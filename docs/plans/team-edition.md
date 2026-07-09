# Happy Team Edition — 完整实现计划

> 本文档是独立项目「Happy Team Edition」的实施蓝图。项目基于 slopus/happy monorepo fork，
> 为企业团队提供：网页访问各成员自己电脑/服务器上的 Claude Code 与 Codex；
> 管理员集中录入 SSH 凭据、远程一键初始化成员机器；独立的邮箱+密码鉴权；自托管部署。
> 所有时间维度已省略，按里程碑顺序执行即可。

---

## 1. 目标与范围

### 1.1 必须实现
1. **自托管**：server + webapp + Postgres/Redis/MinIO 全套跑在企业自己的服务器上，一条 `docker compose up -d` 启动。
2. **独立鉴权**：邮箱 + 密码登录（argon2id），角色分 ADMIN / MEMBER，管理员通过环境变量播种。不接 SSO。
3. **托管密钥**：每个团队用户对应一个 Happy Account（NaCl 密钥对），私钥由服务端生成并加密托管。成员登录后无感使用，原有加密/同步协议零改动。
4. **SSH Provisioning**：管理员在后台录入目标机器 SSH 凭据，系统自动 SSH 上去安装 CLI、注册凭据、拉起 daemon，机器上线后归属指定成员。
5. **管理后台**：成员管理、机器初始化向导（实时进度日志）、全团队机器在线总览、审计日志。
6. **成员体验**：登录网页 → 看到自己的机器 → 开 Claude Code / Codex 会话，与原版 Happy 一致。

### 1.2 明确不做
- SSO / LDAP / OAuth 登录（架构上留缝，不实现）。
- 移动端原生 App 改造（只做 Web 目标；Expo 同源，以后要做成本低）。
- 严格端到端加密（企业可信环境，接受服务端托管私钥；客户端间加密机制原样保留）。
- Claude / Codex 账号 OAuth 登录的全自动化（客观不可行，见 §9.5）。

### 1.3 既定决策（不要重新讨论）
- fork 本 monorepo 作为项目基础，新代码尽量收敛在**新增目录/新增包**中，便于定期同步 upstream。
- 鉴权桥接采用托管密钥（key escrow）方案，见 §5。
- 机器凭据注册采用 `happy enroll` + 一次性 token 方案，**不**直接 scp 私钥文件，见 §7。
- SSH 凭据用 `HANDY_MASTER_SECRET` 派生密钥加密存库（复用服务端现有 token 加密手法）。
- Agent（Claude Code / Codex）认证：**默认统一使用公司配置的 API key**（provisioning 时自动注入，成员零操作）；**成员可选切换为用自己的账号 OAuth 登录**（在机器上完成一次 `claude` / `codex` 登录，可直接通过网页远程会话完成）。见 §9.5。

---

## 2. 现有架构基础（哪些直接复用）

fork 自 `/home/dev/Documents/happy`（slopus/happy），pnpm monorepo：

| 包 | 作用 | 本项目处理方式 |
|---|---|---|
| `packages/happy-server` | Fastify + Socket.IO + Prisma(Postgres) + Redis + S3 | 复用，新增团队模块 |
| `packages/happy-cli` | 装在成员机器上，包 claude/codex，daemon 主动 WebSocket 连回服务器 | 复用，新增 `enroll` 命令 |
| `packages/happy-app` | Expo 的 Web+移动客户端 | 复用，替换登录页 + 新增管理后台 |
| `packages/happy-wire` | 协议定义 | 原样复用 |

关键既有事实（实现前先读对应源码确认细节）：
- 账号模型：一个 NaCl 密钥对 = 一个 `Account`（`publicKey` 唯一键），签名挑战换 JWT。参考 `docs/user-identity.md`、`packages/happy-server/prisma/schema.prisma`、CLI 侧 `packages/happy-cli/src/api/auth.ts`。
- CLI 凭据存储：`~/.happy/` 下 settings.json（含 `serverUrl`、`machineId`）+ 私钥文件，读写逻辑在 `packages/happy-cli/src/persistence.ts`，服务器地址可用 `HAPPY_SERVER_URL` 覆盖（`packages/happy-cli/src/configuration.ts`）。
- daemon 运行时**主动出网**连服务器，成员机器无需开端口；SSH 只用于一次性引导。
- 服务端已有加密存储敏感 token 的手法（GitHub token、AI vendor key，见 `docs/user-identity.md` 与 connectRoutes.ts），托管私钥与 SSH 凭据加密直接复用同一套。
- 部署基础：`Dockerfile.server`、`Dockerfile.webapp`、`docs/deployment.md`（必需 env：`DATABASE_URL`、`HANDY_MASTER_SECRET`、`REDIS_URL`、S3 五件套；无 S3 时落本地文件系统）。
- 服务端已有 Machine 心跳/在线状态，管理后台的机器总览只需加聚合查询。

---

## 3. 总体架构

```
┌─────────────────────────── 企业服务器 ────────────────────────────┐
│                                                                   │
│  webapp (浏览器)                server (fork 改造)                │
│  ├─ 登录页(邮箱+密码) ────────► ├─ sources/team/auth      (新增)  │
│  ├─ 会话/终端 UI (复用)         ├─ sources/team/escrow    (新增)  │
│  └─ 管理后台 (新增)             ├─ sources/team/provision (新增)  │
│                                 ├─ sources/team/admin     (新增)  │
│                                 └─ 原有 sync/session/machine     │
│                                                                   │
│  Postgres          Redis           MinIO(S3)        Caddy(TLS)    │
└───────────────────────────────────────────────────────────────────┘
                     ▲ WebSocket 443（成员机器主动连入）
         ┌───────────┴────────────┬──────────────────┐
    成员A的电脑               成员B的服务器          ...
    happy daemon              happy daemon
    （由 Provisioner           + claude / codex
      SSH 一次性初始化）
```

---

## 4. 仓库与代码组织

