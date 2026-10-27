package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"mc-activity-replay/collector"
	"mc-activity-replay/config"
	"mc-activity-replay/db"
	"mc-activity-replay/models"
)

const exportBatchSize = 2000

// periodFilter 导出过滤条件：零值表示不限（玩家 / 起止时间）
type periodFilter struct {
	UUID  *string
	Start *time.Time
	End   *time.Time
}

func (f periodFilter) limited() bool { return f.Start != nil || f.End != nil }

// parseTimeParam 解析 RFC3339 时间查询参数（可带小数秒，如 2026-10-27T10:00:00.123Z）。
// 空字符串返回 nil（不限）。
func parseTimeParam(c *gin.Context, name string) (*time.Time, error) {
	v := strings.TrimSpace(c.Query(name))
	if v == "" {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return nil, fmt.Errorf("%s 时间格式应为 RFC3339（可带小数秒）: %q", name, v)
	}
	u := t.UTC()
	return &u, nil
}

// parsePeriod 解析 start/end 查询参数并校验区间
func parsePeriod(c *gin.Context) (periodFilter, error) {
	var f periodFilter
	var err error
	if f.Start, err = parseTimeParam(c, "start"); err != nil {
		return f, err
	}
	if f.End, err = parseTimeParam(c, "end"); err != nil {
		return f, err
	}
	if f.Start != nil && f.End != nil && f.End.Before(*f.Start) {
		return f, fmt.Errorf("结束时间不能早于开始时间")
	}
	return f, nil
}

// applyPeriodToSession 时间段导出时把会话起止改写为所选区间，
// 使导出文件（及其导入结果）的时间轴与数据一致。
func applyPeriodToSession(sess *models.Session, f periodFilter) {
	if !f.limited() {
		return
	}
	if f.Start != nil {
		sess.StartedAt = *f.Start
	}
	if f.End != nil {
		sess.StoppedAt = f.End
	} else {
		sess.StoppedAt = nil
	}
	sess.Name = sess.Name + "（时间段）"
}

// exportSession 导出单个会话为 JSON 或 CSV。
// 可选查询参数：start / end（RFC3339，闭区间），用于固定时间段导出。
func exportSession(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := parseID(c, "id")
		if !ok {
			return
		}
		format := c.DefaultQuery("format", "json")
		ctx := c.Request.Context()

		f, err := parsePeriod(c)
		if err != nil {
			badRequest(c, err.Error())
			return
		}

		// 读取会话
		sess, err := scanSession(database.Pool.QueryRow(ctx,
			`SELECT `+sessionCols+` FROM sessions WHERE id = $1`, id))
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "会话不存在"})
			return
		}
		applyPeriodToSession(sess, f)

		filename := fmt.Sprintf("session-%d", sess.ID)
		if f.limited() {
			filename += "-period"
		}
		switch format {
		case "json":
			exportSessionJSON(c, database, sess, f, filename)
		case "csv":
			exportSessionCSV(c, database, sess, f, filename)
		default:
			badRequest(c, "不支持的导出格式（支持 json / csv）")
		}
	}
}

