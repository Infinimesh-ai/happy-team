# Happy Team Tasks — 云端任务模式实现计划

> 本文档是 Team Edition（见 [team-edition.md](team-edition.md)）之后的下一阶段蓝图：
> 在成员常驻机器上提供类 Cursor Cloud Agent 的「任务」能力——一句话发起，
> 多 Agent（Claude Code / Codex）按模板编排协作，产出分支与 PR/MR，全程可跟进可介入。
> **前置依赖：Team Edition M2 完成**（机器 provisioning、agent.env、enroll、托管密钥全部就绪）。
> 所有时间维度省略，按里程碑顺序执行。

---

## 1. 目标与范围

### 1.1 必须实现
1. **Task 一等公民**：任务 = 仓库 + 目标描述 + 编排模板 + 若干 agent 会话。网页/手机发起后即可走人，阶段推进、失败、交付均有推送通知。
2. **常驻机器 + worktree 隔离**：任务跑在成员自己的机器上（Team 版 provisioning 的产物），不销毁环境；每个任务一个 git worktree，多任务并行互不干扰。
3. **多 Agent 编排**：同一任务的不同阶段可指定不同 agent 与模型（如 Fable 5 规划、GPT-5.5 执行、Fable 5 验收），首版固化三个内置模板。
4. **两种运行模式**：supervised（关键转移人工确认）与 autonomous（全自动闭环，带轮次预算保险丝）。
5. **Git 交付**：产出物为分支 + PR/MR，GitHub 与 GitLab 双模式（`gh` / `glab` CLI 吸收差异）。
6. **策略层（Skills 组件，团队无关）**：策略层是产品组件而非某个团队的仓库——skills 仓库只含符合契约的内容（机器可读的产物 schema、验证命令、SOP），校验、注入、写回、curator 等一切机构由产品自带；发布有版本纪律（tag + 灰度），任务准备阶段自动下发并记录版本。没有 skills 的新团队从公开模板一键初始化后开始迭代；我们的 Team-Skills 完成契约化改造后成为第一个公开模板，上线时一次性切换（§9.5）。
7. **自迭代机制**：系统遥测（验收拦截率、返工轮次、ESCALATED 案例、guardrail 触发统计）驱动策略层迭代——curator 定期任务产出对 skills 仓库的 PR，人审合并后灰度发布。系统只能提议，只有人能合并。

### 1.2 明确不做（首版）
- 云端一次性容器/VM 池（机器常驻是既定前提；将来要做也是在同一 Machine 抽象下加一种机器来源，不影响本计划）。
- 自由编排 DAG / 模板可视化编辑器（模板先固化为代码内定义，可配化是后续里程碑）。
- server 侧 Git API 深度集成（webhook、CI 状态回写、自动 merge）——PR 创建走成员机器上的 CLI，server 只记录 URL；API 集成列为后续增强。
- 云端 IDE 式接管——降级为「网页终端进 worktree」+「本地 checkout 分支」，已够用。

