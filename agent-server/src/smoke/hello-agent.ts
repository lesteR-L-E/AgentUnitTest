/**
 * Agent Loop 全链路冒烟（真实 LLM + 桩工具，消耗少量 token）：
 * 建临时 Java 工程 fixture → 发起生成任务 → 观察 Agent 自主调工具 → 校验收到 result。
 * 运行：npm run smoke:agent（.env 需配置任一 provider 的 key）
 * 可选环境变量：SMOKE_PROVIDER（默认 deepseek）、SMOKE_MODEL
 */
import "../env.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResultMessage, ServerMessage } from "@agent-unittest/contracts";
import { getModel, validateModel } from "../llm/factory.js";
import { SessionManager } from "../runtime/session.js";
import { buildTaskUserMessage, runAgentTurn } from "../runtime/agent.js";

// 1) 临时 Java 工程 fixture（供 inspect_environment 探测 maven）
const root = await mkdtemp(path.join(tmpdir(), "agent-unit-test-fixture-"));
await mkdir(path.join(root, "src/main/java/com/example"), { recursive: true });
const CALC = `package com.example;

public class Calculator {
    public int add(int a, int b) {
        return a + b;
    }

    public int divide(int a, int b) {
        return a / b;
    }
}
`;
await writeFile(path.join(root, "src/main/java/com/example/Calculator.java"), CALC);
await writeFile(
  path.join(root, "pom.xml"),
  `<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>demo</artifactId><version>1.0</version></project>`,
);
console.log(`[hello-agent] fixture: ${root}`);

// 2) 模型
const handle = getModel(process.env.SMOKE_PROVIDER ?? "deepseek", process.env.SMOKE_MODEL);
console.log(`[hello-agent] provider=${handle.provider} model=${handle.modelName}，校验凭证...`);
await validateModel(handle);

// 3) 发起一轮任务
const sessions = new SessionManager();
const session = sessions.getOrCreate("smoke-agent");
session.modelHandle = handle;
session.state.taskContext = {
  code: CALC,
  filePath: "src/main/java/com/example/Calculator.java",
  workspaceRoot: root,
};

const counts = new Map<string, number>();
let resultMsg: ResultMessage | null = null;
const emit = (m: ServerMessage): void => {
  counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
  if (m.type === "token") {
    process.stdout.write(m.delta);
  } else if (m.type === "result") {
    resultMsg = m;
    console.log(`\n[result] passed=${m.passed} testCount=${m.testCount} message=${m.message ?? ""}`);
  } else {
    console.log(`\n[${m.type}]`, JSON.stringify(m).slice(0, 220));
  }
};

await runAgentTurn({
  session,
  handle,
  emit,
  userMessage: buildTaskUserMessage({
    code: CALC,
    filePath: "src/main/java/com/example/Calculator.java",
  }),
});

// 4) 校验
console.log("\n[hello-agent] 事件统计:", Object.fromEntries(counts));
const toolEvents = counts.get("tool_call") ?? 0;
if (toolEvents === 0) {
  console.error("❌ 没有观察到工具调用 —— Agent Loop 未生效");
  process.exit(1);
}
if (!resultMsg) {
  console.error("❌ 未收到 result 消息（提示词要求：无 run_tests 结果不得宣告完成）");
  process.exit(1);
}
console.log(`[hello-agent] ✅ Agent Loop 全链路跑通（工具事件 ${toolEvents} 个；真实 LLM + 桩工具）`);
