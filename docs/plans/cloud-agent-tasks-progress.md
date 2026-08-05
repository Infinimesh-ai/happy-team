# Cloud Agent Tasks — 执行进度（单一事实源）

> **当前状态（2026-07-09）**：C0–C4 全部里程碑的**可自动化部分代码完成**并单测/集成通过；每个里程碑仅剩 `⏸ 待业主端到端人工验收`（真机 + 浏览器 + 真实 GitHub/GitLab + 真外部 Team-Skills 仓库），见各里程碑末尾清单：C0.11 / C1.9 / C2.8 / C3.6 / C4.9。
> 未验收项按红线一律**未自行声明里程碑关闭**。
> **2026-07-10 复核修复**：会话内代码复核发现并修复 4 处集成断裂（阶段 prompt/权限模式未送达会话、task-mcp 缺 serverUrl 回退、prompt 与产物契约矛盾、超时清扫无调度），见决策记录 2026-07-10 各行。
> 全量测试：服务端 181（25 文件）+ CLI unit 731（83 文件）全绿；三包（server/cli/app）typecheck 通过。
>
> 分支：`cloud-agent`，已于 2026-08-04 合并回 `main`（merge commit `e6727011`）；剩余 ⏸ 人工验收项随合并后的初步上线使用测试执行。
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
- [x] C1.1 任务 token 签发/校验（server 无状态签名：payload {taskId,stage,round}，短 exp；校验时比对任务当前 stage/round 实现「阶段结束作废」，不新增表）
- [x] C1.2 内部意图端点 `POST /v1/team/tasks/:id/intent`（task-token 鉴权）→ 转交状态机；每个意图（含被拒）全量落写 `TeamTaskTransition`
- [x] C1.3 状态机扩展：`complete_stage`（verify verdict 预留）/`report_blocker`→ESCALATED/`get_task_context`；`WAITING_APPROVAL` 态 + 审批边 + `approveTask`/`rejectTask`
- [x] C1.4 `happy task-mcp` stdio 子命令（get_task_context/complete_stage/report_blocker）→ HTTP 转发 server intent 端点；spawn 注入 `HAPPY_TASK_ID`/`HAPPY_TASK_TOKEN`/`HAPPY_TASK_STAGE`；prepare 写机器本地 `.mcp.json`（git 本地排除）注册 Claude MCP（Codex 配置随 C3 统一 adapter）
- [x] C1.5 T2 模板 `plan-execute` + plan 权限模式；状态机 plan→(审批)→execute；supervised 在 requiresApproval 边转 WAITING_APPROVAL 并推送（autonomous 自动放行）
- [x] C1.6 审批 API（`POST /:id/approve` 可带改后 plan.md 经 daemon 写回、`POST /:id/reject`、`GET /:id/plan` 读 plan.md）+ CLI `task-write-artifact`/`task-read-artifact` RPC + 前端 plan 审批卡（渲染/编辑/批准/编辑后批准/打回）
- [x] C1.7 三信号完成兜底（intent + 退出 + 产物）+ `TeamTaskTransition` 全量落写核对
- [x] C1.8 服务端/CLI 测试补齐（token、intent、审批转移、T2 多阶段推进、三信号兜底）
- [ ] C1.9 ⏸ C1 端到端人工验收（计划 §11 C1 清单）— 待业主执行，步骤见下

  **前置**：同 C0.11，且成员机器 daemon 已升级到含 task 系列 RPC + `happy task-mcp` 的版本；Claude Code 可在 worktree 内加载 `.mcp.json`（首次可能需批准 project MCP server）。
  1. **T2 规划阶段**：网页发起 `plan-execute` 任务（supervised），规划阶段（Claude, plan 模式）在 worktree 内只读分析并产出 `.happy-task/plan.md`；会话退出后任务转 `WAITING_APPROVAL`，手机/网页收到「Approval needed」推送。
  2. **审批卡**：网页/手机任务详情出现审批卡，渲染 plan.md；可直接批准、或编辑后批准（编辑经 daemon `task-write-artifact` 写回 worktree）、或打回（任务 FAILED）。
  3. **执行阶段**：批准后执行阶段（Codex）按 plan.md 实施、提交、写 pr.md，交付出 PR/MR。
  4. **三信号兜底**：构造 agent 不调 `complete_stage` 的情形（或直接观察 T1），确认「会话退出 + 产物存在」仍推进交付。
  5. **report_blocker**：在一个阶段内让 agent 调用 `report_blocker`（或手动 POST intent），确认任务转 `ESCALATED` 并推送、`TeamTaskTransition` 落有 `escalated` 行。
  6. **黑匣子**：任务详情/审计可见完整 transition 序列（含 agent 意图与被拒）。
  验收通过后由业主打勾并记录 PR/MR 链接与一次 ESCALATED 案例。

  **会话内已自动化的降险**：状态机 T2 审批全流程、三信号幂等、report_blocker→ESCALATED、全量 transition 序列、token 签发/校验、intent 端点鉴权、task-mcp 意图转发、`.mcp.json` 注册与 git 排除、plan 读写回，均有单测/集成覆盖（server 143 + CLI 712 全绿）。仅「真 agent 在真会话内实际调用 MCP 工具 + Claude 对 project MCP 的审批 + Codex 执行」三处真外部行为留待本清单真机验收。

