// Package collector 实现采集状态机：轮询上游 API 并将数据写入数据库
package collector

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"mc-activity-replay/db"
	"mc-activity-replay/models"
)

// 采集状态
const (
	StatusIdle       = "idle"
	StatusRecording  = "recording"
	maxErrorEntries  = 100 // 错误环形缓冲区容量
	batchFlushSize   = 100 // 累积多少条位置数据触发一次 flush
	batchFlushPeriod = 5 * time.Second
	minPollInterval  = 50 * time.Millisecond
)

// Collector 采集器单例（全局只允许一个进行中的会话）
type Collector struct {
	mu sync.RWMutex

	db  *db.DB
	cfg *configForCollector

	status       string
	sessionID    int64
	startedAt    time.Time
	pollInterval time.Duration
	playerCount  int
	lastError    string
	errors       []models.ErrorEntry

	// 最近一次轮询结果（供 /api/collector/live）
	livePlayers   []models.LivePlayer
	livePolledAt  *time.Time
	liveSessionID int64 // 快照所属会话 ID（Stop 不清除，保证停止后仍可返回有效快照）

	// 轮询协程控制通道（仅 Start/Stop 访问）
	stopCh   chan struct{}
	doneCh   chan struct{}
	stopping bool

	// 时长上限定时器（Stop 时取消，避免手动停止后仍触发自动停止的错误日志）
	durationTimer *time.Timer

	// 去重状态（每个会话独立）
	lastPositions map[string]posKey
	lastTransit   map[string]transitKey
	lastMTRCached int64

	// 批量写入缓冲（仅由轮询协程访问，Stop 会等待轮询协程退出后再 flush）
	writeBuf    []activityRow
	transitBuf  []transitRow
	lastFlushAt time.Time

	// 会话参数
	world  string
	filter *models.PlayerFilter
}

// configForCollector 采集器需要的配置子集
type configForCollector struct {
	MtrURL       string
	SquaremapURL string
}

// posKey 位置去重键：(x, z, yaw) 与上次写入完全相同则不重复记录
type posKey struct {
	X, Z  float64
	Yaw   float64
	YawOK bool
}

type transitKey struct {
	Station, Route, RS1, RS2 string
}

// New 创建采集器
func New(database *db.DB, mtrURL, squaremapURL string) *Collector {
	return &Collector{
		db:     database,
		cfg:    &configForCollector{MtrURL: mtrURL, SquaremapURL: squaremapURL},
		status: StatusIdle,
		errors: []models.ErrorEntry{},
	}
}

// RecoverInterruptedSessions 后端启动时调用：
// 将数据库中 stopped_at IS NULL 的会话标记为异常终止（stopped_reason='error'）。
func (c *Collector) RecoverInterruptedSessions(ctx context.Context) error {
	tag, err := c.db.Pool.Exec(ctx,
		`UPDATE sessions SET stopped_at = NOW(), stopped_reason = 'error' WHERE stopped_at IS NULL`)
	if err != nil {
		return fmt.Errorf("恢复中断会话失败: %w", err)
	}
	if tag.RowsAffected() > 0 {
		c.addError(fmt.Sprintf("启动时发现 %d 个未正常结束的会话，已标记为 error", tag.RowsAffected()))
	}
	return nil
}

// ---------- 状态机 ----------

