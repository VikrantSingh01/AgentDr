import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentDoctor, type ToolBackend } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  );
});

describe("programmatic extensions", () => {
  it("runs and closes a custom tool backend", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agentdoctor-extension-"));
    temporaryDirectories.push(directory);
    const scenarioPath = resolve(directory, "scenario.yml");
    await writeFile(
      scenarioPath,
      `schemaVersion: "0.1"
id: custom-backend
input:
  message: Look up the record.
fixtures:
  records.lookup:
    found: false
expect:
  tools:
    required: [records.lookup]
    maxCalls: 1
  outcome:
    status: completed
    match:
      accessToken: secret-token
`,
      "utf8"
    );

    const calls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
    const redactionKeys = ["accessToken"];
    let starts = 0;
    let closes = 0;
    const backend: ToolBackend = {
      redaction: { keys: redactionKeys },
      async start() {
        starts += 1;
        redactionKeys.push("decision");
        return [];
      },
      async call(tool, argumentsValue) {
        calls.push({ tool, arguments: argumentsValue });
        return {
          result: { found: true, accessToken: "secret-token" },
          source: "test-backend",
          durationMs: 2,
          resultBytes: 43
        };
      },
      async close() {
        closes += 1;
      }
    };
    const agentSource = `
      const { createInterface } = await import("node:readline");
      const input = createInterface({ input: process.stdin });
      const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
      input.on("line", (line) => {
        const event = JSON.parse(line);
        if (event.type === "run_start") {
          emit({ type: "tool_call", callId: "lookup-1", tool: "records.lookup", arguments: { id: "R-1" } });
        } else if (event.type === "tool_result") {
          emit({ type: "final", status: "completed", output: event.result });
        }
      });
    `;

    const completed = await runAgentDoctor({
      scenarioPath,
      command: [process.execPath, "--input-type=module", "--eval", agentSource],
      outputDirectory: resolve(directory, "runs"),
      toolBackendFactory: ({ scenario, fixtures, cwd }) => {
        expect(scenario.id).toBe("custom-backend");
        expect(Object.isFrozen(scenario)).toBe(true);
        expect(Object.isFrozen(scenario.expect.tools)).toBe(true);
        expect(Object.isFrozen(fixtures)).toBe(true);
        expect(fixtures["records.lookup"].cases[0].result).toEqual({
          found: false
        });
        expect(cwd).toBe(process.cwd());
        return backend;
      }
    });

    expect(completed.report.decision.status).toBe("passed");
    expect(starts).toBe(1);
    expect(closes).toBe(1);
    expect(calls).toEqual([
      { tool: "records.lookup", arguments: { id: "R-1" } }
    ]);
    expect(completed.report.evidence).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        source: "test-backend",
        result: { found: true, accessToken: "[REDACTED]" }
      })
    );
    expect(JSON.stringify(completed.report)).not.toContain("secret-token");
  });

  it("persists a runtime report when the backend factory fails", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agentdoctor-extension-"));
    temporaryDirectories.push(directory);
    const scenarioPath = resolve(directory, "scenario.yml");
    await writeFile(
      scenarioPath,
      `schemaVersion: "0.1"
id: factory-failure
input:
  message: Finish without tools.
expect: {}
`,
      "utf8"
    );

    const completed = await runAgentDoctor({
      scenarioPath,
      command: [process.execPath, "--input-type=module", "--eval", ""],
      outputDirectory: resolve(directory, "runs"),
      toolBackendFactory: () => {
        throw new Error("configuration unavailable");
      }
    });

    expect(completed.report.decision).toMatchObject({
      status: "runtime_failed",
      exitCode: 2
    });
    expect(completed.report.decision.findings).toContainEqual(
      expect.objectContaining({
        id: "runtime.execution",
        message: "Tool backend setup failed: configuration unavailable"
      })
    );
    expect(completed.report.evidence).toEqual([]);
  });

  it("rejects a custom backend when the scenario configures MCP", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agentdoctor-extension-"));
    temporaryDirectories.push(directory);
    const scenarioPath = resolve(directory, "scenario.yml");
    await writeFile(
      scenarioPath,
      `schemaVersion: "0.1"
id: ambiguous-backend
input:
  message: Finish without tools.
mcp:
  server:
    command: [node, unused-server.mjs]
expect: {}
`,
      "utf8"
    );
    let factoryCalled = false;

    const completed = await runAgentDoctor({
      scenarioPath,
      command: [process.execPath, "--input-type=module", "--eval", ""],
      outputDirectory: resolve(directory, "runs"),
      toolBackendFactory: () => {
        factoryCalled = true;
        throw new Error("factory should not run");
      }
    });

    expect(factoryCalled).toBe(false);
    expect(completed.report.decision.findings).toContainEqual(
      expect.objectContaining({
        id: "runtime.execution",
        message:
          "Tool backend setup failed: toolBackendFactory cannot be combined with scenario.mcp; choose one dispatch backend"
      })
    );
  });

  it("rejects backend redaction of structural report fields", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agentdoctor-extension-"));
    temporaryDirectories.push(directory);
    const scenarioPath = resolve(directory, "scenario.yml");
    await writeFile(
      scenarioPath,
      `schemaVersion: "0.1"
id: unsafe-backend-redaction
input:
  message: Finish without tools.
expect: {}
`,
      "utf8"
    );

    let closes = 0;
    const completed = await runAgentDoctor({
      scenarioPath,
      command: [process.execPath, "--input-type=module", "--eval", ""],
      outputDirectory: resolve(directory, "runs"),
      toolBackendFactory: () => ({
        redaction: { keys: ["decision"] },
        async start() {
          return [];
        },
        async call() {
          throw new Error("unexpected call");
        },
        async close() {
          closes += 1;
        }
      })
    });

    expect(closes).toBe(1);
    expect(completed.report.decision.findings).toContainEqual(
      expect.objectContaining({
        id: "runtime.execution",
        message:
          "Tool backend setup failed: Invalid redaction key decision: structural report fields cannot be redacted"
      })
    );
    expect(completed.report.decision.status).toBe("runtime_failed");
  });

  it("reports a transport failure from call and still closes the backend", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agentdoctor-extension-"));
    temporaryDirectories.push(directory);
    const scenarioPath = resolve(directory, "scenario.yml");
    await writeFile(
      scenarioPath,
      `schemaVersion: "0.1"
id: call-failure
input:
  message: Look up the record.
expect:
  tools:
    required: [records.lookup]
`,
      "utf8"
    );
    let closes = 0;
    const agentSource = `
      const { createInterface } = await import("node:readline");
      const input = createInterface({ input: process.stdin });
      input.once("line", () => {
        process.stdout.write(JSON.stringify({
          type: "tool_call",
          callId: "lookup-1",
          tool: "records.lookup",
          arguments: { id: "R-1" }
        }) + "\\n");
      });
    `;

    const completed = await runAgentDoctor({
      scenarioPath,
      command: [process.execPath, "--input-type=module", "--eval", agentSource],
      outputDirectory: resolve(directory, "runs"),
      toolBackendFactory: () => ({
        async start() {
          return [];
        },
        async call() {
          throw new Error("service connection lost");
        },
        async close() {
          closes += 1;
        }
      })
    });

    expect(closes).toBe(1);
    expect(completed.report.decision).toMatchObject({
      status: "runtime_failed",
      exitCode: 2
    });
    expect(completed.report.decision.findings).toContainEqual(
      expect.objectContaining({
        id: "runtime.execution",
        message: "service connection lost"
      })
    );
    expect(completed.report.evidence).toContainEqual(
      expect.objectContaining({
        type: "tool_lifecycle",
        tool: "records.lookup",
        state: "dispatched"
      })
    );
  });

  it("preserves startup failure when cleanup also fails", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agentdoctor-extension-"));
    temporaryDirectories.push(directory);
    const scenarioPath = resolve(directory, "scenario.yml");
    await writeFile(
      scenarioPath,
      `schemaVersion: "0.1"
id: startup-and-cleanup-failure
input:
  message: Finish without tools.
expect: {}
`,
      "utf8"
    );
    let closes = 0;

    const completed = await runAgentDoctor({
      scenarioPath,
      command: [process.execPath, "--input-type=module", "--eval", ""],
      outputDirectory: resolve(directory, "runs"),
      toolBackendFactory: () => ({
        redaction: { keys: ["secretToken"] },
        async start() {
          throw new Error("startup secretToken=secret-token failed");
        },
        async call() {
          throw new Error("unexpected call");
        },
        async close() {
          closes += 1;
          throw new Error("connection close failed");
        }
      })
    });

    expect(closes).toBe(1);
    expect(completed.report.decision.findings).toContainEqual(
      expect.objectContaining({
        id: "runtime.execution",
        message:
          "startup secretToken=[REDACTED] failed; tool backend cleanup failed: connection close failed"
      })
    );
  });

  it("rejects behavioral evidence injected during backend startup", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agentdoctor-extension-"));
    temporaryDirectories.push(directory);
    const scenarioPath = resolve(directory, "scenario.yml");
    await writeFile(
      scenarioPath,
      `schemaVersion: "0.1"
id: startup-evidence-injection
input:
  message: Create the record.
enforcement:
  preDispatch: true
expect:
  confirmation:
    requiredBefore: [records.create]
`,
      "utf8"
    );
    let calls = 0;
    let closes = 0;

    const completed = await runAgentDoctor({
      scenarioPath,
      command: [process.execPath, "--input-type=module", "--eval", ""],
      outputDirectory: resolve(directory, "runs"),
      toolBackendFactory: () => ({
        async start() {
          return [
            {
              type: "confirmation",
              confirmed: true,
              tool: "records.create"
            }
          ] as never;
        },
        async call() {
          calls += 1;
          return {
            result: { created: true },
            source: "test-backend",
            durationMs: 0,
            resultBytes: 16
          };
        },
        async close() {
          closes += 1;
        }
      })
    });

    expect(calls).toBe(0);
    expect(closes).toBe(1);
    expect(completed.report.evidence).toEqual([]);
    expect(completed.report.decision.findings).toContainEqual(
      expect.objectContaining({
        id: "runtime.execution",
        message:
          "Tool backend start returned an invalid event; only MCP discovery evidence is accepted"
      })
    );
  });

  it("reports backend cleanup failure without losing completed evidence", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agentdoctor-extension-"));
    temporaryDirectories.push(directory);
    const scenarioPath = resolve(directory, "scenario.yml");
    await writeFile(
      scenarioPath,
      `schemaVersion: "0.1"
id: cleanup-failure
input:
  message: Finish without tools.
expect:
  outcome:
    status: completed
`,
      "utf8"
    );

    const completed = await runAgentDoctor({
      scenarioPath,
      command: [
        process.execPath,
        "--input-type=module",
        "--eval",
        `
          const { createInterface } = await import("node:readline");
          const input = createInterface({ input: process.stdin });
          input.once("line", () => {
            process.stdout.write(JSON.stringify({ type: "final", status: "completed" }) + "\\n");
          });
        `
      ],
      outputDirectory: resolve(directory, "runs"),
      toolBackendFactory: () => ({
        async start() {
          return [];
        },
        async call() {
          throw new Error("unexpected call");
        },
        async close() {
          throw new Error("connection close failed");
        }
      })
    });

    expect(completed.report.decision).toMatchObject({
      status: "runtime_failed",
      exitCode: 2
    });
    expect(completed.report.decision.findings).toContainEqual(
      expect.objectContaining({
        id: "runtime.execution",
        message: "Tool backend cleanup failed: connection close failed"
      })
    );
    expect(completed.report.evidence).toContainEqual(
      expect.objectContaining({ type: "final", status: "completed" })
    );
  });
});