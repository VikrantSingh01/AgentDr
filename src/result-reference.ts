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

export interface ArgumentReferenceNode {
  $argument: string;
}

export function isArgumentReferenceNode(
  value: unknown
): value is ArgumentReferenceNode {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "$argument")
  );
}

/**
 * Resolution is always relative to one call under test. `callArguments` is that
 * call's argument object, which `$argument` nodes read from, so a correlation
 * can join a consuming call to a producing call by shared key rather than by
 * position in the trace.
 */
export interface ResolutionContext {
  evidence: EvidenceEvent[];
  beforeSequence: number;
  callArguments: unknown;
}

function describeCriteria(criteria: Record<string, unknown>): string {
  return Object.entries(criteria)
    .map(([key, value]) => `${key}=${describeExpected(value)}`)
    .join(", ");
}

function describeExpected(value: unknown): string {
  if (isArgumentReferenceNode(value)) return `$argument.${value.$argument}`;
  if (isResultReferenceNode(value)) return `(${describeReference(value.$fromResult)})`;
  return JSON.stringify(value) ?? String(value);
}

export function describeReference(reference: ResultReference): string {
  const selector =
    reference.callIndex !== undefined
      ? `[${reference.callIndex}]`
      : reference.where
        ? `[where ${describeCriteria(reference.where)}]`
        : "";
  let base = `${reference.tool}${selector}.${reference.path}`;
  if (reference.find) {
    base = `${base}[find ${describeCriteria(reference.find)}]`;
    if (reference.select) base = `${base}.${reference.select}`;
  }
  if (!reference.sequence) return base;
  return `${base} offset ${reference.offset ?? 1} in declared sequence`;
}

function validateCriteria(
  label: string,
  criteria: unknown,
  errors: string[]
): void {
  if (
    typeof criteria !== "object" ||
    criteria === null ||
    Array.isArray(criteria)
  ) {
    errors.push(`$fromResult ${label} must be an object`);
    return;
  }
  const entries = Object.entries(criteria as Record<string, unknown>);
  if (entries.length === 0) {
    errors.push(`$fromResult ${label} must declare at least one key`);
  }
  for (const [key, value] of entries) {
    if (key.length === 0) {
      errors.push(`$fromResult ${label} keys must be non-empty paths`);
    }
    if (isArgumentReferenceNode(value)) {
      const path = (value as ArgumentReferenceNode).$argument;
      if (typeof path !== "string" || path.length === 0) {
        errors.push("$argument requires a non-empty argument path");
      }
      if (Object.keys(value as object).length > 1) {
        errors.push("$argument must be the only property of its object");
      }
      continue;
    }
    if (isResultReferenceNode(value)) {
      errors.push(...validateReference(value.$fromResult));
    }
  }
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
    if (
      ![
        "tool",
        "path",
        "callIndex",
        "sequence",
        "offset",
        "where",
        "find",
        "select"
      ].includes(key)
    ) {
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
    if (candidate.where !== undefined) {
      errors.push(
        "$fromResult cannot combine callIndex with where; a correlation selects a call by key, not by position"
      );
    }
  }
  if (candidate.where !== undefined) validateCriteria("where", candidate.where, errors);
  if (candidate.find !== undefined) validateCriteria("find", candidate.find, errors);
  if (candidate.select !== undefined) {
    if (typeof candidate.select !== "string" || candidate.select.length === 0) {
      errors.push("$fromResult select must be a non-empty path");
    }
    if (candidate.find === undefined) {
      errors.push("$fromResult select requires find");
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

/**
 * Resolve one criteria value to the set of values it may legally take. A
 * literal resolves to itself; `$argument` reads the call under test; a nested
 * `$fromResult` performs a further join.
 */
function resolveExpectedValues(
  expected: unknown,
  context: ResolutionContext
): unknown[] {
  if (isArgumentReferenceNode(expected)) {
    const read = readPath(context.callArguments, expected.$argument);
    return read.found ? [read.value] : [];
  }
  if (isResultReferenceNode(expected)) {
    return resolveCandidates(expected.$fromResult, context);
  }
  return [expected];
}

function criteriaMatch(
  criteria: Record<string, unknown>,
  subject: unknown,
  context: ResolutionContext
): boolean {
  return Object.entries(criteria).every(([path, expected]) => {
    const read = readPath(subject, path);
    if (!read.found) return false;
    const values = resolveExpectedValues(expected, context);
    return values.some((value) => isStructurallyEqual(value, read.value));
  });
}

function argumentsForCallId(
  evidence: EvidenceEvent[],
  callId: string
): Record<string, unknown> | undefined {
  for (const event of evidence) {
    if (event.type === "tool_call" && event.callId === callId) {
      return event.arguments;
    }
  }
  return undefined;
}

export function resolveCandidates(
  reference: ResultReference,
  contextOrEvidence: ResolutionContext | EvidenceEvent[],
  beforeSequence?: number
): unknown[] {
  const context: ResolutionContext = Array.isArray(contextOrEvidence)
    ? {
        evidence: contextOrEvidence,
        beforeSequence: beforeSequence ?? Number.POSITIVE_INFINITY,
        callArguments: undefined
      }
    : contextOrEvidence;
  const { evidence, beforeSequence: limit } = context;
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
    if (event.sequence >= limit) continue;
    if (reference.where) {
      const sourceArguments = argumentsForCallId(evidence, event.callId);
      if (sourceArguments === undefined) continue;
      if (!criteriaMatch(reference.where, sourceArguments, context)) continue;
    }
    const read = readPath(event.result, reference.path);
    if (!read.found) continue;
    let value = read.value;
    if (reference.find) {
      if (!Array.isArray(value)) continue;
      const element = value.find((entry) =>
        criteriaMatch(reference.find as Record<string, unknown>, entry, context)
      );
      if (element === undefined) continue;
      if (reference.select) {
        const selected = readPath(element, reference.select);
        if (!selected.found) continue;
        value = selected.value;
      } else {
        value = element;
      }
    }
    if (!reference.sequence) {
      candidates.push(value);
      continue;
    }
    const index = reference.sequence.findIndex((entry) =>
      isStructurallyEqual(entry, value)
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
  context: ResolutionContext,
  unresolved: string[]
): boolean {
  if (isResultReferenceNode(expected)) {
    const reference = expected.$fromResult;
    const candidates = resolveCandidates(reference, context);
    if (candidates.length === 0) {
      unresolved.push(describeReference(reference));
      return false;
    }
    return candidates.some((candidate) => isStructurallyEqual(candidate, actual));
  }

  if (isArgumentReferenceNode(expected)) {
    const read = readPath(context.callArguments, expected.$argument);
    if (!read.found) {
      unresolved.push(`$argument.${expected.$argument}`);
      return false;
    }
    return isStructurallyEqual(read.value, actual);
  }

  if (expected === null || typeof expected !== "object") {
    return Object.is(expected, actual);
  }
  if (actual === null || typeof actual !== "object") return false;

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((value, index) =>
      walk(value, actual[index], context, unresolved)
    );
  }

  return Object.entries(expected).every(([key, value]) =>
    walk(value, (actual as Record<string, unknown>)[key], context, unresolved)
  );
}

export function matchWithReferences(
  expected: unknown,
  actual: unknown,
  evidence: EvidenceEvent[],
  beforeSequence: number
): ReferenceMatch {
  const unresolved: string[] = [];
  const context: ResolutionContext = {
    evidence,
    beforeSequence,
    callArguments: actual
  };
  const matched = walk(expected, actual, context, unresolved);
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
