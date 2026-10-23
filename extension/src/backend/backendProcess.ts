import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";

/**
 * 后端进程管理（项目文档 §6.1/§6.4 规范的落地）：
 *  - 运行时优先复用 VSCode 内置 Node（ELECTRON_RUN_AS_NODE + process.execPath）→ 用户零环境安装；
 *  - argv 数组方式 spawn，不拼 shell 字符串；
 *  - 就绪判定只看 /health，不解析 stdout 文案；
 *  - Windows 用 taskkill /T /F 杀进程树，Unix 用 SIGTERM→SIGKILL。
 */
export class BackendProcess {
  private child: cp.ChildProcess | null = null;
  private output: vscode.OutputChannel;
  port = 0;

  constructor(private readonly extensionPath: string) {
    this.output = vscode.window.createOutputChannel("AgentUnitTest Backend");
  }

  /** agent-server 目录：设置项优先，否则 <仓库根>/agent-server（开发态 extensionPath=<仓库根>/extension） */
  resolveServerDir(): string {
    const configured = vscode.workspace.getConfiguration("agentUnitTest").get<string>("backendPath");
    if (configured && configured.trim()) return configured.trim();
    return path.resolve(this.extensionPath, "..", "agent-server");
  }

  get running(): boolean {
    return this.child !== null;
  }

  async start(): Promise<number> {
    if (this.child) return this.port;

    const dir = this.resolveServerDir();
    const entry = path.join(dir, "dist", "server.js");
    if (!fs.existsSync(entry)) {
      throw new Error(`后端未构建：找不到 ${entry}（请在仓库根目录执行 npm run build）`);
    }

    this.port = await this.freePort();
    // ELECTRON_RUN_AS_NODE=1：把 VSCode 自带的 Electron 当纯 Node 用（免装 Node，跨平台一致）
    const runtime = process.execPath && fs.existsSync(process.execPath) ? process.execPath : "node";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(this.port),
    };

    this.output.appendLine(`启动后端: ${runtime} ${entry} (port=${this.port})`);
    this.output.show(true);
    this.child = cp.spawn(runtime, [entry], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });

    this.child.stdout?.on("data", (d: Buffer) => this.output.appendLine(d.toString().trimEnd()));
    this.child.stderr?.on("data", (d: Buffer) => this.output.appendLine(`[stderr] ${d.toString().trimEnd()}`));
    this.child.on("exit", (code) => {
      this.output.appendLine(`后端进程退出 code=${code}`);
      this.child = null;
    });

    await this.waitHealthy(30_000);
    return this.port;
  }

  /** 向操作系统要一个空闲端口（listen 0），交给后端进程用 PORT 环境变量绑定 */
  private freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (addr && typeof addr === "object") {
          const p = addr.port;
          srv.close(() => resolve(p));
        } else {
          srv.close(() => reject(new Error("无法分配端口")));
        }
      });
    });
  }

  private async waitHealthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) {
        throw new Error("后端进程意外退出（详见输出面板：AgentUnitTest Backend）");
      }
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`);
        const data = (await res.json()) as { service?: string };
        if (res.status === 200 && data.service === "AgentUnitTest") {
          this.output.appendLine("后端就绪 ✓");
          return;
        }
      } catch {
        // 还没起来，继续轮询
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("后端启动超时（30s），详见输出面板：AgentUnitTest Backend");
  }

  stop(): void {
    if (!this.child) return;
    const pid = this.child.pid;
    if (process.platform === "win32" && pid) {
      // §6.1：Windows 杀整棵进程树（后端将来会派生 Maven/java 子进程）
      cp.spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      this.child.kill("SIGTERM");
      const child = this.child;
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出
        }
      }, 3000);
      t.unref();
    }
    this.child = null;
    this.output.appendLine("后端已停止");
  }

  dispose(): void {
    this.stop();
    this.output.dispose();
  }
}
