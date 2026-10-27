package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"mc-activity-replay/db"
)

// deletePlayerPoint 删除单个玩家的一个数据点（按采集时间精确定位）。
//
// 同一时刻的状态记录（player_state）一并删除：两者来自同一次采集，
// 只删位置会留下与轨迹脱节的状态变化。返回删除行数与该玩家剩余点数，
// 供回放页即时更新本地轨迹。
//
// 查询参数 time 为 RFC3339（可带小数秒），例如 2026-10-27T10:00:00.123Z。
func deletePlayerPoint(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := parseID(c, "id")
		if !ok {
			return
		}
		uuid := c.Param("uuid")
		if uuid == "" {
			badRequest(c, "缺少玩家 UUID")
			return
		}
		at, err := parseTimeParam(c, "time")
		if err != nil {
			badRequest(c, err.Error())
			return
		}
		if at == nil {
			badRequest(c, "请提供 time 参数（RFC3339，可带小数秒）")
			return
		}

		ctx := c.Request.Context()
		tx, err := database.Pool.Begin(ctx)
		if err != nil {
			serverError(c, err)
			return
		}
		defer tx.Rollback(ctx)

		tag, err := tx.Exec(ctx,
			`DELETE FROM player_activity
			 WHERE session_id = $1 AND player_uuid = $2
			   AND time >= $3 AND time < $3 + interval '1 millisecond'`, id, uuid, *at)
		if err != nil {
			serverError(c, err)
			return
		}
		deleted := tag.RowsAffected()
		if deleted == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "未找到该数据点（可能已被删除）"})
			return
		}
		// 状态记录：同一采集时刻，跟随位置点一起删除（缺失时忽略）
		// 同样使用 1ms 窗口：浏览器 JS 时间精度为毫秒，数据库为微秒
		if _, err := tx.Exec(ctx,
			`DELETE FROM player_state
			 WHERE session_id = $1 AND player_uuid = $2
			   AND time >= $3 AND time < $3 + interval '1 millisecond'`, id, uuid, *at); err != nil {
			serverError(c, err)
			return
		}

		var remaining int64
		if err := tx.QueryRow(ctx,
			`SELECT COUNT(*) FROM player_activity WHERE session_id = $1 AND player_uuid = $2`,
			id, uuid).Scan(&remaining); err != nil {
			serverError(c, err)
			return
		}
		if err := tx.Commit(ctx); err != nil {
			serverError(c, err)
			return
		}

		c.JSON(http.StatusOK, gin.H{"ok": true, "deleted": deleted, "remaining": remaining})
	}
}
