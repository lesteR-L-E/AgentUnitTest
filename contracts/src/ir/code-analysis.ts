import { z } from "zod";
import { SourceLocationSchema } from "./source-location.js";

/**
 * CodeAnalysis —— 统一代码分析 IR（Tool1 的输出，Tool2/Tool3 与对话下钻的输入）。
 * v1 Pydantic 模型逐字段翻译；命名 snake_case → camelCase，语义一一对应。
 *
 * 生产者：analyze_code（人员1）
 * 消费者：generate_tests / diagnose_failures / inspect_environment / runtime 上下文压缩
 */

/** 符号的结构种类（v1: Symbol.kind） */
export const SymbolStructKindSchema = z.enum([
  "class",
  "interface",
  "enum",
  "record",
  "annotation_type",
  "method",
  "constructor",
  "field",
  "package",
  "unknown",
]);
export type SymbolStructKind = z.infer<typeof SymbolStructKindSchema>;

/**
 * 符号来源分类（v1: SymbolKind）——人员1 核心任务：
 * local=当前文件定义 / project=项目内其他文件 / external_library=第三方库 / unresolved=未能解析
 */
export const SymbolSourceSchema = z.enum(["local", "project", "external_library", "unresolved"]);
export type SymbolSource = z.infer<typeof SymbolSourceSchema>;

/**
 * 符号定义。注意类型导出名为 CodeSymbol（避开 JS 内置 Symbol）。
 */
export const SymbolSchema = z.object({
  name: z.string(),
  qualifiedName: z.string().nullish(), // 全限定名，如 com.example.Calculator
  kind: SymbolStructKindSchema.default("unknown"),
  symbolSource: SymbolSourceSchema.default("local"),
  sourceFile: z.string().nullish(), // 定义文件（相对 workspaceRoot 路径）
  sourceLocation: SourceLocationSchema.nullish(),
  external: z.boolean().default(false), // 是否外部（非本项目）符号
  annotations: z.array(z.string()).default([]), // 如 ["@Override"]
  accessModifier: z.string().nullish(), // public / private / protected / package
  javadoc: z.string().nullish(),
  type: z.string().nullish(), // 字段/变量的声明类型
});
export type CodeSymbol = z.infer<typeof SymbolSchema>;

/** 方法调用引用（v1: MethodReference） */
export const MethodReferenceSchema = z.object({
  name: z.string(),
  declaringType: z.string().nullish(), // 被调方法所属类型的全限定名
  signature: z.string().nullish(),
  line: z.number().int().nullish(),
  column: z.number().int().nullish(),
});
export type MethodReference = z.infer<typeof MethodReferenceSchema>;

/** 方法级信息（v1: MethodInfo） */
export const MethodInfoSchema = z.object({
  name: z.string(),
  signature: z.string().default(""),
  parameters: z.array(z.string()).default([]), // 参数名列表，如 ["a","b"]
  parameterTypes: z.array(z.string()).default([]), // 参数声明类型，如 ["int","int"]
  returnType: z.string().nullish(),
  localVariables: z.array(z.string()).default([]),
  methodCalls: z.array(MethodReferenceSchema).default([]),
  variableReferences: z.array(z.string()).default([]),
  annotations: z.array(z.string()).default([]),
  accessModifier: z.string().nullish(),
  isStatic: z.boolean().default(false),
  isConstructor: z.boolean().default(false),
  typeParameters: z.array(z.string()).default([]), // 泛型参数
  throws: z.array(z.string()).default([]),
  sourceLocation: SourceLocationSchema.nullish(),
  javadoc: z.string().nullish(),
});
export type MethodInfo = z.infer<typeof MethodInfoSchema>;

/** 依赖边类型 */
export const DependencyTypeSchema = z.enum([
  "import",
  "extends",
  "implements",
  "method_call",
  "field_ref",
  "type_ref",
  "other",
]);

/** 依赖图的边（v1: Dependency） */
export const DependencySchema = z.object({
  source: z.string(), // 依赖方（文件或符号全限定名）
  target: z.string(), // 被依赖方
  dependencyType: DependencyTypeSchema.default("import"),
});
export type Dependency = z.infer<typeof DependencySchema>;

/**
 * 解析层级（v2 AST 分层策略，项目文档 §6.6）：
 * java_parser=纯JS解析器（主力候选）/ tree_sitter=WASM tree-sitter（主力候选）
 * javaparser_jar=可选增强（需用户显式配置）/ regex=兜底
 */
export const ParseTierSchema = z.enum([
  "java_parser",
  "tree_sitter",
  "javaparser_jar",
  "regex",
  "unknown",
]);
export type ParseTier = z.infer<typeof ParseTierSchema>;

/** 统一分析结果 IR */
export const CodeAnalysisSchema = z.object({
  filePath: z.string(),
  language: z.string().default("java"), // 多语言扩展位（本期仅 java）
  packageName: z.string().nullish(),
  imports: z.array(z.string()).default([]),
  definedSymbols: z.array(SymbolSchema).default([]),
  externalSymbols: z.array(SymbolSchema).default([]),
  unresolvedSymbols: z.array(z.string()).default([]),
  methods: z.array(MethodInfoSchema).default([]),
  dependencies: z.array(DependencySchema).default([]),
  superClass: z.string().nullish(),
  interfaces: z.array(z.string()).default([]),
  parseTier: ParseTierSchema.default("unknown"),
});
export type CodeAnalysis = z.infer<typeof CodeAnalysisSchema>;
