// Package config 负责从环境变量加载配置
package config

import (
	"os"
	"strconv"
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

// DSN 返回 pgx 连接字符串
func (c *Config) DSN() string {
	return "postgres://" + c.DBUser + ":" + c.DBPassword + "@" + c.DBHost + ":" + c.DBPort + "/" + c.DBName + "?sslmode=disable"
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getEnvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
