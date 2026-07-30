import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { McpStdioProxy } from "../dist/src/mcp-stdio-proxy.js";

const proxy = new McpStdioProxy(
  {
    server: {
      command: [process.execPath, resolve("examples/mcp-release-server.mjs")]
    },
    startupTimeoutMs: 5000
  },
  process.cwd()
);

try {
  const events = await proxy.start(5000);
  const discovery = events.find((event) => event.type === "mcp_discovery");
  if (!discovery) throw new Error("MCP server returned no discovery evidence");
  await writeFile(
    resolve("examples/fixtures/mcp-release-tools.snapshot.json"),
    `${JSON.stringify(discovery.tools, null, 2)}\n`,
    "utf8"
  );
  console.log(`Snapshot updated with ${discovery.tools.length} MCP tools`);
} finally {
  await proxy.close();
}