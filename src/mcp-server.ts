import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { stat, readFile, realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { terminateChildProcess } from "./agent-process.js";
import type { EvidenceEvent, Finding, RunReport } from "./types.js";
import { VERSION } from "./version.js";

const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const MAX_RUN_TIMEOUT_MS = 120_000;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_SUMMARY_ITEMS = 100;
const MAX_TEXT_CHARS = 4000;
const MAX_VALUE_CHARS = 4000;

const exitCodeMeanings = {
  0: "pass",
  1: "contract failure",
  2: "runtime error",
  3: "safety or pre-dispatch denial"
} as const;

const exitCodeSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3)
]);

const findingSummarySchema = z.object({
  id: z.string(),
  severity: z.string(),
  message: z.string(),
  messageTruncated: z.boolean().optional(),
  evidenceSequence: z.number().int().optional()
});

const exitCodeSummarySchema = z.object({
  code: exitCodeSchema,
  meaning: z.string()
});

const diagnosticsSchema = z.object({
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  stderrPreview: z.string().optional()
});

export const runContractInputSchema = z
  .object({
    scenarioPath: z.string().min(1).describe("Path to an Agent Doctor scenario YAML file"),
    agentCommand: z
      .array(z.string().min(1))
      .min(1)
      .describe("Agent command tokens. This is never executed through a shell."),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(MAX_RUN_TIMEOUT_MS)
      .optional()
      .describe("Maximum wall clock duration for this MCP tool call in milliseconds")
  })
  .strict();

export const explainReportInputSchema = z
  .object({
    reportPath: z.string().min(1).describe("Path to an existing Agent Doctor JSON report")
  })
  .strict();

const runContractOutputSchema = z.object({
  status: z.enum(["passed", "failed", "runtime_failed"]),
  exitCode: exitCodeSummarySchema,
  findings: z.array(findingSummarySchema),
  toolCallCount: z.number().int().nonnegative(),
  evidencePath: z.string().nullable(),
  diagnostics: diagnosticsSchema
});

const toolCallSchema = z.object({
  sequence: z.number().int(),
  callId: z.string(),
  tool: z.string(),
  arguments: z.unknown()
});

const lifecycleEventSchema = z.object({
  sequence: z.number().int(),
  callId: z.string(),
  tool: z.string(),
  state: z.string(),
  mode: z.string(),
  reason: z.string().optional()
});

const finalEventSchema = z
  .object({
    sequence: z.number().int(),
    status: z.string(),
    output: z.unknown().optional()
  })
  .nullable();

const reportExplanationOutputSchema = z.object({
  reportPath: z.string(),
  scenarioId: z.string(),
  scenarioPath: z.string(),
  command: z.array(z.string()),
  durationMs: z.number(),
  decision: z.object({
    status: z.enum(["passed", "failed", "runtime_failed"]),
    exitCode: exitCodeSummarySchema
  }),
  findings: z.array(findingSummarySchema),
  toolCalls: z.object({
    count: z.number().int().nonnegative(),
    items: z.array(toolCallSchema),
    truncated: z.boolean()
  }),
  lifecycle: z.object({
    count: z.number().int().nonnegative(),
    items: z.array(lifecycleEventSchema),
    truncated: z.boolean()
  }),
  final: finalEventSchema
});

type ExitCode = keyof typeof exitCodeMeanings;
export type RunContractInput = z.infer<typeof runContractInputSchema>;
export type ExplainReportInput = z.infer<typeof explainReportInputSchema>;

export interface AgentDoctorMcpOptions {
  cwd?: string;
  cliPath?: string;
  defaultTimeoutMs?: number;
}

interface CliResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  evidencePath: string | null;
  timedOut: boolean;
}

function exitCodeSummary(code: ExitCode) {
  return { code, meaning: exitCodeMeanings[code] };
}

function statusFromExitCode(code: ExitCode): RunReport["decision"]["status"] {
  return code === 0 ? "passed" : code === 2 ? "runtime_failed" : "failed";
}

