import { describe, expect, it } from "vitest";
import { evaluateRun } from "../src/evaluator.js";
import { lintScenario } from "../src/scenario-linter.js";
import {
  matchWithReferences,
  resolveCandidates,
  validateReference
} from "../src/result-reference.js";
import type { EvidenceEvent, Scenario } from "../src/types.js";

const RINGS = ["ring0", "ring1", "ring1_5", "ring2"];

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

describe("resolveCandidates", () => {
  const evidence: EvidenceEvent[] = [
    toolResult(1, "owner.lookup", { owner: "android-dri@example.test" }),
    toolResult(2, "owner.lookup", { owner: "ios-dri@example.test" }),
    toolResult(3, "rollout.status", { currentRing: "ring1_5" })
  ];

  it("collects every preceding result value at the referenced path", () => {
    expect(
      resolveCandidates({ tool: "owner.lookup", path: "owner" }, evidence, 9)
    ).toEqual(["android-dri@example.test", "ios-dri@example.test"]);
  });

  it("ignores results at or after the referencing call", () => {
    expect(
      resolveCandidates({ tool: "owner.lookup", path: "owner" }, evidence, 2)
    ).toEqual(["android-dri@example.test"]);
  });

  it("reads nested and indexed paths", () => {
    const nested: EvidenceEvent[] = [
      toolResult(1, "calendar.availability", { slots: [{ start: "09:00" }] })
    ];
    expect(
      resolveCandidates(
        { tool: "calendar.availability", path: "slots.0.start" },
        nested,
        9
      )
    ).toEqual(["09:00"]);
  });

  it("returns no candidates when the path is absent", () => {
    expect(
      resolveCandidates({ tool: "owner.lookup", path: "missing" }, evidence, 9)
    ).toEqual([]);
  });

  it("resolves the declared successor when a sequence and offset are given", () => {
    expect(
      resolveCandidates(
        {
          tool: "rollout.status",
          path: "currentRing",
          sequence: RINGS,
          offset: 1
        },
        evidence,
        9
      )
    ).toEqual(["ring2"]);
  });

  it("returns no candidates when the offset runs past the declared sequence", () => {
    expect(
      resolveCandidates(
        {
          tool: "rollout.status",
          path: "currentRing",
          sequence: RINGS,
          offset: 5
        },
        evidence,
        9
      )
    ).toEqual([]);
  });

  it("returns no candidates when the observed value is outside the declared sequence", () => {
    expect(
      resolveCandidates(
        {
          tool: "rollout.status",
          path: "currentRing",
          sequence: ["alpha", "beta"],
          offset: 1
        },
        evidence,
        9
      )
    ).toEqual([]);
  });
});

describe("matchWithReferences", () => {
  const evidence: EvidenceEvent[] = [
    toolResult(1, "owner.lookup", { owner: "android-dri@example.test" })
  ];

  it("matches an argument bound to a preceding result", () => {
    expect(
      matchWithReferences(
        { assignedTo: { $fromResult: { tool: "owner.lookup", path: "owner" } } },
        { assignedTo: "android-dri@example.test", id: 1 },
        evidence,
        9
      )
    ).toEqual({ matched: true, unresolved: [] });
  });

  it("rejects an argument that does not equal any preceding result", () => {
    expect(
      matchWithReferences(
        { assignedTo: { $fromResult: { tool: "owner.lookup", path: "owner" } } },
        { assignedTo: "triage-bot@example.test" },
        evidence,
        9
      )
    ).toEqual({ matched: false, unresolved: [] });
  });

  it("reports an unresolvable reference rather than silently matching", () => {
    const outcome = matchWithReferences(
      { assignedTo: { $fromResult: { tool: "owner.lookup", path: "owner" } } },
      { assignedTo: "anything" },
      [],
      9
    );
    expect(outcome.matched).toBe(false);
    expect(outcome.unresolved).toEqual(["owner.lookup.owner"]);
  });

  it("still compares literal values alongside references", () => {
    expect(
      matchWithReferences(
        {
          channel: "Mobile Platform Leads",
          assignedTo: { $fromResult: { tool: "owner.lookup", path: "owner" } }
        },
        { channel: "Wrong Channel", assignedTo: "android-dri@example.test" },
        evidence,
        9
      ).matched
    ).toBe(false);
  });
});

