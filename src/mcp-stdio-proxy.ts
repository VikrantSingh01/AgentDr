import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  compareToolSnapshots,
  contractsEqual,
  normalizeMcpTool
} from "./mcp-conformance.js";
import { createRedactor } from "./redaction.js";
import type {
  ToolBackend,
  ToolBackendCallResult,
  ToolBackendStartupEvent
} from "./tool-backend.js";
import type { McpConfiguration, McpToolSnapshot } from "./types.js";
import { VERSION } from "./version.js";

export function decodeMcpToolResult(result: {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}): unknown {
  const metadata = Object.fromEntries(
    Object.entries(result).filter(
      ([key]) => !["content", "structuredContent", "isError"].includes(key)
    )
  );
  if (result.isError) {
    return {
      ...metadata,
      isError: true,
      content: result.content,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {})
    };
  }
  if (result.structuredContent !== undefined) {
    const onlyBlock = result.content.length === 1 ? result.content[0] : undefined;
    if (
      onlyBlock?.type === "text" &&
      typeof onlyBlock.text === "string" &&
      onlyBlock.text === JSON.stringify(result.structuredContent) &&
      Object.keys(onlyBlock).every((key) => key === "type" || key === "text") &&
      Object.keys(metadata).length === 0
    ) {
      return result.structuredContent;
    }
    return {
      ...metadata,
      structuredContent: result.structuredContent,
      content: result.content
    };
  }

  const onlyBlock = result.content.length === 1 ? result.content[0] : undefined;
  if (
    onlyBlock?.type === "text" &&
    typeof onlyBlock.text === "string" &&
    Object.keys(onlyBlock).every((key) => key === "type" || key === "text") &&
    Object.keys(metadata).length === 0
  ) {
    try {
      return JSON.parse(onlyBlock.text) as unknown;
    } catch {
      return onlyBlock.text;
    }
  }
  return { ...metadata, content: result.content };
}

export class McpStdioProxy implements ToolBackend {
  readonly redaction;
  private readonly client = new Client({ name: "agentdoctor", version: VERSION });
  private readonly transport: StdioClientTransport;
  private readonly redactValue: (value: unknown) => unknown;
  private serverStderr = "";
  private started = false;
  private closed = false;

  constructor(
    private readonly configuration: McpConfiguration,
    cwd: string
  ) {
    this.redaction = configuration.redaction;
    const [command, ...args] = configuration.server.command;
    this.transport = new StdioClientTransport({
      command,
      args,
      cwd,
      stderr: "pipe"
    });
    this.transport.stderr?.on("data", (chunk: Buffer) => {
      this.serverStderr = `${this.serverStderr}${chunk.toString("utf8")}`.slice(-8192);
    });
    this.redactValue = createRedactor(configuration.redaction);
  }

  async start(runTimeoutMs: number): Promise<ToolBackendStartupEvent[]> {
    const startedAt = Date.now();
    const startupTimeoutMs = Math.min(
      this.configuration.startupTimeoutMs ?? 5000,
      runTimeoutMs
    );
    const deadline = startedAt + startupTimeoutMs;
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => {
      controller.abort(new Error(`MCP startup timed out after ${startupTimeoutMs}ms`));
    }, startupTimeoutMs);
    try {
      this.started = true;
      await this.client.connect(this.transport, {
        timeout: startupTimeoutMs,
        signal: controller.signal
      });
      const { tools } = await this.client.listTools(undefined, {
        timeout: Math.max(1, deadline - Date.now()),
        signal: controller.signal
      });
      const serverInfo = this.client.getServerVersion();
      const capabilities = this.client.getServerCapabilities() ?? {};
      const normalizedTools = tools.map(normalizeMcpTool);
      const toolComparison = Array.isArray(this.configuration.toolSnapshot)
        ? compareToolSnapshots(this.configuration.toolSnapshot, normalizedTools)
        : undefined;
      return [
        {
          type: "mcp_discovery",
          serverCommand: [...this.configuration.server.command],
          ...(serverInfo
            ? { serverInfo: { name: serverInfo.name, version: serverInfo.version } }
            : {}),
          capabilities: capabilities as Record<string, unknown>,
          tools: normalizedTools,
          ...(this.configuration.capabilitySnapshot
            ? {
                capabilitySnapshotMatches: contractsEqual(
                  this.configuration.capabilitySnapshot,
                  capabilities
                )
              }
            : {}),
          ...(toolComparison
            ? {
                toolSnapshotMatches: toolComparison.matches,
                driftedTools: toolComparison.driftedTools
              }
            : {}),
          durationMs: Date.now() - startedAt
        }
      ];
    } catch (error) {
      throw new Error(this.withServerStderr(error));
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  async call(
    tool: string,
    argumentsValue: Record<string, unknown>
  ): Promise<ToolBackendCallResult> {
    const startedAt = Date.now();
    try {
      const protocolResult = await this.client.callTool(
        {
          name: tool,
          arguments: argumentsValue
        },
        {
          timeout:
            this.configuration.requestTimeoutMs ??
            Math.max((this.configuration.maxToolDurationMs ?? 1000) * 2, 1000)
        }
      );
      const result = decodeMcpToolResult(protocolResult);
      return {
        result,
        evidenceResult: result,
        source: "mcp",
        durationMs: Date.now() - startedAt,
        resultBytes: Buffer.byteLength(JSON.stringify(protocolResult), "utf8"),
        ...(protocolResult.isError ? { isError: true } : {})
      };
    } catch (error) {
      throw new Error(this.withServerStderr(error));
    }
  }

  async close(): Promise<void> {
    if (!this.started || this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      try {
        await this.transport.close();
      } catch {
        // Teardown is best-effort and must not mask the run result.
      }
    }
  }

  private withServerStderr(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = this.serverStderr.trim();
    return String(
      this.redactValue(stderr ? `${message}; MCP server stderr: ${stderr}` : message)
    );
  }
}