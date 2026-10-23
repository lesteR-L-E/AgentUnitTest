/**
 * 9 个工具的桩实现（M1 第 5 步）。
 *
 * 桩的原则：
 *  - 输入输出严格遵守 @agent-unittest/contracts 契约（agent.ts 的执行包装器会再校验一遍）；
 *  - 能给"半真"数据就给（analyze_code 用正则做轻量解析、read_project_file 真读文件、
 *    inspect_environment 真探测 pom.xml/build.gradle），让演示和追问场景有真实感；
 *  - 其余返回带 [stub] 标记的罐头数据，M2 由各负责人替换为真实现。
 *
 * ★ 组员替换指南：保持函数签名与返回信封 {ok,data}|{ok,error,retryable} 不变，
 *   把内部实现换掉即可；输出契约校验不过 = build/运行时报错，这就是对照标准。
 */
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AnalyzeCodeInput,
  CodeAnalysis,
  DiagnoseFailuresInput,
  Diagnosis,
  EnvironmentContext,
  GenerateTestsInput,
  GeneratedTest,
  InspectEnvironmentInput,
  MethodInfo,
  ReadArtifactInput,
  ReadProjectFileInput,
  RepairTestsInput,
  RunTestsInput,
  SearchProjectInput,
  TestResult,
} from "@agent-unittest/contracts";
import { putArtifact, type Session } from "./session.js";

export interface ToolContext {
  session: Session;
}

const JAVA_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "do", "try", "else",
  "class", "interface", "enum", "package", "import",
]);

// ───────────────────────── 1. analyze_code（半真：正则轻解析，M2 换 java-parser） ─────────────────────────

const METHOD_RE =
  /(?:^|\n)[ \t]*(?:(?:public|protected|private)[ \t]+)?(?:static[ \t]+)?(?:final[ \t]+)?([\w<>\[\], .]+?)[ \t]+(\w+)[ \t]*\(([^)]*)\)[ \t]*(?:throws[ \t]+[\w.,\s]+)?\{/g;

/**
 * 桩｜半真：正则轻解析 Java 源码（相当于 v1 的 Tier3）。
 * 容错分支：找不到 package/类名 → 用 null/"Unknown" 兜底而不报错；
 * 方法名或"返回类型"命中 Java 关键字（if/for/class 等）→ 丢弃该匹配（正则误报过滤）。
 * M2 由人员1 换成 java-parser/web-tree-sitter 真实现，本函数即对照基线。
 */
export async function analyzeCodeStub(input: AnalyzeCodeInput): Promise<{ ok: true; data: CodeAnalysis }> {
  const code = input.code;
  const packageName = /package\s+([\w.]+)\s*;/.exec(code)?.[1] ?? null;
  const imports = [...code.matchAll(/import\s+(?:static\s+)?([\w.*]+)\s*;/g)].map((m) => m[1]!);
  const className = /(?:class|interface|enum)\s+(\w+)/.exec(code)?.[1] ?? "Unknown";

  const methods: MethodInfo[] = [];
  for (const m of code.matchAll(METHOD_RE)) {
    const [, rawType, name, rawParams] = m as unknown as [string, string, string, string];
    if (JAVA_KEYWORDS.has(name) || JAVA_KEYWORDS.has(rawType.trim())) continue;
    const parameters: string[] = [];
    const parameterTypes: string[] = [];
    for (const p of rawParams.split(",").map((s) => s.trim()).filter(Boolean)) {
      const parts = p.split(/\s+/);
      parameters.push(parts[parts.length - 1]!);
      parameterTypes.push(parts.slice(0, -1).join(" "));
    }
    methods.push({
      name,
      signature: `${rawType.trim()} ${name}(${rawParams.trim()})`,
      parameters,
      parameterTypes,
      returnType: rawType.trim(),
      localVariables: [],
      methodCalls: [],
      variableReferences: [],
      annotations: [],
      accessModifier: null,
      isStatic: false,
      isConstructor: false,
      typeParameters: [],
      throws: [],
      sourceLocation: null,
      javadoc: null,
    });
  }

  const data: CodeAnalysis = {
    filePath: input.filePath,
    language: "java",
    packageName,
    imports,
    definedSymbols: [{
      name: className,
      qualifiedName: packageName ? `${packageName}.${className}` : className,
      kind: "class",
      symbolSource: "local",
      sourceFile: input.filePath,
      sourceLocation: null,
      external: false,
      annotations: [],
      accessModifier: "public",
      javadoc: null,
      type: null,
    }],
    externalSymbols: [],
    unresolvedSymbols: [],
    methods,
    dependencies: imports.map((target) => ({ source: className, target, dependencyType: "import" as const })),
    superClass: null,
    interfaces: [],
    parseTier: "regex",
  };
  return { ok: true, data };
}

// ───────────────────────── 2. read_project_file（真实现：读文件 + 越权防护） ─────────────────────────

/**
 * 桩｜真实现：读取项目内文件（对话追问/依赖下钻的能力来源）。
 * 三个拒绝分支（都返回结构化错误，LLM 收到后会换路径或放弃）：
 *  1. 会话没有 taskContext（不知道 workspaceRoot）→ 拒绝；
 *  2. 解析后的绝对路径越出 workspaceRoot → 拒绝（防任意文件读取，契约里的安全规则）；
 *  3. 文件不存在/读失败 → 错误信息带原因。
 * 截断分支：超过 maxBytes → 只读前段并标记 truncated=true（防大文件撑爆上下文）。
 */
export async function readProjectFileStub(
  input: ReadProjectFileInput,
  ctx: ToolContext,
): Promise<{ ok: true; data: { path: string; content: string; truncated: boolean } } | { ok: false; error: string; retryable: boolean }> {
  const root = ctx.session.state.taskContext?.workspaceRoot;
  if (!root) return { ok: false, error: "无任务上下文（workspaceRoot 未知），无法读取项目文件", retryable: false };
  const resolved = path.resolve(root, input.path);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    return { ok: false, error: `路径越出 workspaceRoot，已拒绝: ${input.path}`, retryable: false };
  }
  try {
    const buf = await readFile(resolved);
    const truncated = buf.byteLength > input.maxBytes;
    return {
      ok: true,
      data: { path: input.path, content: buf.subarray(0, input.maxBytes).toString("utf-8"), truncated },
    };
  } catch (err) {
    return { ok: false, error: `读取失败: ${(err as Error).message}`, retryable: false };
  }
}

