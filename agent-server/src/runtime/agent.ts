/**
 * Agent 核心（M1 第 4 步）：基于 Vercel AI SDK 的工具循环 + §3.7 双重确认护栏。
 *
 * 职责：
 *  - buildTools：把 TOOL_CONTRACTS 注册表转成 AI SDK tools（LLM 看到的"工具说明书"）
 *  - runAgentTurn：一轮对话/任务（streamText 多步循环 → 流事件映射为 WS 协议 v2 消息）
 *  - handleRepairCall：repair_tests 的工具层硬校验（断言级修改必须走双重确认）
 *  - handleConfirmDecision：确认按钮回传处理（content → risk → 服务端代执行修复 → 恢复轮次）
 */
import { randomUUID } from "node:crypto";
import { stepCountIs, streamText, tool } from "ai";
import {
  RepairTestsInputSchema,
  TOOL_CONTRACTS,
  type ConfirmMessage,
  type GeneratedTest,
  type ServerMessage,
  type ToolName,
} from "@agent-unittest/contracts";
import type { ModelHandle } from "../llm/factory.js";
import { MAX_TOOL_STEPS, SYSTEM_PROMPT } from "./prompt.js";
import { lastArtifactIdOfKind, type Session } from "./session.js";
import * as stubs from "./stubs.js";

export type EmitFn = (msg: ServerMessage) => void;

/** 给 LLM 看的工具用途说明（会进入 JSON Schema 的 description） */
const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  analyze_code: "解析 Java 源码结构：类/方法/字段/注解/imports/依赖，输出 CodeAnalysis。生成测试任务的第一步。",
  read_project_file: "读取项目内源文件（相对 workspaceRoot 路径，只读；越界路径会被拒绝）。用于失败追问与依赖下钻。",
  search_project: "按符号名或文本检索项目文件（只读）。用于定位依赖类的源文件。",
  inspect_environment: "探测项目环境：构建工具（Maven/Gradle）、测试框架、mock 库、测试目录等。",
  generate_tests: "生成符合项目规范的测试代码。用户约束放 userConstraints；迭代场景填 previousTestCode 与 userFeedback。",
  run_tests: "将测试代码写入沙箱并通过 Maven/Gradle 执行，返回结构化结果（通过数/失败详情）。",
  diagnose_failures: "分析失败原因并分类，输出各项是否可自动修复（autoRepairable）与是否需双重确认（requiresDoubleConfirm）。",
  repair_tests: "修复测试代码。断言级修改必须设 assertionLevelChange=true，系统会自动发起双重确认；严禁编造确认凭证 ID。",
  read_artifact: "按 artifactId 读取历史产物（测试源码/失败详情/诊断报告/构建日志）。追问时优先用它引用真实数据。",
};

// ───────────────────────── 任务消息构造 ─────────────────────────

