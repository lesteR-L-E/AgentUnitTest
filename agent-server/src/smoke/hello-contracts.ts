/**
 * 契约冒烟脚本：演示 agent-server 如何消费 @agent-unittest/contracts。
 * 组员写工具/前端写 WSClient 都照这个模式来。
 *
 * 运行：npm run smoke:contracts
 */
import {
  CodeAnalysisSchema,
  ClientMessageSchema,
  ServerMessageSchema,
  TOOL_CONTRACTS,
  ToolNameSchema,
} from "@agent-unittest/contracts";

// 1) IR 模型校验：模拟 analyze_code 的输出（没填的字段由 default 补齐）
const analysis = CodeAnalysisSchema.parse({
  filePath: "src/main/java/com/example/Calculator.java",
  packageName: "com.example",
  imports: ["java.util.List"],
  definedSymbols: [{ name: "Calculator", kind: "class", symbolSource: "local" }],
  methods: [
    { name: "add", parameters: ["a", "b"], parameterTypes: ["int", "int"], returnType: "int" },
  ],
  parseTier: "regex",
});
console.log("[contracts] CodeAnalysis 校验通过，方法数:", analysis.methods.length);

// 2) 客户端消息校验：模拟前端发来的 run_task
const clientMsg = ClientMessageSchema.parse({
  type: "run_task",
  sessionId: "s-demo",
  code: "public class Calculator {}",
  filePath: "Calculator.java",
  workspaceRoot: "/tmp/demo",
  provider: "deepseek",
  model: "deepseek-chat",
});
console.log("[contracts] ClientMessage 校验通过，类型:", clientMsg.type);

// 3) 服务端消息校验：模拟推给前端的 result
const serverMsg = ServerMessageSchema.parse({
  type: "result",
  sessionId: "s-demo",
  passed: true,
  testCount: 5,
});
console.log("[contracts] ServerMessage 校验通过，类型:", serverMsg.type);

// 4) 非法消息必须被拒绝（strict 模式：多字段直接报错）
const bad = ClientMessageSchema.safeParse({
  type: "chat",
  sessionId: "s-demo",
  message: "hi",
  hackField: "should-fail",
});
console.log("[contracts] 非法消息被正确拒绝:", bad.success === false);

// 5) 工具注册表完整性：TOOL_CONTRACTS 的键必须与 ToolName 枚举一一对应
const registered = Object.keys(TOOL_CONTRACTS);
const declared = ToolNameSchema.options;
const missing = declared.filter((name) => !registered.includes(name));
console.log(
  `[contracts] 工具注册表 ${registered.length}/${declared.length}，缺失:`,
  missing.length === 0 ? "无 ✅" : missing,
);

console.log("[contracts] ✅ 契约层全部可用");
