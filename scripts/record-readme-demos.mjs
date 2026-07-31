import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parse } from "yaml";

const root = process.cwd();
const outputDirectory = resolve("docs/assets");

function normalize(text) {
  return text
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll("\r\n", "\n")
    .replaceAll(root, ".")
    .replaceAll(root.replaceAll("\\", "/"), ".")
    .replaceAll(process.execPath, "node")
    .replaceAll(process.execPath.replaceAll("\\", "/"), "node")
    .replaceAll("\\", "/");
}

async function capture(commandLabel, args, expectedExitCode) {
  let output = "";
  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.on("data", (chunk) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (output += chunk.toString("utf8")));
    child.on("error", rejectPromise);
    child.on("close", resolvePromise);
  });
  if (exitCode !== expectedExitCode) {
    throw new Error(`${commandLabel} exited ${exitCode}; expected ${expectedExitCode}`);
  }
  return { output: normalize(output).trimEnd(), exitCode };
}

function reportPath(output) {
  const match = output.match(/^Evidence:\s+(.+)$/m);
  if (!match) throw new Error("Agent Doctor output did not contain an evidence path");
  return resolve(match[1].replace(/^\.([/\\])/, ""));
}

function portablePath(path) {
  return `./${relative(root, path).replaceAll("\\", "/")}`;
}

function normalizeValue(value) {
  if (typeof value === "string") return normalize(value);
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)])
    );
  }
  return value;
}

async function publishReport(report, filename) {
  const path = resolve(outputDirectory, filename);
  await writeFile(path, `${JSON.stringify(normalizeValue(report), null, 2)}\n`, "utf8");
  return path;
}

function assertReportExitCode(commandLabel, report, expectedExitCode) {
  const actualExitCode = report.decision?.exitCode;
  if (actualExitCode !== expectedExitCode) {
    throw new Error(
      `${commandLabel} report exit code ${actualExitCode}; expected ${expectedExitCode}`
    );
  }
}

async function publishInspectOutput(reportFile, filename) {
  const inspected = await capture(
    `agentdoctor inspect ${portablePath(reportFile)}`,
    ["dist/src/cli.js", "inspect", reportFile],
    0
  );
  await writeFile(resolve(outputDirectory, filename), `${inspected.output}\n`, "utf8");
}

function evidenceLines(report) {
  const events = [...report.evidence].sort((left, right) => left.sequence - right.sequence);
  const lifecycleCounts = new Map();
  for (const event of events) {
    if (event.type === "tool_lifecycle") {
      lifecycleCounts.set(event.callId, (lifecycleCounts.get(event.callId) ?? 0) + 1);
    }
  }
  return events.flatMap((event) => {
    if (event.type === "mcp_discovery") {
      return `#${event.sequence} mcp_discovery tools=${event.tools.length}`;
    }
    if (event.type === "tool_call") {
      const result = events.find(
        (candidate) => candidate.type === "tool_result" && candidate.callId === event.callId
      );
      const sequence = result
        ? `#${event.sequence}-#${result.sequence}`
        : `#${event.sequence}`;
      const source = result ? ` result=${result.source}` : "";
      const lifecycle = lifecycleCounts.has(event.callId)
        ? ` lifecycle=${lifecycleCounts.get(event.callId)}`
        : "";
      return `${sequence} tool_call ${event.tool}${source}${lifecycle}`;
    }
    if (event.type === "tool_result" || event.type === "tool_lifecycle") {
      return [];
    }
    if (event.type === "confirmation") {
      return `#${event.sequence} confirmation ${event.tool}`;
    }
    if (event.type === "final") {
      return `#${event.sequence} final status=${event.status}`;
    }
    return `#${event.sequence} ${event.type} ${event.tool}`;
  });
}

await mkdir(outputDirectory, { recursive: true });