function truncateText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_TEXT_CHARS) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, MAX_TEXT_CHARS)} [truncated]`,
    truncated: true
  };
}

function summarizeFinding(finding: Finding) {
  const message = truncateText(finding.message);
  return {
    id: finding.id,
    severity: finding.severity,
    message: message.text,
    ...(message.truncated ? { messageTruncated: true } : {}),
    ...(finding.evidenceSequence !== undefined
      ? { evidenceSequence: finding.evidenceSequence }
      : {})
  };
}

function limitJsonValue(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= MAX_VALUE_CHARS) return value;
  return {
    truncated: true,
    preview: `${text.slice(0, MAX_VALUE_CHARS)} [truncated]`
  };
}

function captureChunk(
  previous: string,
  chunk: Buffer,
  bytes: number
): { text: string; bytes: number; truncated: boolean } {
  const nextBytes = bytes + chunk.length;
  if (previous.length >= MAX_CAPTURE_BYTES) {
    return { text: previous, bytes: nextBytes, truncated: true };
  }
  const next = `${previous}${chunk.toString("utf8")}`;
  if (next.length <= MAX_CAPTURE_BYTES) {
    return { text: next, bytes: nextBytes, truncated: false };
  }
  return {
    text: next.slice(0, MAX_CAPTURE_BYTES),
    bytes: nextBytes,
    truncated: true
  };
}

async function requireFilePath(pathValue: string, label: string): Promise<string> {
  if (pathValue.includes("\0")) {
    throw new Error(`${label} contains an invalid null character`);
  }
  const resolved = resolve(process.cwd(), pathValue);
  let metadata;
  try {
    metadata = await stat(resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} was not found at ${resolved}: ${message}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${label} must be a file: ${resolved}`);
  }
  return realpath(resolved);
}

async function readReport(reportPath: string): Promise<{ path: string; report: RunReport }> {
  const path = await requireFilePath(reportPath, "reportPath");
  const metadata = await stat(path);
  if (metadata.size > MAX_REPORT_BYTES) {
    throw new Error(
      `reportPath exceeds the ${MAX_REPORT_BYTES}-byte Agent Doctor MCP report limit`
    );
  }
  return { path, report: parseRunReport(await readFile(path, "utf8")) };
}

function parseRunReport(content: string): RunReport {
  let document: unknown;
  try {
    document = JSON.parse(content) as unknown;
  } catch {
    throw new Error("Invalid Agent Doctor report: file is not valid JSON");
  }

  const candidate =
    typeof document === "object" && document !== null
      ? (document as Record<string, unknown>)
      : {};
  const decision = candidate.decision as Record<string, unknown> | undefined;
  if (
    typeof document !== "object" ||
    document === null ||
    candidate.reportVersion !== "0.1" ||
    typeof candidate.runId !== "string" ||
    typeof candidate.scenarioId !== "string" ||
    typeof candidate.scenarioPath !== "string" ||
    !Array.isArray(candidate.command) ||
    typeof candidate.startedAt !== "string" ||
    typeof candidate.durationMs !== "number" ||
    !Array.isArray(candidate.evidence) ||
    !Array.isArray(candidate.graph) ||
    typeof decision !== "object" ||
    decision === null ||
    !["passed", "failed", "runtime_failed"].includes(String(decision.status)) ||
    ![0, 1, 2, 3].includes(Number(decision.exitCode)) ||
    !Array.isArray(decision.findings)
  ) {
    throw new Error("Invalid Agent Doctor report: required fields are missing or unsupported");
  }

  return document as RunReport;
}

function resolveDefaultCliPath(): string {
  const siblingCli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
  if (existsSync(siblingCli)) return siblingCli;
  return resolve(process.cwd(), "dist", "src", "cli.js");
}