// exportPlayerPeriod 导出单个玩家的固定时间段数据（JSON/CSV），
// 便于把某个玩家的某段轨迹单独归档或分享。玩家不存在时 404。
func exportPlayerPeriod(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := parseID(c, "id")
		if !ok {
			return
		}
		uuid := c.Param("uuid")
		format := c.DefaultQuery("format", "json")
		ctx := c.Request.Context()

		f, err := parsePeriod(c)
		if err != nil {
			badRequest(c, err.Error())
			return
		}
		f.UUID = &uuid

		sess, err := scanSession(database.Pool.QueryRow(ctx,
			`SELECT `+sessionCols+` FROM sessions WHERE id = $1`, id))
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "会话不存在"})
			return
		}

		// 该玩家在（可选）时间范围内是否存在数据点
		var exists bool
		if err := database.Pool.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM player_activity
			   WHERE session_id = $1 AND player_uuid = $2
			     AND ($3::timestamptz IS NULL OR time >= $3)
			     AND ($4::timestamptz IS NULL OR time <= $4))`,
			id, uuid, f.Start, f.End).Scan(&exists); err != nil {
			serverError(c, err)
			return
		}
		if !exists {
			c.JSON(http.StatusNotFound, gin.H{"error": "该玩家在所选时间段内没有数据"})
			return
		}

		applyPeriodToSession(sess, f)
		filename := fmt.Sprintf("session-%d-%s", sess.ID, uuid[:min(8, len(uuid))])
		switch format {
		case "json":
			exportSessionJSON(c, database, sess, f, filename)
		case "csv":
			exportSessionCSV(c, database, sess, f, filename)
		default:
			badRequest(c, "不支持的导出格式（支持 json / csv）")
		}
	}
}

// exportSessionJSON 流式导出 JSON，避免大会话占用过多内存。
// f.UUID 非空时只导出该玩家；f.Start/f.End 用于限定时间段。
func exportSessionJSON(c *gin.Context, database *db.DB, sess *models.Session, f periodFilter, filename string) {
	ctx := c.Request.Context()
	c.Header("Content-Type", "application/json; charset=utf-8")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.json"`, filename))

	w := bufio.NewWriter(c.Writer)
	defer w.Flush()

	w.WriteString(`{"version":1,"session":`)
	sessJSON, _ := json.Marshal(sess)
	w.Write(sessJSON)
	w.WriteString(`,"players":[`)

	// 玩家列表
	pRows, err := database.Pool.Query(ctx,
		`SELECT player_uuid, (array_agg(player_name ORDER BY time))[1] AS name
		 FROM player_activity WHERE session_id = $1
		   AND ($2::text IS NULL OR player_uuid = $2)
		 GROUP BY player_uuid ORDER BY name`, sess.ID, f.UUID)
	if err != nil {
		return
	}
	type playerInfo struct{ uuid, name string }
	var players []playerInfo
	for pRows.Next() {
		var p playerInfo
		if err := pRows.Scan(&p.uuid, &p.name); err == nil {
			players = append(players, p)
		}
	}
	pRows.Close()

	first := true
	for _, p := range players {
		if !first {
			w.WriteString(",")
		}
		first = false
		w.WriteString(`{"uuid":`)
		uuidJSON, _ := json.Marshal(p.uuid)
		w.Write(uuidJSON)
		w.WriteString(`,"name":`)
		nameJSON, _ := json.Marshal(p.name)
		w.Write(nameJSON)

		// activity（分批流式）
		w.WriteString(`,"activity":[`)
		offset := 0
		firstPoint := true
		for {
			aRows, err := database.Pool.Query(ctx,
				`SELECT time, x, z, yaw FROM player_activity
				 WHERE session_id = $1 AND player_uuid = $2
				   AND ($5::timestamptz IS NULL OR time >= $5)
				   AND ($6::timestamptz IS NULL OR time <= $6)
				 ORDER BY time ASC OFFSET $3 LIMIT $4`,
				sess.ID, p.uuid, offset, exportBatchSize, f.Start, f.End)
			if err != nil {
				return
			}
			n := 0
			for aRows.Next() {
				var pt models.ActivityPoint
				if err := aRows.Scan(&pt.Time, &pt.X, &pt.Z, &pt.Yaw); err != nil {
					aRows.Close()
					return
				}
				if !firstPoint {
					w.WriteString(",")
				}
				firstPoint = false
				ptJSON, _ := json.Marshal(pt)
				w.Write(ptJSON)
				n++
			}
			aRows.Close()
			offset += n
			if n < exportBatchSize {
				break
			}
		}
		w.WriteString(`]`)

		// state（player_state：MTR 乘坐状态 + 生命值/护甲）。
		// 时间段导出时先补一条区间起点之前最近的状态记录，保证导入后
		// 该段起始时刻的 tooltip 仍有站点/线路（采集器按“变化才记录”，
		// 起点可能在两条状态之间）。
		w.WriteString(`,"state":[`)
		firstState := true
		if f.Start != nil {
			var r models.StateRecord
			err := database.Pool.QueryRow(ctx,
				`SELECT time, station_id, route_id, route_station_id1, route_station_id2, health, armor
				 FROM player_state WHERE session_id = $1 AND player_uuid = $2 AND time < $3
				 ORDER BY time DESC LIMIT 1`, sess.ID, p.uuid, *f.Start).
				Scan(&r.Time, &r.StationID, &r.RouteID, &r.RouteStationID1, &r.RouteStationID2, &r.Health, &r.Armor)
			if err == nil {
				rJSON, _ := json.Marshal(r)
				w.Write(rJSON)
				firstState = false
			}
		}
		sRows, err := database.Pool.Query(ctx,
			`SELECT time, station_id, route_id, route_station_id1, route_station_id2, health, armor
			 FROM player_state WHERE session_id = $1 AND player_uuid = $2
			   AND ($3::timestamptz IS NULL OR time >= $3)
			   AND ($4::timestamptz IS NULL OR time <= $4)
			 ORDER BY time ASC`,
			sess.ID, p.uuid, f.Start, f.End)
		if err != nil {
			return
		}
		for sRows.Next() {
			var r models.StateRecord
			if err := sRows.Scan(&r.Time, &r.StationID, &r.RouteID, &r.RouteStationID1, &r.RouteStationID2, &r.Health, &r.Armor); err != nil {
				sRows.Close()
				return
			}
			if !firstState {
				w.WriteString(",")
			}
			firstState = false
			rJSON, _ := json.Marshal(r)
			w.Write(rJSON)
		}
		sRows.Close()
		w.WriteString(`]}`)
	}
	w.WriteString(`]}`)
}

// CSV 会话元数据以注释行写在表头之前：CSV 没有标准元数据段，而把元数据
// 复制到每一行会让文件体积随数据点数量线性膨胀。读取端按行首前缀识别并剥离。
const csvMetaPrefix = "#mc-activity-replay."

// csvMetaEsc 把元数据值压成单行（注释行按行切分，值内不能含换行）
func csvMetaEsc(v string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(v)
}

func boolFlag(v bool) string {
	if v {
		return "1"
	}
	return "0"
}

// writeCSVMeta 写会话元数据注释行（读取端 restoreSessionFromCSVMeta）
func writeCSVMeta(w io.Writer, sess *models.Session) {
	set := func(k, v string) {
		fmt.Fprintf(w, "%s%s=%s\n", csvMetaPrefix, k, csvMetaEsc(v))
	}
	set("version", "2")
	set("name", sess.Name)
	set("started_at", sess.StartedAt.UTC().Format(time.RFC3339Nano))
	if sess.StoppedAt != nil {
		set("stopped_at", sess.StoppedAt.UTC().Format(time.RFC3339Nano))
	}
	if sess.MaxDurationSec != nil {
		set("max_duration_sec", strconv.Itoa(*sess.MaxDurationSec))
	}
	if sess.StoppedReason != nil {
		set("stopped_reason", *sess.StoppedReason)
	}
	set("poll_interval_ms", strconv.Itoa(sess.PollIntervalMs))
	set("mtr_url", sess.MtrURL)
	set("squaremap_url", sess.SquaremapURL)
	set("world", sess.World)
	set("tile_zoom", strconv.Itoa(sess.TileZoom))
	set("tile_url_template", sess.TileURLTemplate)
	set("mtr_enabled", boolFlag(sess.MtrEnabled))
	set("collect_station_id", boolFlag(sess.CollectStationID))
	set("collect_route_id", boolFlag(sess.CollectRouteID))
	set("collect_route_station1", boolFlag(sess.CollectRouteStation1))
	set("collect_route_station2", boolFlag(sess.CollectRouteStation2))
	set("collect_health", boolFlag(sess.CollectHealth))
	set("collect_armor", boolFlag(sess.CollectArmor))
}

