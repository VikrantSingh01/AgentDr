import { afterEach, describe, expect, it, vi } from "vitest";
import {
  escapeGitHubCommandValue,
  printRunReport
} from "../src/reporter.js";
import type { RunReport } from "../src/types.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GitHub Actions reporting", () => {
  it("escapes workflow-command control characters", () => {
    expect(
      escapeGitHubCommandValue("failure\r\n::add-mask::attacker%value")
    ).toBe("failure%0D%0A::add-mask::attacker%25value");
  });

  it("never prints an injected standalone workflow command", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const report: RunReport = {
      reportVersion: "0.1",
      runId: "run",
      scenarioId: "scenario",
      scenarioPath: "scenario.yml",
      command: ["node", "agent.mjs"],
      startedAt: new Date().toISOString(),
      durationMs: 1,
      graph: [],
      evidence: [],
      decision: {
        status: "failed",
        exitCode: 1,
        findings: [
          {
            id: "runtime.execution",
            severity: "error",
            message: "failure\n::add-mask::attacker"
          }
        ]
      }
    };

    printRunReport(report, "report.json");

    expect(log.mock.calls).toEqual([
      ["FAIL scenario (1ms)"],
      ["  ERROR failure\\n::add-mask::attacker"],
      ["::warning::failure%0A::add-mask::attacker"],
      ["Evidence: report.json"]
    ]);
  });
});