import { describe, expect, it } from "vitest";
import { createRedactor, redactRunReport } from "../src/redaction.js";
import type { RunReport } from "../src/types.js";

describe("evidence redaction", () => {
  const redact = createRedactor({ keys: ["accessToken", "ownerEmail"] });

  it("redacts nested objects and arrays", () => {
    expect(
      redact({
        internal: {
          accessToken: "secret",
          contacts: [{ ownerEmail: "owner@example.test" }]
        }
      })
    ).toEqual({
      internal: {
        accessToken: "[REDACTED]",
        contacts: [{ ownerEmail: "[REDACTED]" }]
      }
    });
  });

  it("redacts JSON encoded inside text content", () => {
    expect(redact('{"accessToken":"secret","ok":true}')).toBe(
      '{"accessToken":"[REDACTED]","ok":true}'
    );
  });

  it("redacts key/value diagnostics", () => {
    expect(redact("request failed accessToken=secret ownerEmail:owner@example.test")).toBe(
      "request failed accessToken=[REDACTED] ownerEmail:[REDACTED]"
    );
  });

  it("preserves sensitive property names in JSON Schema", () => {
    const report = createReport({
      type: "mcp_discovery",
      serverCommand: ["node", "server.mjs"],
      capabilities: {},
      tools: [
        {
          name: "lookup",
          inputSchema: {
            type: "object",
            properties: {
              accessToken: { type: "string", default: "secret" }
            }
          }
        }
      ],
      durationMs: 1,
      sequence: 1,
      timestamp: new Date().toISOString()
    });

    expect(
      (redactRunReport(report, {
        keys: ["accessToken"]
      }).evidence[0] as Extract<RunReport["evidence"][number], { type: "mcp_discovery" }>).tools[0]
        .inputSchema
    ).toEqual({
      type: "object",
      properties: {
        accessToken: { type: "string", default: "[REDACTED]" }
      }
    });
  });

  it("redacts instance values through composed sensitive-property schemas", () => {
    const report = createReport({
      type: "mcp_discovery",
      serverCommand: ["node", "server.mjs"],
      capabilities: {},
      tools: [
        {
          name: "lookup",
          inputSchema: {
            type: "object",
            properties: {
              accessToken: {
                anyOf: [
                  {
                    type: "string",
                    default: "default-secret",
                    const: "const-secret",
                    examples: ["example-secret"],
                    enum: ["enum-secret"]
                  }
                ]
              }
            }
          }
        }
      ],
      durationMs: 1,
      sequence: 1,
      timestamp: new Date().toISOString()
    });
    const content = JSON.stringify(
      redactRunReport(report, { keys: ["accessToken"] })
    );

    expect(content).not.toMatch(/default-secret|const-secret|example-secret|enum-secret/);
    expect(content).toContain("[REDACTED]");
  });

  it("redacts ordinary data nested under a properties key", () => {
    expect(redact({ properties: { accessToken: "secret" } })).toEqual({
      properties: { accessToken: "[REDACTED]" }
    });
  });

  it("redacts schema-lookalike keys in ordinary data", () => {
    expect(redact({ payload: { inputSchema: { accessToken: "secret" } } })).toEqual({
      payload: { inputSchema: { accessToken: "[REDACTED]" } }
    });
  });

  it("does not trust discovery-shaped ordinary tool results", () => {
    const report = createReport({
      type: "tool_result",
      callId: "1",
      tool: "echo",
      result: {
        type: "mcp_discovery",
        tools: [
          {
            inputSchema: {
              properties: { accessToken: "secret" }
            }
          }
        ]
      },
      sequence: 1,
      timestamp: new Date().toISOString()
    });
    const content = JSON.stringify(
      redactRunReport(report, { keys: ["accessToken"] })
    );

    expect(content).not.toContain("secret");
    expect(content).toContain("[REDACTED]");
  });

  it("redacts values following sensitive command flags", () => {
    expect(redact(["node", "server.mjs", "--access-token", "secret"])).toEqual([
      "node",
      "server.mjs",
      "--access-token",
      "[REDACTED]"
    ]);
  });
});

function createReport(evidence: RunReport["evidence"][number]): RunReport {
  return {
    reportVersion: "0.1",
    runId: "run",
    scenarioId: "scenario",
    scenarioPath: "scenario.yml",
    command: ["node", "agent.mjs"],
    startedAt: new Date().toISOString(),
    durationMs: 1,
    graph: [],
    evidence: [evidence],
    decision: { status: "passed", exitCode: 0, findings: [] }
  };
}