// csvExportHeader 与 JSON 导出等效的 CSV 列。
// record_type 区分两类行：activity（位置点）/ state（状态记录）。
var csvExportHeader = []string{
	"record_type", "time", "player_uuid", "player_name",
	"x", "z", "yaw", "health", "armor",
	"station_id", "route_id", "route_station_id1", "route_station_id2",
}

// exportSessionCSV 导出 CSV，内容与 JSON 导出等效：
//   - 表头前用注释行携带完整会话元数据（导入时还原，不再由数据推导）
//   - record_type=activity 行是位置点，附该时刻最新状态（便于表格里直接查看）
//   - record_type=state 行是 player_state 原始记录，保留各自独立的采集时间
//
// 采集器只在位置变化时写 activity、状态变化时写 state，两者时间彼此独立
// （玩家静止时换乘/掉血不会产生位置点）。因此「每个位置点 + 当时状态」的宽表
// 无法还原这些状态变化的时间，必须额外导出独立的 state 行，导入时按行类型分别写表。
func exportSessionCSV(c *gin.Context, database *db.DB, sess *models.Session, f periodFilter, filename string) {
	ctx := c.Request.Context()
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.csv"`, filename))

	writeCSVMeta(c.Writer, sess)

	w := csv.NewWriter(c.Writer)
	defer w.Flush()

	w.Write(csvExportHeader)

	// 用 LATERAL 关联每个位置点对应的最新玩家状态
	rows, err := database.Pool.Query(ctx,
		`SELECT a.time, a.player_uuid, a.player_name, a.x, a.z, a.yaw,
		        t.health, t.armor, t.station_id, t.route_id,
		        t.route_station_id1, t.route_station_id2
		 FROM player_activity a
		 LEFT JOIN LATERAL (
		     SELECT health, armor, station_id, route_id, route_station_id1, route_station_id2
		     FROM player_state t
		     WHERE t.session_id = a.session_id AND t.player_uuid = a.player_uuid AND t.time <= a.time
		     ORDER BY t.time DESC LIMIT 1
		 ) t ON true
		 WHERE a.session_id = $1
		   AND ($2::text IS NULL OR a.player_uuid = $2)
		   AND ($3::timestamptz IS NULL OR a.time >= $3)
		   AND ($4::timestamptz IS NULL OR a.time <= $4)
		 ORDER BY a.time`, sess.ID, f.UUID, f.Start, f.End)
	if err != nil {
		return
	}
	defer rows.Close()

	for rows.Next() {
		var (
			t          time.Time
			uuid, name string
			x, z       float64
			yaw        *float64
			health     *float64
			armor      *int
			stationID  *string
			routeID    *string
			rs1, rs2   *string
		)
		if err := rows.Scan(&t, &uuid, &name, &x, &z, &yaw, &health, &armor,
			&stationID, &routeID, &rs1, &rs2); err != nil {
			return
		}
		w.Write([]string{
			"activity",
			t.UTC().Format(time.RFC3339Nano), // 亚秒精度：同一秒内的多点/状态变化保持顺序，保证导入往返无损
			uuid,
			name,
			strconv.FormatFloat(x, 'f', -1, 64),
			strconv.FormatFloat(z, 'f', -1, 64),
			formatFloatPtr(yaw),
			formatFloatPtr(health),
			formatIntPtr(armor),
			formatCSVStringPtr(stationID),
			formatCSVStringPtr(routeID),
			formatCSVStringPtr(rs1),
			formatCSVStringPtr(rs2),
		})
	}
	rows.Close()

	// ---- 状态记录段：保留每条 player_state 的独立采集时间（JSON 的 state 数组）----
	// player_state 没有 player_name 列，用该玩家位置记录里的名字补上便于阅读
	nameByUUID := map[string]string{}
	if pRows, err := database.Pool.Query(ctx,
		`SELECT player_uuid, (array_agg(player_name ORDER BY time))[1]
		 FROM player_activity WHERE session_id = $1
		   AND ($2::text IS NULL OR player_uuid = $2)
		 GROUP BY player_uuid`, sess.ID, f.UUID); err == nil {
		for pRows.Next() {
			var u, n string
			if pRows.Scan(&u, &n) == nil {
				nameByUUID[u] = n
			}
		}
		pRows.Close()
	}

	writeState := func(t time.Time, uuid string, health *float64, armor *int,
		station, route, rs1, rs2 *string) {
		w.Write([]string{
			"state",
			t.UTC().Format(time.RFC3339Nano),
			uuid,
			nameByUUID[uuid],
			"", "", "", // x / z / yaw：状态记录不含位置
			formatFloatPtr(health),
			formatIntPtr(armor),
			formatCSVStringPtr(station),
			formatCSVStringPtr(route),
			formatCSVStringPtr(rs1),
			formatCSVStringPtr(rs2),
		})
	}

	// 时间段导出：先补每个玩家在区间起点之前最近的一条状态，作为该段初始状态
	// （状态按变化记录，区间起点可能落在两条状态之间；与 JSON 导出一致）
	if f.Start != nil {
		preRows, err := database.Pool.Query(ctx,
			`SELECT DISTINCT ON (player_uuid)
			        time, player_uuid, health, armor, station_id, route_id,
			        route_station_id1, route_station_id2
			 FROM player_state
			 WHERE session_id = $1 AND time < $2
			   AND ($3::text IS NULL OR player_uuid = $3)
			 ORDER BY player_uuid, time DESC`, sess.ID, *f.Start, f.UUID)
		if err == nil {
			for preRows.Next() {
				var (
					t       time.Time
					uuid    string
					health  *float64
					armor   *int
					station *string
					route   *string
					sRs1    *string
					sRs2    *string
				)
				if preRows.Scan(&t, &uuid, &health, &armor, &station, &route, &sRs1, &sRs2) == nil {
					writeState(t, uuid, health, armor, station, route, sRs1, sRs2)
				}
			}
			preRows.Close()
		}
	}

	sRows, err := database.Pool.Query(ctx,
		`SELECT time, player_uuid, health, armor, station_id, route_id,
		        route_station_id1, route_station_id2
		 FROM player_state
		 WHERE session_id = $1
		   AND ($2::text IS NULL OR player_uuid = $2)
		   AND ($3::timestamptz IS NULL OR time >= $3)
		   AND ($4::timestamptz IS NULL OR time <= $4)
		 ORDER BY time`, sess.ID, f.UUID, f.Start, f.End)
	if err != nil {
		return
	}
	defer sRows.Close()
	for sRows.Next() {
		var (
			t       time.Time
			uuid    string
			health  *float64
			armor   *int
			station *string
			route   *string
			sRs1    *string
			sRs2    *string
		)
		if err := sRows.Scan(&t, &uuid, &health, &armor, &station, &route, &sRs1, &sRs2); err != nil {
			return
		}
		writeState(t, uuid, health, armor, station, route, sRs1, sRs2)
	}
}

