import type {
  EvidenceEventInput,
  ResolvedFixtures,
  Scenario
} from "./types.js";
import type { RedactionOptions } from "./redaction.js";

export interface ToolBackendCallResult {
  /** Payload returned to the agent adapter. */
  result: unknown;
  /** Optional sanitized payload recorded in evidence instead of `result`. */
  evidenceResult?: unknown;
  /** Stable backend label recorded on the tool result evidence. */
  source: string;
  durationMs: number;
  resultBytes: number;
  /** Use for tool-level failures. Throw only for transport or runtime failures. */
  isError?: boolean;
}

export type ToolBackendStartupEvent = Extract<
  EvidenceEventInput,
  { type: "mcp_discovery" }
>;

export interface ToolBackend {
  /** Declarative report redaction applied after evaluation. */
  readonly redaction?: RedactionOptions;
  /** Perform asynchronous setup. The implementation must honor `timeoutMs`. */
  start(timeoutMs: number): Promise<ToolBackendStartupEvent[]>;
  call(tool: string, argumentsValue: Record<string, unknown>): Promise<ToolBackendCallResult>;
  /** Release resources. Called once after setup, including failed runs. */
  close(): Promise<void>;
}

export type DeepReadonly<T> = T extends (...argumentsValue: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface ToolBackendContext {
  readonly scenario: DeepReadonly<Scenario>;
  readonly fixtures: DeepReadonly<ResolvedFixtures>;
  readonly cwd: string;
}

export type ToolBackendFactory = (
  context: ToolBackendContext
) => ToolBackend;