### 1.3 既定决策（讨论已收敛，不要重新讨论）
- **状态机做脊柱，MCP 做神经**：编排状态机在 server 侧（可观测、可恢复、可审计）；agent 通过 task-control MCP 声明**意图**（完成阶段/请求转移/上报阻塞），server 对照模板校验后才真正执行。agent 不直接持有 spawn 权力。
- **文件是唯一交接介质**：阶段之间不做任何协议级上下文传递。规划产出 `plan.md`，验收产出 `findings.md`，交付材料 `pr.md`，全部落在 worktree 内的任务产物目录，随分支进 PR（评审者可见 agent 当时的计划）。
- **阶段完成的判定**：`complete_stage` 意图 + 会话进程退出 + 约定产物存在性检查（三者兜底组合，不从对话内容解析任何东西）。
- **闭环必须有预算**：执行↔验收超过 `maxRounds`（默认 3）自动升级人工介入并推送，附最后一份 findings。
- **交付由 daemon 确定性执行**：`git push` + `gh pr create` / `glab mr create` 是 daemon 的机械步骤，不指望 agent 记得做；PR 标题与正文由 agent 产出的 `pr.md` 提供。
- **分支约定**：任务分支统一 `happy/<user>/<task-slug>`，daemon 拒绝向 base 分支直推。
- **Team-Skills 注入**：任务级注入 + 记录 commit。首版挂载机器上统一 clone（任务开始时同步并记录 HEAD 供审计）；按 commit 严格钉住副本列为后续增强。C4 起 server 追踪 release tag 而非 main。
- **策略层写路径永远是 git + PR，merge 权在人**：curator 与一切系统侧迭代只产出 PR，不直接写入。这是防止「agent 写 lesson → lesson 改 skill → skill 约束 agent」复利病理的唯一闸门，与任务系统「agent 提议、server 裁决」是同一哲学在更高层的重复。
- **策略层组件化边界**：仓库 = 纯内容（契约化的 standards / 项目 skills / lessons / decision-log），机构 = 产品（schema 校验器、上下文预算 linter、写回 MCP、注入 adapter、curator 模板、初始化 scaffold）。团队仓库声明 `contractVersion`；server 分发前校验，不合格的 ref 拒绝下发。团队仓库里不放任何可执行代码。
- **切换是激进的一次性动作，不设双轨期**：上线前完成契约化改造与全量预演，上线日旧人工流程（link-project.sh 挂载、手动 git 同步）即刻废止。
- **task-control MCP 的实现形态**：一个 stdio 二进制（`happy task-mcp`），Claude Code 与 Codex 用同一实现，经 daemon 既有通道把意图转发给 server；按任务签发短期 token 鉴权。
- 新代码收敛原则延续 Team 版 §4：server 侧全部放 `packages/happy-server/sources/team/tasks/`，CLI 侧新增独立模块，单点注册。

---

## 2. 与 Cursor Cloud Agent 的对照（定位）

| Cursor Cloud Agent | Happy Team Tasks | 说明 |
|---|---|---|
| 每 agent 一台云端 VM，用完销毁 | 成员常驻机器 + 每任务一个 git worktree | 隔离单元换成 worktree；环境保真度问题随之消解（共享成员机器已有环境） |
| environment.json + VM 快照 | 不需要 | 机器常驻，无冷启动问题 |
| GitHub App 授权，平台代持仓库权限 | 成员机器上自己的 Git 凭据 | 权限边界 = 成员本人权限，无多租户安全面 |
| 单一 agent（Cursor 自家） | Claude Code + Codex 混合编排，逐阶段选 agent/模型 | 本方案独有 |
| 运行中追加消息、多端跟进、通知 | 复用 Happy 现有会话协议/推送 | 控制面零新增 |
| 接管：编辑器打开云端 VM | 网页终端进 worktree / 本地 checkout 分支 | 降级但够用 |
| 无人工卡点 | supervised 模式：plan 确认后才执行 | 本方案独有 |

一句话：Happy 已有完整控制面（会话、流式、审批、多端、通知），本计划只新增**编排层**（Task 状态机）+ **隔离层**（worktree）+ **交付层**（push/PR）+ **策略层**（Skills 组件，含自迭代）。

---

## 3. 现有基础（实现前先读源码确认）

- daemon 已有 `spawn-happy-session` RPC（`packages/happy-cli/src/api/apiMachine.ts`），支持 directory、agent（claude/codex）、environmentVariables、parentSessionId——阶段 spawn 直接用它。
- daemon RPC 注册机制（`RpcHandlerManager`）——新增 task 系列 RPC 照现有模式注册。
- 会话生命周期事件（进程退出）已上报 server——阶段完成判定的信号源之一。
- Team 版产物：Machine 归属、agent.env（公司 key / 个人 OAuth）、`happy enroll`、托管密钥、审计表。
- Team-Skills 仓库（策略层第一个实例与公开模板来源，见 §9.5 切换）：`SKILL.md + agents/openai.yaml` 双 agent 格式、`mcp/server.py`（get_skill / append_lesson / log_guardrail_event）、`scripts/link-project.sh` 挂载逻辑、goal-driven-execution-standard（GOAL.md + 每会话执行环 + 反假完成信号）、decision-log 的 durable/model-compensating 规则分类与退役流程。

---

## 4. 核心概念与总体架构