func formatFloatPtr(v *float64) string {
	if v == nil {
		return ""
	}
	return strconv.FormatFloat(*v, 'f', -1, 64)
}

func formatIntPtr(v *int) string {
	if v == nil {
		return ""
	}
	return strconv.Itoa(*v)
}

// csvNull 表示 NULL（CSV 空字段无法与空字符串区分，而 player_state 的
// station_id/route_id 等既有 NULL（未采集）也有 ""（无站点），两者需区分）
const csvNull = `\N`

// formatCSVStringPtr 文本状态列：NULL → \N，空字符串 → 空字段
func formatCSVStringPtr(v *string) string {
	if v == nil {
		return csvNull
	}
	return *v
}

func formatStringPtr(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// importSession 导入会话（JSON 或 CSV 格式，multipart/form-data）。
// JSON 为控制台「导出会话」产生的结构（version=1）；
// CSV 为导出会话的产物（表头前注释行携带会话元数据，record_type 区分
// activity/state 行），导入结果与 JSON 等效；同时兼容旧版 8 列宽表 CSV
// （无元数据，按状态变化从位置行重建 player_state）。
func importSession(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		file, header, err := c.Request.FormFile("file")
		if err != nil {
			badRequest(c, "请上传 JSON 或 CSV 文件（字段名 file）")
			return
		}
		defer file.Close()

		body, err := io.ReadAll(io.LimitReader(file, 512<<20)) // 512MB 上限
		if err != nil {
			serverError(c, err)
			return
		}

		var data models.ExportJSON
		if isCSVUpload(header) {
			data, err = parseSessionCSV(body, header.Filename, database)
			if err != nil {
				badRequest(c, "CSV 解析失败: "+err.Error())
				return
			}
		} else {
			if err := json.Unmarshal(body, &data); err != nil {
				badRequest(c, "JSON 解析失败: "+err.Error())
				return
			}
		}
		if data.Version != 1 || len(data.Players) == 0 {
			badRequest(c, "无效的导入文件（version 必须为 1 且包含玩家数据）")
			return
		}

		ctx := c.Request.Context()
		tx, err := database.Pool.Begin(ctx)
		if err != nil {
			serverError(c, err)
			return
		}
		defer tx.Rollback(ctx)

		s := data.Session

		var newID int64
		err = tx.QueryRow(ctx,
			`INSERT INTO sessions (name, started_at, stopped_at, max_duration_sec, poll_interval_ms,
			                        mtr_url, squaremap_url, world, tile_zoom, tile_url_template,
			                        mtr_enabled, collect_station_id, collect_route_id, collect_route_station1,
			                        collect_route_station2, collect_health, collect_armor)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
			s.Name, s.StartedAt, s.StoppedAt, s.MaxDurationSec, s.PollIntervalMs,
			s.MtrURL, s.SquaremapURL, s.World, s.TileZoom, s.TileURLTemplate,
			s.MtrEnabled, s.CollectStationID, s.CollectRouteID, s.CollectRouteStation1,
			s.CollectRouteStation2, s.CollectHealth, s.CollectArmor).Scan(&newID)
		if err != nil {
			serverError(c, err)
			return
		}

		// 逐玩家批量插入
		for _, p := range data.Players {
			if err := copyActivity(ctx, tx, newID, p.UUID, p.Name, p.Activity); err != nil {
				serverError(c, err)
				return
			}
			state := p.State
			if err := copyState(ctx, tx, newID, p.UUID, state); err != nil {
				serverError(c, err)
				return
			}
		}

		if err := tx.Commit(ctx); err != nil {
			serverError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "sessionId": newID, "name": s.Name})
	}
}

// isCSVUpload 按文件扩展名与 Content-Type 判断是否为 CSV 上传
func isCSVUpload(header *multipart.FileHeader) bool {
	if header == nil {
		return false
	}
	if strings.HasSuffix(strings.ToLower(header.Filename), ".csv") {
		return true
	}
	ct := header.Header.Get("Content-Type")
	return strings.Contains(ct, "csv")
}

// csvImportRow CSV 一行。recType 为空表示旧版宽表（无 record_type 列）。
type csvImportRow struct {
	recType string // activity | state
	t       time.Time
	uuid    string
	name    string
	x, z    float64
	yaw     *float64
	health  *float64
	armor   *int
	station *string
	route   *string
	rs1     *string
	rs2     *string
}

// csvStrVal 取指针字符串值（nil 视为空串，仅用于旧格式的状态去重 key）
func csvStrVal(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// splitCSVMeta 剥离表头之前的 "#mc-activity-replay.<key>=<value>" 注释行，
// 返回元数据与剩余 CSV 正文。旧格式文件没有注释行，返回空 map。
func splitCSVMeta(body []byte) (map[string]string, []byte) {
	meta := map[string]string{}
	lines := strings.Split(string(body), "\n")
	rest := make([]string, 0, len(lines))
	headerSeen := false
	for _, ln := range lines {
		trimmed := strings.TrimSpace(strings.TrimPrefix(ln, "\ufeff"))
		if !headerSeen {
			if strings.HasPrefix(trimmed, "#") {
				if strings.HasPrefix(trimmed, csvMetaPrefix) {
					kv := strings.SplitN(strings.TrimPrefix(trimmed, csvMetaPrefix), "=", 2)
					if len(kv) == 2 {
						meta[strings.TrimSpace(kv[0])] = kv[1]
					}
				}
				continue
			}
			if trimmed == "" {
				continue // 注释与表头之间的空行
			}
			headerSeen = true
		}
		rest = append(rest, ln)
	}
	return meta, []byte(strings.Join(rest, "\n"))
}

func parseCSVFloatPtr(v string) *float64 {
	if v == "" {
		return nil
	}
	if f, err := strconv.ParseFloat(v, 64); err == nil {
		return &f
	}
	return nil
}

func parseCSVIntPtr(v string) *int {
	if v == "" {
		return nil
	}
	if n, err := strconv.Atoi(v); err == nil {
		return &n
	}
	return nil
}

// parseSessionCSV 解析 CSV 为 ExportJSON。
//
// 支持两种格式：
//   - 新版（导出的 CSV 自带 `record_type` 列）：表头前注释行还原完整会话元数据；
//     activity 行写位置点、state 行写独立状态记录（精确保留时间，不去重），
//     与 JSON 导入等效。
//   - 旧版宽表（8 列，无 record_type）：元数据由数据推导，乘坐状态按
//     「状态变化才记录」从位置行去重重建。
func parseSessionCSV(body []byte, filename string, database *db.DB) (models.ExportJSON, error) {
	meta, data := splitCSVMeta(body)

	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1 // 容忍末尾缺列
	reader.TrimLeadingSpace = true
	records, err := reader.ReadAll()
	if err != nil {
		return models.ExportJSON{}, fmt.Errorf("读取 CSV 失败: %w", err)
	}
	if len(records) == 0 {
		return models.ExportJSON{}, fmt.Errorf("CSV 为空")
	}

	// 表头按列名定位（新旧格式列数不同，避免写死下标）
	header := records[0]
	col := make(map[string]int, len(header))
	for i, h := range header {
		col[strings.ToLower(strings.TrimSpace(strings.TrimPrefix(h, "\ufeff")))] = i
	}
	if _, ok := col["time"]; !ok {
		return models.ExportJSON{}, fmt.Errorf("CSV 表头缺少 time 列（应为导出生成的 CSV）")
	}
	if _, ok := col["player_uuid"]; !ok {
		return models.ExportJSON{}, fmt.Errorf("CSV 表头缺少 player_uuid 列")
	}
	_, typed := col["record_type"]

	get := func(rec []string, name string) string {
		i, ok := col[name]
		if !ok || i >= len(rec) {
			return ""
		}
		return strings.TrimSpace(rec[i])
	}

	var rows []csvImportRow
	for _, rec := range records[1:] {
		if len(rec) == 0 {
			continue
		}
		rt := strings.ToLower(get(rec, "record_type"))
		if typed && rt != "activity" && rt != "state" {
			continue // 未知行类型（为将来扩展留出空间）
		}
		if rt == "" {
			rt = "activity"
		}
		rawTime := get(rec, "time")
		if rawTime == "" {
			continue
		}
		t, err := time.Parse(time.RFC3339, rawTime)
		if err != nil {
			return models.ExportJSON{}, fmt.Errorf("时间解析失败（应为 RFC3339，可带小数秒）: %q", rawTime)
		}
		// 新版文本状态列用 \N 表示 NULL；旧版空字段一律视为空字符串（保持原行为）
		strOf := func(name string) *string {
			v := get(rec, name)
			if typed && v == csvNull {
				return nil
			}
			return &v
		}
		row := csvImportRow{
			recType: rt,
			t:       t,
			uuid:    get(rec, "player_uuid"),
			name:    get(rec, "player_name"),
			yaw:     parseCSVFloatPtr(get(rec, "yaw")),
			health:  parseCSVFloatPtr(get(rec, "health")),
			armor:   parseCSVIntPtr(get(rec, "armor")),
			station: strOf("station_id"),
			route:   strOf("route_id"),
			rs1:     strOf("route_station_id1"),
			rs2:     strOf("route_station_id2"),
		}
		if rt == "state" {
			rows = append(rows, row)
			continue
		}
		// 位置行必须有坐标
		x, err := strconv.ParseFloat(get(rec, "x"), 64)
		if err != nil {
			return models.ExportJSON{}, fmt.Errorf("x 解析失败: %q", get(rec, "x"))
		}
		z, err := strconv.ParseFloat(get(rec, "z"), 64)
		if err != nil {
			return models.ExportJSON{}, fmt.Errorf("z 解析失败: %q", get(rec, "z"))
		}
		row.x, row.z = x, z
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		return models.ExportJSON{}, fmt.Errorf("CSV 无数据行")
	}

	// 全局按时间排序（稳定）：activity 与 state 各自保持时间升序
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].t.Before(rows[j].t) })

	// 按玩家分组（保持出现顺序）
	order := []string{}
	players := map[string]*models.ExportPlayer{}
	lastState := map[string]string{}
	for _, r := range rows {
		if r.uuid == "" {
			continue
		}
		p, ok := players[r.uuid]
		if !ok {
			p = &models.ExportPlayer{UUID: r.uuid, Name: r.name}
			players[r.uuid] = p
			order = append(order, r.uuid)
		}
		if p.Name == "" {
			p.Name = r.name
		}
		if r.recType == "state" {
			// 新格式：状态记录带独立采集时间，原样保留
			p.State = append(p.State, models.StateRecord{
				Time:            r.t,
				StationID:       r.station,
				RouteID:         r.route,
				RouteStationID1: r.rs1,
				RouteStationID2: r.rs2,
				Health:          r.health,
				Armor:           r.armor,
			})
			continue
		}
		p.Activity = append(p.Activity, models.ActivityPoint{Time: r.t, X: r.x, Z: r.z, Yaw: r.yaw})
		if !typed {
			// 旧版宽表没有独立状态段：按「状态变化才记录」从位置行重建
			key := csvStrVal(r.station) + "\x00" + csvStrVal(r.route)
			if key != lastState[r.uuid] {
				lastState[r.uuid] = key
				p.State = append(p.State, models.StateRecord{
					Time: r.t, StationID: r.station, RouteID: r.route,
				})
			}
		}
	}
	if len(order) == 0 {
		return models.ExportJSON{}, fmt.Errorf("CSV 中没有有效的玩家数据（player_uuid 为空）")
	}

	// 会话元数据：新版用文件头注释还原，旧版由数据推导
	cfgMap := loadConfigMap(database)
	sess := deriveSessionCSV(filename, rows, cfgMap)
	applyCSVMeta(&sess, meta)

	exportPlayers := make([]models.ExportPlayer, 0, len(order))
	for _, uuid := range order {
		exportPlayers = append(exportPlayers, *players[uuid])
	}
	return models.ExportJSON{Version: 1, Session: sess, Players: exportPlayers}, nil
}

// deriveSessionCSV 由数据推导会话元数据（旧版宽表无元数据时的兜底）
func deriveSessionCSV(filename string, rows []csvImportRow, cfgMap map[string]string) models.Session {
	tileZoom := 3
	if v := strings.TrimSpace(cfgMap["default_tile_zoom"]); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			tileZoom = n
		}
	}
	// 起止时间与轮询间隔只看位置行（状态行时间更密，会拉低中位数）
	act := make([]csvImportRow, 0, len(rows))
	for _, r := range rows {
		if r.recType != "state" {
			act = append(act, r)
		}
	}
	if len(act) == 0 {
		act = rows
	}
	return models.Session{
		Name:             importSessionName(filename),
		StartedAt:        act[0].t,
		StoppedAt:        &act[len(act)-1].t,
		PollIntervalMs:   medianIntervalMs(act),
		MtrURL:           cfgMap["mtr_url"],
		SquaremapURL:     cfgMap["squaremap_url"],
		World:            "minecraft_overworld", // 系统默认世界名
		TileZoom:         tileZoom,
		TileURLTemplate:  "/tiles/{world}/{zoom}/{x}_{z}.png", // 系统默认瓦片模板
		MtrEnabled:       true,
		CollectStationID: true,
		CollectRouteID:   true,
	}
}

// applyCSVMeta 用文件头注释还原会话元数据（解析失败的字段保留推导值）
func applyCSVMeta(s *models.Session, meta map[string]string) {
	if len(meta) == 0 {
		return
	}
	if v, ok := meta["name"]; ok && strings.TrimSpace(v) != "" {
		s.Name = v
	}
	if v, ok := meta["started_at"]; ok {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			s.StartedAt = t.UTC()
		}
	}
	if v, ok := meta["stopped_at"]; ok && v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			u := t.UTC()
			s.StoppedAt = &u
		}
	}
	if v, ok := meta["max_duration_sec"]; ok && v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			s.MaxDurationSec = &n
		}
	}
	if v, ok := meta["stopped_reason"]; ok && v != "" {
		s.StoppedReason = &v
	}
	if v, ok := meta["poll_interval_ms"]; ok {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			s.PollIntervalMs = n
		}
	}
	if v, ok := meta["mtr_url"]; ok {
		s.MtrURL = v
	}
	if v, ok := meta["squaremap_url"]; ok {
		s.SquaremapURL = v
	}
	if v, ok := meta["world"]; ok && v != "" {
		s.World = v
	}
	if v, ok := meta["tile_zoom"]; ok {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			s.TileZoom = n
		}
	}
	if v, ok := meta["tile_url_template"]; ok && v != "" {
		s.TileURLTemplate = v
	}
	boolFlag := func(key string, dst *bool) {
		if v, ok := meta[key]; ok {
			*dst = v == "1" || strings.EqualFold(v, "true")
		}
	}
	boolFlag("mtr_enabled", &s.MtrEnabled)
	boolFlag("collect_station_id", &s.CollectStationID)
	boolFlag("collect_route_id", &s.CollectRouteID)
	boolFlag("collect_route_station1", &s.CollectRouteStation1)
	boolFlag("collect_route_station2", &s.CollectRouteStation2)
	boolFlag("collect_health", &s.CollectHealth)
	boolFlag("collect_armor", &s.CollectArmor)
}

// importSessionName 由上传文件名生成会话名（去目录与扩展名，过滤非法字符）
func importSessionName(filename string) string {
	base := filepath.Base(strings.TrimSpace(filename))
	if ext := filepath.Ext(base); ext != "" {
		base = strings.TrimSuffix(base, ext)
	}
	base = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\?%*:|"<>`, r) {
			return '_'
		}
		return r
	}, base)
	base = strings.TrimSpace(base)
	if base == "" {
		base = "会话"
	}
	return "导入_" + base
}

