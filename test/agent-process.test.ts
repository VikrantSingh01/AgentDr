import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { evaluateRun } from "../src/evaluator.js";
import {
  executeAgentProcess,
  terminateChildProcess
} from "../src/agent-process.js";
import type { ToolBackend } from "../src/tool-backend.js";
import type { ResolvedFixtures, Scenario } from "../src/types.js";

const scenario: Scenario = {
  schemaVersion: "0.1",
  id: "process-test",
  input: { message: "test" },
  expect: {}
};

function execute(
  source: string,
  fixtures: ResolvedFixtures = {},
  toolBackend?: ToolBackend,
  scenarioValue: Scenario = scenario
) {
  return executeAgentProcess({
    scenario: scenarioValue,
    fixtures,
    command: [process.execPath, "--input-type=module", "--eval", source],
    cwd: process.cwd(),
    toolBackend
  });
}

describe("child agent protocol", () => {
  it("rejects invalid JSONL", async () => {
    await expect(execute(`console.log("not-json")`)).rejects.toThrow(
      "Agent emitted invalid JSONL"
    );
  });

  it("rejects output after the final event", async () => {
    const source = `
      console.log(JSON.stringify({ type: "final", status: "completed" }));
      console.log(JSON.stringify({ type: "final", status: "completed" }));
    `;

    await expect(execute(source)).rejects.toThrow(
      "Agent emitted output after its final event"
    );
  });

  it("does not resolve inherited fixture properties", async () => {
    const source = `
      console.log(JSON.stringify({ type: "tool_call", callId: "1", tool: "toString" }));
      setTimeout(() => {}, 1000);
    `;

    await expect(execute(source)).rejects.toThrow(
      "No fixture is configured for tool toString"
    );
  });

  it("reports nonzero child exits", async () => {
    await expect(execute(`process.stderr.write("failed"); process.exit(7)`)).rejects.toThrow(
      "Agent exited with code 7: failed"
    );
  });

  it("rejects array tool arguments", async () => {
    const source = `
      console.log(JSON.stringify({
        type: "tool_call",
        callId: "1",
        tool: "echo",
        arguments: []
      }));
    `;

    await expect(
      execute(source, { echo: { cases: [{ result: true }] } })
    ).rejects.toThrow(
      "Agent emitted an unsupported event"
    );
  });

  it("rejects duplicate tool call IDs", async () => {
    const source = `
      const input = await import("node:readline").then(({ createInterface }) =>
        createInterface({ input: process.stdin })
      );
      input.on("line", (line) => {
        const event = JSON.parse(line);
        if (event.type === "run_start") {
          console.log(JSON.stringify({ type: "tool_call", callId: "same", tool: "echo" }));
        } else if (event.type === "tool_result") {
          console.log(JSON.stringify({ type: "tool_call", callId: "same", tool: "echo" }));
        }
      });
    `;

    await expect(
      execute(source, { echo: { cases: [{ result: true }] } })
    ).rejects.toThrow(
      "Agent reused tool call ID: same"
    );
  });

  it("selects ordered fixture cases by per-tool call index and arguments", async () => {
        const source = `
          const input = await import("node:readline").then(({ createInterface }) =>
            createInterface({ input: process.stdin })
          );
          input.on("line", (line) => {
            const event = JSON.parse(line);
            if (event.type === "run_start") {
              console.log(JSON.stringify({
                type: "tool_call", callId: "1", tool: "lookup", arguments: { id: "A" }
              }));
            } else if (event.type === "tool_result" && event.callId === "1") {
              console.log(JSON.stringify({
                type: "tool_call", callId: "2", tool: "lookup", arguments: { id: "A" }
              }));
            } else if (event.type === "tool_result" && event.callId === "2") {
              console.log(JSON.stringify({ type: "final", status: "completed" }));
            }
          });
        `;
        const execution = await execute(source, {
          lookup: {
            cases: [
              { callIndex: 0, arguments: { id: "A" }, result: { page: 1 } },
              { callIndex: 1, arguments: { id: "A" }, result: { page: 2 } }
            ]
          }
        });

        expect(
          execution.evidence
            .filter((event) => event.type === "tool_result")
            .map((event) => event.result)
        ).toEqual([{ page: 1 }, { page: 2 }]);
  });

  it("answers an unmatched fixture case with an error instead of aborting the run", async () => {
        // A real agent will sometimes call a tool with arguments the fixture
        // set does not anticipate. Aborting there would hide every defect
        // later in the trace, so the miss is reported and the run continues.
        const source = `
          const input = await import("node:readline").then(({ createInterface }) =>
            createInterface({ input: process.stdin })
          );
          console.log(JSON.stringify({
            type: "tool_call", callId: "1", tool: "lookup", arguments: { id: "B" }
          }));
          input.on("line", (line) => {
            const event = JSON.parse(line);
            if (event.type === "tool_result" && event.callId === "1") {
              console.log(JSON.stringify({
                type: "tool_call", callId: "2", tool: "lookup", arguments: { id: "A" }
              }));
            } else if (event.type === "tool_result" && event.callId === "2") {
              console.log(JSON.stringify({ type: "final", status: "completed" }));
            }
          });
        `;

        const execution = await execute(source, {
          lookup: {
            cases: [{ arguments: { id: "A" }, result: { found: true } }]
          }
        });

        const results = execution.evidence.filter(
          (event) => event.type === "tool_result"
        );

        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({ isError: true, fixtureMiss: true });
        expect(results[0].result).toMatchObject({ error: "fixture_unmatched" });

        // The call after the miss still ran and still resolved normally, so
        // downstream expectations remain evaluable.
        expect(results[1].result).toEqual({ found: true });
        expect(results[1].fixtureMiss).toBeUndefined();

        const decision = evaluateRun(scenario, execution.evidence, 1);
        expect(decision.findings.map((finding) => finding.id)).toContain(
          "fixture.unmatched_call"
        );
  });

  it("enforces argument-bound confirmation before dispatch", async () => {
        const protectedScenario: Scenario = {
          ...scenario,
          enforcement: { preDispatch: true },
          expect: {
            confirmation: {
              requiredBefore: ["calendar.create_event"],
              bindArguments: true
            }
          }
        };
        const source = `
          const input = await import("node:readline").then(({ createInterface }) =>
            createInterface({ input: process.stdin })
          );
          input.on("line", (line) => {
            const event = JSON.parse(line);
            if (event.type === "run_start") {
              const argumentsValue = { title: "Approved", durationMinutes: 30 };
              console.log(JSON.stringify({
                type: "confirmation",
                confirmed: true,
                tool: "calendar.create_event",
                arguments: argumentsValue
              }));
              console.log(JSON.stringify({
                type: "tool_call",
                callId: "1",
                tool: "calendar.create_event",
                arguments: argumentsValue
              }));
            } else if (event.type === "tool_result") {
              console.log(JSON.stringify({ type: "final", status: "completed" }));
            }
          });
        `;

        const execution = await execute(
          source,
          {
            "calendar.create_event": {
              cases: [{ result: { status: "created" } }]
            }
          },
          undefined,
          protectedScenario
        );

        expect(execution.evidence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "tool_lifecycle", state: "authorized" }),
            expect.objectContaining({ type: "tool_lifecycle", state: "dispatched" }),
            expect.objectContaining({ type: "tool_lifecycle", state: "completed" })
          ])
        );
  });

  it("denies mismatched confirmation arguments before calling the backend", async () => {
        let backendCalls = 0;
        const backend: ToolBackend = {
          async start() {
            return [];
          },
          async call() {
            backendCalls += 1;
            return {
              result: { status: "created" },
              source: "mcp",
              durationMs: 1,
              resultBytes: 20
            };
          },
          async close() {}
        };
        const protectedScenario: Scenario = {
          ...scenario,
          enforcement: { preDispatch: true },
          expect: {
            confirmation: {
              requiredBefore: ["calendar.create_event"],
              bindArguments: true
            }
          }
        };
        const source = `
          console.log(JSON.stringify({
            type: "confirmation",
            confirmed: true,
            tool: "calendar.create_event",
            arguments: { title: "Approved" }
          }));
          console.log(JSON.stringify({
            type: "tool_call",
            callId: "1",
            tool: "calendar.create_event",
            arguments: { title: "Changed" }
          }));
          setTimeout(() => {}, 1000);
        `;

        let execution;
        try {
          await execute(source, {}, backend, protectedScenario);
        } catch (error) {
          execution = (error as { execution?: { evidence: unknown[] } }).execution;
        }

        expect(backendCalls).toBe(0);
        expect(execution?.evidence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "tool_lifecycle",
              state: "denied",
              reason: "confirmation_missing_or_mismatched"
            })
          ])
        );
  });

  it("returns legacy fixture results that contain a cases property unchanged", async () => {
    const source = `
      const input = await import("node:readline").then(({ createInterface }) =>
        createInterface({ input: process.stdin })
      );
      input.on("line", (line) => {
        const event = JSON.parse(line);
        if (event.type === "run_start") {
          console.log(JSON.stringify({ type: "tool_call", callId: "1", tool: "lookup" }));
        } else if (event.type === "tool_result") {
          console.log(JSON.stringify({
            type: "final",
            status: "completed",
            output: event.result
          }));
        }
      });
    `;
    const resultWithCases = { cases: [{ id: "support-case-1" }] };

    const execution = await execute(source, {
      lookup: { cases: [{ result: resultWithCases }] }
    });

    expect(
      execution.evidence.find((event) => event.type === "tool_result")
    ).toMatchObject({ result: resultWithCases });
  });

  it("rejects a final event emitted before an asynchronous tool result", async () => {
    const backend: ToolBackend = {
      async start() {
        return [];
      },
      async call() {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        return {
          result: { value: 42 },
          source: "mcp",
          durationMs: 50,
          resultBytes: 12
        };
      },
      async close() {}
    };
    const source = `
      console.log(JSON.stringify({ type: "tool_call", callId: "pending", tool: "echo" }));
      console.log(JSON.stringify({ type: "final", status: "completed" }));
    `;

    await expect(execute(source, {}, backend)).rejects.toThrow(
      "Agent emitted final before observing tool result for pending"
    );
  });

  it("force-terminates a child that ignores graceful shutdown", async () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
      ],
      {
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true
      }
    );
    await once(child, "spawn");
    const startedAt = Date.now();

    await terminateChildProcess(child);

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("force-terminates POSIX descendants after the group leader exits", async () => {
    if (process.platform === "win32") return;
    const leaderSource = `
      const { spawn } = await import("node:child_process");
      const descendant = spawn(process.execPath, [
        "--input-type=module",
        "--eval",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
      ], { stdio: "ignore" });
      console.log(descendant.pid);
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1000);
    `;
    const leader = spawn(
      process.execPath,
      ["--input-type=module", "--eval", leaderSource],
      {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"]
      }
    );
    const descendantPid = await new Promise<number>((resolvePromise, rejectPromise) => {
      leader.once("error", rejectPromise);
      leader.stdout!.once("data", (chunk: Buffer) => {
        resolvePromise(Number.parseInt(chunk.toString("utf8").trim(), 10));
      });
    });

    await terminateChildProcess(leader);

    expect(() => process.kill(descendantPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" })
    );
  });
});