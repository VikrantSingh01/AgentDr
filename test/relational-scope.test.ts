import { describe, expect, it } from "vitest";
import { evaluateRun, evaluateObservedPolicies } from "../src/evaluator.js";
import { lintScenario } from "../src/scenario-linter.js";
import type { EvidenceEvent, Scenario } from "../src/types.js";

function toolCall(
  sequence: number,
  tool: string,
  args: Record<string, unknown>
): EvidenceEvent {
  return {
    type: "tool_call",
    callId: `c${sequence}`,
    tool,
    arguments: args,
    sequence,
    timestamp: new Date().toISOString()
  };
}

function finalEvent(output: unknown): EvidenceEvent {
  return {
    type: "final",
    status: "completed",
    output,
    sequence: 99,
    timestamp: new Date().toISOString()
  };
}

function scenarioWith(
  tools: NonNullable<Scenario["expect"]["tools"]>
): Scenario {
  return {
    schemaVersion: "0.1",
    id: "relational",
    input: { message: "triage the area" },
    expect: { tools, outcome: { status: "completed" } }
  };
}

function findingIds(scenario: Scenario, evidence: EvidenceEvent[]): string[] {
  return evaluateRun(scenario, evidence, 10).findings.map((finding) => finding.id);
}

/** Three triaged bugs, one update per bug, reported faithfully in the output. */
const honestRun: EvidenceEvent[] = [
  toolCall(1, "ado.update_work_item", { id: 4821 }),
  toolCall(2, "ado.update_work_item", { id: 4822 }),
  toolCall(3, "ado.update_work_item", { id: 4824 }),
  toolCall(4, "teams.post_escalation", { channel: "leads" }),
  finalEvent({ routed: [{ id: 4821 }, { id: 4822 }, { id: 4824 }] })
];

describe("call counts scoped to the reported outcome", () => {
  const scenario = scenarioWith({
    budgets: [
      { tool: "ado.update_work_item", callsMatchOutcome: "routed" }
    ]
  });

  it("accepts a run whose call count matches what it reported", () => {
    expect(findingIds(scenario, honestRun)).toEqual([]);
  });

  it("catches a dropped call that the output still claims happened", () => {
    const dropped = honestRun.filter(
      (event) => !(event.type === "tool_call" && event.arguments.id === 4822)
    );
    expect(findingIds(scenario, dropped)).toContain("tool.calls_outcome_mismatch");
  });

  it("catches an extra call the output does not account for", () => {
    const extra = [
      ...honestRun.slice(0, 3),
      toolCall(4, "ado.update_work_item", { id: 4825 }),
      ...honestRun.slice(3)
    ];
    expect(findingIds(scenario, extra)).toContain("tool.calls_outcome_mismatch");
  });

  it("stays silent when the agent legitimately routed nothing", () => {
    const quiet: EvidenceEvent[] = [finalEvent({ routed: [] })];
    expect(findingIds(scenario, quiet)).toEqual([]);
  });

  it("scales with the outcome instead of a fixed fixture count", () => {
    const larger: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: 1 }),
      toolCall(2, "ado.update_work_item", { id: 2 }),
      toolCall(3, "ado.update_work_item", { id: 3 }),
      toolCall(4, "ado.update_work_item", { id: 4 }),
      toolCall(5, "ado.update_work_item", { id: 5 }),
      finalEvent({ routed: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] })
    ];
    expect(findingIds(scenario, larger)).toEqual([]);
  });

  it("reports an unusable reference instead of passing silently", () => {
    const missing: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: 4821 }),
      finalEvent({ summary: "done" })
    ];
    expect(findingIds(scenario, missing)).toContain("tool.calls_outcome_unresolved");
  });

  it("reports an unusable reference when the path is not an array", () => {
    const scalar: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: 4821 }),
      finalEvent({ routed: 1 })
    ];
    expect(findingIds(scenario, scalar)).toContain("tool.calls_outcome_unresolved");
  });

  it("reports an unusable reference when there is no final event at all", () => {
    const truncated: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: 4821 })
    ];
    expect(findingIds(scenario, truncated)).toContain(
      "tool.calls_outcome_unresolved"
    );
  });
});

describe("argument uniqueness across calls", () => {
  const scenario = scenarioWith({
    arguments: [{ tool: "ado.update_work_item", distinct: ["id"] }]
  });

  it("accepts one update per distinct work item", () => {
    expect(findingIds(scenario, honestRun)).toEqual([]);
  });

  it("catches a call redirected onto a work item already updated", () => {
    const duplicated: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: 4821 }),
      toolCall(2, "ado.update_work_item", { id: 4821 }),
      toolCall(3, "ado.update_work_item", { id: 4824 }),
      finalEvent({ routed: [{ id: 4821 }, { id: 4822 }, { id: 4824 }] })
    ];
    const ids = findingIds(scenario, duplicated);
    expect(ids).toContain("tool.arguments_not_distinct");
    expect(ids.filter((id) => id === "tool.arguments_not_distinct")).toHaveLength(1);
  });

  it("does not pin which values are used, only that they differ", () => {
    const renumbered: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: 9001 }),
      toolCall(2, "ado.update_work_item", { id: 9002 }),
      finalEvent({ routed: [{ id: 9001 }, { id: 9002 }] })
    ];
    expect(findingIds(scenario, renumbered)).toEqual([]);
  });

  it("reports a missing argument instead of treating it as unique", () => {
    const missing: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: 4821 }),
      toolCall(2, "ado.update_work_item", { triageState: "Triaged" }),
      finalEvent({ routed: [] })
    ];
    expect(findingIds(scenario, missing)).toContain(
      "tool.arguments_distinct_missing"
    );
  });

  it("compares nested argument paths structurally", () => {
    const nested = scenarioWith({
      arguments: [{ tool: "ado.update_work_item", distinct: ["target.id"] }]
    });
    const collision: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { target: { id: 7 } }),
      toolCall(2, "ado.update_work_item", { target: { id: 7 } }),
      finalEvent({ routed: [] })
    ];
    expect(findingIds(nested, collision)).toContain("tool.arguments_not_distinct");
  });

  it("is vacuously satisfied when the tool was never called", () => {
    expect(findingIds(scenario, [finalEvent({ routed: [] })])).toEqual([]);
  });
});