// ───────────────────────── 3. search_project（桩：M2 由人员1 实现） ─────────────────────────

/** 桩：恒返回空匹配列表（M2 人员1 实现符号/文本检索）。空结果对 LLM 是诚实的「没找到」，不会误导它编造内容 */
export async function searchProjectStub(
  _input: SearchProjectInput,
): Promise<{ ok: true; data: { matches: Array<{ path: string; line: number | null; snippet: string }> } }> {
  // TODO(M2 人员1): 符号/文本检索实现
  return { ok: true, data: { matches: [] } };
}

// ───────────────────────── 4. inspect_environment（半真：探测构建文件） ─────────────────────────

/** 小工具：路径存在性探测（access 抛任何错都视为不存在） */
async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 桩｜半真：真实探测项目根的构建文件。
 * 构建工具分支：有 pom.xml → maven；否则有 build.gradle(.kts) → gradle；都没有 → none。
 * wrapper 分支：按平台找 mvnw.cmd/win 或 mvnw/unix（存在才填 buildWrapperPath）。
 * [stub] 假定值：testFramework 恒为 junit5、javaVersion 恒为 null —— M2 由人员3 做真检测。
 * 结果同时写入 session.state.latest.envContext。
 */
export async function inspectEnvironmentStub(
  input: InspectEnvironmentInput,
  ctx: ToolContext,
): Promise<{ ok: true; data: EnvironmentContext }> {
  const root = ctx.session.state.taskContext?.workspaceRoot ?? input.workspaceRoot;
  const hasPom = await exists(path.join(root, "pom.xml"));
  const hasGradle =
    (await exists(path.join(root, "build.gradle"))) || (await exists(path.join(root, "build.gradle.kts")));
  const isWin = process.platform === "win32";
  const wrapperCandidates = hasPom
    ? [isWin ? "mvnw.cmd" : "mvnw"]
    : hasGradle
      ? [isWin ? "gradlew.bat" : "gradlew"]
      : [];
  let wrapperPath: string | null = null;
  for (const w of wrapperCandidates) {
    if (await exists(path.join(root, w))) {
      wrapperPath = w;
      break;
    }
  }
  const data: EnvironmentContext = {
    language: "java",
    javaVersion: null, // TODO(M2 人员3): JAVA_HOME / javac 探测
    buildTool: hasPom ? "maven" : hasGradle ? "gradle" : "none",
    testFramework: "junit5", // [stub] 假定值；M2 由人员3 按依赖真实检测
    mockLibrary: null,
    existingTestPatterns: [],
    projectRoot: root,
    testDirectory: "src/test/java",
    moduleStructure: [],
    packageStyle: null,
    assertionStyle: null,
    ciEnvironment: (await exists(path.join(root, ".github/workflows"))) ? "github_actions" : null,
    buildWrapperPath: wrapperPath,
  };
  ctx.session.state.latest.envContext = data;
  return { ok: true, data };
}

