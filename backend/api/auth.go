package api

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"mc-activity-replay/config"
	"mc-activity-replay/db"
)

const (
	sessionCookieName = "mc_session"
	sessionMaxAge     = 7 * 24 * 3600 // 7 天
)

// ---------- 签名 Token（无状态，HMAC-SHA256） ----------

type tokenPayload struct {
	Exp   int64  `json:"exp"`
	Nonce string `json:"nonce"`
}

func signToken(cfg *config.Config, p tokenPayload) (string, error) {
	raw := fmt.Sprintf(`{"exp":%d,"nonce":"%s"}`, p.Exp, p.Nonce)
	payload := base64.RawURLEncoding.EncodeToString([]byte(raw))
	mac := hmac.New(sha256.New, []byte(cfg.SessionSecret))
	mac.Write([]byte(payload))
	sig := hex.EncodeToString(mac.Sum(nil))
	return payload + "." + sig, nil
}

func verifyToken(cfg *config.Config, token string) bool {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return false
	}
	payload, sig := parts[0], parts[1]
	mac := hmac.New(sha256.New, []byte(cfg.SessionSecret))
	mac.Write([]byte(payload))
	expected := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(sig), []byte(expected)) != 1 {
		return false
	}
	// 解析过期时间
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return false
	}
	// 简单提取 exp 字段（避免引入完整 JSON 解析的循环依赖问题）
	idx := strings.Index(string(raw), `"exp":`)
	if idx < 0 {
		return false
	}
	rest := string(raw)[idx+6:]
	end := strings.IndexAny(rest, ",}")
	if end < 0 {
		return false
	}
	exp, err := strconv.ParseInt(strings.TrimSpace(rest[:end]), 10, 64)
	if err != nil {
		return false
	}
	return time.Now().Unix() < exp
}

// ---------- 中间件 ----------

// AuthRequired Cookie 认证中间件
func AuthRequired(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		token, err := c.Cookie(sessionCookieName)
		if err != nil || token == "" || !verifyToken(cfg, token) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录或会话已过期"})
			c.Abort()
			return
		}
		c.Next()
	}
}

// ---------- 处理器 ----------

// login 登录：校验密码并设置 Cookie
func login(database *db.DB, cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Password string `json:"password" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			badRequest(c, "请提供密码")
			return
		}

		var hash string
		err := database.Pool.QueryRow(c.Request.Context(),
			`SELECT password_hash FROM admin_auth ORDER BY id LIMIT 1`).Scan(&hash)
		if err != nil {
			serverError(c, err)
			return
		}
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "密码错误"})
			return
		}

		nonce := make([]byte, 16)
		if _, err := rand.Read(nonce); err != nil {
			serverError(c, err)
			return
		}
		token, err := signToken(cfg, tokenPayload{
			Exp:   time.Now().Add(sessionMaxAge * time.Second).Unix(),
			Nonce: hex.EncodeToString(nonce),
		})
		if err != nil {
			serverError(c, err)
			return
		}
		c.SetCookie(sessionCookieName, token, sessionMaxAge, "/", "", false, true)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// logout 退出登录：清除 Cookie
func logout(c *gin.Context) {
	c.SetCookie(sessionCookieName, "", -1, "/", "", false, true)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// authCheck 检查登录状态
func authCheck(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"authenticated": true})
}

// changePassword 修改密码
func changePassword(database *db.DB, cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Old string `json:"old" binding:"required"`
			New string `json:"new" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			badRequest(c, "请提供旧密码和新密码")
			return
		}
		if len(req.New) < 4 {
			badRequest(c, "新密码长度至少为 4 位")
			return
		}

		var id int
		var hash string
		err := database.Pool.QueryRow(c.Request.Context(),
			`SELECT id, password_hash FROM admin_auth ORDER BY id LIMIT 1`).Scan(&id, &hash)
		if err != nil {
			serverError(c, err)
			return
		}
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Old)) != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "旧密码错误"})
			return
		}
		newHash, err := bcrypt.GenerateFromPassword([]byte(req.New), bcrypt.DefaultCost)
		if err != nil {
			serverError(c, err)
			return
		}
		if _, err := database.Pool.Exec(c.Request.Context(),
			`UPDATE admin_auth SET password_hash = $1, updated_at = NOW() WHERE id = $2`, string(newHash), id); err != nil {
			serverError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}
