import { z } from "zod";

/**
 * TestResult —— 测试执行结果 IR（run_tests 的输出）。
 * v1 TestResult 逐字段翻译 + passed/durationMs 两个便利字段。
 *
 * 生产者：run_tests（人员2）
 * 消费者：diagnose_failures · result WS 消息 · 对话追问（read_artifact）
 */

/** 三态执行状态（v1 TestExecutionStatus） */
export const TestExecutionStatusSchema = z.enum([
  "success", // 全部通过
  "test_code_error", // 测试代码本身编译/运行错误（≠ 断言失败）
  "test_failure", // 有断言失败
]);
export type TestExecutionStatus = z.infer<typeof TestExecutionStatusSchema>;

export const TestResultSchema = z.object({
  status: TestExecutionStatusSchema,
  passed: z.boolean(), // 全部通过 = true（前端 result 卡片直接消费）
  testCount: z.number().int().nonnegative().default(0),
  passedCount: z.number().int().nonnegative().default(0),
  failedCount: z.number().int().nonnegative().default(0),
  skippedCount: z.number().int().nonnegative().default(0),
  failureDetails: z.array(z.string()).default([]), // 如 ["testAdd(): expected: <5> but was: <-1>"]
  failingTests: z.array(z.string()).default([]), // 如 ["CalculatorTest#testAdd"]
  compilationError: z.string().nullish(), // status=test_code_error 时非空
  message: z.string().nullish(), // 摘要行，如 "Tests run: 3, Failures: 0, Errors: 0, Skipped: 0"
  stderr: z.string().nullish(), // 截断保护后的 stderr
  durationMs: z.number().int().nonnegative().nullish(),
});

export type TestResult = z.infer<typeof TestResultSchema>;
