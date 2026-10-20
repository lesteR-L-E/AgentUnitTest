/**
 * AgentUnitTest Agent Server —— WS 协议 v2 骨架版（M1 第 4 步）。
 *
 * 已实现：
 *   - ClientMessage 契约校验（strict：非法/未知字段直接拒绝）
 *   - run_task / chat / confirm / cancel / clear_memory / ping 分发
 *   - 每会话串行任务队列（chat 在任务运行中自动排队 —— 讨论稿议题三决议）
 *   - 出站消息契约校验（ServerMessageSchema）
 *   - 会话 TTL 过期 → session_expired 推送；断线 → 取消该连接会话的活跃轮次
 *
 * TODO（M1 第 6 步 / M2）：
 *   - instanceId 校验（防陈旧前端连接，v1 机制迁移）
 *   - 同 sessionId 多连接广播（当前事件只回发起连接）
 */
import "./env.js"; // ⚠️ 必须是第一个 import（清洗空字符串环境变量，见 env.ts 注释）

import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ClientMessageSchema,
  ServerMessageSchema,
  type ChatMessage,
  type ConfirmMessage,
  type RunTaskMessage,
  type ServerMessage,
} from "@agent-unittest/contracts";
import { getModel, validateModel, type ModelHandle } from "./llm/factory.js";
import { SessionManager, type Session } from "./runtime/session.js";
import {
  buildTaskUserMessage,
  handleConfirmDecision,
  runAgentTurn,
  type EmitFn,
} from "./runtime/agent.js";

const VERSION = "0.1.0";
const AGENT_FRAMEWORK = "vercel-ai-sdk";

const sessions = new SessionManager();
const chains = new Map<string, Promise<void>>(); // 每会话串行队列
const socketsBySession = new Map<string, Set<WebSocket>>();
const sessionsBySocket = new Map<WebSocket, Set<string>>();

sessions.setExpirationHandler((sessionId) => {
  const sockets = socketsBySession.get(sessionId);
  if (!sockets) return;
  for (const socket of sockets) {
    send(socket, { type: "session_expired", sessionId });
  }
  socketsBySession.delete(sessionId);
});

// ───────────────────────── 基础设施 ─────────────────────────

function send(socket: WebSocket, msg: ServerMessage): void {
  const parsed = ServerMessageSchema.safeParse(msg);
  if (!parsed.success) {
    console.error("[server] 出站消息违反契约（已拦截）:", parsed.error.message);
    return;
  }
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(parsed.data));
}

function bind(socket: WebSocket, sessionId: string): void {
  let set = socketsBySession.get(sessionId);
  if (!set) socketsBySession.set(sessionId, (set = new Set()));
  set.add(socket);
  let owned = sessionsBySocket.get(socket);
  if (!owned) sessionsBySocket.set(socket, (owned = new Set()));
  owned.add(sessionId);
}

/** 同会话任务串行：运行中收到的新消息自动排队（不并发、不丢失） */
function enqueue(sessionId: string, task: () => Promise<void>): void {
  const prev = chains.get(sessionId) ?? Promise.resolve();
  const next = prev.then(task, task);
  chains.set(sessionId, next);
  void next.catch(() => {});
}

// ───────────────────────── 消息处理 ─────────────────────────

