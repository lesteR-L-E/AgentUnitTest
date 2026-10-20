import { z } from "zod";
import { CodeAnalysisSchema } from "./code-analysis.js";
import { EnvironmentContextSchema } from "./environment-context.js";
import { GeneratedTestSchema } from "./generated-test.js";
import { TestResultSchema } from "./test-result.js";
import { DiagnosisSchema } from "./diagnosis.js";

/**
 * SessionState —— 会话级任务状态（替代 v1 AgentState）。
 *
 * 注意：对话消息历史本身由 runtime 以 AI SDK 消息格式管理（项目文档 §3.2/§3.3），
 * 不在本契约冻结——这里冻结的是「任务上下文 + 最新产物引用」。
 * 长产物走「摘要 + artifactId」进对话历史，细节由 read_artifact 按需读取（§3.2(4)）。
 */

export const TaskContextSchema = z.object({
  code: z.string(), // 用户选中的源码
  filePath: z.string(),
  workspaceRoot: z.string(),
});
export type TaskContext = z.infer<typeof TaskContextSchema>;

export const ArtifactKindSchema = z.enum([
  "test_code",
  "test_result",
  "diagnosis",
  "build_log",
  "source_snippet",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactRefSchema = z.object({
  artifactId: z.string(),
  kind: ArtifactKindSchema,
  path: z.string().nullish(), // 服务端落盘路径
  summary: z.string().nullish(), // 进对话历史的摘要
  createdAtMs: z.number().int().nullish(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const SessionStateSchema = z.object({
  sessionId: z.string(),
  taskContext: TaskContextSchema.nullish(),
  latest: z
    .object({
      codeAnalysis: CodeAnalysisSchema.nullish(),
      envContext: EnvironmentContextSchema.nullish(),
      generatedTest: GeneratedTestSchema.nullish(),
      testResult: TestResultSchema.nullish(),
      diagnosis: DiagnosisSchema.nullish(),
    })
    .default({}),
  artifacts: z.array(ArtifactRefSchema).default([]),
  cancelRequested: z.boolean().default(false),
});
export type SessionState = z.infer<typeof SessionStateSchema>;
