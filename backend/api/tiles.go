package api

import (
	"bytes"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"mc-activity-replay/db"
)

// tilePathRe 瓦片路径格式：{world}/{zoom}/{tileX}_{tileZ}.png。
// 世界名限字母数字下划线连字符，zoom 0-99，瓦片索引限 7 位（含负号）。
// 严格白名单防止路径穿越与 SSRF（代理目标只能由服务端配置推导）。
var tilePathRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}/\d{1,2}/-?\d{1,7}_-?\d{1,7}\.png$`)

// tileCache 简单的 FIFO 瓦片缓存：回放平移/重载时减少对上游的重复请求。
// 条目数与单块大小双重受限（跳过超过 maxCachedTileBytes 的大块），
// 浏览器侧另有 Cache-Control 缓存，双端互补。
const (
	maxCachedTiles     = 1024
	maxCachedTileBytes = 1 << 20 // 1MB
)

type tileCacheEntry struct {
	body        []byte
	contentType string
}

type tileCache struct {
	mu      sync.Mutex
	entries map[string]tileCacheEntry
	order   []string // FIFO 键顺序（最旧在前）
}

func newTileCache() *tileCache {
	return &tileCache{entries: make(map[string]tileCacheEntry)}
}

func (tc *tileCache) get(key string) (tileCacheEntry, bool) {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	e, ok := tc.entries[key]
	return e, ok
}

func (tc *tileCache) put(key string, e tileCacheEntry) {
	if len(e.body) > maxCachedTileBytes {
		return
	}
	tc.mu.Lock()
	defer tc.mu.Unlock()
	if _, exists := tc.entries[key]; exists {
		return
	}
	tc.entries[key] = e
	tc.order = append(tc.order, key)
	for len(tc.order) > maxCachedTiles {
		oldest := tc.order[0]
		tc.order = tc.order[1:]
		delete(tc.entries, oldest)
	}
}

// tileProxy 瓦片代理：浏览器 → 后端 → Squaremap 服务器（或镜像地址）。
// 适用于浏览器无法直连瓦片上游的场景（跨域限制、内网部署、防火墙）。
// 上游基址取配置 mirror_url（回放镜像，优先），未设置时回退 squaremap_url；
// 采集端使用的上游地址不受影响（各会话记录时已固化）。
func tileProxy(database *db.DB) gin.HandlerFunc {
	cache := newTileCache()
	client := &http.Client{Timeout: 15 * time.Second}
	return func(c *gin.Context) {
		rest := strings.TrimPrefix(c.Param("rest"), "/")
		if rest == "" || !tilePathRe.MatchString(rest) {
			badRequest(c, "无效的瓦片路径")
			return
		}

		// 缓存键含上游基址，切换镜像/上游后不会串味
		cfg := loadConfigMap(database)
		base := strings.TrimSpace(cfg["mirror_url"])
		if base == "" {
			base = strings.TrimSpace(cfg["squaremap_url"])
		}
		base = strings.TrimRight(base, "/")
		if base == "" {
			badRequest(c, "未配置 Squaremap 地址（mirror_url / squaremap_url）")
			return
		}
		cacheKey := base + "/tiles/" + rest

		if e, ok := cache.get(cacheKey); ok {
			writeTile(c, e, "HIT")
			return
		}

		req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, cacheKey, nil)
		if err != nil {
			serverError(c, err)
			return
		}
		resp, err := client.Do(req)
		if err != nil {
			c.Status(http.StatusBadGateway) // 上游不可达：Leaflet 按缺失瓦片处理
			return
		}
		defer resp.Body.Close()
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxCachedTileBytes+1))
		if readErr != nil {
			c.Status(http.StatusBadGateway)
			return
		}
		if resp.StatusCode != http.StatusOK {
			// 透传上游状态码（404 等），不缓存错误响应
			c.Status(resp.StatusCode)
			return
		}
		ct := resp.Header.Get("Content-Type")
		if ct == "" || !strings.HasPrefix(ct, "image/") {
			ct = "image/png"
		}
		if len(body) > maxCachedTileBytes {
			// 超过单块缓存上限（如低缩放等级的大图）：直接流转发剩余部分，
			// 不缓存。不可截断——损坏的图片数据比缺失瓦片更糟
			c.Header("Content-Type", ct)
			c.Header("Cache-Control", "public, max-age=86400")
			c.Header("X-Tile-Cache", "MISS")
			c.Status(http.StatusOK)
			if _, err := io.Copy(c.Writer, io.MultiReader(bytes.NewReader(body), resp.Body)); err != nil {
				return // 客户端中途断开：无法再改写状态码，仅记录到访问日志
			}
			return
		}
		e := tileCacheEntry{body: body, contentType: ct}
		cache.put(cacheKey, e)
		writeTile(c, e, "MISS")
	}
}

// writeTile 输出瓦片内容（带浏览器缓存头）
func writeTile(c *gin.Context, e tileCacheEntry, hit string) {
	c.Header("Content-Type", e.contentType)
	c.Header("Cache-Control", "public, max-age=86400") // 瓦片内容基本不变，允许浏览器长期缓存
	c.Header("X-Tile-Cache", hit)
	c.Data(http.StatusOK, e.contentType, e.body)
}