## C2 闭环 + autonomous

- [x] C2.0 细化本里程碑条目（对照计划 §6 §7 §10，粒度对齐 C0/C1）
- [x] C2.1 T3 模板 `plan-execute-verify`（verify 阶段 + 条件边 verify_passed/verify_failed_within_budget）
- [x] C2.2 状态机 verdict 分支：verify 通过→交付；不通过 && round+1<maxRounds→回执行（round++、注入 findings.md）；否则→ESCALATED
- [x] C2.3 验收阶段证据注入（verify prompt 注入 plan.md/findings.md 路径 + 指示跑门禁看 diff、逐条定位；daemon 执行门禁并注入真实输出属 C4）
- [x] C2.4 `request_transition` 意图 + server 对照模板裁决（模板有该边→auto_approved 推进；无→rejected；均落写黑匣子）+ task-mcp 工具
- [x] C2.5 autonomous 模式核对（全边自动放行，T3 自主闭环 pass/rework/ESCALATED 均已测）
- [x] C2.6 Transition 黑匣子查询页（前端任务详情渲染 transition 全序列：from→to · decision · requestedBy · reason）
- [x] C2.7 服务端测试补齐（返工回路、3 轮 ESCALATED、request_transition 裁决；server tasks 56 全绿）
- [ ] C2.8 ⏸ C2 端到端人工验收（含构造必失败任务验证 3 轮 ESCALATED）— 待业主执行，步骤见下

  **前置**：同 C1.9。
  1. **autonomous 闭环**：autonomous 模式发起一个中等 `plan-execute-verify` 任务，全程零人工走完 规划→执行→验收→（至少一轮 findings.md 返工）→交付；看板/详情可见 round≥1 与最终 PR。
  2. **必失败 3 轮 ESCALATED**：构造一个验收必然失败的任务（如要求实现一个自相矛盾的目标），确认执行↔验收循环在 3 轮后转 ESCALATED 并推送，附最后一份 findings.md。
  3. **request_transition**：让 agent（或手动 POST intent）请求一个模板允许的非默认转移与一个不允许的，确认前者放行、后者被拒，两者都在 transition 黑匣子留痕。
  4. **黑匣子回放**：任务详情 History 区可回放全部 agent 意图（含被拒），与实际阶段推进一致。
  验收通过后由业主打勾并记录 autonomous 交付 PR 与 ESCALATED 案例链接。

  **会话内已自动化的降险**：T3 autonomous pass/rework/3 轮 ESCALATED、request_transition 放行/拒绝、verdict 分支、黑匣子全序列均有单测（server tasks 56 全绿）。仅真 agent 在真会话内实际产出 findings.md 并调 complete_stage(verdict) 的真实行为留待真机验收。

