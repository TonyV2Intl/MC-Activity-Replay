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

// MTRClient MTR API 返回的单个客户端（玩家）
type MTRClient struct {
	ID              string  `json:"id"` // 带连字符 UUID
	Name            string  `json:"name"`
	X               float64 `json:"x"`
	Z               float64 `json:"z"`
	StationID       string  `json:"stationId"`
	RouteID         string  `json:"routeId"`
	RouteStationID1 string  `json:"routeStationId1"`
	RouteStationID2 string  `json:"routeStationId2"`
}

// mtrResponse MTR API 响应结构
type mtrResponse struct {
	Code        int    `json:"code"`
	CurrentTime int64  `json:"currentTime"`
	Text        string `json:"text"`
	Version     int    `json:"version"`
	Data        struct {
		CachedResponseTime int64       `json:"cachedResponseTime"`
		Clients            []MTRClient `json:"clients"`
	} `json:"data"`
}

// MTRData 解析后的 MTR 数据
type MTRData struct {
	CachedResponseTime int64
	Clients            []MTRClient
}

// FetchMTR 请求 MTR API 并解析响应
func FetchMTR(ctx context.Context, url string, timeout time.Duration) (*MTRData, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("构造 MTR 请求失败: %w", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求 MTR API 失败: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20)) // 32MB 上限
	if err != nil {
		return nil, fmt.Errorf("读取 MTR 响应失败: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("MTR API 返回状态 %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	var parsed mtrResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("解析 MTR 响应失败: %w", err)
	}
	if parsed.Code != 200 && parsed.Code != 0 {
		return nil, fmt.Errorf("MTR API 返回 code=%d text=%s", parsed.Code, parsed.Text)
	}
	return &MTRData{
		CachedResponseTime: parsed.Data.CachedResponseTime,
		Clients:            parsed.Data.Clients,
	}, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// NormalizeUUID 将任意格式 UUID 统一为无连字符小写形式
func NormalizeUUID(s string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(s), "-", ""))
}
