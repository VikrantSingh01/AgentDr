#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentDoctor } from "./graph.js";
import { initializeScenario } from "./initializer.js";
import { inspectRun, printRunReport } from "./reporter.js";
import { VERSION } from "./version.js";

function printHelp(): void {
  console.log(`Agent Doctor 0.1

Usage:
  agentdoctor init [scenario.yml]
  agentdoctor test <scenario.yml> -- <agent command> [arguments]
  agentdoctor inspect <run.json>
  agentdoctor --version

Examples:
  agentdoctor init
  agentdoctor test examples/release-safety.yml -- node examples/release-agent.mjs
  agentdoctor inspect .agentdoctor/runs/release-safety-<timestamp>.json

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

  if (args[0] === "inspect") {
    if (!args[1]) throw new Error("inspect requires a run report path");
    await inspectRun(args[1]);
    return 0;
  }

  if (args[0] !== "test") {
    throw new Error(`Unknown command: ${args[0]}`);
  }
  if (!args[1]) throw new Error("test requires a scenario path");

  const separator = args.indexOf("--");
  const command = separator === -1 ? args.slice(2) : args.slice(separator + 1);
  const completed = await runAgentDoctor({
    scenarioPath: args[1],
    command
  });
  printRunReport(completed.report, completed.reportPath);
  return completed.report.decision.exitCode;
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