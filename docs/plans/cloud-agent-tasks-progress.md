# Cloud Agent Tasks — 执行进度（单一事实源）

> **当前状态（2026-07-09）**：C0 代码全部完成（C0.1–C0.10 ✅），仅剩 **C0.11 ⏸ 待业主端到端人工验收**（步骤见 C0.11 条目）。
> 业主决定：**先验收 C0 再开 C1**。C1 起始项 C1.0 在 C0 里程碑经业主验收关闭前不开工（遵守红线「上一里程碑未关闭就开下一个」）。
> 服务端 123 + CLI unit 705 测试全绿；两包 typecheck 通过。
>
> 分支：`cloud-agent`。
> 规则：严格按序取第一个未完成项；勾选与决策记录随实现同一变更提交；
> `⏸ 待人工验收` 表示 agent 已完成可自动化部分、剩余步骤已列出等业主执行。
> C0 已细化到可实现粒度；C1–C4 为里程碑级条目，**到达时由当次会话按计划文档细化为同等粒度再动工**（细化本身作为该里程碑第一项）。

## C0 任务骨架 + 仅执行模板

- [x] C0.1 Prisma 迁移：`TeamTask` / `TeamTaskStageRun` / `TeamTaskTransition`（计划 §5；原有表零改动）
- [x] C0.2 模板定义结构 `TaskTemplate` + T1 `execute-only`（`sources/team/tasks/templates.ts`，计划 §6）
- [x] C0.3 daemon RPC `task-prepare-worktree`：fetch → worktree add -b `happy/<user>/<slug>` → `.happy-task/` 创建（计划 §8；Skills 注入留到 C3，本项只留挂载点）
- [x] C0.4 daemon RPC `task-deliver`（分支前缀校验、push、remote 探测、`gh pr create` / `glab mr create`、pr.md 兜底）与 `task-cleanup`（默认保留 worktree）
- [x] C0.5 server 状态机最小实现（PENDING→PREPARING→RUNNING→SUCCEEDED/FAILED/CANCELLED）+ 完成判定（会话退出 + 产物存在）+ 阶段超时
- [x] C0.6 任务 API：POST/GET `/v1/team/tasks`、`/:id`、`/:id/cancel`、GET `/templates`（计划 §10.1；鉴权/审计沿用 Team 版模式）
- [x] C0.7 阶段 spawn 接线：状态机经既有 `spawn-happy-session` 在 worktree 内起会话（directory/agent/env 注入 `HAPPY_TASK_ID`）
- [x] C0.8 推送通知：阶段推进 / 失败 / 交付完成（复用现有通知通道）
- [x] C0.9 前端：任务发起页 + 任务看板（计划 §10.2 第 1、2 项；审批卡留 C1）— 代码完成，视觉/交互随 C0.11 真机浏览器验收
- [x] C0.10 服务端/CLI 测试补齐（状态机转移、worktree 与交付对本地裸仓库测）
- [ ] C0.11 ⏸ C0 端到端人工验收（计划 §11 C0 验收清单：真实机器、并行两任务、直推 base 被拒、手机跟进）— 待业主执行，步骤见下

  **前置**：一台已 Team provision 的常驻机器（daemon 在线、`gh` 已认证、Git 有 push 权限的真实 GitHub 仓库）；server 已部署含本分支；网页/手机已登录该成员账号。
  1. **发起 T1**：网页 设置 → Tasks → New Task，选该机器、填仓库路径、模板 `execute-only`、base `main`、写一句目标（如“在 README 加一行”）、模式随意 → Create。看板出现任务，状态从 PENDING→PREPARING→RUNNING。
  2. **自动跑完**：worktree 内 Claude 会话自动执行、写 `.happy-task/pr.md`、提交；会话退出后 daemon push 分支并 `gh pr create`。看板任务转 SUCCEEDED，详情页出现 PR 链接（点开可达 GitHub PR）。
  3. **并行两任务**：对同一机器/仓库同时发起第二个任务，确认两者各自独立 worktree/分支互不干扰，均能交付。
  4. **禁推 base**：构造一个 workBranch 非 `happy/` 前缀或直推 base 的情形（可用 daemon 日志验证 `task-deliver` 对非 `happy/` 分支或 base 分支拒绝）——确认被拒绝、任务不误交付到 base。
  5. **手机跟进**：手机端收到阶段/交付推送；进入任务详情能打开当前阶段会话并可追加消息。
  6. **取消**：对一个 RUNNING 任务点 Cancel，确认状态转 CANCELLED、活动会话被停止、worktree 保留（可 `cd` 进去）。
  验收通过后由业主将本项打勾并记录机器/仓库/PR 链接。

  **在会话内可自动化的前置降险（已完成）**：`taskPipeline.integration.spec.ts` 以真实 git 在进程内端到端跑通整条脊柱——真实 `git worktree add`（本地裸仓库 origin）→ 模拟 agent 写 `.happy-task/pr.md` 并 commit → 会话退出 → 真实产物存在性检查 → 真实 `git push` 落到 origin → 交付（PR URL 注入）→ SUCCEEDED；并验证缺 pr.md 时不 push、任务 FAILED。仅socket 加密传输、`gh`/`glab`、浏览器这三处真外部依赖留待 C0.11 真机验收。

