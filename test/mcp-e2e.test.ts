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

async function runMcpScenario(regression?: string) {
  const outputDirectory = await mkdtemp(resolve(tmpdir(), "agentdoctor-mcp-"));
  temporaryDirectories.push(outputDirectory);
  return runAgentDoctor({
    scenarioPath: resolve("examples/mcp-release-contract.yml"),
    command: [process.execPath, resolve("examples/agentic-release-assistant.mjs")],
    mcpCommand: [
      process.execPath,
      resolve("examples/mcp-release-server.mjs"),
      ...(regression ? [`--regression=${regression}`] : [])
    ],
    outputDirectory
  });
}

describe("real MCP stdio conformance", () => {
  it("replays the same agent workflow with deterministic fixtures", async () => {
    const outputDirectory = await mkdtemp(resolve(tmpdir(), "agentdoctor-replay-"));
    temporaryDirectories.push(outputDirectory);
    const replay = await runAgentDoctor({
      scenarioPath: resolve("examples/agentic-release-contract.yml"),
      command: [process.execPath, resolve("examples/agentic-release-assistant.mjs")],
      outputDirectory
    });
    const live = await runMcpScenario();
    const replayCalls = replay.report.evidence
      .filter((event) => event.type === "tool_call")
      .map((event) => event.tool);
    const liveCalls = live.report.evidence
      .filter((event) => event.type === "tool_call")
      .map((event) => event.tool);
    const replayFinal = replay.report.evidence.find((event) => event.type === "final");
    const liveFinal = live.report.evidence.find((event) => event.type === "final");

    expect(replay.report.decision.exitCode).toBe(0);
    expect(live.report.decision.exitCode).toBe(0);
    expect(liveCalls).toEqual(replayCalls);
    expect(liveFinal?.output).toMatchObject({
      release: (replayFinal?.output as { release: unknown }).release
    });
  });

  it("discovers and calls a real MCP server with redacted evidence", async () => {
    const completed = await runMcpScenario();
    const reportContent = await readFile(completed.reportPath, "utf8");

    expect(completed.report.decision).toMatchObject({ status: "passed", exitCode: 0 });
    expect(completed.report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "mcp_discovery",
          tools: expect.arrayContaining([
            expect.objectContaining({ name: "calendar.create_event" })
          ])
        }),
        expect.objectContaining({
          type: "tool_result",
          source: "mcp",
          resultBytes: expect.any(Number),
          durationMs: expect.any(Number)
        })
      ])
    );
    expect(reportContent).toContain("[REDACTED]");
    expect(reportContent).not.toContain("demo-token-must-not-enter-evidence");
    expect(reportContent).not.toContain("release-owner@contoso.example");
  });

  it("redacts secrets echoed into final output and agent stderr", async () => {
    const outputDirectory = await mkdtemp(resolve(tmpdir(), "agentdoctor-redaction-"));
    temporaryDirectories.push(outputDirectory);
    const source = `
      const input = await import("node:readline").then(({ createInterface }) =>
        createInterface({ input: process.stdin })
      );
      input.on("line", line => {
        const event = JSON.parse(line);
        if (event.type === "run_start") {
          console.log(JSON.stringify({
            type: "tool_call",
            callId: "status",
            tool: "project.get_release_status",
            arguments: { project: "Apollo" }
          }));
        } else if (event.type === "tool_result") {
          process.stderr.write("accessToken=agent-stderr-secret");
          console.log(JSON.stringify({
            type: "final",
            status: "completed",
            output: { echoed: event.result.internal }
          }));
          input.close();
        }
      });
    `;
    const completed = await runAgentDoctor({
      scenarioPath: resolve("examples/mcp-release-contract.yml"),
      command: [process.execPath, "--input-type=module", "--eval", source],
      mcpCommand: [process.execPath, resolve("examples/mcp-release-server.mjs")],
      outputDirectory
    });
    const reportContent = await readFile(completed.reportPath, "utf8");

    expect(reportContent).toContain("[REDACTED]");
    expect(reportContent).not.toContain("demo-token-must-not-enter-evidence");
    expect(reportContent).not.toContain("release-owner@contoso.example");
    expect(reportContent).not.toContain("agent-stderr-secret");
  });

  it("detects MCP input schema drift", async () => {
    const completed = await runMcpScenario("schema-drift");

    expect(completed.report.decision).toMatchObject({ status: "failed", exitCode: 1 });
    expect(completed.report.decision.findings).toEqual([
      expect.objectContaining({
        id: "mcp.schema_drift",
        message: expect.stringContaining("project.get_release_status")
      })
    ]);
  });

  it("detects oversized MCP responses", async () => {
    const completed = await runMcpScenario("oversized-response");

    expect(completed.report.decision).toMatchObject({ status: "failed", exitCode: 1 });
    expect(completed.report.decision.findings).toEqual([
      expect.objectContaining({
        id: "mcp.response_size",
        message: expect.stringContaining("project.get_release_status")
      })
    ]);
  });

  it("detects MCP tool latency regressions", async () => {
    const completed = await runMcpScenario("slow-response");

    expect(completed.report.decision).toMatchObject({ status: "failed", exitCode: 1 });
    expect(completed.report.decision.findings).toEqual([
      expect.objectContaining({
        id: "mcp.tool_duration",
        message: expect.stringContaining("project.get_release_status")
      })
    ]);
  });

  it("preserves MCP tool-error evidence when the agent fails", async () => {
    const completed = await runMcpScenario("tool-error");
    const reportContent = await readFile(completed.reportPath, "utf8");

    expect(completed.report.decision).toMatchObject({
      status: "runtime_failed",
      exitCode: 2
    });
    expect(completed.report.decision.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mcp.tool_error" }),
        expect.objectContaining({ id: "runtime.execution" })
      ])
    );
    expect(completed.report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_result",
          tool: "bugs.list_blockers",
          source: "mcp",
          isError: true
        })
      ])
    );
    expect(reportContent).not.toContain("tool-error-secret");
    expect(reportContent).toContain("[REDACTED]");
  });

  it("preserves discovery and call evidence for MCP protocol failures", async () => {
    const completed = await runMcpScenario("missing-tool");
    const reportContent = await readFile(completed.reportPath, "utf8");

    expect(completed.report.decision).toMatchObject({
      status: "runtime_failed",
      exitCode: 2
    });
    expect(completed.report.decision.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "runtime.execution",
          message: expect.stringMatching(/not found|unknown tool/i)
        })
      ])
    );
    expect(completed.report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "mcp_discovery" }),
        expect.objectContaining({
          type: "tool_call",
          tool: "bugs.list_blockers"
        })
      ])
    );
    expect(reportContent).not.toContain("protocol-error-secret");
  });
});