// Package config 负责从环境变量加载配置
package config

import (
	"net"
	"net/url"
	"os"
)

// Config 应用配置
type Config struct {
	DBHost               string
	DBPort               string
	DBName               string
	DBUser               string
	DBPassword           string
	InitialAdminPassword string
	SessionSecret        string
	ServerPort           string
}

// Load 从环境变量加载配置，带默认值
func Load() *Config {
	return &Config{
		DBHost:               getEnv("DB_HOST", "localhost"),
		DBPort:               getEnv("DB_PORT", "5432"),
		DBName:               getEnv("DB_NAME", "mc_activity"),
		DBUser:               getEnv("DB_USER", "postgres"),
		DBPassword:           getEnv("DB_PASSWORD", "mc_activity_pass"),
		InitialAdminPassword: getEnv("INITIAL_ADMIN_PASSWORD", "admin"),
		SessionSecret:        getEnv("SESSION_SECRET", "change-me-in-production"),
		ServerPort:           getEnv("SERVER_PORT", "3000"),
	}
}

// DSN 返回 pgx 连接字符串（目标库为配置库）
func (c *Config) DSN() string {
	return c.dsn(c.DBName)
}

// DSNFor 返回连接指定数据库的 DSN（维护库连接等场景使用）
func (c *Config) DSNFor(dbName string) string {
	return c.dsn(dbName)
}

// dsn 构造 URL 形式的连接串。用户信息经 net/url 百分号编码，
// 密码含 @ / : 等特殊字符时不会破坏 DSN 解析（pgx 会解码还原）。
func (c *Config) dsn(dbName string) string {
	u := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(c.DBUser, c.DBPassword),
		Host:   net.JoinHostPort(c.DBHost, c.DBPort),
		Path:   "/" + dbName,
	}
	q := u.Query()
	q.Set("sslmode", "disable")
	u.RawQuery = q.Encode()
	return u.String()
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