```
成员网页：选机器 → 选仓库路径 → 选模板(逐阶段 agent/model) → 写目标 → 选模式 → 发起
    │
    ▼
server  sources/team/tasks/          成员机器 daemon
  ├─ Task 状态机（脊柱）  ──RPC──►    ├─ task-prepare-worktree
  │    阶段推进/审批/轮次预算          │   fetch + worktree add -b happy/<user>/<slug>
  │                                    │   + Team-Skills 注入 + 机器本地配置重建
  ├─ 意图裁决（MCP 请求经             ├─ spawn-happy-session(directory=worktree,
  │   daemon 转发上来）               │        agent, model, env: TASK_ID/TASK_TOKEN)
  ├─ TaskTransition 审计               │     └─ 会话内 agent 可用 task-control MCP
  └─ 推送通知（复用现有）             ├─ task-deliver: push + gh/glab → prUrl
                                       └─ task-cleanup(keepWorktree)
    worktree 内交接介质（随分支提交）：
    .happy-task/plan.md  findings.md  pr.md
```

**Task** = { 仓库, base 分支, 工作分支, worktree, 模板, 模式, 当前阶段, 轮次, 关联 sessions, PR URL }。
**阶段（stage）** = 一次 agent 会话，参数（agent、模型、prompt 模板、期望产物）由模板定义。
**转移（transition）** = 模板中允许的阶段跳转边，每条边可标 `requiresApproval`。

---

## 5. 数据模型（Prisma 新增）

```prisma
enum TaskMode { SUPERVISED AUTONOMOUS }
enum TaskStatus { PENDING PREPARING RUNNING WAITING_APPROVAL SUCCEEDED FAILED ESCALATED CANCELLED }
enum StageRunStatus { RUNNING SUCCEEDED FAILED }

model TeamTask {
  id           String     @id @default(cuid())
  ownerUserId  String                // TeamUser.id
  machineId    String                // 目标机器
  templateId   String                // 内置模板 key（首版不入库）
  mode         TaskMode   @default(SUPERVISED)
  status       TaskStatus @default(PENDING)
  title        String
  goalPrompt   String                // 用户原始任务描述
  repoPath     String                // 成员机器上的仓库路径
  baseBranch   String
  workBranch   String                // happy/<user>/<slug>
  worktreePath String?
  currentStage String?
  round        Int        @default(0)
  maxRounds    Int        @default(3)
  skillsCommit String?               // 注入时 Team-Skills HEAD，审计用
  prUrl        String?
  error        String?
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
  finishedAt   DateTime?
}

model TeamTaskStageRun {
  id        String         @id @default(cuid())
  taskId    String
  stage     String                   // plan / execute / verify / deliver
  round     Int
  agent     String                   // claude | codex
  model     String?
  sessionId String?                  // 关联的 Session.id
  status    StageRunStatus @default(RUNNING)
  summary   String?                  // complete_stage 上报的摘要
  startedAt DateTime       @default(now())
  endedAt   DateTime?
}

// 自主模式行为的黑匣子，第一天就要有
model TeamTaskTransition {
  id          String   @id @default(cuid())
  taskId      String
  fromStage   String?
  toStage     String
  requestedBy String                 // agent:<sessionId> | system | user:<id>
  reason      String?
  decision    String                 // auto_approved | user_approved | rejected | escalated
  decidedBy   String?
  createdAt   DateTime @default(now())
}
```

原有 Session/Machine 及 Team 版各表**一律不改**。Task 的关键动作同时写 `TeamAuditLog`。

---

## 6. 内置模板与状态机

模板首版为服务端 TypeScript 常量（`sources/team/tasks/templates.ts`），结构：

```ts
interface TaskTemplate {
  id: string;
  stages: Record<string, {
    agent: 'claude' | 'codex';
    model?: string;                 // 发起时可覆盖
    promptTemplate: string;         // 注入 goalPrompt / plan.md / findings.md 路径
    expectedArtifacts: string[];    // 完成判定兜底，如 ['.happy-task/plan.md']
    permissionMode: 'plan' | 'auto';
  }>;
  transitions: { from: string | null; to: string; requiresApproval?: boolean;
                 condition?: 'verify_passed' | 'verify_failed_within_budget' }[];
}
```