1. 新项目仓库 = 本 monorepo 的 clone/fork（如 `happy-team`），保留 git 历史，`git remote add upstream` 指向原仓库以便定期合并。
2. **改动收敛原则**：
   - 服务端新代码全部放 `packages/happy-server/sources/team/`（auth、escrow、provision、admin、audit 各一个子模块），在 main.ts 只加一处路由注册。
   - CLI 新代码：新增 `enroll` 子命令文件 + index.ts 一处注册。
   - 前端新代码放独立目录（如 `sources/team/` 或按该包现有路由约定的新路由组），登录入口替换点尽量单一。
3. 遵守各包已有 CLAUDE.md / AGENTS.md 的代码规范（严格类型、少 class、`@/` 别名、Vitest 真实调用不 mock 等）。
4. 新增包依赖：服务端 `ssh2`、`argon2`（或 `@node-rs/argon2`）；队列优先复用仓库内已有方案，没有则用 BullMQ（Redis 已在栈内）。

---

## 5. 鉴权与身份设计

### 5.1 TeamUser 与托管密钥
- 新表 `TeamUser`（见 §6），与原有 `Account` 一对一。
- 创建成员时：服务端生成 NaCl 密钥对 → 以 publicKey upsert `Account`（复用现有 upsert 逻辑）→ 私钥用 `HANDY_MASTER_SECRET` 派生密钥 AES 加密后存 `TeamUser.encSecretKey`。
- 管理员播种：服务端启动时若无任何 ADMIN，读取 `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` 创建（首次登录强制改密码）。

### 5.2 登录流程
```
浏览器 ─ POST /v1/team/auth/login {email, password}
  server: argon2 校验 → 解密托管私钥 → 走现有签名挑战逻辑签发 happy JWT
  返回 { happyToken, secretKey, role, mustChangePassword }
浏览器: 用 secretKey 灌入 app 现有的 "restore from secret key" 初始化路径
  → 之后全部走原有同步/加密代码，app 主体无感
```
- 登录接口需限流（Redis 计数）+ 审计记录。
- 密码策略：最小长度 10，argon2id 默认参数即可。
- 提供 `POST /v1/team/auth/change-password`；管理员可重置成员密码（生成一次性临时密码，强制首登修改）。
- DISABLED 状态的用户：登录拒绝 + 现有 happy JWT 失效（实现方式：team 模块在 JWT 校验装饰器后加一层 TeamUser 状态检查，或缩短 token 时效 + 登录态刷新，取实现成本低者，但必须保证禁用后分钟级生效）。

### 5.3 权限模型
- MEMBER：只访问自己 Account 名下资源（原有 Account 隔离天然保证，无需额外行级过滤）。
- ADMIN：额外可访问 `/v1/team/admin/*`。admin 路由统一挂角色校验前置钩子。

---

## 6. 数据模型（Prisma 新增）

```prisma
enum TeamRole { ADMIN MEMBER }
enum TeamUserStatus { ACTIVE DISABLED }
enum SshAuthType { PASSWORD PRIVATE_KEY }
enum AgentAuthMode { COMPANY_API PERSONAL_OAUTH }
enum ProvisionStatus { PENDING RUNNING SUCCEEDED FAILED }

model TeamUser {
  id                 String         @id @default(cuid())
  email              String         @unique
  passwordHash       String
  role               TeamRole       @default(MEMBER)
  status             TeamUserStatus @default(ACTIVE)
  mustChangePassword Boolean        @default(false)
  accountId          String         @unique   // -> Account.id
  encSecretKey       Bytes                    // master key 加密的 NaCl 私钥
  claudeAuthMode     AgentAuthMode  @default(COMPANY_API)  // Claude Code 认证模式
  codexAuthMode      AgentAuthMode  @default(COMPANY_API)  // Codex 认证模式
  createdAt          DateTime       @default(now())
  updatedAt          DateTime       @updatedAt
}

model SshCredential {
  id          String      @id @default(cuid())
  ownerUserId String                 // 分配给哪个成员 (TeamUser.id)
  label       String                 // "张三的开发机"
  host        String
  port        Int         @default(22)
  username    String
  authType    SshAuthType
  encAuth     Bytes                  // 加密的密码或 SSH 私钥
  deleteAfterUse Boolean  @default(false)
  createdBy   String                 // 管理员 TeamUser.id
  createdAt   DateTime    @default(now())
}

model ProvisionJob {
  id           String          @id @default(cuid())
  credentialId String?                // 凭据可能已被 deleteAfterUse 删除，保留快照字段
  hostSnapshot String                 // host:port 快照，凭据删除后仍可追溯
  targetUserId String                 // TeamUser.id
  agents       String[]               // ["claude"] / ["codex"] / 两者
  status       ProvisionStatus @default(PENDING)
  step         String?                // 当前步骤 key，前端进度展示
  log          String          @default("")  // 追加式执行日志
  machineId    String?                // 成功后关联的 Machine.id
  error        String?
  createdBy    String
  createdAt    DateTime        @default(now())
  finishedAt   DateTime?
}

model TeamAgentAuthUpdate {
  id             String @id @default(cuid())
  teamUserId     String                 // TeamUser.id
  machineId      String                 // Machine.id
  status         String                 // PENDING/APPLIED/FAILED
  claudeAuthMode AgentAuthMode
  codexAuthMode  AgentAuthMode
  error          String?
  appliedAt      DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([teamUserId, machineId])
}

model EnrollToken {
  id           String   @id @default(cuid())
  tokenHash    String   @unique       // 只存哈希
  targetUserId String
  expiresAt    DateTime               // 创建后 15 分钟
  usedAt       DateTime?
  createdBy    String                 // 管理员或 provisioner
  createdAt    DateTime @default(now())
}

model TeamAuditLog {
  id        String   @id @default(cuid())
  actorId   String?                   // 登录失败时可为空，记录 email 到 detail
  action    String                    // login/login_failed/create_user/disable_user/reset_password/create_credential/delete_credential/provision_start/provision_finish/enroll ...
  target    String?
  detail    Json?
  createdAt DateTime @default(now())
}
```

