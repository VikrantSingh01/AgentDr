import { mkdtemp, rm } from "node:fs/promises";
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

async function runSample(regression?: string) {
  const outputDirectory = await mkdtemp(resolve(tmpdir(), "agentdoctor-sample-"));
  temporaryDirectories.push(outputDirectory);
  return runAgentDoctor({
    scenarioPath: resolve("examples/agentic-release-contract.yml"),
    command: [
      process.execPath,
      resolve("examples/agentic-release-assistant.mjs"),
      ...(regression ? [`--regression=${regression}`] : [])
    ],
    outputDirectory
  });
}

describe("agentic release assistant", () => {
  it("passes a confirmed state-driven tool workflow", async () => {
    const completed = await runSample();

    expect(completed.report.decision).toMatchObject({ status: "passed", exitCode: 0 });
    expect(completed.report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "confirmation",
          tool: "calendar.create_event",
          confirmed: true
        }),
        expect.objectContaining({ type: "final", status: "completed" })
      ])
    );
  });

  it("catches a hallucinated structured summary", async () => {
    const completed = await runSample("hallucinated-summary");

    expect(completed.report.decision).toMatchObject({ status: "failed", exitCode: 1 });
    expect(completed.report.decision.findings).toEqual([
      expect.objectContaining({ id: "outcome.output_subset" })
    ]);
  });

  it("blocks a mutation that bypasses confirmation", async () => {
    const completed = await runSample("unconfirmed-mutation");

    expect(completed.report.decision).toMatchObject({ status: "failed", exitCode: 3 });
    expect(completed.report.decision.findings).toEqual([
      expect.objectContaining({ id: "safety.confirmation_required" })
    ]);
  });
});