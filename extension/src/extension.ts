import * as vscode from "vscode";

/**
 * 脚手架占位入口。
 *
 * TODO(M1 第 6 步)：最简陋可演示插件 UI ——
 *   - BackendProcess：拉起 agent-server（复用 VSCode 内置 Node，见项目文档 §6.4）
 *   - WSClient：连接 ws://127.0.0.1:{port}/ws（协议 v2）
 *   - 侧边栏 Webview：选中触发 + 消息列表 + 输入框（能演示即可）
 * TODO(M2)：正式对话式侧边栏（人员5）。
 */
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("agentUnitTest.hello", () => {
      vscode.window.showInformationMessage(
        "AgentUnitTest 脚手架运行正常 ✅（下一步见 docs/项目文档-v2.md §9 M1）"
      );
    })
  );
}

export function deactivate() {}
