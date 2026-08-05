# Cloud Agent Tasks — GOAL 执行指令

> 会话启动方式：`在 happy-team 仓库 cloud-agent 分支上，按照 docs/plans/cloud-agent-tasks-goal.md 执行`。
> 本文件是执行指令（怎么干活）；蓝图与验收标准见 [cloud-agent-tasks.md](cloud-agent-tasks.md)（做什么，权威文档）；
> 进度唯一事实源见 [cloud-agent-tasks-progress.md](cloud-agent-tasks-progress.md)。

## 终态定义

[cloud-agent-tasks.md](cloud-agent-tasks.md) 的 C0–C4 全部里程碑按其验收标准完成：
成员在网页一句话发起任务 → 自己机器上的 worktree 内多 Agent（Claude Code / Codex）按模板编排执行 →
产出分支 + PR/MR（GitHub/GitLab 双模式）→ supervised/autonomous 双模式 → 策略层（Skills 组件）组件化并自迭代。

## 每会话执行环

1. 读 [cloud-agent-tasks-progress.md](cloud-agent-tasks-progress.md)，取**严格顺序下第一个未完成项**，不跳项。
2. 读 [cloud-agent-tasks.md](cloud-agent-tasks.md) 中该项对应章节；计划 §3 列出的"实现前先读源码确认"锚点，动手前必须实际读到对应源码。
3. 读所在包的 CLAUDE.md / AGENTS.md，遵守包内代码规范（严格类型、`@/` 别名、Vitest 真实调用不 mock 等）。
4. 代码与测试同一变更完成；用最小充分门禁验证（该包的 typecheck + 相关 vitest），完成声明前跑过。
5. 同一变更内更新进度文档：勾选项 + 决策记录表新增行（如有决策）。未记录的设计偏离视为缺陷。
6. Conventional commits 提交到 `cloud-agent` 分支。
7. 会话结束报告：所选项、变更文件、验证命令与结果、新决策、剩余风险、下一项。

## 红线（违反即缺陷）

- **既定决策不重新讨论**：计划 §1.3 全部条目（状态机脊柱/MCP 神经、文件交接介质、daemon 确定性交付、轮次预算、组件化边界、一次性切换等）。
- **改动收敛**：server 新代码全部在 `packages/happy-server/sources/team/tasks/`，main.ts 单点注册；CLI 新代码独立模块 + 入口单点注册；原有 Account/Machine/Session 及 Team 版各表**一律不改**。
- **不合并回 main**：全部工作停留在 `cloud-agent` 分支，合并由业主决定。
- **反假完成**（对照 Team-Skills goal-driven 标准的 anti-signals）：占位文件、mock 冒充真实集成、放宽断言、上一里程碑未关闭就开下一个，均视为未完成。里程碑的端到端验收需要真实浏览器 + 真实机器，agent 会话内无法完成的部分在进度文档标记 `待人工验收` 并列出操作步骤，**不得自行声明里程碑关闭**。
- 单元/集成测试中不得使用真实外部凭据或产生付费调用。

## 决策授权

- 开放式设计与实现细节：自主决定，记入进度文档决策表，继续执行。
- 依赖选型：优先复用 monorepo 已有方案；新增依赖记录理由。
- 文档冲突：cloud-agent-tasks.md 为权威；其自相矛盾时取更严格读法并记录。
- 必须停下询问：真实外部凭据/付费资源、破坏性操作、以及发现计划目标不可行。

## 上下文锚点

- 前置事实：Team 版 M0–M3 已完成并经业主验收（相关模块在 `sources/team/`，复用其 auth/审计/加密手法）。
- 外部仓库：Team-Skills 位于 `/home/dev/Documents/Team-Skills`（C3/C4 涉及；其契约化改造属 C4，先读后动）。
- 计划文档同目录的 [team-edition.md](team-edition.md) 是架构背景。
