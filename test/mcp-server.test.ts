import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { explainReport, runContract } from "../src/mcp-server.js";

const evidencePaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...evidencePaths].map((path) => rm(path, { force: true }))
  );
  evidencePaths.clear();
});

function trackEvidence<T extends { evidencePath: string | null }>(summary: T): T {
  if (summary.evidencePath) evidencePaths.add(summary.evidencePath);
  return summary;
}

describe("Agent Doctor MCP server tools", () => {
  it("run_contract returns pass and exit 0 for a passing contract", async () => {
    const summary = trackEvidence(
      await runContract({
        scenarioPath: "examples/release-safety.yml",
        agentCommand: [process.execPath, resolve("examples/release-agent.mjs")],
        timeoutMs: 15_000
      })
    );

    expect(summary.status).toBe("passed");
    expect(summary.exitCode).toEqual({ code: 0, meaning: "pass" });
    expect(summary.findings).toEqual([]);
    expect(summary.toolCallCount).toBe(3);
    expect(summary.evidencePath).toEqual(expect.stringContaining("release-safety"));
  });

  it("run_contract surfaces a safety failure with exit 3", async () => {
    const summary = trackEvidence(
      await runContract({
        scenarioPath: "examples/release-safety.yml",
        agentCommand: [
          process.execPath,
          resolve("examples/release-agent.mjs"),
          "--unsafe"
        ],
        timeoutMs: 15_000
      })
    );

    expect(summary.status).toBe("failed");
    expect(summary.exitCode).toEqual({
      code: 3,
      meaning: "safety or pre-dispatch denial"
    });
    expect(summary.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tool.forbidden" }),
        expect.objectContaining({ id: "safety.confirmation_required" })
      ])
    );
  });

  it("explain_report parses a report produced by an actual run", async () => {
    const summary = trackEvidence(
      await runContract({
        scenarioPath: "examples/release-safety.yml",
        agentCommand: [process.execPath, resolve("examples/release-agent.mjs")],
        timeoutMs: 15_000
      })
    );

    expect(summary.evidencePath).toBeTruthy();
    const explanation = await explainReport({ reportPath: summary.evidencePath as string });

    expect(explanation.decision.exitCode).toEqual({ code: 0, meaning: "pass" });
    expect(explanation.toolCalls.count).toBe(3);
    expect(explanation.lifecycle.count).toBeGreaterThanOrEqual(9);
    expect(explanation.final).toMatchObject({
      status: "completed"
    });
  });

  it("run_contract rejects a non-array agent command", async () => {
    await expect(
      runContract({
        scenarioPath: "examples/release-safety.yml",
        agentCommand: `${process.execPath} ${resolve("examples/release-agent.mjs")}`
      })
    ).rejects.toThrow(/agentCommand/);
  });
});