原有 `Account` / `Machine` / `Session` 等表**一律不改**。迁移用 `prisma migrate`。

---

## 7. 服务端 API 设计

统一前缀 `/v1/team`。除 login / enroll 外都要求 happy JWT + TeamUser 存在且 ACTIVE；`admin/*` 要求 ADMIN。

### 7.1 鉴权
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/team/auth/login` | `{email,password}` → `{happyToken, secretKey, role, mustChangePassword}`；限流；审计 |
| POST | `/v1/team/auth/change-password` | `{oldPassword,newPassword}` |
| GET  | `/v1/team/me` | 当前用户信息（email、role、状态、agent 认证模式） |
| PATCH | `/v1/team/me/agent-auth` | `{claude?: mode, codex?: mode}` 成员自助切换 agent 认证模式，触发在线机器的 agent.env 更新（§9.5） |

### 7.2 Enroll（CLI 调用，无 JWT，凭一次性 token）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/team/enroll` | `{token}` → `{secretKey}`。校验 tokenHash、未过期、未使用；标记 usedAt；返回目标用户托管私钥；审计 |

### 7.3 管理端
| 方法 | 路径 | 说明 |
|---|---|---|
| POST/GET | `/v1/team/admin/users` | 创建成员（自动生成 Account+托管密钥）/ 列表 |
| PATCH | `/v1/team/admin/users/:id` | 禁用/启用、重置密码（返回一次性临时密码）、代改 agent 认证模式 |
| GET | `/v1/team/admin/machines` | 全团队机器聚合：归属成员、在线状态、最近心跳（复用现有 Machine 数据） |
| POST/GET/DELETE | `/v1/team/admin/ssh-credentials` | 凭据 CRUD（响应中**永不回传**明文/密文凭据本体） |
| POST | `/v1/team/admin/provision-jobs` | `{credentialId, targetUserId, agents[]}` → 创建 job 入队 |
| GET | `/v1/team/admin/provision-jobs/:id` | job 状态 + 日志（前端轮询，间隔 2s 足够） |
| POST | `/v1/team/admin/provision-jobs/:id/retry` | 仅失败 job 可重试；复用原 SSH 凭据创建新 job 与新 enroll token |
| GET | `/v1/team/admin/provision-jobs` | job 列表 |
| POST | `/v1/team/admin/enroll-token` | `{targetUserId}` → 一次性 token 明文（也用于"手动安装"场景：管理员把一行命令发给成员自己执行） |
| GET | `/v1/team/admin/audit` | 审计日志分页查询 |

---

## 8. CLI 改动：`happy enroll`

新增子命令（注册进现有 CLI 入口）：

```bash
happy enroll --server https://happy.yourco.com --token <一次性token>
```

行为：
1. 调 `POST /v1/team/enroll` 换取 secretKey；
2. 走 CLI **现有的**凭据/设置写入逻辑（`persistence.ts`：写私钥文件 + settings.json 的 `serverUrl`），不自造文件格式；
3. 幂等：已 enroll 过则提示并要求 `--force` 覆盖；
4. 退出码明确（0 成功 / 非 0 带 stderr 原因），供 provisioner 判断。

> 设计动机：凭据文件格式的兼容性完全由 CLI 自己维护，provisioner 与 `~/.happy/` 内部结构解耦，upstream 变更不碎。

---

## 9. Provisioner（SSH 初始化）

服务端 `sources/team/provision/` 模块。`ssh2` 纯 JS 实现连接；job 经队列串行/限并发执行（并发上限 3）；每步更新 `ProvisionJob.step` 并向 `log` 追加带时间戳的输出。

### 9.1 步骤状态机
```
PENDING → RUNNING(connect → detect → install_node → install_cli
        → enroll → setup_agents → start_daemon → verify) → SUCCEEDED | FAILED
```

| step | 内容 | 失败处理 |
|---|---|---|
| connect | SSH 连接（密码或私钥） | 明确报错：认证失败/不可达/超时 |
| detect | `uname -sm`、`node -v`、`command -v happy`、是否 systemd、是否有出网代理 env | 不支持的 OS 直接 FAILED（M3 代码事实：Node artifact URL 按目标 `uname -s` / `uname -m` 解析；Linux x64 与 Linux arm64/qemu 已 E2E 验证，macOS 需要提供对应 artifact 并补真实机器验证） |
| install_node | 无 Node≥20 时，下载自包含 Node 二进制到 `~/.happy-team/bin/node`（**不依赖 root 与系统包管理器**）。M3 代码事实：`/v1/team/artifacts/node/:platform/:arch` 支持 `linux|darwin` + `x64|arm64`；Linux x64 默认从 server 镜像自身 Node runtime 分发，其他平台从 `TEAM_NODE_ARTIFACT_DIR` 查找企业自托管制品 | 下载失败给出代理配置提示 |
| install_cli | 从企业服务器分发 fork 版 CLI tarball，`npm install -g` 到用户级前缀（`~/.happy-team/prefix`），或直接解包运行 | |
| enroll | 服务端为目标成员生成一次性 EnrollToken → 远端执行 `happy enroll --server <url> --token <t>` | token 单次有效，日志中脱敏 |
| setup_agents | 检测 `claude` / `codex` 是否可用（缺失则从企业服务器分发安装）；按目标成员的 agentAuthMode（§9.5）生成 `~/.happy-team/agent.env`：COMPANY_API 模式写入公司 API key 环境变量，PERSONAL_OAUTH 模式不写 key 并在 job 结果标注"待成员完成一次 OAuth 登录" | 缺 agent 且无法安装不算 FAILED，标 warning |
| start_daemon | Linux 写 systemd **user** unit（无 systemd 则 cron `@reboot` + nohup 立即拉起）；macOS 写用户级 `~/Library/LaunchAgents/com.happy-team.daemon.plist`，plist 只 source `agent.env`，不展开保存公司 API key；随后启动 daemon | |
| verify | 轮询服务端确认新 Machine 心跳出现且归属正确 Account，回填 `machineId` | 60s 无心跳则 FAILED，附排查提示 |

