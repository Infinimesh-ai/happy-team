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
| POST | `/v1/team/admin/provision` | `{credentialId, targetUserId, agents[]}` → 创建 job 入队 |
| GET | `/v1/team/admin/provision/:id` | job 状态 + 日志（前端轮询，间隔 2s 足够） |
| GET | `/v1/team/admin/provision` | job 列表 |
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
| detect | `uname -sm`、`node -v`、`command -v happy`、是否 systemd、是否有出网代理 env | 不支持的 OS 直接 FAILED（首版支持 Linux x64/arm64，其次 macOS） |
| install_node | 无 Node≥20 时，下载自包含 Node 二进制解压到 `~/.happy-team/node/`（**不依赖 root 与系统包管理器**）。二进制从企业服务器自身分发（server 启动时预置多平台 tarball 到 S3/本地），不依赖目标机访问外网 nodejs.org | 下载失败给出代理配置提示 |
| install_cli | 从企业服务器分发 fork 版 CLI tarball，`npm install -g` 到用户级前缀（`~/.happy-team/prefix`），或直接解包运行 | |
| enroll | 服务端为目标成员生成一次性 EnrollToken → 远端执行 `happy enroll --server <url> --token <t>` | token 单次有效，日志中脱敏 |
| setup_agents | 检测 `claude` / `codex` 是否可用（缺失则从企业服务器分发安装）；按目标成员的 agentAuthMode（§9.5）生成 `~/.happy-team/agent.env`：COMPANY_API 模式写入公司 API key 环境变量，PERSONAL_OAUTH 模式不写 key 并在 job 结果标注"待成员完成一次 OAuth 登录" | 缺 agent 且无法安装不算 FAILED，标 warning |
| start_daemon | 写 systemd **user** unit（无 systemd 则 cron `@reboot` + nohup 立即拉起），`happy daemon start`，开机自启 | |
| verify | 轮询服务端确认新 Machine 心跳出现且归属正确 Account，回填 `machineId` | 60s 无心跳则 FAILED，附排查提示 |

完成后：若凭据 `deleteAfterUse`，删除 `SshCredential`（job 保留 hostSnapshot）。

### 9.2 安全要求
- SSH 凭据仅在 job 执行期间在内存解密，日志与错误信息全程脱敏（密码/私钥/enroll token 不落日志）。
- enroll token 只存哈希、15 分钟过期、单次使用。
- 所有 provision 操作写审计。

### 9.3 手动安装兜底（必须实现，成本极低）
管理后台提供"复制安装命令"：
```bash
npx <fork-cli-package> enroll --server https://happy.yourco.com --token <t> && happy daemon start
```
覆盖 SSH 不可达/Windows 等场景，成员自己粘贴执行即可。

### 9.4 首版平台矩阵
- Linux (x64/arm64, systemd)：完整支持 —— 主要目标场景（成员服务器）。
- Linux 无 systemd / macOS：daemon 持久化降级方案（cron @reboot / launchd），best effort。
- Windows：不支持 SSH 初始化，走手动安装兜底。

### 9.5 Agent 认证模式（默认公司 API，成员可选个人 OAuth）

每个成员按 agent 各有一个模式（`TeamUser.claudeAuthMode` / `codexAuthMode`），默认 `COMPANY_API`：

- **COMPANY_API（默认）**：服务端全局配置 `TEAM_ANTHROPIC_API_KEY` / `TEAM_OPENAI_API_KEY`（可选 `TEAM_ANTHROPIC_BASE_URL` 支持企业网关/代理）。provisioning 时把对应环境变量写入目标机 `~/.happy-team/agent.env`（权限 600），由 daemon 的 systemd unit `EnvironmentFile=` 引用 → 全自动，成员零操作，计费走公司账号。
- **PERSONAL_OAUTH（成员自选）**：不写入公司 key（注意：`ANTHROPIC_API_KEY` 存在会覆盖订阅登录，因此该模式下必须确保 agent.env 中无对应 key）。成员在该机器上完成一次 `claude` / `codex` 的 OAuth 登录即可——**可以直接通过网页开一个远程会话/终端完成**，无需物理接触机器；OAuth 交互本身无法由系统代劳，这是外部约束。

模式切换：
- 成员在网页设置页自助切换（每个 agent 独立），或管理员在成员详情页代改。
- 切换后需要更新目标机的 agent.env 并重启 daemon 才生效。实现方式：daemon 侧增加一个轻量 RPC（复用现有 RPC 通道）"重写 agent.env + 自重启"；机器离线时标记 pending，上线后应用。切 PERSONAL_OAUTH 时同时清除 agent.env 中的公司 key。
- 初始化向导中显示目标成员当前模式，允许管理员在发起 provisioning 时一并设定。

---

## 10. 前端改动（happy-app，Web 目标）

### 10.1 登录
- 新登录页：邮箱+密码 → 调 login 接口 → 拿 secretKey 走 app **现有的** "restore from secret key" 初始化路径 → 进入主界面。原扫码/手输 key 入口保留为隐藏 fallback（如 `/legacy-login`）。
- `mustChangePassword` 时先弹强制改密。
- 登出需清空本地密钥存储（复用现有 logout/reset 逻辑）。

### 10.2 管理后台（仅 ADMIN 可见，新路由组）
1. **成员管理**：列表（含机器数、状态）、创建（显示一次性初始密码）、禁用/启用、重置密码。
2. **机器初始化向导**：选成员 → 填/选 SSH 凭据 → 选 agents → 提交 → 实时步骤进度 + 滚动日志（轮询 job 接口）→ 成功页含机器名；失败页含日志与"手动安装命令"兜底。
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
