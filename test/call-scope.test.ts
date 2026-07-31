import { describe, expect, it } from "vitest";
import { evaluateRun } from "../src/evaluator.js";
import { lintScenario } from "../src/scenario-linter.js";
import { resolveCandidates, validateReference } from "../src/result-reference.js";
import type { EvidenceEvent, Scenario } from "../src/types.js";

function toolResult(
  sequence: number,
  tool: string,
  result: unknown
): EvidenceEvent {
  return {
    type: "tool_result",
    callId: `c${sequence}`,
    tool,
    result,
    sequence,
    timestamp: new Date().toISOString()
  };
}

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

const final: EvidenceEvent = {
  type: "final",
  status: "completed",
  sequence: 99,
  timestamp: new Date().toISOString()
};

function scenarioWith(
  tools: NonNullable<Scenario["expect"]["tools"]>
): Scenario {
  return {
    schemaVersion: "0.1",
    id: "scoped",
    input: { message: "triage the area" },
    expect: { tools, outcome: { status: "completed" } }
  };
}

/**
 * Two lookups return two different correct owners, and the second update reuses
 * the first owner. Both values are legitimate results of the referenced tool, so
 * an unscoped reference cannot see the divergence.
 */
const wrongOwnerEvidence: EvidenceEvent[] = [
  toolResult(1, "ado.get_area_owner", { owner: "android-dri@example.test" }),
  toolCall(2, "ado.update_work_item", {
    id: "BUG-1",
    assignedTo: "android-dri@example.test"
  }),
  toolResult(3, "ado.get_area_owner", { owner: "ios-dri@example.test" }),
  toolCall(4, "ado.update_work_item", {
    id: "BUG-2",
    assignedTo: "android-dri@example.test"
  }),
  final
];

describe("call-scoped argument expectations", () => {
  it("documents the unscoped blind spot the scoping closes", () => {
    const unscoped = scenarioWith({
      arguments: [
        {
          tool: "ado.update_work_item",
          match: {
            assignedTo: {
              $fromResult: { tool: "ado.get_area_owner", path: "owner" }
            }
          }
        }
      ]
    });

    expect(evaluateRun(unscoped, wrongOwnerEvidence, 10).findings).toEqual([]);
  });

  it("catches the wrong owner once both sides are scoped to a call", () => {
    const scoped = scenarioWith({
      arguments: [0, 1].map((callIndex) => ({
        tool: "ado.update_work_item",
        callIndex,
        match: {
          assignedTo: {
            $fromResult: {
              tool: "ado.get_area_owner",
              path: "owner",
              callIndex
            }
          }
        }
      }))
    });

    expect(evaluateRun(scoped, wrongOwnerEvidence, 10).findings).toMatchObject([
      { id: "tool.arguments_subset", evidenceSequence: 4 }
    ]);
  });

  it("passes the same scoped contract when each update uses its own lookup", () => {
    const scoped = scenarioWith({
      arguments: [0, 1].map((callIndex) => ({
        tool: "ado.update_work_item",
        callIndex,
        match: {
          assignedTo: {
            $fromResult: {
              tool: "ado.get_area_owner",
              path: "owner",
              callIndex
            }
          }
        }
      }))
    });
    const evidence: EvidenceEvent[] = [
      toolResult(1, "ado.get_area_owner", { owner: "android-dri@example.test" }),
      toolCall(2, "ado.update_work_item", {
        id: "BUG-1",
        assignedTo: "android-dri@example.test"
      }),
      toolResult(3, "ado.get_area_owner", { owner: "ios-dri@example.test" }),
      toolCall(4, "ado.update_work_item", {
        id: "BUG-2",
        assignedTo: "ios-dri@example.test"
      }),
      final
    ];

    expect(evaluateRun(scoped, evidence, 10).findings).toEqual([]);
  });

  it("catches an update applied to the wrong work item", () => {
    const scoped = scenarioWith({
      arguments: [
        { tool: "ado.update_work_item", callIndex: 1, match: { id: "BUG-2" } }
      ]
    });
    const evidence: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: "BUG-1" }),
      toolCall(2, "ado.update_work_item", { id: "BUG-3" }),
      final
    ];

    expect(evaluateRun(scoped, evidence, 10).findings).toMatchObject([
      { id: "tool.arguments_subset", evidenceSequence: 2 }
    ]);
  });

  it("leaves an expectation without a selector applied to every call", () => {
    const unscoped = scenarioWith({
      arguments: [{ tool: "ado.update_work_item", match: { state: "Active" } }]
    });
    const evidence: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { state: "Active" }),
      toolCall(2, "ado.update_work_item", { state: "Resolved" }),
      final
    ];

    expect(evaluateRun(unscoped, evidence, 10).findings).toMatchObject([
      { id: "tool.arguments_subset", evidenceSequence: 2 }
    ]);
  });

  it("reports a selector that matches no call instead of passing vacuously", () => {
    const scoped = scenarioWith({
      arguments: [
        { tool: "ado.update_work_item", callIndex: 2, match: { id: "BUG-3" } }
      ]
    });
    const evidence: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: "BUG-1" }),
      toolCall(2, "ado.update_work_item", { id: "BUG-2" }),
      final
    ];

    expect(evaluateRun(scoped, evidence, 10).findings).toMatchObject([
      { id: "tool.arguments_call_missing" }
    ]);
  });

  it("reports an unreachable referenced call index as unresolved", () => {
    const scoped = scenarioWith({
      arguments: [
        {
          tool: "ado.update_work_item",
          match: {
            assignedTo: {
              $fromResult: {
                tool: "ado.get_area_owner",
                path: "owner",
                callIndex: 3
              }
            }
          }
        }
      ]
    });
    const evidence: EvidenceEvent[] = [
      toolResult(1, "ado.get_area_owner", { owner: "android-dri@example.test" }),
      toolCall(2, "ado.update_work_item", {
        assignedTo: "android-dri@example.test"
      }),
      final
    ];

    expect(evaluateRun(scoped, evidence, 10).findings).toMatchObject([
      {
        id: "tool.arguments_reference_unresolved",
        evidenceSequence: 2
      }
    ]);
  });
});

