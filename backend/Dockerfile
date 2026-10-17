# 构建阶段
FROM golang:1.22-alpine AS builder
# GOPROXY 构建参数：默认依次尝试国内镜像与官方代理，境外/内网环境可用
#   docker compose build --build-arg GOPROXY=https://proxy.golang.org,direct
# 覆盖。仓库内已提供 go.sum，镜像不可达时也可在宿主机 go mod download 后
# 使用 -mod=mod 缓存（DOCKER_BUILDKIT=0 时自动继承 /go/pkg/mod 需挂载）。
ARG GOPROXY=https://goproxy.cn,https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o backend .

# 运行阶段
FROM alpine:latest
# 固定 postgresql16-client：客户端主版本需与 timescaledb（PostgreSQL 16）一致。
# 若使用最新的 postgresql-client（如 18.x），pg_dump 会发出旧服务器不认识的
# GUC（如 transaction_timeout），导致导出的 SQL 无法通过 psql 导入。
RUN apk --no-cache add ca-certificates tzdata postgresql16-client
WORKDIR /app
COPY --from=builder /app/backend .
EXPOSE 3000
CMD ["./backend"]