/** run_task → 预设用户消息（「任务与对话统一为消息」，项目文档 §3.2(2)）。分支：instruction 非空时追加「用户附加约束」一行——生成前对话谈好的约束就是这样进入 LLM 上下文的 */
export function buildTaskUserMessage(task: {
  code: string;
  filePath: string;
  instruction?: string;
}): string {
  return [
    "请为以下选中代码生成单元测试并运行至结束，然后汇报结果。",
    `文件: ${task.filePath}`,
    task.instruction ? `用户附加约束: ${task.instruction}` : null,
    "```java",
    task.code,
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

// ───────────────────────── 工具执行 ─────────────────────────

/** 类型守卫：判断工具返回值是否为 {ok:true,data} 成功信封（失败信封不触发副作用推送） */
function isOk(raw: unknown): raw is { ok: true; data: Record<string, unknown> } {
  return typeof raw === "object" && raw !== null && (raw as { ok?: unknown }).ok === true;
}

/** 把生成/修复后的测试源码推给前端（test_code 消息），附带最新一份 test_code 产物的 ID（前端与 LLM 之后可凭 ID 调 read_artifact 取全文） */
function emitTestCode(session: Session, emit: EmitFn, generated: GeneratedTest): void {
  emit({
    type: "test_code",
    sessionId: session.state.sessionId,
    testCode: generated.code,
    filePath: `${generated.className}.java`,
    artifactId: lastArtifactIdOfKind(session, "test_code"),
  });
}

/**
 * 把工具结果压缩成一句人话，填进 tool_call 消息的 summary 字段（侧边栏任务状态行显示用）。
 * 分支：按工具名各取关键字段；未知工具 / data 缺失 / 取字段抛错 → 一律返回 undefined（摘要失败绝不影响主流程）。
 */
function summarizeToolResult(name: ToolName, data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  try {
    switch (name) {
      case "analyze_code":
        return `解析出 ${((data.methods as unknown[]) ?? []).length} 个方法（tier=${data.parseTier}）`;
      case "inspect_environment":
        return `构建工具=${data.buildTool}，测试框架=${data.testFramework}`;
      case "generate_tests":
      case "repair_tests":
        return `生成 ${data.className}（${(String(data.code ?? "").match(/@Test/g) ?? []).length} 个用例）`;
      case "run_tests":
        return `${data.passed ? "✓ 全部通过" : "✗ 有失败"}：${data.message ?? ""}`;
      case "diagnose_failures":
        return data.summary ? String(data.summary).slice(0, 100) : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * 所有工具的统一执行入口（buildTools 注册给 AI SDK 的 execute 回调都指向这里）。
 * 流程分支：
 *  1. repair_tests → 转交 handleRepairCall 走护栏（可能不执行本体，改发确认请求）；
 *  2. 其他工具 → 分发到对应桩实现；analyze_code 成功后额外把结果写入 latest.codeAnalysis；
 *  3. 桩实现抛异常 → 兜底转成 {ok:false, retryable:true} 结构化错误（工具永不炸会话，LLM 自己决定重试或求助）；
 *  4. 成功后的副作用推送：generate_tests → test_code 消息；run_tests → result 消息（前端结果卡）。
 * 返回值由 SDK 自动喂回 LLM，成为下一步推理的输入。
 */
async function executeTool(
  name: ToolName,
  args: unknown,
  session: Session,
  emit: EmitFn,
): Promise<unknown> {
  const ctx = { session };
  let raw: unknown;
  try {
    switch (name) {
      case "analyze_code": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await stubs.analyzeCodeStub(args as any);
        if (r.ok) session.state.latest.codeAnalysis = r.data;
        raw = r;
        break;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      case "read_project_file": raw = await stubs.readProjectFileStub(args as any, ctx); break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      case "search_project": raw = await stubs.searchProjectStub(args as any); break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      case "inspect_environment": raw = await stubs.inspectEnvironmentStub(args as any, ctx); break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      case "generate_tests": raw = await stubs.generateTestsStub(args as any, ctx); break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      case "run_tests": raw = await stubs.runTestsStub(args as any, ctx); break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      case "diagnose_failures": raw = await stubs.diagnoseFailuresStub(args as any, ctx); break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      case "read_artifact": raw = await stubs.readArtifactStub(args as any, ctx); break;
      case "repair_tests": return await handleRepairCall(session, args, emit);
    }
  } catch (err) {
    raw = { ok: false, error: `工具执行异常: ${(err as Error).message}`, retryable: true };
  }

  // 执行成功后的副作用推送（协议 v2 §5.3）
  const sessionId = session.state.sessionId;
  if (isOk(raw)) {
    if (name === "generate_tests") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emitTestCode(session, emit, raw.data as any);
    }
    if (name === "run_tests") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = raw.data as any;
      emit({
        type: "result",
        sessionId,
        passed: Boolean(d.passed),
        testCount: Number(d.testCount ?? 0),
        failedCount: Number(d.failedCount ?? 0),
        message: d.message ?? undefined,
        diagnosisSummary: session.state.latest.diagnosis?.summary,
      });
    }
  }
  return raw;
}

// ───────────────────────── §3.7 断言双重确认：工具层硬校验 ─────────────────────────

/**
 * repair_tests 的守卫包装：
 *  - 非断言级修改 → 直接放行；
 *  - 断言级修改且无确认凭证 → 发起第 1 步确认（confirmation_request），返回「等待确认」；
 *  - 断言级修改带凭证 → 校验凭证真实登记且已批准，否则拒绝（防 LLM 编造 ID）。
 */
export async function handleRepairCall(
  session: Session,
  args: unknown,
  emit: EmitFn,
): Promise<unknown> {
  const parsed = RepairTestsInputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `repair_tests 参数违反契约: ${parsed.error.message}`, retryable: false };
  }
  const a = parsed.data;

  if (a.assertionLevelChange) {
    if (!a.confirmations) {
      const confirmId = randomUUID();
      const detail = [
        `目标测试类: ${a.generatedTest.className}`,
        `修改要求: ${a.userInstruction ?? "(来自诊断建议)"}`,
        a.diagnosis ? `诊断摘要: ${a.diagnosis.summary}` : null,
        "批准本步后将进入第二次确认（风险提示）。",
      ]
        .filter(Boolean)
        .join("\n");
      session.confirmations.set(confirmId, {
        confirmId,
        stage: "content",
        question: "确认修改断言（第 1/2 步：变更内容）",
        detail,
      });
      session.pendingRepair = { args: a, contentConfirmId: confirmId, stage: "content" };
      emit({
        type: "confirmation_request",
        sessionId: session.state.sessionId,
        confirmId,
        stage: "content",
        question: "确认修改断言（第 1/2 步：变更内容）",
        detail,
      });
      return {
        ok: false,
        error:
          "断言级修改需要双重确认。确认请求已发送给用户（第 1/2 步：变更内容）。请告知用户在弹窗中确认，然后结束本轮，不要重复调用本工具。",
        retryable: false,
      };
    }
    const c1 = session.confirmations.get(a.confirmations.contentConfirmId);
    const c2 = session.confirmations.get(a.confirmations.riskConfirmId);
    if (!c1 || c1.decision !== "approve" || !c2 || c2.decision !== "approve") {
      return {
        ok: false,
        error: "确认凭证无效：ID 不存在于本会话登记或未获批准，已拒绝执行（§3.7 工具层硬校验）",
        retryable: false,
      };
    }
  }

  const r = await stubs.repairTestsStub(a, { session });
  if (r.ok) emitTestCode(session, emit, r.data);
  return r;
}

export interface ConfirmHooks {
  /** 确认流程结束后需要发起新一轮 Agent 对话时回调（由 server 入队执行） */
  onResume: (systemMessage: string) => void;
}

/**
 * confirm 消息（用户点了确认按钮）处理。全部分支：
 *  - confirmId 不在账本 → 报 error（伪造/过期 ID）；
 *  - 该确认已有决定 → 报 error（拒绝重复提交）；
 *  - 无 pendingRepair → 静默返回（理论上不发生：确认请求只会伴随暂存的修复产生）；
 *  - decision=reject（任意阶段）→ 清暂存，注入「用户已拒绝」系统消息开新一轮（Agent 会改口问用户意图）；
 *  - decision=approve 且 stage=content → 登记第二步（risk）确认并发出新的 confirmation_request；
 *  - decision=approve 且 stage=risk → 服务端把两个确认 ID 注入暂存参数、代 LLM 执行修复，
 *    推送 test_code，再注入「已确认已修复，去 run_tests 重跑」系统消息开新一轮。
 */
export async function handleConfirmDecision(
  session: Session,
  msg: ConfirmMessage,
  emit: EmitFn,
  hooks: ConfirmHooks,
): Promise<void> {
  const sessionId = session.state.sessionId;
  const rec = session.confirmations.get(msg.confirmId);
  if (!rec) {
    emit({ type: "error", sessionId, message: `confirmId 不存在: ${msg.confirmId}` });
    return;
  }
  if (rec.decision) {
    emit({ type: "error", sessionId, message: "该确认已处理过，请勿重复提交" });
    return;
  }
  rec.decision = msg.decision;
  rec.decidedAtMs = Date.now();

  const pending = session.pendingRepair;
  if (!pending) return;

  if (msg.decision === "reject") {
    session.pendingRepair = null;
    hooks.onResume(
      "[系统] 用户拒绝了本次断言修改。请尊重用户决定，不要重试相同修改；向用户询问下一步意图（例如先修改被测代码，或调整测试策略）。",
    );
    return;
  }

  if (rec.stage === "content") {
    const riskId = randomUUID();
    const detail =
      "⚠️ 风险提示：本次失败的诊断分类涉及断言与被测代码行为分歧（ASSERTION_ERROR / SUSPECTED_SOURCE_BUG）。修改断言可能掩盖被测代码的真实缺陷。请确认已知悉该风险。";
    session.confirmations.set(riskId, {
      confirmId: riskId,
      stage: "risk",
      question: "再次确认修改断言（第 2/2 步：风险提示）",
      detail,
    });
    pending.riskConfirmId = riskId;
    pending.stage = "risk";
    emit({
      type: "confirmation_request",
      sessionId,
      confirmId: riskId,
      stage: "risk",
      question: "再次确认修改断言（第 2/2 步：风险提示）",
      detail,
    });
    return;
  }

  // risk 已批准 → 服务端代执行暂存的修复（凭证由服务端注入，不依赖 LLM 记忆）
  const args = {
    ...pending.args,
    confirmations: {
      contentConfirmId: pending.contentConfirmId!,
      riskConfirmId: pending.riskConfirmId!,
    },
  };
  session.pendingRepair = null;
  // 桩实现不会失败（返回类型恒为 ok:true）；M2 换真实现后此处需恢复 ok:false 分支处理
  const r = await stubs.repairTestsStub(args, { session });
  emitTestCode(session, emit, r.data);
  hooks.onResume(
    "[系统] 用户已完成断言修改的双重确认，修复已执行、新测试代码已保存。请勿再次调用 repair_tests，直接调用 run_tests 重跑，并向用户汇报结果。",
  );
}

// ───────────────────────── Agent Loop ─────────────────────────

/**
 * 把契约注册表（TOOL_CONTRACTS）翻译成 AI SDK 的 tools 集合。
 * 每个工具三要素：description（LLM 看的用途说明）、inputSchema（zod → JSON Schema，LLM 传参据此校验）、
 * execute（统一走 executeTool：护栏、副作用、错误信封都在那里收口）。
 * 每轮对话新建一次（闭包捕获当前 session 与 emit）。
 */
function buildTools(session: Session, emit: EmitFn) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};
  for (const [name, contract] of Object.entries(TOOL_CONTRACTS)) {
    tools[name] = tool({
      description: TOOL_DESCRIPTIONS[name as ToolName],
      inputSchema: contract.input,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: async (args: any) => executeTool(name as ToolName, args, session, emit),
    });
  }
  return tools;
}

