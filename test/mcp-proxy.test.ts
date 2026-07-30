import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { McpStdioProxy } from "../src/mcp-stdio-proxy.js";

describe("MCP stdio proxy deadlines", () => {
  it("bounds a server that never completes startup", async () => {
    const proxy = new McpStdioProxy(
      {
        server: {
          command: [
            process.execPath,
            "--input-type=module",
            "--eval",
            "setInterval(() => {}, 1000)"
          ]
        },
        startupTimeoutMs: 100
      },
      process.cwd()
    );
    const startedAt = Date.now();

    try {
      await expect(proxy.start(500)).rejects.toThrow(/timed out|timeout/i);
      expect(Date.now() - startedAt).toBeLessThan(1500);
    } finally {
      await proxy.close();
    }
  });

  it("bounds a tool call that exceeds its request deadline", async () => {
    const proxy = new McpStdioProxy(
      {
        server: {
          command: [
            process.execPath,
            resolve("examples/mcp-release-server.mjs"),
            "--regression=slow-response"
          ]
        },
        startupTimeoutMs: 1000,
        requestTimeoutMs: 25
      },
      process.cwd()
    );

    try {
      await proxy.start(1500);
      await expect(
        proxy.call("project.get_release_status", { project: "Apollo" })
      ).rejects.toThrow(/timed out|timeout/i);
    } finally {
      await proxy.close();
    }
  });
});