// Start 开始一次记录会话
func (c *Collector) Start(ctx context.Context, req models.StartCollectorRequest) (*models.Session, error) {
	c.mu.Lock()
	if c.status == StatusRecording || c.stopping {
		c.mu.Unlock()
		return nil, errors.New("已有进行中的会话，请先停止当前会话")
	}

	// 参数默认值处理（未传的字段回退到全局配置默认值）。
	// 世界名与瓦片 URL 模板按设计固定为系统默认值，不提供配置项。
	cfgMap := db.LoadConfigMap(ctx, c.db.Pool)

	pollInterval := 1000
	if req.PollIntervalMs != nil {
		pollInterval = *req.PollIntervalMs
	} else if n, err := strconv.Atoi(strings.TrimSpace(cfgMap["default_poll_interval_ms"])); err == nil && n > 0 {
		pollInterval = n
	}
	if pollInterval < int(minPollInterval.Milliseconds()) {
		pollInterval = int(minPollInterval.Milliseconds())
	}

	world := "minecraft_overworld"
	if req.World != nil && *req.World != "" {
		world = *req.World
	}
	// 瓦片最大缩放等级：请求未指定时回退到 app_config.default_tile_zoom，再回退到 3。
	// 该值须与 Squaremap 服务器 settings.json 的 zoom.max 一致（回放坐标换算基准）。
	tileZoom := 3
	if req.TileZoom != nil {
		tileZoom = *req.TileZoom
	} else if n, err := strconv.Atoi(strings.TrimSpace(cfgMap["default_tile_zoom"])); err == nil && n >= 0 {
		tileZoom = n
	}
	tileURLTemplate := "/tiles/{world}/{zoom}/{x}_{z}.png"
	if req.TileURLTemplate != nil && *req.TileURLTemplate != "" {
		tileURLTemplate = *req.TileURLTemplate
	}
	// 记录时长上限：请求未指定时回退到 app_config.default_max_duration_sec（空 = 无上限）
	maxDurationSec := req.MaxDurationSec
	if maxDurationSec == nil {
		if v := strings.TrimSpace(cfgMap["default_max_duration_sec"]); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				maxDurationSec = &n
			}
		}
	}
	mtrURL := c.cfg.MtrURL
	if req.MtrURL != nil && *req.MtrURL != "" {
		mtrURL = *req.MtrURL
	}
	squaremapURL := c.cfg.SquaremapURL
	if req.SquaremapURL != nil && *req.SquaremapURL != "" {
		squaremapURL = *req.SquaremapURL
	}
	name := time.Now().UTC().Format("2006-01-02_15-04-05")
	if req.Name != nil && *req.Name != "" {
		name = *req.Name
	}
	var filter *models.PlayerFilter
	if req.PlayerFilter != nil && req.PlayerFilter.Mode != "" && req.PlayerFilter.Mode != "all" {
		filter = req.PlayerFilter
	}

	// 插入会话记录
	sess := &models.Session{
		Name:            name,
		StartedAt:       time.Now().UTC(),
		MaxDurationSec:  maxDurationSec,
		PollIntervalMs:  pollInterval,
		MtrURL:          mtrURL,
		SquaremapURL:    squaremapURL,
		World:           world,
		TileZoom:        tileZoom,
		TileURLTemplate: tileURLTemplate,
	}
	err := c.db.Pool.QueryRow(ctx,
		`INSERT INTO sessions (name, started_at, max_duration_sec, poll_interval_ms, mtr_url, squaremap_url, world, tile_zoom, tile_url_template)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
		sess.Name, sess.StartedAt, sess.MaxDurationSec, sess.PollIntervalMs,
		sess.MtrURL, sess.SquaremapURL, sess.World, sess.TileZoom, sess.TileURLTemplate).Scan(&sess.ID)
	if err != nil {
		c.mu.Unlock()
		return nil, fmt.Errorf("创建会话失败: %w", err)
	}

	// 初始化采集状态
	c.status = StatusRecording
	c.sessionID = sess.ID
	c.startedAt = sess.StartedAt
	c.pollInterval = time.Duration(pollInterval) * time.Millisecond
	c.playerCount = 0
	c.lastError = ""
	c.lastPositions = make(map[string]posKey)
	c.lastTransit = make(map[string]transitKey)
	c.lastMTRCached = 0
	c.livePlayers = nil
	c.livePolledAt = nil
	c.writeBuf = nil
	c.transitBuf = nil
	c.lastFlushAt = time.Now()
	c.world = world
	c.filter = filter

	stopCh := make(chan struct{})
	doneCh := make(chan struct{})
	ticker := time.NewTicker(c.pollInterval)
	c.stopCh = stopCh
	c.doneCh = doneCh

	// 倒计时硬上限：到时强制停止，无延长选项。
	// 定时器句柄保存在 durationTimer，Stop 时取消——否则手动停止后定时器
	// 仍会触发，向错误日志写入无意义的"自动停止失败: 当前没有进行中的会话"
	if maxDurationSec != nil && *maxDurationSec > 0 {
		c.durationTimer = time.AfterFunc(time.Duration(*maxDurationSec)*time.Second, func() {
			c.addError("记录时长达到上限，自动停止")
			if err := c.Stop(context.Background(), "timeout"); err != nil {
				c.addError("自动停止失败: " + err.Error())
			}
		})
	}

	c.mu.Unlock()

	go c.run(stopCh, doneCh, ticker, sess.ID, mtrURL, squaremapURL)

	return sess, nil
}

// Stop 停止当前记录会话，reason 为 'manual' 或 'timeout'。
// 最终 flush 由轮询协程在退出前自行完成（见 run），本方法只负责通知与等待，
// 避免 Stop 与轮询协程同时操作写入缓冲的数据竞争。
func (c *Collector) Stop(ctx context.Context, reason string) error {
	c.mu.Lock()
	if c.status != StatusRecording || c.stopping {
		c.mu.Unlock()
		return errors.New("当前没有进行中的会话")
	}
	sessionID := c.sessionID
	// 取出轮询协程的停止通道与完成通道（由 Start 时创建）
	stopCh, doneCh := c.stopCh, c.doneCh
	c.stopCh, c.doneCh = nil, nil
	c.stopping = true // 阻止并发 Start，直到轮询协程完全退出
	// 取消时长上限定时器（手动/超时停止都不需要它再触发）
	if c.durationTimer != nil {
		c.durationTimer.Stop()
		c.durationTimer = nil
	}
	c.mu.Unlock()

	// 通知轮询协程退出并等待其结束（协程退出前会自行完成最终 flush）
	if stopCh != nil {
		close(stopCh)
	}
	if doneCh != nil {
		select {
		case <-doneCh:
		case <-time.After(30 * time.Second):
			// 轮询协程未在 30s 内退出（通常卡在数据库写入）：
			// 保持 stopping 阻止新会话，由协程最终退出时自愈状态（见 run）；
			// 此处不碰写入缓冲，也不替代协程 flush，避免数据竞争
			c.addError("等待轮询协程退出超时，最终数据将由该协程继续尝试写入")
			if _, err := c.db.Pool.Exec(ctx,
				`UPDATE sessions SET stopped_at = NOW(), stopped_reason = $1 WHERE id = $2`, reason, sessionID); err != nil {
				return fmt.Errorf("更新会话结束状态失败: %w", err)
			}
			return errors.New("停止记录超时：轮询协程仍在退出中，其最终数据写入完成后状态将自动恢复")
		}
	}

	if _, err := c.db.Pool.Exec(ctx,
		`UPDATE sessions SET stopped_at = NOW(), stopped_reason = $1 WHERE id = $2`, reason, sessionID); err != nil {
		c.mu.Lock()
		c.stopping = false
		c.mu.Unlock()
		return fmt.Errorf("更新会话结束状态失败: %w", err)
	}

	c.mu.Lock()
	c.stopping = false
	c.status = StatusIdle
	c.sessionID = 0
	c.mu.Unlock()
	return nil
}

// Status 返回采集器状态
func (c *Collector) Status() models.CollectorStatus {
	c.mu.RLock()
	defer c.mu.RUnlock()

	st := models.CollectorStatus{
		Status:      c.status,
		PlayerCount: c.playerCount,
		Errors:      append([]models.ErrorEntry(nil), c.errors...),
	}
	// stopping 期间对外表现为 idle（轮询协程正在退出）
	if c.stopping {
		st.Status = StatusIdle
	}
	if c.status == StatusRecording && !c.stopping {
		id := c.sessionID
		startedAt := c.startedAt
		interval := int(c.pollInterval.Milliseconds())
		st.SessionID = &id
		st.StartedAt = &startedAt
		st.PollInterval = &interval
	}
	if c.lastError != "" {
		e := c.lastError
		st.LastError = &e
	}
	return st
}

// Recording 返回采集器是否正在记录（含 Stop 执行中的过渡状态）。
// 与 Status 不同：不清空/导入等破坏性操作必须用本方法判断——
// Stop 等待轮询协程退出期间 Status 对外表现为 idle，但协程仍可能持有
// 数据库写入，此时执行 TRUNCATE/DROP 会与最后的 flush 竞争。
func (c *Collector) Recording() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.status == StatusRecording
}

// ClearLive 清空内存中的实时快照（数据库清空后调用，避免监控仍显示旧玩家）
func (c *Collector) ClearLive() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.livePlayers = nil
	c.livePolledAt = nil
	c.liveSessionID = 0
	c.playerCount = 0
}

// Live 返回最近一次轮询的玩家列表
func (c *Collector) Live() models.CollectorLive {
	c.mu.RLock()
	defer c.mu.RUnlock()

	live := models.CollectorLive{
		Players: append([]models.LivePlayer(nil), c.livePlayers...),
	}
	// 录制中返回当前会话 ID；停止后若仍有上次轮询快照也一并返回，
	// 使控制台在未记录状态下手动刷新也能看到最后的玩家列表
	if c.livePolledAt != nil {
		id := c.liveSessionID
		live.SessionID = &id
		t := *c.livePolledAt
		live.PolledAt = &t
	}
	return live
}

// ---------- 内部 ----------

// run 轮询主循环。退出前（stopCh 触发）必须完成最终 flush——
// Stop 通过等待 doneCh 保证这一点，且缓冲仅由本协程操作，无数据竞争。
func (c *Collector) run(stopCh <-chan struct{}, doneCh chan struct{}, ticker *time.Ticker, sessionID int64, mtrURL, squaremapURL string) {
	defer close(doneCh)
	defer ticker.Stop()
	// 自愈：Stop 等待超时（协程卡住）时由其代为保持的状态，由本协程退出时恢复
	defer func() {
		c.mu.Lock()
		if c.stopping {
			c.stopping = false
			c.status = StatusIdle
			c.sessionID = 0
		}
		c.mu.Unlock()
	}()

	// 立即执行第一次轮询
	c.doPoll(context.Background(), stopCh, sessionID, mtrURL, squaremapURL)
	for {
		select {
		case <-stopCh:
			// 最终 flush：剩余缓冲数据在此写入（Stop 正等待 doneCh）
			flushCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			if err := c.flush(flushCtx, sessionID); err != nil {
				c.addError("停止时最终写入失败: " + err.Error())
			}
			cancel()
			return
		case <-ticker.C:
			c.doPoll(context.Background(), stopCh, sessionID, mtrURL, squaremapURL)
		}
	}
}

// addError 追加错误到环形缓冲区（最多保留最近 maxErrorEntries 条）
func (c *Collector) addError(msg string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastError = msg
	c.errors = append(c.errors, models.ErrorEntry{Time: time.Now().UTC(), Message: msg})
	if len(c.errors) > maxErrorEntries {
		c.errors = c.errors[len(c.errors)-maxErrorEntries:]
	}
}

// setLive 更新最近一次轮询结果
func (c *Collector) setLive(players []models.LivePlayer, sessionID int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.livePlayers = players
	c.liveSessionID = sessionID
	now := time.Now().UTC()
	c.livePolledAt = &now
	c.playerCount = len(players)
}
