import { describe, expect, it } from "vitest";
import {
  compareToolSnapshots,
  contractsEqual,
  normalizeMcpTool
} from "../src/mcp-conformance.js";

describe("MCP contract comparison", () => {
  it("ignores required-array ordering", () => {
    expect(
      compareToolSnapshots(
        [
          {
            name: "lookup",
            inputSchema: { type: "object", required: ["name", "value"] }
          }
        ],
        [
          {
            name: "lookup",
            inputSchema: { required: ["value", "name"], type: "object" }
          }
        ]
      ).matches
    ).toBe(true);
  });

  it("detects newly restrictive schema keywords", () => {
    const comparison = compareToolSnapshots(
      [{ name: "lookup", inputSchema: { type: "object" } }],
      [
        {
          name: "lookup",
          inputSchema: { type: "object", additionalProperties: false }
        }
      ]
    );

    expect(comparison).toEqual({ matches: false, driftedTools: ["lookup"] });
  });

  it("rejects duplicate tool names", () => {
    expect(
      compareToolSnapshots(
        [{ name: "lookup" }],
        [{ name: "lookup" }, { name: "lookup" }]
      )
    ).toEqual({ matches: false, driftedTools: ["lookup"] });
  });

  it("retains task execution and extension metadata", () => {
    expect(
      normalizeMcpTool({
        name: "deploy",
        inputSchema: { type: "object" },
        execution: { taskSupport: "optional" },
        _meta: { "example/risk": "mutation" }
      })
    ).toEqual({
      name: "deploy",
      inputSchema: { type: "object" },
      execution: { taskSupport: "optional" },
      _meta: { "example/risk": "mutation" }
    });
  });

  it("preserves ordering in arbitrary extension metadata", () => {
    expect(
      contractsEqual(
        { _meta: { required: ["first", "second"] } },
        { _meta: { required: ["second", "first"] } }
      )
    ).toBe(false);
  });
});