## C1 多阶段 + task-control MCP + supervised

- [x] C1.0 细化本里程碑条目（对照计划 §6 §7 §10，粒度对齐 C0）
- [ ] C1.1 任务 token 签发/校验（server 无状态签名：payload {taskId,stage,round}，短 exp；校验时比对任务当前 stage/round 实现「阶段结束作废」，不新增表）
- [x] C1.2 内部意图端点 `POST /v1/team/tasks/:id/intent`（task-token 鉴权）→ 转交状态机；每个意图（含被拒）全量落写 `TeamTaskTransition`
- [x] C1.3 状态机扩展：`complete_stage`（verify verdict 预留）/`report_blocker`→ESCALATED/`get_task_context`；`WAITING_APPROVAL` 态 + 审批边 + `approveTask`/`rejectTask`
- [x] C1.4 `happy task-mcp` stdio 子命令（get_task_context/complete_stage/report_blocker）→ HTTP 转发 server intent 端点；spawn 注入 `HAPPY_TASK_ID`/`HAPPY_TASK_TOKEN`/`HAPPY_TASK_STAGE`；prepare 写机器本地 `.mcp.json`（git 本地排除）注册 Claude MCP（Codex 配置随 C3 统一 adapter）
- [x] C1.5 T2 模板 `plan-execute` + plan 权限模式；状态机 plan→(审批)→execute；supervised 在 requiresApproval 边转 WAITING_APPROVAL 并推送（autonomous 自动放行）
- [ ] C1.6 审批 API（`POST /:id/approve` 可带改后 plan.md 经 daemon 写回、`POST /:id/reject`）+ 前端 plan 审批卡（渲染/批准/编辑后批准/打回）
- [ ] C1.7 三信号完成兜底（intent + 退出 + 产物）+ `TeamTaskTransition` 全量落写核对
- [ ] C1.8 服务端/CLI 测试补齐（token、intent、审批转移、T2 多阶段推进、三信号兜底）
- [ ] C1.9 ⏸ C1 端到端人工验收（计划 §11 C1 清单）

## C2 闭环 + autonomous

- [ ] C2.0 细化本里程碑条目
- [ ] C2.x T3 模板 + 验收阶段（物化证据注入）+ findings.md 返工回路 + round/maxRounds
- [ ] C2.x request_transition 裁决 + autonomous 模式 + Transition 黑匣子查询页
- [ ] C2.x ⏸ C2 端到端人工验收（含构造必失败任务验证 3 轮 ESCALATED）

## C3 Skills 下发 + 双平台收尾

- [ ] C3.0 细化本里程碑条目
- [ ] C3.x daemon 统一 clone + worktree 注入 adapter（Claude/Codex 双形态）+ skillsCommit 记录
- [ ] C3.x provisioning 扩展（gh/glab/skills clone 检测）+ 模板 prompt 改引用 skills
- [ ] C3.x ⏸ C3 端到端人工验收（GitHub 与 GitLab 各交付一次；append_lesson 写回）