完成后：若凭据 `deleteAfterUse`，删除 `SshCredential`（job 保留 hostSnapshot）。

### 9.2 安全要求
- SSH 凭据仅在 job 执行期间在内存解密，日志与错误信息全程脱敏（密码/私钥/enroll token 不落日志）。
- enroll token 只存哈希、15 分钟过期、单次使用。
- 所有 provision 操作写审计。

### 9.3 手动安装兜底（必须实现，成本极低）
管理后台提供"复制安装命令"：
```bash
curl/wget https://happy.yourco.com/v1/team/artifacts/cli.tgz ... &&
~/.happy-team/bin/happy enroll --server https://happy.yourco.com --token <t> --force &&
HAPPY_SERVER_URL=https://happy.yourco.com ~/.happy-team/bin/happy daemon start
```
覆盖 SSH 不可达/Windows 等场景，成员自己粘贴执行即可。

### 9.4 首版平台矩阵
- M2/M3 代码事实：Linux x64/glibc 已通过 Ubuntu 24.04 sshd 容器端到端验证；Linux arm64 已通过 Ubuntu 24.04 arm64/qemu sshd 容器端到端验证；Linux 无 systemd 走普通 daemon + `crontab @reboot` fallback。
- M3 代码事实：Node artifact 路由与 provisioning/manual command 已支持 `linux|darwin` + `x64|arm64`；Linux x64 可直接分发 server runtime，其他平台需在 `TEAM_NODE_ARTIFACT_DIR`/compose artifact mount 中提供 `node` 二进制。macOS start_daemon 路径已生成用户级 LaunchAgent，不需要 root 权限。
- 待补真实验收：物理 Linux arm64 或 macOS 真实机器端到端；macOS launchd 持久化实际重启验证；Alpine/musl Node 兼容。
- Windows：不支持 SSH 初始化，走手动安装兜底。

### 9.5 Agent 认证模式（默认公司 API，成员可选个人 OAuth）

每个成员按 agent 各有一个模式（`TeamUser.claudeAuthMode` / `codexAuthMode`），默认 `COMPANY_API`：

- **COMPANY_API（默认）**：服务端全局配置 `TEAM_ANTHROPIC_API_KEY` / `TEAM_OPENAI_API_KEY`（可选 `TEAM_ANTHROPIC_BASE_URL` 支持企业网关/代理）。provisioning 时把对应环境变量写入目标机 `~/.happy-team/agent.env`（权限 600），由 daemon 的 systemd unit `EnvironmentFile=` 引用 → 全自动，成员零操作，计费走公司账号。
- **PERSONAL_OAUTH（成员自选）**：不写入公司 key（注意：`ANTHROPIC_API_KEY` 存在会覆盖订阅登录，因此该模式下必须确保 agent.env 中无对应 key）。成员在该机器上完成一次 `claude` / `codex` 的 OAuth 登录即可——**可以直接通过网页开一个远程会话/终端完成**，无需物理接触机器；OAuth 交互本身无法由系统代劳，这是外部约束。

模式切换：
- 成员在网页设置页自助切换（每个 agent 独立），或管理员在成员管理页代改。
- 切换后需要更新目标机的 agent.env 并重启 daemon 才生效。M3 代码事实：daemon 侧 RPC 方法名为 `team-apply-agent-env`，复用现有 Machine RPC 加密/房间机制；server 使用托管私钥解开 legacy/dataKey 机器密钥后加密 payload。机器离线时写 `TeamAgentAuthUpdate` pending 行，上线 `machine-alive` 后应用。切 PERSONAL_OAUTH 时同时清除 agent.env 中的公司 key。
- 初始化向导中显示目标成员当前模式，允许管理员在发起 provisioning 时一并设定。

---

## 10. 前端改动（happy-app，Web 目标）

### 10.1 登录
- 新登录页：邮箱+密码 → 调 login 接口 → 拿 secretKey 走 app **现有的** "restore from secret key" 初始化路径 → 进入主界面。原扫码/手输 key 入口保留为隐藏 fallback（如 `/legacy-login`）。
- `mustChangePassword` 时先弹强制改密。
- 登出需清空本地密钥存储（复用现有 logout/reset 逻辑）。

### 10.2 管理后台（仅 ADMIN 可见，新路由组）
1. **成员管理**：列表（含机器数、状态、agent 认证模式）、创建（显示一次性初始密码）、禁用/启用、重置密码、管理员代改 Claude/Codex agent 认证模式。
2. **机器初始化向导**：选成员 → 填/选 SSH 凭据 → 选 agents → 提交 → 实时步骤进度 + 滚动日志（轮询 job 接口）→ 成功页含机器名；失败页含日志、重试按钮与"手动安装命令"兜底。
3. **机器总览**：全团队机器表（成员、主机名、在线状态、最近心跳、活跃会话数）。
4. **SSH 凭据管理**：列表（只显示 label/host/user，永不显示秘密）、新增、删除、"用完即删"开关。
5. **审计日志**：分页表格 + 按 action/actor 筛选。

### 10.3 成员设置页（新增，小页面）
- Agent 认证模式切换：Claude Code / Codex 各一个开关（公司 API ↔ 个人账号 OAuth），显示当前生效状态与 pending 机器；切到个人模式时给出引导文案："在网页里打开该机器的会话，运行一次登录即可"。
- 改密码入口。

成员其余视图不改。

---

## 11. 部署

新增根目录 `docker-compose.yml` + `deploy/README.md`：

