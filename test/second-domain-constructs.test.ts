import { describe, expect, it } from "vitest";
import { evaluateRun } from "../src/evaluator.js";
import { lintScenario } from "../src/scenario-linter.js";
import { validateReference } from "../src/result-reference.js";
import type { EvidenceEvent, Scenario } from "../src/types.js";

// The five constructs here all came out of building a second reference domain
// whose task topology differs from the first. Each one exists because a real
// property of a correct agent could not be stated without it, and each is
// exercised in both directions: it has to accept the correct run and reject the
// defect it was added for. A construct that only ever passes is untested.

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

function toolResult(sequence: number, tool: string, result: unknown): EvidenceEvent {
  return {
    type: "tool_result",
    callId: `c${sequence - 1}`,
    tool,
    result,
    sequence,
    timestamp: new Date().toISOString()
  };
}

function final(output: unknown): EvidenceEvent {
  return {
    type: "final",
    status: "completed",
    output,
    sequence: 99,
    timestamp: new Date().toISOString()
  };
}

function findingIds(scenario: Scenario, evidence: EvidenceEvent[]): string[] {
  return evaluateRun(scenario, evidence, 1).findings.map((finding) => finding.id);
}

function base(expectations: Scenario["expect"]): Scenario {
  return {
    schemaVersion: "0.1",
    id: "second-domain-constructs",
    input: { message: "run" },
    expect: expectations
  };
}

describe("numeric comparison in correlation criteria", () => {
  // The limit comes from the policy the world published, never from a literal.
  // A frozen threshold passes in one world and rejects every other.
  const scenario = base({
    tools: {
      allowed: ["get_policy", "list_items", "approve"],
      arguments: [
        {
          tool: "approve",
          match: {
            id: {
              $fromResult: {
                tool: "list_items",
                path: "items",
                find: {
                  id: { $argument: "id" },
                  amount: {
                    $lessThan: { $fromResult: { tool: "get_policy", path: "limit" } }
                  }
                },
                select: "id"
              }
            }
          }
        }
      ]
    },
    outcome: { status: "completed" }
  });

  const world = (limit: number): EvidenceEvent[] => [
    toolCall(0, "get_policy", {}),
    toolResult(1, "get_policy", { limit }),
    toolCall(2, "list_items", {}),
    toolResult(3, "list_items", {
      items: [
        { id: "A", amount: 100 },
        { id: "B", amount: 900 }
      ]
    })
  ];

  it("accepts an action on a record inside the published limit", () => {
    const evidence = [
      ...world(500),
      toolCall(4, "approve", { id: "A" }),
      toolResult(5, "approve", { ok: true }),
      final({})
    ];
    expect(findingIds(scenario, evidence)).toEqual([]);
  });

  it("rejects an action on a record outside the published limit", () => {
    const evidence = [
      ...world(500),
      toolCall(4, "approve", { id: "B" }),
      toolResult(5, "approve", { ok: true }),
      final({})
    ];
    expect(findingIds(scenario, evidence)).toContain("tool.arguments_reference_unresolved");
  });

  it("follows the limit rather than the value, so a looser world accepts more", () => {
    const evidence = [
      ...world(1000),
      toolCall(4, "approve", { id: "B" }),
      toolResult(5, "approve", { ok: true }),
      final({})
    ];
    expect(findingIds(scenario, evidence)).toEqual([]);
  });

  it("does not compare a non-numeric value, which JS relational operators would coerce", () => {
    const evidence = [
      toolCall(0, "get_policy", {}),
      toolResult(1, "get_policy", { limit: 500 }),
      toolCall(2, "list_items", {}),
      toolResult(3, "list_items", { items: [{ id: "A", amount: "100" }] }),
      toolCall(4, "approve", { id: "A" }),
      toolResult(5, "approve", { ok: true }),
      final({})
    ];
    expect(findingIds(scenario, evidence)).toContain("tool.arguments_reference_unresolved");
  });

  it("rejects a comparison bound that is neither a number nor a reference", () => {
    expect(
      validateReference({
        tool: "list_items",
        path: "items",
        find: { amount: { $lessThan: "many" } }
      })
    ).toContain(
      "$fromResult find $lessThan requires a number, a $argument, or a $fromResult bound"
    );
  });

  it("rejects a comparison operator written with a sibling key", () => {
    // Otherwise the object is read as a literal and the selector silently
    // matches nothing, which looks strict and asserts nothing.
    expect(
      validateReference({
        tool: "list_items",
        path: "items",
        find: { amount: { $lessThan: 5, $atLeast: 1 } }
      })
    ).toContain("$fromResult find $lessThan, $atLeast must be the only property of its object");
  });
});

