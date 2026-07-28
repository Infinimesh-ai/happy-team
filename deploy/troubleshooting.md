# Happy Team Edition 故障排查

按症状查。每条给出**代码里真实的报错字符串**，可以直接拿去 grep 日志或搜 `ProvisionJob.log`。

部署与运维步骤见 [README.md](README.md)，机制原理见 [../docs/team-edition.md](../docs/team-edition.md)。

## 先做这三件事

排查 provisioning 问题之前，先跑这三步，能挡掉大部分问题：

**1. 跑一次部署预检。** `/team/admin/preflight`，或者：

```bash
curl -sS -H "Authorization: Bearer <admin happyToken>" "$TEAM_PUBLIC_SERVER_URL/v1/team/admin/preflight"
```

`action_required` 表示零配置 provisioning 已经被挡住了，先修这个再说。

**2. 确认目标机器能访问 `TEAM_PUBLIC_SERVER_URL`。** 这是最常见的单点故障。注意它和 `HAPPY_PUBLIC_SERVER_URL` 是两个不同的变量，解析自不同的网络——前者要**目标机器**能通，后者要**浏览器**能通。在目标机器上直接验证：

```bash
curl -fsSL "$TEAM_PUBLIC_SERVER_URL/v1/team/artifacts/cli.tgz" -o /dev/null && echo reachable
```

**3. 看 job 日志的最后一步。** `ProvisionJob.step` 记录了失败位置，`log` 是脱敏后的完整输出。日志里不会有密码、私钥、token 或 API key——如果你在里面看到了任何一个，那是 bug，请上报。

## Provisioning 按步骤排查

状态机：`connect → detect → install_node → install_cli → enroll → setup_agents → start_daemon → verify`

失败时的通用报错格式：

```
Remote command failed at <step> with code <N>: <输出>
```

### connect

| 症状 | 原因 | 处理 |
|---|---|---|
| 认证失败 | 密码/私钥错误，或该用户不允许密码登录 | 手工验证：`ssh -p <port> <user>@<host>`。私钥要带完整 PEM 头尾，注意粘贴时是否丢了换行 |
| 连接被拒 / 不可达 | 端口错、防火墙、sshd 未运行 | 确认是 **server 容器**能连到目标机，不是你的笔记本能连 |
| `SSH command timed out after <N>ms` | 网络慢或中间有跳板 | 走 Manual Command 路线 |

server 是主动连出去的，所以目标机需要**入站** SSH 可达。这是唯一需要入站的时刻，之后 daemon 全是主动出网。

### detect

很少单独失败。它探测 `uname -s` / `uname -m`、已有 Node、已有 `happy`、systemd 可用性，以及用 `ldd` 判断 glibc/musl。

如果它把平台识别错了，后续 `install_node` 会去取错误的 artifact。日志里能看到实际探测结果，先核对再往下查。

### install_node

超时 120 秒。

| 症状 | 原因 | 处理 |
|---|---|---|
| 下载失败 | 目标机**既没有 `curl` 也没有 `wget`** | 下载命令是 `curl -fsSL ... \|\| wget -q ...`，两个都没有就无解，装一个 |
| HTTP 503 | server 侧没有对应平台的 Node artifact | 见下面「制品 503」 |
| `Could not determine Node path` | 下载成功但脚本没能输出路径，通常是磁盘满或 `$HOME` 不可写 | 检查目标机 `df -h` 和 `$HOME` 权限 |
| 卡住超时 | 跨地域拉取，或走了代理 | 提高带宽，或预先在目标机放好 Node 后重试（脚本会复用已有的 Node ≥ 20） |

目标机已经有 Node ≥ 20 时会直接复用，不会下载。所以这一步失败往往只发生在干净机器上。

### install_cli

超时 180 秒。需要目标机有 `tar`。

结尾会自检 `test -s "$HOME/.happy-team/cli/dist/index.mjs"` 并执行一次 Node，失败说明 tarball 损坏或不完整。

最隐蔽的一种失败**不在这一步报错**：tarball 解开了、CLI 能跑，但里面缺少目标平台的 Claude/Codex native binary，要等到成员真正发起会话时才暴露。这是因为构建 artifact 前忘了跑 `pnpm install --force`。用预检的 per-platform binary 检查项确认，详见 [README.md §4](README.md)。

### enroll

| 症状 | 原因 | 处理 |
|---|---|---|
| token 过期 | 一次性 token 只有 15 分钟 | 用 Retry，会签发新 token（旧的绝不复用） |
| token 已使用 | 同一个 token 被用了两次 | 同上，重新发起 |
| `This machine is already enrolled` | 目标机之前装过 | 重装场景要么先清 `~/.happy/` 和 `~/.happy-team/`，要么手工带 `--force` 跑 |

### setup_agents

超时 30 秒。

```
TEAM_ANTHROPIC_API_KEY is not configured
TEAM_OPENAI_API_KEY is not configured
```

字面意思：勾选了某个 agent 走 COMPANY_API，但 server 环境里没配对应的 key。补上 `.env` 里的值，重启 server 容器，再 Retry。

只有 `COMPANY_API` 模式才需要 key。成员已经切到 `PERSONAL_OAUTH` 的 agent 不会读这个变量。

### start_daemon

超时 60 秒。这一步**很少硬失败**，但会静默降级，需要留意日志里的 warning：