function handleRunTask(msg: RunTaskMessage, emit: EmitFn): void {
  const session = sessions.getOrCreate(msg.sessionId);
  session.abortController?.abort(); // 抢占：新任务取消旧轮次（沿用 v1 行为）
  session.state.taskContext = {
    code: msg.code,
    filePath: msg.filePath,
    workspaceRoot: msg.workspaceRoot,
  };

  let handle: ModelHandle;
  try {
    handle = getModel(msg.provider, msg.model, { apiKey: msg.apiKey, baseURL: msg.baseUrl });
  } catch (err) {
    emit({ type: "error", sessionId: msg.sessionId, message: (err as Error).message });
    return;
  }
  session.modelHandle = handle; // chat 消息不带 provider，沿用本会话模型

  enqueue(msg.sessionId, async () => {
    try {
      await validateModel(handle);
    } catch (err) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: `模型凭证校验失败: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    await runAgentTurn({
      session,
      handle,
      emit,
      userMessage: buildTaskUserMessage({
        code: msg.code,
        filePath: msg.filePath,
        instruction: msg.instruction,
      }),
    });
  });
}

function handleChat(msg: ChatMessage, emit: EmitFn): void {
  const session = sessions.getOrCreate(msg.sessionId);
  const handle = session.modelHandle ?? defaultHandle();
  if (!handle) {
    emit({
      type: "error",
      sessionId: msg.sessionId,
      message: "会话没有可用模型：请先发起一次生成任务（run_task），或在 .env 配置 DEFAULT_PROVIDER 对应的 key",
    });
    return;
  }
  session.modelHandle = handle;
  enqueue(msg.sessionId, () =>
    runAgentTurn({ session, handle, emit, userMessage: msg.message }),
  );
}

function defaultHandle(): ModelHandle | null {
  const provider = process.env.DEFAULT_PROVIDER?.trim();
  if (!provider) return null;
  try {
    return getModel(provider, process.env.DEFAULT_MODEL);
  } catch {
    return null;
  }
}

function handleConfirm(msg: ConfirmMessage, emit: EmitFn): void {
  const session: Session | undefined = sessions.get(msg.sessionId);
  if (!session) {
    emit({ type: "error", sessionId: msg.sessionId, message: "会话不存在或已过期" });
    return;
  }
  const handle = session.modelHandle;
  enqueue(msg.sessionId, async () => {
    await handleConfirmDecision(session, msg, emit, {
      onResume: (systemMessage) => {
        if (!handle) {
          emit({
            type: "error",
            sessionId: msg.sessionId,
            message: "无可用模型，无法继续（请先发起过一次生成任务）",
          });
          return;
        }
        enqueue(msg.sessionId, () =>
          runAgentTurn({ session, handle, emit, userMessage: systemMessage }),
        );
      },
    });
  });
}

// ───────────────────────── 服务器 ─────────────────────────

export function createServer(): { httpServer: http.Server; wss: WebSocketServer } {
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          service: "AgentUnitTest",
          status: "ok",
          pid: process.pid,
          version: VERSION,
          agent_framework: AGENT_FRAMEWORK,
          active_sessions: sessions.count(),
        }),
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (socket) => {
    console.log("[ws] client connected");
    const emit: EmitFn = (msg) => send(socket, msg);

    socket.on("message", (rawBuf) => {
      let json: unknown;
      try {
        json = JSON.parse(rawBuf.toString());
      } catch {
        send(socket, { type: "error", message: "消息不是合法 JSON" });
        return;
      }
      const parsed = ClientMessageSchema.safeParse(json);
      if (!parsed.success) {
        send(socket, {
          type: "error",
          message: `消息违反协议 v2: ${parsed.error.message}`.slice(0, 300),
        });
        return;
      }
      const msg = parsed.data;
      if ("sessionId" in msg && typeof msg.sessionId === "string") bind(socket, msg.sessionId);

      switch (msg.type) {
        case "ping":
          send(socket, { type: "pong", ts: msg.ts ?? Date.now() });
          break;
        case "run_task":
          handleRunTask(msg, emit);
          break;
        case "chat":
          handleChat(msg, emit);
          break;
        case "confirm":
          handleConfirm(msg, emit);
          break;
        case "cancel": {
          const session = sessions.get(msg.sessionId);
          if (session?.abortController) {
            session.abortController.abort(); // cancelled 事件由 runAgentTurn 的 catch 发出
          } else {
            send(socket, {
              type: "cancelled",
              sessionId: msg.sessionId,
              message: "当前无运行中任务",
            });
          }
          break;
        }
        case "clear_memory":
          sessions.clear(msg.sessionId);
          console.log(`[server] 会话已清空: ${msg.sessionId}`);
          break;
      }
    });

    socket.on("close", () => {
      console.log("[ws] client disconnected");
      const owned = sessionsBySocket.get(socket);
      if (owned) {
        for (const sid of owned) {
          sessions.get(sid)?.abortController?.abort(); // 断线取消活跃轮次（沿用 v1 行为）
          socketsBySession.get(sid)?.delete(socket);
        }
        sessionsBySocket.delete(socket);
      }
    });
  });

  return { httpServer, wss };
}

export interface ServerHandle {
  httpServer: http.Server;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(port: number): Promise<ServerHandle> {
  const { httpServer, wss } = createServer();
  await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
  const addr = httpServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  console.log(`[agent-server] health: http://127.0.0.1:${actualPort}/health`);
  console.log(`[agent-server] ws:     ws://127.0.0.1:${actualPort}/ws`);
  return {
    httpServer,
    port: actualPort,
    close: () =>
      new Promise((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}

// 直接运行本文件时启动服务（被 import 时不启动，供冒烟脚本复用）
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8765);
  void startServer(port);
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8765);
  void startServer(port);
}