describe("whereResult, selecting a producing call by what it returned", () => {
  // `where` filters candidates by their arguments. A lookup that takes an id and
  // returns a verdict cannot be selected that way at all, because the thing
  // being selected on is on the result side.
  const scenario = base({
    tools: {
      allowed: ["check", "act"],
      arguments: [
        {
          tool: "act",
          match: {
            id: {
              $fromResult: {
                tool: "check",
                path: "id",
                whereResult: { verified: true }
              }
            }
          }
        }
      ]
    },
    outcome: { status: "completed" }
  });

  const checks: EvidenceEvent[] = [
    toolCall(0, "check", { id: "A" }),
    toolResult(1, "check", { id: "A", verified: true }),
    toolCall(2, "check", { id: "B" }),
    toolResult(3, "check", { id: "B", verified: false })
  ];

  it("accepts an action grounded in a check that came back verified", () => {
    const evidence = [
      ...checks,
      toolCall(4, "act", { id: "A" }),
      toolResult(5, "act", { ok: true }),
      final({})
    ];
    expect(findingIds(scenario, evidence)).toEqual([]);
  });

  it("rejects an action grounded in a check that came back unverified", () => {
    // The reference resolves — a verified check exists — but it resolves to a
    // different record, so the mismatch is in the value rather than the lookup.
    const evidence = [
      ...checks,
      toolCall(4, "act", { id: "B" }),
      toolResult(5, "act", { ok: true }),
      final({})
    ];
    expect(findingIds(scenario, evidence)).toContain("tool.arguments_subset");
  });

  it("resolves nothing at all when no check came back verified", () => {
    const evidence = [
      toolCall(0, "check", { id: "B" }),
      toolResult(1, "check", { id: "B", verified: false }),
      toolCall(2, "act", { id: "B" }),
      toolResult(3, "act", { ok: true }),
      final({})
    ];
    expect(findingIds(scenario, evidence)).toContain("tool.arguments_reference_unresolved");
  });

  it("cannot combine with callIndex, which selects by position rather than by key", () => {
    expect(
      validateReference({
        tool: "check",
        path: "id",
        callIndex: 0,
        whereResult: { verified: true }
      })
    ).toContain(
      "$fromResult cannot combine callIndex with whereResult; a correlation selects a call by key, not by position"
    );
  });
});

describe("$anyOf in the value position, for mutually exclusive correlations", () => {
  // A submitter is told "approved" or "escalated". Correlating to one branch
  // rejects every correct run that took the other; correlating to neither
  // accepts a notice that contradicts the action.
  const scenario = base({
    tools: {
      allowed: ["approve", "escalate", "notify"],
      arguments: [
        {
          tool: "notify",
          match: {
            decision: {
              $anyOf: [
                {
                  $fromResult: {
                    tool: "approve",
                    path: "state",
                    where: { id: { $argument: "id" } }
                  }
                },
                {
                  $fromResult: {
                    tool: "escalate",
                    path: "state",
                    where: { id: { $argument: "id" } }
                  }
                }
              ]
            }
          }
        }
      ]
    },
    outcome: { status: "completed" }
  });

  const actions: EvidenceEvent[] = [
    toolCall(0, "approve", { id: "A" }),
    toolResult(1, "approve", { state: "approved" }),
    toolCall(2, "escalate", { id: "B" }),
    toolResult(3, "escalate", { state: "escalated" })
  ];

  it("accepts a notice matching either branch", () => {
    const evidence = [
      ...actions,
      toolCall(4, "notify", { id: "A", decision: "approved" }),
      toolResult(5, "notify", { ok: true }),
      toolCall(6, "notify", { id: "B", decision: "escalated" }),
      toolResult(7, "notify", { ok: true }),
      final({})
    ];
    expect(findingIds(scenario, evidence)).toEqual([]);
  });

  it("rejects a notice that reports the other branch's outcome", () => {
    // Well-formed and wrong: "escalated" is a legal value, and an enum accepts
    // it. What it contradicts is the action actually taken for that record.
    const evidence = [
      ...actions,
      toolCall(4, "notify", { id: "A", decision: "escalated" }),
      toolResult(5, "notify", { ok: true }),
      final({})
    ];
    expect(findingIds(scenario, evidence)).toContain("tool.arguments_reference_unresolved");
  });

  it("rejects a notice for a record nothing happened to, since no branch resolves", () => {
    const evidence = [
      ...actions,
      toolCall(4, "notify", { id: "C", decision: "approved" }),
      toolResult(5, "notify", { ok: true }),
      final({})
    ];
    expect(findingIds(scenario, evidence)).toContain("tool.arguments_reference_unresolved");
  });

  it("lints a malformed disjunction rather than reading it as a literal", () => {
    const scenarioWithBadAnyOf = base({
      tools: {
        allowed: ["notify"],
        arguments: [{ tool: "notify", match: { decision: { $anyOf: "approved" } } }]
      },
      outcome: { status: "completed" }
    });
    expect(lintScenario(scenarioWithBadAnyOf, {})).toContain(
      "Argument expectation for notify is invalid: match.decision $anyOf must be an array of at least two alternatives"
    );
  });
});

