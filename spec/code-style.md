# 代码风格与注释规范

本文件是全仓库代码风格的唯一标准。写任何代码（含桩实现、冒烟脚本、webview 内联 JS）前先读本文。

## 总则

- 语言：TypeScript，ESM（`"type": "module"`）
- 相对导入必须带 `.js` 后缀（NodeNext 解析约定，仓库现行写法）；不用 `__dirname`/`__filename`，用 `import.meta.url`
- 类型显化：接口参数与返回值完整声明，避免 `any`；确需绕过类型（如 AI SDK 泛型收窄）处加一行注释说明原因
- 代码简洁优雅，阅读体验优先；增量式构建，每步可验证
- 错误消息面向人（中文、说清原因与去哪修），日志前缀统一 `[server]`/`[agent]`/`[session]`/`[store]` 式样

## 注释规范（核心）

**所有注释使用中文。** 注释回答"为什么/边界在哪"，不复述代码在做什么。

### 函数 JSDoc 统一格式

每个导出函数/类/模块必须有 JSDoc，结构为「职责 + 分支」：

```
/**
 * 一句话说清这个函数做什么（给谁用、什么时候被调）。
 *
 * 分支逻辑 / 优先级 / 副作用（有几条写几条，逐条列出）：
 *  - 情况 A → 对应行为；
 *  - 情况 B → 对应行为；
 *  - 副作用：写盘 / 推送消息 / 更新 session.latest 等。
 */
```

按函数复杂度分三档，仓库内真实示例：

**第 1 档 · 单行版**（简单函数，一行讲清职责与边界）：

```ts
/** 规范化 provider 名：去空格 + 转小写。分支：三个合法名之一 → 返回；否则抛错（错误文案含可选项，会经 server 直接回给前端） */
export function normalizeProvider(raw: string): ProviderName {
```

**第 2 档 · 分支版**（多分支/优先级逻辑，先一句话职责再列分支）：

```ts
/**
 * 解析 API key。优先级分支：请求显式传入的 apiKey（非空、trim 后）> .env 对应环境变量。
 * 两者都没有 → 抛错（提示去哪配置）。显式 key 只允许来自本机回环的 WS 请求，严禁写日志。
 */
function resolveKey(provider: ProviderName, explicit?: string): string {
```

**第 3 档 · 全分支版**（核心流程，逐分支写全，含错误与边界路径）：

```ts
/**
 * confirm 消息（用户点了确认按钮）处理。全部分支：
 *  - confirmId 不在账本 → 报 error（伪造/过期 ID）；
 *  - 该确认已有决定 → 报 error（拒绝重复提交）；
 *  - 无 pendingRepair → 静默返回（理论上不发生）；
 *  - decision=reject（任意阶段）→ 清暂存，注入「用户已拒绝」系统消息开新一轮；
 *  - decision=approve 且 stage=content → 登记第二步（risk）确认并发出新的 confirmation_request；
 *  - decision=approve 且 stage=risk → 服务端把两个确认 ID 注入暂存参数、代 LLM 执行修复，
 *    推送 test_code，再注入「已确认已修复，去 run_tests 重跑」系统消息开新一轮。
 */
```

### 哪些函数必须列分支

- 含 ≥ 2 个条件分支（if/switch/catch/降级路径）的函数：**必须**把每个分支走向写进 JSDoc
- 含优先级/回退链的（如"显式传参 > 环境变量 > 默认值"）：必须写清优先级顺序
- 有副作用的（写文件、发 WS 消息、改 `session.latest`、入队）：必须单独一行注明
- 纯取值/透传的简单函数：单行档即可，不必硬凑分支

### 两类文档：给人看的与给 LLM 看的

本项目特有且同等重要，混淆会导致 LLM 行为退化：

| 类别 | 位置 | 写给谁 | 要求 |
|------|------|--------|------|
| JSDoc | 函数/类/模块上方 | 人类开发者 | 上述统一格式 |
| `.describe()` | zod schema 每个字段 | LLM（直接进入工具参数 JSON Schema） | 说清语义、单位、默认行为与安全约束，例如 `describe("相对 workspaceRoot 的文件路径；越出 workspaceRoot 的绝对路径必须被拒绝")` |
| `TOOL_DESCRIPTIONS` | `agent-server/src/runtime/agent.ts` | LLM（决定它何时调用该工具） | 一句话说清用途与使用时机；护栏类工具要写"必须/严禁" |

系统提示词（`runtime/prompt.ts`）是 Agent 行为规范的载体：修改任何业务护栏（推荐路径、断言规则、垂直边界）必须同步改它，且保持条目化、指令化表述。

### 其他注释场合

- 文件头：每个源文件顶部一段块注释，说明该文件职责与在链路中的位置（参照 `server.ts`/`session-store.ts` 现有写法）
- 桩实现：保持 `桩｜半真`/`桩` 标记与 `TODO(M2 负责人)` 注明替换方式；替换时保留函数签名与返回信封不变
- 行内注释：只写反直觉的"为什么"（如 `// ELECTRON_RUN_AS_NODE=1：把 VSCode 自带的 Electron 当纯 Node 用`），不写翻译代码的废话

## 命名约定

- 变量/函数：camelCase；类型/类：PascalCase；常量：UPPER_SNAKE_CASE
- 契约字段一律 camelCase（v1 Python 模型是 snake_case，语义一一对应，映射说明见 contracts 各文件注释）
- 桩实现命名 `xxxStub`，M2 替换为真实现时改名为正式名并同步 `agent.ts` 的分发处
- 会话/工具消息字段与协议 v2 schema 保持完全一致，不自创同义字段

## 错误处理风格

- 工具实现不抛异常：一律返回统一信封 `{ok:true,data}` 或 `{ok:false,error,retryable}`（见 `contracts/src/tools/envelope.ts`）；异常在 `executeTool` 包装层兜底转信封
- server 层消息处理包在统一 async try/catch 里，把异常转成 `error` 消息回给客户端而不是炸掉连接
- 日志分级：正常流程 info、降级/可疑 warning、失败 error；**任何日志不得出现 API key 明文**
