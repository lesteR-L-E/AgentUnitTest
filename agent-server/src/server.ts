/**
 * AgentUnitTest Agent Server —— WS 协议 v2（M1 骨架 + 会话 JSON 落盘）。
 *
 * 已实现：
 *   - ClientMessage 契约校验（strict）+ 出站消息契约校验
 *   - run_task / chat / confirm / cancel / clear_memory / list_sessions / ping 分发
 *   - 每会话串行任务队列（chat 在任务运行中自动排队）
 *   - 会话持久化：data/sessions/<sessionId>.json（重启后选择同一对话可继续聊）
 *   - 断线 → 取消该连接会话的活跃轮次
 *
 * TODO（M1 第 6 步 / M2）：instanceId 校验、同 sessionId 多连接广播、上下文压缩。
 */
import "./env.js"; // ⚠️ 必须是第一个 import（清洗空字符串环境变量，见 env.ts 注释）

import http from "node:http";
import path from "node:path";
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
import { SessionStore } from "./runtime/session-store.js";
import {
  buildTaskUserMessage,
  handleConfirmDecision,
  runAgentTurn,
  type EmitFn,
} from "./runtime/agent.js";

const VERSION = "0.1.0";
const AGENT_FRAMEWORK = "vercel-ai-sdk";

const store = new SessionStore();
const sessions = new SessionManager(undefined, store);
const chains = new Map<string, Promise<void>>(); // 每会话串行队列
const socketsBySession = new Map<string, Set<WebSocket>>();
const sessionsBySocket = new Map<WebSocket, Set<string>>();

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

/** 对话标题派生：首条内容的第一行，去代码围栏，截 30 字 */
function deriveTitle(text: string): string {
  const firstLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("```")) ?? text.trim();
  return firstLine.length > 30 ? `${firstLine.slice(0, 30)}…` : firstLine;
}

// ───────────────────────── 消息处理 ─────────────────────────

async function handleRunTask(msg: RunTaskMessage, emit: EmitFn): Promise<void> {
  const session = await sessions.getOrCreate(msg.sessionId);
  session.abortController?.abort(); // 抢占：新任务取消旧轮次（沿用 v1 行为）
  session.state.taskContext = {
    code: msg.code,
    filePath: msg.filePath,
    workspaceRoot: msg.workspaceRoot,
  };
  if (!session.title) {
    session.title = msg.instruction
      ? deriveTitle(msg.instruction)
      : `${path.basename(msg.filePath)} 测试对话`;
  }

  let handle: ModelHandle;
  try {
    handle = getModel(msg.provider, msg.model, { apiKey: msg.apiKey, baseURL: msg.baseUrl });
  } catch (err) {
    emit({ type: "error", sessionId: msg.sessionId, message: (err as Error).message });
    return;
  }
  session.modelHandle = handle; // chat 消息不带 provider，沿用本会话模型
  await sessions.save(session); // 任务上下文与模型绑定先落盘（即使本轮崩溃也能恢复）

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
      onPersist: () => sessions.save(session),
    });
  });
}

async function handleChat(msg: ChatMessage, emit: EmitFn): Promise<void> {
  const session = await sessions.getOrCreate(msg.sessionId);
  if (!session.title) session.title = deriveTitle(msg.message);
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
    runAgentTurn({
      session,
      handle,
      emit,
      userMessage: msg.message,
      onPersist: () => sessions.save(session),
    }),
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

async function handleConfirm(msg: ConfirmMessage, emit: EmitFn): Promise<void> {
  const session: Session | undefined = await sessions.get(msg.sessionId);
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
          runAgentTurn({
            session,
            handle,
            emit,
            userMessage: systemMessage,
            onPersist: () => sessions.save(session),
          }),
        );
      },
    });
    await sessions.save(session); // 确认账本/pendingRepair 变化落盘
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
          session_store: store.dir,
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

      // 统一异步分发 + 兜底错误处理（如非法 sessionId 的路径穿越拦截）
      void (async () => {
        try {
          switch (msg.type) {
            case "ping":
              send(socket, { type: "pong", ts: msg.ts ?? Date.now() });
              break;
            case "run_task":
              await handleRunTask(msg, emit);
              break;
            case "chat":
              await handleChat(msg, emit);
              break;
            case "confirm":
              await handleConfirm(msg, emit);
              break;
            case "list_sessions":
              send(socket, { type: "sessions_list", sessions: await sessions.list() });
              break;
            case "cancel": {
              const session = sessions.peek(msg.sessionId); // 只关心内存中活着的轮次
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
              await sessions.clear(msg.sessionId); // 内存 + JSON 文件一起删
              console.log(`[server] 会话已删除（含文件）: ${msg.sessionId}`);
              break;
          }
        } catch (err) {
          const sessionId = "sessionId" in msg ? (msg.sessionId as string) : undefined;
          send(socket, {
            type: "error",
            sessionId,
            message: `处理失败: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      })();
    });

    socket.on("close", () => {
      console.log("[ws] client disconnected");
      const owned = sessionsBySocket.get(socket);
      if (owned) {
        for (const sid of owned) {
          sessions.peek(sid)?.abortController?.abort(); // 断线取消活跃轮次（沿用 v1 行为）
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
  console.log(`[agent-server] 会话存储目录: ${store.dir}`);
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
  void startServer(Number(process.env.PORT ?? 8765));
}
