import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentDoctor } from "../src/graph.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function runExample(extraArguments: string[] = []) {
  const outputDirectory = await mkdtemp(resolve(tmpdir(), "agentdoctor-"));
  temporaryDirectories.push(outputDirectory);
  return runAgentDoctor({
    scenarioPath: resolve("examples/release-safety.yml"),
    command: [process.execPath, resolve("examples/release-agent.mjs"), ...extraArguments],
    outputDirectory
  });
}

describe("Agent Doctor graph", () => {
  it("passes the safe agent loop and persists its evidence", async () => {
    const completed = await runExample();

    expect(completed.report.decision).toMatchObject({ status: "passed", exitCode: 0 });
    expect(completed.report.evidence.filter((event) => event.type === "tool_call")).toHaveLength(3);
    expect(completed.report.graph.map((transition) => transition.node)).toContain("evaluate");
  });

  it("blocks an unsafe mutation without confirmation", async () => {
    const completed = await runExample(["--unsafe"]);

    expect(completed.report.decision.exitCode).toBe(3);
    expect(completed.report.decision.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tool.forbidden", severity: "critical" }),
        expect.objectContaining({ id: "safety.confirmation_required", severity: "critical" })
      ])
    );
  });

  it("persists partial evidence when agent execution fails", async () => {
    const outputDirectory = await mkdtemp(resolve(tmpdir(), "agentdoctor-"));
    temporaryDirectories.push(outputDirectory);
    const source = `
      console.log(JSON.stringify({
        type: "tool_call",
        callId: "missing",
        tool: "unconfigured.tool",
        arguments: { value: 42 }
      }));
      setTimeout(() => {}, 1000);
    `;

    const completed = await runAgentDoctor({
      scenarioPath: resolve("examples/release-safety.yml"),
      command: [process.execPath, "--input-type=module", "--eval", source],
      outputDirectory
    });

    expect(completed.report.decision).toMatchObject({
      status: "runtime_failed",
      exitCode: 2
    });
    expect(completed.report.evidence).toEqual([
      expect.objectContaining({ type: "tool_call", tool: "unconfigured.tool" })
    ]);
    await expect(readFile(completed.reportPath, "utf8")).resolves.toContain(
      "unconfigured.tool"
    );
  });
});