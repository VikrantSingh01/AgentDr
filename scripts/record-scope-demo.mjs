import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = process.cwd();
const outputDirectory = resolve("docs/assets");
const startedAt = Date.now();
const events = [];
const createdRunReports = [];
let transcript = "";

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

function append(text) {
  const clean = normalize(text);
  transcript += clean;
  events.push([
    (Date.now() - startedAt) / 1000,
    "o",
    clean.replaceAll("\n", "\r\n")
  ]);
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

function reportPath(output) {
  const match = output.match(/^Evidence:\s+(.+)$/m);
  if (!match) throw new Error("Agent Doctor output did not contain an evidence path");
  return resolve(match[1].replace(/^\.([/\\])/, ""));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function capture(display, command, args) {
  append(`$ ${display}\n`);
  let output = "";
  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      append(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      append(text);
    });
    child.on("error", rejectPromise);
    child.on("close", resolvePromise);
  });
  append(`Exit code: ${exitCode}\n\n`);
  return { output, exitCode };
}

async function runCli(display, args, expectedExitCode) {
  const run = await capture(display, process.execPath, args);
  if (run.exitCode !== expectedExitCode) {
    throw new Error(
      `${display} exited ${run.exitCode}; expected ${expectedExitCode}\n${normalize(run.output)}`
    );
  }
  const reportFile = reportPath(run.output);
  createdRunReports.push(reportFile);
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  assert(
    report.decision.exitCode === expectedExitCode,
    `${display} report exit code ${report.decision.exitCode}; expected ${expectedExitCode}`
  );
  return { ...run, report, reportFile };
}

async function publishReport(report, filename) {
  const path = resolve(outputDirectory, filename);
  await writeFile(path, `${JSON.stringify(normalizeValue(report), null, 2)}\n`, "utf8");
  return path;
}

function calls(report, tool) {
  return report.evidence.filter((event) => event.type === "tool_call" && event.tool === tool);
}

function results(report, tool) {
  return report.evidence.filter((event) => event.type === "tool_result" && event.tool === tool);
}

function ownerEvidence(report) {
  const ownerResults = results(report, "lookup_owner");
  const assignments = calls(report, "assign_work_item");
  assert(ownerResults.length === 2, "Expected two lookup_owner results");
  assert(assignments.length === 2, "Expected two assign_work_item calls");
  return {
    firstOwner: ownerResults[0].result.owner,
    secondOwner: ownerResults[1].result.owner,
    firstAssignment: assignments[0],
    secondAssignment: assignments[1]
  };
}

