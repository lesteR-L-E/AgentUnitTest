/**
 * 会话 JSON 落盘冒烟（零 LLM 消耗）：
 * 验证「存盘 → 模拟重启 → 续聊」全链路与路径穿越防护。
 * 运行：npm run smoke:store
 */
import "../env.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../runtime/session-store.js";
import { SessionManager, putArtifact } from "../runtime/session.js";

const dir = await mkdtemp(path.join(tmpdir(), "agent-unit-test-store-"));
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

// 1) 写入：建会话 → 塞消息/任务上下文/产物/确认账本 → 存盘
const m1 = new SessionManager(60_000, new SessionStore(dir));
const s = await m1.getOrCreate("conv-demo");
s.title = "Calculator 测试对话";
s.messages.push({ role: "user", content: "为 Calculator 生成单元测试" });
s.messages.push({
  role: "assistant",
  content: [{ type: "text", text: "已完成：5/5 通过" }],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);
s.state.taskContext = { code: "class Calculator{}", filePath: "Calculator.java", workspaceRoot: "/tmp" };
const aid = putArtifact(s, "test_code", "package com.example;\n// 测试源码全文".repeat(5), "CalculatorTest（3 个用例）");
s.confirmations.set("cf-1", {
  confirmId: "cf-1",
  stage: "content",
  question: "确认修改断言？",
  detail: "...",
  decision: "approve",
  decidedAtMs: Date.now(),
});
await m1.save(s);

// 2) 模拟重启：全新 manager + 同一目录 → 会话完整恢复
const m2 = new SessionManager(60_000, new SessionStore(dir));
const loaded = await m2.getOrCreate("conv-demo");
check("消息跨重启存活", loaded.messages.length === 2);
check("标题跨重启存活", loaded.title === "Calculator 测试对话");
check("任务上下文跨重启存活", loaded.state.taskContext?.filePath === "Calculator.java");
check("产物全文可取回", loaded.artifacts.get(aid)?.content.includes("测试源码全文") === true);
check("确认账本跨重启存活", loaded.confirmations.get("cf-1")?.decision === "approve");

// 3) 列表：前端「选择对话继续 / 新建对话」的数据源
const list = await m2.list();
check(
  "list 返回对话摘要（按最近活跃）",
  list.length === 1 && list[0]!.sessionId === "conv-demo" && list[0]!.messageCount === 2,
);

// 4) 新建对话互不干扰
const fresh = await m2.getOrCreate("conv-new");
check("新建对话是干净的", fresh.messages.length === 0 && fresh.title === null);

// 5) clear：内存 + 文件一起删
await m2.clear("conv-demo");
const m3 = new SessionManager(60_000, new SessionStore(dir));
check("clear 后文件已删除", (await m3.get("conv-demo")) === undefined);

// 6) 路径穿越防护
let threw = false;
try {
  await new SessionStore(dir).load("../../etc/passwd");
} catch {
  threw = true;
}
check("非法 sessionId 被拒绝（防路径穿越）", threw);

if (failures.length > 0) {
  console.error(`[hello-store] ❌ ${failures.length} 项失败: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("[hello-store] ✅ 会话 JSON 落盘全部通过（零 LLM 消耗）");
