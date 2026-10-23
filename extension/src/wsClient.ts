import WebSocket from "ws";

/**
 * WS 客户端（协议 v2）：心跳 30s、断线指数退避重连（1s 起步、15s 封顶）。
 * 收到的每条消息经 JSON.parse 后原样交给 onMessage（契约校验在服务端已做，
 * 前端渲染时对未知 type 走 default 分支忽略）。
 */
export class WsClient {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private shouldRun = false;
  private reconnectDelay = 1000;

  constructor(
    private readonly url: string,
    private readonly onMessage: (msg: Record<string, unknown>) => void,
    private readonly onStatus?: (status: "connected" | "disconnected") => void,
  ) {}

  connect(): void {
    this.shouldRun = true;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on("open", () => {
      this.reconnectDelay = 1000;
      this.onStatus?.("connected");
      // 心跳（协议 §5.1）：30s 一次 ping，服务端回 pong
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        }
      }, 30_000);
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        this.onMessage(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch {
        // 非法 JSON：忽略（服务端出站都有契约校验，走到这里说明有 bug）
      }
    });
    ws.on("close", () => {
      this.clearPing();
      this.onStatus?.("disconnected");
      this.scheduleReconnect();
    });
    ws.on("error", () => {
      // close 事件会紧随其后，重连逻辑统一在那里
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 15_000);
    const t = setTimeout(() => {
      if (this.shouldRun) this.open();
    }, delay);
    t.unref();
  }

  /** 发送消息；未连接返回 false（调用方提示用户） */
  send(msg: Record<string, unknown>): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  dispose(): void {
    this.shouldRun = false;
    this.clearPing();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }
}
