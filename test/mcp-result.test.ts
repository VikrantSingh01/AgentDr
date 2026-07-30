import { describe, expect, it } from "vitest";
import { decodeMcpToolResult } from "../src/mcp-stdio-proxy.js";

describe("MCP result decoding", () => {
  it("returns plain structured content when text is its exact rendering", () => {
    const output = { value: 42 };
    expect(
      decodeMcpToolResult({
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output
      })
    ).toEqual(output);
  });

  it("preserves mixed content alongside structured content", () => {
    expect(
      decodeMcpToolResult({
        content: [
          { type: "text", text: "preview" },
          { type: "image", data: "base64", mimeType: "image/png" }
        ],
        structuredContent: { value: 42 }
      })
    ).toEqual({
      structuredContent: { value: 42 },
      content: [
        { type: "text", text: "preview" },
        { type: "image", data: "base64", mimeType: "image/png" }
      ]
    });
  });

  it("preserves annotations and top-level metadata on mirrored content", () => {
    const structuredContent = { value: 42 };
    expect(
      decodeMcpToolResult({
        content: [
          {
            type: "text",
            text: JSON.stringify(structuredContent),
            annotations: { audience: ["user"] }
          }
        ],
        structuredContent,
        _meta: { requestId: "req-1" }
      })
    ).toEqual({
      _meta: { requestId: "req-1" },
      structuredContent,
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent),
          annotations: { audience: ["user"] }
        }
      ]
    });
  });

    it("preserves annotations and metadata on text-only content", () => {
      expect(
        decodeMcpToolResult({
          content: [
            {
              type: "text",
              text: "hello",
              annotations: { audience: ["user"] }
            }
          ],
          _meta: { requestId: "req-2" }
        })
      ).toEqual({
        _meta: { requestId: "req-2" },
        content: [
          {
            type: "text",
            text: "hello",
            annotations: { audience: ["user"] }
          }
        ]
      });
    });
});