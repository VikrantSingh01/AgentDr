import { describe, expect, it } from "vitest";
import { evaluateRun } from "../src/evaluator.js";
import { lintScenario } from "../src/scenario-linter.js";
import { validateReference } from "../src/result-reference.js";
import type { EvidenceEvent, Scenario } from "../src/types.js";

function toolResult(
  sequence: number,
  tool: string,
  result: unknown
): EvidenceEvent {
  return {
    type: "tool_result",
    callId: `c${sequence - 1}`,
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

const BUGS = {
  bugs: [
    { id: 1, areaPath: "Android" },
    { id: 2, areaPath: "iOS" },
    { id: 3, areaPath: "Android" }
  ]
};

/**
 * The invariant under test is relational, not positional: the assignee on an
 * update must be the owner returned by the lookup whose areaPath matches the
 * area of the bug that update is about.
 */
const CORRELATED_ASSIGNEE = {
  $fromResult: {
    tool: "get_owner",
    path: "owner",
    where: {
      areaPath: {
        $fromResult: {
          tool: "list_bugs",
          path: "bugs",
          find: { id: { $argument: "id" } },
          select: "areaPath"
        }
      }
    }
  }
};

function scenario(): Scenario {
  return {
    schemaVersion: "0.1",
    id: "correlated",
    input: { message: "triage" },
    expect: {
      tools: {
        allowed: ["list_bugs", "get_owner", "update"],
        arguments: [{ tool: "update", match: { assignedTo: CORRELATED_ASSIGNEE } }]
      },
      outcome: { status: "completed" }
    }
  };
}

/** Build a trace from a caller-chosen interleaving of lookups and updates. */
function trace(
  steps: Array<
    | { kind: "lookup"; areaPath: string; owner: string }
    | { kind: "update"; id: number; assignedTo: string }
  >
): EvidenceEvent[] {
  const evidence: EvidenceEvent[] = [
    toolCall(0, "list_bugs", { areaPath: "root" }),
    toolResult(1, "list_bugs", BUGS)
  ];
  let sequence = 2;
  for (const step of steps) {
    if (step.kind === "lookup") {
      evidence.push(
        toolCall(sequence, "get_owner", { areaPath: step.areaPath }),
        toolResult(sequence + 1, "get_owner", { owner: step.owner })
      );
    } else {
      evidence.push(
        toolCall(sequence, "update", {
          id: step.id,
          assignedTo: step.assignedTo
        }),
        toolResult(sequence + 1, "update", { ok: true })
      );
    }
    sequence += 2;
  }
  evidence.push(final);
  return evidence;
}

const BASELINE = [
  { kind: "lookup", areaPath: "Android", owner: "droid@x" },
  { kind: "update", id: 1, assignedTo: "droid@x" },
  { kind: "lookup", areaPath: "iOS", owner: "ios@x" },
  { kind: "update", id: 2, assignedTo: "ios@x" },
  { kind: "update", id: 3, assignedTo: "droid@x" }
] as const;

function findingIds(evidence: EvidenceEvent[]): string[] {
  return evaluateRun(scenario(), evidence, 1).findings.map(
    (finding) => finding.id
  );
}

describe("relational correlation by shared key", () => {
  it("accepts a trace where every assignee matches its own area owner", () => {
    expect(findingIds(trace([...BASELINE]))).toEqual([]);
  });

  it("accepts the same assignments applied in a different order", () => {
    expect(
      findingIds(
        trace([
          { kind: "lookup", areaPath: "iOS", owner: "ios@x" },
          { kind: "lookup", areaPath: "Android", owner: "droid@x" },
          { kind: "update", id: 3, assignedTo: "droid@x" },
          { kind: "update", id: 2, assignedTo: "ios@x" },
          { kind: "update", id: 1, assignedTo: "droid@x" }
        ])
      )
    ).toEqual([]);
  });

  it("accepts lookups batched ahead of every update", () => {
    expect(
      findingIds(
        trace([
          { kind: "lookup", areaPath: "Android", owner: "droid@x" },
          { kind: "lookup", areaPath: "iOS", owner: "ios@x" },
          { kind: "update", id: 1, assignedTo: "droid@x" },
          { kind: "update", id: 2, assignedTo: "ios@x" },
          { kind: "update", id: 3, assignedTo: "droid@x" }
        ])
      )
    ).toEqual([]);
  });

  it("rejects an assignee swapped between two bugs in different areas", () => {
    expect(
      findingIds(
        trace([
          { kind: "lookup", areaPath: "Android", owner: "droid@x" },
          { kind: "lookup", areaPath: "iOS", owner: "ios@x" },
          { kind: "update", id: 1, assignedTo: "ios@x" },
          { kind: "update", id: 2, assignedTo: "droid@x" },
          { kind: "update", id: 3, assignedTo: "droid@x" }
        ])
      )
    ).toEqual(["tool.arguments_subset", "tool.arguments_subset"]);
  });

  it("rejects an assignee that was never returned by any lookup", () => {
    expect(
      findingIds(
        trace([
          { kind: "lookup", areaPath: "Android", owner: "droid@x" },
          { kind: "update", id: 1, assignedTo: "intern@x" }
        ])
      )
    ).toEqual(["tool.arguments_subset"]);
  });

  it("reports an unresolved correlation when the update precedes its lookup", () => {
    expect(
      findingIds(
        trace([
          { kind: "update", id: 1, assignedTo: "droid@x" },
          { kind: "lookup", areaPath: "Android", owner: "droid@x" }
        ])
      )
    ).toEqual(["tool.arguments_reference_unresolved"]);
  });

  it("reports an unresolved correlation when the join key is absent", () => {
    // Bug 99 is not in the list, so the inner join yields nothing. Section 9
    // rule: an unresolvable correlation reports, it never vacuously passes.
    expect(
      findingIds(
        trace([
          { kind: "lookup", areaPath: "Android", owner: "droid@x" },
          { kind: "update", id: 99, assignedTo: "droid@x" }
        ])
      )
    ).toEqual(["tool.arguments_reference_unresolved"]);
  });

  it("holds on a larger backlog without touching the contract", () => {
    expect(
      findingIds(
        trace([
          { kind: "lookup", areaPath: "Android", owner: "droid@x" },
          { kind: "lookup", areaPath: "iOS", owner: "ios@x" },
          { kind: "update", id: 1, assignedTo: "droid@x" },
          { kind: "update", id: 3, assignedTo: "droid@x" },
          { kind: "update", id: 2, assignedTo: "ios@x" }
        ])
      )
    ).toEqual([]);
  });
});

describe("correlation linting", () => {
  it("rejects combining callIndex with where", () => {
    expect(
      validateReference({
        tool: "a",
        path: "b",
        callIndex: 0,
        where: { k: 1 }
      })
    ).toContain(
      "$fromResult cannot combine callIndex with where; a correlation selects a call by key, not by position"
    );
  });

  it("rejects an empty where clause", () => {
    expect(validateReference({ tool: "a", path: "b", where: {} })).toContain(
      "$fromResult where must declare at least one key"
    );
  });

  it("rejects an empty find clause", () => {
    expect(validateReference({ tool: "a", path: "b", find: {} })).toContain(
      "$fromResult find must declare at least one key"
    );
  });

  it("rejects select without find", () => {
    expect(validateReference({ tool: "a", path: "b", select: "x" })).toContain(
      "$fromResult select requires find"
    );
  });

  it("rejects an empty select path", () => {
    expect(
      validateReference({ tool: "a", path: "b", find: { k: 1 }, select: "" })
    ).toContain("$fromResult select must be a non-empty path");
  });

  it("rejects an empty $argument path", () => {
    expect(
      validateReference({ tool: "a", path: "b", where: { k: { $argument: "" } } })
    ).toContain("$argument requires a non-empty argument path");
  });

  it("validates a reference nested inside a where clause", () => {
    expect(
      validateReference({
        tool: "a",
        path: "b",
        where: { k: { $fromResult: { tool: "c", bogus: 1 } } }
      })
    ).toContain("$fromResult does not support the property bogus");
  });

  it("surfaces correlation errors through the scenario linter", () => {
    const invalid = scenario();
    invalid.expect.tools!.arguments = [
      {
        tool: "update",
        match: {
          assignedTo: {
            $fromResult: { tool: "get_owner", path: "owner", select: "x" }
          }
        }
      }
    ];
    expect(lintScenario(invalid, {}).join("\n")).toContain(
      "$fromResult select requires find"
    );
  });
});
