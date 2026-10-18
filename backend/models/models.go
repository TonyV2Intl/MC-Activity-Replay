// Package models 定义后端 API 与采集器使用的数据结构
package models

import "time"

// ---------- 会话 ----------

// Session 一次记录会话
type Session struct {
	ID              int64      `json:"id"`
	Name            string     `json:"name"`
	StartedAt       time.Time  `json:"started_at"`
	StoppedAt       *time.Time `json:"stopped_at"`
	MaxDurationSec  *int       `json:"max_duration_sec"`
	StoppedReason   *string    `json:"stopped_reason"`
	PollIntervalMs  int        `json:"poll_interval_ms"`
	MtrURL          string     `json:"mtr_url"`
	SquaremapURL    string     `json:"squaremap_url"`
	World           string     `json:"world"`
	TileZoom        int        `json:"tile_zoom"`
	TileURLTemplate string     `json:"tile_url_template"`
	CreatedAt       time.Time  `json:"created_at"`
}

// SessionWithStats 带统计信息的会话（列表/详情返回）
type SessionWithStats struct {
	Session
	PlayerCount int   `json:"player_count"`
	PointCount  int64 `json:"point_count"`
}

// ---------- 轨迹数据 ----------

// ActivityPoint 玩家位置点
type ActivityPoint struct {
	Time time.Time `json:"time"`
	X    float64   `json:"x"`
	Z    float64   `json:"z"`
	Yaw  *float64  `json:"yaw"`
}

// TransitRecord MTR 乘坐状态变化记录
type TransitRecord struct {
	Time            time.Time `json:"time"`
	StationID       *string   `json:"station_id"`
	RouteID         *string   `json:"route_id"`
	RouteStationID1 *string   `json:"route_station_id1"`
	RouteStationID2 *string   `json:"route_station_id2"`
}

// PlayerSummary 会话内玩家概要
type PlayerSummary struct {
	UUID       string `json:"uuid"`
	Name       string `json:"name"`
	PointCount int64  `json:"point_count"`
}

// TrajectoryChunk 分页轨迹响应
type TrajectoryChunk struct {
	UUID        string          `json:"uuid"`
	Name        string          `json:"name"`
	TotalPoints int64           `json:"totalPoints"`
	ChunkIndex  int             `json:"chunkIndex"`
	ChunkSize   int             `json:"chunkSize"`
	TotalChunks int             `json:"totalChunks"`
	Points      []ActivityPoint `json:"points"`
}

// SnapshotPlayer 某一时间点的玩家快照
type SnapshotPlayer struct {
	UUID string    `json:"uuid"`
	Name string    `json:"name"`
	X    float64   `json:"x"`
	Z    float64   `json:"z"`
	Yaw  *float64  `json:"yaw"`
	Time time.Time `json:"time"`
}

// ---------- 采集器 ----------

// CollectorStatus 采集器状态
type CollectorStatus struct {
	Status       string       `json:"status"` // idle | recording
	SessionID    *int64       `json:"sessionId"`
	StartedAt    *time.Time   `json:"startedAt"`
	PollInterval *int         `json:"pollInterval"` // ms
	PlayerCount  int          `json:"playerCount"`
	LastError    *string      `json:"lastError"`
	Errors       []ErrorEntry `json:"errors"`
}

// ErrorEntry 环形缓冲区中的一条错误
type ErrorEntry struct {
	Time    time.Time `json:"time"`
	Message string    `json:"message"`
}

// LivePlayer 实时监控中的玩家
type LivePlayer struct {
	UUID  string   `json:"uuid"`
	Name  string   `json:"name"`
	World string   `json:"world"`
	X     float64  `json:"x"`
	Z     float64  `json:"z"`
	Yaw   *float64 `json:"yaw"`
}

// CollectorLive 实时监控响应
type CollectorLive struct {
	SessionID *int64       `json:"sessionId"`
	PolledAt  *time.Time   `json:"polledAt"`
	Players   []LivePlayer `json:"players"`
}

// PlayerFilter 玩家筛选
type PlayerFilter struct {
	Mode  string   `json:"mode"` // all | include | exclude
	UUIDs []string `json:"uuids"`
	Names []string `json:"names"`
}

// StartCollectorRequest 开始记录请求
type StartCollectorRequest struct {
	Name            *string       `json:"name"`
	MaxDurationSec  *int          `json:"maxDurationSec"`
	PollIntervalMs  *int          `json:"pollIntervalMs"`
	MtrURL          *string       `json:"mtrUrl"`
	SquaremapURL    *string       `json:"squaremapUrl"`
	World           *string       `json:"world"`
	TileZoom        *int          `json:"tileZoom"`
	TileURLTemplate *string       `json:"tileUrlTemplate"`
	PlayerFilter    *PlayerFilter `json:"playerFilter"`
}

// ---------- 请求体 ----------

// LoginRequest 登录请求
type LoginRequest struct {
	Password string `json:"password" binding:"required"`
}

// PasswordChangeRequest 修改密码请求
type PasswordChangeRequest struct {
	Old string `json:"old" binding:"required"`
	New string `json:"new" binding:"required"`
}

// RenameSessionRequest 重命名请求
type RenameSessionRequest struct {
	Name string `json:"name" binding:"required"`
}

// MergeSessionsRequest 合并会话请求
type MergeSessionsRequest struct {
	SessionIDs []int64 `json:"sessionIds" binding:"required"`
	NewName    *string `json:"newName"`
}

// ---------- 导出/导入 ----------

// ExportJSON 会话导出的 JSON 结构
type ExportJSON struct {
	Version int            `json:"version"`
	Session Session        `json:"session"`
	Players []ExportPlayer `json:"players"`
}

// ExportPlayer 导出 JSON 中的玩家
type ExportPlayer struct {
	UUID     string          `json:"uuid"`
	Name     string          `json:"name"`
	Activity []ActivityPoint `json:"activity"`
	Transit  []TransitRecord `json:"transit"`
}
