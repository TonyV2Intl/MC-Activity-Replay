package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"mc-activity-replay/db"
)

// 已知配置项。
// 世界名与瓦片 URL 模板固定为系统默认值，不提供配置项（见 collector.Start）。
var knownConfigKeys = []string{
	"mtr_url",
	"squaremap_url",
	"mirror_url",
	"default_tile_zoom",
	"default_poll_interval_ms",
	"default_max_duration_sec",
}

// getConfig 返回所有配置
func getConfig(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"config": loadConfigMap(database)})
	}
}

// updateConfig 更新配置
func updateConfig(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			Config map[string]string `json:"config" binding:"required"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			// 也允许直接平铺的键值对形式
			var flat map[string]string
			if err2 := c.ShouldBindJSON(&flat); err2 != nil {
				badRequest(c, "请提供配置对象")
				return
			}
			body.Config = flat
		}

		ctx := c.Request.Context()
		for key, value := range body.Config {
			if !isKnownConfigKey(key) {
				continue // 忽略未知配置项
			}
			if _, err := database.Pool.Exec(ctx,
				`INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
				 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
				key, value); err != nil {
				serverError(c, err)
				return
			}
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "config": loadConfigMap(database)})
	}
}

func isKnownConfigKey(key string) bool {
	for _, k := range knownConfigKeys {
		if k == key {
			return true
		}
	}
	return false
}