// medianIntervalMs 相邻点时间间隔的中位数（毫秒），作为导入会话的轮询间隔
func medianIntervalMs(rows []csvImportRow) int {
	const fallback = 1000
	if len(rows) < 2 {
		return fallback
	}
	diffs := make([]int, 0, len(rows)-1)
	for i := 1; i < len(rows); i++ {
		if d := int(rows[i].t.Sub(rows[i-1].t).Milliseconds()); d > 0 {
			diffs = append(diffs, d)
		}
	}
	if len(diffs) == 0 {
		return fallback
	}
	sort.Ints(diffs)
	m := diffs[len(diffs)/2]
	if m < 50 {
		m = 50
	}
	if m > 600000 {
		m = 600000
	}
	return m
}

func copyActivity(ctx context.Context, tx pgx.Tx, sessionID int64, uuid, name string, points []models.ActivityPoint) error {
	if len(points) == 0 {
		return nil
	}
	for start := 0; start < len(points); start += exportBatchSize {
		end := start + exportBatchSize
		if end > len(points) {
			end = len(points)
		}
		batch := points[start:end]
		_, err := tx.CopyFrom(ctx,
			pgx.Identifier{"player_activity"},
			[]string{"time", "session_id", "player_uuid", "player_name", "x", "z", "yaw"},
			pgx.CopyFromSlice(len(batch), func(i int) ([]any, error) {
				p := batch[i]
				return []any{p.Time, sessionID, uuid, name, p.X, p.Z, p.Yaw}, nil
			}))
		if err != nil {
			return fmt.Errorf("导入位置数据失败: %w", err)
		}
	}
	return nil
}

