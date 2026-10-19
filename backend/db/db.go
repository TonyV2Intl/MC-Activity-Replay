// Package db 负责数据库连接与结构迁移
package db

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"mc-activity-replay/config"
)

// DB 数据库连接池封装
type DB struct {
	Pool *pgxpool.Pool
	mu   sync.Mutex
}

// Connect 连接数据库（带重试，等待容器就绪）
func Connect(cfg *config.Config) (*DB, error) {
	d := &DB{}
	if err := d.connect(cfg); err != nil {
		return nil, err
	}
	return d, nil
}

func (d *DB) connect(cfg *config.Config) error {
	poolCfg, err := pgxpool.ParseConfig(cfg.DSN())
	if err != nil {
		return fmt.Errorf("解析 DSN 失败: %w", err)
	}
	poolCfg.MaxConns = 10

	// 容器启动时数据库可能尚未就绪，重试最多 60 秒
	for i := 0; i < 30; i++ {
		pool, err := pgxpool.NewWithConfig(context.Background(), poolCfg)
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			pingErr := pool.Ping(ctx)
			cancel()
			if pingErr == nil {
				d.Pool = pool
				return nil
			}
			pool.Close()
			err = pingErr
		}
		time.Sleep(2 * time.Second)
	}
	return fmt.Errorf("连接数据库失败: %w", err)
}

// Reconnect 关闭并按原配置重建连接池（用于整库导入后恢复连接）
func (d *DB) Reconnect(cfg *config.Config) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.Pool != nil {
		d.Pool.Close()
		d.Pool = nil
	}
	return d.connect(cfg)
}

// Close 关闭连接池
func (d *DB) Close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.Pool != nil {
		d.Pool.Close()
	}
}

// ResetDatabase 删除并重建目标数据库（整库恢复语义）。
// 通过维护库 postgres 连接执行，WITH (FORCE) 会终止残留连接（PG13+）。
// 重建后的库为空库，调用方需重新连接并恢复结构。
func ResetDatabase(cfg *config.Config) error {
	// 连到维护库（目标库被删除时维护连接不受影响）。
	// DSNFor 对用户信息做 URL 编码，密码含特殊字符时不会破坏连接串
	conn, err := pgx.Connect(context.Background(), cfg.DSNFor("postgres"))
	if err != nil {
		return fmt.Errorf("连接维护库失败: %w", err)
	}
	defer conn.Close(context.Background())

	ctx := context.Background()
	// 库名来自受信任的环境变量，拼接前做标识符转义
	quoted := pgx.Identifier{cfg.DBName}.Sanitize()
	if _, err := conn.Exec(ctx, fmt.Sprintf(`DROP DATABASE IF EXISTS %s WITH (FORCE)`, quoted)); err != nil {
		return fmt.Errorf("删除数据库失败: %w", err)
	}
	if _, err := conn.Exec(ctx, fmt.Sprintf(`CREATE DATABASE %s TEMPLATE template0`, quoted)); err != nil {
		return fmt.Errorf("创建数据库失败: %w", err)
	}
	return nil
}
