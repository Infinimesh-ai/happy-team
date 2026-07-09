# Happy Team Edition 部署说明

根目录 `docker-compose.yml` 会启动 Postgres、Redis、MinIO、server、webapp；Caddy 作为生产反代 profile 可选启用。M1 起服务端会在首次启动时用环境变量播种一个 Team ADMIN。

## 1. 准备环境

安装 Docker 和 Docker Compose v2，然后在仓库根目录创建本机 `.env`。不要提交这个文件。

```bash
HANDY_MASTER_SECRET="$(openssl rand -base64 48)"
cat > .env <<EOF
HANDY_MASTER_SECRET=${HANDY_MASTER_SECRET}
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
MINIO_ROOT_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
ADMIN_EMAIL=admin@example.com
ADMIN_INITIAL_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 18)
HAPPY_PUBLIC_SERVER_URL=http://localhost:3005
S3_PUBLIC_URL=http://localhost:9000/happy-team
EOF
```

`ADMIN_INITIAL_PASSWORD` 只用于无 ADMIN 时的首次播种，管理员首登会被要求修改密码。生产环境必须把 `HANDY_MASTER_SECRET` 放在密管里保存。这个值用于服务端 token/密文派生，也用于加密托管私钥和 SSH 凭据；丢失后密文不可恢复，泄漏后需要轮换并重置相关秘密。

## 2. 启动

```bash
docker compose build
docker compose up -d
docker compose ps
```

本机默认入口：

- Webapp: `http://localhost:8080`
- Server API: `http://localhost:3005`
- MinIO Console: `http://localhost:9001`

服务端容器启动时会先执行 Prisma migrations，再启动 Fastify。查看日志：

```bash
docker compose logs -f server
```

Team Edition 登录入口是 `http://localhost:8080/team/login`。用 `.env` 里的 `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` 登录，按提示完成首次改密后即可进入成员管理页。

## 3. 生产域名与 TLS

本机验证可直接使用暴露端口。生产环境建议设置域名后启用 Caddy profile：

```bash
cat >> .env <<EOF
HAPPY_WEB_HOST=happy.yourco.com
HAPPY_API_HOST=api.happy.yourco.com
HAPPY_PUBLIC_SERVER_URL=https://api.happy.yourco.com
S3_PUBLIC_URL=https://minio-or-cdn.yourco.com/happy-team
EOF

docker compose --profile proxy up -d --build
```

`HAPPY_PUBLIC_SERVER_URL` 是 webapp 构建期变量；修改它后必须重新 build `webapp`。

## 4. M0 手动端到端验证

在一台 Linux 机器上安装 CLI，并让它指向自托管 server：

```bash
cd /path/to/happy-team
pnpm install
pnpm --filter happy build
HAPPY_SERVER_URL=http://localhost:3005 \
HAPPY_WEBAPP_URL=http://localhost:8080 \
pnpm --filter happy exec happy auth login --force

HAPPY_SERVER_URL=http://localhost:3005 \
HAPPY_WEBAPP_URL=http://localhost:8080 \
pnpm --filter happy exec happy daemon start
```

然后打开 `http://localhost:8080`，完成现有 Happy 登录流程，确认能看到该机器并发起一次 Claude Code 会话：发送一条消息、看到输出、完成一次权限审批。

## 5. 备份要求

Postgres 和 MinIO 数据卷必须备份。进入 M1 之后，Postgres 会包含托管 NaCl 私钥密文和 SSH 凭据密文，因此备份必须加密，且备份密钥与 `HANDY_MASTER_SECRET` 分开管理。
