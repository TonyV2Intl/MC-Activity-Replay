package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"mc-activity-replay/collector"
	"mc-activity-replay/config"
	"mc-activity-replay/db"
)

// wipeDatabase 一键清空数据库：TRUNCATE 全部表 → EnsureSchema 重新种子
// 默认配置与初始管理员密码 → 清空采集器内存快照。
// 用于彻底重置系统，**不可恢复**；录制中拒绝执行。
func wipeDatabase(database *db.DB, cfg *config.Config, coll *collector.Collector) gin.HandlerFunc {
	return func(c *gin.Context) {
		// 记录中的采集器持有数据库写入，清空期间必须停止
		// （用 Recording 而非 Status：Stop 等待轮询协程退出期间 Status 表现为
		// idle，但协程仍可能持有最后的 flush 写入）
		if coll != nil && coll.Recording() {
			badRequest(c, "请先停止记录再清空数据库")
			return
		}

		ctx := c.Request.Context()
		// 单条 TRUNCATE 必须包含全部表：player_activity / player_state
		// 经外键引用 sessions，分表截断会触发 "cannot truncate a table
		// referenced in a foreign key constraint"。RESTART IDENTITY 重置
		// SERIAL 序列，达到“全新安装”效果（hypertable 无自增列，无副作用）
		if _, err := database.Pool.Exec(ctx,
			`TRUNCATE TABLE sessions, player_activity, player_state, app_config, admin_auth RESTART IDENTITY`); err != nil {
			serverError(c, err)
			return
		}

		// 重新种子：默认配置（含镜像等新键）与初始管理员密码（admin_auth 已空）
		if err := db.EnsureSchema(ctx, database.Pool, cfg); err != nil {
			serverError(c, err)
			return
		}

		// 清空采集器内存中的实时快照，避免清空后监控仍显示旧玩家
		if coll != nil {
			coll.ClearLive()
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}
