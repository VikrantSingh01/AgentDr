import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  executeAgentProcess,
  terminateChildProcess
} from "../src/agent-process.js";
import type { ToolBackend } from "../src/tool-backend.js";
import type { Scenario } from "../src/types.js";

const scenario: Scenario = {
  schemaVersion: "0.1",
  id: "process-test",
  input: { message: "test" },
  expect: {}
};

function execute(
  source: string,
  fixtures: Record<string, unknown> = {},
  toolBackend?: ToolBackend
) {
  return executeAgentProcess({
    scenario,
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

    await expect(execute(source, { echo: true })).rejects.toThrow(
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

    await expect(execute(source, { echo: true })).rejects.toThrow(
      "Agent reused tool call ID: same"
    );
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
      redact(value) {
        return value;
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