## C4 策略层组件化与自迭代

- [ ] C4.0 细化本里程碑条目（对照计划 §9，含 Team-Skills 契约化改造任务清单）
- [ ] C4.x 内容契约（产物 schema、repo:/validation: 字段、角色级 skills、完成判定升级、门禁 daemon 执行）
- [ ] C4.x 组件化（校验器 + 预算 linter + 分发前校验、`happy skills-mcp`、scaffold、skills.yaml/contractVersion）
- [ ] C4.x 遥测报表 + T4 curator + tag 化灰度发布
- [ ] C4.x ⏸ Team-Skills 契约化改造与一次性切换（§9.5 检查清单）+ 公开模板发布 + 新团队空仓库跑通验证

## 决策记录

| 日期 | 项 | 决策 | 理由 |
|---|---|---|---|
| 2026-07-09 | C0.1 | 三张新表不加外键关系，仅用带索引的 String 列（`ownerUserId`/`machineId`/`sessionId`/`taskId`）。 | 计划 §5「原有 Session/Machine 及 Team 版各表一律不改」；Prisma 关系需双向反向字段会改动既有表，故沿用 §5 快照的裸 String 建模。 |
| 2026-07-09 | C0.1 | 迁移 SQL 手写，命名 `20260709040000_add_team_tasks`，未跑 `prisma migrate dev`。 | `migrate diff`/`migrate dev` 需真实 Postgres 连接，本仓库标准开发用 PGlite；沿用 Team 版既有迁移（`20260709010000`/`030000`）的手写格式，已用 PGlite 全量迁移 + 列/枚举/默认值 round-trip 验证通过。 |
| 2026-07-09 | C0.2 | 模板用 `interface` + 字符串字面量联合（非 enum），`deliver` 只作为转移目标不入 `stages`；额外加入 `renderStagePrompt`（`{{token}}` 占位替换，未知 token→空串）与注册表 helper。 | 遵循包 CLAUDE.md「interfaces over types / avoid enums」；`deliver` 是 daemon 机械步骤（计划 §8）非 agent 会话；占位渲染是模板结构的直接配套且可单测，避免后续 spawn 接线时散落。默认 execute agent=claude、model 留空用会话默认，发起时可 stageOverrides 覆盖。 |
| 2026-07-09 | C0.3 | CLI 任务 RPC 走新模块树 `src/team/tasks/`，经 `registerTaskHandlers(rpcHandlerManager)` 在 apiMachine 单点注册（毗邻 `team-apply-agent-env`）；git 用 `execFile`（无 shell）；worktree 根 `<happyHomeDir>/worktrees/<taskId>`；prepare 幂等（已注册 worktree 直接复用）；Skills 注入 = `injectTeamSkills` 空实现挂载点（C3 落地）。 | §1.3「CLI 新代码独立模块 + 入口单点注册」；execFile 避免 shell 注入；happyHomeDir 兼顾 dev/prod 变体；幂等符合重试安全；C0.3 明确「本项只留挂载点」。机器本地配置重建（link-project.sh 吸收）随 Skills 一并留到 C3。 |
| 2026-07-09 | C0.4 | `deliverTask` 内 git 机械步骤（分支前缀校验/push/remote 探测/pr.md·plan.md 解析）为真实代码并对本地裸仓库测；外部 `gh`/`glab` PR 创建走可注入 seam（`createPullRequest`，默认真实 CLI），单测注入桩离线验证编排。remote 探测按 host 子串（github/gitlab），自建域名可用 `platform` 参数覆盖。cleanup 默认保留 worktree、删除时不动分支、幂等。 | 计划 §8 交付为 daemon 确定性步骤；push 对裸仓库离线可真跑，唯 hosted-platform CLI 属真外部依赖，注入 seam 非「mock 冒充集成」——确定性机制全真，真实 `gh`/`glab` 实现随包发布留 C0.11/C3 人工验收。自建 GitLab host 无 `gitlab` 字样的完整探测属 C3。 |
| 2026-07-09 | C0.5 | 状态机所有机器侧副作用经注入 `TaskDaemonGateway`（prepare/spawn/checkArtifacts/deliver），真实 daemon 实现（加密机器 RPC）留 C0.7；工厂函数 `createTaskStateMachine`（闭包非 class）；超时→`FAILED`（非 ESCALATED，后者 C1+，C0.5 状态集不含）；转移全量落写 `TeamTaskTransition`（decision=auto_approved）。 | §6「状态机脊柱」；包 CLAUDE.md「avoid classes」；C0.5 状态集显式仅 PENDING/PREPARING/RUNNING/SUCCEEDED/FAILED/CANCELLED；对内存 PGlite + 假 daemon 桩测（§11）。`checkArtifacts` 对应的 daemon 代查 RPC 与真实 gateway 一并留 C0.7。 |
| 2026-07-09 | C0.5 | `stageOverrides`（逐阶段 model 覆盖，§10.1 API）暂不持久化，阶段用模板默认 agent/model。 | 计划 §5 的 `TeamTask` schema 无 override 字段，T1 单执行阶段无覆盖必要；多阶段覆盖首次真正需要在 C1（T2），届时决定存储形态（新增字段或编码），本里程碑不臆造 schema。 |
| 2026-07-09 | C0.6 | POST 只创建 PENDING 任务不自动 start；cancel 为 service 内自足 DB 转移（非经状态机）。API 路由经 api.ts 单行 `teamTaskRoutes(typed)` 注册（毗邻 `teamRoutes`）；`GET /v1/team/tasks/templates`（静态段，Fastify 优先于 `/:id`）；`stageOverrides` 接受并校验阶段名但暂不落库。 | 自动 start 与状态机统一 cancel（含停会话）依赖真实 daemon gateway，属下一项 C0.7，不跳项前移；PENDING 是真实合法态非占位。路由在 sources/team/tasks/ 内、单点注册，符合 §1.3 收敛。 |
| 2026-07-09 | C1.4 | task-mcp 意图**直接 HTTP** POST 到 server intent 端点（非再经 daemon socket），token 提供鉴权——§7「经 daemon 通道」取「daemon 负责 spawn 时注入 token/id + 写 MCP 配置」，转发本身走 HTTP（intent 端点即为此设计的 token-authed HTTP）。Claude 经 worktree 本地 `.mcp.json`（写入 `.git/info/exclude` 不入库）注册 `happy task-mcp`；per-session token/id 走 spawn env，故配置无秘密、跨阶段稳定。Codex 的 MCP 配置格式（config.toml）与 Claude 统一由 C3 注入 adapter 落地（§9.2「注入逻辑集中在 daemon 一处 adapter」）。task-mcp 客户端注入 fetch 单测；`.mcp.json` 写入 + git 排除对真实 worktree 测。live agent 实际调用 MCP + Claude 对 project MCP 的审批行为留 C1.9 真机验收。 | 计划 §7 工具面与 token；§9.2 adapter 归属。 |
| 2026-07-09 | C1.2/1.3 | 完成判定重构为按 stageRun 原子 claim 的 `completeStage`，`complete_stage` 意图与 `session-end` 共用之→三信号幂等（先到者推进，后到者 no-op）。`get_task_context` 为纯 DB 读（`readTaskContext`，无需 daemon/io）故可离线单测；状态变更意图（complete/blocker）与 approve/reject 经 `buildStateMachine`（io 门控）。`report_blocker`→ESCALATED（非终止 finishedAt，待人工）。intent 端点用 task-token 鉴权（非账号），approve/reject 用账号+归属+状态 409 守卫。`get_task_context` 不写 transition（纯读，避免灌爆黑匣子），其余意图含被拒全量落写。 | 计划 §6 三信号兜底 + §7 工具面；幂等避免 intent/exit 竞态双交付；§7「所有调用无条件写 TeamTaskTransition」取「状态相关意图 + 被拒」读法，纯读 context 除外（记录理由）。plan 写回经 gateway `writeArtifact`（`task-write-artifact` RPC，CLI 侧 C1.6 落地）。 |
| 2026-07-09 | C1.0 | C1 细化为 C1.1–C1.9（粒度对齐 C0）。任务 token 决定采用**无状态签名**（payload {taskId,stage,round}+短 exp），校验时比对任务当前 stage/round 实现「阶段结束作废」，**不新增 Prisma 表**。 | 计划 §7「按任务签发短期 token、阶段结束作废」；无状态方案天然实现作废（stage/round 前进后旧 token 不匹配即拒），避免新表与状态管理，签名复用 `HANDY_MASTER_SECRET` 派生密钥。 |
| 2026-07-09 | C0.10 | 测试随各项 TDD 式同步落地，非集中补写：状态机转移（`taskStateMachine.spec` 8）、worktree/交付对真实本地裸仓库（CLI `prepareWorktree.test` 5 + `deliverTask.test` 12）、API（`routes.spec` 8）、模板/通知/gateway（templates 8 + notifier 3 + machineTaskDaemon 4）。全量套件：server 123、CLI unit 705 全绿（含 agentAuth 抽取、session-end hook 无回归）。 | 计划 §11「服务端逻辑带 Vitest，Git 操作对本地裸仓库测」；agent→agent 多阶段推进路径待 C1 的 T2 覆盖（当前 registry 仅 T1）。 |
| 2026-07-09 | C0.9 | 前端三屏（看板 `tasks/index`、发起 `tasks/new`、详情 `tasks/[id]`）+ `team/api.ts` 客户端方法 + `taskLabels.ts`；发起页机器选择复用 `useAllMachines`（app sync store，非 admin 端点），模板来自 `GET /templates`；看板卡 tap → 详情（含阶段 session 深链、PR、cancel），非计划直述的「tap→会话」——因 summary DTO 不含 sessionId，详情屏承载会话入口。i18n `team.tasks.*` 键加入全部 10 个语言文件；发现类型/英文主控在 `text/_default.ts`（非 `translations/en.ts`），键加于此。 | §10.2 第 1/2 项；审批卡（第 3 项）留 C1。状态标签用扁平 `statusXxx` 经 `taskStatusLabel` 而非 4 层嵌套，规避 `TranslationStructure` 深度。前端端到端（真机+浏览器）属 C0.11 人工验收，本项交付代码 + `pnpm typecheck` 通过。 |
| 2026-07-09 | C0.8 | `TaskNotifier` 实现 `createTaskNotifier(accountId)` 复用 `dispatchSessionEventPush`（既有 session-event 推送通道 → Expo，自带 active 抑制）；push 落到 `TeamUser.accountId`，deep-link 用当前阶段 session（无则回退 taskId）。API 用户主动 cancel 不推送。 | 计划 §1.1 阶段推进/失败/交付推送、C0.8「复用现有通知通道」；dispatch 可注入使单测离线（无真实 Expo 调用），`renderTaskNotification` 纯函数直测。 |
| 2026-07-09 | C0.7 | 机器 RPC 加密从 `agentAuth.ts` 抽取到共享 `sources/team/machineRpc.ts`（`callMachineRpc` + 低层 helper），`agentAuth` 改为委托（apply 路径保持 transport→PENDING / daemon-error→FAILED 语义逐字不变，全 team 套件 48 测试通过）。gateway `createMachineTaskDaemon` 为纯映射，transport 注入可单测；`checkArtifacts` 落成 CLI 新 RPC `task-check-artifacts`。auto-start 经路由 `void startTeamTask`；会话退出经 `session-end` handler 单行 `handleTaskSessionEnd`（按 sessionId 关联 stageRun，非任务会话早返）；cancel 经 `stopActiveTaskSessions` best-effort 停会话。spawn 只注入 directory/agent/env(HAPPY_TASK_ID)，model/permissionMode 覆盖留后续。 | §3「复用 auth/加密手法」→抽取避免重复且保证一致（crypto 无测试覆盖，逐字移动 + typecheck 兜底）；真实 daemon 往返需活机器属 C0.11 人工验收，本项落地全部确定性/逻辑代码并单测（gateway 映射、关联查询经状态机 spec 覆盖）。无 socket server 时 runtime 安全 no-op。 |
