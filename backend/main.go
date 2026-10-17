// main 程序入口：加载配置 → 连接数据库 → 确保结构 → 启动采集器与 API 服务
package main

import (
	"context"
	"log"

	"mc-activity-replay/api"
	"mc-activity-replay/collector"
	"mc-activity-replay/config"
	"mc-activity-replay/db"
)

func main() {
	cfg := config.Load()

	database, err := db.Connect(cfg)
	if err != nil {
		log.Fatalf("数据库连接失败: %v", err)
	}
	defer database.Close()

	// 幂等结构迁移 + 初始管理员密码/默认配置种子
	if err := db.EnsureSchema(context.Background(), database.Pool, cfg); err != nil {
		log.Fatalf("数据库结构初始化失败: %v", err)
	}

	// 采集器（初始 URL 取自全局配置，运行中开始记录时仍可按请求覆盖）
	configMap := db.LoadConfigMap(context.Background(), database.Pool)
	mtrURL := configMap["mtr_url"]
	if mtrURL == "" {
		mtrURL = "https://letsplay.minecrafttransitrailway.com/system-map/mtr/api/map/clients?dimension=0"
	}
	squaremapURL := configMap["squaremap_url"]
	if squaremapURL == "" {
		squaremapURL = "https://letsplay.minecrafttransitrailway.com/world-map"
	}
	coll := collector.New(database, mtrURL, squaremapURL)

	// 容器重启恢复：未正常结束的会话标记为 error
	if err := coll.RecoverInterruptedSessions(context.Background()); err != nil {
		log.Printf("恢复中断会话时出错: %v", err)
	}

	router := api.NewRouter(database, cfg, coll)
	log.Printf("Minecraft 活动记录与回放系统后端启动，监听端口 %s", cfg.ServerPort)
	if err := router.Run(":" + cfg.ServerPort); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}
