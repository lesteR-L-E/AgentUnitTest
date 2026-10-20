/**
 * AgentUnitTest Agent Server —— 脚手架占位版
 *
 * 当前能力（仅供打通链路）：
 *   GET /health → {"service":"AgentUnitTest","status":"ok"}   供插件 BackendProcess 就绪探测
 *   WS  /ws     → echo（原样回显收到的消息，供连接链路冒烟）
 *
 * TODO(M1)：
 *   - 按 docs/项目文档-v2.md §5 实现协议 v2（run_task / chat / cancel / clear_memory）
 *   - 接入 runtime/（AI SDK Agent Loop）与 llm/ 工厂
 *   - instanceId 校验 + 心跳（§5.1）
 */
import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8765);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ service: "AgentUnitTest", status: "ok", pid: process.pid }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket) => {
  console.log("[ws] client connected");
  socket.on("message", (raw) => {
    // TODO(M1): 替换 echo 为协议 v2 分发
    socket.send(raw.toString());
  });
  socket.on("close", () => console.log("[ws] client disconnected"));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[agent-server] health: http://127.0.0.1:${PORT}/health`);
  console.log(`[agent-server] ws:     ws://127.0.0.1:${PORT}/ws`);
});
