# macOS / Windows 双平台互通规范

macOS 与 Windows 同为一等公民。目标：双平台上开发体验一致、功能一致、可分发运行一致。**平台差异只允许收敛在明确的兼容位置，不得散落在业务代码里**；CI 三平台矩阵（ubuntu + macos + windows）必须全绿。

写任何涉及进程、路径、文件 IO、环境变量、子进程终止的代码前，先读本文对应小节。

## 1. 进程管理

- **argv 数组方式 spawn，禁止拼接 shell 字符串**（杜绝 sh/cmd 差异与注入）。参照 `extension/src/backend/backendProcess.ts` 的 `start()`。
- **终止进程树**：Windows 用 `taskkill /pid <pid> /T /F`（后端将来会派生 Maven/java 子进程，必须杀整棵树）；Unix 用 `SIGTERM` → 3 秒宽限 → `SIGKILL`。参照 `backendProcess.stop()`，已实现可直接复用其模式。
- **禁止假设 SIGTERM 语义跨平台一致**——Windows 上 Node 的信号是模拟语义。
- **就绪判定只看 `/health` HTTP 轮询**，不解析 stdout 文案（不同平台/版本日志措辞会变）。参照 `backendProcess.waitHealthy()`。
- **端口不写死**：`net.createServer().listen(0)` 向操作系统要空闲端口，经 `PORT` 环境变量传给后端。参照 `backendProcess.freePort()`。
- **运行时复用**：插件端启动后端用 `process.execPath + ELECTRON_RUN_AS_NODE=1`（VSCode 内置 Node 当纯 Node 用，用户零环境安装），兜底系统 `node`。

## 2. 路径

- 一律使用 `node:path` 拼接，**禁止手写 `/` 或 `\\` 字符串拼接**；判断平台分隔符用 `path.sep`。
- 与前端/LLM 交换文件位置统一用相对 workspaceRoot 的 POSIX 风格相对路径；绝对路径仅限内部使用。
- **路径穿越防护**：sessionId 只允许 `[\w.-]`（见 `session-store.ts` 的 `SESSION_ID_RE`）；读取项目文件必须 `path.resolve` 后校验仍在 workspaceRoot 内（见 `stubs.ts` 的 `readProjectFileStub`）。
- 大小写敏感性：macOS 默认不敏感、Linux 敏感；文件查找结果以实际枚举为准，不假设大小写。
- ESM 模块路径转换用 `pathToFileURL`/`fileURLToPath`（Windows 盘符/反斜杠下字符串拼接会失效），参照 `server.ts` 入口判断。

## 3. 编码

- 全链路显式 UTF-8：读写文件传 `"utf-8"`；子进程管道解码按 UTF-8。
- 调用 Java/JVM 子进程（Maven/Gradle，M2 `run_tests` 真实现）一律带 `-Dfile.encoding=UTF-8`。
- Windows 中文环境控制台默认 GBK——任何把进程输出当文本消费的地方都要显式解码，不依赖系统默认编码。

## 4. 构建工具 wrapper（M2 run_tests 真实现必读）

按平台探测 wrapper 脚本：Windows 找 `mvnw.cmd` / `gradlew.bat`（需经 `cmd.exe /d /c` 执行），Unix 找 `mvnw` / `gradlew`（可执行权限缺失时经 `sh` 执行）。已有半真示范：`stubs.ts` 的 `inspectEnvironmentStub` 探测部分；v1 基线 `executor.py` 的 `_resolve_wrapper`/`_wrapper_prefix` 是完整参照（路径 `单元测试Agent插件/AgentUnitTest-backend/backend/tools/test_runner/executor.py`）。

## 5. 换行符

- 仓库已配 `.gitattributes`：`* text=auto eol=lf`，`*.bat`/`*.cmd` 强制 CRLF。不要改动此策略。
- 生成写入**用户项目**的文件（测试代码等）遵循该项目的换行现状（探测既有文件/`.gitattributes`）；工具自身临时文件统一 LF。

## 6. 环境变量

- `.env` 空值陷阱：`KEY=` 注入的是空字符串而非"未设置"，AI SDK 会当非法值在 import 期抛错。`agent-server/src/env.ts` 负责清洗并必须保持为**每个入口文件的第一个 import**；新增入口（冒烟脚本等）照做。
- 环境变量读取统一 `?.trim()` 后再判空（参照 `factory.ts` 的 `resolveKey`）。

## 7. 双端检查清单（PR 前自查）

涉及以下任一领域的改动，合并前逐条确认（条件不允许双端实测时，逐条写明依据）：

- [ ] 子进程：argv spawn？双平台终止方式各自正确？就绪只看 /health？
- [ ] 路径：全部 node:path？无手写分隔符？越界校验仍在？
- [ ] 编码：文件读写显式 utf-8？JVM 调用带 file.encoding？
- [ ] wrapper：win 找 .cmd/.bat、unix 找无后缀版本？
- [ ] CI：三平台矩阵跑过且全绿（`git push` 后看 Actions）？
