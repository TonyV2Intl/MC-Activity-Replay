package api

import (
	"bufio"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"mc-activity-replay/collector"
	"mc-activity-replay/config"
	"mc-activity-replay/db"
	"mc-activity-replay/models"
)

const exportBatchSize = 2000

// exportSession 导出单个会话为 JSON 或 CSV
func exportSession(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := parseID(c, "id")
		if !ok {
			return
		}
		format := c.DefaultQuery("format", "json")
		ctx := c.Request.Context()

		// 读取会话
		sess, err := scanSession(database.Pool.QueryRow(ctx,
			`SELECT `+sessionCols+` FROM sessions WHERE id = $1`, id))
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "会话不存在"})
			return
		}

		switch format {
		case "json":
			exportSessionJSON(c, database, sess)
		case "csv":
			exportSessionCSV(c, database, sess)
		default:
			badRequest(c, "不支持的导出格式（支持 json / csv）")
		}
	}
}

// exportSessionJSON 流式导出 JSON，避免大会话占用过多内存
func exportSessionJSON(c *gin.Context, database *db.DB, sess *models.Session) {
	ctx := c.Request.Context()
	c.Header("Content-Type", "application/json; charset=utf-8")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="session-%d.json"`, sess.ID))

	w := bufio.NewWriter(c.Writer)
	defer w.Flush()

	w.WriteString(`{"version":1,"session":`)
	sessJSON, _ := json.Marshal(sess)
	w.Write(sessJSON)
	w.WriteString(`,"players":[`)

	// 玩家列表
	pRows, err := database.Pool.Query(ctx,
		`SELECT player_uuid, (array_agg(player_name ORDER BY time))[1] AS name
		 FROM player_activity WHERE session_id = $1 GROUP BY player_uuid ORDER BY name`, sess.ID)
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
				`SELECT time, x, z, health, armor, yaw FROM player_activity
				 WHERE session_id = $1 AND player_uuid = $2 ORDER BY time ASC OFFSET $3 LIMIT $4`,
				sess.ID, p.uuid, offset, exportBatchSize)
			if err != nil {
				return
			}
			n := 0
			for aRows.Next() {
				var pt models.ActivityPoint
				if err := aRows.Scan(&pt.Time, &pt.X, &pt.Z, &pt.Health, &pt.Armor, &pt.Yaw); err != nil {
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

		// transit
		w.WriteString(`,"transit":[`)
		tRows, err := database.Pool.Query(ctx,
			`SELECT time, station_id, route_id, route_station_id1, route_station_id2
			 FROM player_transit_state WHERE session_id = $1 AND player_uuid = $2 ORDER BY time ASC`,
			sess.ID, p.uuid)
		if err != nil {
			return
		}
		firstTransit := true
		for tRows.Next() {
			var r models.TransitRecord
			if err := tRows.Scan(&r.Time, &r.StationID, &r.RouteID, &r.RouteStationID1, &r.RouteStationID2); err != nil {
				tRows.Close()
				return
			}
			if !firstTransit {
				w.WriteString(",")
			}
			firstTransit = false
			rJSON, _ := json.Marshal(r)
			w.Write(rJSON)
		}
		tRows.Close()
		w.WriteString(`]}`)
	}
	w.WriteString(`]}`)
}

// exportSessionCSV 导出宽表 CSV：每行一个数据点
func exportSessionCSV(c *gin.Context, database *db.DB, sess *models.Session) {
	ctx := c.Request.Context()
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="session-%d.csv"`, sess.ID))

	w := csv.NewWriter(c.Writer)
	defer w.Flush()

	w.Write([]string{"time", "player_uuid", "player_name", "x", "z", "health", "armor", "yaw", "station_id", "route_id"})

	// 用 LATERAL 关联每个位置点对应的最新乘坐状态
	rows, err := database.Pool.Query(ctx,
		`SELECT a.time, a.player_uuid, a.player_name, a.x, a.z, a.health, a.armor, a.yaw,
		        t.station_id, t.route_id
		 FROM player_activity a
		 LEFT JOIN LATERAL (
		     SELECT station_id, route_id FROM player_transit_state t
		     WHERE t.session_id = a.session_id AND t.player_uuid = a.player_uuid AND t.time <= a.time
		     ORDER BY t.time DESC LIMIT 1
		 ) t ON true
		 WHERE a.session_id = $1
		 ORDER BY a.time`, sess.ID)
	if err != nil {
		return
	}
	defer rows.Close()

	for rows.Next() {
		var (
			t          time.Time
			uuid, name string
			x, z       float64
			health     *float64
			armor      *int
			yaw        *float64
			stationID  *string
			routeID    *string
		)
		if err := rows.Scan(&t, &uuid, &name, &x, &z, &health, &armor, &yaw, &stationID, &routeID); err != nil {
			return
		}
		w.Write([]string{
			t.UTC().Format(time.RFC3339),
			uuid,
			name,
			strconv.FormatFloat(x, 'f', -1, 64),
			strconv.FormatFloat(z, 'f', -1, 64),
			formatFloatPtr(health),
			formatIntPtr(armor),
			formatFloatPtr(yaw),
			formatStringPtr(stationID),
			formatStringPtr(routeID),
		})
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

func formatStringPtr(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// importSession 导入会话（JSON 格式，multipart/form-data）
func importSession(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		file, _, err := c.Request.FormFile("file")
		if err != nil {
			badRequest(c, "请上传 JSON 文件（字段名 file）")
			return
		}
		defer file.Close()

		body, err := io.ReadAll(io.LimitReader(file, 512<<20)) // 512MB 上限
		if err != nil {
			serverError(c, err)
			return
		}

		var data models.ExportJSON
		if err := json.Unmarshal(body, &data); err != nil {
			badRequest(c, "JSON 解析失败: "+err.Error())
			return
		}
		if data.Version != 1 || len(data.Players) == 0 {
			badRequest(c, "无效的导出文件（version 必须为 1 且包含玩家数据）")
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
			                        mtr_url, squaremap_url, world, tile_zoom, tile_url_template)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
			s.Name, s.StartedAt, s.StoppedAt, s.MaxDurationSec, s.PollIntervalMs,
			s.MtrURL, s.SquaremapURL, s.World, s.TileZoom, s.TileURLTemplate).Scan(&newID)
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
			if err := copyTransit(ctx, tx, newID, p.UUID, p.Transit); err != nil {
				serverError(c, err)
				return
			}
		}

		if err := tx.Commit(ctx); err != nil {
			serverError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "sessionId": newID})
	}
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
			[]string{"time", "session_id", "player_uuid", "player_name", "x", "z", "health", "armor", "yaw"},
			pgx.CopyFromSlice(len(batch), func(i int) ([]any, error) {
				p := batch[i]
				return []any{p.Time, sessionID, uuid, name, p.X, p.Z, p.Health, p.Armor, p.Yaw}, nil
			}))
		if err != nil {
			return fmt.Errorf("导入位置数据失败: %w", err)
		}
	}
	return nil
}