```yaml
services:
  postgres:   # pg16, volume 持久化
  redis:      # redis7
  minio:      # 或省略，server 落本地文件系统亦可（deployment.md 已支持）
  server:     # build: Dockerfile.server；env 见下
  webapp:     # build: Dockerfile.webapp；EXPO_PUBLIC_HAPPY_SERVER_URL 指向 server 公网地址
  caddy:      # TLS 反代：happy.yourco.com -> webapp / api.happy.yourco.com -> server(3005)
```

必需 env（server）：`DATABASE_URL`、`REDIS_URL`、`HANDY_MASTER_SECRET`（强随机 32B+，密管保存）、S3 五件套（用 minio 时）、`ADMIN_EMAIL`、`ADMIN_INITIAL_PASSWORD`、`TEAM_ANTHROPIC_API_KEY` / `TEAM_OPENAI_API_KEY`（COMPANY_API 默认模式的公司 key，至少配一个）；可选 `TEAM_ANTHROPIC_BASE_URL`（企业网关/代理）。

运维要求：
- Postgres 每日备份，**备份必须加密**（库里有托管私钥与 SSH 凭据密文）。
- webapp 构建时的服务器地址注入方式以 `packages/happy-app` 实际 env 约定为准（实现时查该包的环境变量读取代码，不要臆测变量名）。
- CLI 分发：fork CLI 发到私有 npm registry，或 server 静态托管 tarball；provisioner 与手动安装命令都从这里取。

---

## 12. 里程碑与验收（按序执行，无时间约束）

### M0 自部署跑通（零代码改动）
- 产出：`docker-compose.yml`、部署文档。
- 验收：compose 起全套；一台 Linux 机器手动装原版 CLI（`HAPPY_SERVER_URL` 指向自建服务器）完成 auth + daemon；浏览器打开 webapp 能完整进行一次 Claude Code 会话（发消息、看输出、权限审批）。

### M1 独立鉴权 + 托管密钥
- 产出：TeamUser/审计表迁移、login/change-password/me 接口、admin users CRUD、管理员播种、Web 登录页、成员管理页、登录限流。
- 验收：管理员登录 → 创建成员 → 成员用邮箱密码登录 → 用 M0 的机器（enroll 到该成员，临时手动方式）在其账下正常可用；禁用成员后其无法再登录且现有会话访问失效；关键操作出现在审计日志。

### M2 Enroll + SSH Provisioning
- 产出：`happy enroll` 命令、EnrollToken 接口、ssh2 执行器 + job 队列 + 状态机、SSH 凭据 CRUD、初始化向导 UI、Node/CLI 制品分发、systemd 持久化、COMPANY_API 默认模式的 key 注入（agent.env）、手动安装命令。
- 验收：管理后台对一台**干净** Linux 机器（无 Node、无 happy）填 SSH 信息点击初始化 → 数分钟内机器上线归属正确成员 → 成员网页直接开 Claude Code 会话且**无需任何 agent 登录**（走公司 API key）；重启目标机后 daemon 自动恢复在线；`deleteAfterUse` 生效；日志无任何明文秘密。

### M3 管理与运维完善
- 产出：机器总览页、审计查询页、密码重置全流程、provision 失败重试、成员自助切换 agent 认证模式全链路（设置页 + RPC 更新 agent.env + daemon 自重启 + 离线 pending）、（可选）Codex 同流程验证、upstream 同步文档。
- 验收：两名以上真实成员、三台以上机器（至少一台 arm64 或 macOS）稳定使用；至少一名成员切换为 PERSONAL_OAUTH 并通过网页远程会话完成登录、确认请求走个人账号（且切回 COMPANY_API 同样生效）；从零重演一遍部署文档可完整复现整套系统。

### 每个里程碑通用要求
- 新增服务端逻辑带 Vitest 测试（遵循仓库"真实调用不 mock"惯例；SSH 执行器可对本地 sshd 容器测试）。
- 端到端手工验证走真实浏览器 + 真实机器，不以单测通过为完成标准。
- 遵守各包 CLAUDE.md 代码规范；改动收敛原则（§4.2）作为 code review 检查项。

---

## 13. 风险与应对

| 风险 | 应对 |
|---|---|
| 目标机环境多样（无 root、无外网、代理、arm） | 自包含 Node + 企业服务器自分发制品 + 用户级安装；手动安装命令兜底 |
| agent OAuth 无法自动化 | 默认 COMPANY_API 全自动零操作；选 PERSONAL_OAUTH 的成员通过网页远程会话自行完成一次登录 |
| PERSONAL_OAUTH 下公司 key 泄漏到个人用量（或反向） | 模式切换必须原子地重写 agent.env 并重启 daemon；`ANTHROPIC_API_KEY` 优先级高于订阅登录，切个人模式时必须清除 key |
| 托管私钥集中 | master secret 密管、备份加密、审计全覆盖；架构留有升级为浏览器端生成密钥的缝 |
| upstream 演进冲突 | 改动收敛在新目录 + 单点注册；保留 upstream remote 定期合并 |
| happy-app 的 restore-from-key 路径与假设不符 | M1 第一件事就是通读该路径源码验证桥接可行性，若入口形态不同则调整登录页灌入方式（这是 M1 唯一的架构级不确定点） |

---

## 14. 实施记录