### T1 仅执行 `execute-only`
```
(发起) ──► 执行 ──► 交付
```
### T2 规划→执行 `plan-execute`
```
(发起) ──► 规划 ──[supervised: 人工确认 plan.md]──► 执行 ──► 交付
```
### T3 闭环 `plan-execute-verify`
```
(发起) ──► 规划 ──► 执行 ──► 验收 ──┬─ 通过 ─────────► 交付
                     ▲              │
                     └─ findings.md ┘ 不通过 && round < maxRounds
                                      不通过 && round ≥ maxRounds ──► ESCALATED(人工)
```
### T4 策略层 curator `skills-curator`（C4 引入）
```
(定时发起) ──► 整编(聚合 lessons+遥测 → 修订 skills) ──► 验收(decision-log 纪律检查) ──► 交付(PR，人审合并)
```
仓库固定为 skills 仓库本身，详见 §9.3；结构上就是 T3 的特化，不需要新机制。

规则：
- **规划阶段**跑在只读/plan 权限模式，产物 `.happy-task/plan.md`（结构遵循 Team-Skills 的 goal-driven 标准：目标定义、红线、有序清单）。
- **执行阶段**全自动权限模式，prompt 注入 plan.md（返工轮注入 findings.md），要求逐项勾选并 commit（conventional commits，遵循下发的 SOP skill）。
- **验收阶段**拿到的是物化证据：plan.md 勾选状态、diff、项目验证命令的真实运行结果（Team-Skills validation.md 定义的最小充分门禁）。不通过则写 `findings.md` 并 `complete_stage(verdict: failed)`；server 递增 round。验收 skill 直接复用 Team-Skills 的反假完成信号清单。
- **交付阶段**不是 agent 会话，是 daemon 机械步骤（§8）。
- supervised 模式下 `requiresApproval` 边推送通知，成员在网页/手机查看渲染后的 plan.md，可改后批准；autonomous 模式全边自动放行。两种模式是同一状态机的参数差异。

server 状态机的输入信号：MCP 意图（经 daemon 转发）、会话退出事件、产物存在性检查（daemon 代查）、人工审批操作、超时（阶段级可配，默认 2h 无活动 → ESCALATED）。

---

## 7. task-control MCP

`happy task-mcp`（stdio，happy-cli 新子命令），spawn 会话时由 daemon 注册给两个 agent（Claude Code 走 SDK MCP 配置，Codex 写入会话级 config），环境变量携带 `HAPPY_TASK_ID` / `HAPPY_TASK_TOKEN`（server 按任务签发、阶段结束作废）。工具面刻意窄：

| 工具 | 参数 | 语义 |
|---|---|---|
| `get_task_context` | — | 返回任务目标、当前阶段、轮次、产物路径约定 |
| `complete_stage` | `summary`, `verdict?(passed/failed)` | 声明本阶段完成；verify 阶段必须带 verdict |
| `report_blocker` | `reason` | 上报阻塞，任务转 ESCALATED 并推送（对应 goal-driven 标准的 must-stop-and-ask 情形） |
| `request_transition` | `toStage`, `reason` | （C2 起）请求非默认转移，如"任务太简单请求跳过验收"；server 对照模板裁决 |

所有调用无条件写 `TeamTaskTransition`（含被拒绝的），这张表是调试自主模式的黑匣子。skills 写回 MCP（get_skill / append_lesson，C4 起由产品自带的 `happy skills-mcp` 提供，见 §9.4）与 task-control 并存，互不感知。

---

## 8. daemon 新增 RPC

| RPC | 行为 |
|---|---|
| `task-prepare-worktree` | `git fetch` → `git worktree add <path> -b happy/<user>/<slug> origin/<base>`；worktree 路径 `~/.happy/worktrees/<taskId>`；执行 Team-Skills 注入（§9）；重建机器本地配置（`.mcp.json`、`.claude/settings.json`、`.codex/config.toml` 不入库，新 worktree 没有——吸收 link-project.sh 的逻辑或直接调用它）；创建 `.happy-task/`；返回 worktreePath + skillsCommit |
| `task-deliver` | 校验当前分支为 `happy/` 前缀（否则拒绝）→ `git push -u origin <branch>` → 按 remote URL 探测 GitHub/GitLab → `gh pr create` / `glab mr create`（标题正文取 `.happy-task/pr.md`，缺失则用 plan.md 首段兜底）→ 返回 prUrl |
| `task-cleanup` | `keepWorktree=true`（默认，成员可随时 cd 进去接手）或删除 worktree；分支不动 |