describe("resolveCandidates with a scoped call index", () => {
  const evidence: EvidenceEvent[] = [
    toolResult(1, "owner.lookup", { owner: "android-dri@example.test" }),
    toolResult(2, "owner.lookup", { owner: "ios-dri@example.test" })
  ];

  it("narrows candidates to the referenced call", () => {
    expect(
      resolveCandidates(
        { tool: "owner.lookup", path: "owner", callIndex: 1 },
        evidence,
        9
      )
    ).toEqual(["ios-dri@example.test"]);
  });

  it("returns no candidate when the referenced call never happened", () => {
    expect(
      resolveCandidates(
        { tool: "owner.lookup", path: "owner", callIndex: 2 },
        evidence,
        9
      )
    ).toEqual([]);
  });

  it("returns no candidate when the referenced call is not yet complete", () => {
    expect(
      resolveCandidates(
        { tool: "owner.lookup", path: "owner", callIndex: 1 },
        evidence,
        2
      )
    ).toEqual([]);
  });
});

describe("validateReference with a call index", () => {
  it("accepts a non-negative integer", () => {
    expect(
      validateReference({ tool: "a", path: "b", callIndex: 0 })
    ).toEqual([]);
  });

  it("rejects a negative or fractional index", () => {
    expect(validateReference({ tool: "a", path: "b", callIndex: -1 })).toContain(
      "$fromResult callIndex must be a non-negative integer"
    );
    expect(
      validateReference({ tool: "a", path: "b", callIndex: 1.5 })
    ).toContain("$fromResult callIndex must be a non-negative integer");
  });
});

describe("per-tool call budgets", () => {
  it("catches a deleted update that a required-tool list cannot see", () => {
    const scenario = scenarioWith({
      required: ["ado.update_work_item"],
      budgets: [{ tool: "ado.update_work_item", minCalls: 2 }]
    });
    const evidence: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: "BUG-1" }),
      final
    ];

    const findings = evaluateRun(scenario, evidence, 10).findings;
    expect(findings).toMatchObject([{ id: "tool.min_calls_per_tool" }]);
    expect(findings[0].message).toContain("observed 1, minimum 2");
  });

  it("catches noisy repetition that the run budget is too loose to see", () => {
    const scenario = scenarioWith({
      maxCalls: 12,
      budgets: [{ tool: "ado.update_work_item", maxCalls: 2 }]
    });
    const evidence: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: "BUG-1" }),
      toolCall(2, "ado.update_work_item", { id: "BUG-2" }),
      toolCall(3, "ado.update_work_item", { id: "BUG-3" }),
      final
    ];

    const findings = evaluateRun(scenario, evidence, 10).findings;
    expect(findings).toMatchObject([{ id: "tool.max_calls_per_tool" }]);
    expect(findings[0].message).toContain("observed 3, maximum 2");
  });

  it("passes a run inside both the floor and the ceiling", () => {
    const scenario = scenarioWith({
      budgets: [{ tool: "ado.update_work_item", minCalls: 1, maxCalls: 2 }]
    });
    const evidence: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: "BUG-1" }),
      toolCall(2, "ado.update_work_item", { id: "BUG-2" }),
      final
    ];

    expect(evaluateRun(scenario, evidence, 10).findings).toEqual([]);
  });

  it("scores each budgeted tool independently", () => {
    const scenario = scenarioWith({
      budgets: [
        { tool: "ado.update_work_item", maxCalls: 1 },
        { tool: "ado.get_area_owner", minCalls: 1 }
      ]
    });
    const evidence: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { id: "BUG-1" }),
      toolCall(2, "ado.update_work_item", { id: "BUG-2" }),
      final
    ];

    expect(
      evaluateRun(scenario, evidence, 10).findings.map((finding) => finding.id)
    ).toEqual(["tool.max_calls_per_tool", "tool.min_calls_per_tool"]);
  });
});