### M0 代码事实确认
- 当前仓库已有两类 Dockerfile：根目录 `Dockerfile` 是单容器 standalone/PGlite 模式；`Dockerfile.server` + `Dockerfile.webapp` 是 full-stack 部署模式。M0 自托管 compose 采用后者，以满足 Postgres/Redis/MinIO 全套部署目标。
- `packages/happy-server/sources/main.ts` 启动时会连接 Postgres/Redis 并初始化文件存储，但不会自动执行 Prisma migrations；compose 的 server 启动命令必须先运行 `prisma migrate deploy`。
- `packages/happy-server/package.json` 的实际包名是 `happy-server-self-host`，不是旧 Dockerfile 中使用的 `happy-server` filter；M0 修正 `Dockerfile.server` 与 compose 启动命令以匹配实际包名。
- 服务端类型检查包含 `machinesRoutes.spec.ts` 的跨包契约引用，依赖 `happy-app/sources/sync/apiTypes`；M0 在 `Dockerfile.server` 的 builder 阶段复制 `happy-app/sources/sync`，runtime 阶段仍只复制 server/wire。
- `happy-server-self-host build` 会调用 `scripts/build-runtime.cjs` 并要求 `bun`，但 `Dockerfile.server` runtime 运行的是 `tsx ./sources/main.ts`，不依赖 standalone bundle；M0 的 server image 构建改为执行 `typecheck`。
- webapp 的服务器地址读取点在 `packages/happy-app/sources/sync/serverConfig.ts`，构建期变量为 `EXPO_PUBLIC_HAPPY_SERVER_URL`；`Dockerfile.webapp` 已通过 `HAPPY_SERVER_URL` build arg 映射到该变量。
- S3/MinIO 启动时 `loadFiles()` 只检查 bucket 是否存在，不自动创建；compose 需要 `minio-init` 预创建 bucket。

### M0 验收记录
- 2026-07-09：使用显式 `HANDY_MASTER_SECRET`、`POSTGRES_PASSWORD`、`MINIO_ROOT_PASSWORD` 从空卷启动 compose 全套服务；server/webapp 镜像构建通过，Postgres/Redis/server healthcheck 通过，MinIO live healthcheck 通过，Prisma migrations 应用数量为 37。
- 2026-07-09：在真实 Linux 主机上用原版 Happy CLI 源码构建产物，设置 `HAPPY_SERVER_URL=http://localhost:3005` 与 `HAPPY_WEBAPP_URL=http://localhost:8080`，完成 web auth、daemon 启动、机器上线；机器页显示 `dev-xps-ubuntu` online，Claude/Codex installed。
- 2026-07-09：用真实 Chromium 浏览器打开自托管 webapp，创建 Happy 账号，发起 Claude Code session，收到 `HAPPY_TEAM_M0_OK` 输出；切到 Plan 模式后完成 plan approval 与 Bash tool approval，并验证 `/tmp/happy-team-m0-plan-approval.txt` 内容为 `HAPPY_TEAM_PLAN_APPROVED`。

### M1 代码事实确认
- `happy-app` 的 restore-from-key 路径可直接桥接：`AuthProvider.login(token, secret)` 会把 `{token, secret}` 写入 `TokenStorage` 并调用 `syncCreate()`；根布局启动时会从 `TokenStorage.getCredentials()` 读取并执行 `syncRestore(credentials)`。因此 Team 登录接口返回 Happy JWT 与 32 字节 NaCl seed 的 base64url 字符串即可复用现有同步/加密初始化路径，无需修改原有协议。
- 手输恢复页 `restore/manual.tsx` 的 `authGetToken(secretBytes)` 只是在客户端用 seed 签名挑战并换取 Happy JWT；Team 登录由服务端托管 seed 后直接签发 JWT，前端调用同一个 `auth.login()` 写入凭据。
- 当前依赖树已包含纯 JS `@noble/hashes`；M1 将其声明为 server 直接依赖，用 `argon2id` 生成 PHC 格式密码哈希，避免新增 native postinstall 依赖。
- DISABLED 成员的 Happy JWT 失效通过两处保证：HTTP `app.authenticate` 成功验 token 后检查 `TeamUser.status`，WebSocket 握手与后续 socket event middleware 也检查同一状态；普通非 Team Happy Account 不受影响。
- Team admin users 更新接口使用 `PATCH /v1/team/admin/users/:id`；现有 Fastify CORS method 白名单需要包含 `PATCH`，否则浏览器只会完成 OPTIONS 预检而不会发出禁用/重置请求。M1 已把 `PATCH` 加入 `packages/happy-server/sources/app/api/api.ts` 的 CORS methods。

### M1 验收记录
- 2026-07-09：从 M0 compose 栈升级到 M1 schema，`prisma migrate deploy` 应用 `20260709010000_add_team_edition_core` 后迁移数量为 38；server 启动时用 `ADMIN_EMAIL=admin@happy-team.test` / `ADMIN_INITIAL_PASSWORD=AdminPass12345` 播种 ADMIN，首次登录强制改密。
- 2026-07-09：真实 Chromium 浏览器访问 `http://localhost:8080/team/login`，管理员邮箱密码登录后强制把密码改为 `AdminPassM145`，进入 `Team Members`；通过页面创建 `member-m1@happy-team.test`，随后成员邮箱密码登录并强制把临时密码改为 `MemberPassM145`，登录后进入原 Happy 主界面。
- 2026-07-09：用真实 Linux 主机上的 Happy CLI，在隔离 `HAPPY_HOME_DIR=/tmp/happy-team-m1-member-home.4GwqDl` 下设置 `HAPPY_SERVER_URL=http://localhost:3005` / `HAPPY_WEBAPP_URL=http://localhost:8080`，通过成员浏览器会话批准 `terminal/connect#key=...`，生成机器 ID `8bc826d5-26f7-4f13-a2f2-c5cd198364c9` 并启动 daemon；CLI `auth status` 显示 authenticated、machine registered、daemon running，成员网页显示 `Terminals connected`，管理员成员页显示该 member 有 1 台机器。
- 2026-07-09：管理员在真实浏览器 Team Members 页面禁用 `member-m1@happy-team.test`；列表刷新为 `member / disabled / 0 machines`，旧 CLI token 调 `/v1/team/me` 返回 HTTP 403 `{"error":"Account disabled"}`，被禁用成员再次在浏览器邮箱密码登录时停留在 `/team/login` 并显示 `User is disabled`。
- 2026-07-09：审计接口 `/v1/team/admin/audit?limit=100` 验证存在关键动作：`create_user`、`reset_password`、`change_password`、`disable_user`、admin/member `login`、禁用后 `login_failed`。