阶段 spawn 复用现有 `spawn-happy-session`（directory=worktree，注入 task env 与 MCP 配置）。前置条件由 Team 版 provisioning 保证/补充：机器上 `gh`/`glab` 已安装并认证、Git 凭据可 push（provision 的 setup_agents 步骤扩展一项检测，缺失标 warning 并在任务发起时提示）。

---

## 9. 策略层：系统自有的 Skills 组件

定位：策略层是**团队无关的产品组件**——每个使用本系统的团队配置一个自己的 skills 仓库，仓库只含符合契约的内容；对机器可读、发布有版本纪律、由系统遥测驱动迭代、写路径保持 git + PR + 人审。可靠性闭环由此成立：**任务产生证据 → 证据修订策略 → 策略约束下一批任务**。组件边界见 §9.4；没有 skills 的团队从公开模板初始化（§9.5）。我们现有的 Team-Skills 仓库是第一个实例：其结构（standards / templates / projects / lessons / decision-log）被契约直接继承，契约化改造后成为第一个公开模板。

### 9.1 内容契约（C4，机器可读化改造）

- **产物 schema**：新增 standards 定义 `plan.md` / `findings.md` / `pr.md` 的结构化 frontmatter——plan 的条目清单与勾选状态、findings 的 verdict 与逐条定位、pr 的 title/body 字段。daemon 的完成判定从「文件存在」升级为「可解析且字段完备」，配合 §6 的三信号兜底，假完成的空间被结构卡死。
- **项目 skill 结构化字段**：`repo:`（remote URL pattern，供 `task-prepare-worktree` 自动匹配项目 skill，取代人工传项目名）；`validation:`（最小充分门禁 / 聚合门禁命令 + 超时预算）。验收阶段的门禁**由 daemon 执行、真实输出注入验收 agent**，不信任 agent 自己找命令、如实运行——这是「验收物化」从口号落成机制的关键一步。
- **角色级 skills**：standards 层新增规划者标准（plan.md 怎么写才能被执行者无歧义消费）、执行者标准（goal-driven 执行环的任务系统版）、验收者标准（反假完成清单 + findings 规范）。它们是三个内置模板阶段 prompt 的直接引用对象。
- **CI 门禁扩展**：validate.sh 增加 schema 校验与 **skill 上下文预算**（SKILL.md 行数上限，细节下沉 references 按需加载）。skills 进每个任务会话的上下文，膨胀就是全团队的 token 税，预算从第一天立规矩。

### 9.2 下发机制

1. server 登记 skills 仓库地址与追踪 ref（env：`TEAM_SKILLS_REPO`、`TEAM_SKILLS_REF`；C0–C3 用 `main`/commit 记录，C4 起追踪 release tag）。
2. daemon 维护机器统一 clone（`~/.happy/team-skills/`，provisioning 时预置）。`task-prepare-worktree` 时同步该 ref，记录 HEAD 到 `TeamTask.skillsCommit`。
3. 注入 = 在 worktree 内执行挂载：Claude Code 侧 `.claude/skills/` 符号链接 + SessionStart 注入 hook；Codex 侧 `.agents/skills/` 链接 + `AGENTS.md` 块（吸收 link-project.sh 逻辑，集中在 daemon 一处 adapter）。按 `repo:` 字段匹配项目 skill；无匹配时只挂 standards 通用层，并自动建议发起一个「初始化项目 skill」任务（复用现有 New Project Initialization prompt 作为该任务的 goalPrompt）。
4. 模板阶段 prompt 只写「做什么」，「怎么做」引用下发的 skills。SOP 演进走 skills 仓库 review，任务系统零改动。
5. `append_lesson` 写回环保留：任务会话内 agent 照常经 skills MCP 记 lesson（append-only inbox，auto commit+push 用成员机器 Git 凭据）。ESCALATED 案例是 lesson 的重点素材来源。

