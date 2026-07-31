import { describe, expect, it } from "vitest";
import { evaluateRun } from "../src/evaluator.js";
import { lintScenario } from "../src/scenario-linter.js";
import type { EvidenceEvent, Scenario } from "../src/types.js";

function scenario(expectations: unknown): Scenario {
  return {
    schema: "agentdoctor/scenario@0.1",
    id: "derived",
    prompt: "triage",
    fixtures: {},
    expect: expectations
  } as Scenario;
}

interface CallSpec {
  tool: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
}

function evidenceFor(calls: CallSpec[], output: unknown): EvidenceEvent[] {
  const events: EvidenceEvent[] = [];
  let sequence = 0;
  calls.forEach((call, index) => {
    events.push({
      type: "tool_call",
      sequence: ++sequence,
      timestamp: sequence,
      callId: `c${index}`,
      tool: call.tool,
      arguments: call.arguments ?? {}
    });
    events.push({
      type: "tool_result",
      sequence: ++sequence,
      timestamp: sequence,
      callId: `c${index}`,
      tool: call.tool,
      result: call.result ?? {}
    });
  });
  events.push({
    type: "final",
    sequence: ++sequence,
    timestamp: sequence,
    status: "completed",
    output
  });
  return events;
}

const backlog = {
  bugs: [
    { id: 1, severity: "S1", priority: 3, areaPath: "A" },
    { id: 2, severity: "S3", priority: 1, areaPath: "B" },
    { id: 3, severity: "S3", priority: 3, areaPath: "C" }
  ]
};

const selectionPolicy = scenario({
  tools: {
    arguments: [
      {
        tool: "ado.update_work_item",
        match: {
          id: {
            $fromResult: {
              tool: "ado.query_untriaged_bugs",
              path: "bugs",
              find: {
                id: { $argument: "id" },
                $anyOf: [{ severity: "S1" }, { priority: 1 }]
              },
              select: "id"
            }
          }
        }
      }
    ]
  }
});

describe("$anyOf selection policy", () => {
  it("accepts a call that satisfies the first branch", () => {
    const result = evaluateRun(
      selectionPolicy,
      evidenceFor(
        [
          { tool: "ado.query_untriaged_bugs", result: backlog },
          { tool: "ado.update_work_item", arguments: { id: 1 } }
        ],
        {}
      ),
      1
    );
    expect(result.findings).toEqual([]);
  });

  it("accepts a call that satisfies only the second branch", () => {
    const result = evaluateRun(
      selectionPolicy,
      evidenceFor(
        [
          { tool: "ado.query_untriaged_bugs", result: backlog },
          { tool: "ado.update_work_item", arguments: { id: 2 } }
        ],
        {}
      ),
      1
    );
    expect(result.findings).toEqual([]);
  });

  it("rejects a call that satisfies no branch", () => {
    const result = evaluateRun(
      selectionPolicy,
      evidenceFor(
        [
          { tool: "ado.query_untriaged_bugs", result: backlog },
          { tool: "ado.update_work_item", arguments: { id: 3 } }
        ],
        {}
      ),
      1
    );
    expect(result.findings.map((entry) => entry.id)).toEqual([
      "tool.arguments_reference_unresolved"
    ]);
  });

  it("still requires the non-disjunctive criteria to hold", () => {
    // Bug 1 satisfies the disjunction, but the id criterion pins the join to the
    // record the call is actually about, so a call about bug 99 cannot borrow it.
    const result = evaluateRun(
      selectionPolicy,
      evidenceFor(
        [
          { tool: "ado.query_untriaged_bugs", result: backlog },
          { tool: "ado.update_work_item", arguments: { id: 99 } }
        ],
        {}
      ),
      1
    );
    expect(result.findings.map((entry) => entry.id)).toEqual([
      "tool.arguments_reference_unresolved"
    ]);
  });

  it("rejects a disjunction with fewer than two alternatives", () => {
    const errors = lintScenario(
      scenario({
        tools: {
          arguments: [
            {
              tool: "t",
              match: {
                id: {
                  $fromResult: {
                    tool: "s",
                    path: "items",
                    find: { $anyOf: [{ severity: "S1" }] }
                  }
                }
              }
            }
          ]
        }
      }),
      {}
    );
    expect(errors.join("\n")).toContain("at least two alternatives");
  });

  it("validates the inside of each alternative", () => {
    const errors = lintScenario(
      scenario({
        tools: {
          arguments: [
            {
              tool: "t",
              match: {
                id: {
                  $fromResult: {
                    tool: "s",
                    path: "items",
                    find: { $anyOf: [{ a: 1 }, { b: { $argument: "" } }] }
                  }
                }
              }
            }
          ]
        }
      }),
      {}
    );
    expect(errors.join("\n")).toContain("$argument requires a non-empty argument path");
  });
});

