/**
 * 会话管理（项目文档 §3.3）：按 sessionId 隔离，30 分钟滑动 TTL。
 * SessionState 形状由契约冻结；对话历史（ModelMessage[]）由 runtime 自管，不入契约。
 */
import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type {
  ArtifactKind,
  RepairTestsInput,
  SessionState,
} from "@agent-unittest/contracts";
import type { ModelHandle } from "../llm/factory.js";

// ───────────────────────── 会话内结构 ─────────────────────────

export interface ConfirmationRecord {
  confirmId: string;
  stage: "content" | "risk"; // 第一次=变更内容 / 第二次=风险提示
  question: string;
  detail: string;
  decision?: "approve" | "reject";
  decidedAtMs?: number;
}

export interface PendingRepair {
  args: RepairTestsInput; // 暂存的原始调用参数（用户批准后由服务端注入确认凭证执行）
  contentConfirmId?: string;
  riskConfirmId?: string;
  stage: "content" | "risk";
}

export interface ArtifactEntry {
  artifactId: string;
  kind: ArtifactKind;
  content: string;
  summary?: string;
  createdAtMs: number;
}

export interface Session {
  state: SessionState; // 契约冻结的任务状态（taskContext / latest / artifacts / cancelRequested）
  messages: ModelMessage[]; // 对话历史（AI SDK 消息格式）
  modelHandle: ModelHandle | null; // 最近一次 run_task 使用的模型（chat 消息不带 provider，沿用它）
  artifacts: Map<string, ArtifactEntry>; // artifactId → 产物全文
  confirmations: Map<string, ConfirmationRecord>; // §3.7 双重确认登记表
  pendingRepair: PendingRepair | null; // 等待用户确认的断言级修复
  abortController: AbortController | null;
  turnActive: boolean;
  lastActiveAtMs: number;
}

// ───────────────────────── 管理器 ─────────────────────────

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 分钟（与 v1 SessionMemoryManager 一致）
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private onExpired?: (sessionId: string) => void;

  constructor(private ttlMs: number = DEFAULT_TTL_MS) {
    const timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    timer.unref(); // 不阻止进程退出
  }

  setExpirationHandler(fn: (sessionId: string) => void): void {
    this.onExpired = fn;
  }

  getOrCreate(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        state: {
          sessionId,
          taskContext: null,
          latest: {},
          artifacts: [],
          cancelRequested: false,
        },
        messages: [],
        modelHandle: null,
        artifacts: new Map(),
        confirmations: new Map(),
        pendingRepair: null,
        abortController: null,
        turnActive: false,
        lastActiveAtMs: Date.now(),
      };
      this.sessions.set(sessionId, session);
    }
    this.touch(session);
    return session;
  }

  get(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (session) this.touch(session);
    return session;
  }

  touch(session: Session): void {
    session.lastActiveAtMs = Date.now();
  }

  clear(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.abortController?.abort();
    this.sessions.delete(sessionId);
  }

  count(): number {
    return this.sessions.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActiveAtMs > this.ttlMs) {
        session.abortController?.abort();
        this.sessions.delete(sessionId);
        this.onExpired?.(sessionId);
        console.log(`[session] TTL 过期清理: ${sessionId}`);
      }
    }
  }
}

// ───────────────────────── 产物存取（§3.2(4) 摘要+ID 机制） ─────────────────────────

export function putArtifact(
  session: Session,
  kind: ArtifactKind,
  content: string,
  summary?: string,
): string {
  const artifactId = randomUUID();
  const createdAtMs = Date.now();
  session.artifacts.set(artifactId, { artifactId, kind, content, summary, createdAtMs });
  session.state.artifacts.push({ artifactId, kind, path: null, summary: summary ?? null, createdAtMs });
  return artifactId;
}

export function lastArtifactIdOfKind(session: Session, kind: ArtifactKind): string | undefined {
  for (let i = session.state.artifacts.length - 1; i >= 0; i--) {
    const ref = session.state.artifacts[i]!;
    if (ref.kind === kind) return ref.artifactId;
  }
  return undefined;
}
