package collector

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"mc-activity-replay/models"
)

// activityRow 待写入 player_activity 的一行
type activityRow struct {
	Time time.Time
	UUID string
	Name string
	X, Z float64
	Yaw  *float64
}

// transitRow 待写入 player_transit_state 的一行
type transitRow struct {
	Time    time.Time
	UUID    string
	Station string
	Route   string
	RS1     string
	RS2     string
}

// mergedPlayer 合并后的玩家快照
type mergedPlayer struct {
	UUID    string
	Name    string
	World   string
	X, Z    float64
	Yaw     *float64
	Station string
	Route   string
	RS1     string
	RS2     string
}

// doPoll 执行一次轮询：拉取上游 → 合并 → 去重 → 缓冲写入
func (c *Collector) doPoll(ctx context.Context, stopCh <-chan struct{}, sessionID int64, mtrURL, squaremapURL string) {
	select {
	case <-stopCh:
		return
	default:
	}

	// 1. 并行请求 MTR 和 Squaremap
	var (
		wg       sync.WaitGroup
		mtrData  *MTRData
		mtrErr   error
		smPlayer []SquaremapPlayer
		smErr    error
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		mtrData, mtrErr = FetchMTR(ctx, mtrURL, 10*time.Second)
	}()
	go func() {
		defer wg.Done()
		smPlayer, smErr = FetchSquaremapPlayers(ctx, squaremapURL, 10*time.Second)
	}()
	wg.Wait()

	// Squaremap 是主数据源，失败则本轮跳过
	if smErr != nil {
		c.addError("Squaremap 请求失败: " + smErr.Error())
		return
	}
	// MTR 失败不阻塞主流程（仅记录错误，无乘坐状态数据）
	if mtrErr != nil {
		c.addError("MTR 请求失败: " + mtrErr.Error())
		mtrData = nil
	}

	// 2. 检查 MTR cachedResponseTime，与上次相同则跳过 MTR 数据部分
	mtrFresh := false
	if mtrData != nil && mtrData.CachedResponseTime != c.lastMTRCached {
		mtrFresh = true
		c.lastMTRCached = mtrData.CachedResponseTime
	}

	// 3. 以 Squaremap 为基准合并 MTR 数据
	players := c.mergePlayers(smPlayer, mtrData, mtrFresh)

	// 4. 应用玩家筛选
	filtered := make([]mergedPlayer, 0, len(players))
	for _, p := range players {
		if !c.passFilter(p) {
			continue
		}
		filtered = append(filtered, p)
	}

	// 6. 对比上次写入，去重；7. 缓冲批量写入
	now := time.Now().UTC()
	var newActivity []activityRow
	var newTransit []transitRow
	for _, p := range filtered {
		key := posKey{X: p.X, Z: p.Z}
		if p.Yaw != nil {
			key.Yaw, key.YawOK = *p.Yaw, true
		}
		if prev, ok := c.lastPositions[p.UUID]; !ok || prev != key {
			c.lastPositions[p.UUID] = key
			newActivity = append(newActivity, activityRow{
				Time: now,
				UUID: p.UUID,
				Name: p.Name,
				X:    p.X,
				Z:    p.Z,
				Yaw:  p.Yaw,
			})
		}

		// 8. MTR 状态变化检测（仅当 MTR 数据新鲜时）
		if mtrFresh {
			tk := transitKey{Station: p.Station, Route: p.Route, RS1: p.RS1, RS2: p.RS2}
			if prev, ok := c.lastTransit[p.UUID]; !ok || prev != tk {
				c.lastTransit[p.UUID] = tk
				newTransit = append(newTransit, transitRow{
					Time:    now,
					UUID:    p.UUID,
					Station: p.Station,
					Route:   p.Route,
					RS1:     p.RS1,
					RS2:     p.RS2,
				})
			}
		}
	}

	c.writeBuf = append(c.writeBuf, newActivity...)
	c.transitBuf = append(c.transitBuf, newTransit...)

	// 9. 达到批量阈值或超过 flush 周期时写入数据库
	if len(c.writeBuf) >= batchFlushSize || time.Since(c.lastFlushAt) >= batchFlushPeriod {
		if err := c.flush(ctx, sessionID); err != nil {
			c.addError("数据库写入失败: " + err.Error())
			// 写入失败时保留缓冲，下次重试；缓冲过大则丢弃最旧数据防止内存膨胀
			if len(c.writeBuf) > batchFlushSize*50 {
				c.addError("写入缓冲积压过多，丢弃最旧的一批数据")
				c.writeBuf = c.writeBuf[len(c.writeBuf)-batchFlushSize:]
				c.transitBuf = nil
			}
		}
	}

	// 10. 更新内存中的最近一次轮询结果（含 MTR 乘坐状态，供控制台实时监控展示）
	live := make([]models.LivePlayer, 0, len(filtered))
	for _, p := range filtered {
		live = append(live, models.LivePlayer{
			UUID:    p.UUID,
			Name:    p.Name,
			World:   p.World,
			X:       p.X,
			Z:       p.Z,
			Yaw:     p.Yaw,
			Station: p.Station,
			Route:   p.Route,
			RS1:     p.RS1,
			RS2:     p.RS2,
		})
	}
	c.setLive(live)
}

