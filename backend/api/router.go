// Package api 实现 HTTP API 层
package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"mc-activity-replay/collector"
	"mc-activity-replay/config"
	"mc-activity-replay/db"
)

// NewRouter 创建 Gin 路由
func NewRouter(database *db.DB, cfg *config.Config, coll *collector.Collector) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	api := r.Group("/api")
	{
		// 公开端点：登录
		api.POST("/login", login(database, cfg))

		// 以下端点均需 Cookie 认证
		auth := api.Group("")
		auth.Use(AuthRequired(cfg))
		{
			auth.POST("/logout", logout)
			auth.GET("/auth/check", authCheck)
			auth.POST("/auth/password", changePassword(database))

			auth.GET("/collector/status", func(c *gin.Context) {
				c.JSON(http.StatusOK, coll.Status())
			})
			auth.POST("/collector/start", startCollector(database, coll))
			auth.POST("/collector/stop", stopCollector(coll))
			auth.GET("/collector/live", liveCollector(coll))
			auth.GET("/collector/preview", previewLive(coll))

			auth.GET("/sessions", listSessions(database))
			auth.GET("/sessions/:id", getSession(database))
			auth.PATCH("/sessions/:id", renameSession(database))
			auth.DELETE("/sessions/:id", deleteSession(database))
			auth.POST("/sessions/merge", mergeSessions(database))
			auth.POST("/sessions/import", importSession(database))

			auth.GET("/sessions/:id/players", sessionPlayers(database))
			auth.GET("/sessions/:id/players/:uuid/trajectory", trajectory(database))
			auth.GET("/sessions/:id/players/:uuid/state", playerState(database))
			auth.GET("/sessions/:id/players/:uuid/export", exportPlayerPeriod(database))
			auth.DELETE("/sessions/:id/players/:uuid/points", deletePlayerPoint(database))
			auth.GET("/sessions/:id/snapshot", snapshot(database))
			auth.GET("/sessions/:id/export", exportSession(database))

			auth.GET("/config", getConfig(database))
			auth.PUT("/config", updateConfig(database))

			// MTR 站点/线路 ID → 名称映射（回放 tooltip 显示站名/线名）
			auth.GET("/network/names", networkNames(database))

			// 瓦片代理：浏览器经后端中转下载 Squaremap 瓦片（上游取 mirror_url，回退 squaremap_url）
			auth.GET("/tiles/*rest", tileProxy(database))

			auth.GET("/database/export", exportDatabase(database))
			auth.POST("/database/import", importDatabase(database, cfg, coll))
			auth.POST("/database/wipe", wipeDatabase(database, cfg, coll))
		}
	}

	r.NoRoute(func(c *gin.Context) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
	})
	return r
}

// parseID 解析路径中的 int64 ID 参数
func parseID(c *gin.Context, name string) (int64, bool) {
	id, err := strconv.ParseInt(c.Param(name), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的 ID"})
		return 0, false
	}
	return id, true
}

// badRequest 统一错误响应
func badRequest(c *gin.Context, msg string) {
	c.JSON(http.StatusBadRequest, gin.H{"error": msg})
}

func serverError(c *gin.Context, err error) {
	c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
}
