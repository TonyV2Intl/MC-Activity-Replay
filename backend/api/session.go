package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"mc-activity-replay/collector"
	"mc-activity-replay/db"
	"mc-activity-replay/models"
)

// scanSession 从 pgx.Row 扫描会话行
func scanSession(row pgx.Row) (*models.Session, error) {
	var s models.Session
	err := row.Scan(&s.ID, &s.Name, &s.StartedAt, &s.StoppedAt, &s.MaxDurationSec,
		&s.StoppedReason, &s.PollIntervalMs, &s.MtrURL, &s.SquaremapURL,
		&s.World, &s.TileZoom, &s.TileURLTemplate, &s.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

const sessionCols = `id, name, started_at, stopped_at, max_duration_sec, stopped_reason,
	poll_interval_ms, mtr_url, squaremap_url, world, tile_zoom, tile_url_template, created_at`

// listSessions 列出所有会话（含统计信息）
func listSessions(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := database.Pool.Query(c.Request.Context(),
			`SELECT s.id, s.name, s.started_at, s.stopped_at, s.max_duration_sec, s.stopped_reason,
			        s.poll_interval_ms, s.mtr_url, s.squaremap_url, s.world, s.tile_zoom, s.tile_url_template, s.created_at,
			        (SELECT COUNT(DISTINCT a.player_uuid) FROM player_activity a WHERE a.session_id = s.id),
			        (SELECT COUNT(*) FROM player_activity a WHERE a.session_id = s.id)
			 FROM sessions s ORDER BY s.started_at DESC`)
		if err != nil {
			serverError(c, err)
			return
		}
		defer rows.Close()

		list := make([]models.SessionWithStats, 0)
		for rows.Next() {
			var s models.SessionWithStats
			if err := rows.Scan(&s.ID, &s.Name, &s.StartedAt, &s.StoppedAt, &s.MaxDurationSec,
				&s.StoppedReason, &s.PollIntervalMs, &s.MtrURL, &s.SquaremapURL,
				&s.World, &s.TileZoom, &s.TileURLTemplate, &s.CreatedAt,
				&s.PlayerCount, &s.PointCount); err != nil {
				serverError(c, err)
				return
			}
			list = append(list, s)
		}
		c.JSON(http.StatusOK, gin.H{"sessions": list})
	}
}

// getSession 获取单个会话详情
func getSession(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := parseID(c, "id")
		if !ok {
			return
		}
		var s models.SessionWithStats
		err := database.Pool.QueryRow(c.Request.Context(),
			`SELECT s.id, s.name, s.started_at, s.stopped_at, s.max_duration_sec, s.stopped_reason,
			        s.poll_interval_ms, s.mtr_url, s.squaremap_url, s.world, s.tile_zoom, s.tile_url_template, s.created_at,
			        (SELECT COUNT(DISTINCT a.player_uuid) FROM player_activity a WHERE a.session_id = s.id),
			        (SELECT COUNT(*) FROM player_activity a WHERE a.session_id = s.id)
			 FROM sessions s WHERE s.id = $1`, id).
			Scan(&s.ID, &s.Name, &s.StartedAt, &s.StoppedAt, &s.MaxDurationSec,
				&s.StoppedReason, &s.PollIntervalMs, &s.MtrURL, &s.SquaremapURL,
				&s.World, &s.TileZoom, &s.TileURLTemplate, &s.CreatedAt,
				&s.PlayerCount, &s.PointCount)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "会话不存在"})
			return
		}
		c.JSON(http.StatusOK, s)
	}
}