func copyState(ctx context.Context, tx pgx.Tx, sessionID int64, uuid string, records []models.StateRecord) error {
	if len(records) == 0 {
		return nil
	}
	for start := 0; start < len(records); start += exportBatchSize {
		end := start + exportBatchSize
		if end > len(records) {
			end = len(records)
		}
		batch := records[start:end]
		_, err := tx.CopyFrom(ctx,
			pgx.Identifier{"player_state"},
			[]string{"time", "session_id", "player_uuid", "health", "armor", "station_id", "route_id", "route_station_id1", "route_station_id2"},
			pgx.CopyFromSlice(len(batch), func(i int) ([]any, error) {
				r := batch[i]
				return []any{r.Time, sessionID, uuid, r.Health, r.Armor, r.StationID, r.RouteID, r.RouteStationID1, r.RouteStationID2}, nil
			}))
		if err != nil {
			return fmt.Errorf("导入玩家状态数据失败: %w", err)
		}
	}
	return nil
}

// ---------- 数据库整体导出/导入（数据快照 COPY 格式 + psql 执行） ----------

func pgEnv(cfg *config.Config) []string {
	return []string{"PGPASSWORD=" + cfg.DBPassword}
}

// 数据快照导出的表清单（顺序即外键依赖顺序：sessions 在前）。
// 列清单显式书写，与 models 保持一致；排序键保证导出结果确定。
var dataSnapshotTables = []struct {
	name  string
	cols  string
	order string
}{
	{"sessions", `id, name, started_at, stopped_at, max_duration_sec, stopped_reason,
	poll_interval_ms, mtr_url, squaremap_url, world, tile_zoom, tile_url_template,
	mtr_enabled, collect_station_id, collect_route_id, collect_route_station1,
	collect_route_station2, collect_health, collect_armor, created_at`, "id"},
	{"player_activity", `"time", session_id, player_uuid, player_name, x, z, yaw`,
		`"time", session_id, player_uuid`},
	{"player_state", `"time", session_id, player_uuid, health, armor, station_id, route_id,
	route_station_id1, route_station_id2`, `"time", session_id, player_uuid`},
	{"app_config", "key, value, updated_at", "key"},
	{"admin_auth", "id, password_hash, updated_at", "id"},
}

