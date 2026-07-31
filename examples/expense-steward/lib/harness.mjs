// Shared driver for the expense-steward reference domain. Runs Agent Doctor
// through the built CLI, exactly the way a consumer does, and reads the JSON
// report it writes.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const domainRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(domainRoot, "..", "..");

export const agentDoctorCli =
  process.env.AGENTDOCTOR_CLI ?? resolve(repoRoot, "dist/src/cli.js");

export const adapterPath = resolve(domainRoot, "adapter.mjs");
export const contractPath = resolve(domainRoot, "contract.yml");

function scenarioPath(contract) {
  if (isAbsolute(contract)) return contract;
  return resolve(domainRoot, contract);
}

function readEvidencePath(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith("Evidence: "));
  return line ? line.slice("Evidence: ".length).trim() : undefined;
}

/**
 * @param {string} contract absolute path or a path relative to the domain root
 * @param {string[]} agentArgs extra flags for the adapter (--fault=, --mutation=)
 */
export function runContract(contract, agentArgs = []) {
  const result = spawnSync(
    process.execPath,
    [
      agentDoctorCli,
      "test",
      scenarioPath(contract),
      "--",
      process.execPath,
      adapterPath,
      ...agentArgs
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );

  if (result.error) {
    throw new Error(`Failed to run Agent Doctor: ${result.error.message}`);
  }

  const stdout = result.stdout ?? "";
  const evidencePath = readEvidencePath(stdout);
  const report = evidencePath ? JSON.parse(readFileSync(evidencePath, "utf8")) : undefined;

  return { exitCode: result.status ?? -1, report, stdout, stderr: result.stderr ?? "" };
}

export function toolCalls(report, tool) {
  if (!report) return [];
  return report.evidence.filter(
    (event) => event.type === "tool_call" && (tool === undefined || event.tool === tool)
  );
}

export function findingIds(report) {
  if (!report) return [];
  return report.decision.findings.map((finding) => finding.id);
}

export function finalOutput(report) {
  if (!report) return undefined;
  return report.evidence.find((event) => event.type === "final")?.output;
}

export function finalStatus(report) {
  if (!report) return undefined;
  return report.evidence.find((event) => event.type === "final")?.status;
}
