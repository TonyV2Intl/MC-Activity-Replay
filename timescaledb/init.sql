-- =============================================================
-- Minecraft 玩家活动记录与回放系统 — 数据库初始化脚本
-- 通过 /docker-entrypoint-initdb.d/ 在 TimescaleDB 容器
-- 首次启动时自动执行。
-- =============================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 会话表
CREATE TABLE sessions (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,                    -- 自动生成时间戳名，可手动重命名
    started_at      TIMESTAMPTZ NOT NULL,
    stopped_at      TIMESTAMPTZ,                      -- NULL 表示仍在进行中
    max_duration_sec INTEGER,                         -- NULL 表示无上限
    stopped_reason  TEXT,                             -- 'manual' | 'timeout' | 'error'
    poll_interval_ms INTEGER NOT NULL DEFAULT 1000,
    mtr_url         TEXT NOT NULL,
    squaremap_url   TEXT NOT NULL,
    world           TEXT NOT NULL DEFAULT 'minecraft_overworld',
    tile_zoom       INTEGER NOT NULL DEFAULT 3,
    tile_url_template TEXT NOT NULL,                  -- 如 /tiles/{world}/{zoom}/{x}_{z}.png
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 玩家位置主表（高频数据）
CREATE TABLE player_activity (
    time        TIMESTAMPTZ NOT NULL,
    session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    player_uuid TEXT NOT NULL,                        -- 无连字符小写 UUID
    player_name TEXT NOT NULL,
    x           DOUBLE PRECISION NOT NULL,
    z           DOUBLE PRECISION NOT NULL,
    yaw         REAL
);

SELECT create_hypertable('player_activity', 'time', chunk_time_interval => INTERVAL '1 day');

CREATE INDEX idx_activity_session_uuid_time ON player_activity (session_id, player_uuid, time);
CREATE INDEX idx_activity_session_time ON player_activity (session_id, time);

-- 玩家乘坐状态表（低频数据，仅状态变化时写入）
CREATE TABLE player_transit_state (
    time         TIMESTAMPTZ NOT NULL,
    session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    player_uuid  TEXT NOT NULL,
    station_id   TEXT,
    route_id     TEXT,
    route_station_id1 TEXT,
    route_station_id2 TEXT
);

SELECT create_hypertable('player_transit_state', 'time', chunk_time_interval => INTERVAL '7 days');

CREATE INDEX idx_transit_session_uuid_time ON player_transit_state (session_id, player_uuid, time);

-- 全局配置表（键值对）
CREATE TABLE app_config (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 管理员密码表
CREATE TABLE admin_auth (
    id              SERIAL PRIMARY KEY,
    password_hash   TEXT NOT NULL,                    -- bcrypt 哈希
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 数据压缩策略（30 天前的数据自动压缩）
ALTER TABLE player_activity SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'session_id, player_uuid',
    timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('player_activity', INTERVAL '30 days');

ALTER TABLE player_transit_state SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'session_id, player_uuid',
    timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('player_transit_state', INTERVAL '30 days');

-- 默认配置（可被控制台修改）
INSERT INTO app_config (key, value) VALUES
    ('mtr_url', 'https://letsplay.minecrafttransitrailway.com/system-map/mtr/api/map/clients?dimension=0'),
    ('squaremap_url', 'https://letsplay.minecrafttransitrailway.com/world-map'),
    ('tile_url_template', '/tiles/{world}/{zoom}/{x}_{z}.png'),
    ('default_world', 'minecraft_overworld'),
    ('default_tile_zoom', '3'),
    ('default_poll_interval_ms', '1000'),
    ('default_max_duration_sec', '')
ON CONFLICT (key) DO NOTHING;