export interface RunTurnOptions {
  session: Session;
  handle: ModelHandle;
  emit: EmitFn;
  userMessage: string;
  /** 轮次结束（含失败/取消）后回调：server 用它把会话落盘 */
  onPersist?: () => void | Promise<void>;
}

/**
 * 执行一轮 Agent 对话（run_task 与 chat 走同一入口——「任务即消息」）。
 * 内部流程：用户消息入历史 → streamText 启动多步循环（SDK 自动完成：LLM 要调工具 → zod 校验参数
 * → execute → 结果喂回 → 再问 LLM……直到 LLM 只回文本，或达 stopWhen 的 25 步上限）
 * → 消费 result.stream 把分片实时翻译成协议 v2 消息 → 轮末把本轮 assistant/tool 消息落入历史（跨轮记忆）→ token 记账。
 * 关键分支：
 *  - catch：若是 cancel 触发的 abort → 发 cancelled；其他异常 → 发 error（轮次失败不清历史，用户可继续聊）；
 *  - finally：无论成败/取消 → 复位轮次状态 + onPersist 落盘（重启续聊靠这一步）。
 */
export async function runAgentTurn(opts: RunTurnOptions): Promise<void> {
  const { session, handle, emit, userMessage } = opts;
  const sessionId = session.state.sessionId;
  const turnId = randomUUID();

  session.messages.push({ role: "user", content: userMessage });
  session.turnActive = true;
  const ac = new AbortController();
  session.abortController = ac;

  let assistantText = "";
  try {
    const result = streamText({
      model: handle.model,
      system: SYSTEM_PROMPT,
      messages: session.messages,
      tools: buildTools(session, emit),
      stopWhen: stepCountIs(MAX_TOOL_STEPS), // 轮数护栏（§3.2(1)）
      abortSignal: ac.signal,
    });

    // v7：fullStream 已弃用，改名为 stream（分片类型不变）
    for await (const part of result.stream) {
      switch (part.type) {
        case "text-delta": {
          assistantText += part.text; // v7 的 text-delta 分片字段名是 text
          emit({ type: "token", sessionId, turnId, delta: part.text });
          break;
        }
        case "tool-call": {
          emit({
            type: "tool_call",
            sessionId,
            callId: part.toolCallId,
            tool: part.toolName as ToolName,
            status: "running",
          });
          break;
        }
        case "tool-result": {
          const out = part.output as { ok?: boolean; error?: string; data?: Record<string, unknown> };
          const failed = out?.ok === false;
          emit({
            type: "tool_call",
            sessionId,
            callId: part.toolCallId,
            tool: part.toolName as ToolName,
            status: failed ? "error" : "done",
            error: failed ? out.error : undefined,
            summary: failed ? undefined : summarizeToolResult(part.toolName as ToolName, out?.data),
          });
          break;
        }
        case "error": {
          emit({ type: "error", sessionId, message: `[模型/流错误] ${String(part.error)}` });
          break;
        }
        default:
          break; // 其余分片（text-start/finish 等）骨架阶段不透传
      }
    }

    // 本轮产生的 assistant/tool 消息落入会话历史（跨轮记忆）
    // v7：response.messages 已弃用，改用 responseMessages（全部步骤的累计响应消息）
    const newMessages = await result.responseMessages;
    session.messages.push(...newMessages);

    // v7：totalUsage 已弃用，usage 本身即全步骤累计值
    const usage = await result.usage;
    console.log(
      `[agent] session=${sessionId} turn=${turnId.slice(0, 8)} tokens: in=${usage.inputTokens} out=${usage.outputTokens} total=${usage.totalTokens}`,
    );

    if (assistantText.trim()) {
      emit({ type: "agent_message", sessionId, turnId, text: assistantText });
    }
  } catch (err) {
    if (ac.signal.aborted) {
      emit({ type: "cancelled", sessionId, message: "任务已取消" });
    } else {
      console.error("[agent] turn failed:", err);
      emit({
        type: "error",
        sessionId,
        message: `Agent 执行失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } finally {
    session.turnActive = false;
    session.abortController = null;
    session.lastActiveAtMs = Date.now();
    try {
      await opts.onPersist?.(); // 轮次结束落盘：重启后可从这里继续聊
    } catch (err) {
      console.error("[agent] 会话落盘失败:", err);
    }
  }
}