// ───────────────────────── 5. generate_tests（桩：模板生成） ─────────────────────────

/**
 * 桩：按模板拼一份 JUnit5 测试源码（M2 人员2 换成真 LLM 生成）。
 * 关键分支：userConstraints 或 userFeedback 里含 "fail"/"失败" → 故意注入 STUB_FAIL 标记用例，
 * 让 run_tests 走失败路径（演示 诊断→双重确认 全流程的开关）。
 * 用例来源分支：CodeAnalysis 里有方法 → 每个方法一个用例（最多 3 个）；没有 → 单个 example 用例。
 * 副作用：更新 latest.generatedTest + 产物存档（test_code）。
 */
export async function generateTestsStub(
  input: GenerateTestsInput,
  ctx: ToolContext,
): Promise<{ ok: true; data: GeneratedTest }> {
  const className = input.codeAnalysis.definedSymbols[0]?.name ?? "Target";
  const testClassName = `${className}Test`;
  const methodNames = input.codeAnalysis.methods.map((m) => m.name).slice(0, 3);
  const wantFail =
    (input.userConstraints ?? "").includes("fail") || (input.userFeedback ?? "").includes("失败");

  const cases = methodNames.length > 0 ? methodNames : ["example"];
  const body = cases
    .map(
      (name, i) => `    @Test
    void test${name.charAt(0).toUpperCase()}${name.slice(1)}() {
        // [stub] Arrange-Act-Assert${i === 0 && wantFail ? "（演示用故意失败用例）" : ""}
        ${i === 0 && wantFail ? 'fail("STUB_FAIL: 演示失败路径");' : `org.junit.jupiter.api.Assertions.assertTrue(true);`}
    }`,
    )
    .join("\n\n");

  const code = `package ${input.codeAnalysis.packageName ?? "com.example"};

import org.junit.jupiter.api.Test;
${wantFail ? "import static org.junit.jupiter.api.Assertions.fail;" : ""}
// [stub] 由 generate_tests 桩工具生成（M2 替换为真 LLM 生成实现）
// userConstraints: ${input.userConstraints ?? "(无)"}
// userFeedback: ${input.userFeedback ?? "(无)"}

class ${testClassName} {

${body}
}
`;

  const data: GeneratedTest = {
    packageName: input.codeAnalysis.packageName,
    className: testClassName,
    code,
    targetFilePath: `src/test/java/${(input.codeAnalysis.packageName ?? "com.example").split(".").join("/")}/${testClassName}.java`,
    framework: "junit5",
  };
  ctx.session.state.latest.generatedTest = data;
  putArtifact(ctx.session, "test_code", code, `${testClassName}（${cases.length} 个用例，stub 生成）`);
  return { ok: true, data };
}

// ───────────────────────── 6. run_tests（桩：罐头结果；代码含 fail() 标记则走失败路径） ─────────────────────────

/**
 * 桩：罐头执行结果（M2 人员2 换成沙箱写入 + Maven/Gradle 真执行）。
 * 成败分支：测试代码含 STUB_FAIL 标记 → test_failure（恰 1 个失败 + 失败详情）；否则 → success 全过。
 * testCount 按代码里 @Test 注解个数统计（至少 1）。
 * 副作用：更新 latest.testResult + 产物存档（test_result 的完整 JSON）。
 */
export async function runTestsStub(
  input: RunTestsInput,
  ctx: ToolContext,
): Promise<{ ok: true; data: TestResult }> {
  const willFail = input.generatedTest.code.includes("STUB_FAIL");
  const testCount = Math.max(1, (input.generatedTest.code.match(/@Test/g) ?? []).length);
  const failing = `${input.generatedTest.className}#test${(input.generatedTest.className ?? "Target").replace("Test", "")}`;

  const data: TestResult = willFail
    ? {
        status: "test_failure",
        passed: false,
        testCount,
        passedCount: testCount - 1,
        failedCount: 1,
        skippedCount: 0,
        failureDetails: [
          "testExample(): STUB_FAIL: 演示失败路径 ==> org.opentest4j.AssertionFailedError",
        ],
        failingTests: [failing],
        compilationError: null,
        message: `[stub] Tests run: ${testCount}, Failures: 1, Errors: 0, Skipped: 0`,
        stderr: null,
        durationMs: 1234,
      }
    : {
        status: "success",
        passed: true,
        testCount,
        passedCount: testCount,
        failedCount: 0,
        skippedCount: 0,
        failureDetails: [],
        failingTests: [],
        compilationError: null,
        message: `[stub] Tests run: ${testCount}, Failures: 0, Errors: 0, Skipped: 0`,
        stderr: null,
        durationMs: 1234,
      };

  ctx.session.state.latest.testResult = data;
  putArtifact(
    ctx.session,
    "test_result",
    JSON.stringify(data, null, 2),
    data.message ?? undefined,
  );
  return { ok: true, data };
}

