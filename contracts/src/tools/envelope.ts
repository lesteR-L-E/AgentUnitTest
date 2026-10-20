import { z } from "zod";

/**
 * 工具统一返回信封（项目文档 §3.4 契约）：
 * 工具异常必须转为结构化错误交给 Agent Loop，由 LLM 决定重试或求助用户，
 * 不允许抛异常炸掉整个会话。
 */
export const ToolFailureSchema = z.object({
  ok: z.literal(false),
  error: z.string(), // 人类可读 + LLM 可读的错误描述
  retryable: z.boolean().default(false), // 是否建议重试
});
export type ToolFailure = z.infer<typeof ToolFailureSchema>;

/** 用数据 schema 构造 `{ok:true,data} | {ok:false,error,retryable}` 判别联合 */
export function toolResultSchema<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: dataSchema }),
    ToolFailureSchema,
  ]);
}