### 9.3 自迭代机制：curator（C4）

现有学习环是项目级、人肉驱动、输入只有 lessons。系统侧迭代改变三件事——输入变厚、驱动变自动、发布变可灰度：

- **遥测聚合**：server 基于 `TeamTaskTransition`、StageRun 数据做报表——每项目/每模板的验收拦截率、返工轮次分布、ESCALATED 案例全文、findings 聚合、guardrail 触发统计。回答两个问题：哪些规则从未触发（退役候选）、哪个项目升级率异常（SOP 缺口）。
- **curator 定期任务（内置模板 T4）**：跑在任务系统自身上——仓库 = skills 仓库，输入 = pending lessons + 遥测报表，产出 = **一个 PR**：合并重复 lesson、按晋升标准提升跨项目规则、凭遥测证据提议退役 model-compensating 规则、每条变更附 decision-log 条目（其验收阶段专门检查这条纪律）。即现有 Lesson Consolidation prompt 的任务化 + 数据增强，吃自己的狗粮。
- **红线（既定决策）**：curator 只出 PR，merge 权在人。成本是每周期 review 一个 PR，收益是自我改进环不跑飞的唯一保证。
- **灰度发布**：新 tag 先对指定项目的任务生效，观测轮次/升级率指标无恶化再全量；回滚 = 改 ref。这是系统下发相对手动 git pull 最实质的增益。
- **规则退役的证据标准**：durable / model-compensating 分类照旧（decision-log 既有机制），退役依据从「感觉新模型不需要了」变成「该检查项 N 个周期拦截率为零」。

### 9.4 组件化边界：仓库只有内容，机构全在产品

| 归属 | 内容 |
|---|---|
| **团队 skills 仓库**（纯内容） | standards、角色级 skills、项目 skills（含 `repo:`/`validation:` 字段）、lessons、decision-log、`skills.yaml`（声明 `contractVersion`、项目映射等仓库级元数据） |
| **产品**（happy-cli / happy-server，随版本发布） | 契约 schema 定义与校验器、上下文预算 linter、写回 MCP（`happy skills-mcp`，吸收现 Team-Skills 的 `mcp/server.py`，团队仓库不再自带任何可执行代码）、worktree 注入 adapter、curator 任务模板（T4）、初始化 scaffold |

- **分发前校验在 server 侧**：server 追踪团队仓库 ref 时先跑契约校验，不合格的 ref 拒绝下发并通知管理员——质量门禁由产品保证，不依赖各团队自己维护 CI（团队仓库可以另配 CI 提前发现，但那是锦上添花）。
- **契约演进**：contract schema 随产品版本演进，`contractVersion` 不匹配时产品提供迁移工具/迁移任务；对旧版本保持至少一个大版本的兼容窗口。

### 9.5 初始化与切换

**新团队（从零开始）**：管理后台配置 skills 仓库地址 → server 检测为空仓库 → 引导从公开模板初始化（scaffold 生成初始 commit：standards 骨架、角色级 skills、产物 schema、decision-log 种子、skills.yaml）→ 各项目的 skill 由「初始化项目 skill」任务逐个生成（§9.2 的自动建议）→ curator 周期启动，团队的策略层从第一天就在遥测驱动下迭代。**模板 = 一个符合契约的公开 skills 仓库**，我们的 Team-Skills 契约化改造后（剥离公司内部项目层，保留 standards 与角色级 skills）即为第一个公开模板。

**我们自己的切换（一次性，不设双轨）**：
1. 上线前：对现有 Team-Skills 仓库执行契约化改造（补齐 §9.1 字段、迁入 skills.yaml、移除 mcp/server.py 与 scripts 等可执行部分——由产品接管），保留 git 历史与 decision-log；这本身作为一次性任务在任务系统上执行并预演。
2. 切换检查清单（全部满足才切）：全部在管项目 skill 契约字段补齐且 server 校验通过；至少一个真实任务在改造后的 skills 上端到端跑通（含 append_lesson 写回）；成员机器 daemon 全部升级到含注入 adapter 的版本。
3. 上线日：server 指向新 ref，旧人工流程（link-project.sh 挂载、手动 clone 同步、手动 Lesson Consolidation）即刻废止；`main` 分支保护 + 只经 PR 写入。不保留回退到人工流程的路径——回滚手段是 ref 回退，不是流程回退。