describe("validateReference", () => {
  it("accepts a minimal reference", () => {
    expect(validateReference({ tool: "a", path: "b" })).toEqual([]);
  });

  it("rejects a missing tool or path", () => {
    expect(validateReference({ path: "b" })).toContain(
      "$fromResult requires a non-empty tool name"
    );
    expect(validateReference({ tool: "a" })).toContain(
      "$fromResult requires a non-empty result path"
    );
  });

  it("rejects unknown properties", () => {
    expect(validateReference({ tool: "a", path: "b", where: 1 })).toContain(
      "$fromResult does not support the property where"
    );
  });

  it("rejects an offset without a declared sequence", () => {
    expect(validateReference({ tool: "a", path: "b", offset: 1 })).toContain(
      "$fromResult offset requires a declared sequence"
    );
  });
});

describe("evaluateRun with derived arguments", () => {
  const scenario: Scenario = {
    schemaVersion: "0.1",
    id: "derived",
    input: { message: "route the bug" },
    expect: {
      tools: {
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
      },
      outcome: { status: "completed" }
    }
  };

  const final: EvidenceEvent = {
    type: "final",
    status: "completed",
    sequence: 99,
    timestamp: new Date().toISOString()
  };

  it("passes when the dispatched argument came from the prior result", () => {
    const evidence: EvidenceEvent[] = [
      toolResult(1, "ado.get_area_owner", { owner: "dri@example.test" }),
      toolCall(2, "ado.update_work_item", { assignedTo: "dri@example.test" }),
      final
    ];
    expect(evaluateRun(scenario, evidence, 10).findings).toEqual([]);
  });

  it("fails when the dispatched argument diverges from the prior result", () => {
    const evidence: EvidenceEvent[] = [
      toolResult(1, "ado.get_area_owner", { owner: "dri@example.test" }),
      toolCall(2, "ado.update_work_item", { assignedTo: "bot@example.test" }),
      final
    ];
    expect(evaluateRun(scenario, evidence, 10).findings).toMatchObject([
      { id: "tool.arguments_subset", evidenceSequence: 2 }
    ]);
  });

  it("fails when the referenced result was never observed", () => {
    const evidence: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { assignedTo: "dri@example.test" }),
      final
    ];
    expect(evaluateRun(scenario, evidence, 10).findings).toMatchObject([
      { id: "tool.arguments_reference_unresolved", evidenceSequence: 1 }
    ]);
  });

  it("fails when the referenced result arrives only after the call", () => {
    const evidence: EvidenceEvent[] = [
      toolCall(1, "ado.update_work_item", { assignedTo: "dri@example.test" }),
      toolResult(2, "ado.get_area_owner", { owner: "dri@example.test" }),
      final
    ];
    expect(evaluateRun(scenario, evidence, 10).findings).toMatchObject([
      { id: "tool.arguments_reference_unresolved", evidenceSequence: 1 }
    ]);
  });
});

describe("lintScenario with derived arguments", () => {
  function scenarioWith(
    tools: NonNullable<Scenario["expect"]["tools"]>
  ): Scenario {
    return {
      schemaVersion: "0.1",
      id: "lint",
      input: { message: "x" },
      expect: { tools, outcome: { status: "completed" } }
    };
  }

  it("rejects a reference to a forbidden tool", () => {
    const errors = lintScenario(
      scenarioWith({
        forbidden: ["ado.get_area_owner"],
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
      }),
      {}
    );
    expect(errors).toContain(
      "Argument expectation for ado.update_work_item references forbidden tool ado.get_area_owner, so it can never resolve"
    );
  });

  it("rejects a reference the declared order places later", () => {
    const errors = lintScenario(
      scenarioWith({
        order: ["ado.update_work_item", "ado.get_area_owner"],
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
      }),
      {}
    );
    expect(errors).toContain(
      "Argument expectation for ado.update_work_item references ado.get_area_owner, which the declared order places later"
    );
  });

  it("accepts a reference the declared order places earlier", () => {
    const errors = lintScenario(
      scenarioWith({
        order: ["ado.get_area_owner", "ado.update_work_item"],
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
      }),
      {}
    );
    expect(errors).toEqual([]);
  });

  it("reports a malformed reference", () => {
    const errors = lintScenario(
      scenarioWith({
        arguments: [
          {
            tool: "ado.update_work_item",
            match: { assignedTo: { $fromResult: { tool: "a" } } }
          }
        ]
      }),
      {}
    );
    expect(errors).toContain(
      "Argument expectation for ado.update_work_item is invalid: $fromResult requires a non-empty result path"
    );
  });
});
