/**
 * WS 协议层冒烟（零 LLM 消耗）：起真服务器，验证协议 v2 的分发与校验。
 * 运行：npm run smoke:ws
 */
import "../env.js";
import WebSocket from "ws";
import { startServer } from "../server.js";

const handle = await startServer(0); // 随机端口
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

// 1) /health
const health = (await fetch(`http://127.0.0.1:${handle.port}/health`).then((r) =>
  r.json(),
)) as Record<string, unknown>;
check(
  "GET /health 返回 ok + 框架标识",
  health.status === "ok" && health.service === "AgentUnitTest" && health.agent_framework === "vercel-ai-sdk",
);

// 2) WS 连接
const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
await new Promise<void>((resolve, reject) => {
  ws.once("open", () => resolve());
  ws.once("error", reject);
});

function nextMessage(predicate: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMsg = (buf: WebSocket.RawData) => {
      const m = JSON.parse(buf.toString()) as Record<string, unknown>;
      if (predicate(m)) {
        ws.off("message", onMsg);
        resolve(m);
      }
    };
    ws.on("message", onMsg);
  });
}

// 3) ping → pong
const pongWait = nextMessage((m) => m.type === "pong");
ws.send(JSON.stringify({ type: "ping", ts: 12345 }));
const pong = await pongWait;
check("ping → pong（心跳链路）", pong.ts === 12345);

// 4) 非法 JSON → error
const err1Wait = nextMessage((m) => m.type === "error");
ws.send("这不是JSON{{{");
const err1 = await err1Wait;
check("非法 JSON → error", String(err1.message).includes("JSON"));

// 5) 未知消息类型 → 契约校验 error
const err2Wait = nextMessage((m) => m.type === "error");
ws.send(JSON.stringify({ type: "bogus_type", sessionId: "x" }));
const err2 = await err2Wait;
check("未知消息类型 → 协议校验 error", String(err2.message).includes("协议 v2"));

// 6) strict 模式：多余字段被拒绝
const err3Wait = nextMessage((m) => m.type === "error");
ws.send(JSON.stringify({ type: "chat", sessionId: "x", message: "hi", hackField: "boom" }));
await err3Wait;
check("strict 模式拒绝多余字段", true);

ws.close();
await handle.close();

if (failures.length > 0) {
  console.error(`[hello-ws] ❌ ${failures.length} 项失败: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("[hello-ws] ✅ 协议层冒烟全部通过（零 LLM 消耗）");
