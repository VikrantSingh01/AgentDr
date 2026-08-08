import { describe, expect, it } from "vitest";
import { createRedactor, runAgentDoctor } from "../src/index.js";
import type {
  CompletedRun,
  ToolBackend,
  ToolBackendFactory
} from "../src/index.js";

describe("public API", () => {
  it("exports the runner and backend building blocks", () => {
    const backend: ToolBackend = {
      async start() {
        return [];
      },
      async call() {
        return {
          result: { ok: true },
          source: "api-test",
          durationMs: 0,
          resultBytes: 11
        };
      },
      async close() {}
    };
    const factory: ToolBackendFactory = () => backend;
    const completedRunTypeCheck = (run: CompletedRun) => run.report.decision.status;

    expect(runAgentDoctor).toBeTypeOf("function");
    expect(createRedactor).toBeTypeOf("function");
    expect(factory({ scenario: {} as never, fixtures: {}, cwd: process.cwd() }))
      .toBe(backend);
    expect(completedRunTypeCheck).toBeTypeOf("function");
  });
});