// exportDatabase 导出整个数据库的数据快照（SQL 文件，可被 psql 直接执行）。
//
// 设计说明（为何不用 pg_dump --data-only）：
//  1. TimescaleDB hypertable 的物理数据位于 _timescaledb_internal 的分片表中，
//     pg_dump 对 hypertable 父表的 COPY 输出为 0 行，只有分片表含数据；
//     排除分片表（或只导 public.*）都会丢掉全部轨迹数据。
//  2. 带 --clean 的 pg_dump 导出含 "ALTER TABLE ONLY ... DROP CONSTRAINT"，
//     TimescaleDB hypertable 不接受该语法，导致导出文件无法被 psql 重新导入。
//  3. Alpine 的 pg_dump 非 TimescaleDB 补丁版，不会生成 timescaledb_post_restore()，
//     直接恢复 hypertable DDL 会在外键校验阶段报 "table is not a hypertable"。
//
// 因此改为通过服务端 COPY ... TO STDOUT 经 hypertable 父表读出全部行
// （转义由 PostgreSQL 保证，流式输出不占用内存），生成与 pg_dump --data-only
// 兼容的 COPY 格式 SQL；导入仍使用 psql 执行（见 importDatabase）。
// 注意：已被压缩（超过 30 天）的旧数据以内部分片形式存储，不在快照范围内。
func exportDatabase(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()

		c.Header("Content-Type", "application/sql; charset=utf-8")
		c.Header("Content-Disposition",
			fmt.Sprintf(`attachment; filename="mc-activity-db-%s.sql"`, time.Now().UTC().Format("20060102-150405")))

		w := c.Writer
		fmt.Fprintf(w, "-- Minecraft 活动记录与回放系统 数据库数据快照\n")
		fmt.Fprintf(w, "-- 格式与 pg_dump --data-only 兼容，使用 psql 导入（控制台数据库导入）\n")
		fmt.Fprintf(w, "-- 导出时间: %s\n\n", time.Now().UTC().Format(time.RFC3339))

		pc, err := database.Pool.Acquire(ctx)
		if err != nil {
			fmt.Fprintf(w, "\n-- 获取数据库连接失败: %v\n", err)
			return
		}
		defer pc.Release()

		for _, t := range dataSnapshotTables {
			fmt.Fprintf(w, "--\n-- Data for Name: %s\n--\n\n", t.name)
			fmt.Fprintf(w, "COPY public.%s (%s) FROM stdin;\n", t.name, t.cols)
			// COPY ... TO STDOUT 经 hypertable 父表读出全部行（含所有分片）
			if _, err := pc.Conn().PgConn().CopyTo(ctx, w,
				fmt.Sprintf("COPY (SELECT %s FROM public.%s ORDER BY %s) TO STDOUT",
					t.cols, t.name, t.order)); err != nil {
				fmt.Fprintf(w, "\n-- 导出 %s 失败: %v\n", t.name, err)
				return
			}
			fmt.Fprintf(w, "\\.\n\n")
		}

		// 恢复序列值（DO 块容错：序列缺失时不影响导入其余数据）
		fmt.Fprintf(w, "--\n-- Sequence values\n--\n\n")
		for _, seq := range []struct{ table, col, seqName string }{
			{"sessions", "id", "sessions_id_seq"},
			{"admin_auth", "id", "admin_auth_id_seq"},
		} {
			fmt.Fprintf(w, `DO $$
BEGIN
    PERFORM setval('public.%s', (SELECT COALESCE(MAX(%s), 0) FROM public.%s) + 1, false);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
`, seq.seqName, seq.col, seq.table)
		}
	}
}

