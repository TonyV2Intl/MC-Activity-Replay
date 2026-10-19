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
// 并完成旧版本结构迁移、管理员密码、默认配置的种子写入。
//
// 结构迁移（v2，player_state）：
//   - player_transit_state  hypertable 改名（数据/分片/压缩策略自动保留）
//   - player_state 增加 health / armor 列（来自 Squaremap 的可选采集字段）
//   - sessions 增加 mtr_enabled 与 6 个 collect_* 采集标志列
//   - app_config 增加对应的 7 个默认值键
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool, cfg *config.Config) error {
	// 1. 扩展
	if _, err := pool.Exec(ctx, `CREATE EXTENSION IF NOT EXISTS timescaledb`); err != nil {
		return fmt.Errorf("创建 timescaledb 扩展失败: %w", err)
	}

	// 2. 旧表改名（必须在 CREATE TABLE IF NOT EXISTS player_state 之前！
	//    否则旧库上会先建出空的目标表，改名检查因目标已存在而被跳过，
	//    导致全部数据滞留旧表）。改名仅在新表不存在时执行。
	var oldTableExists, newTableExists bool
	if err := pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = 'player_transit_state')`).Scan(&oldTableExists); err != nil {
		return fmt.Errorf("查询旧表 player_transit_state 失败: %w", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = 'player_state')`).Scan(&newTableExists); err != nil {
		return fmt.Errorf("查询新表 player_state 失败: %w", err)
	}
	if oldTableExists && !newTableExists {
		if _, err := pool.Exec(ctx, `ALTER TABLE player_transit_state RENAME TO player_state`); err != nil {
			return fmt.Errorf("重命名 player_transit_state 失败: %w", err)
		}
	}

	// 3. 建表（幂等；旧库在上一步已完成改名，此处为 no-op）
	stmts := []string{
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
			mtr_enabled     BOOLEAN NOT NULL DEFAULT true,
			collect_station_id BOOLEAN NOT NULL DEFAULT true,
			collect_route_id BOOLEAN NOT NULL DEFAULT true,
			collect_route_station1 BOOLEAN NOT NULL DEFAULT true,
			collect_route_station2 BOOLEAN NOT NULL DEFAULT true,
			collect_health  BOOLEAN NOT NULL DEFAULT false,
			collect_armor   BOOLEAN NOT NULL DEFAULT false,
			created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS player_activity (
			time        TIMESTAMPTZ NOT NULL,
			session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			player_uuid TEXT NOT NULL,
			player_name TEXT NOT NULL,
			x           DOUBLE PRECISION NOT NULL,
			z           DOUBLE PRECISION NOT NULL,
			yaw         REAL
		)`,
		`CREATE TABLE IF NOT EXISTS player_state (
			time         TIMESTAMPTZ NOT NULL,
			session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			player_uuid  TEXT NOT NULL,
			health       REAL,
			armor        INTEGER,
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
	}

	for _, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			return fmt.Errorf("执行建表语句失败: %w", err)
		}
	}

	// ---- v2 结构迁移（幂等，旧库执行；新库上述语句已建好，以下均为 no-op）----

	// 1. player_state 增加 health / armor 列（旧库可能没有）
	if _, err := pool.Exec(ctx, `ALTER TABLE player_state ADD COLUMN IF NOT EXISTS health REAL`); err != nil {
		return fmt.Errorf("添加 player_state.health 列失败: %w", err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE player_state ADD COLUMN IF NOT EXISTS armor INTEGER`); err != nil {
		return fmt.Errorf("添加 player_state.armor 列失败: %w", err)
	}

	// 2. sessions 增加采集标志列（旧库可能没有）
	for _, ddl := range []string{
		`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mtr_enabled BOOLEAN NOT NULL DEFAULT true`,
		`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS collect_station_id BOOLEAN NOT NULL DEFAULT true`,
		`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS collect_route_id BOOLEAN NOT NULL DEFAULT true`,
		`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS collect_route_station1 BOOLEAN NOT NULL DEFAULT true`,
		`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS collect_route_station2 BOOLEAN NOT NULL DEFAULT true`,
		`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS collect_health BOOLEAN NOT NULL DEFAULT false`,
		`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS collect_armor BOOLEAN NOT NULL DEFAULT false`,
	} {
		if _, err := pool.Exec(ctx, ddl); err != nil {
			return fmt.Errorf("添加 sessions 采集标志列失败: %w", err)
		}
	}

	// 3. 索引改名（旧库残留的 transit 命名；新库已是目标名，ALTER IF EXISTS 为 no-op）。
	//    必须先改名再建索引：否则 CREATE IF NOT EXISTS 会先把新名建出来，改名必失败。
	//    上次迁移中途失败可能同时留下旧名与新名两个重复索引，先删旧名再改名。
	var oldIdxExists, newIdxExists bool
	if err := pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname = 'idx_transit_session_uuid_time')`).Scan(&oldIdxExists); err != nil {
		return fmt.Errorf("查询旧索引失败: %w", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname = 'idx_state_session_uuid_time')`).Scan(&newIdxExists); err != nil {
		return fmt.Errorf("查询新索引失败: %w", err)
	}
	if oldIdxExists && newIdxExists {
		if _, err := pool.Exec(ctx, `DROP INDEX idx_transit_session_uuid_time`); err != nil {
			return fmt.Errorf("清理重复索引失败: %w", err)
		}
	}
	for _, ddl := range []string{
		`ALTER INDEX IF EXISTS idx_transit_session_uuid_time RENAME TO idx_state_session_uuid_time`,
		`ALTER INDEX IF EXISTS player_transit_state_time_idx RENAME TO player_state_time_idx`,
	} {
		if _, err := pool.Exec(ctx, ddl); err != nil {
			return fmt.Errorf("重命名索引失败: %w", err)
		}
	}
	// 新库（或索引缺失时）补建（改名成功后此处为 no-op）
	if _, err := pool.Exec(ctx,
		`CREATE INDEX IF NOT EXISTS idx_state_session_uuid_time ON player_state (session_id, player_uuid, time)`); err != nil {
		return fmt.Errorf("创建 player_state 索引失败: %w", err)
	}

	// 旧版本数据库可能残留 health/armor 列（曾在 player_activity 上采集，已停采），幂等清理
	for _, col := range []string{"health", "armor"} {
		if _, err := pool.Exec(ctx,
			fmt.Sprintf(`ALTER TABLE player_activity DROP COLUMN IF EXISTS %s`, col)); err != nil {
			return fmt.Errorf("清理 player_activity.%s 列失败: %w", col, err)
		}
	}

	// 旧版本数据库可能残留已废弃的配置键：世界名与瓦片 URL 模板已固定为系统默认值
	// （collector.Start 硬编码），不再提供配置项，幂等清理
	for _, key := range []string{"default_world", "tile_url_template"} {
		if _, err := pool.Exec(ctx, `DELETE FROM app_config WHERE key = $1`, key); err != nil {
			return fmt.Errorf("清理废弃配置键 %s 失败: %w", key, err)
		}
	}

	// hypertable 创建（仅当尚未是 hypertable 时）
	if err := ensureHypertable(ctx, pool, "player_activity", "1 day"); err != nil {
		return err
	}
	if err := ensureHypertable(ctx, pool, "player_state", "7 days"); err != nil {
		return err
	}

	// 压缩策略（幂等）
	for _, t := range []string{"player_activity", "player_state"} {
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
				return fmt.Errorf("添加压缩策略失败: %w", err)
			}
		}
	}

	// 默认配置种子。
	// 世界名与瓦片 URL 模板固定为系统默认值（collector.Start 硬编码），不提供配置项。
	// mtr_enabled 与 collect_* 为采集标志的默认值：新建会话时作为默认写入会话记录。
	defaults := [][2]string{
		{"mtr_url", "https://letsplay.minecrafttransitrailway.com/system-map/mtr/api/map/clients?dimension=0"},
		{"squaremap_url", "https://letsplay.minecrafttransitrailway.com/world-map"},
		{"mirror_url", ""},
		{"default_tile_zoom", "3"},
		{"default_poll_interval_ms", "1000"},
		{"default_max_duration_sec", ""},
		{"default_mtr_enabled", "true"},
		{"default_collect_station_id", "true"},
		{"default_collect_route_id", "true"},
		{"default_collect_route_station1", "true"},
		{"default_collect_route_station2", "true"},
		{"default_collect_health", "false"},
		{"default_collect_armor", "false"},
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
		return fmt.Errorf("查询 hypertable %s 失败: %w", table, err)
	}
	if !exists {
		if _, err := pool.Exec(ctx, fmt.Sprintf(
			`SELECT create_hypertable('%s', 'time', chunk_time_interval => INTERVAL '%s')`, table, chunkInterval)); err != nil {
			return fmt.Errorf("创建 %s hypertable 失败: %w", table, err)
		}
	}
	return nil
}

// LoadConfigMap 读取全部配置为 map
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
