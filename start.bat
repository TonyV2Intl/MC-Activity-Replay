@echo off
echo 正在启动 Minecraft 活动记录与回放系统...
if not exist timescaledb\data mkdir timescaledb\data
docker compose up -d --build
echo.
echo ✅ 启动完成！
echo    控制台: http://localhost:8080
echo    初始密码: admin（首次登录后请立即修改）
pause