// importDatabase 整库恢复：删除并重建数据库，由 EnsureSchema 重建结构后执行数据快照。
// 语义为"恢复"而非"在现有库上执行"——先重置为空库并重建 hypertable 结构，再导入数据：
//  1. 避免 TimescaleDB 对 "ALTER TABLE ONLY" 的限制影响；
//  2. 避免外部 SQL 直接注入 _timescaledb_catalog 导致扩展缓存与 catalog 不一致；
//  3. 恢复结果与导出一致，不会被残留数据污染。
//
// 导入文件应为控制台"数据库导出"产生的数据快照（pg_dump --data-only）。
func importDatabase(database *db.DB, cfg *config.Config, coll *collector.Collector) gin.HandlerFunc {
	return func(c *gin.Context) {
		// 记录中的采集器持有数据库写入，恢复期间必须停止
		// （用 Recording 而非 Status：Stop 过渡期间协程仍可能持有最后的 flush）
		if coll != nil && coll.Recording() {
			badRequest(c, "请先停止记录再进行数据库导入")
			return
		}

		file, _, err := c.Request.FormFile("file")
		if err != nil {
			badRequest(c, "请上传 SQL 文件（字段名 file）")
			return
		}
		defer file.Close()

		// 保存到临时文件供 psql 使用
		tmp, err := os.CreateTemp("", "mc-db-import-*.sql")
		if err != nil {
			serverError(c, err)
			return
		}
		defer os.Remove(tmp.Name())
		if _, err := io.Copy(tmp, io.LimitReader(file, 1<<30)); err != nil {
			tmp.Close()
			serverError(c, err)
			return
		}
		tmp.Close()

		// 1. 关闭旧连接池（随后的 DROP DATABASE 会强制终止残留连接）
		database.Pool.Close()

		// 2. 删除并重建空库
		if err := db.ResetDatabase(cfg); err != nil {
			// 尝试恢复连接，避免后端无限期失去数据库
			if recErr := database.Reconnect(cfg); recErr != nil {
				serverError(c, fmt.Errorf("%v；且重连失败: %v", err, recErr))
				return
			}
			serverError(c, err)
			return
		}

		// 3. 重建连接池（连向空库）
		if err := database.Reconnect(cfg); err != nil {
			serverError(c, err)
			return
		}

		// 4. 幂等重建表结构（hypertable / 索引 / 压缩策略 / 默认配置 / 管理员密码）
		if err := db.EnsureSchema(c.Request.Context(), database.Pool, cfg); err != nil {
			serverError(c, fmt.Errorf("重建数据库结构失败: %w", err))
			return
		}

		// 5. 清空结构重建时播种的数据（管理员密码、默认配置），避免与导入数据主键冲突。
		//    单条 TRUNCATE 自动处理外键依赖顺序；序列值由导入文件中的 setval 恢复。
		if _, err := database.Pool.Exec(c.Request.Context(),
			`TRUNCATE TABLE sessions, player_activity, player_state, app_config, admin_auth`); err != nil {
			serverError(c, fmt.Errorf("清空现有数据失败: %w", err))
			return
		}

		// 6. 执行数据导入
		args := []string{
			"-h", cfg.DBHost,
			"-p", cfg.DBPort,
			"-U", cfg.DBUser,
			"-d", cfg.DBName,
			"-v", "ON_ERROR_STOP=1",
			"-f", tmp.Name(),
		}
		cmd := exec.CommandContext(c.Request.Context(), "psql", args...)
		cmd.Env = append(os.Environ(), pgEnv(cfg)...)

		output, err := cmd.CombinedOutput()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":  "导入失败: " + err.Error(),
				"output": string(output),
			})
			return
		}

		// 7. 安全网：导入文件缺少 admin_auth 数据时补种管理员密码（幂等）
		if err := db.EnsureSchema(c.Request.Context(), database.Pool, cfg); err != nil {
			serverError(c, fmt.Errorf("导入后结构校验失败: %w", err))
			return
		}

		// 8. 序列兜底：导出文件自带 setval，但手工构造的快照可能没有；
		//    此处按各表最大 ID 同步序列，避免后续新建会话/密码行主键冲突。
		//    同步失败不影响已导入的数据（序列异常只影响后续 INSERT），忽略错误
		for _, seq := range []struct{ table, col, seqName string }{
			{"sessions", "id", "sessions_id_seq"},
			{"admin_auth", "id", "admin_auth_id_seq"},
		} {
			_, _ = database.Pool.Exec(c.Request.Context(),
				fmt.Sprintf(`SELECT setval('public.%s', (SELECT COALESCE(MAX(%s), 0) FROM public.%s) + 1, false)`,
					seq.seqName, seq.col, seq.table))
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "output": string(output)})
	}
}
