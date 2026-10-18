package api

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"mc-activity-replay/db"
	"mc-activity-replay/models"
)

// sessionPlayers 返回会话中所有玩家
func sessionPlayers(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := parseID(c, "id")
		if !ok {
			return
		}
		rows, err := database.Pool.Query(c.Request.Context(),
			`SELECT player_uuid, (array_agg(player_name ORDER BY time))[1] AS name, COUNT(*) AS point_count
			 FROM player_activity WHERE session_id = $1
			 GROUP BY player_uuid ORDER BY name`, id)
		if err != nil {
			serverError(c, err)
			return
		}
		defer rows.Close()

		players := make([]models.PlayerSummary, 0)
		for rows.Next() {
			var p models.PlayerSummary
			if err := rows.Scan(&p.UUID, &p.Name, &p.PointCount); err != nil {
				serverError(c, err)
				return
			}
			players = append(players, p)
		}
		c.JSON(http.StatusOK, gin.H{"players": players})
	}
}

// trajectory 返回单个玩家的轨迹点（分页）
func trajectory(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := parseID(c, "id")
		if !ok {
			return
		}
		uuid := c.Param("uuid")

		chunkIndex := 0
		chunkSize := 2000
		if v := c.Query("chunk"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n >= 0 {
				chunkIndex = n
			}
		}
		if v := c.Query("chunkSize"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 20000 {
				chunkSize = n
			}
		}

		ctx := c.Request.Context()

		// 玩家名称与总点数
		var name string
		var total int64
		err := database.Pool.QueryRow(ctx,
			`SELECT (array_agg(player_name ORDER BY time))[1], COUNT(*)
			 FROM player_activity WHERE session_id = $1 AND player_uuid = $2`, id, uuid).Scan(&name, &total)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "未找到该玩家的轨迹数据"})
			return
		}

		rows, err := database.Pool.Query(ctx,
			`SELECT time, x, z, yaw FROM player_activity
			 WHERE session_id = $1 AND player_uuid = $2
			 ORDER BY time ASC OFFSET $3 LIMIT $4`,
			id, uuid, chunkIndex*chunkSize, chunkSize)
		if err != nil {
			serverError(c, err)
			return
		}
		defer rows.Close()

		points := make([]models.ActivityPoint, 0, chunkSize)
		for rows.Next() {
			var p models.ActivityPoint
			if err := rows.Scan(&p.Time, &p.X, &p.Z, &p.Yaw); err != nil {
				serverError(c, err)
				return
			}
			points = append(points, p)
		}

		totalChunks := int((total + int64(chunkSize) - 1) / int64(chunkSize))
		c.JSON(http.StatusOK, models.TrajectoryChunk{
			UUID:        uuid,
			Name:        name,
			TotalPoints: total,
			ChunkIndex:  chunkIndex,
			ChunkSize:   chunkSize,
			TotalChunks: totalChunks,
			Points:      points,
		})
	}
}

// playerTransit 返回玩家的 MTR 状态变化记录
func playerTransit(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := parseID(c, "id")
		if !ok {
			return
		}
		uuid := c.Param("uuid")

		rows, err := database.Pool.Query(c.Request.Context(),
			`SELECT time, station_id, route_id, route_station_id1, route_station_id2
			 FROM player_transit_state WHERE session_id = $1 AND player_uuid = $2
			 ORDER BY time ASC`, id, uuid)
		if err != nil {
			serverError(c, err)
			return
		}
		defer rows.Close()

		records := make([]models.TransitRecord, 0)
		for rows.Next() {
			var r models.TransitRecord
			if err := rows.Scan(&r.Time, &r.StationID, &r.RouteID, &r.RouteStationID1, &r.RouteStationID2); err != nil {
				serverError(c, err)
				return
			}
			records = append(records, r)
		}
		c.JSON(http.StatusOK, gin.H{"records": records})
	}
}

// snapshot 返回某个时间点所有在线玩家
func snapshot(database *db.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := parseID(c, "id")
		if !ok {
			return
		}
		at := time.Now().UTC()
		if v := c.Query("at"); v != "" {
			if t, err := time.Parse(time.RFC3339, v); err == nil {
				at = t.UTC()
			}
		}

		rows, err := database.Pool.Query(c.Request.Context(),
			`SELECT DISTINCT ON (player_uuid) player_uuid, player_name, x, z, yaw, time
			 FROM player_activity
			 WHERE session_id = $1 AND time <= $2
			 ORDER BY player_uuid, time DESC`, id, at)
		if err != nil {
			serverError(c, err)
			return
		}
		defer rows.Close()

		players := make([]models.SnapshotPlayer, 0)
		for rows.Next() {
			var p models.SnapshotPlayer
			if err := rows.Scan(&p.UUID, &p.Name, &p.X, &p.Z, &p.Yaw, &p.Time); err != nil {
				serverError(c, err)
				return
			}
			players = append(players, p)
		}
		c.JSON(http.StatusOK, gin.H{"at": at, "players": players})
	}
}

// loadConfigMap 读取全部配置为 map（供内部使用）
func loadConfigMap(database *db.DB) map[string]string {
	return db.LoadConfigMap(context.Background(), database.Pool)
}