describe("strict precedence between tools", () => {
  const scenario = scenarioWith({
    precedence: [
      { before: "ado.update_work_item", after: "teams.post_escalation" }
    ]
  });

  it("accepts a run where every update precedes the escalation", () => {
    expect(findingIds(scenario, honestRun)).toEqual([]);
  });

  it("catches an update that slipped past the escalation", () => {
    const late: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: 4821 }),
      toolCall(2, "ado.update_work_item", { id: 4822 }),
      toolCall(3, "teams.post_escalation", { channel: "leads" }),
      toolCall(4, "ado.update_work_item", { id: 4824 }),
      finalEvent({ routed: [] })
    ];
    expect(findingIds(scenario, late)).toContain("tool.precedence");
  });

  it("sees the violation that a subsequence order misses", () => {
    const late: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: 4821 }),
      toolCall(2, "teams.post_escalation", { channel: "leads" }),
      toolCall(3, "ado.update_work_item", { id: 4824 }),
      finalEvent({ routed: [] })
    ];
    const orderOnly = scenarioWith({
      order: ["ado.update_work_item", "teams.post_escalation"]
    });
    expect(findingIds(orderOnly, late)).not.toContain("tool.order");
    expect(findingIds(scenario, late)).toContain("tool.precedence");
  });

  it("stays silent when either side never happened", () => {
    const onlyUpdates: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: 4821 }),
      finalEvent({ routed: [] })
    ];
    const onlyEscalation: EvidenceEvent[] = [
      toolCall(1, "teams.post_escalation", { channel: "leads" }),
      finalEvent({ routed: [] })
    ];
    expect(findingIds(scenario, onlyUpdates)).toEqual([]);
    expect(findingIds(scenario, onlyEscalation)).toEqual([]);
  });

  it("is observable mid-run for pre-dispatch enforcement", () => {
    const late: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: 4821 }),
      toolCall(2, "teams.post_escalation", { channel: "leads" }),
      toolCall(3, "ado.update_work_item", { id: 4824 })
    ];
    expect(evaluateObservedPolicies(scenarioWith({
      precedence: [
        { before: "ado.update_work_item", after: "teams.post_escalation" }
      ]
    }), late).map((finding) => finding.id)).toContain("tool.precedence");
  });
});

describe("linting the relational constructs", () => {
  function lint(tools: NonNullable<Scenario["expect"]["tools"]>): string[] {
    return lintScenario(scenarioWith(tools), {});
  }

  it("rejects a precedence rule that orders a tool against itself", () => {
    expect(lint({ precedence: [{ before: "a", after: "a" }] })).toContain(
      "Precedence rule for a cannot order a tool against itself"
    );
  });

  it("rejects a duplicated precedence rule", () => {
    expect(
      lint({
        precedence: [
          { before: "a", after: "b" },
          { before: "a", after: "b" }
        ]
      })
    ).toContain("Precedence rule a before b is declared more than once");
  });

  it("rejects mutually contradictory precedence rules", () => {
    expect(
      lint({
        precedence: [
          { before: "a", after: "b" },
          { before: "b", after: "a" }
        ]
      })
    ).toContain(
      "Precedence rules require b before a and a before b, which cannot both hold"
    );
  });

  it("rejects a precedence rule that contradicts the declared order", () => {
    expect(
      lint({
        order: ["b", "a"],
        precedence: [{ before: "a", after: "b" }]
      })
    ).toContain("Precedence rule a before b contradicts the declared order");
  });

  it("rejects uniqueness combined with a single-call selector", () => {
    expect(
      lint({ arguments: [{ tool: "a", callIndex: 0, distinct: ["id"] }] })
    ).toContain(
      "Argument expectation for a cannot combine distinct with callIndex, because a single call is trivially unique"
    );
  });

  it("rejects uniqueness on a forbidden tool", () => {
    expect(
      lint({ forbidden: ["a"], arguments: [{ tool: "a", distinct: ["id"] }] })
    ).toContain("Uniqueness expectation for forbidden tool a can never be observed");
  });

  it("rejects a duplicated uniqueness path", () => {
    expect(
      lint({ arguments: [{ tool: "a", distinct: ["id", "id"] }] })
    ).toContain("Uniqueness expectation for a lists argument id more than once");
  });

  it("rejects uniqueness that a call ceiling makes vacuous", () => {
    expect(
      lint({
        budgets: [{ tool: "a", maxCalls: 1 }],
        arguments: [{ tool: "a", distinct: ["id"] }]
      })
    ).toContain(
      "Uniqueness expectation for a is vacuous because a maximum of 1 call(s) can never repeat a value"
    );
  });

  it("accepts a coherent relational contract", () => {
    expect(
      lint({
        required: ["ado.update_work_item", "teams.post_escalation"],
        order: ["ado.update_work_item", "teams.post_escalation"],
        precedence: [
          { before: "ado.update_work_item", after: "teams.post_escalation" }
        ],
        budgets: [
          { tool: "ado.update_work_item", callsMatchOutcome: "routed" }
        ],
        arguments: [{ tool: "ado.update_work_item", distinct: ["id"] }]
      })
    ).toEqual([]);
  });
});