async function validateEvidencePath(pathValue: string): Promise<string> {
  const trimmed = pathValue.trim();
  if (!isAbsolute(trimmed)) {
    throw new Error(`Agent Doctor CLI returned a non-absolute evidence path: ${trimmed}`);
  }
  return requireFilePath(trimmed, "evidencePath");
}

function waitForCli(
  child: ChildProcess,
  timeoutMs: number,
  getResult: () => Omit<CliResult, "exitCode" | "signal" | "timedOut">
): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...getResult(), exitCode, signal, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateChildProcess(child).then(() => settle(child.exitCode, child.signalCode));
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new Error(`Could not start Agent Doctor CLI: ${error.message}`));
    });
    child.once("close", settle);
  });
}

async function runCliForContract(
  scenarioPath: string,
  agentCommand: string[],
  timeoutMs: number,
  options: AgentDoctorMcpOptions
): Promise<CliResult> {
  const cliPath = await requireFilePath(
    options.cliPath ?? resolveDefaultCliPath(),
    "Agent Doctor CLI"
  );
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let evidencePath: string | null = null;
  const child = spawn(
    process.execPath,
    [cliPath, "test", scenarioPath, "--", ...agentCommand],
    {
      cwd: resolve(options.cwd ?? process.cwd()),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    }
  );
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const match = line.match(/^Evidence:\s+(.+)$/);
    if (match) evidencePath = match[1];
  });
  child.stdout.on("data", (chunk: Buffer) => {
    const captured = captureChunk(stdout, chunk, stdoutBytes);
    stdout = captured.text;
    stdoutBytes = captured.bytes;
    stdoutTruncated = stdoutTruncated || captured.truncated;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const captured = captureChunk(stderr, chunk, stderrBytes);
    stderr = captured.text;
    stderrBytes = captured.bytes;
    stderrTruncated = stderrTruncated || captured.truncated;
  });
  try {
    return await waitForCli(child, timeoutMs, () => ({
      stdout,
      stderr,
      stdoutBytes,
      stderrBytes,
      stdoutTruncated,
      stderrTruncated,
      evidencePath
    }));
  } finally {
    lines.close();
  }
}

function parseExitCode(code: number | null, signal: NodeJS.Signals | null): ExitCode {
  if (code === 0 || code === 1 || code === 2 || code === 3) return code;
  throw new Error(
    `Agent Doctor CLI exited with unsupported code ${code ?? "null"}${
      signal ? ` and signal ${signal}` : ""
    }`
  );
}

function diagnosticsFromCli(result: CliResult) {
  const stderrPreview = truncateText(result.stderr.trim());
  return {
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated || stderrPreview.truncated,
    ...(stderrPreview.text ? { stderrPreview: stderrPreview.text } : {})
  };
}

function summarizeRunReport(
  report: RunReport,
  evidencePath: string,
  actualExitCode: ExitCode,
  diagnostics: ReturnType<typeof diagnosticsFromCli>
) {
  const toolCallCount = report.evidence.filter((event) => event.type === "tool_call").length;
  return {
    status: report.decision.status,
    exitCode: exitCodeSummary(actualExitCode),
    findings: report.decision.findings.map(summarizeFinding),
    toolCallCount,
    evidencePath,
    diagnostics
  };
}

export async function runContract(
  input: unknown,
  options: AgentDoctorMcpOptions = {}
) {
  const parsed = runContractInputSchema.parse(input);
  const scenarioPath = await requireFilePath(parsed.scenarioPath, "scenarioPath");
  if (parsed.agentCommand.some((part) => part.includes("\0"))) {
    throw new Error("agentCommand contains an invalid null character");
  }
  const timeoutMs = parsed.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const result = await runCliForContract(
    scenarioPath,
    parsed.agentCommand,
    timeoutMs,
    options
  );
  if (result.timedOut) {
    throw new Error(`Agent Doctor CLI timed out after ${timeoutMs}ms`);
  }
  const code = parseExitCode(result.exitCode, result.signal);
  const diagnostics = diagnosticsFromCli(result);
  if (!result.evidencePath) {
    return {
      status: statusFromExitCode(code),
      exitCode: exitCodeSummary(code),
      findings: [],
      toolCallCount: 0,
      evidencePath: null,
      diagnostics
    };
  }
  const evidencePath = await validateEvidencePath(result.evidencePath);
  const { report } = await readReport(evidencePath);
  return summarizeRunReport(report, evidencePath, code, diagnostics);
}

