import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunReport } from "./types.js";

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

  return document as unknown as RunReport;
}

export async function writeRunReport(
  report: RunReport,
  outputDirectory: string
): Promise<string> {
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const timestamp = report.startedAt.replaceAll(":", "-").replaceAll(".", "-");
  const path = resolve(directory, `${report.scenarioId}-${timestamp}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

export function printRunReport(report: RunReport, reportPath: string): void {
  const label =
    report.decision.status === "passed"
      ? "PASS"
      : report.decision.status === "runtime_failed"
        ? "ERROR"
        : "FAIL";
  console.log(`${label} ${report.scenarioId} (${report.durationMs}ms)`);
  for (const finding of report.decision.findings) {
    const sequence = finding.evidenceSequence
      ? ` [evidence #${finding.evidenceSequence}]`
      : "";
    console.log(`  ${finding.severity.toUpperCase()} ${finding.message}${sequence}`);

    if (process.env.GITHUB_ACTIONS === "true") {
      const command = finding.severity === "critical" ? "error" : "warning";
      console.log(`::${command}::${finding.message.replaceAll("%", "%25")}`);
    }
  }
  console.log(`Evidence: ${reportPath}`);
}

export async function inspectRun(path: string): Promise<void> {
  const report = parseRunReport(await readFile(resolve(path), "utf8"));
  printRunReport(report, resolve(path));
  for (const event of report.evidence) {
    if (event.type === "tool_call") {
      console.log(`  #${event.sequence} CALL ${event.tool} ${JSON.stringify(event.arguments)}`);
    } else if (event.type === "tool_result") {
      console.log(`  #${event.sequence} RESULT ${event.tool}`);
    } else if (event.type === "confirmation") {
      console.log(`  #${event.sequence} CONFIRMATION ${event.confirmed}`);
    } else {
      console.log(`  #${event.sequence} FINAL ${event.status}`);
    }
  }
}