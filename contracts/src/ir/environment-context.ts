import { z } from "zod";

/**
 * EnvironmentContext —— 工程环境检测 IR（Tool3 的输出）。
 * v1 模型逐字段翻译（含 README 中实际使用的 test_source_dir / wrapper 信息）。
 *
 * 生产者：inspect_environment（人员3）
 * 消费者：generate_tests（按框架/mock 库生成）· run_tests（按构建工具执行）
 */

export const BuildToolSchema = z.enum(["maven", "gradle", "none"]);
export type BuildTool = z.infer<typeof BuildToolSchema>;

export const TestFrameworkSchema = z.enum([
  "junit5",
  "junit4",
  "testng",
  "spock",
  "none",
  "unknown",
]);
export type TestFramework = z.infer<typeof TestFrameworkSchema>;

export const EnvironmentContextSchema = z.object({
  language: z.string().default("java"), // 多语言扩展位
  javaVersion: z.string().nullish(), // 如 "17"（探测自 pom/JAVA_HOME/javac）
  buildTool: BuildToolSchema,
  testFramework: TestFrameworkSchema.default("unknown"),
  mockLibrary: z.string().nullish(), // 如 "mockito"（本期只探测不强枚举）
  existingTestPatterns: z.array(z.string()).default([]), // 现有测试风格：AAA / GWT / @BeforeEach ...
  projectRoot: z.string(), // 绝对路径
  testDirectory: z.string().nullish(), // 测试源根，如 "src/test/java"（相对 projectRoot）
  moduleStructure: z.array(z.string()).default([]), // 多模块列表（相对路径）
  packageStyle: z.string().nullish(), // 包命名风格摘要
  assertionStyle: z.string().nullish(), // "junit" | "assertj" | "hamcrest"
  ciEnvironment: z.string().nullish(), // "github_actions" | "jenkins" | ...
  buildWrapperPath: z.string().nullish(), // mvnw / gradlew(.cmd) 实际路径（run_tests 执行器用，v1 wrapper_path）
});

export type EnvironmentContext = z.infer<typeof EnvironmentContextSchema>;
