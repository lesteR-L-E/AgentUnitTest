import * as vscode from "vscode";

/**
 * 侧边栏 Webview（M1 演示版）：消息流 + 输入框 + 任务事件 + 双重确认按钮 + 对话列表。
 * 原则：能演示即可，不求美观（正式 UI 由人员5 在 M2 重做）。
 *
 * 与 extension.ts 的分工：
 *  - webview 内 JS 只管渲染和收集用户动作，通过 postMessage 上报 {command,...}；
 *  - 所有业务（会话 ID、WS、后端进程）都在 extension.ts（webview 里没有秘密、没有状态）。
 */

export interface SidebarHooks {
  onReady(): void;
  onGenerate(): void;
  onChat(text: string): void;
  onConfirm(confirmId: string, decision: "approve" | "reject"): void;
  onCancel(): void;
  onNewChat(): void;
  onListSessions(): void;
  onSwitchSession(sessionId: string): void;
}

interface WebviewToExtMessage {
  command: string;
  text?: string;
  confirmId?: string;
  decision?: "approve" | "reject";
  sessionId?: string;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;

  constructor(private readonly hooks: SidebarHooks) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // retainContextWhenHidden 在 registerWebviewViewProvider 的第三参数里设置（见 extension.ts）
    view.webview.options = { enableScripts: true };
    view.webview.html = buildHtml();
    view.webview.onDidReceiveMessage((m: WebviewToExtMessage) => {
      switch (m.command) {
        case "ready":
          this.hooks.onReady();
          break;
        case "generate":
          this.hooks.onGenerate();
          break;
        case "chat":
          if (m.text && m.text.trim()) this.hooks.onChat(m.text.trim());
          break;
        case "confirm":
          if (m.confirmId && m.decision) this.hooks.onConfirm(m.confirmId, m.decision);
          break;
        case "cancel":
          this.hooks.onCancel();
          break;
        case "newChat":
          this.hooks.onNewChat();
          break;
        case "listSessions":
          this.hooks.onListSessions();
          break;
        case "switchSession":
          if (m.sessionId) this.hooks.onSwitchSession(m.sessionId);
          break;
      }
    });
  }

  /** 服务端消息透传给 webview（extension.ts 已按 sessionId 过滤） */
  postServerMessage(msg: Record<string, unknown>): void {
    void this.view?.webview.postMessage({ channel: "server", msg });
  }

  postInfo(text: string): void {
    void this.view?.webview.postMessage({ channel: "info", text });
  }

  /** 通知 webview 当前会话变了（清空消息流） */
  setSession(sessionId: string): void {
    void this.view?.webview.postMessage({ channel: "session", sessionId });
  }
}

// ───────────────────────── Webview HTML（无外部资源，内联 JS/CSS） ─────────────────────────
// 注意：模板字符串内不能出现 ${...}（会被 TS 插值），webview JS 全部用字符串拼接。

function buildHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 6px; margin: 0; }
  #bar { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { opacity: 0.85; }
  #sid { font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  #sessions { display: none; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px; margin-bottom: 6px; max-height: 160px; overflow: auto; }
  .sitem { padding: 4px; cursor: pointer; font-size: 11px; border-radius: 3px; }
  .sitem:hover { background: var(--vscode-list-hoverBackground); }
  #list { display: flex; flex-direction: column; gap: 6px; padding-bottom: 8px; }
  .msg { padding: 6px 8px; border-radius: 6px; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .user { background: var(--vscode-input-background); align-self: flex-end; max-width: 92%; }
  .agent { background: var(--vscode-editorWidget-background); align-self: flex-start; max-width: 96%; }
  .info { color: var(--vscode-descriptionForeground); font-size: 11px; text-align: center; }
  .tool { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .err { color: var(--vscode-errorForeground); font-size: 12px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px 8px; font-size: 12px; }
  .pass { border-left: 3px solid #73c991; }
  .fail { border-left: 3px solid var(--vscode-errorForeground); }
  pre { white-space: pre-wrap; word-break: break-all; background: var(--vscode-textCodeBlock-background); padding: 6px; border-radius: 4px; font-size: 11px; margin: 4px 0 0 0; }
  .confirmBox { border: 1px solid var(--vscode-focusBorder); border-radius: 6px; padding: 8px; font-size: 12px; }
  .confirmBox .btns { display: flex; gap: 6px; margin-top: 8px; }
  #inputRow { display: flex; gap: 4px; margin-top: 6px; position: sticky; bottom: 0; background: var(--vscode-sideBar-background); padding: 6px 0; }
  textarea { flex: 1; background: var(--vscode-input-background); color: var(--vscode-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 4px 6px; font-size: 12px; resize: none; height: 46px; font-family: inherit; }
</style>
</head>
<body>
  <div id="bar">
    <button id="btnGen" title="用编辑器当前选中代码发起测试生成">生成测试(选中)</button>
    <button id="btnNew" class="secondary">新建对话</button>
    <button id="btnSessions" class="secondary">对话列表</button>
    <button id="btnCancel" class="secondary">取消</button>
  </div>
  <div id="sessions"></div>
  <div id="sid"></div>
  <div id="list"></div>
  <div id="inputRow">
    <textarea id="input" placeholder="和 Agent 对话…（Enter 发送，Shift+Enter 换行）"></textarea>
    <button id="btnSend">发送</button>
  </div>
<script>
(function () {
  var vscode = acquireVsCodeApi();
  var listEl = document.getElementById('list');
  var inputEl = document.getElementById('input');
  var sessionsEl = document.getElementById('sessions');
  var sidEl = document.getElementById('sid');
  var bubbles = {}; // turnId -> 正在流式输出的气泡

  function esc(s) { var d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; }
  function scrollBottom() { window.scrollTo(0, document.body.scrollHeight); }
  function addText(cls, text) { var d = document.createElement('div'); d.className = cls; d.textContent = text; listEl.appendChild(d); scrollBottom(); return d; }
  function addHtml(cls, html) { var d = document.createElement('div'); d.className = cls; d.innerHTML = html; listEl.appendChild(d); scrollBottom(); return d; }

  document.getElementById('btnGen').onclick = function () { vscode.postMessage({ command: 'generate' }); };
  document.getElementById('btnNew').onclick = function () { vscode.postMessage({ command: 'newChat' }); };
  document.getElementById('btnCancel').onclick = function () { vscode.postMessage({ command: 'cancel' }); };
  document.getElementById('btnSessions').onclick = function () { vscode.postMessage({ command: 'listSessions' }); };
  document.getElementById('btnSend').onclick = sendChat;
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  function sendChat() {
    var t = inputEl.value.trim();
    if (!t) return;
    addText('msg user', t);
    vscode.postMessage({ command: 'chat', text: t });
    inputEl.value = '';
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (d.channel === 'info') { addText('info', d.text); return; }
    if (d.channel === 'session') {
      sidEl.textContent = '当前对话: ' + d.sessionId;
      listEl.innerHTML = ''; bubbles = {};
      return;
    }
    if (d.channel !== 'server') return;
    var m = d.msg;
    switch (m.type) {
      case 'token': {
        var b = bubbles[m.turnId];
        if (!b) { b = addText('msg agent', ''); bubbles[m.turnId] = b; }
        b.textContent += m.delta;
        scrollBottom();
        break;
      }
      case 'agent_message': {
        var b2 = bubbles[m.turnId];
        if (b2) { b2.textContent = m.text; } else { addText('msg agent', m.text); }
        delete bubbles[m.turnId];
        break;
      }
      case 'tool_call': {
        var id = 'tc-' + m.callId;
        var el = document.getElementById(id);
        var text;
        if (m.status === 'running') { text = '▶ ' + m.tool + ' 运行中…'; }
        else if (m.status === 'done') { text = '✓ ' + m.tool + (m.summary ? ' — ' + m.summary : ''); }
        else { text = '✗ ' + m.tool + (m.error ? ' — ' + m.error : ''); }
        if (!el) { el = addText('tool', text); el.id = id; } else { el.textContent = text; }
        break;
      }
      case 'test_code': {
        var det = document.createElement('details');
        det.className = 'card';
        var sum = document.createElement('summary');
        sum.textContent = '📄 ' + (m.filePath || '测试代码') + '（点击展开）';
        var pre = document.createElement('pre');
        pre.textContent = m.testCode;
        det.appendChild(sum); det.appendChild(pre); listEl.appendChild(det); scrollBottom();
        break;
      }
      case 'result': {
        var html = '<b>' + (m.passed ? '测试通过 ✓' : '测试未通过 ✗') + '</b>　' + m.testCount + ' 个用例'
          + (m.failedCount ? '（' + m.failedCount + ' 个失败）' : '')
          + (m.message ? '<br>' + esc(m.message) : '')
          + (m.diagnosisSummary ? '<br>诊断: ' + esc(m.diagnosisSummary) : '');
        addHtml('card ' + (m.passed ? 'pass' : 'fail'), html);
        break;
      }
      case 'confirmation_request': {
        var box = document.createElement('div');
        box.className = 'confirmBox';
        box.innerHTML = '<b>⚠️ ' + esc(m.question) + '</b><br><span style="white-space:pre-wrap">' + esc(m.detail) + '</span>';
        var btns = document.createElement('div');
        btns.className = 'btns';
        var ok = document.createElement('button'); ok.textContent = '同意';
        var no = document.createElement('button'); no.textContent = '拒绝'; no.className = 'secondary';
        ok.onclick = function () {
          vscode.postMessage({ command: 'confirm', confirmId: m.confirmId, decision: 'approve' });
          box.remove();
          addText('info', '已同意（' + (m.stage === 'content' ? '变更内容确认' : '风险确认') + '）');
        };
        no.onclick = function () {
          vscode.postMessage({ command: 'confirm', confirmId: m.confirmId, decision: 'reject' });
          box.remove();
          addText('info', '已拒绝本次修改');
        };
        btns.appendChild(ok); btns.appendChild(no); box.appendChild(btns);
        listEl.appendChild(box); scrollBottom();
        break;
      }
      case 'error': addHtml('err', '❌ ' + esc(m.message)); break;
      case 'cancelled': addText('info', '⏹ ' + (m.message || '已取消')); break;
      case 'sessions_list': {
        sessionsEl.innerHTML = '';
        if (!m.sessions || !m.sessions.length) {
          sessionsEl.innerHTML = '<div class="info">暂无已保存对话</div>';
        } else {
          m.sessions.forEach(function (s) {
            var it = document.createElement('div');
            it.className = 'sitem';
            it.textContent = (s.title || s.sessionId) + '　·　' + s.messageCount + ' 条 · ' + new Date(s.updatedAtMs).toLocaleString();
            it.onclick = function () {
              vscode.postMessage({ command: 'switchSession', sessionId: s.sessionId });
              sessionsEl.style.display = 'none';
            };
            sessionsEl.appendChild(it);
          });
        }
        sessionsEl.style.display = 'block';
        break;
      }
      default: break; // pong 等未知/无需渲染的消息
    }
  });

  vscode.postMessage({ command: 'ready' });
})();
</script>
</body>
</html>`;
}
