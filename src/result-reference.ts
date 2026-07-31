import type { EvidenceEvent, ResultReference } from "./types.js";
import { isStructurallyEqual } from "./value-match.js";

export interface ResultReferenceNode {
  $fromResult: ResultReference;
}

export function isResultReferenceNode(
  value: unknown
): value is ResultReferenceNode {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "$fromResult")
  );
}

export function describeReference(reference: ResultReference): string {
  const base = `${reference.tool}${
    reference.callIndex === undefined ? "" : `[${reference.callIndex}]`
  }.${reference.path}`;
  if (!reference.sequence) return base;
  return `${base} offset ${reference.offset ?? 1} in declared sequence`;
}

export function validateReference(reference: unknown): string[] {
  const errors: string[] = [];
  if (
    typeof reference !== "object" ||
    reference === null ||
    Array.isArray(reference)
  ) {
    errors.push("$fromResult must be an object");
    return errors;
  }
  const candidate = reference as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (!["tool", "path", "callIndex", "sequence", "offset"].includes(key)) {
      errors.push(`$fromResult does not support the property ${key}`);
    }
  }
  if (typeof candidate.tool !== "string" || candidate.tool.length === 0) {
    errors.push("$fromResult requires a non-empty tool name");
  }
  if (typeof candidate.path !== "string" || candidate.path.length === 0) {
    errors.push("$fromResult requires a non-empty result path");
  }
  if (candidate.callIndex !== undefined) {
    if (!Number.isInteger(candidate.callIndex) || (candidate.callIndex as number) < 0) {
      errors.push("$fromResult callIndex must be a non-negative integer");
    }
  }
  if (candidate.sequence !== undefined) {
    if (!Array.isArray(candidate.sequence) || candidate.sequence.length === 0) {
      errors.push("$fromResult sequence must be a non-empty array");
    }
  }
  if (candidate.offset !== undefined) {
    if (!Number.isInteger(candidate.offset)) {
      errors.push("$fromResult offset must be an integer");
    } else if (candidate.sequence === undefined) {
      errors.push("$fromResult offset requires a declared sequence");
    }
  }
  return errors;
}

function readPath(source: unknown, path: string): { found: boolean; value: unknown } {
  let current = source;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return { found: false, value: undefined };
    }
    if (!Object.hasOwn(current as object, segment)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

export function readValueAtPath(
  source: unknown,
  path: string
): { found: boolean; value: unknown } {
  return readPath(source, path);
}

export function resolveCandidates(
  reference: ResultReference,
  evidence: EvidenceEvent[],
  beforeSequence: number
): unknown[] {
  const offset = reference.offset ?? 1;
  const candidates: unknown[] = [];
  const results = evidence.filter(
    (event): event is Extract<EvidenceEvent, { type: "tool_result" }> =>
      event.type === "tool_result" && event.tool === reference.tool
  );
  const scoped =
    reference.callIndex === undefined
      ? results
      : results.slice(reference.callIndex, reference.callIndex + 1);
  for (const event of scoped) {
    if (event.sequence >= beforeSequence) continue;
    const read = readPath(event.result, reference.path);
    if (!read.found) continue;
    if (!reference.sequence) {
      candidates.push(read.value);
      continue;
    }
    const index = reference.sequence.findIndex((entry) =>
      isStructurallyEqual(entry, read.value)
    );
    if (index === -1) continue;
    const target = index + offset;
    if (target < 0 || target >= reference.sequence.length) continue;
    candidates.push(reference.sequence[target]);
  }
  return candidates;
}

export interface ReferenceMatch {
  matched: boolean;
  unresolved: string[];
}

function walk(
  expected: unknown,
  actual: unknown,
  evidence: EvidenceEvent[],
  beforeSequence: number,
  unresolved: string[]
): boolean {
  if (isResultReferenceNode(expected)) {
    const reference = expected.$fromResult;
    const candidates = resolveCandidates(reference, evidence, beforeSequence);
    if (candidates.length === 0) {
      unresolved.push(describeReference(reference));
      return false;
    }
    return candidates.some((candidate) => isStructurallyEqual(candidate, actual));
  }

  if (expected === null || typeof expected !== "object") {
    return Object.is(expected, actual);
  }
  if (actual === null || typeof actual !== "object") return false;

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((value, index) =>
      walk(value, actual[index], evidence, beforeSequence, unresolved)
    );
  }

  return Object.entries(expected).every(([key, value]) =>
    walk(
      value,
      (actual as Record<string, unknown>)[key],
      evidence,
      beforeSequence,
      unresolved
    )
  );
}

export function matchWithReferences(
  expected: unknown,
  actual: unknown,
  evidence: EvidenceEvent[],
  beforeSequence: number
): ReferenceMatch {
  const unresolved: string[] = [];
  const matched = walk(expected, actual, evidence, beforeSequence, unresolved);
  return { matched, unresolved };
}

export function collectReferenceNodes(expected: unknown): unknown[] {
  if (isResultReferenceNode(expected)) {
    return [expected.$fromResult];
  }
  if (Array.isArray(expected)) {
    return expected.flatMap((entry) => collectReferenceNodes(entry));
  }
  if (expected !== null && typeof expected === "object") {
    return Object.values(expected as Record<string, unknown>).flatMap((entry) =>
      collectReferenceNodes(entry)
    );
  }
  return [];
}
