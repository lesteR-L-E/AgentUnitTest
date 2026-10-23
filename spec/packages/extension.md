# extension — VSCode 插件

> 开始任何涉及 extension 的工作前，先读本文。

## 定位与结构

VSCode 扩展（M1 演示版，正式 UI 由人员5 在 M2 重做）：对话式侧边栏 + agent-server 进程生命周期 + WS 客户端。

```
src/
├── extension.ts           # 入口：状态管理（sessionId/ws/starting）、懒启动链路、命令注册
├── sidebarProvider.ts     # 侧边栏 Webview：消息流 UI（内联 HTML/JS）+ 用户动作上报
├── wsClient.ts            # WS 客户端：30s 心跳、指数退避重连（1s 起步 15s 封顶）
└── backend/backendProcess.ts  # 后端子进程：启动/就绪/停止（跨平台规范落地，见 spec/cross-platform.md）
```

## 与 webview 的分工（原则）

**webview 内 JS 只管渲染和收集用户动作；所有业务（会话 ID、WS、后端进程）都在 extension.ts。** webview 里没有秘密、没有状态——两边仅靠 postMessage 通讯：

- webview → 扩展：`{command: ready|generate|chat|confirm|cancel|newChat|listSessions|switchSession, ...}`
- 扩展 → webview：四个 channel——`server`（服务端消息透传）、`info`（本地提示文案）、`session`（会话切换，清空消息流）、`selection`（选中代码预览推送；sel=null 表示清除预览）

## 关键机制（修改前必知）

- **懒启动**：扩展激活不拉起后端；侧边栏 `ready` 或首次发消息/生成时才 `ensureBackend()`（幂等：进行中复用同一 Promise；失败后置空允许重试）。
- **选中预览**（选区变化 → 侧边栏预览卡，供用户核对选区）：`onDidChangeTextEditorSelection` 监听 + 防抖 200ms（拖选事件风暴），把 `{fileName, lineCount, code}` 经 `selection` channel 推给 webview 渲染折叠卡；非 file 文档（输出面板等）不预览；选区为空推 null 隐藏。预览超 2000 字符截断显示（附提示），**完整代码仍随 run_task 发送**；点「生成测试」时以编辑器当前实际选区为准，预览本身不参与发送、不改变任何业务行为。
- **会话 ID 生命周期**（extension.ts `state.sessionId`）：每个窗口一个 UUID；「新建对话」= 换新 UUID（旧对话文件保留，可从列表回去）；「对话列表」= `list_sessions` 消息拉取；切换 = 改 state + 通知 webview 清屏。收到服务端消息先按 sessionId 过滤——**不是当前对话的消息不渲染**。
- **两个消息入口最终合流**：「生成测试(选中)」按钮/右键 → `run_task`（带 code/filePath/workspaceRoot）；输入框打字 → `chat`。两者都要求编辑器打开的是工作区内的文件（无 workspace 时提示先打开项目）。
- **心跳与重连**（wsClient.ts）：连接建立即起 30s ping 定时器；close 即指数退避重连；`dispose()` 置 `shouldRun=false` 后不再重连。
- **后端进程**（backendProcess.ts）：`ELECTRON_RUN_AS_NODE` 复用 VSCode 内置 Node 跑 `agent-server/dist/server.js`（所以**改了后端源码必须先 `npm run build`**）；`listen(0)` 要端口经 `PORT` 传入；就绪只轮询 `/health`；停止按平台 taskkill / SIGTERM→SIGKILL（见 spec/cross-platform.md §1）。插件 deactivate / 窗口关闭 → dispose 杀进程树。
- **webview HTML 约束**（sidebarProvider.ts `buildHtml`）：模板字符串内不能出现 `${...}`（会被 TS 插值），webview JS 全部用字符串拼接；**反斜杠转义会被 TS 模板字符串先解释**——`\n` 到 webview 已是真实换行，断在字符串里即语法错误且整个 webview 脚本失效（按钮/监听全无反应），需在 webview JS 里写换行转义必须写 `\\n`；已设 CSP（`default-src 'none'`）；`retainContextWhenHidden: true` 隐藏时保留聊天记录。

## 硬约束

- 现阶段从 contracts 只 `import type`，不引运行时值（插件打 ESM 切换前，见项目文档 §7）。
- 模型 provider/model 配置经 VSCode 设置（`agentUnitTest.provider` / `agentUnitTest.model`）读取，不在 webview 存任何 key。
- 涉及后端进程/路径的代码必须遵守 `spec/cross-platform.md`（backendProcess.ts 是已落地的标准示范，改它时保持规范）。
- 新增服务端消息类型渲染：在 webview 的 message switch 加分支即可；未知 type 走 default 忽略（前后端不同步时不崩 UI）。

## 调试

VSCode 打开仓库根目录按 **F5**（`npm run build` + 启动扩展开发宿主）；后端日志看输出面板 **AgentUnitTest Backend** 频道。演示流程：新窗口打开任意 Java 项目（含 pom.xml/build.gradle）→ 活动栏图标 → 侧边栏自动启动后端 → 选中代码生成 / 直接对话。