describe("lintScenario with scoped expectations", () => {
  it("rejects a duplicate budget for one tool", () => {
    expect(
      lintScenario(
        scenarioWith({
          budgets: [
            { tool: "ado.update_work_item", maxCalls: 1 },
            { tool: "ado.update_work_item", minCalls: 1 }
          ]
        }),
        {}
      )
    ).toContain("Call budget for ado.update_work_item is declared more than once");
  });

  it("rejects a floor above its own ceiling", () => {
    expect(
      lintScenario(
        scenarioWith({
          budgets: [{ tool: "ado.update_work_item", minCalls: 3, maxCalls: 2 }]
        }),
        {}
      )
    ).toContain(
      "Call budget for ado.update_work_item is impossible: minimum 3 exceeds maximum 2"
    );
  });

  it("rejects a floor on a forbidden tool", () => {
    expect(
      lintScenario(
        scenarioWith({
          forbidden: ["ado.advance_ring"],
          budgets: [{ tool: "ado.advance_ring", minCalls: 1 }]
        }),
        {}
      )
    ).toContain(
      "Forbidden tool ado.advance_ring cannot have a minimum call budget of 1"
    );
  });

  it("rejects a zero ceiling on a required tool", () => {
    expect(
      lintScenario(
        scenarioWith({
          required: ["ado.update_work_item"],
          budgets: [{ tool: "ado.update_work_item", maxCalls: 0 }]
        }),
        {}
      )
    ).toContain(
      "Required tool ado.update_work_item cannot have a maximum call budget of 0"
    );
  });

  it("rejects a ceiling that the declared order already exceeds", () => {
    expect(
      lintScenario(
        scenarioWith({
          order: ["ado.update_work_item", "ado.update_work_item"],
          budgets: [{ tool: "ado.update_work_item", maxCalls: 1 }]
        }),
        {}
      )
    ).toContain(
      "Call budget 1 for ado.update_work_item cannot satisfy an order that calls it 2 times"
    );
  });

  it("rejects per-tool floors that together exceed the run budget", () => {
    expect(
      lintScenario(
        scenarioWith({
          maxCalls: 3,
          budgets: [
            { tool: "ado.update_work_item", minCalls: 2 },
            { tool: "ado.get_area_owner", minCalls: 2 }
          ]
        }),
        {}
      )
    ).toContain(
      "Per-tool minimum call budgets total 4, which exceeds the run budget 3"
    );
  });

  it("rejects a selector the declared ceiling can never reach", () => {
    expect(
      lintScenario(
        scenarioWith({
          budgets: [{ tool: "ado.update_work_item", maxCalls: 2 }],
          arguments: [
            { tool: "ado.update_work_item", callIndex: 2, match: { id: "BUG-3" } }
          ]
        }),
        {}
      )
    ).toContain(
      "Argument expectation for ado.update_work_item targets call index 2, which a maximum of 2 calls can never reach"
    );
  });

  it("rejects a selector on a forbidden tool", () => {
    expect(
      lintScenario(
        scenarioWith({
          forbidden: ["ado.advance_ring"],
          arguments: [
            { tool: "ado.advance_ring", callIndex: 0, match: { ring: "ring2" } }
          ]
        }),
        {}
      )
    ).toContain(
      "Argument expectation for forbidden tool ado.advance_ring targets call index 0, which can never be observed"
    );
  });

  it("rejects a referenced call index the referenced ceiling can never reach", () => {
    expect(
      lintScenario(
        scenarioWith({
          budgets: [{ tool: "ado.get_area_owner", maxCalls: 1 }],
          arguments: [
            {
              tool: "ado.update_work_item",
              match: {
                assignedTo: {
                  $fromResult: {
                    tool: "ado.get_area_owner",
                    path: "owner",
                    callIndex: 1
                  }
                }
              }
            }
          ]
        }),
        {}
      )
    ).toContain(
      "Argument expectation for ado.update_work_item references ado.get_area_owner call index 1, which a maximum of 1 calls can never reach"
    );
  });

  it("accepts a consistent scoped contract", () => {
    expect(
      lintScenario(
        scenarioWith({
          required: ["ado.get_area_owner", "ado.update_work_item"],
          order: ["ado.get_area_owner", "ado.update_work_item"],
          maxCalls: 6,
          budgets: [
            { tool: "ado.get_area_owner", minCalls: 1, maxCalls: 2 },
            { tool: "ado.update_work_item", minCalls: 2, maxCalls: 2 }
          ],
          arguments: [
            {
              tool: "ado.update_work_item",
              callIndex: 1,
              match: {
                assignedTo: {
                  $fromResult: {
                    tool: "ado.get_area_owner",
                    path: "owner",
                    callIndex: 1
                  }
                }
              }
            }
          ]
        }),
        {}
      )
    ).toEqual([]);
  });
});
