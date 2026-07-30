import { describe, expect, it } from "vitest";
import { executeAgentProcess } from "../src/agent-process.js";
import type { Scenario } from "../src/types.js";

const scenario: Scenario = {
  schemaVersion: "0.1",
  id: "process-test",
  input: { message: "test" },
  expect: {}
};

function execute(source: string, fixtures: Record<string, unknown> = {}) {
  return executeAgentProcess({
    scenario,
    fixtures,
    command: [process.execPath, "--input-type=module", "--eval", source],
    cwd: process.cwd()
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
});