describe("correlated precedence, per record rather than per tool", () => {
  // Evidence gathered about one record has to precede the action on that same
  // record. The uncorrelated form cannot say this: it either demands a
  // prerequisite for records that never needed one, or accepts a prerequisite
  // gathered for some entirely different record.
  const scenario = base({
    tools: {
      allowed: ["check", "act"],
      precedence: [{ before: "check", after: "act", correlate: ["id"] }]
    },
    outcome: { status: "completed" }
  });

  it("accepts an action taken after the check for its own record", () => {
    const evidence = [
      toolCall(0, "check", { id: "A" }),
      toolResult(1, "check", { ok: true }),
      toolCall(2, "act", { id: "A" }),
      toolResult(3, "act", { ok: true }),
      final({})
    ];
    expect(findingIds(scenario, evidence)).toEqual([]);
  });

  it("rejects an action taken before the check for its own record", () => {
    const evidence = [
      toolCall(0, "act", { id: "A" }),
      toolResult(1, "act", { ok: true }),
      toolCall(2, "check", { id: "A" }),
      toolResult(3, "check", { ok: true }),
      final({})
    ];
    expect(findingIds(scenario, evidence)).toContain("tool.precedence");
  });

  it("is vacuous for a record the prerequisite never covered", () => {
    // Whether evidence was required at all is a different question, answered by
    // the argument correlations. This rule only orders what the agent gathered.
    const evidence = [
      toolCall(0, "act", { id: "A" }),
      toolResult(1, "act", { ok: true }),
      final({})
    ];
    expect(findingIds(scenario, evidence)).toEqual([]);
  });

  it("does not accept a prerequisite gathered for a different record", () => {
    const evidence = [
      toolCall(0, "check", { id: "B" }),
      toolResult(1, "check", { ok: true }),
      toolCall(2, "act", { id: "A" }),
      toolResult(3, "act", { ok: true }),
      toolCall(4, "check", { id: "A" }),
      toolResult(5, "check", { ok: true }),
      final({})
    ];
    expect(findingIds(scenario, evidence)).toContain("tool.precedence");
  });

  it("rejects combining correlate with scope, which has no meaning per record", () => {
    const scenarioWithScope = base({
      tools: {
        allowed: ["check", "act"],
        precedence: [{ before: "check", after: "act", correlate: ["id"], scope: "first" }]
      },
      outcome: { status: "completed" }
    });
    expect(lintScenario(scenarioWithScope, {})).toContain(
      "Precedence rule check before act cannot combine correlate with scope; a per-record rule already has exactly one first call per record"
    );
  });
});

describe("disjunction in a conditional obligation", () => {
  // A notice is owed for every decision. Naming one arm of a two-armed decision
  // forbids the notice in every world where the other arm happened alone, which
  // is a false positive rather than a detection.
  const scenario = base({
    tools: {
      allowed: ["notify"],
      required: [
        {
          tool: "notify",
          when: {
            $anyOf: [
              { outcomePath: "approved", nonEmpty: true },
              { outcomePath: "escalated", nonEmpty: true }
            ]
          }
        }
      ]
    },
    outcome: { status: "completed" }
  });

  const notified: EvidenceEvent[] = [
    toolCall(0, "notify", { id: "A" }),
    toolResult(1, "notify", { ok: true })
  ];

  it("accepts a notice when only the second branch holds", () => {
    const evidence = [...notified, final({ approved: [], escalated: ["A"] })];
    expect(findingIds(scenario, evidence)).toEqual([]);
  });

  it("accepts a notice when only the first branch holds", () => {
    const evidence = [...notified, final({ approved: ["A"], escalated: [] })];
    expect(findingIds(scenario, evidence)).toEqual([]);
  });

  it("requires the notice when either branch holds", () => {
    const evidence = [final({ approved: [], escalated: ["A"] })];
    expect(findingIds(scenario, evidence)).toContain("tool.required_when");
  });

  it("still forbids the notice when no branch holds", () => {
    const evidence = [...notified, final({ approved: [], escalated: [] })];
    expect(findingIds(scenario, evidence)).toContain("tool.forbidden_when");
  });

  it("reports an unreadable branch instead of quietly treating it as false", () => {
    const evidence = [...notified, final({ approved: [] })];
    expect(findingIds(scenario, evidence)).toContain("tool.condition_unresolved");
  });

  it("rejects a branch that states no condition", () => {
    const vacuous = base({
      tools: {
        allowed: ["notify"],
        required: [
          {
            tool: "notify",
            when: {
              $anyOf: [
                { outcomePath: "approved", nonEmpty: true },
                { outcomePath: "escalated" }
              ]
            }
          }
        ]
      },
      outcome: { status: "completed" }
    });
    expect(lintScenario(vacuous, {})).toContain(
      "Conditional requirement for notify must declare either equals or nonEmpty"
    );
  });
});
