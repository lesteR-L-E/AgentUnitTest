/**
 * 会话管理（项目文档 §3.3）：按 sessionId 隔离；内存缓存 + JSON 文件落盘。
 *
 * 两层存储的分工：
 *  - 内存 Map（本文件的 sessions）：运行态缓存，读写快，进程重启即失；
 *  - JSON 文件（session-store.ts）：持久层，对话跨重启存活，重访时静默重载。
 *
 * TTL 语义（2026-10-23 决议调整后）：
 *  30 分钟不活跃 → 仅逐出【内存缓存】，文件保留；下次访问自动从文件重载，用户无感。
 *  文件只在 clear_memory（用户清空/删除对话）时删除。
 */
import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type {
  ArtifactKind,
  RepairTestsInput,
  SessionState,
} from "@agent-unittest/contracts";
import { getModel, type ModelHandle } from "../llm/factory.js";
import type { SessionStore, StoredSession } from "./session-store.js";

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
  title: string | null; // 对话标题（列表展示用，取首条消息/任务文件派生）
  modelHandle: ModelHandle | null; // 最近一次 run_task 使用的模型（chat 消息不带 provider，沿用它）
  artifacts: Map<string, ArtifactEntry>; // artifactId → 产物全文
  confirmations: Map<string, ConfirmationRecord>; // §3.7 双重确认登记表
  pendingRepair: PendingRepair | null; // 等待用户确认的断言级修复
  abortController: AbortController | null;
  turnActive: boolean;
  lastActiveAtMs: number;
}

// ───────────────────────── 管理器 ─────────────────────────

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 内存缓存 30 分钟不活跃即逐出（文件保留）
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function newSession(sessionId: string): Session {
  return {
    state: {
      sessionId,
      taskContext: null,
      latest: {},
      artifacts: [],
      cancelRequested: false,
    },
    messages: [],
    title: null,
    modelHandle: null,
    artifacts: new Map(),
    confirmations: new Map(),
    pendingRepair: null,
    abortController: null,
    turnActive: false,
    lastActiveAtMs: Date.now(),
  };
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(
    private ttlMs: number = DEFAULT_TTL_MS,
    private store?: SessionStore,
  ) {
    const timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    timer.unref(); // 不阻止进程退出
  }

  /** 取会话：内存缓存 → 磁盘文件（重载）→ 都没有则新建 */
  async getOrCreate(sessionId: string): Promise<Session> {
    const cached = this.sessions.get(sessionId);
    if (cached) {
      this.touch(cached);
      return cached;
    }
    const stored = (await this.store?.load(sessionId)) ?? null;
    const session = stored ? this.hydrate(stored) : newSession(sessionId);
    this.sessions.set(sessionId, session);
    this.touch(session);
    return session;
  }

  /** 同 getOrCreate 但不新建：不存在返回 undefined（confirm 等场景用） */
  async get(sessionId: string): Promise<Session | undefined> {
    const cached = this.sessions.get(sessionId);
    if (cached) {
      this.touch(cached);
      return cached;
    }
    const stored = await this.store?.load(sessionId);
    if (!stored) return undefined;
    const session = this.hydrate(stored);
    this.sessions.set(sessionId, session);
    this.touch(session);
    return session;
  }

  /** 同步只查内存缓存（cancel/断线中止等只关心"活着的轮次"的场景） */
  peek(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** 把文件内容还原成活会话（模型句柄按存的 provider/model 重建，key 缺失则置空） */
  private hydrate(stored: StoredSession): Session {
    const session = newSession(stored.sessionId);
    session.title = stored.title;
    session.messages = stored.messages;
    session.state = stored.state;
    session.artifacts = new Map(stored.artifacts.map((a) => [a.artifactId, a]));
    session.confirmations = new Map(stored.confirmations.map((c) => [c.confirmId, c]));
    session.pendingRepair = stored.pendingRepair;
    session.lastActiveAtMs = stored.lastActiveAtMs;
    if (stored.modelInfo) {
      try {
        session.modelHandle = getModel(stored.modelInfo.provider, stored.modelInfo.modelName);
      } catch {
        session.modelHandle = null; // 环境无 key：等下一次 run_task 带上
      }
    }
    return session;
  }

  /** 落盘（在关键节点调用：任务上下文落位后 / 每轮结束 / 确认流程变化后） */
  async save(session: Session): Promise<void> {
    await this.store?.save(session);
  }

  touch(session: Session): void {
    session.lastActiveAtMs = Date.now();
  }

  /** 清空/删除对话：中止运行中轮次 + 删内存 + 删文件 */
  async clear(sessionId: string): Promise<void> {
    this.sessions.get(sessionId)?.abortController?.abort();
    this.sessions.delete(sessionId);
    await this.store?.delete(sessionId);
  }

  count(): number {
    return this.sessions.size; // 内存缓存数（health 用）
  }

  /** 对话列表（前端「选择对话继续/新建对话」）：磁盘 + 内存中尚未落盘的，按最近活跃倒序 */
  async list(): Promise<
    Array<{ sessionId: string; title: string | null; messageCount: number; updatedAtMs: number }>
  > {
    const fromStore = this.store ? await this.store.list() : [];
    const seen = new Set(fromStore.map((s) => s.sessionId));
    for (const [id, s] of this.sessions) {
      if (!seen.has(id)) {
        fromStore.push({
          sessionId: id,
          title: s.title,
          messageCount: s.messages.length,
          updatedAtMs: s.lastActiveAtMs,
        });
      }
    }
    return fromStore.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  /** 内存缓存清理：只逐出内存，不删文件（重访时静默重载） */
  private sweep(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActiveAtMs > this.ttlMs) {
        session.abortController?.abort();
        this.sessions.delete(sessionId);
        console.log(`[session] 内存缓存逐出（文件保留，重访自动重载）: ${sessionId}`);
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
