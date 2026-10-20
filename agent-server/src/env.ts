/**
 * 环境变量加载与清洗。
 *
 * ⚠️ 必须是每个入口文件（server.ts / smoke 脚本）的【第一个 import】：
 * ESM 按声明顺序求值，本文件先跑，才能保证后面 import 的 @ai-sdk/* 包
 * 在创建模块级默认实例时不会读到「空字符串」环境变量。
 *
 * 背景：.env 里写 `OPENAI_BASE_URL=`（空值）时 dotenv 会注入空字符串，
 * AI SDK 会把它当非法 baseURL 直接抛错（空字符串 ≠ 未设置）。
 */
import "dotenv/config";

for (const key of [
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
]) {
  if (process.env[key]?.trim() === "") delete process.env[key];
}

export {};
