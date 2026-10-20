import { z } from "zod";

/**
 * Diagnosis —— 失败诊断 IR（v2 正式模型，diagnose_failures 的输出）。
 *
 * ★ 护栏进契约（项目文档 §3.7）：
 *   failureClass 决定后续路径 —— autoRepairable=true 的类别才允许进入自动修复循环；
 *   assertion_error / suspected_source_bug 必须 requiresDoubleConfirm=true，
 *   自动循环遇到它们必须停下走「变更内容 → 风险提示」双重确认。
 */

export const FailureClassSchema = z.enum([
  "test_compile_error", // 测试代码编译错误 → 可自动修复
  "mock_config", // mock/fixture 配置问题 → 可自动修复
  "env_error", // 环境/构建问题 → 可自动修复或引导用户
  "assertion_error", // 断言与实际行为不符 → ★ 需双重确认
  "suspected_source_bug", // 疑似被测代码 bug → ★ 只报告建议，绝不代改
  "flaky", // 不稳定测试
  "unknown",
]);
export type FailureClass = z.infer<typeof FailureClassSchema>;

export const DiagnosisItemSchema = z.object({
  failingTest: z.string(), // 如 "CalculatorTest#testDivideByZero"
  failureClass: FailureClassSchema,
  evidence: z.string().default(""), // 失败输出/堆栈的关键摘录（追问时引用，禁止编造）
  suspectedCause: z.string().default(""), // 自然语言根因分析
  suggestedAction: z.string().default(""), // 建议动作；断言/源码类 = 给用户的建议文本
  autoRepairable: z.boolean().default(false), // 是否可进入自动修复循环
  requiresDoubleConfirm: z.boolean().default(false), // 是否触发 §3.7 双重确认
  confidence: z.number().min(0).max(1).nullish(),
});
export type DiagnosisItem = z.infer<typeof DiagnosisItemSchema>;

export const DiagnosisSchema = z.object({
  items: z.array(DiagnosisItemSchema).default([]),
  summary: z.string().default(""), // 面向用户的一段话总结（result 消息的 diagnosisSummary 用它）
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;