async function renderGif() {
  const display =
    'python scripts/render-demo-gifs.py docs/assets/scoped-catch.summary.txt docs/assets/scoped-catch.gif "Scoped expectations catch it" "unscoped passes to scoped fails"';
  const args = [
    "scripts/render-demo-gifs.py",
    "docs/assets/scoped-catch.summary.txt",
    "docs/assets/scoped-catch.gif",
    "Scoped expectations catch it",
    "unscoped passes to scoped fails"
  ];
  append(`$ ${display}\n`);
  let output = "";
  const result = await new Promise((resolvePromise) => {
    const child = spawn("python", args, {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      append(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      append(text);
    });
    child.on("error", (error) => resolvePromise({ exitCode: undefined, error }));
    child.on("close", (exitCode) => resolvePromise({ exitCode }));
  });
  if (result.error) {
    append(`GIF render skipped: ${result.error.message}\n\n`);
    return { rendered: false, reason: result.error.message, output };
  }
  append(`Exit code: ${result.exitCode}\n\n`);
  if (result.exitCode !== 0) {
    return {
      rendered: false,
      reason: `python render exited ${result.exitCode}`,
      output
    };
  }
  return { rendered: true, reason: "", output };
}

await mkdir(outputDirectory, { recursive: true });
await rm(resolve(outputDirectory, "scoped-catch.gif"), { force: true });
await rm(resolve(outputDirectory, "scoped-catch.png"), { force: true });

let renderResult = { rendered: false, reason: "recording did not reach render", output: "" };

try {
  const cli = resolve("dist/src/cli.js");
  const agent = "examples/scoped-triage-agent.mjs";
  const unscopedContract = "examples/scoped-triage-unscoped-contract.yml";
  const scopedContract = "examples/scoped-triage-contract.yml";

  const unscopedRun = await runCli(
    "node dist/src/cli.js test examples/scoped-triage-unscoped-contract.yml -- node examples/scoped-triage-agent.mjs",
    [cli, "test", unscopedContract, "--", process.execPath, agent],
    0
  );
  const unscoped = ownerEvidence(unscopedRun.report);
  assert(
    unscoped.secondAssignment.arguments.assignedTo === unscoped.firstOwner,
    "Buggy agent did not reuse the first owner in the unscoped beat"
  );
  assert(
    unscoped.secondAssignment.arguments.assignedTo !== unscoped.secondOwner,
    "Unscoped beat was not silently wrong"
  );
  const unscopedReport = await publishReport(
    unscopedRun.report,
    "scoped-catch-unscoped.report.json"
  );

  const scopedRun = await runCli(
    "node dist/src/cli.js test examples/scoped-triage-contract.yml -- node examples/scoped-triage-agent.mjs",
    [cli, "test", scopedContract, "--", process.execPath, agent],
    1
  );
  const scoped = ownerEvidence(scopedRun.report);
  const scopedFinding = scopedRun.report.decision.findings.find(
    (finding) =>
      finding.id === "tool.arguments_subset" &&
      finding.evidenceSequence === scoped.secondAssignment.sequence
  );
  assert(scopedFinding, "Scoped beat did not cite tool.arguments_subset on the second assignment");
  const scopedReport = await publishReport(
    scopedRun.report,
    "scoped-catch-scoped-failure.report.json"
  );

  const fixedRun = await runCli(
    "node dist/src/cli.js test examples/scoped-triage-contract.yml -- node examples/scoped-triage-agent.mjs --fixed",
    [cli, "test", scopedContract, "--", process.execPath, agent, "--fixed"],
    0
  );
  const fixed = ownerEvidence(fixedRun.report);
  assert(
    fixed.secondAssignment.arguments.assignedTo === fixed.secondOwner,
    "Fixed beat did not assign the second work item to the second owner"
  );
  const fixedReport = await publishReport(fixedRun.report, "scoped-catch-fixed.report.json");

  const summaryLines = [
    "$ unscoped contract + buggy agent",
    `PASS ${unscopedRun.report.scenarioId}`,
    `Agent wrong: BUG-202 got ${unscoped.secondAssignment.arguments.assignedTo}`,
    "Exit code: 0",
    `Report: ${portablePath(unscopedReport)}`,
    "$ scoped contract + buggy agent",
    `FAIL ${scopedRun.report.scenarioId}`,
    `ERROR ${scopedFinding.id}`,
    `Expected lookup_owner[1].owner=${scoped.secondOwner}`,
    `Actual assign_work_item[1].assignedTo=${scoped.secondAssignment.arguments.assignedTo}`,
    `Evidence sequence: #${scopedFinding.evidenceSequence}`,
    "Exit code: 1",
    `Report: ${portablePath(scopedReport)}`,
    "$ scoped contract + fixed agent",
    `PASS ${fixedRun.report.scenarioId}`,
    `BUG-202 got ${fixed.secondAssignment.arguments.assignedTo}`,
    "Exit code: 0",
    `Report: ${portablePath(fixedReport)}`
  ];

  await writeFile(
    resolve(outputDirectory, "scoped-catch.summary.txt"),
    `${summaryLines.join("\n")}\n`,
    "utf8"
  );

  await writeFile(
    resolve(outputDirectory, "scoped-catch.media.json"),
    `${JSON.stringify(
      {
        contracts: {
          unscoped: unscopedContract,
          scoped: scopedContract
        },
        agent,
        beats: [
          {
            name: "blind spot",
            exitCode: unscopedRun.exitCode,
            status: unscopedRun.report.decision.status,
            finding: "unscoped $fromResult accepts any earlier lookup_owner result",
            secondAssignment: unscoped.secondAssignment.arguments,
            report: portablePath(unscopedReport)
          },
          {
            name: "scoped catch",
            exitCode: scopedRun.exitCode,
            status: scopedRun.report.decision.status,
            finding: scopedFinding,
            expectedOwner: scoped.secondOwner,
            secondAssignment: scoped.secondAssignment.arguments,
            report: portablePath(scopedReport)
          },
          {
            name: "fixed agent",
            exitCode: fixedRun.exitCode,
            status: fixedRun.report.decision.status,
            secondAssignment: fixed.secondAssignment.arguments,
            report: portablePath(fixedReport)
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  renderResult = await renderGif();

  const header = {
    version: 2,
    width: 120,
    height: 36,
    timestamp: Math.floor(startedAt / 1000),
    env: {
      SHELL:
        process.env.SHELL ??
        process.env.ComSpec ??
        (process.platform === "win32" ? "powershell" : "sh"),
      TERM: process.env.TERM ?? "xterm-256color"
    }
  };
  const cast = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))].join(
    "\n"
  );
  await writeFile(resolve(outputDirectory, "scoped-catch.cast"), `${cast}\n`, "utf8");
  await writeFile(resolve(outputDirectory, "scoped-catch.txt"), `${transcript.trimEnd()}\n`, "utf8");

  if (renderResult.rendered) {
    console.log("Recorded scoped expectations demo and rendered docs/assets/scoped-catch.gif");
  } else {
    console.log(
      `Recorded scoped expectations demo; GIF rendering skipped (${renderResult.reason})`
    );
  }
} finally {
  await Promise.all(createdRunReports.map((path) => rm(path, { force: true })));
}