### M2 代码事实确认
- `happy enroll --server <url> --token <token>` 由 CLI 自己换取托管 secretKey、调用 `/v1/auth`、写入 legacy credentials 与新 machineId；provisioner 不直接写 `~/.happy/` 内部文件。
- server artifact 路由为 `GET /v1/team/artifacts/cli.tgz` 与 `GET /v1/team/artifacts/node/:platform/:arch`；Linux x64 自动分发 server runtime，Linux arm64/macOS 从企业配置 artifact 目录分发。
- Provisioning 队列限并发 3，状态步骤为 `connect -> detect -> install_node -> install_cli -> enroll -> setup_agents -> start_daemon -> verify`；`setup_agents` 写 `~/.happy-team/agent.env` 0600，`start_daemon` 优先 user systemd，fallback 为普通 daemon + `crontab @reboot`。

### M2 验收记录
- 2026-07-09：Docker compose 从空卷重放部署，server/webapp 镜像构建通过，`TEAM_ANTHROPIC_API_KEY` / `TEAM_OPENAI_API_KEY` 以占位 key 注入；管理员真实浏览器可打开 Provision Machine。
- 2026-07-09：对干净 Ubuntu 24.04 sshd 容器执行 API provisioning 与浏览器 provisioning 均成功；目标机安装自包含 Node/CLI，执行 enroll，daemon online，`agent.env` 权限 600 且包含公司 key，`deleteAfterUse` 凭据清理生效。占位 key 只能验证注入与进程环境，不能验证真实 Claude/OpenAI 计费链路。

