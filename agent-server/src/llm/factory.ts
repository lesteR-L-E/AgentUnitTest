/**
 * 模型工厂 —— 全项目唯一的模型出口（项目文档 §3.6）。
 *
 * 约束：业务代码（runtime/tools/server）禁止直接 import @ai-sdk/* provider 包，
 * 只能经本文件 getModel() 取模型。换框架/换供应商时只改这里。
 */
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, type LanguageModel } from "ai";

export type ProviderName = "deepseek" | "openai" | "anthropic";

const ENV_KEY: Record<ProviderName, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

const DEFAULT_MODELS: Record<ProviderName, string> = {
  deepseek: "deepseek-chat",
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5",
};

export interface ModelHandle {
  model: LanguageModel;
  provider: ProviderName;
  modelName: string;
}

export interface GetModelOptions {
  apiKey?: string; // 来自 WS 请求（仅本机回环，禁止写日志）
  baseURL?: string;
}

export function normalizeProvider(raw: string): ProviderName {
  const p = raw.trim().toLowerCase();
  if (p === "deepseek" || p === "openai" || p === "anthropic") return p;
  throw new Error(`不支持的 provider: "${raw}"（可选: deepseek / openai / anthropic）`);
}

function resolveKey(provider: ProviderName, explicit?: string): string {
  const key = explicit?.trim() || process.env[ENV_KEY[provider]]?.trim();
  if (!key) {
    throw new Error(
      `缺少 ${provider} 的 API key：请在 WS 请求中传 apiKey，或在 agent-server/.env 设置 ${ENV_KEY[provider]}`,
    );
  }
  return key;
}

export function getModel(provider: string, model?: string, opts: GetModelOptions = {}): ModelHandle {
  const p = normalizeProvider(provider);
  const modelName = model?.trim() || DEFAULT_MODELS[p];

  if (p === "anthropic") {
    const anthropic = createAnthropic({
      apiKey: resolveKey(p, opts.apiKey),
      baseURL: opts.baseURL?.trim() || undefined,
    });
    return { model: anthropic(modelName), provider: p, modelName };
  }

  // deepseek 走 OpenAI 兼容协议；openai 支持自定义网关（OPENAI_BASE_URL）
  const baseURL =
    p === "deepseek"
      ? opts.baseURL?.trim() || "https://api.deepseek.com/v1"
      : opts.baseURL?.trim() || process.env.OPENAI_BASE_URL?.trim() || undefined;

  const openai = createOpenAI({ apiKey: resolveKey(p, opts.apiKey), baseURL });
  return { model: openai(modelName), provider: p, modelName };
}

/** 凭证校验（对应 v1 validate_credentials）：发一次最小请求验证 key/模型可用 */
export async function validateModel(handle: ModelHandle): Promise<void> {
  await generateText({ model: handle.model, prompt: "Reply with OK", maxOutputTokens: 8 });
}