// ───────────────────────── 7. diagnose_failures（桩：失败一律归为断言类 → 触发双重确认） ─────────────────────────

/**
 * 桩：把每个失败用例一律归类为 assertion_error，且 requiresDoubleConfirm=true、autoRepairable=false
 * ——刻意让所有失败都命中 §3.7 护栏路径（自动修复必须停下问用户），方便演示与验收；
 * M2 人员2 换成真诊断（区分编译错/mock 配置/断言/源码 bug 等，编译类才允许自动修）。
 */
export async function diagnoseFailuresStub(
  input: DiagnoseFailuresInput,
  ctx: ToolContext,
): Promise<{ ok: true; data: Diagnosis }> {
  const items = (input.testResult.failingTests.length > 0
    ? input.testResult.failingTests
    : ["(unknown)"]
  ).map((t) => ({
    failingTest: t,
    failureClass: "assertion_error" as const,
    evidence: input.testResult.failureDetails[0] ?? "(无失败详情)",
    suspectedCause:
      "[stub] 断言预期与实际行为不符：可能是被测代码缺陷，也可能是断言写错。需结合源码确认（可用 read_project_file 查看被测方法实现）。",
    suggestedAction: "向用户说明两种可能；如用户确认修改断言，走双重确认流程（repair_tests + assertionLevelChange=true）。",
    autoRepairable: false,
    requiresDoubleConfirm: true,
    confidence: 0.6,
  }));
  const data: Diagnosis = {
    items,
    summary: `[stub] ${items.length} 个失败均归类为断言问题（requiresDoubleConfirm=true），自动修复循环必须停下询问用户。`,
  };
  ctx.session.state.latest.diagnosis = data;
  putArtifact(ctx.session, "diagnosis", JSON.stringify(data, null, 2), data.summary);
  return { ok: true, data };
}

// ───────────────────────── 8. repair_tests 桩本体（护栏校验在 agent.ts 包装器，不在这里） ─────────────────────────

/**
 * 桩本体：移除 STUB_FAIL 标记（让重跑通过）+ 在文件头追加修复说明注释。
 * ⚠️ 注意：护栏校验不在这里——在 agent.ts 的 handleRepairCall 包装器里，
 * 能执行到本函数说明「非断言级修改」或「双重确认凭证已验真」。M2 人员2 换成真 LLM 修复。
 */
export async function repairTestsStub(
  input: RepairTestsInput,
  ctx: ToolContext,
): Promise<{ ok: true; data: GeneratedTest }> {
  // 桩策略：移除故意失败标记 + 追加修复说明注释（M2 由人员2 替换为真 LLM 修复）
  const repairedCode = input.generatedTest.code
    .replaceAll("STUB_FAIL", "STUB_REPAIRED")
    .replace(
      /fail\("STUB_REPAIRED[^"]*"\);/,
      'org.junit.jupiter.api.Assertions.assertTrue(true); // [stub] 按双重确认修改',
    )
    .replace(
      /^(package [^\n]+;)/m,
      `$1\n// [stub] repair_tests 已执行：${input.userInstruction ?? "双重确认后的断言修改"}`,
    );
  const data: GeneratedTest = { ...input.generatedTest, code: repairedCode };
  ctx.session.state.latest.generatedTest = data;
  putArtifact(ctx.session, "test_code", repairedCode, `${data.className}（修复后，stub）`);
  return { ok: true, data };
}

// ───────────────────────── 9. read_artifact（真实现：从会话产物库读取） ─────────────────────────

/**
 * 真实现：按 ID 从档案室取产物全文（对话追问「为什么失败」的数据来源）。
 * 分支：ID 不存在 → 结构化错误（LLM 收到后会换 ID 或改用其他工具）；超 maxBytes → 截断并标记 truncated。
 */
export async function readArtifactStub(
  input: ReadArtifactInput,
  ctx: ToolContext,
): Promise<
  | { ok: true; data: { artifactId: string; kind: string; content: string; truncated: boolean } }
  | { ok: false; error: string; retryable: boolean }
> {
  const entry = ctx.session.artifacts.get(input.artifactId);
  if (!entry) {
    return {
      ok: false,
      error: `artifactId 不存在: ${input.artifactId}（可用 ID 见会话产物列表）`,
      retryable: false,
    };
  }
  const truncated = entry.content.length > input.maxBytes;
  return {
    ok: true,
    data: {
      artifactId: entry.artifactId,
      kind: entry.kind,
      content: entry.content.slice(0, input.maxBytes),
      truncated,
    },
  };
}
