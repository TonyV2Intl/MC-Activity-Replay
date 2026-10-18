package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"mc-activity-replay/db"
)

// networkCacheTTL 站线名称表的内存缓存时长。
// 上游 stations-and-routes 数据（约 2MB）变化频率低，回放页按需拉取，
// 缓存避免每次进入回放页都请求上游。
const (
	networkCacheTTL     = 10 * time.Minute  // 缓存有效期
	networkFetchTimeout = 150 * time.Second // 上游拉取超时（2MB 响应慢速链路）
)

// networkNamesCache MTR 站点/线路 ID → 名称映射的内存缓存
type networkNamesCache struct {
	mu        sync.Mutex
	url       string // 缓存对应的上游 URL（配置变更后自动失效）
	fetchedAt time.Time
	stations  map[string]string
	routes    map[string]string
}

var networkCache = &networkNamesCache{}

// networkNames 返回 MTR 站点/线路 ID → 名称映射（供回放 tooltip 显示站名/线名）。
// 上游地址由配置的 mtr_url 推导（路径中的 clients 段替换为 stations-and-routes）。
// 上游不可用且无缓存时返回空表，前端回退为显示原始 ID。
func networkNames(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		mtrURL := strings.TrimSpace(loadConfigMap(database)["mtr_url"])
		stations, routes := networkCache.get(mtrURL)
		c.JSON(http.StatusOK, gin.H{"stations": stations, "routes": routes})
	}
}

// get 返回缓存数据，过期或未配置时向上游拉取（持锁执行，避免并发重复请求）
func (nc *networkNamesCache) get(mtrURL string) (map[string]string, map[string]string) {
	nc.mu.Lock()
	defer nc.mu.Unlock()

	if mtrURL == "" {
		return map[string]string{}, map[string]string{}
	}
	if nc.stations != nil && nc.url == mtrURL && time.Since(nc.fetchedAt) < networkCacheTTL {
		return nc.stations, nc.routes
	}

	stations, routes, err := fetchNetworkNames(mtrURL)
	if err != nil {
		// 上游失败：有同 URL 旧缓存则返回旧数据，否则空表
		if nc.stations != nil && nc.url == mtrURL {
			return nc.stations, nc.routes
		}
		return map[string]string{}, map[string]string{}
	}
	nc.url = mtrURL
	nc.fetchedAt = time.Now()
	nc.stations = stations
	nc.routes = routes
	return stations, routes
}

// stationsRoutesURL 由 MTR clients URL 推导 stations-and-routes URL：
// 路径末段 clients → stations-and-routes，查询参数（如 dimension）保持不变。
func stationsRoutesURL(mtrURL string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(mtrURL))
	if err != nil {
		return "", fmt.Errorf("解析 MTR URL 失败: %w", err)
	}
	if !strings.Contains(u.Path, "clients") {
		return "", fmt.Errorf("MTR URL 路径中未找到 clients 段: %s", mtrURL)
	}
	u.Path = strings.Replace(u.Path, "clients", "stations-and-routes", 1)
	return u.String(), nil
}

// mtrNetworkResponse stations-and-routes 响应中仅需的字段
type mtrNetworkResponse struct {
	Code int    `json:"code"`
	Text string `json:"text"`
	Data struct {
		Stations []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"stations"`
		Routes []struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Number string `json:"number"`
		} `json:"routes"`
	} `json:"data"`
}

// fetchNetworkNames 请求上游 stations-and-routes，提取 ID → 名称映射
func fetchNetworkNames(mtrURL string) (map[string]string, map[string]string, error) {
	target, err := stationsRoutesURL(mtrURL)
	if err != nil {
		return nil, nil, err
	}

	// 上游 stations-and-routes 响应约 2MB，慢速链路下传输可达数分钟，超时限制放宽
	ctx, cancel := context.WithTimeout(context.Background(), networkFetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("构造请求失败: %w", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("请求 stations-and-routes 失败: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20)) // 64MB 上限
	if err != nil {
		return nil, nil, fmt.Errorf("读取响应失败: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("上游返回状态 %d", resp.StatusCode)
	}

	var parsed mtrNetworkResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, nil, fmt.Errorf("解析响应失败: %w", err)
	}
	if parsed.Code != 200 && parsed.Code != 0 {
		return nil, nil, fmt.Errorf("上游返回 code=%d text=%s", parsed.Code, parsed.Text)
	}

	stations := make(map[string]string, len(parsed.Data.Stations))
	for _, s := range parsed.Data.Stations {
		if s.ID == "" {
			continue
		}
		stations[s.ID] = primaryName(s.Name, "")
	}
	routes := make(map[string]string, len(parsed.Data.Routes))
	for _, r := range parsed.Data.Routes {
		if r.ID == "" {
			continue
		}
		routes[r.ID] = primaryName(r.Name, r.Number)
	}
	return stations, routes, nil
}

// primaryName 取多语言名称的第一个非空段（如 "中文|English" → "中文"），
// 全部为空时回退到 fallback（线路号），再为空则返回空串（前端回退原始 ID）。
func primaryName(name, fallback string) string {
	for _, seg := range strings.Split(name, "|") {
		if s := strings.TrimSpace(seg); s != "" {
			return s
		}
	}
	return strings.TrimSpace(fallback)
}

// StartNetworkCacheRefresher 后台维护站线名称缓存：
// 启动即预热（首次拉取需数分钟），之后每个 TTL 刷新一次，
// 使回放页打开时缓存埋热。getMTRURL 用于读取当前配置（可能在运行中被修改）。
func StartNetworkCacheRefresher(ctx context.Context, getMTRURL func() string) {
	go func() {
		for {
			url := ""
			if getMTRURL != nil {
				url = strings.TrimSpace(getMTRURL())
			}
			networkCache.get(url) // 超时/失败时自动保留旧缓存，下个周期重试
			select {
			case <-ctx.Done():
				return
			case <-time.After(networkCacheTTL):
			}
		}
	}()
}
