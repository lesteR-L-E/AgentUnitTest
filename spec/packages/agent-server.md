# agent-server — Agent 后端

> 开始任何涉及 agent-server 的工作前，先读本文。运行链路总览见 `docs/项目文档-v2.md` §3；本文只写仓库现状的架构与约束。

## 定位与结构

Node ≥ 20 的 WS 服务端：接收协议 v2 消息，驱动基于 Vercel AI SDK 的 Agent Loop，管理会话（内存 + JSON 落盘）。

```
src/
├── env.ts                # 环境变量清洗（必须是每个入口的第一个 import，见 spec/cross-platform.md §6）
├── server.ts             # HTTP(/health) + WS 服务：消息三道关校验、按 type 分发、串行队列
├── llm/factory.ts        # 模型工厂——全项目唯一的模型出口（业务代码禁止直接 import @ai-sdk/*）
├── runtime/
│   ├── prompt.ts         # 系统提示词 + 25 步轮数护栏（改 Agent 行为规范必改这里）
│   ├── agent.ts          # Agent Loop 核心：buildTools / executeTool 收口 / 双重确认护栏 / runAgentTurn
│   ├── session.ts        # SessionManager：三级查找、TTL 只逐出内存、产物「摘要+ID」存档
│   ├── session-store.ts  # JSON 落盘层：原子写、sessionId 防路径穿越、list/删
│   └── stubs.ts          # 9 个工具的桩实现（M2 逐个替换为真实现）
├── smoke/                # 六套冒烟脚本（hello-llm/ws/contracts/confirm/store/agent）
└── ../data/sessions/     # 会话 JSON（git-ignored，绝不入库；SESSION_DIR 环境变量可覆盖）
```

## 关键机制（修改前必知其边界）

- **消息三道关**（server.ts）：JSON 解析失败 → error；ClientMessageSchema strict 校验失败 → error；通过后才分发。出站消息统一经 `send()` 先过 ServerMessageSchema 校验再发（违反契约的出站消息宁可拦截不发）。
- **串行队列**（`enqueue`）：每个 sessionId 一条 Promise 链，任务运行中收到的 chat 自动排队到任务后；`prev.then(task, task)` 写法保证一次失败不卡死队列。
- **会话三级查找**（session.ts `getOrCreate`）：内存缓存 → JSON 文件重载（跨重启续聊）→ 新建。TTL 30 分钟只逐出内存、文件保留；文件只在 `clear_memory` 时删。`get`（不新建）用于 confirm；`peek`（只查内存）用于 cancel。
- **模型绑定**：run_task 携带 provider/model 建立绑定并落盘（key 不落盘，只存 provider/modelName 名）；chat 不带 provider，沿用会话绑定，未绑定时按 `.env` 已配置 key 自动探测（deepseek → openai → anthropic）。
- **Agent Loop**（agent.ts `runAgentTurn`）：run_task 与 chat 走同一入口（任务即消息）。`streamText` 多步循环（LLM 要调工具 → zod 校验 → execute → 结果喂回），`stopWhen: stepCountIs(25)` 护栏；流分片实时映射为协议消息（token / tool_call running→done|error）；轮末把 responseMessages 落入会话历史 + onPersist 落盘。
- **双重确认护栏**（§3.7）：repair_tests 断言级修改 → `handleRepairCall` 拦截，发 confirmation_request（content → risk 两步），LLM 拿不到凭证；用户确认后由**服务端**代注入凭证执行修复，再以系统消息恢复轮次。改这段逻辑必须同步过冒烟 `smoke:confirm`。
- **工具收口**：所有工具的 execute 都指向 `executeTool`（护栏、副作用推送、错误信封在那里统一处理）；成功副作用：generate_tests/repair_tests → test_code 消息，run_tests → result 消息。
- **产物「摘要 + ID」机制**：长产物全文进 `session.artifacts`（档案室），只把「ID + 摘要」放进对话历史；LLLM 按需用 read_artifact 取全文——防止上下文爆炸，新增产出大内容的工具时必须走 `putArtifact`。

## 硬约束

- 模型出口唯一：任何新模块要调 LLM 只能经 `llm/factory.ts` 的 `getModel`/`validateModel`。
- API key 永不写日志、永不落盘。
- 会话文件写入必须走 SessionStore（原子写 + sessionId 正则校验），不得自行 writeFile。
- 工具实现不抛异常，统一返回 `{ok,...}` 信封（见 `spec/code-style.md` 错误处理节）。

## 桩替换指南（M2 各负责人）

替换 `stubs.ts` 中某个 `xxxStub` 时：**保持函数签名与返回信封不变**，换内部实现；输出契约校验不过 = 编译/运行时报错，这就是对照标准。真实现涉及进程/路径/编码时先读 `spec/cross-platform.md`；v1 Python 基线（`单元测试Agent插件/AgentUnitTest-backend`）是对照行为参照。

## 冒烟脚本

`smoke:contracts` / `smoke:ws` / `smoke:confirm` / `smoke:store`（零 token）；`smoke:llm`（连通性，少量 token）；`smoke:agent`（全链路：真实 LLM + 桩工具）。改动 agent-server 行为后至少跑相关的 1~2 套。
