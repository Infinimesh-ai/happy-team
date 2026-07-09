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
TEAM_PUBLIC_SERVER_URL=http://localhost:3005
TEAM_NODE_ARTIFACT_HOST_DIR=./.team-artifacts/node
S3_PUBLIC_URL=http://localhost:9000/happy-team
TEAM_ANTHROPIC_API_KEY=sk-ant-...
TEAM_OPENAI_API_KEY=sk-proj-...
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

`HAPPY_PUBLIC_SERVER_URL` 用于 webapp 构建期 API 地址；`TEAM_PUBLIC_SERVER_URL` 用于 server 生成 enroll/manual/provisioning artifact URL。生产环境两者通常都是真实 HTTPS API 域名；Docker 内网 E2E 可把 `HAPPY_PUBLIC_SERVER_URL=http://localhost:3005`、`TEAM_PUBLIC_SERVER_URL=http://server:3005`，让宿主机浏览器和目标容器都能访问 server。修改 `HAPPY_PUBLIC_SERVER_URL` 后需重新 build `webapp`。

## 4. Team Provisioning

M2 起 server 镜像会内置 `happy-cli.tgz`，并通过以下只读接口分发给目标机器：

- `GET /v1/team/artifacts/cli.tgz`
- `GET /v1/team/artifacts/node/:platform/:arch`（支持 `linux|darwin` 与 `x64|arm64`）

Docker 部署时不需要额外构建 CLI artifact；`Dockerfile.server` 会在 build 阶段运行 CLI deploy，并把 artifact 放到 `/opt/happy-team/artifacts/happy-cli.tgz`。Linux x64 Node 默认从 server 容器自身的 `process.execPath` 分发。其他平台需要把对应 Node 20+ 单文件二进制放入 host 侧 `TEAM_NODE_ARTIFACT_HOST_DIR`（compose 会只读挂载到容器内 `/opt/happy-team/artifacts/node`），例如：

```text
.team-artifacts/node/linux-arm64/node
.team-artifacts/node/darwin-arm64/node
.team-artifacts/node/darwin-x64/node
```

也可以使用分层目录：

```text
.team-artifacts/node/linux/arm64/node
```

目标机不访问公网；这些 Node 制品由企业 server 自分发。若 artifact 缺失，对应 provisioning job 会在 `install_node` 步骤失败并提示缺少的 server-side path。

如果用源码直接跑 server，需要先生成同名 CLI artifact：

```bash
mkdir -p .team-artifacts
pnpm --filter happy build
pnpm --filter happy deploy --prod --legacy .team-artifacts/happy-cli
tar -czf .team-artifacts/happy-cli.tgz -C .team-artifacts/happy-cli .
```

管理员登录 `http://localhost:8080/team/admin/users` 后进入 Provision Machine：

1. 选择目标成员。
2. 选择该成员已保存的 SSH 凭据，或输入新的 SSH host、port、username 和密码/私钥。新的凭据可以先保存后复用，也可以直接用于本次 provisioning。
3. 选择要启用的 agent。默认 Claude Code 使用 `TEAM_ANTHROPIC_API_KEY`；Codex 使用 `TEAM_OPENAI_API_KEY`。
4. 点击 Start Provisioning。server 会用 ssh2 连接目标机，检测 `uname -s` / `uname -m` 后下载匹配 Node artifact，安装 CLI，执行 `happy enroll --server <url> --token <一次性token>`，写入 `~/.happy-team/agent.env`（权限 600），并拉起 daemon。Linux 优先写 user systemd unit；没有 user systemd 时会尝试普通 daemon + crontab fallback。macOS 写用户级 `~/Library/LaunchAgents/com.happy-team.daemon.plist`，不需要 root 权限；plist 只 source `agent.env`，不展开保存公司 API key。

Saved SSH Credentials 列表只显示 label/host/user/auth type 和 delete-after-use 标记，不显示密码、私钥或密文。Provisioning 日志会脱敏 token、SSH 凭据、公司 API key。响应里的 Manual Command 是兜底安装命令，可复制到目标机器手工执行；一次性 token 默认 15 分钟有效，只能使用一次。Manual Command 不包含公司 API key；它会导出 provisioned Node 的 `PATH`、完成 enroll 并启动 daemon，daemon 首次上线后由 server 通过加密 Machine RPC 写入当前成员的 `agent.env`。

目标机器不需要 root 权限，也不需要访问公网；它只需要能通过 SSH 被 server 访问，并能访问 `TEAM_PUBLIC_SERVER_URL` 指向的 server。

失败的 provisioning job 会在列表里显示 Retry 按钮；重试会创建新的 job 和新的 enroll token，旧 token 不会复用。若 SSH 凭据已经被删除，需重新录入凭据后再发起新的 provisioning。

## 5. Team 运维页面

管理员页面入口：

- Members: `http://localhost:8080/team/admin/users`
- Machines: `http://localhost:8080/team/admin/machines`
- Audit: `http://localhost:8080/team/admin/audit`
- Provisioning: `http://localhost:8080/team/admin/provision`

Audit 页可按 action 名称过滤，例如 `login`、`create_user`、`provision_succeeded`、`self_update_agent_auth_mode`。Machines 页展示成员归属、在线状态和最近心跳。

成员在 Settings 里打开 Team Agent Access 可切换每个 agent 的认证模式：

- Company API：daemon 的 `agent.env` 写入 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`，请求走公司 key。
- Personal OAuth：daemon RPC 会重写 `agent.env` 并清除对应公司 key；成员随后通过网页远程会话在目标机器上完成一次 `claude` 或 `codex` 登录。

机器离线时切换会进入 pending；daemon 下次上线后通过现有 Machine RPC 应用变更并自重启。切换回 Company API 要求 server 环境中仍配置对应的 `TEAM_ANTHROPIC_API_KEY` / `TEAM_OPENAI_API_KEY`。

## 6. M0 手动端到端验证

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

## 7. 备份要求

Postgres 和 MinIO 数据卷必须备份。进入 M1 之后，Postgres 会包含托管 NaCl 私钥密文和 SSH 凭据密文，因此备份必须加密，且备份密钥与 `HANDY_MASTER_SECRET` 分开管理。
