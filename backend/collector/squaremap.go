package collector

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// SquaremapPlayer Squaremap players.json 中的单个玩家
type SquaremapPlayer struct {
	World  string   `json:"world"`
	Armor  *int     `json:"armor"` // 护甲 0-20（部分服务器/插件不提供时为 NULL）
	Name   string   `json:"name"`
	X      float64  `json:"x"`
	Health *float64 `json:"health"` // 生命值 0-20（部分服务器/插件不提供时为 NULL）
	Z      float64  `json:"z"`
	UUID   string   `json:"uuid"` // 无连字符 UUID
	Yaw    *float64 `json:"yaw"`
}

// squaremapResponse players.json 响应结构
type squaremapResponse struct {
	Max     int               `json:"max"`
	Players []SquaremapPlayer `json:"players"`
}

// FetchSquaremapPlayers 请求 Squaremap players.json。
// squaremapURL 为地图根地址（如 https://host/world-map），
// players.json 固定位于 {squaremapURL}/tiles/players.json。
func FetchSquaremapPlayers(ctx context.Context, squaremapURL string, timeout time.Duration) ([]SquaremapPlayer, error) {
	url := strings.TrimSuffix(squaremapURL, "/") + "/tiles/players.json"

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("构造 Squaremap 请求失败: %w", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求 Squaremap API 失败: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, fmt.Errorf("读取 Squaremap 响应失败: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Squaremap API 返回状态 %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	var parsed squaremapResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("解析 Squaremap 响应失败: %w", err)
	}
	return parsed.Players, nil
}
