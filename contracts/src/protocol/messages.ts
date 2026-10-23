import { z } from "zod";
import { ToolNameSchema } from "../tools/definitions.js";

/**
 * WebSocket 协议 v2（项目文档 §5）—— 前后端消息的单一事实源。
 *
 * 约定：
 * - 所有消息以 `type` 为判别字段（discriminated union），收到消息先 parse 再处理；
 * - 客户端消息 .strict()：出现未知字段直接校验失败，尽早暴露前后端不同步；
 * - v1 的 `run_agent` 兼容映射在服务端接入层处理，契约只认 `run_task`；
 * - 心跳：客户端每 30s 发 ping，服务端回 pong；两次丢失判定断线（§5.1）。
 */

// ════════════════════ 客户端 → 服务端 ════════════════════

export const RunTaskMessageSchema = z
  .object({
    type: z.literal("run_task"),
    sessionId: z.string(),
    code: z.string().describe("用户选中的源码"),
    filePath: z.string(),
    workspaceRoot: z.string(),
    provider: z.string().describe('"deepseek" | "openai" | "anthropic"'),
    model: z.string(),
    apiKey: z.string().optional().describe("⚠️ 仅本机回环使用；严禁写入任何日志"),
    baseUrl: z.string().optional(),
    instruction: z.string().optional().describe("生成前对话形成的附加测试约束"),
  })
  .strict();
export type RunTaskMessage = z.infer<typeof RunTaskMessageSchema>;

export const ChatMessageSchema = z
  .object({
    type: z.literal("chat"),
    sessionId: z.string(),
    message: z.string(),
    queue: z.boolean().default(true).describe("任务运行中默认排队，任务结束后作为下一轮输入"),
  })
  .strict();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** 双重确认决定（§3.7：用户点击侧边栏 同意/拒绝 按钮时发送） */
export const ConfirmMessageSchema = z
  .object({
    type: z.literal("confirm"),
    sessionId: z.string(),
    confirmId: z.string(),
    decision: z.enum(["approve", "reject"]),
  })
  .strict();
export type ConfirmMessage = z.infer<typeof ConfirmMessageSchema>;

export const CancelMessageSchema = z
  .object({ type: z.literal("cancel"), sessionId: z.string() })
  .strict();
export type CancelMessage = z.infer<typeof CancelMessageSchema>;

export const ClearMemoryMessageSchema = z
  .object({ type: z.literal("clear_memory"), sessionId: z.string() })
  .strict();
export type ClearMemoryMessage = z.infer<typeof ClearMemoryMessageSchema>;

export const PingMessageSchema = z
  .object({
    type: z.literal("ping"),
    sessionId: z.string().optional(),
    ts: z.number().optional(),
  })
  .strict();
export type PingMessage = z.infer<typeof PingMessageSchema>;

/** 请求已保存的对话列表（前端「选择对话继续 / 新建对话」用，无需 sessionId） */
export const ListSessionsMessageSchema = z.object({ type: z.literal("list_sessions") }).strict();
export type ListSessionsMessage = z.infer<typeof ListSessionsMessageSchema>;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  RunTaskMessageSchema,
  ChatMessageSchema,
  ConfirmMessageSchema,
  CancelMessageSchema,
  ClearMemoryMessageSchema,
  ListSessionsMessageSchema,
  PingMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ════════════════════ 服务端 → 客户端 ════════════════════

export const PongMessageSchema = z.object({ type: z.literal("pong"), ts: z.number().optional() });

/** 工具调用事件（取代 v1 的 step；前端渲染为任务卡片，callId 串起 running→done/error） */
export const ToolCallMessageSchema = z.object({
  type: z.literal("tool_call"),
  sessionId: z.string(),
  callId: z.string(),
  tool: ToolNameSchema,
  status: z.enum(["running", "done", "error"]),
  summary: z.string().optional().describe('给 UI 的一句话摘要，如 "解析出 5 个方法"'),
  error: z.string().optional(),
});
export type ToolCallMessage = z.infer<typeof ToolCallMessageSchema>;