### M3 代码事实确认
- 新增 `TeamAgentAuthUpdate` 表记录每台机器的 agent-auth 应用状态；该表只保存模式和状态，不保存生成后的 `agent.env` 或 API key。
- 成员自助接口为 `PATCH /v1/team/me/agent-auth`；管理员代改仍走 `PATCH /v1/team/admin/users/:id`。两者都会对该成员机器入队/尝试应用，并返回 `agentAuthSync` 汇总。
- daemon 新增 Machine RPC `team-apply-agent-env`：原子重写 `~/.happy-team/agent.env`、0600 chmod、更新当前 daemon `process.env`、再调度自重启。server 内部通过现有 Socket.IO RPC room 找 daemon，payload 仍按机器 legacy/dataKey 加密。
- 失败 provisioning job 的重试接口为 `POST /v1/team/admin/provision-jobs/:id/retry`，创建新 job 和新 enroll token，不复用旧 token。
- 手动安装命令会导出 `PATH="$HOME/.happy-team/bin:$PATH"` 后启动 daemon；否则目标机无系统 Node 时 CLI wrapper 可启动，但 `happy daemon start` 内部 spawn `node` 会失败。手动 enroll 的机器首次 `machine-alive` 若尚无 `TeamAgentAuthUpdate` 行，server 会自动创建并应用当前成员的 agent-auth 配置，避免把公司 API key 明文嵌入手动命令。
- Provisioning 与 Manual Command 都按目标机 `uname -s` / `uname -m` 生成 Node artifact URL：`/v1/team/artifacts/node/$platform/$arch`，平台支持 `linux|darwin`、架构支持 `x64|arm64`。compose 默认把 host 侧 `.team-artifacts/node` 只读挂载到 `/opt/happy-team/artifacts/node` 供企业放置非 x64 制品。
- CLI 内部自重启路径用 `process.execPath` 启动当前 Node runtime，不再依赖目标机 `PATH` 上存在系统 `node`；`happy daemon start` 等待 state file 的窗口从 5s 调整为 30s，以覆盖 arm64/qemu 与冷启动自包含 Node 的慢启动情况。
- macOS provisioning 的 `start_daemon` 分支写用户级 `~/Library/LaunchAgents/com.happy-team.daemon.plist`，通过 `/bin/sh -lc` source `~/.happy-team/agent.env` 后执行 `happy daemon start-sync`；plist 文件本身不保存 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`。若 SSH 会话中 `launchctl bootstrap gui/$UID` / `launchctl load` 不可用，会退回一次性 detached `happy daemon start` 并在日志标 warning。
- Team Members 管理页现在在每个成员行显示 Claude/Codex 当前认证模式，并通过 `Manage agent access` action 调用既有 `PATCH /v1/team/admin/users/:id` 完成管理员代改；前端合并更新响应时保留列表接口返回的 `machineCount`，避免 agent-auth 更新接口未带计数时把机器数显示为 0。

### M3 验收记录
- 2026-07-09：M3 后再次执行 CLI/server typecheck 与 focused Vitest：`pnpm --filter happy typecheck` 通过；`pnpm --filter happy-server-self-host typecheck` 通过；`pnpm --filter happy-server-self-host test -- sources/team/provision/runner.spec.ts sources/team/artifacts.spec.ts sources/team/routes.spec.ts sources/team/provision/ssh.spec.ts` 通过（Vitest 依赖收集共 13 个文件 / 80 tests）。M3 之前已执行 `happy-app` typecheck 通过。
- 2026-07-09：从空卷重放 `deploy/README.md` / compose 部署，`sudo docker compose build` 成功，`sudo docker compose up -d` 后 Postgres/Redis/server healthy，server 应用迁移到 `20260709030000_add_team_agent_auth_updates`，webapp `/team/login` 与 server `/` 均可访问。
- 2026-07-09：真实 Chromium 浏览器完成 admin 首登改密、Team Members 创建成员、Provision Machine 页面发起一台干净 Ubuntu 24.04 sshd 容器初始化；另用同一 live API 初始化两台干净 Ubuntu 24.04 sshd 容器。三台机器均在线并在 Team Machines 页面显示 owner：`member1@example.com` → `e638e530-12d0-47bb-a7e9-edb1f24dd052`，`member2@example.com` → `06038ca3-8f9d-40bb-a5c7-8a25a2ec5700`，`member3@example.com` → `6d49a3a8-0556-4c59-ae86-187b40cfa33e`。
- 2026-07-09：Provisioning 页面显示三条成功 job；两条 `claude,codex` job 的 `agent.env` 为 0600 且含公司 Anthropic/OpenAI key（命令输出只做 key 名称验证，值已 redacted）。持久化 `ProvisionJob.log` 中搜索 SSH 密码、enroll token、占位 API key，命中数为 0。
- 2026-07-09：Team Audit 页面在真实浏览器加载并按 `provision_succeeded` 过滤；审计中存在 `enroll` 3 条、`provision_succeeded` 3 条、`provision_retry_created` 1 条、`self_update_agent_auth_mode` 2 条。
- 2026-07-09：创建 bad-password provisioning job 使其在 `connect` 阶段失败；浏览器 Provisioning 页面显示 Retry 按钮，点击后创建新 job 与新 enroll token，原失败 job 不复用 token，重试 job 因同一错误凭据再次按预期失败。
- 2026-07-09：成员 `member1@example.com` 在真实浏览器打开 Team Agent Access，将 Claude Code 从 COMPANY_API 切到 PERSONAL_OAUTH 并保存；接口返回 `Applied 1 / Pending 0 / Failed 0`。目标机 `happy-team-m3-one` 的 `~/.happy-team/agent.env` 仍为 0600，`ANTHROPIC_API_KEY` 已清除，`OPENAI_API_KEY` 保留（Codex 仍为 COMPANY_API），daemon 进程时间更新为保存后的自重启时间。
- 2026-07-09：离线 pending 验证：停止 `member2@example.com` 目标 daemon 后调用成员自助切换 Claude Code 为 PERSONAL_OAUTH，`TeamAgentAuthUpdate` 为 `PENDING` 且 error 为 `RPC method not available`；用 provisioned Node/CLI + PATH 重启 daemon 后，machine-alive 触发 pending 应用，行变为 `APPLIED`，目标 `agent.env` 清除 `ANTHROPIC_API_KEY`、保留 `OPENAI_API_KEY`、权限保持 0600，daemon 完成二次自重启。
- 2026-07-09：补齐平台感知 Node artifact 路由：`getTeamNodeArtifactInfo()` 支持配置目录中的 `linux-arm64/node`、`darwin-arm64/node`、`darwin-x64/node`，Linux x64 fallback 为 server `process.execPath`；`install_node` 与 Manual Command 不再硬编码 Linux x64 URL。
- 2026-07-09：用 `tonistiigi/binfmt` 启用 arm64 binfmt，在 Linux x64 主机上运行 Ubuntu 24.04 arm64/qemu sshd 目标机；host 侧 `.team-artifacts/node/linux-arm64/node` 使用 Node `v20.20.2` arm64 二进制，live server `GET /v1/team/artifacts/node/linux/arm64` 返回 200。retry job `cmrdaonhs000fqq2tryzxhbjj` 成功完成 `connect -> detect -> install_node -> install_cli -> enroll -> setup_agents -> start_daemon -> verify`，机器 `85dec7b0-f6e6-48b8-a555-cca0199966bf` 归属 `member-arm64c-1783588717@example.com` 且 online；目标机 `uname -m=aarch64`，provisioned Node 报 `linux arm64 v20.20.2`，`agent.env` 为 `600 happy:happy` 并含公司 Anthropic/OpenAI key，`deleteAfterUse` 凭据已删除。
- 2026-07-09：同一 arm64/qemu 机器上，成员自助把 Claude/Codex 均切到 PERSONAL_OAUTH，接口返回 `Applied 1 / Pending 0 / Failed 0`，目标 `agent.env` 权限保持 0600 且公司 key 全部清除；随后切回 COMPANY_API，同样返回 `Applied 1 / Pending 0 / Failed 0`，公司 key 通过 daemon RPC 恢复。
- 2026-07-09：补齐 macOS 用户级 launchd 分支；`buildStartDaemonCommand()` 生成的远端 shell 通过 `sh -n` 语法检查，Vitest 覆盖 launchd plist、Linux systemd/cron fallback、以及启动脚本不嵌入公司 API key 名称。`SshExecutor` 增加 baseline error listener，避免 ssh2 失败握手清理后的迟到 socket error 作为 unhandled exception 污染测试结果。
- 2026-07-09：真实 Chromium 浏览器验证 Team Members 管理页的 `Manage agent access` action：管理员把 `member-arm64c-1783588717@example.com` 的 Claude Code 从 COMPANY_API 切到 PERSONAL_OAUTH、Codex 保持 COMPANY_API，页面显示 `Member / Active / 1 machine` 与 `Claude Personal OAuth / Codex Company API`，弹窗返回 `Applied 1 / Pending 0 / Failed 0`；目标 arm64/qemu 机器 `agent.env` 保持 `600 happy:happy`，`ANTHROPIC_API_KEY` 被清除、`OPENAI_API_KEY` 保留。
- 2026-07-09：同一真实浏览器流程把该成员 Claude Code 切回 COMPANY_API，页面保持 `1 machine` 且显示 `Claude Company API / Codex Company API`；目标 arm64/qemu 机器 `agent.env` 恢复 Anthropic/OpenAI 两个公司 key。期间补修了更新用户响应缺少 `machineCount` 时前端把机器数短暂显示成 0 的问题，并重建 webapp 镜像复验。
- 未完成的外部验收项：尚未在物理 Linux arm64 或 macOS 机器跑完端到端；macOS LaunchAgent 尚未在真实 macOS 重启后验证；`TEAM_ANTHROPIC_API_KEY` / `TEAM_OPENAI_API_KEY` 使用占位值，未能真实验证 Claude/OpenAI 计费链路；没有可用个人 Claude/Codex OAuth 账号，未能完成"切到 PERSONAL_OAUTH 后实际发起一次个人账号请求"的最终业务验收。
