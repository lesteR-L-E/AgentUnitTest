# 项目规范-入口文件

此文件是项目规范的入口。对当前项目的阅读、修改等，应先阅读此文件，再按需展开相关 spec 文件。

## 项目概述

### 基本信息

- 项目名称：AgentUnitTest（v2）
- 项目形态：Monorepo（npm workspaces），VSCode 插件 + Node 后端 + 共享契约层
- 语言：TypeScript（ESM）
- 运行时基线：Node ≥ 20（插件端复用 VSCode 内置 Node，用户零环境安装）
- Agent 框架：Vercel AI SDK（`streamText + tools + stopWhen` 即工具循环；锁大版本，v7 API）
- 契约层：zod schema（WS 协议 v2 + IR 数据模型 + 9 工具接口的单一事实源）

### 里程碑状态

- [x] M0 选型定案：全面 TypeScript + Vercel AI SDK
- [x] M1 地基 MVP：脚手架 / zod 契约 / llm 工厂 / runtime 骨架 / 9 桩工具 / 会话 JSON 落盘 / 六套冒烟 / 演示插件（收尾中）
- [ ] M2 并行填充：各负责人把桩工具替换为真实现（AST 解析 / 环境探测 / 沙箱执行…），正式 UI
- [ ] M3 跨平台强化 + CI 三平台矩阵全绿
- [ ] M4 端到端联调（验收场景 1~11）
- [ ] M5 验收与文档定稿

### Monorepo 结构

```
AgentUnitTest/
├── agent.md                # 引导层：Agent 工作主入口（身份/思考流程/硬约束）
├── spec/                   # 规范层（本目录）：入口 / 代码风格 / 跨平台 / 子包 spec
├── docs/                   # 项目文档-v2（目标设计·唯一事实源）· 重构讨论稿 · 优化点汇总
├── contracts/              # @agent-unittest/contracts：zod 契约（协议 v2 + IR + 9 工具接口）
├── agent-server/           # Agent 后端：runtime（Agent Loop/会话）+ llm 工厂 + 9 桩工具 + 冒烟
│   └── data/sessions/      # 会话 JSON 落盘（git-ignored，绝不入库）
├── extension/              # VSCode 插件（对话式侧边栏 UI + 后端进程管理 + WS 客户端）
└── .github/workflows/      # CI（ubuntu + macos + windows 三平台矩阵）
```

### 包依赖关系

```
extension ──WS(协议v2)──▶ agent-server ──▶ @agent-unittest/contracts ◀── extension(仅 import type)
```

- `contracts` 不依赖任何兄弟包，是最底层；
- `agent-server` 运行时校验 + 类型都来自 contracts；
- `extension` 现阶段只从 contracts `import type`（插件切 ESM 前不引运行时值，见项目文档 §7）。

## 子包一览与 spec 阅读规则（硬约束）

> **开始任何涉及具体子包的工作前，必须先阅读该子包的详细 spec。任务涉及多个子包时，读全部相关子包的 spec。这不是建议而是硬约束。**

| 子包 | 位置 | 一句话定位 | 详细 spec |
|------|------|-----------|-----------|
| contracts | `contracts/` | 契约层单一事实源：协议 v2 + IR + 9 工具接口（zod） | [packages/contracts.md](packages/contracts.md) |
| agent-server | `agent-server/` | Agent 后端：WS 服务、Agent Loop、会话管理、模型工厂、9 桩工具 | [packages/agent-server.md](packages/agent-server.md) |
| extension | `extension/` | VSCode 插件：对话式侧边栏、后端进程生命周期、WS 客户端 | [packages/extension.md](packages/extension.md) |

配套规范（同样先读再用）：

- 代码风格与注释规范：[code-style.md](code-style.md)
- macOS/Windows 双平台互通规范：[cross-platform.md](cross-platform.md)

## Git 提交信息规范

基于 Conventional Commits，`type`/`scope` 用英文、描述用中文、结尾不加句号：

```
<type>(<scope>): <中文标题——可带破折号补充说明>

- 变更点 1（功能/需求视角）
    - 相关文件路径
```

- type：`feat` / `fix` / `refactor` / `docs` / `style` / `test` / `chore` / `ci` / `perf`
- scope 惯例：`contracts` / `server` / `runtime` / `session` / `extension` / `smoke` / 根级杂项可省略
- 跨多个包时省略 scope，在 body 说明涉及的包

## 调试经验

1. **改了 `src/` 行为不变？先查产物目录是否更新。** agent-server 由插件拉起的是 `dist/server.js`，contracts 被消费方引用的是 `out/`——改源码后必须 `npm run build` 才生效（根目录 build 会按 contracts → agent-server → extension 顺序自动构建）。快速检查：看 `agent-server/dist/`、`contracts/out/` 的文件时间戳。
2. **`.env` 空字符串会让 AI SDK 在 import 期抛错。** `OPENAI_BASE_URL=`（等号后为空）注入的是空字符串而非"未设置"，AI SDK 视为非法值。`agent-server/src/env.ts` 负责清洗并必须保持为入口文件第一个 import——新增入口（冒烟脚本等）时照做。
3. **AI SDK v7 弃用 API 注意**：用 `result.stream`（不是 fullStream）、`result.responseMessages`（不是 response.messages）、`result.usage`（不是 totalUsage）。升级 SDK 版本时先全局检查这三处。
4. **会话相关改动重启后"丢失"？** 会话按 sessionId 存 `agent-server/data/sessions/*.json`（不入库）；内存缓存 30 分钟逐出但文件保留。排查续聊问题先看文件是否存在、`version`/`sessionId` 是否匹配（不匹配按不存在处理）。
5. **webview 整个没反应（按钮/对话/ready 全失效）？** 内联 JS 一行语法错误会废掉整个脚本。`buildHtml` 是 TS 模板字符串：`${...}` 会被插值、反斜杠转义（如 `\n`）会被 TS 先解释成真实换行——断在 webview JS 字符串里就是语法错误。**`npm run build` 查不出这类问题**（tsc 只看 TS 源码），需对产物做运行时验证：取出 `out/sidebarProvider.js` 的模板串 eval 后，用 `new Function(<script>内容)` 做语法检查。
