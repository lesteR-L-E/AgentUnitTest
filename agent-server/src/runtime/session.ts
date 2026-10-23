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

  /**
   * 取会话（三级查找）：
   *  1. 内存缓存命中 → touch 续命后直接返回；
   *  2. 未命中 → 从 JSON 文件加载，有则 hydrate 成活会话（跨重启续聊就发生在这一步）；
   *  3. 磁盘也没有 → 新建空会话放入缓存。
   * 非法 sessionId（路径穿越样式）会在 store 层抛错，由 server 的分发 catch 统一回错误消息。
   */
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

  /** 同 getOrCreate 的三级查找，但不新建：内存与磁盘都没有 → 返回 undefined（confirm 等「必须已有会话」的场景用，避免确认消息凭空造会话） */
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

  /**
   * 把 JSON 文件内容还原成活会话。
   * 关键分支：存过 modelInfo → 尝试用当前环境的 key 重建模型句柄；重建失败（如环境没 key）
   * 置 null 而不报错——下一次 run_task 会重新绑定模型，chat 则走 defaultHandle 兜底。
   * Map 类字段（artifacts/confirmations）从数组还原；运行态字段（abortController/turnActive）一律归零。
   */
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

  /** 落盘（关键节点调用：任务上下文落位后 / 每轮对话结束 / 确认流程变化后）。分支：未配置 store（如部分冒烟脚本）→ 静默跳过，退化为纯内存模式 */
  async save(session: Session): Promise<void> {
    await this.store?.save(session);
  }

  touch(session: Session): void {
    session.lastActiveAtMs = Date.now();
  }

  /** 删除对话（clear_memory 消息触发）：先 abort 运行中轮次（若有）→ 删内存缓存 → 删 JSON 文件。文件删除失败不阻塞（store 层已吞错），内存删除必定生效 */
  async clear(sessionId: string): Promise<void> {
    this.sessions.get(sessionId)?.abortController?.abort();
    this.sessions.delete(sessionId);
    await this.store?.delete(sessionId);
  }

  count(): number {
    return this.sessions.size; // 内存缓存数（health 用）
  }

  /** 对话列表（前端「选择对话继续/新建对话」的数据源）：以磁盘文件为主，合并内存中尚未落盘的会话（按 sessionId 去重），结果按最近活跃时间倒序 */
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

  /**
   * 定期清理（每 5 分钟）：遍历内存缓存，逐出超过 TTL 未活跃的会话。
   * 分支：逐出时若仍有运行中轮次 → 先 abort；【只删内存、不删文件】——
   * 该对话下次被访问时走 getOrCreate 的第 2 级（磁盘重载），用户全程无感知。
   */
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

/**
 * 产物存档（双写）：全文写入 session.artifacts（档案室 Map），
 * 同时在 state.artifacts 登记「ID + 摘要」索引（目录页，供 LLM 上下文引用）。
 * 返回 artifactId —— 调用方把它塞进 test_code 等 WS 消息，前端/LLM 之后凭 ID 调 read_artifact 取全文。
 */
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

/** 在目录页倒序查找：返回指定类型最近一份产物的 ID；一份都没有 → undefined（发消息时省略 artifactId 字段） */
export function lastArtifactIdOfKind(session: Session, kind: ArtifactKind): string | undefined {
  for (let i = session.state.artifacts.length - 1; i >= 0; i--) {
    const ref = session.state.artifacts[i]!;
    if (ref.kind === kind) return ref.artifactId;
  }
  return undefined;
}
