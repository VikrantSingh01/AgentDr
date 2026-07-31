export type Severity = "error" | "critical";

export interface McpToolSnapshot {
  name: string;
  title?: string;
  description?: string;
  icons?: Array<Record<string, unknown>>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface McpConfiguration {
  server: {
    command: string[];
  };
  capabilitySnapshot?: Record<string, unknown>;
  toolSnapshot?: McpToolSnapshot[] | { $file: string };
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxToolDurationMs?: number;
  redaction?: {
    keys: string[];
    replacement?: string;
  };
}

export interface ResultReference {
  tool: string;
  path: string;
  callIndex?: number;
  sequence?: unknown[];
  offset?: number;
  where?: Record<string, unknown>;
  find?: Record<string, unknown>;
  select?: string;
}

export interface ArgumentReference {
  $argument: string;
}

/**
 * A tool that is obligatory only in the worlds that warrant it. The condition
 * reads the agent's own reported outcome, and the relationship is a
 * biconditional: the tool must be called when the condition holds and must not
 * be called when it does not. Stating it one-way would let an agent take a
 * consequential action and simply not report it.
 */
/**
 * A reference to a path in the agent's own final output, usable from an
 * argument expectation. Stating "what you did must match what you reported"
 * this way scopes the check to the calls that actually happened, so it does not
 * fire in worlds where the action was legitimately not taken.
 */
export interface OutcomeReference {
  $fromOutcome: string;
}

export interface ConditionalRequirement {
  tool: string;
  when: {
    outcomePath: string;
    equals?: unknown;
    nonEmpty?: boolean;
  };
}

export interface FixtureCase {
  callIndex?: number;
  arguments?: Record<string, unknown>;
  result: unknown;
}

export interface ResolvedFixture {
  cases: FixtureCase[];
}

export type ResolvedFixtures = Record<string, ResolvedFixture>;

export interface Scenario {
  schemaVersion: "0.1";
  id: string;
  input: {
    message: string;
    data?: unknown;
  };
  fixtures?: Record<string, unknown>;
  adapter?: {
    command: string[];
  };
  enforcement?: {
    preDispatch: boolean;
  };
  mcp?: McpConfiguration;
  expect: {
    tools?: {
      required?: Array<string | ConditionalRequirement>;
      forbidden?: string[];
      order?: string[];
      precedence?: Array<{
        before: string;
        after: string;
        /**
         * `all` (the default) requires every `before` call to precede every
         * `after` call. `first` requires only that the first `after` call be
         * preceded by a `before` call, which leaves an agent free to call
         * `before` again afterwards to verify what it just did.
         */
        scope?: "all" | "first";
      }>;
      maxCalls?: number;
      budgets?: Array<{
        tool: string;
        minCalls?: number;
        maxCalls?: number;
        callsMatchOutcome?: string;
      }>;
      arguments?: Array<{
        tool: string;
        callIndex?: number;
        match?: Record<string, unknown>;
        schema?: Record<string, unknown>;
        distinct?: string[];
      }>;
    };
    confirmation?: {
      requiredBefore: string[];
      bindArguments?: boolean;
    };
    outcome?: {
      status: string;
      match?: unknown;
      schema?: Record<string, unknown>;
    };
  };
  performance?: {
    maxDurationMs?: number;
  };
}

export interface EvidenceBase {
  sequence: number;
  timestamp: string;
}

export type EvidenceEvent =
  | (EvidenceBase & {
      type: "mcp_discovery";
      serverCommand: string[];
      serverInfo?: { name: string; version: string };
      capabilities: Record<string, unknown>;
      tools: McpToolSnapshot[];
      capabilitySnapshotMatches?: boolean;
      toolSnapshotMatches?: boolean;
      driftedTools?: string[];
      durationMs: number;
    })
  | (EvidenceBase & {
      type: "tool_call";
      callId: string;
      tool: string;
      arguments: Record<string, unknown>;
    })
  | (EvidenceBase & {
      type: "tool_result";
      callId: string;
      tool: string;
      result: unknown;
      source?: "fixture" | "mcp";
      durationMs?: number;
      resultBytes?: number;
      isError?: boolean;
      fixtureMiss?: boolean;
    })
  | (EvidenceBase & {
      type: "confirmation";
      confirmed: boolean;
      tool: string;
      source?: string;
      arguments?: Record<string, unknown>;
    })
  | (EvidenceBase & {
      type: "tool_lifecycle";
      callId: string;
      tool: string;
      state: "requested" | "authorized" | "denied" | "dispatched" | "completed";
      mode: "observe" | "enforce";
      reason?: "tool_forbidden" | "confirmation_missing_or_mismatched";
    })
  | (EvidenceBase & {
      type: "final";
      status: string;
      output?: unknown;
    });

export type EvidenceEventInput = EvidenceEvent extends infer Event
  ? Event extends EvidenceBase
    ? Omit<Event, keyof EvidenceBase>
    : never
  : never;

export interface ExecutionResult {
  command: string[];
  startedAt: string;
  durationMs: number;
  evidence: EvidenceEvent[];
  stderr: string;
}

export interface Finding {
  id: string;
  severity: Severity;
  message: string;
  evidenceSequence?: number;
  /**
   * The id of the finding this one follows from. A finding that is only
   * reachable because an earlier expectation already failed is a consequence,
   * not an independent defect, and counting it as one overstates how much is
   * wrong with the run.
   */
  causedBy?: string;
}

export interface Decision {
  status: "passed" | "failed" | "runtime_failed";
  exitCode: 0 | 1 | 2 | 3;
  findings: Finding[];
}

export type GraphNodeName =
  | "load"
  | "execute"
  | "capture"
  | "evaluate"
  | "report";

export interface GraphTransition {
  node: GraphNodeName;
  status: "started" | "completed" | "failed";
  timestamp: string;
  detail?: string;
}

export interface RunReport {
  reportVersion: "0.1";
  runId: string;
  scenarioId: string;
  scenarioPath: string;
  command: string[];
  startedAt: string;
  durationMs: number;
  graph: GraphTransition[];
  evidence: EvidenceEvent[];
  decision: Decision;
  stderr?: string;
}

export interface CompletedRun {
  report: RunReport;
  reportPath: string;
}