// renameSession 重命名会话
func renameSession(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := parseID(c, "id")
		if !ok {
			return
		}
		var req models.RenameSessionRequest
		if err := c.ShouldBindJSON(&req); err != nil || req.Name == "" {
			badRequest(c, "请提供新的会话名称")
			return
		}
		tag, err := database.Pool.Exec(c.Request.Context(),
			`UPDATE sessions SET name = $1 WHERE id = $2`, req.Name, id)
		if err != nil {
			serverError(c, err)
			return
		}
		if tag.RowsAffected() == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "会话不存在"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// deleteSession 删除会话及关联数据
func deleteSession(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := parseID(c, "id")
		if !ok {
			return
		}
		// ON DELETE CASCADE 会级联删除 player_activity / player_transit_state
		tag, err := database.Pool.Exec(c.Request.Context(),
			`DELETE FROM sessions WHERE id = $1`, id)
		if err != nil {
			serverError(c, err)
			return
		}
		if tag.RowsAffected() == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "会话不存在"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// mergeSessions 合并多个会话（时间段不得重叠）
func mergeSessions(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req models.MergeSessionsRequest
		if err := c.ShouldBindJSON(&req); err != nil || len(req.SessionIDs) < 2 {
			badRequest(c, "请提供至少两个会话 ID")
			return
		}

		ctx := c.Request.Context()
		tx, err := database.Pool.Begin(ctx)
		if err != nil {
			serverError(c, err)
			return
		}
		defer tx.Rollback(ctx)

		// 加载所有待合并会话
		rows, err := tx.Query(ctx,
			`SELECT `+sessionCols+` FROM sessions WHERE id = ANY($1) ORDER BY started_at ASC`, req.SessionIDs)
		if err != nil {
			serverError(c, err)
			return
		}
		var sessions []models.Session
		for rows.Next() {
			s, err := scanSession(rows)
			if err != nil {
				rows.Close()
				serverError(c, err)
				return
			}
			sessions = append(sessions, *s)
		}
		rows.Close()
		if len(sessions) != len(req.SessionIDs) {
			badRequest(c, "部分会话不存在")
			return
		}

		// 进行中的会话不允许合并（stopped_at 为空视为未结束）
		for _, s := range sessions {
			if s.StoppedAt == nil {
				badRequest(c, "存在尚未结束的会话，无法合并")
				return
			}
		}

		// 重叠检查：按开始时间排序后，任意相邻两个会话时间段重叠即拒绝
		for i := 1; i < len(sessions); i++ {
			prev := sessions[i-1]
			if prev.StoppedAt.After(sessions[i].StartedAt) {
				badRequest(c, "会话时间段存在重叠，拒绝合并")
				return
			}
		}

		// 新会话参数：起始取最早，结束取最晚，其余参数取最早会话
		first := sessions[0]
		last := sessions[len(sessions)-1]
		name := first.Name + "_merged"
		if req.NewName != nil && *req.NewName != "" {
			name = *req.NewName
		}

		var newID int64
		err = tx.QueryRow(ctx,
			`INSERT INTO sessions (name, started_at, stopped_at, max_duration_sec, poll_interval_ms,
			                        mtr_url, squaremap_url, world, tile_zoom, tile_url_template)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
			name, first.StartedAt, last.StoppedAt, first.MaxDurationSec, first.PollIntervalMs,
			first.MtrURL, first.SquaremapURL, first.World, first.TileZoom, first.TileURLTemplate).Scan(&newID)
		if err != nil {
			serverError(c, err)
			return
		}

		// 迁移数据到新会话 ID
		if _, err := tx.Exec(ctx,
			`UPDATE player_activity SET session_id = $1 WHERE session_id = ANY($2)`, newID, req.SessionIDs); err != nil {
			badRequest(c, "迁移位置数据失败（数据可能已被压缩，请先解压）: "+err.Error())
			return
		}
		if _, err := tx.Exec(ctx,
			`UPDATE player_transit_state SET session_id = $1 WHERE session_id = ANY($2)`, newID, req.SessionIDs); err != nil {
			badRequest(c, "迁移乘坐状态数据失败（数据可能已被压缩，请先解压）: "+err.Error())
			return
		}

		// 删除原会话
		if _, err := tx.Exec(ctx,
			`DELETE FROM sessions WHERE id = ANY($1)`, req.SessionIDs); err != nil {
			serverError(c, err)
			return
		}

		if err := tx.Commit(ctx); err != nil {
			serverError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "sessionId": newID})
	}
}

// startCollector 开始记录
func startCollector(database *db.DB, coll *collector.Collector) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req models.StartCollectorRequest
		// 允许空 body（全部使用默认值）
		_ = c.ShouldBindJSON(&req)

		// 未提供的 URL 回退到全局配置
		if req.MtrURL == nil || req.SquaremapURL == nil {
			cfgMap := loadConfigMap(database)
			if req.MtrURL == nil {
				if v, ok := cfgMap["mtr_url"]; ok && v != "" {
					req.MtrURL = &v
				}
			}
			if req.SquaremapURL == nil {
				if v, ok := cfgMap["squaremap_url"]; ok && v != "" {
					req.SquaremapURL = &v
				}
			}
		}

		sess, err := coll.Start(c.Request.Context(), req)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, sess)
	}
}

// stopCollector 停止记录
func stopCollector(coll *collector.Collector) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := coll.Stop(c.Request.Context(), "manual"); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// liveCollector 实时玩家列表
func liveCollector(coll *collector.Collector) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, coll.Live())
	}
}
