/**
 * 会话落盘层：每个对话一个 JSON 文件（默认 agent-server/data/sessions/<sessionId>.json）。
 *
 * 设计：
 *  - 内存 Map 仍是运行态缓存（见 session.ts），本层只管 存/取/删/列 四件事；
 *  - 原子写（先写 .tmp 再 rename）：进程中途崩溃不会留下半截坏文件；
 *  - sessionId 严格校验（只允许 字母数字._-）：防止 "../../etc/passwd" 式路径穿越；
 *  - 文件损坏时按「不存在」处理并告警，下次保存自动覆盖重建。
 *
 * 存储目录优先级：构造参数 > 环境变量 SESSION_DIR > 默认 <agent-server>/data/sessions/
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelMessage } from "ai";
import type { SessionState } from "@agent-unittest/contracts";
import type { ArtifactEntry, ConfirmationRecord, PendingRepair, Session } from "./session.js";

const SESSION_ID_RE = /^[\w.-]{1,128}$/;

/** 落盘格式（纯 JSON，可直接打开查看/调试） */
export interface StoredSession {
  version: 1;
  sessionId: string;
  title: string | null;
  modelInfo: { provider: string; modelName: string } | null; // 重建 modelHandle 用（key 不存盘！）
  lastActiveAtMs: number;
  messages: ModelMessage[];
  state: SessionState;
  artifacts: ArtifactEntry[];
  confirmations: ConfirmationRecord[];
  pendingRepair: PendingRepair | null;
}

export interface SessionSummaryInfo {
  sessionId: string;
  title: string | null;
  messageCount: number;
  updatedAtMs: number;
}

export class SessionStore {
  readonly dir: string;

  constructor(dir?: string) {
    this.dir =
      dir ??
      (process.env.SESSION_DIR?.trim() ||
        fileURLToPath(new URL("../../data/sessions/", import.meta.url)));
  }

  private filePath(sessionId: string): string {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new Error(`非法 sessionId（只允许字母数字._-，长度≤128）: ${sessionId}`);
    }
    return path.join(this.dir, `${sessionId}.json`);
  }

  async save(session: Session): Promise<void> {
    const file = this.filePath(session.state.sessionId);
    await mkdir(path.dirname(file), { recursive: true });
    const data: StoredSession = {
      version: 1,
      sessionId: session.state.sessionId,
      title: session.title,
      modelInfo: session.modelHandle
        ? { provider: session.modelHandle.provider, modelName: session.modelHandle.modelName }
        : null,
      lastActiveAtMs: session.lastActiveAtMs,
      messages: session.messages,
      state: session.state,
      artifacts: [...session.artifacts.values()],
      confirmations: [...session.confirmations.values()],
      pendingRepair: session.pendingRepair,
    };
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmp, file); // 原子替换
  }

  async load(sessionId: string): Promise<StoredSession | null> {
    const file = this.filePath(sessionId); // 非法 ID 在这里抛错（不被下面的 catch 吞掉）
    try {
      const raw = await readFile(file, "utf-8");
      const data = JSON.parse(raw) as StoredSession;
      if (data.version !== 1 || data.sessionId !== sessionId) {
        console.warn(`[store] 会话文件版本/ID 不匹配，忽略: ${sessionId}`);
        return null;
      }
      return data;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      console.warn(`[store] 会话文件读取失败（按不存在处理）: ${sessionId}`, err);
      return null;
    }
  }

  async delete(sessionId: string): Promise<void> {
    const file = this.filePath(sessionId); // 非法 ID 抛错（调用方决定如何处理）
    await rm(file, { force: true }); // force：文件不存在不算错
  }

  async list(): Promise<SessionSummaryInfo[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return []; // 目录还不存在 = 没有任何已存对话
    }
    const out: SessionSummaryInfo[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const stored = await this.load(f.slice(0, -".json".length));
      if (stored) {
        out.push({
          sessionId: stored.sessionId,
          title: stored.title,
          messageCount: stored.messages.length,
          updatedAtMs: stored.lastActiveAtMs,
        });
      }
    }
    return out;
  }
}