func copyTransit(ctx context.Context, tx pgx.Tx, sessionID int64, uuid string, records []models.TransitRecord) error {
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
			pgx.Identifier{"player_transit_state"},
			[]string{"time", "session_id", "player_uuid", "station_id", "route_id", "route_station_id1", "route_station_id2"},
			pgx.CopyFromSlice(len(batch), func(i int) ([]any, error) {
				r := batch[i]
				return []any{r.Time, sessionID, uuid, r.StationID, r.RouteID, r.RouteStationID1, r.RouteStationID2}, nil
			}))
		if err != nil {
			return fmt.Errorf("导入乘坐状态数据失败: %w", err)
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
		poll_interval_ms, mtr_url, squaremap_url, world, tile_zoom, tile_url_template, created_at`, "id"},
	{"player_activity", `"time", session_id, player_uuid, player_name, x, z, health, armor, yaw`,
		`"time", session_id, player_uuid`},
	{"player_transit_state", `"time", session_id, player_uuid, station_id, route_id,
		route_station_id1, route_station_id2`, `"time", session_id, player_uuid`},
	{"app_config", "key, value, updated_at", "key"},
	{"admin_auth", "id, password_hash, updated_at", "id"},
}

// exportDatabase 导出整个数据库的数据快照（SQL 文件，可被 psql 直接执行）。
//
// 设计说明（为何不用 pg_dump --data-only）：
//   1. TimescaleDB hypertable 的物理数据位于 _timescaledb_internal 的分片表中，
//      pg_dump 对 hypertable 父表的 COPY 输出为 0 行，只有分片表含数据；
//      排除分片表（或只导 public.*）都会丢掉全部轨迹数据。
//   2. 带 --clean 的 pg_dump 导出含 "ALTER TABLE ONLY ... DROP CONSTRAINT"，
//      TimescaleDB hypertable 不接受该语法，导致导出文件无法被 psql 重新导入。
//   3. Alpine 的 pg_dump 非 TimescaleDB 补丁版，不会生成 timescaledb_post_restore()，
//      直接恢复 hypertable DDL 会在外键校验阶段报 "table is not a hypertable"。
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
// importDatabase 使用 psql 导入数据库
// importDatabase 整库恢复：删除并重建数据库，由 EnsureSchema 重建结构后执行数据快照。
// 语义为"恢复"而非"在现有库上执行"——先重置为空库并重建 hypertable 结构，再导入数据：
//   1. 避免 TimescaleDB 对 "ALTER TABLE ONLY" 的限制影响；
//   2. 避免外部 SQL 直接注入 _timescaledb_catalog 导致扩展缓存与 catalog 不一致；
//   3. 恢复结果与导出一致，不会被残留数据污染。
// 导入文件应为控制台"数据库导出"产生的数据快照（pg_dump --data-only）。
func importDatabase(database *db.DB, cfg *config.Config, coll *collector.Collector) gin.HandlerFunc {
	return func(c *gin.Context) {
		// 记录中的采集器持有数据库写入，恢复期间必须停止
		if coll != nil && coll.Status().Status == "recording" {
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
			`TRUNCATE TABLE sessions, player_activity, player_transit_state, app_config, admin_auth`); err != nil {
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
		c.JSON(http.StatusOK, gin.H{"ok": true, "output": string(output)})
	}
}