/** Agent 文本流式增量 */
export const TokenMessageSchema = z.object({
  type: z.literal("token"),
  sessionId: z.string(),
  turnId: z.string().describe("对话轮次 ID：同一轮的 token 与 agent_message 共享"),
  delta: z.string(),
});
export type TokenMessage = z.infer<typeof TokenMessageSchema>;

/** 一轮 Agent 回复完成（完整文本，供前端落历史/重连恢复） */
export const AgentMessageSchema = z.object({
  type: z.literal("agent_message"),
  sessionId: z.string(),
  turnId: z.string(),
  text: z.string(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/** 生成/修复后的测试源码推送 */
export const TestCodeMessageSchema = z.object({
  type: z.literal("test_code"),
  sessionId: z.string(),
  testCode: z.string(),
  filePath: z.string().describe("展示文件名，如 CalculatorTest.java"),
  artifactId: z.string().optional().describe("供后续 read_artifact 引用"),
});
export type TestCodeMessage = z.infer<typeof TestCodeMessageSchema>;

/** 任务级最终结果 */
export const ResultMessageSchema = z.object({
  type: z.literal("result"),
  sessionId: z.string(),
  passed: z.boolean(),
  testCount: z.number().int(),
  failedCount: z.number().int().optional(),
  message: z.string().optional(),
  testCode: z.string().optional(),
  resultFilePath: z.string().optional(),
  testCodeFilePath: z.string().optional(),
  diagnosisSummary: z.string().optional().describe("Diagnosis.summary（v2 扩展）"),
});
export type ResultMessage = z.infer<typeof ResultMessageSchema>;

/**
 * 双重确认请求（§3.7）：UI 据此渲染 同意/拒绝 按钮，
 * 用户点击结果经 confirm 客户端消息回传。两次确认 = 两条本消息（stage 依次为 content → risk）。
 */
export const ConfirmationRequestMessageSchema = z.object({
  type: z.literal("confirmation_request"),
  sessionId: z.string(),
  confirmId: z.string(),
  stage: z.enum(["content", "risk"]), // content=第一次（变更内容对照）/ risk=第二次（风险提示）
  question: z.string(),
  detail: z.string().default(""),
});
export type ConfirmationRequestMessage = z.infer<typeof ConfirmationRequestMessageSchema>;

export const ErrorMessageSchema = z.object({
  type: z.literal("error"),
  sessionId: z.string().optional(),
  message: z.string(),
});
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

export const CancelledMessageSchema = z.object({
  type: z.literal("cancelled"),
  sessionId: z.string(),
  message: z.string().optional(),
});
export type CancelledMessage = z.infer<typeof CancelledMessageSchema>;

/** 会话过期通知（持久化落地后仅保留作协议预留：内存缓存淘汰改为静默重载） */
export const SessionExpiredMessageSchema = z.object({
  type: z.literal("session_expired"),
  sessionId: z.string(),
});
export type SessionExpiredMessage = z.infer<typeof SessionExpiredMessageSchema>;

/** 对话摘要（列表项） */
export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  title: z.string().nullish(), // 对话标题（取首条消息/文件名派生）
  messageCount: z.number().int().nonnegative(),
  updatedAtMs: z.number().int(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** list_sessions 的应答：全部已保存对话，按最近活跃倒序 */
export const SessionsListMessageSchema = z.object({
  type: z.literal("sessions_list"),
  sessions: z.array(SessionSummarySchema),
});
export type SessionsListMessage = z.infer<typeof SessionsListMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  PongMessageSchema,
  ToolCallMessageSchema,
  TokenMessageSchema,
  AgentMessageSchema,
  TestCodeMessageSchema,
  ResultMessageSchema,
  ConfirmationRequestMessageSchema,
  SessionsListMessageSchema,
  ErrorMessageSchema,
  CancelledMessageSchema,
  SessionExpiredMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