const passRun = await capture(
  "agentdoctor test examples/mcp-release-contract.yml",
  ["dist/src/cli.js", "test", "examples/mcp-release-contract.yml"],
  0
);
const passReportFile = reportPath(passRun.output);
const passReport = JSON.parse(await readFile(passReportFile, "utf8"));
assertReportExitCode("agentdoctor test examples/mcp-release-contract.yml", passReport, 0);
const publishedPassReportFile = await publishReport(passReport, "mcp-pass.report.json");
await publishInspectOutput(
  publishedPassReportFile,
  "mcp-pass.inspect.txt"
);
const passTranscript = [
  "$ agentdoctor test examples/mcp-release-contract.yml",
  `PASS ${passReport.scenarioId}`,
  ...evidenceLines(passReport),
  `Exit code: ${passReport.decision.exitCode}`,
  `Report: ${portablePath(publishedPassReportFile)}`
];
await writeFile(
  resolve(outputDirectory, "mcp-pass.summary.txt"),
  `${passTranscript.join("\n")}\n`,
  "utf8"
);

const safetyRun = await capture(
  "agentdoctor test examples/agentic-release-contract.yml -- node examples/agentic-release-assistant.mjs --regression=unconfirmed-mutation",
  [
    "dist/src/cli.js",
    "test",
    "examples/agentic-release-contract.yml",
    "--",
    process.execPath,
    "examples/agentic-release-assistant.mjs",
    "--regression=unconfirmed-mutation"
  ],
  3
);
const safetyReportFile = reportPath(safetyRun.output);
const safetyReport = JSON.parse(await readFile(safetyReportFile, "utf8"));
assertReportExitCode(
  "agentdoctor test examples/agentic-release-contract.yml -- node examples/agentic-release-assistant.mjs --regression=unconfirmed-mutation",
  safetyReport,
  3
);
const protectedCall = safetyReport.evidence.find(
  (event) => event.type === "tool_call" && event.tool === "calendar.create_event"
);
if (!protectedCall) throw new Error("Safety report did not contain the protected call");
const protectedResult = safetyReport.evidence.find(
  (event) => event.type === "tool_result" && event.callId === protectedCall.callId
);
if (!protectedResult) throw new Error("Safety report did not contain the protected result");
const safetyFinding = safetyReport.decision.findings.find(
  (finding) => finding.id === "safety.confirmation_required"
);
if (!safetyFinding) throw new Error("Safety report did not contain the expected finding");
const safetyScenario = parse(
  await readFile(resolve("examples/agentic-release-contract.yml"), "utf8")
);
const protectedTools = safetyScenario.expect?.confirmation?.requiredBefore;
if (!Array.isArray(protectedTools) || !protectedTools.includes(protectedCall.tool)) {
  throw new Error("Safety scenario does not protect the observed tool call");
}
const publishedSafetyReportFile = await publishReport(
  safetyReport,
  "safety-failure.report.json"
);
await publishInspectOutput(
  publishedSafetyReportFile,
  "safety-failure.inspect.txt"
);
const safetyTranscript = [
  "$ agentdoctor test examples/agentic-release-contract.yml -- node examples/agentic-release-assistant.mjs --regression=unconfirmed-mutation",
  `FAIL ${safetyReport.scenarioId}`,
  `#${protectedCall.sequence} ${protectedCall.type} ${protectedCall.tool}`,
  `#${protectedResult.sequence} ${protectedResult.type} ${protectedResult.tool} source=${protectedResult.source}`,
  `CRITICAL ${safetyFinding.id}`,
  safetyFinding.message,
  `Evidence sequence: #${safetyFinding.evidenceSequence}`,
  `Exit code: ${safetyReport.decision.exitCode}`,
  `Report: ${portablePath(publishedSafetyReportFile)}`
];
await writeFile(
  resolve(outputDirectory, "safety-failure.summary.txt"),
  `${safetyTranscript.join("\n")}\n`,
  "utf8"
);
await writeFile(
  resolve(outputDirectory, "safety-failure.media.json"),
  `${JSON.stringify(
    {
      scenario: "examples/agentic-release-contract.yml",
      confirmationRequiredBefore: protectedCall.tool,
      event: {
        sequence: protectedCall.sequence,
        type: protectedCall.type,
        tool: protectedCall.tool
      },
      result: {
        sequence: protectedResult.sequence,
        type: protectedResult.type,
        tool: protectedResult.tool,
        source: protectedResult.source
      },
      finding: safetyFinding,
      exitCode: safetyReport.decision.exitCode,
      report: portablePath(publishedSafetyReportFile)
    },
    null,
    2
  )}\n`,
  "utf8"
);

console.log("Recorded README reports, inspect output, and animation summaries");