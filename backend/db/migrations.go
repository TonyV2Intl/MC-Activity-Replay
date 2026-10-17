package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
	"mc-activity-replay/config"
)

// EnsureSchema 幂等地确保数据库结构存在。
// 正常情况下 init.sql 已通过 /docker-entrypoint-initdb.d/ 完成初始化，
// 此处作为安全网：在未执行 init.sql 的环境（如本地开发/测试）中补齐结构，
// 并完成管理员密码、默认配置的种子写入。
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool, cfg *config.Config) error {
	stmts := []string{
		`CREATE EXTENSION IF NOT EXISTS timescaledb`,
		`CREATE TABLE IF NOT EXISTS sessions (
			id              SERIAL PRIMARY KEY,
			name            TEXT NOT NULL,
			started_at      TIMESTAMPTZ NOT NULL,
			stopped_at      TIMESTAMPTZ,
			max_duration_sec INTEGER,
			stopped_reason  TEXT,
			poll_interval_ms INTEGER NOT NULL DEFAULT 1000,
			mtr_url         TEXT NOT NULL,
			squaremap_url   TEXT NOT NULL,
			world           TEXT NOT NULL DEFAULT 'minecraft_overworld',
			tile_zoom       INTEGER NOT NULL DEFAULT 3,
			tile_url_template TEXT NOT NULL,
			created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS player_activity (
			time        TIMESTAMPTZ NOT NULL,
			session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			player_uuid TEXT NOT NULL,
			player_name TEXT NOT NULL,
			x           DOUBLE PRECISION NOT NULL,
			z           DOUBLE PRECISION NOT NULL,
			health      REAL,
			armor       INTEGER,
			yaw         REAL
		)`,
		`CREATE TABLE IF NOT EXISTS player_transit_state (
			time         TIMESTAMPTZ NOT NULL,
			session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			player_uuid  TEXT NOT NULL,
			station_id   TEXT,
			route_id     TEXT,
			route_station_id1 TEXT,
			route_station_id2 TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS app_config (
			key         TEXT PRIMARY KEY,
			value       TEXT NOT NULL,
			updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS admin_auth (
			id              SERIAL PRIMARY KEY,
			password_hash   TEXT NOT NULL,
			updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_activity_session_uuid_time ON player_activity (session_id, player_uuid, time)`,
		`CREATE INDEX IF NOT EXISTS idx_activity_session_time ON player_activity (session_id, time)`,
		`CREATE INDEX IF NOT EXISTS idx_transit_session_uuid_time ON player_transit_state (session_id, player_uuid, time)`,
	}

	for _, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			return fmt.Errorf("执行建表语句失败: %w", err)
		}
	}

	// hypertable 创建（仅当尚未是 hypertable 时）
	if err := ensureHypertable(ctx, pool, "player_activity", "1 day"); err != nil {
		return err
	}
	if err := ensureHypertable(ctx, pool, "player_transit_state", "7 days"); err != nil {
		return err
	}

	// 压缩策略（幂等）
	for _, t := range []string{"player_activity", "player_transit_state"} {
		if _, err := pool.Exec(ctx, fmt.Sprintf(
			`ALTER TABLE %s SET (timescaledb.compress, timescaledb.compress_segmentby = 'session_id, player_uuid', timescaledb.compress_orderby = 'time DESC')`, t)); err != nil {
			return fmt.Errorf("设置 %s 压缩属性失败: %w", t, err)
		}
		var exists bool
		err := pool.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression' AND hypertable_name = $1)`, t).Scan(&exists)
		if err != nil {
			return fmt.Errorf("查询压缩策略失败: %w", err)
		}
		if !exists {
			if _, err := pool.Exec(ctx, fmt.Sprintf(`SELECT add_compression_policy('%s', INTERVAL '30 days')`, t)); err != nil {
				return fmt.Errorf("添加 %s 压缩策略失败: %w", t, err)
			}
		}
	}

	// 默认配置种子
	defaults := [][2]string{
		{"mtr_url", "https://letsplay.minecrafttransitrailway.com/system-map/mtr/api/map/clients?dimension=0"},
		{"squaremap_url", "https://letsplay.minecrafttransitrailway.com/world-map"},
		{"tile_url_template", "/tiles/{world}/{zoom}/{x}_{z}.png"},
		{"default_world", "minecraft_overworld"},
		{"default_tile_zoom", "3"},
		{"default_poll_interval_ms", "1000"},
		{"default_max_duration_sec", ""},
	}
	for _, kv := range defaults {
		if _, err := pool.Exec(ctx,
			`INSERT INTO app_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, kv[0], kv[1]); err != nil {
			return fmt.Errorf("写入默认配置失败: %w", err)
		}
	}

	// 初始管理员密码（仅当 admin_auth 为空时）
	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM admin_auth`).Scan(&count); err != nil {
		return fmt.Errorf("查询 admin_auth 失败: %w", err)
	}
	if count == 0 {
		hash, err := bcrypt.GenerateFromPassword([]byte(cfg.InitialAdminPassword), bcrypt.DefaultCost)
		if err != nil {
			return fmt.Errorf("生成密码哈希失败: %w", err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO admin_auth (password_hash) VALUES ($1)`, string(hash)); err != nil {
			return fmt.Errorf("写入初始管理员密码失败: %w", err)
		}
	}
	return nil
}

func ensureHypertable(ctx context.Context, pool *pgxpool.Pool, table, chunkInterval string) error {
	var exists bool
	err := pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = $1)`, table).Scan(&exists)
	if err != nil {
		return fmt.Errorf("查询 hypertable 失败: %w", err)
	}
	if !exists {
		if _, err := pool.Exec(ctx, fmt.Sprintf(
			`SELECT create_hypertable('%s', 'time', chunk_time_interval => INTERVAL '%s')`, table, chunkInterval)); err != nil {
			return fmt.Errorf("创建 %s hypertable 失败: %w", table, err)
		}
	}
	return nil
}

// LoadConfigMap 读取全部全局配置为 map
func LoadConfigMap(ctx context.Context, pool *pgxpool.Pool) map[string]string {
	m := make(map[string]string)
	rows, err := pool.Query(ctx, `SELECT key, value FROM app_config`)
	if err != nil {
		return m
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err == nil {
			m[k] = v
		}
	}
	return m
}
