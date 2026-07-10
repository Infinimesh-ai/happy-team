# Cloud Agent Tasks — 执行进度（单一事实源）

> 状态：未开工（脚手架就绪）。分支：`cloud-agent`。
> 规则：严格按序取第一个未完成项；勾选与决策记录随实现同一变更提交；
> `⏸ 待人工验收` 表示 agent 已完成可自动化部分、剩余步骤已列出等业主执行。
> C0 已细化到可实现粒度；C1–C4 为里程碑级条目，**到达时由当次会话按计划文档细化为同等粒度再动工**（细化本身作为该里程碑第一项）。

## C0 任务骨架 + 仅执行模板

- [x] C0.1 Prisma 迁移：`TeamTask` / `TeamTaskStageRun` / `TeamTaskTransition`（计划 §5；原有表零改动）
- [ ] C0.2 模板定义结构 `TaskTemplate` + T1 `execute-only`（`sources/team/tasks/templates.ts`，计划 §6）
- [ ] C0.3 daemon RPC `task-prepare-worktree`：fetch → worktree add -b `happy/<user>/<slug>` → `.happy-task/` 创建（计划 §8；Skills 注入留到 C3，本项只留挂载点）
- [ ] C0.4 daemon RPC `task-deliver`（分支前缀校验、push、remote 探测、`gh pr create` / `glab mr create`、pr.md 兜底）与 `task-cleanup`（默认保留 worktree）
- [ ] C0.5 server 状态机最小实现（PENDING→PREPARING→RUNNING→SUCCEEDED/FAILED/CANCELLED）+ 完成判定（会话退出 + 产物存在）+ 阶段超时
- [ ] C0.6 任务 API：POST/GET `/v1/team/tasks`、`/:id`、`/:id/cancel`、GET `/templates`（计划 §10.1；鉴权/审计沿用 Team 版模式）
- [ ] C0.7 阶段 spawn 接线：状态机经既有 `spawn-happy-session` 在 worktree 内起会话（directory/agent/env 注入 `HAPPY_TASK_ID`）
- [ ] C0.8 推送通知：阶段推进 / 失败 / 交付完成（复用现有通知通道）
- [ ] C0.9 前端：任务发起页 + 任务看板（计划 §10.2 第 1、2 项；审批卡留 C1）
- [ ] C0.10 服务端/CLI 测试补齐（状态机转移、worktree 与交付对本地裸仓库测）
- [ ] C0.11 ⏸ C0 端到端人工验收（计划 §11 C0 验收清单：真实机器、并行两任务、直推 base 被拒、手机跟进）

## C1 多阶段 + task-control MCP + supervised

- [ ] C1.0 细化本里程碑条目（对照计划 §6 §7 §10，粒度对齐 C0）
- [ ] C1.x `happy task-mcp`（complete_stage / report_blocker / get_task_context）+ 任务 token 签发与作废
- [ ] C1.x T2 模板 + plan 权限模式 + plan 审批卡全流程（approve/reject API + 通知直达）
- [ ] C1.x 三信号完成兜底 + `TeamTaskTransition` 全量落写
- [ ] C1.x ⏸ C1 端到端人工验收（计划 §11 C1 清单）

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