---

## 10. 服务端 API 与前端

### 10.1 API（前缀 `/v1/team/tasks`，鉴权同 Team 版）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/` | 发起任务 `{machineId, repoPath, templateId, stageOverrides?(逐阶段 model), mode, title, goalPrompt, baseBranch}` |
| GET | `/` `/:id` | 任务列表（自己的）/ 详情（含 stageRuns、transitions、prUrl） |
| POST | `/:id/approve` | supervised 卡点批准（body 可带修改后的 plan.md 内容，server 经 daemon 写回再放行） |
| POST | `/:id/reject` | 拒绝并终止 / 要求重新规划 |
| POST | `/:id/cancel` | 取消任务（终止活动会话，worktree 保留） |
| GET | `/templates` | 模板列表及各阶段默认 agent/model |
| POST（内部） | `/:id/intent` | daemon 转发 MCP 意图（task token 鉴权） |

管理员经现有 admin 前缀可查全团队任务与 Transition 审计。

### 10.2 前端（happy-app，Web 优先）
1. **任务发起页**：机器 → 仓库路径（daemon 提供最近会话目录候选）→ 模板卡片（三选一，展开逐阶段改 agent/model）→ 目标描述 → 模式开关。
2. **任务看板**：进行中/已完成两栏；卡片显示阶段进度条、轮次、当前会话入口（点进去就是现有会话 UI，可追加消息）、PR 链接、ESCALATED 高亮。
3. **Plan 审批卡**：渲染 plan.md，批准 / 编辑后批准 / 打回重规划；推送通知直达。
4. 会话视图零改动（任务的每个阶段就是一条普通 session，天然可跟进可介入）。

---

## 11. 里程碑与验收（按序执行）

### C0 任务骨架 + 仅执行模板
- 产出：TeamTask/StageRun/Transition 迁移；daemon 三个 RPC；T1 模板；状态机最小实现（prepare → execute → deliver）；发起页 + 看板；推送通知接入。
- 验收：网页对一台 Team 版机器上的真实仓库发起 T1 任务 → worktree 内会话自动跑完 → 分支推送、PR 自动创建、看板出现链接；同机并行两个任务互不干扰；向 base 分支直推被 daemon 拒绝；全程手机可跟进并追加消息。

### C1 多阶段 + task-control MCP + supervised
- 产出：`happy task-mcp` 与 token 签发；complete_stage / report_blocker / get_task_context；T2 模板；plan 审批卡全流程；阶段完成三信号兜底；阶段超时。
- 验收：T2 任务规划阶段（Claude Code, plan 模式）产出 plan.md → 手机收到通知、编辑后批准 → 执行阶段（Codex）按 plan 实施并交付；agent 忘调 complete_stage 时产物兜底判定仍推进；report_blocker 正确转 ESCALATED。

### C2 闭环 + autonomous
- 产出：T3 模板；验收阶段（含物化证据注入）；findings.md 返工回路；round/maxRounds；request_transition 裁决；autonomous 模式；Transition 黑匣子查询页。
- 验收：一个中等任务在 autonomous 模式下完整走完 规划→执行→验收→（至少一轮返工）→交付，全程零人工；一个构造的必失败任务在 3 轮后 ESCALATED 并推送 findings；所有 agent 意图（含被拒）可在审计页回放。

### C3 Skills 下发 + 双平台收尾
- 产出：skills 注入进 prepare 流程（含 skillsCommit 记录）；provisioning 扩展（gh/glab/skills clone 检测）；GitLab（glab）全流程真实验证；模板阶段 prompt 全面改为引用 skills；（可选）模板 DB 化 + 管理后台编辑入口。
- 验收：新 provision 的干净机器直接可跑任务；同一任务在 GitHub 项目与自建 GitLab 项目各完整交付一次；任务详情能显示当次 skillsCommit；skills 仓库改一条 SOP 后，新任务立即生效且旧任务审计可区分版本；任务会话内 append_lesson 写回成功。

