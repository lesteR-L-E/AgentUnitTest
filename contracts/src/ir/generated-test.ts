import { z } from "zod";

/**
 * GeneratedTest —— 生成/修复后的测试代码载体。
 * generate_tests 与 repair_tests 的输出；run_tests 的输入。
 * v1 GeneratedTest（test_runner/models.py）翻译。
 */
export const GeneratedTestSchema = z.object({
  packageName: z.string().nullish(), // 测试类包名（沙箱按它计算写入路径）
  className: z.string(), // 如 "CalculatorTest"
  code: z.string(), // 完整测试源码
  targetFilePath: z.string().nullish(), // 相对测试源根的目标路径（沙箱解析结果）
  framework: z.string().nullish(), // "junit5" / "junit4" ...
});

export type GeneratedTest = z.infer<typeof GeneratedTestSchema>;