function summarizeToolCalls(evidence: EvidenceEvent[]) {
  const calls = evidence.filter(
    (event): event is Extract<EvidenceEvent, { type: "tool_call" }> =>
      event.type === "tool_call"
  );
  return {
    count: calls.length,
    items: calls.slice(0, MAX_SUMMARY_ITEMS).map((event) => ({
      sequence: event.sequence,
      callId: event.callId,
      tool: event.tool,
      arguments: limitJsonValue(event.arguments)
    })),
    truncated: calls.length > MAX_SUMMARY_ITEMS
  };
}

function summarizeLifecycle(evidence: EvidenceEvent[]) {
  const events = evidence.filter(
    (event): event is Extract<EvidenceEvent, { type: "tool_lifecycle" }> =>
      event.type === "tool_lifecycle"
  );
  return {
    count: events.length,
    items: events.slice(0, MAX_SUMMARY_ITEMS).map((event) => ({
      sequence: event.sequence,
      callId: event.callId,
      tool: event.tool,
      state: event.state,
      mode: event.mode,
      ...(event.reason ? { reason: event.reason } : {})
    })),
    truncated: events.length > MAX_SUMMARY_ITEMS
  };
}

function summarizeFinal(evidence: EvidenceEvent[]) {
  const final = evidence.find(
    (event): event is Extract<EvidenceEvent, { type: "final" }> =>
      event.type === "final"
  );
  if (!final) return null;
  return {
    sequence: final.sequence,
    status: final.status,
    ...(final.output !== undefined ? { output: limitJsonValue(final.output) } : {})
  };
}

export async function explainReport(input: unknown) {
  const parsed = explainReportInputSchema.parse(input);
  const { path, report } = await readReport(parsed.reportPath);
  return {
    reportPath: path,
    scenarioId: report.scenarioId,
    scenarioPath: report.scenarioPath,
    command: report.command,
    durationMs: report.durationMs,
    decision: {
      status: report.decision.status,
      exitCode: exitCodeSummary(report.decision.exitCode)
    },
    findings: report.decision.findings.map(summarizeFinding),
    toolCalls: summarizeToolCalls(report.evidence),
    lifecycle: summarizeLifecycle(report.evidence),
    final: summarizeFinal(report.evidence)
  };
}

function structured<T>(output: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output
  };
}

export function createAgentDoctorMcpServer(options: AgentDoctorMcpOptions = {}) {
  const server = new McpServer({
    name: "agentdoctor",
    version: VERSION
  });

  server.registerTool(
    "run_contract",
    {
      description:
        "Run one Agent Doctor scenario through the Agent Doctor CLI and return the deterministic report summary",
      inputSchema: runContractInputSchema,
      outputSchema: runContractOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false
      }
    },
    async (input) => structured(await runContract(input, options))
  );

  server.registerTool(
    "explain_report",
    {
      description:
        "Summarize an existing Agent Doctor JSON report without model judgement or speculation",
      inputSchema: explainReportInputSchema,
      outputSchema: reportExplanationOutputSchema,
      annotations: {
        readOnlyHint: true
      }
    },
    async (input) => structured(await explainReport(input))
  );

  return server;
}

export function serveAgentDoctorMcpServer(options: AgentDoctorMcpOptions = {}): void {
  serveStdio(() => createAgentDoctorMcpServer(options), {
    onerror: (error) =>
      console.error(`Agent Doctor MCP server error: ${error.message}`)
  });
  console.error("Agent Doctor MCP server running");
}
