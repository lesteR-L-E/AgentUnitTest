import * as vscode from "vscode";
import { randomUUID } from "crypto";
import * as path from "path";
import { BackendProcess } from "./backend/backendProcess";
import { WsClient } from "./wsClient";
import { SidebarProvider } from "./sidebarProvider";

/**
 * 插件入口（M1 演示版）。
 *
 * 链路：激活 → 注册侧边栏/命令 → （打开侧边栏或触发生成时）拉起 agent-server
 *       → WS 连接 → 编辑器选中代码 run_task / 输入框 chat / 确认按钮 confirm
 *
 * TODO(M2 人员5)：正式对话式 UI、历史消息回显、多窗口会话映射、打包分发。
 */
export function activate(context: vscode.ExtensionContext) {
  const backend = new BackendProcess(context.extensionPath);

  const state = {
    sessionId: randomUUID() as string, // 当前对话 ID；「新建对话」= 换一个新 UUID
    ws: null as WsClient | null,
    starting: null as Promise<void> | null,
  };

  // ── 侧边栏 ──────────────────────────────────────────────
  const provider = new SidebarProvider({
    onReady: () => {
      provider.setSession(state.sessionId);
      provider.postInfo("欢迎使用 AgentUnitTest（M1 演示版）：打开一个 Java 项目，选中代码后点「生成测试」，或直接开始对话");
      void ensureBackend().catch(() => undefined);
    },
    onGenerate: () => void generateTests(),
    onChat: (text) => void sendChat(text),
    onConfirm: (confirmId, decision) =>
      sendRaw({ type: "confirm", sessionId: state.sessionId, confirmId, decision }),
    onCancel: () => sendRaw({ type: "cancel", sessionId: state.sessionId }),
    onNewChat: () => {
      state.sessionId = randomUUID();
      provider.setSession(state.sessionId);
      provider.postInfo(`已新建对话（${state.sessionId.slice(0, 8)}…），旧对话已保存，可从「对话列表」回去`);
    },
    onListSessions: () => {
      void ensureBackend()
        .then(() => sendRaw({ type: "list_sessions" }))
        .catch(() => undefined);
    },
    onSwitchSession: (id) => {
      state.sessionId = id;
      provider.setSession(id);
      provider.postInfo("已切换到历史对话：Agent 记得之前的内容，直接继续聊即可（旧消息暂不回显，M2 实现）");
    },
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("agentUnitTest.sidebar", provider, {
      webviewOptions: { retainContextWhenHidden: true }, // 视图隐藏时保留聊天记录
    }),
  );

  // ── 后端进程 + WS ───────────────────────────────────────
  async function ensureBackend(): Promise<void> {
    if (state.ws?.connected) return;
    if (!state.starting) {
      state.starting = (async () => {
        provider.postInfo("正在启动后端进程…");
        try {
          const port = await backend.start();
          state.ws = new WsClient(
            `ws://127.0.0.1:${port}/ws`,
            onServerMessage,
            (s) => provider.postInfo(s === "connected" ? "WebSocket 已连接 ✓" : "WebSocket 断开，重连中…"),
          );
          state.ws.connect();
        } catch (err) {
          provider.postInfo(`❌ 后端启动失败: ${(err as Error).message}`);
          state.starting = null; // 允许下次重试
          throw err;
        }
      })();
    }
    return state.starting;
  }

  function onServerMessage(m: Record<string, unknown>): void {
    const sid = m.sessionId as string | undefined;
    if (sid && sid !== state.sessionId) return; // 其他对话的消息不渲染
    provider.postServerMessage(m);
  }

  function sendRaw(msg: Record<string, unknown>): boolean {
    if (!state.ws || !state.ws.send(msg)) {
      provider.postInfo("⚠️ 尚未连接后端（可能正在启动或已断开），请稍后重试");
      return false;
    }
    return true;
  }

  // ── 选中代码预览（供用户核对选区；仅显示，不参与发送） ────
  let previewTimer: NodeJS.Timeout | null = null;
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const doc = e.textEditor.document;
      // 非 file 文档（输出面板/终端等）不预览，避免垃圾选区
      if (doc.uri.scheme !== "file") return;
      // 防抖 200ms：拖选过程事件风暴，停下后只推一次
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        previewTimer = null;
        const sel = e.textEditor.selection;
        const text = sel.isEmpty ? "" : doc.getText(sel);
        provider.postSelection(
          text
            ? { fileName: path.basename(doc.fileName), lineCount: text.split("\n").length, code: text }
            : null, // 选区为空 → null，webview 隐藏预览卡
        );
      }, 200);
    }),
    { dispose: () => { if (previewTimer) clearTimeout(previewTimer); } },
  );

  // ── 生成测试（侧边栏按钮 / 右键菜单共用） ─────────────────
  async function generateTests(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showWarningMessage("请先在编辑器中选中要测试的代码");
      return;
    }
    const doc = editor.document;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) {
      vscode.window.showWarningMessage("请先打开项目文件夹（包含 pom.xml / build.gradle 的 Java 项目）");
      return;
    }
    try {
      await ensureBackend();
    } catch {
      return; // 失败原因已由 ensureBackend 提示
    }
    const cfg = vscode.workspace.getConfiguration("agentUnitTest");
    const sent = sendRaw({
      type: "run_task",
      sessionId: state.sessionId,
      code: doc.getText(editor.selection),
      filePath: vscode.workspace.asRelativePath(doc.uri),
      workspaceRoot: folder.uri.fsPath,
      provider: cfg.get<string>("provider") ?? "deepseek",
      model: cfg.get<string>("model") ?? "",
    });
    if (sent) {
      provider.postInfo(
        `已发起生成任务：${vscode.workspace.asRelativePath(doc.uri)}（选中 ${doc.getText(editor.selection).split("\n").length} 行）`,
      );
      await vscode.commands.executeCommand("agentUnitTest.sidebar.focus");
    }
  }

  async function sendChat(text: string): Promise<void> {
    try {
      await ensureBackend();
    } catch {
      return;
    }
    sendRaw({ type: "chat", sessionId: state.sessionId, message: text });
  }

  // ── 命令注册 ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("agentUnitTest.generateTests", () => generateTests()),
    vscode.commands.registerCommand("agentUnitTest.hello", () => {
      vscode.window.showInformationMessage("AgentUnitTest 脚手架运行正常 ✅");
    }),
    {
      dispose: () => {
        state.ws?.dispose();
        backend.dispose(); // 插件卸载/窗口关闭 → 杀掉后端进程树
      },
    },
  );
}

export function deactivate() {}
