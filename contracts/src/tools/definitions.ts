import { z } from "zod";
import { CodeAnalysisSchema } from "../ir/code-analysis.js";
import { EnvironmentContextSchema } from "../ir/environment-context.js";
import { GeneratedTestSchema } from "../ir/generated-test.js";
import { TestResultSchema } from "../ir/test-result.js";
import { DiagnosisSchema } from "../ir/diagnosis.js";
import { ArtifactKindSchema } from "../ir/session-state.js";
import { toolResultSchema } from "./envelope.js";

/**
 * 9 个工具的输入/输出契约（项目文档 §3.4）。
 * runtime（M1 第 4 步）将基于 TOOL_CONTRACTS 注册表构造 AI SDK tool 定义。
 * 输入 schema 会直接成为 LLM 看到的工具参数 JSON Schema（.describe() 写给 LLM 看，务必清晰）。
 */

export const ToolNameSchema = z.enum([
  "analyze_code",
  "read_project_file",
  "search_project",
  "inspect_environment",
  "generate_tests",
  "run_tests",
  "diagnose_failures",
  "repair_tests",
  "read_artifact",
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

// ───────────────────────── 1. analyze_code（人员1） ─────────────────────────

export const AnalyzeCodeInputSchema = z.object({
  code: z.string().describe("被测源码内容"),
  filePath: z.string().describe("源文件路径（绝对或相对 workspaceRoot）"),
  workspaceRoot: z.string().describe("项目根目录绝对路径"),
  recursive: z.boolean().default(false).describe("是否递归分析项目内依赖文件"),
  maxDepth: z.number().int().min(1).max(10).default(5).describe("递归依赖的最大深度"),
});
export const AnalyzeCodeOutputSchema = toolResultSchema(CodeAnalysisSchema);

// ───────────────────── 2. read_project_file（人员1，只读） ─────────────────────

export const ReadProjectFileInputSchema = z.object({
  path: z.string().describe("相对 workspaceRoot 的文件路径；越出 workspaceRoot 的绝对路径必须被拒绝"),
  maxBytes: z.number().int().positive().default(200_000).describe("最大读取字节数，超出则截断"),
});
export const ReadProjectFileOutputSchema = toolResultSchema(
  z.object({
    path: z.string(),
    content: z.string(),
    truncated: z.boolean().default(false),
  }),
);

// ───────────────────── 3. search_project（人员1，只读） ─────────────────────

export const SearchProjectInputSchema = z.object({
  query: z.string().describe("检索词：符号名（kind=symbol）或文本片段（kind=text）"),
  kind: z.enum(["text", "symbol"]).default("symbol"),
  fileGlob: z.string().optional().describe("文件过滤，如 **/*.java"),
  maxResults: z.number().int().positive().default(20),
});
export const SearchProjectOutputSchema = toolResultSchema(
  z.object({
    matches: z
      .array(
        z.object({
          path: z.string(),
          line: z.number().int().nullish(),
          snippet: z.string(),
        }),
      )
      .default([]),
  }),
);

// ───────────────────── 4. inspect_environment（人员3） ─────────────────────

export const InspectEnvironmentInputSchema = z.object({
  filePath: z.string(),
  workspaceRoot: z.string(),
});
export const InspectEnvironmentOutputSchema = toolResultSchema(EnvironmentContextSchema);

// ───────────────────── 5. generate_tests（人员2） ─────────────────────

export const GenerateTestsInputSchema = z.object({
  code: z.string().describe("被测源码"),
  codeAnalysis: CodeAnalysisSchema,
  envContext: EnvironmentContextSchema,
  userConstraints: z
    .string()
    .nullish()
    .describe("生成前对话形成的测试约束（mock 策略/覆盖重点/断言风格），提示词要求原样传入"),
  previousTestCode: z.string().nullish().describe("对话迭代/重生成时的上一版测试代码"),
  previousDiagnosis: DiagnosisSchema.nullish(),
  userFeedback: z.string().nullish().describe("用户的迭代要求，如「补充 null 输入边界用例」"),
});
export const GenerateTestsOutputSchema = toolResultSchema(GeneratedTestSchema);

// ───────────────────── 6. run_tests（人员2） ─────────────────────

export const RunTestsInputSchema = z.object({
  generatedTest: GeneratedTestSchema,
  envContext: EnvironmentContextSchema,
  originalFilePath: z.string().nullish(),
});
export const RunTestsOutputSchema = toolResultSchema(TestResultSchema);

// ───────────────────── 7. diagnose_failures（人员2） ─────────────────────

export const DiagnoseFailuresInputSchema = z.object({
  testResult: TestResultSchema,
  generatedTest: GeneratedTestSchema,
  codeAnalysis: CodeAnalysisSchema.nullish(),
  envContext: EnvironmentContextSchema.nullish(),
  originalCode: z.string().nullish(),
});
export const DiagnoseFailuresOutputSchema = toolResultSchema(DiagnosisSchema);

// ───────────────────── 8. repair_tests（人员2，含 §3.7 护栏） ─────────────────────

export const RepairTestsInputSchema = z.object({
  generatedTest: GeneratedTestSchema,
  diagnosis: DiagnosisSchema.nullish(),
  userInstruction: z.string().nullish().describe("用户的修复要求"),
  assertionLevelChange: z
    .boolean()
    .default(false)
    .describe("本次修复是否触及断言预期值（assert*/verify）。触及则必须提供 confirmations"),
  confirmations: z
    .object({
      contentConfirmId: z.string().describe("第一次确认（变更内容对照）的服务端事件 ID"),
      riskConfirmId: z.string().describe("第二次确认（风险提示）的服务端事件 ID"),
    })
    .nullish()
    .describe("assertionLevelChange=true 时必填；runtime 校验缺失即拒绝执行（工具层硬校验）"),
});
export const RepairTestsOutputSchema = toolResultSchema(GeneratedTestSchema);

// ───────────────────── 9. read_artifact（人员2，只读） ─────────────────────

export const ReadArtifactInputSchema = z.object({
  artifactId: z.string(),
  maxBytes: z.number().int().positive().default(100_000),
});
export const ReadArtifactOutputSchema = toolResultSchema(
  z.object({
    artifactId: z.string(),
    kind: ArtifactKindSchema,
    content: z.string(),
    truncated: z.boolean().default(false),
  }),
);

// ───────────────────────── 注册表 ─────────────────────────

/**
 * 工具契约注册表 —— runtime 遍历它生成 AI SDK tools；CI 可校验「注册表键 = ToolName 枚举」。
 */
export const TOOL_CONTRACTS = {
  analyze_code: { input: AnalyzeCodeInputSchema, output: AnalyzeCodeOutputSchema },
  read_project_file: { input: ReadProjectFileInputSchema, output: ReadProjectFileOutputSchema },
  search_project: { input: SearchProjectInputSchema, output: SearchProjectOutputSchema },
  inspect_environment: { input: InspectEnvironmentInputSchema, output: InspectEnvironmentOutputSchema },
  generate_tests: { input: GenerateTestsInputSchema, output: GenerateTestsOutputSchema },
  run_tests: { input: RunTestsInputSchema, output: RunTestsOutputSchema },
  diagnose_failures: { input: DiagnoseFailuresInputSchema, output: DiagnoseFailuresOutputSchema },
  repair_tests: { input: RepairTestsInputSchema, output: RepairTestsOutputSchema },
  read_artifact: { input: ReadArtifactInputSchema, output: ReadArtifactOutputSchema },
} as const satisfies Record<ToolName, { input: z.ZodType; output: z.ZodType }>;

// ───────────────────────── 推导类型（消费方 import type 用） ─────────────────────────
// 注意：Input 类型是 z.infer 的「输出侧」类型 —— 带 .default() 的字段已补齐、可选字段已展开，
// 即工具 execute 实际收到的参数形状。

export type AnalyzeCodeInput = z.infer<typeof AnalyzeCodeInputSchema>;
export type AnalyzeCodeOutput = z.infer<typeof AnalyzeCodeOutputSchema>;
export type ReadProjectFileInput = z.infer<typeof ReadProjectFileInputSchema>;
export type ReadProjectFileOutput = z.infer<typeof ReadProjectFileOutputSchema>;
export type SearchProjectInput = z.infer<typeof SearchProjectInputSchema>;
export type SearchProjectOutput = z.infer<typeof SearchProjectOutputSchema>;
export type InspectEnvironmentInput = z.infer<typeof InspectEnvironmentInputSchema>;
export type InspectEnvironmentOutput = z.infer<typeof InspectEnvironmentOutputSchema>;
export type GenerateTestsInput = z.infer<typeof GenerateTestsInputSchema>;
export type GenerateTestsOutput = z.infer<typeof GenerateTestsOutputSchema>;
export type RunTestsInput = z.infer<typeof RunTestsInputSchema>;
export type RunTestsOutput = z.infer<typeof RunTestsOutputSchema>;
export type DiagnoseFailuresInput = z.infer<typeof DiagnoseFailuresInputSchema>;
export type DiagnoseFailuresOutput = z.infer<typeof DiagnoseFailuresOutputSchema>;
export type RepairTestsInput = z.infer<typeof RepairTestsInputSchema>;
export type RepairTestsOutput = z.infer<typeof RepairTestsOutputSchema>;
export type ReadArtifactInput = z.infer<typeof ReadArtifactInputSchema>;
export type ReadArtifactOutput = z.infer<typeof ReadArtifactOutputSchema>;