## C3 Skills 下发 + 双平台收尾

- [x] C3.0 细化本里程碑条目（对照计划 §9.2 §8 §12）
- [x] C3.1 daemon 机器统一 clone 同步（`~/.happy/team-skills/`，env `HAPPY_SKILLS_DIR`/`TEAM_SKILLS_REF`）+ 记录 HEAD（无 clone 则 skillsCommit=null no-op）
- [x] C3.2 worktree 注入 adapter（吸收 link-project.sh）：`.claude/skills/` + `.agents/skills/` 符号链接、AGENTS.md 块、按 `repo:` 匹配项目 skill、无匹配挂 standards；全部 git 本地排除；`injectTeamSkills` 落地并回填 `skillsCommit`
- [x] C3.3 provisioning 扩展检测（`detectTaskPrerequisites`：gh/glab 可用+已认证、skills clone 存在）→ warnings，probe 可注入单测
- [x] C3.4 模板阶段 prompt 改为引用下发 skills（T2/T3 规划/验收标准指向 `.claude/skills/standards`；执行遵 SOP）
- [x] C3.5 服务端/CLI 测试补齐（注入 adapter 对本地假 skills clone + 真 worktree 测；preflight 注入 probe 测）
- [ ] C3.6 ⏸ C3 端到端人工验收（GitHub 与 GitLab 各交付一次；append_lesson 写回；skillsCommit 可见）— 待业主执行，步骤见下

  **前置**：机器上预置 Team-Skills clone（`~/.happy/team-skills/` 或 `HAPPY_SKILLS_DIR`）；`gh`、`glab` 均已认证；分别有一个 GitHub 项目与一个自建 GitLab 项目可 push。
  1. **干净机器可跑**：新 provision 的机器（含 skills clone、gh/glab 认证）直接发起任务并交付，不再手工挂载。
  2. **双平台各一次**：同一类任务在 GitHub 项目与 GitLab 项目各完整交付一次（`task-deliver` 分别走 `gh pr create` / `glab mr create`）。
  3. **skillsCommit 可见**：任务详情显示当次注入的 `skillsCommit`；worktree 内 `.claude/skills/`、`.agents/skills/` 有 standards（+ 匹配项目 skill）符号链接且不入 PR。
  4. **SOP 生效 + 版本可区分**：改 skills 仓库一条 SOP 后新任务立即生效；两次任务的 `skillsCommit` 不同可区分。
  5. **append_lesson 写回**：任务会话内经 skills MCP 记一条 lesson，确认 append-only 写回成功（写回 MCP 完整形态属 C4 `happy skills-mcp`，本项验证现有 Team-Skills MCP 路径）。
  验收通过后由业主打勾并记录两个平台的 PR/MR 链接与 skillsCommit。

  **会话内已自动化的降险**：注入 adapter（standards + repo 匹配项目 skill 挂载、git 排除、AGENTS.md 块、HEAD 记录）对真实本地 skills clone + worktree 全测；gh/glab/skills 前置检测注入 probe 测；`task-deliver` 双平台探测 C0.4 已测。仅真 GitHub/GitLab 网络交付、真 agent 读 skills、append_lesson 真写回留待真机验收。

## C4 策略层组件化与自迭代

