# @agent-unittest/contracts — 契约层（单一事实源）

本包是全团队的"法律文件"：**WS 协议 v2 消息、IR 数据模型、9 个工具接口**全部在此定义。
agent-server 与 extension 都从这里导入 schema 和类型，任何一侧不得私自定义。

## 目录

```
src/
├── ir/         # IR 数据模型（5+2 个）：CodeAnalysis · EnvironmentContext · TestResult
│               #   · Diagnosis · GeneratedTest · SessionState · SourceLocation
├── protocol/   # WS 协议 v2：ClientMessage / ServerMessage（ discriminated union，按 type 判别）
└── tools/      # 9 个工具的输入/输出 schema + TOOL_CONTRACTS 注册表 + 统一返回信封
```

## 三条规则

1. **命名**：字段一律 camelCase（v1 Python 模型是 snake_case，语义一一对应，各文件注释有映射说明）。
2. **修改流程**：M1 评审通过后契约即冻结——改任何字段必须全员知悉同意（PR 里 @所有人），禁止悄悄改。
3. **构建**：改完本包必须 `npm run build -w @agent-unittest/contracts`，消费方引用的是 `out/` 产物
   （根目录 `npm run build` 会按 contracts → agent-server → extension 顺序自动构建）。

## 消费方式

```ts
// agent-server（运行时校验 + 类型）
import { CodeAnalysisSchema, TOOL_CONTRACTS, ClientMessageSchema } from "@agent-unittest/contracts";

// extension（现阶段建议只 import type；运行时需要值时等插件切 ESM，见项目文档 §7）
import type { ServerMessage } from "@agent-unittest/contracts";
```

## 设计要点（评审时重点看）

- **护栏进契约**（项目文档 §3.7）：`DiagnosisItem.requiresDoubleConfirm / autoRepairable`、
  `RepairTestsInput.assertionLevelChange + confirmations`——断言双重确认由数据结构强制，不靠提示词自觉。
- **工具统一返回信封**：`{ok:true,data}` | `{ok:false,error,retryable}`，工具异常必须结构化返回（§3.4）。
- **消息 strict 模式**：客户端消息用 `.strict()`，多余字段直接校验失败，尽早暴露前后端不同步。
