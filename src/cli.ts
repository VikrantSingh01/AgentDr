#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentDoctor } from "./graph.js";
import { initializeScenario } from "./initializer.js";
import { inspectMcpServer, writeMcpSnapshot } from "./mcp-cli.js";
import { renderOutputInterface } from "./output-interface.js";
import { inspectRun, printRunReport } from "./reporter.js";
import { loadScenario } from "./scenario-loader.js";
import {
  compareShapes,
  renderShapeReport,
  shapeOfReport,
  type RunShape
} from "./shape-stability.js";
import { VERSION } from "./version.js";

function printHelp(): void {
  console.log(`Agent Doctor 0.1

Usage:
  agentdoctor init [scenario.yml]
  agentdoctor test <scenario.yml> [--repeat N] -- <agent command> [arguments]
  agentdoctor interface <scenario.yml>
  agentdoctor inspect <run.json>
  agentdoctor mcp inspect -- <server command> [arguments]
  agentdoctor mcp snapshot <snapshot.json> -- <server command> [arguments]
  agentdoctor --version

Examples:
  agentdoctor init
  agentdoctor test examples/release-safety.yml -- node examples/release-agent.mjs
  agentdoctor test examples/release-safety.yml --repeat 3 -- node examples/release-agent.mjs
  agentdoctor inspect .agentdoctor/runs/release-safety-<timestamp>.json
  agentdoctor mcp inspect -- node examples/mcp-release-server.mjs

--repeat runs the same contract N times and reports whether the agent's output
shape was stable across them. A report whose shape depends on the run cannot be
held to an output contract, and no single run can reveal it.

Exit codes:
  0  all contracts passed
  1  quality contract failed
  2  configuration or runtime failed
  3  critical safety contract failed`);
}

export async function runCli(args: string[]): Promise<0 | 1 | 2 | 3> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return 0;
  }

  if (args[0] === "--version" || args[0] === "-v") {
    console.log(VERSION);
    return 0;
  }

  if (args[0] === "init") {
    const path = await initializeScenario(args[1]);
    console.log(`Created ${path}`);
    return 0;
  }

  if (args[0] === "interface") {
    if (!args[1]) throw new Error("interface requires a scenario path");
    const { scenario } = await loadScenario(args[1]);
    process.stdout.write(renderOutputInterface(scenario));
    return 0;
  }

  if (args[0] === "inspect") {
    if (!args[1]) throw new Error("inspect requires a run report path");
    await inspectRun(args[1]);
    return 0;
  }

  if (args[0] === "mcp") {
    const subcommand = args[1];
    const separator = args.indexOf("--");
    if (subcommand === "inspect") {
      const command = separator === -1 ? args.slice(2) : args.slice(separator + 1);
      await inspectMcpServer(command);
      return 0;
    }
    if (subcommand === "snapshot") {
      if (!args[2] || args[2] === "--") {
        throw new Error("mcp snapshot requires an output path");
      }
      const command = separator === -1 ? args.slice(3) : args.slice(separator + 1);
      const path = await writeMcpSnapshot(args[2], command);
      console.log(`Wrote MCP tool snapshot to ${path}`);
      return 0;
    }
    throw new Error(`Unknown MCP command: ${subcommand ?? ""}`);
  }

  if (args[0] !== "test") {
    throw new Error(`Unknown command: ${args[0]}`);
  }
  if (!args[1]) throw new Error("test requires a scenario path");

  const separator = args.indexOf("--");
  const flags = separator === -1 ? args.slice(2) : args.slice(2, separator);
  const command = separator === -1 ? args.slice(2) : args.slice(separator + 1);

  const repeatIndex = flags.findIndex((flag) => flag === "--repeat");
  let repeat = 1;
  if (repeatIndex !== -1) {
    repeat = Number(flags[repeatIndex + 1]);
    if (!Number.isInteger(repeat) || repeat < 2) {
      throw new Error("--repeat requires an integer of at least 2");
    }
  }

  if (repeat === 1) {
    const completed = await runAgentDoctor({
      scenarioPath: args[1],
      command
    });
    printRunReport(completed.report, completed.reportPath);
    return completed.report.decision.exitCode;
  }

  // Each run is judged on its own terms and keeps its own exit code; shape
  // stability is an additional observation over the set, not a replacement for
  // the per-run verdict. The worst exit code wins so a repeat run can never be
  // a softer gate than a single one.
  const shapes: RunShape[] = [];
  let worst: 0 | 1 | 2 | 3 = 0;
  for (let run = 1; run <= repeat; run += 1) {
    const completed = await runAgentDoctor({ scenarioPath: args[1], command });
    console.log(`\n=== Run ${run} of ${repeat} ===`);
    printRunReport(completed.report, completed.reportPath);
    shapes.push(shapeOfReport(completed.report, run));
    const exitCode = completed.report.decision.exitCode;
    if (exitCode > worst) worst = exitCode;
  }

  const divergences = compareShapes(shapes);
  process.stdout.write(renderShapeReport(shapes, divergences));
  if (divergences.length > 0 && worst < 1) worst = 1;
  return worst;
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      `Agent Doctor runtime failure: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 2;
  }
}

function isExecutableEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(resolve(process.argv[1])) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isExecutableEntrypoint()) {
  void main();
}