- Linux：优先 `systemctl --user enable --now happy-team.service`。检测方式是 `systemctl --user status` 是否可用——SSH 会话里常常不可用（没有 user session bus），此时回退到普通 daemon + `crontab @reboot`。
- 如果连 `crontab` 都没有，日志会打印 `crontab unavailable; daemon started without reboot fallback`。**此时机器重启后 daemon 不会自动回来。**
- macOS：写用户级 LaunchAgent。如果 `launchctl bootstrap gui/$uid` 在 SSH 会话中不可用，日志会打印 `launchctl could not load user agent; daemon started without launchd fallback`，同样失去重启持久化。

看到这两条 warning 之一，就意味着这台机器**当下在线、但重启后不会自愈**。要么让成员本地登录一次让 user systemd 生效，要么接受手工拉起。

### verify

```
Timed out waiting for the enrolled daemon to come online
```

轮询 60 秒（每 2 秒查一次），找归属该成员、`lastActiveAt` 晚于任务开始时间的活跃机器。

前面七步都过了却卡在这里，几乎总是同一个原因：**daemon 起来了，但连不回 server**。逐项确认：

1. 目标机能否访问 `TEAM_PUBLIC_SERVER_URL`（不是 `HAPPY_PUBLIC_SERVER_URL`）
2. 出站 WebSocket 是否被防火墙拦截
3. 目标机上看 daemon 日志：`~/.happy/logs/` 下最新的 `*-daemon.log`

也有可能是 daemon 起得比 60 秒慢（qemu 模拟、冷启动自包含 Node）。这种情况下机器往往会在任务标红之后自己上线——先去 Machines 页面确认，别急着重跑。

## 制品接口 503

```
Team CLI artifact is not configured
Team Node artifact is not configured
```

三种可能：

1. **文件确实不存在。** 非 Linux-x64 目标需要你自己放 Node 二进制。跑 `pnpm team:node-artifacts`，然后确认 `TEAM_NODE_ARTIFACT_HOST_DIR` 挂进了容器。放完文件要重启 server 容器或确认挂载目录已生效。
2. **路径和二进制不匹配。** server 会读 ELF/Mach-O 头校验平台架构，把 Linux 二进制放进 `darwin-arm64/` 会被拒绝分发，而不是发出去让目标机崩。
3. **musl artifact 不自包含。** Linux musl 还会检查 ELF `DT_NEEDED`，依赖 `libstdc++` / `libgcc_s` 的会被判定为不合格。musl **不会**回退到 server runtime——这是故意的，避免给 Alpine 目标装上 glibc Node。

Linux x64 glibc 默认由 server 自身的 `process.execPath` 分发，正常情况下不需要放文件。

## Agent 认证模式切换不生效

切换后停留在 `PENDING`，`error` 为 `RPC method not available`：机器当时离线。这是**预期行为**，不是故障——变更会记在 `TeamAgentAuthUpdate` 里，等 daemon 下次 `machine-alive` 时自动应用。

在 Team Agent Access 页面可以看到每台机器的 APPLIED / PENDING / FAILED 状态。

排查要点：

- 机器明明在线却 PENDING：确认 daemon 版本包含 `team-apply-agent-env` handler。老版本 CLI 装出来的机器需要重新 provisioning。
- 切回 `COMPANY_API` 失败：server 上对应的 `TEAM_*_API_KEY` 必须仍然配着，否则无从注入。
- 切到 `PERSONAL_OAUTH` 后 Claude 仍在用公司账号计费：确认目标机 `agent.env` 里 `ANTHROPIC_API_KEY` 真的被清掉了。环境变量里的 key 优先级高于订阅登录，残留就会继续走公司账号。

## 登录与账号

| 症状 | 原因 |
|---|---|
| `429 Too many login attempts` | 15 分钟窗口内同一 `(ip, email)` 超过 10 次。响应带 `Retry-After`，等窗口过期即可 |
| `403 User is disabled` | 该成员被禁用。禁用会同时吊销已签发的 JWT，HTTP 和 WebSocket 都会拒 |
| 管理员密码忘了 | `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` 只在**库里没有任何 ADMIN 时**播种，改环境变量不会重置已有管理员。只能由另一个管理员重置，或直接改库 |
| 被禁用的成员仍能用公司 API key | 这是已知边界，不是 bug。禁用切断的是账号，不是机器——见 [team-edition.md 离职说明](../docs/team-edition.md#disabling-a-member) |

## 部署起不来

compose 对必填变量用了 `:?` 守卫，缺失会直接报错退出，照提示补 `.env` 即可（模板见仓库根目录 `.env.example`）：

```
Set POSTGRES_PASSWORD in .env before starting
Set HANDY_MASTER_SECRET to a strong random value before starting
Set ADMIN_EMAIL for the initial Team admin before starting
Set ADMIN_INITIAL_PASSWORD for the initial Team admin before starting
Set MINIO_ROOT_PASSWORD in .env before starting
```

其他常见情况：

- **webapp 连的 API 地址不对。** `HAPPY_PUBLIC_SERVER_URL` 是**构建期**烧进 webapp 的，改完必须重新 `docker compose build webapp`，只重启没用。
- **server 起不来。** 先看是不是迁移失败：`docker compose logs server`。容器启动时会先跑 `prisma migrate deploy` 再拉 Fastify。
- **`/team/login` 404。** webapp 镜像太旧，重新 build。
