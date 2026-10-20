# AgentUnitTest (v2)

VSCode 中的 **Java 单元测试生成垂直对话 Agent**：选中代码 → Agent 自动分析、生成、运行、诊断测试 → 全程可多轮对话（生成前提要求、结果追问、对话迭代测试）。

> 本仓库是 v2 重构版（全面 TypeScript，Agent 运行时基于 [Vercel AI SDK](https://ai-sdk.dev/)）。
> 旧 Python 版本仓库：[SYSUSELab/AgentUnitTest-backend](https://github.com/SYSUSELab/AgentUnitTest-backend) —— 作为**行为参照基线**保留（TS 工具重写时对照其输出），地基 MVP 跑顺后将归档只读。

## 仓库结构

```
AgentUnitTest/
├── docs/               # 项目文档-v2（目标设计·唯一事实源）· 重构讨论稿（决议）· 优化点汇总
├── contracts/          # ★ 契约层（单一事实源）：WS 协议 v2 + IR 模型 + 9 工具接口（zod）
├── agent-server/       # Agent 后端（Node ≥20）：runtime / llm 工厂 / tools / WS 服务
├── extension/          # VSCode 插件（对话式侧边栏 UI）
└── .github/workflows/  # CI（ubuntu + macos + windows 三平台矩阵）
```

## 快速开始

前置：Node ≥ 20（`node -v` 检查）

```bash
npm install                        # 安装全部 workspace 依赖

# 后端占位服务（health + WS echo，协议 v2 在 M1 实现）
npm run dev                        # http://127.0.0.1:8765/health

# LLM 冒烟：验证 AI SDK 打通模型
cp agent-server/.env.example agent-server/.env   # 填入任一 provider 的 key
npm run smoke:llm

# 插件脚手架：VSCode 打开本仓库，F5 启动扩展开发宿主，
# 命令面板执行「AgentUnitTest: Hello (scaffold)」
```

## 文档

- [docs/项目文档-v2.md](docs/项目文档-v2.md) —— 目标设计（架构 / 协议 / 规范 / 里程碑）
- [docs/重构讨论稿.md](docs/重构讨论稿.md) —— 选型会与两轮补充决议记录
- [docs/优化点汇总.md](docs/优化点汇总.md) —— v1 问题清单与改动依据（含代码证据）

## 里程碑状态（详见项目文档 §9）

- [x] M0 选型：A1 全面 TypeScript + Vercel AI SDK（2026-10-17）
- [ ] **M1 地基 MVP（进行中）**：脚手架 ✅ → zod 契约 ✅（初稿待评审）→ llm/ 工厂 → runtime 骨架 → 9 桩工具 → WS 冒烟 → 最简陋演示插件
- [ ] M2 并行填充（全员替换桩工具 + 正式 UI）
- [ ] M3 跨平台强化 + CI 矩阵全绿
- [ ] M4 端到端联调（验收场景 1~11）
- [ ] M5 验收与文档定稿