const reportMatchesAction = scenario({
  tools: {
    arguments: [
      {
        tool: "ecs.advance_rollout_ring",
        match: {
          fromRing: { $fromOutcome: "ringAdvance.fromRing" },
          toRing: { $fromOutcome: "ringAdvance.toRing" }
        }
      }
    ]
  }
});

describe("$fromOutcome report-versus-action", () => {
  it("accepts a report that agrees with the arguments sent", () => {
    const result = evaluateRun(
      reportMatchesAction,
      evidenceFor(
        [{ tool: "ecs.advance_rollout_ring", arguments: { fromRing: "r1", toRing: "r2" } }],
        { ringAdvance: { fromRing: "r1", toRing: "r2" } }
      ),
      1
    );
    expect(result.findings).toEqual([]);
  });

  it("catches an agent that acts one way and narrates another", () => {
    const result = evaluateRun(
      reportMatchesAction,
      evidenceFor(
        [{ tool: "ecs.advance_rollout_ring", arguments: { fromRing: "r0", toRing: "r2" } }],
        { ringAdvance: { fromRing: "r1", toRing: "r2" } }
      ),
      1
    );
    expect(result.findings.map((entry) => entry.id)).toEqual(["tool.arguments_subset"]);
  });

  it("stays silent in worlds where the action was never taken", () => {
    // This is the whole reason the check is written as an argument expectation
    // rather than an outcome expectation: it must not fire when the agent
    // correctly declines to act.
    const result = evaluateRun(
      reportMatchesAction,
      evidenceFor([{ tool: "ecs.get_rollout_status" }], {
        ringAdvance: { attempted: false }
      }),
      1
    );
    expect(result.findings).toEqual([]);
  });

  it("never passes vacuously when the reported path is missing", () => {
    const result = evaluateRun(
      reportMatchesAction,
      evidenceFor(
        [{ tool: "ecs.advance_rollout_ring", arguments: { fromRing: "r1", toRing: "r2" } }],
        { ringAdvance: { attempted: true } }
      ),
      1
    );
    expect(result.findings.map((entry) => entry.id)).toEqual([
      "tool.arguments_reference_unresolved"
    ]);
  });

  it("rejects a self-referential use inside the outcome expectation", () => {
    const errors = lintScenario(
      scenario({
        outcome: { status: "completed", match: { a: { $fromOutcome: "b" } } }
      }),
      {}
    );
    expect(errors.join("\n")).toContain("compare the final output against itself");
  });

  it("rejects an empty output path", () => {
    const errors = lintScenario(
      scenario({
        tools: { arguments: [{ tool: "t", match: { a: { $fromOutcome: "" } } }] }
      }),
      {}
    );
    expect(errors.join("\n")).toContain("$fromOutcome requires a non-empty output path");
  });
});

describe("correlated outcome expectations", () => {
  const correlated = scenario({
    outcome: {
      status: "completed",
      match: {
        rollout: {
          currentRing: {
            $fromResult: { tool: "ecs.get_rollout_status", path: "currentRing" }
          }
        }
      }
    }
  });

  it("accepts a report that agrees with the observed result in any world", () => {
    for (const ring of ["ring1_5", "ring3", "ring4"]) {
      const result = evaluateRun(
        correlated,
        evidenceFor([{ tool: "ecs.get_rollout_status", result: { currentRing: ring } }], {
          rollout: { currentRing: ring }
        }),
        1
      );
      expect(result.findings, `ring ${ring}`).toEqual([]);
    }
  });

  it("catches misreporting in a world the baseline never visited", () => {
    const result = evaluateRun(
      correlated,
      evidenceFor([{ tool: "ecs.get_rollout_status", result: { currentRing: "ring3" } }], {
        rollout: { currentRing: "ring4" }
      }),
      1
    );
    expect(result.findings.map((entry) => entry.id)).toEqual(["outcome.output_subset"]);
  });

  it("reports an unresolvable outcome reference rather than passing", () => {
    const result = evaluateRun(
      correlated,
      evidenceFor([], { rollout: { currentRing: "ring4" } }),
      1
    );
    expect(result.findings.map((entry) => entry.id)).toEqual([
      "outcome.reference_unresolved"
    ]);
  });

  it("rejects an outcome expectation that references a forbidden tool", () => {
    const errors = lintScenario(
      scenario({
        tools: { forbidden: ["ecs.get_rollout_status"] },
        outcome: {
          status: "completed",
          match: {
            ring: { $fromResult: { tool: "ecs.get_rollout_status", path: "currentRing" } }
          }
        }
      }),
      {}
    );
    expect(errors.join("\n")).toContain("so it can never resolve");
  });
});