- [x] C4.0 细化本里程碑条目（对照计划 §9.1–§9.5）
- [x] C4.1 产物 schema（plan.md/findings.md/pr.md frontmatter）+ 解析校验器；完成判定升级为「可解析且字段完备」（读到内容即校验，读不到 null 回退存在性）
- [x] C4.2 内容契约 linter：项目 skill `repo:`/`validation:` 字段校验 + SKILL.md 上下文预算（行数上限）linter
- [x] C4.3 `skills.yaml`（contractVersion + 项目映射）解析 + `validateSkillsDirectory` 分发前契约校验（不合格 ref → errors 拒绝）；对接管理端通知/下发门为配置接线
- [x] C4.4 验收门禁 daemon 执行 + 真实输出注入 verify：CLI `task-run-validation`（从匹配项目 skill 的 `validation:` 解析命令并在 worktree 内真实运行、截断输出）+ gateway `runValidation` + 状态机进入 verify 前跑门禁并把真实输出注入 `{{validationOutput}}`。（仅「真项目的真门禁命令在真机上跑」留 C4.9 验收）
- [x] C4.5 遥测聚合报表（`computeTaskTelemetry`：per-template 结果、返工轮次分布、ESCALATED 案例、rejected 意图、escalationRate）
- [x] C4.6 T4 `skills-curator` 模板（整编→验收→交付 PR；只出 PR、人审合并）+ 定期调度经既有 routines/cron（配置接线）
- [x] C4.7 `happy skills-mcp`（get_skill/append_lesson，吸收现 mcp/server.py 到产品）+ 初始化 scaffold（契约合规骨架）；tag 化灰度 = `TEAM_SKILLS_REF` 指向 release tag（配置）
- [x] C4.8 服务端/CLI 测试补齐（artifact schema、contract/预算 linter、telemetry 聚合、T4 模板、skills-mcp get/append/scaffold；server 167 + CLI 723 全绿）
- [ ] C4.9 ⏸ Team-Skills 契约化改造与一次性切换（§9.5 检查清单）+ 公开模板发布 + 新团队空仓库跑通验证 + curator 周期端到端 + 规则退役证据 — 待业主执行，步骤见下

  **本项本质为外部/人工**（改动外部 Team-Skills 仓库、真机 curator 周期、真实发布切换），agent 会话内不可自动完成：
  1. **C4.4 验收门禁 daemon 执行**：在真机上让 daemon 读项目 skill 的 `validation:` 命令并实际运行，把真实输出注入 verify 会话上下文（seam：`validation:` 字段已在 `skillsContract` 校验；`task-check-artifacts`/read RPC 已具；缺的是 daemon 跑门禁 + 注入，需真项目命令）。验证：产物 frontmatter 缺字段时完成判定正确拒绝推进（C4.1 已单测，真机再验一次）。
  2. **契约化改造 Team-Skills**（`/home/dev/Documents/Team-Skills`，§9.5 步骤 1）：补齐各项目 skill `repo:`/`validation:` + 迁入 `skills.yaml`（contractVersion）+ 移除 `mcp/server.py`/`scripts`（由产品 `happy skills-mcp`/注入 adapter 接管），保留 git 历史与 decision-log。此改造本身作为一次任务在本系统上预演。
  3. **分发前校验通过**：`validateSkillsDirectory` 对改造后仓库返回 valid；故意破坏契约的 ref 被拒并通知管理员。
  4. **一次性切换**（§9.5 步骤 2/3）：切换检查清单全绿后 server 指向新 ref，旧人工流程（link-project.sh/手动同步/手动 Lesson Consolidation）即刻废止；`main` 保护 + 只经 PR 写入。
  5. **curator 周期端到端**：遥测报表 → T4 curator 出 PR → 人审合并 → 新 tag 对单项目灰度 → 观测无恶化 → 全量；至少一条 model-compensating 规则凭「N 周期零拦截」证据退役且有 decision-log 条目。
  6. **公开模板 + 新团队**：Team-Skills 契约化后剥离公司项目层即为第一个公开模板；一个全新团队从空仓库经 scaffold 初始化后完整跑通一个任务（组件化最终证明）。
  验收通过后由业主打勾并记录切换日期、公开模板地址、新团队跑通任务链接、退役规则 decision-log。

  **会话内已自动化的降险**：artifact 内容契约 + 完成判定升级、契约/预算 linter、`validateSkillsDirectory` 分发前校验、遥测聚合、T4 curator 模板、`happy skills-mcp`（get_skill/append_lesson/scaffold）均已单测/集成覆盖。仅真外部仓库改造、真机门禁执行、真实发布切换与 curator 真周期留待本清单人工验收。

