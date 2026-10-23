# contracts — 契约层（单一事实源）

> 开始任何涉及 contracts 的工作前，先读本文与 `contracts/README.md`。

## 定位

`@agent-unittest/contracts` 是全团队的"法律文件"：**WS 协议 v2 消息、IR 数据模型、9 个工具接口**全部在此定义。agent-server 与 extension 都从这里导入 schema 和类型，任何一侧不得私自定义。zod schema 同时是 AI SDK tool 定义的输入（LLM 看到的参数 JSON Schema 直接由它生成）。

## 目录结构

```
src/
├── ir/         # IR 数据模型：CodeAnalysis · EnvironmentContext · TestResult
│               #   · Diagnosis · GeneratedTest · SessionState · SourceLocation
├── protocol/   # WS 协议 v2：ClientMessage / ServerMessage（discriminated union，按 type 判别）
└── tools/      # 9 个工具的输入/输出 schema + TOOL_CONTRACTS 注册表 + 统一返回信封 envelope
```

## 三条铁律

1. **命名**：字段一律 camelCase（v1 Python 模型是 snake_case，语义一一对应，各文件注释有映射说明）。
2. **冻结流程**：M1 评审通过后契约即冻结——改任何字段必须全员知悉同意（PR 里 @所有人），禁止悄悄改。客户端消息 `.strict()`：未知字段直接校验失败，尽早暴露前后端不同步。
3. **构建产物**：消费方引用的是 `out/` 产物，改完必须 `npm run build -w @agent-unittest/contracts`（根目录 `npm run build` 会按 contracts → agent-server → extension 顺序自动构建）。

## 关键设计（改契约前必知）

- **工具返回信封**（`tools/envelope.ts`）：所有工具输出统一 `{ok:true,data}` | `{ok:false,error,retryable}` 判别联合；工具异常必须转结构化错误交给 Agent Loop，不允许抛异常炸会话。
- **TOOL_CONTRACTS 注册表**（`tools/definitions.ts`）：runtime 遍历它生成 AI SDK tools；新增/修改工具必须同时更新注册表与 `ToolName` 枚举，CI 校验「注册表键 = 枚举」。
- **repair_tests 的护栏字段**：`assertionLevelChange=true` 时必须携带 `confirmations`（两步确认的服务端事件 ID），缺失由 runtime 硬校验拒绝——这是 §3.7 双重确认的第二道防线，字段语义不得弱化。
- **`.describe()` 写给 LLM 看**：schema 字段的 describe 会直接进入 LLM 的工具说明书，务必清晰写明语义、默认值与安全约束（详见 `spec/code-style.md`「两类文档」节）。
- **v1 兼容**：`run_agent` → `run_task` 的旧名映射只在服务端接入层处理，契约只认 `run_task`。

## 消费方式

```ts
// agent-server（运行时校验 + 类型）
import { CodeAnalysisSchema, TOOL_CONTRACTS, ClientMessageSchema } from "@agent-unittest/contracts";

// extension（现阶段只 import type；运行时需要值时等插件切 ESM）
import type { ServerMessage } from "@agent-unittest/contracts";
```