### C4 策略层组件化与自迭代
- 产出：§9.1 内容契约全套（产物 schema + 完成判定升级、项目 skill `repo:`/`validation:` 字段、验收门禁改由 daemon 执行并注入输出、角色级 skills）；§9.4 组件化（契约校验器 + 上下文预算 linter + server 分发前校验、`happy skills-mcp` 写回、初始化 scaffold、skills.yaml/contractVersion）；发布 tag 化 + 灰度 ref 分级；遥测聚合报表；T4 curator 模板 + 定期调度；未匹配项目自动生成「初始化项目 skill」任务建议；Team-Skills 契约化改造与一次性切换（§9.5）；公开模板发布。
- 验收：一个 T3 任务的验收门禁由 daemon 执行、输出出现在验收会话上下文中；产物 frontmatter 缺字段时完成判定正确拒绝推进；故意破坏契约的 ref 被 server 拒绝下发并通知管理员；一次 curator 周期端到端走通（遥测报表 → PR → 人审合并 → 新 tag 对单项目灰度 → 全量）；至少一条 model-compensating 规则凭「N 周期零拦截」证据完成退役且有 decision-log 条目；**一个全新团队从空仓库经模板初始化后完整跑通一个任务**（组件化的最终证明）；我们自己完成 §9.5 切换检查清单并一次性切换，旧人工流程废止。

### 通用要求
沿用 Team 版：服务端逻辑带 Vitest（真实调用不 mock；状态机可对内存 Prisma + 假 daemon 桩测转移逻辑，Git 操作对本地裸仓库测）；每里程碑以真实浏览器 + 真实机器端到端手工验证为完成标准；改动收敛原则作为 review 检查项。

---

## 12. 风险与应对

| 风险 | 应对 |
|---|---|
| 自主闭环无限乒乓 / 烧 token | round 预算 + 阶段超时 + ESCALATED 升级；Transition 黑匣子定位行为问题 |
| agent 不调 / 错调 MCP 工具 | 三信号兜底（意图+退出+产物）；工具面极窄；用法写进下发的 skill |
| 验收阶段"感觉式"放行 | 验收输入物化（勾选状态/diff/真实门禁输出）；复用 Team-Skills 反假完成信号清单 |
| worktree 与项目工具链不兼容（重 node_modules、生成物） | worktree 内首次 install 由执行阶段 agent 按 SOP 自理；后续可加模板级 setup 命令 |
| full-auto agent 损坏成员环境 | 爆炸半径限制在 worktree；分支前缀强制 + 禁推 base；机器本就归成员个人 |
| gh/glab 未认证 / Git 无 push 权限 | provisioning 检测标 warning；任务发起时预检并明确提示，不让任务跑到交付才失败 |
| 两家 agent 的 MCP/skills 注入形态漂移 | 注入逻辑集中在 daemon 一处 adapter；升级 agent 版本时只改这一处 |
| 模板固化不够用 | 模板结构从第一天就是数据（TS 常量 → DB 一步之遥）；「多人协作评审」等新模板 = 新模板定义 + 新 skills，系统本体不动 |
| 自迭代闭环复利错误（SOP 膨胀、对单次事故过拟合、把模型怪癖固化成规则） | curator 只出 PR、人审合并（既定决策红线）；durable/model-compensating 分类与晋升标准照旧；灰度期观测轮次/升级率指标，恶化即回滚 |
| skills 上下文膨胀成全团队 token 税 | 产品侧上下文预算 linter + 分发前校验；细节下沉 references 按需加载；curator 周期职责包含瘦身与退役 |
| 一次性切换失败无退路 | 切换检查清单（§9.5）全绿才切；回滚手段是 ref 回退而非流程回退；切换改造本身先在任务系统上预演 |
| 契约演进破坏存量团队仓库 | contractVersion 声明 + 至少一个大版本兼容窗口 + 产品提供迁移工具/迁移任务 |
| 其他团队误把可执行代码放进 skills 仓库 | 契约校验器拒绝（仓库纯内容是硬性契约）；机构全部产品化后仓库本就无处放代码 |
