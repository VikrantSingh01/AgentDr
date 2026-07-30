import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { McpStdioProxy } from "./mcp-stdio-proxy.js";
import type { EvidenceEvent, McpToolSnapshot } from "./types.js";

async function discoverMcpServer(command: string[]): Promise<{
  serverInfo?: { name: string; version: string };
  capabilities: Record<string, unknown>;
  tools: McpToolSnapshot[];
  durationMs: number;
}> {
  if (command.length === 0) {
    throw new Error("MCP server command is required after --");
  }
  const proxy = new McpStdioProxy({ server: { command } }, process.cwd());
  try {
    const events = await proxy.start(5000);
    const discovery = events.find(
      (event): event is Omit<Extract<EvidenceEvent, { type: "mcp_discovery" }>, "sequence" | "timestamp"> =>
        event.type === "mcp_discovery"
    );
    if (!discovery) throw new Error("MCP server returned no discovery evidence");
    return discovery;
  } finally {
    await proxy.close();
  }
}

export async function inspectMcpServer(command: string[]): Promise<void> {
  const discovery = await discoverMcpServer(command);
  console.log(JSON.stringify(discovery, null, 2));
}

export async function writeMcpSnapshot(
  path: string,
  command: string[]
): Promise<string> {
  const discovery = await discoverMcpServer(command);
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(discovery.tools, null, 2)}\n`, "utf8");
  return target;
}