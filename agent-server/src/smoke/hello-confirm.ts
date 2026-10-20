/**
 * §3.7 断言双重确认护栏冒烟（零 LLM 消耗）：
 * 直接驱动 handleRepairCall / handleConfirmDecision，验证护栏与确认流转。
 * 运行：npm run smoke:confirm
 */
import "../env.js";
import type { Diagnosis, GeneratedTest, ServerMessage } from "@agent-unittest/contracts";
import { SessionManager } from "../runtime/session.js";
import { handleConfirmDecision, handleRepairCall, type EmitFn } from "../runtime/agent.js";

const events: ServerMessage[] = [];
const emit: EmitFn = (m) => events.push(m);
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

const sessions = new SessionManager();
const session = sessions.getOrCreate("smoke-confirm");
session.state.taskContext = {
  code: "public class Calculator { public int divide(int a, int b) { return a / b; } }",
  filePath: "src/main/java/com/example/Calculator.java",
  workspaceRoot: "/tmp",
};

const generatedTest: GeneratedTest = {
  packageName: "com.example",
  className: "CalculatorTest",
  code: 'package com.example;\n// STUB_FAIL 演示失败标记\nfail("STUB_FAIL: 演示失败路径");',
  targetFilePath: null,
  framework: "junit5",
};
const diagnosis: Diagnosis = {
  items: [
    {
      failingTest: "CalculatorTest#testDivide",
      failureClass: "assertion_error",
      evidence: "expected IllegalArgumentException but was 0",
      suspectedCause: "[stub] 断言与被测行为分歧",
      suggestedAction: "向用户说明两种可能；修改断言需双重确认",
      autoRepairable: false,
      requiresDoubleConfirm: true,
      confidence: 0.6,
    },
  ],
  summary: "[stub] 1 个失败归类为断言问题，需双重确认",
};

// 1) 断言级修改、无确认凭证 → 拒绝 + 发出第 1 步确认请求
const r1 = (await handleRepairCall(
  session,
  { generatedTest, diagnosis, userInstruction: "把断言改成期望返回 0", assertionLevelChange: true },
  emit,
)) as { ok: boolean; error?: string };
check("无凭证的断言级修改被拒绝", r1.ok === false && String(r1.error).includes("双重确认"));
const req1 = events.find(
  (e) => e.type === "confirmation_request" && e.stage === "content",
) as Extract<ServerMessage, { type: "confirmation_request" }> | undefined;
check("已发出第 1 步确认请求（content）", Boolean(req1));

// 2) 伪造确认凭证 → 工具层硬校验拒绝
const r2 = (await handleRepairCall(
  session,
  {
    generatedTest,
    assertionLevelChange: true,
    confirmations: { contentConfirmId: "fake-1", riskConfirmId: "fake-2" },
  },
  emit,
)) as { ok: boolean; error?: string };
check("伪造确认凭证被拒绝（硬校验）", r2.ok === false && String(r2.error).includes("凭证无效"));

// 3) 非断言级修改 → 无需确认直接放行
const r3 = (await handleRepairCall(
  session,
  { generatedTest, userInstruction: "补充一个 null 输入用例", assertionLevelChange: false },
  emit,
)) as { ok: boolean };
check("非断言级修改直接放行", r3.ok === true);

// 4) 批准第 1 步 → 发出第 2 步（risk），且不触发恢复
// （用对象持有值：闭包内赋值不会被 TS 的控制流分析错误收窄为 never）
const resumed: { msg: string | null } = { msg: null };
const hooks = {
  onResume: (m: string) => {
    resumed.msg = m;
  },
};
await handleConfirmDecision(
  session,
  { type: "confirm", sessionId: session.state.sessionId, confirmId: req1!.confirmId, decision: "approve" },
  emit,
  hooks,
);
const req2 = events.find(
  (e) => e.type === "confirmation_request" && e.stage === "risk",
) as Extract<ServerMessage, { type: "confirmation_request" }> | undefined;
check("批准第 1 步后进入第 2 步（risk）", Boolean(req2) && resumed.msg === null);

// 5) 批准第 2 步 → 服务端代执行修复 + test_code 推送 + 恢复指令（要求 run_tests）
await handleConfirmDecision(
  session,
  { type: "confirm", sessionId: session.state.sessionId, confirmId: req2!.confirmId, decision: "approve" },
  emit,
  hooks,
);
const testCodeMsg = events.find((e) => e.type === "test_code") as
  | Extract<ServerMessage, { type: "test_code" }>
  | undefined;
check("修复已执行并推送 test_code", Boolean(testCodeMsg) && testCodeMsg!.testCode.includes("repair_tests 已执行"));
check("发出恢复指令（要求 run_tests 重跑）", resumed.msg !== null && resumed.msg.includes("run_tests"));

// 6) 重复提交同一确认 → 拒绝
const dupEvents = events.length;
await handleConfirmDecision(
  session,
  { type: "confirm", sessionId: session.state.sessionId, confirmId: req2!.confirmId, decision: "approve" },
  emit,
  hooks,
);
check("重复确认被拒绝", events.length > dupEvents && events[events.length - 1]!.type === "error");

if (failures.length > 0) {
  console.error(`[hello-confirm] ❌ ${failures.length} 项失败: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("[hello-confirm] ✅ §3.7 双重确认护栏全部通过（零 LLM 消耗）");
