import type { EvidenceEventInput } from "./types.js";

export interface ToolBackendCallResult {
  result: unknown;
  evidenceResult?: unknown;
  source: "mcp";
  durationMs: number;
  resultBytes: number;
  isError?: boolean;
}

export interface ToolBackend {
  start(timeoutMs: number): Promise<EvidenceEventInput[]>;
  call(tool: string, argumentsValue: Record<string, unknown>): Promise<ToolBackendCallResult>;
  redact(value: unknown): unknown;
  close(): Promise<void>;
}