## 决策记录

| 日期 | 项 | 决策 | 理由 |
|---|---|---|---|
| 2026-07-10 | C1.1 补记 | `taskToken` 实际实现直接以 `HANDY_MASTER_SECRET` 为 HMAC-SHA256 key，域分隔经消息前缀 `happy-task-token.v1`——非 C1.0 决策行所写「派生密钥」。 | 域分隔已由消息前缀提供，安全性等价；按「未记录的设计偏离视为缺陷」规则补记实际形态，不改代码。 |
| 2026-07-10 | 复核修复 C0.5 | 超时清扫接入运行时：main.ts 启动 `startTaskTimeoutSweeper`（60s `forever` 循环，同 presence timeout 模式）；sweep 用不可达 daemon 桩（失败任务是纯 DB+推送操作，机器失联时必须照常工作）+ 新 `createGlobalTaskNotifier`（notify 时按 taskId 解析 owner accountId）。语义记录：按 stageRun.startedAt 计算，是「阶段最长时长 2h」而非计划字面的「无活动 2h」（无逐消息活动跟踪可依）；PREPARING/WAITING_APPROVAL 不清扫（前者是受控 RPC 等待、后者等人）。 | 复核发现 `sweepStageTimeouts` 只有定义与测试、无任何调度者——会话崩溃收不到 session-end 时任务永远卡 RUNNING。 |
| 2026-07-10 | 复核修复 C4.1 | T2/T3 规划 prompt 与 verify prompt 显式给出产物 frontmatter 形状（plan.md `goal:` + `- [ ]` 清单；findings.md `verdict:`），templates.spec 增加「严格按 prompt 指令产出的示例产物必须通过 artifactSchema 校验器」round-trip 断言。同时记录：findings.md 校验器当前**未接入**完成判定（verify 阶段 `expectedArtifacts` 为空），是否强制留待 C2.8 真机观察后决定。 | C4.1 升级内容契约时未回改模板 prompt——校验器要求 frontmatter 而 prompt 从未提及，诚实 agent 的正常产出会被判 invalid、任务 FAILED；round-trip 测试使两者永不再漂移。 |
| 2026-07-10 | 复核修复 C0.7/C1.4/C1.5 | 阶段 prompt/permissionMode/model 经 spawn env（`HAPPY_TASK_PROMPT`/`_PERMISSION_MODE`/`_MODEL`）送达；CLI 新模块 `taskSessionBootstrap` 统一读取——claude 入口注入消息队列并设初始权限模式，codex 入口经 `startSession(initialPrompt)`。auto 阶段沿用 CLI 无人值守默认（yolo），仅 plan 阶段覆盖为 `plan`。task-mcp 的 serverUrl 回退 `configuration.serverUrl`（`HAPPY_SERVER_URL` 仅为 dev 覆盖）。 | 复核发现 `spawn-happy-session` 无首消息参数，真实 gateway 将状态机渲染好的 prompt/permissionMode **静默丢弃**（假 gateway 测试收到完整 effect，掩盖了缝隙）——真机上阶段会话将空转、plan 阶段以可写权限运行、生产 daemon 不导出 `HAPPY_SERVER_URL` 时 task-mcp 直接退出。 |
| 2026-07-09 | C0.1 | 三张新表不加外键关系，仅用带索引的 String 列（`ownerUserId`/`machineId`/`sessionId`/`taskId`）。 | 计划 §5「原有 Session/Machine 及 Team 版各表一律不改」；Prisma 关系需双向反向字段会改动既有表，故沿用 §5 快照的裸 String 建模。 |
| 2026-07-09 | C0.1 | 迁移 SQL 手写，命名 `20260709040000_add_team_tasks`，未跑 `prisma migrate dev`。 | `migrate diff`/`migrate dev` 需真实 Postgres 连接，本仓库标准开发用 PGlite；沿用 Team 版既有迁移（`20260709010000`/`030000`）的手写格式，已用 PGlite 全量迁移 + 列/枚举/默认值 round-trip 验证通过。 |
| 2026-07-09 | C0.2 | 模板用 `interface` + 字符串字面量联合（非 enum），`deliver` 只作为转移目标不入 `stages`；额外加入 `renderStagePrompt`（`{{token}}` 占位替换，未知 token→空串）与注册表 helper。 | 遵循包 CLAUDE.md「interfaces over types / avoid enums」；`deliver` 是 daemon 机械步骤（计划 §8）非 agent 会话；占位渲染是模板结构的直接配套且可单测，避免后续 spawn 接线时散落。默认 execute agent=claude、model 留空用会话默认，发起时可 stageOverrides 覆盖。 |
| 2026-07-09 | C0.3 | CLI 任务 RPC 走新模块树 `src/team/tasks/`，经 `registerTaskHandlers(rpcHandlerManager)` 在 apiMachine 单点注册（毗邻 `team-apply-agent-env`）；git 用 `execFile`（无 shell）；worktree 根 `<happyHomeDir>/worktrees/<taskId>`；prepare 幂等（已注册 worktree 直接复用）；Skills 注入 = `injectTeamSkills` 空实现挂载点（C3 落地）。 | §1.3「CLI 新代码独立模块 + 入口单点注册」；execFile 避免 shell 注入；happyHomeDir 兼顾 dev/prod 变体；幂等符合重试安全；C0.3 明确「本项只留挂载点」。机器本地配置重建（link-project.sh 吸收）随 Skills 一并留到 C3。 |
| 2026-07-09 | C0.4 | `deliverTask` 内 git 机械步骤（分支前缀校验/push/remote 探测/pr.md·plan.md 解析）为真实代码并对本地裸仓库测；外部 `gh`/`glab` PR 创建走可注入 seam（`createPullRequest`，默认真实 CLI），单测注入桩离线验证编排。remote 探测按 host 子串（github/gitlab），自建域名可用 `platform` 参数覆盖。cleanup 默认保留 worktree、删除时不动分支、幂等。 | 计划 §8 交付为 daemon 确定性步骤；push 对裸仓库离线可真跑，唯 hosted-platform CLI 属真外部依赖，注入 seam 非「mock 冒充集成」——确定性机制全真，真实 `gh`/`glab` 实现随包发布留 C0.11/C3 人工验收。自建 GitLab host 无 `gitlab` 字样的完整探测属 C3。 |
| 2026-07-09 | C0.5 | 状态机所有机器侧副作用经注入 `TaskDaemonGateway`（prepare/spawn/checkArtifacts/deliver），真实 daemon 实现（加密机器 RPC）留 C0.7；工厂函数 `createTaskStateMachine`（闭包非 class）；超时→`FAILED`（非 ESCALATED，后者 C1+，C0.5 状态集不含）；转移全量落写 `TeamTaskTransition`（decision=auto_approved）。 | §6「状态机脊柱」；包 CLAUDE.md「avoid classes」；C0.5 状态集显式仅 PENDING/PREPARING/RUNNING/SUCCEEDED/FAILED/CANCELLED；对内存 PGlite + 假 daemon 桩测（§11）。`checkArtifacts` 对应的 daemon 代查 RPC 与真实 gateway 一并留 C0.7。 |
| 2026-07-09 | C0.5 | `stageOverrides`（逐阶段 model 覆盖，§10.1 API）暂不持久化，阶段用模板默认 agent/model。 | 计划 §5 的 `TeamTask` schema 无 override 字段，T1 单执行阶段无覆盖必要；多阶段覆盖首次真正需要在 C1（T2），届时决定存储形态（新增字段或编码），本里程碑不臆造 schema。 |
| 2026-07-09 | C0.6 | POST 只创建 PENDING 任务不自动 start；cancel 为 service 内自足 DB 转移（非经状态机）。API 路由经 api.ts 单行 `teamTaskRoutes(typed)` 注册（毗邻 `teamRoutes`）；`GET /v1/team/tasks/templates`（静态段，Fastify 优先于 `/:id`）；`stageOverrides` 接受并校验阶段名但暂不落库。 | 自动 start 与状态机统一 cancel（含停会话）依赖真实 daemon gateway，属下一项 C0.7，不跳项前移；PENDING 是真实合法态非占位。路由在 sources/team/tasks/ 内、单点注册，符合 §1.3 收敛。 |
| 2026-07-09 | C1.7/1.8 | 三信号兜底与转移全量落写随 C1.3/C1.5 落地，C1.7 补「无 complete_stage 仅退出+产物仍推进」与 T2 全量 transition 黑匣子序列断言（`[null→plan auto]`/`[plan→execute awaiting]`/`[plan→execute user_approved]`/`[execute→deliver auto]`）。全量套件：server 143、CLI unit 712 全绿。 | 计划 §6 三信号、§7「所有意图落写黑匣子」；测试随项同步非集中补写。 |
| 2026-07-09 | C1.6 | plan.md 内容经 `GET /:id/plan` 按需读（daemon `task-read-artifact`，io 门控），不塞进 detail DTO（避免每次 detail 都触发 daemon 读）。审批卡在 `[id].tsx` status=WAITING_APPROVAL 时渲染可编辑 plan.md + 批准/编辑后批准/打回。写回经 `task-write-artifact`。i18n 7 键加入全部 11 文件（anchor 用语言无关的 `repoPathPlaceholder`）。 | 计划 §10.2 第 3 项审批卡；按需读避免 detail 热路径打 daemon；approve/reject 端点 C1.2 已建。前端交互真机验收随 C1.9。 |
| 2026-07-09 | C1.4 | task-mcp 意图**直接 HTTP** POST 到 server intent 端点（非再经 daemon socket），token 提供鉴权——§7「经 daemon 通道」取「daemon 负责 spawn 时注入 token/id + 写 MCP 配置」，转发本身走 HTTP（intent 端点即为此设计的 token-authed HTTP）。Claude 经 worktree 本地 `.mcp.json`（写入 `.git/info/exclude` 不入库）注册 `happy task-mcp`；per-session token/id 走 spawn env，故配置无秘密、跨阶段稳定。Codex 的 MCP 配置格式（config.toml）与 Claude 统一由 C3 注入 adapter 落地（§9.2「注入逻辑集中在 daemon 一处 adapter」）。task-mcp 客户端注入 fetch 单测；`.mcp.json` 写入 + git 排除对真实 worktree 测。live agent 实际调用 MCP + Claude 对 project MCP 的审批行为留 C1.9 真机验收。 | 计划 §7 工具面与 token；§9.2 adapter 归属。 |
| 2026-07-09 | C1.2/1.3 | 完成判定重构为按 stageRun 原子 claim 的 `completeStage`，`complete_stage` 意图与 `session-end` 共用之→三信号幂等（先到者推进，后到者 no-op）。`get_task_context` 为纯 DB 读（`readTaskContext`，无需 daemon/io）故可离线单测；状态变更意图（complete/blocker）与 approve/reject 经 `buildStateMachine`（io 门控）。`report_blocker`→ESCALATED（非终止 finishedAt，待人工）。intent 端点用 task-token 鉴权（非账号），approve/reject 用账号+归属+状态 409 守卫。`get_task_context` 不写 transition（纯读，避免灌爆黑匣子），其余意图含被拒全量落写。 | 计划 §6 三信号兜底 + §7 工具面；幂等避免 intent/exit 竞态双交付；§7「所有调用无条件写 TeamTaskTransition」取「状态相关意图 + 被拒」读法，纯读 context 除外（记录理由）。plan 写回经 gateway `writeArtifact`（`task-write-artifact` RPC，CLI 侧 C1.6 落地）。 |
| 2026-07-09 | C1.0 | C1 细化为 C1.1–C1.9（粒度对齐 C0）。任务 token 决定采用**无状态签名**（payload {taskId,stage,round}+短 exp），校验时比对任务当前 stage/round 实现「阶段结束作废」，**不新增 Prisma 表**。 | 计划 §7「按任务签发短期 token、阶段结束作废」；无状态方案天然实现作废（stage/round 前进后旧 token 不匹配即拒），避免新表与状态管理，签名复用 `HANDY_MASTER_SECRET` 派生密钥。 |
| 2026-07-09 | C0.10 | 测试随各项 TDD 式同步落地，非集中补写：状态机转移（`taskStateMachine.spec` 8）、worktree/交付对真实本地裸仓库（CLI `prepareWorktree.test` 5 + `deliverTask.test` 12）、API（`routes.spec` 8）、模板/通知/gateway（templates 8 + notifier 3 + machineTaskDaemon 4）。全量套件：server 123、CLI unit 705 全绿（含 agentAuth 抽取、session-end hook 无回归）。 | 计划 §11「服务端逻辑带 Vitest，Git 操作对本地裸仓库测」；agent→agent 多阶段推进路径待 C1 的 T2 覆盖（当前 registry 仅 T1）。 |
| 2026-07-09 | C0.9 | 前端三屏（看板 `tasks/index`、发起 `tasks/new`、详情 `tasks/[id]`）+ `team/api.ts` 客户端方法 + `taskLabels.ts`；发起页机器选择复用 `useAllMachines`（app sync store，非 admin 端点），模板来自 `GET /templates`；看板卡 tap → 详情（含阶段 session 深链、PR、cancel），非计划直述的「tap→会话」——因 summary DTO 不含 sessionId，详情屏承载会话入口。i18n `team.tasks.*` 键加入全部 10 个语言文件；发现类型/英文主控在 `text/_default.ts`（非 `translations/en.ts`），键加于此。 | §10.2 第 1/2 项；审批卡（第 3 项）留 C1。状态标签用扁平 `statusXxx` 经 `taskStatusLabel` 而非 4 层嵌套，规避 `TranslationStructure` 深度。前端端到端（真机+浏览器）属 C0.11 人工验收，本项交付代码 + `pnpm typecheck` 通过。 |
| 2026-07-09 | C0.8 | `TaskNotifier` 实现 `createTaskNotifier(accountId)` 复用 `dispatchSessionEventPush`（既有 session-event 推送通道 → Expo，自带 active 抑制）；push 落到 `TeamUser.accountId`，deep-link 用当前阶段 session（无则回退 taskId）。API 用户主动 cancel 不推送。 | 计划 §1.1 阶段推进/失败/交付推送、C0.8「复用现有通知通道」；dispatch 可注入使单测离线（无真实 Expo 调用），`renderTaskNotification` 纯函数直测。 |
| 2026-07-09 | C0.7 | 机器 RPC 加密从 `agentAuth.ts` 抽取到共享 `sources/team/machineRpc.ts`（`callMachineRpc` + 低层 helper），`agentAuth` 改为委托（apply 路径保持 transport→PENDING / daemon-error→FAILED 语义逐字不变，全 team 套件 48 测试通过）。gateway `createMachineTaskDaemon` 为纯映射，transport 注入可单测；`checkArtifacts` 落成 CLI 新 RPC `task-check-artifacts`。auto-start 经路由 `void startTeamTask`；会话退出经 `session-end` handler 单行 `handleTaskSessionEnd`（按 sessionId 关联 stageRun，非任务会话早返）；cancel 经 `stopActiveTaskSessions` best-effort 停会话。spawn 只注入 directory/agent/env(HAPPY_TASK_ID)，model/permissionMode 覆盖留后续。 | §3「复用 auth/加密手法」→抽取避免重复且保证一致（crypto 无测试覆盖，逐字移动 + typecheck 兜底）；真实 daemon 往返需活机器属 C0.11 人工验收，本项落地全部确定性/逻辑代码并单测（gateway 映射、关联查询经状态机 spec 覆盖）。无 socket server 时 runtime 安全 no-op。 |
