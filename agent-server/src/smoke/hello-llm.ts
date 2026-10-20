/**
 * LLM 冒烟脚本（M1 第 2 步）：验证 Vercel AI SDK 能打通模型并流式输出。
 *
 * 用法：
 *   1. cp .env.example .env，填入至少一个 provider 的 key
 *      （可直接从旧仓库 AgentUnitTest-backend/backend/.env 里拷贝）
 *   2. npm run smoke:llm
 *
 * 说明：这是一次性验证脚手架。正式实现是 src/llm/factory.ts（M1 第 3 步），
 * 届时 getModel(provider, model) 会成为全项目唯一的模型出口（项目文档 §3.6）。
 */
import "dotenv/config";

// ⚠️ 必须在 import AI SDK 之前清理「空字符串」环境变量：
// @ai-sdk/openai 等包在模块加载时就会创建默认实例并读取 OPENAI_BASE_URL，
// 空字符串会被当成非法 baseURL 直接抛错（.env 里写了 `OPENAI_BASE_URL=` 就会踩中）。
for (const key of [
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
]) {
  if (process.env[key]?.trim() === "") delete process.env[key];
}

// 清理之后再动态 import AI SDK（静态 import 会先于上面的代码执行，故用动态）
const { streamText } = await import("ai");
const { createOpenAI } = await import("@ai-sdk/openai");
const { createAnthropic } = await import("@ai-sdk/anthropic");

function pickModel() {
  // 优先级：DeepSeek（走 OpenAI 兼容协议）> OpenAI > Anthropic
  if (process.env.DEEPSEEK_API_KEY) {
    const deepseek = createOpenAI({
      baseURL: "https://api.deepseek.com/v1",
      apiKey: process.env.DEEPSEEK_API_KEY,
    });
    return { name: "deepseek/deepseek-chat", model: deepseek("deepseek-chat") };
  }
  if (process.env.OPENAI_API_KEY) {
    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
    return { name: "openai/gpt-4o-mini", model: openai("gpt-4o-mini") };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return { name: "anthropic/claude-sonnet", model: anthropic("claude-sonnet-4-5") };
  }
  throw new Error("未在 .env 中找到任何 API key（参考 .env.example 填写；注意不要留空值行）");
}

const { name, model } = pickModel();
console.log(`[smoke] 使用 ${name}，发起流式调用...`);

const result = streamText({
  model,
  prompt: "用一句话解释什么是单元测试。",
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
console.log("\n[smoke] ✅ LLM 链路打通（流式输出正常）");
