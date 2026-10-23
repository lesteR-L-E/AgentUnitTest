# AgentUnitTest (v2)

VSCode 中的 **Java 单元测试生成垂直对话 Agent**：选中代码 → Agent 自动分析、生成、运行、诊断测试 → 全程可多轮对话（生成前提要求、结果追问、对话迭代测试）。

> 本仓库是 v2 重构版（全面 TypeScript，Agent 运行时基于 [Vercel AI SDK](https://ai-sdk.dev/)）。
> 旧 Python 版本仓库：[SYSUSELab/AgentUnitTest-backend](https://github.com/SYSUSELab/AgentUnitTest-backend) —— 作为**行为参照基线**保留（TS 工具重写时对照其输出），地基 MVP 跑顺后将归档只读。

## 仓库结构

```
AgentUnitTest/
├── agent.md            # ★ Agent 工作入口（身份/思考流程/开发硬约束）；AGENTS.md、CLAUDE.md 为其软链接
├── spec/               # ★ 规范层：入口 readme · 代码风格与注释 · mac/win 双平台 · 各子包 spec
├── docs/               # 项目文档-v2（目标设计·唯一事实源）· 重构讨论稿（决议）· 优化点汇总
├── contracts/          # 契约层（单一事实源）：WS 协议 v2 + IR 模型 + 9 工具接口（zod）
├── agent-server/       # Agent 后端（Node ≥20）：runtime（Agent Loop/会话）· llm 工厂 · 9 桩工具 · WS 服务
├── extension/          # VSCode 插件（对话式侧边栏：消息流 · 双重确认按钮 · 对话列表）
└── .github/workflows/  # CI（ubuntu + macos + windows 三平台矩阵）
```

## 快速开始

前置：Node ≥ 20（`node -v` 检查）

```bash
npm install                        # 安装全部 workspace 依赖

# Agent Server（/health 健康检查 + WS 协议 v2 服务端）
npm run dev                        # http://127.0.0.1:8765/health

# LLM 冒烟：验证 AI SDK 打通模型
cp agent-server/.env.example agent-server/.env   # 填入任一 provider 的 key
npm run smoke:llm

# 其余冒烟：contracts/ws/confirm/store 零 token 消耗；agent 为全链路（真实 LLM + 桩工具）
npm run smoke:contracts && npm run smoke:ws && npm run smoke:confirm && npm run smoke:store
npm run smoke:agent

# 插件演示（M1 演示版已交付）：
#   1. VSCode 打开本仓库，按 F5（自动编译三个包并启动「扩展开发宿主」新窗口）
#   2. 新窗口中：文件 → 打开文件夹 → 选择任意 Java 项目（含 pom.xml/build.gradle）
#   3. 点击活动栏的 AgentUnitTest 图标打开侧边栏（后端进程自动启动）
#   4. 选中一段 Java 代码 → 点「生成测试(选中)」或右键 → Generate Unit Tests
#   5. 在输入框和 Agent 对话；「新建对话」/「对话列表」切换会话，对话存于
#      agent-server/data/sessions/（重启可续聊）
#   6. 演示失败全流程：在生成约束里带「失败」二字 → 桩工具注入故意失败用例 →
#      诊断 → 断言修改双重确认（侧边栏 同意/拒绝 按钮）→ 修复 → 重跑
```

## 文档与规范

- [agent.md](agent.md) —— Agent 工作入口：思考流程 + 开发硬约束
- [spec/readme.md](spec/readme.md) —— 项目规范入口：结构 / 子包一览 / 提交规范 / 调试经验
- [spec/code-style.md](spec/code-style.md) · [spec/cross-platform.md](spec/cross-platform.md) —— 代码风格与注释规范 · macOS/Windows 双平台互通规范
- [docs/项目文档-v2.md](docs/项目文档-v2.md) —— 目标设计（架构 / 协议 / 规范 / 里程碑）
- [docs/重构讨论稿.md](docs/重构讨论稿.md) —— 选型会与两轮补充决议记录
- [docs/优化点汇总.md](docs/优化点汇总.md) —— v1 问题清单与改动依据（含代码证据）

## 里程碑状态（详见项目文档 §9）

- [x] M0 选型：A1 全面 TypeScript + Vercel AI SDK（2026-10-17）
- [x] **M1 地基 MVP（2026-10-23 完成）**：脚手架 → zod 契约（初稿，评审后冻结）→ llm/ 工厂 → runtime 骨架（Agent Loop + §3.7 双重确认硬校验）→ 9 桩工具 → 会话 JSON 落盘（重启续聊 / 对话列表）→ chat 默认模型自动探测 → 六套冒烟全绿 → M1 演示插件
- [ ] **M2 并行填充（当前阶段）**：全员把桩工具替换为真实现（AST 解析 / 环境探测 / 沙箱执行 / LLM 生成与修复）+ 正式对话式 UI
- [ ] M3 跨平台强化 + CI 三平台矩阵全绿
- [ ] M4 端到端联调（验收场景 1~11）
- [ ] M5 验收与文档定稿