// mergePlayers 以 Squaremap 为基准合并 MTR 数据
func (c *Collector) mergePlayers(smPlayers []SquaremapPlayer, mtrData *MTRData, mtrFresh bool) []mergedPlayer {
	seen := make(map[string]bool, len(smPlayers))
	result := make([]mergedPlayer, 0, len(smPlayers))
	index := make(map[string]int, len(smPlayers))

	// Squaremap 基准（仅记录配置的世界，单世界假设）
	for _, sp := range smPlayers {
		uuid := NormalizeUUID(sp.UUID)
		if uuid == "" {
			continue
		}
		if c.world != "" && sp.World != "" && sp.World != c.world {
			continue
		}
		seen[uuid] = true
		index[uuid] = len(result)
		result = append(result, mergedPlayer{
			UUID:  uuid,
			Name:  sp.Name,
			World: sp.World,
			X:     sp.X,
			Z:     sp.Z,
			Yaw:   sp.Yaw,
		})
	}

	// 合并 MTR 数据（只要本轮成功取到数据即合并，使实时监控稳定获得乘坐状态；
	// cachedResponseTime 未变化时数据与上轮相同，合并不产生影响；
	// 数据库变化检测写入仍由 mtrFresh 门控）
	if mtrData != nil {
		for _, mc := range mtrData.Clients {
			uuid := NormalizeUUID(mc.ID)
			if uuid == "" {
				continue
			}
			if i, ok := index[uuid]; ok {
				// Squaremap 中已有的玩家：补充乘坐状态
				result[i].Station = mc.StationID
				result[i].Route = mc.RouteID
				result[i].RS1 = mc.RouteStationID1
				result[i].RS2 = mc.RouteStationID2
			} else if !seen[uuid] {
				// 仅在 MTR 中出现的玩家：加入记录，world 用会话世界，健康值等为 NULL
				seen[uuid] = true
				result = append(result, mergedPlayer{
					UUID:    uuid,
					Name:    mc.Name,
					World:   c.world,
					X:       mc.X,
					Z:       mc.Z,
					Station: mc.StationID,
					Route:   mc.RouteID,
					RS1:     mc.RouteStationID1,
					RS2:     mc.RouteStationID2,
				})
			}
		}
	}
	return result
}

// passFilter 应用玩家筛选
func (c *Collector) passFilter(p mergedPlayer) bool {
	if c.filter == nil || c.filter.Mode == "all" {
		return true
	}
	matched := false
	for _, u := range c.filter.UUIDs {
		if NormalizeUUID(u) == p.UUID {
			matched = true
			break
		}
	}
	if !matched {
		for _, n := range c.filter.Names {
			if n == "" {
				continue
			}
			if strings.EqualFold(strings.TrimSpace(n), p.Name) || strings.Contains(strings.ToLower(p.Name), strings.ToLower(strings.TrimSpace(n))) {
				matched = true
				break
			}
		}
	}
	if c.filter.Mode == "exclude" {
		return !matched
	}
	return matched // include
}

// flush 将缓冲区数据批量写入数据库（CopyFrom）
func (c *Collector) flush(ctx context.Context, sessionID int64) error {
	if len(c.writeBuf) == 0 && len(c.transitBuf) == 0 {
		c.lastFlushAt = time.Now()
		return nil
	}

	rows := c.writeBuf
	transit := c.transitBuf
	c.writeBuf = nil
	c.transitBuf = nil
	c.lastFlushAt = time.Now()

	if len(rows) > 0 {
		_, err := c.db.Pool.CopyFrom(ctx,
			pgx.Identifier{"player_activity"},
			[]string{"time", "session_id", "player_uuid", "player_name", "x", "z", "yaw"},
			pgx.CopyFromSlice(len(rows), func(i int) ([]any, error) {
				r := rows[i]
				return []any{r.Time, sessionID, r.UUID, r.Name, r.X, r.Z, r.Yaw}, nil
			}))
		if err != nil {
			// 写回缓冲以便重试
			c.writeBuf = append(rows, c.writeBuf...)
			return fmt.Errorf("写入 player_activity 失败: %w", err)
		}
	}

	if len(transit) > 0 {
		_, err := c.db.Pool.CopyFrom(ctx,
			pgx.Identifier{"player_transit_state"},
			[]string{"time", "session_id", "player_uuid", "station_id", "route_id", "route_station_id1", "route_station_id2"},
			pgx.CopyFromSlice(len(transit), func(i int) ([]any, error) {
				t := transit[i]
				return []any{t.Time, sessionID, t.UUID, t.Station, t.Route, t.RS1, t.RS2}, nil
			}))
		if err != nil {
			c.transitBuf = append(transit, c.transitBuf...)
			return fmt.Errorf("写入 player_transit_state 失败: %w", err)
		}
	}
	return nil
}
