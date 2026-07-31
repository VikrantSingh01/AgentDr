#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { expenseWorkflow } from "./workflow.mjs";
import { domainRoot, finalOutput, findingIds, runContract, toolCalls } from "./lib/harness.mjs";

const DECISIONS = new Set(["approved", "escalated"]);

const CONTRACT = "contract.yml";
const only = process.argv.find((argument) => argument.startsWith("--only="))?.slice("--only=".length);

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function primitiveType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectScalars(value, key = "") {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [{ key, value }];
  }

  if (Array.isArray(value)) return value.flatMap((item) => collectScalars(item, key));
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([childKey, childValue]) =>
      collectScalars(childValue, childKey)
    );
  }

  return [];
}

function looksLikeEmail(value) {
  return typeof value === "string" && /^[^@\s]+@[^@\s]+$/.test(value);
}

function looksLikeExpenseId(value) {
  return typeof value === "string" && /^EXP-\d+$/.test(value);
}

function keyLooksLikeDecision(key) {
  return key.toLowerCase().includes("decision");
}

function firstCandidate(candidates, predicate) {
  return candidates.find((candidate) => predicate(candidate.value, candidate.key))?.value;
}

function replacementFor(key, original, seenValues) {
  if (!["string", "number", "boolean", "null"].includes(primitiveType(original))) {
    return undefined;
  }

  const candidates = seenValues.filter(
    (candidate) =>
      primitiveType(candidate.value) === primitiveType(original) && !sameValue(candidate.value, original)
  );

  const sameKey = firstCandidate(candidates, (_value, candidateKey) => candidateKey === key);
  if (sameKey !== undefined) return clone(sameKey);

  if (looksLikeEmail(original)) {
    const email = firstCandidate(candidates, (value) => looksLikeEmail(value));
    if (email !== undefined) return clone(email);
  }

  if (looksLikeExpenseId(original)) {
    const expenseId = firstCandidate(candidates, (value) => looksLikeExpenseId(value));
    if (expenseId !== undefined) return clone(expenseId);
  }

  if (keyLooksLikeDecision(key) || DECISIONS.has(original)) {
    const decision = firstCandidate(candidates, (value) => DECISIONS.has(value));
    if (decision !== undefined) return clone(decision);
  }

  const sameType = candidates[0]?.value;
  return sameType === undefined ? undefined : clone(sameType);
}

function syntheticForReorder(tool, args, entriesBefore) {
  const earlier = entriesBefore
    .filter((entry) => entry.kind === "tool" && entry.tool === tool)
    .map((entry) => entry.resumeValue);
  if (earlier.length > 0) return clone(earlier[earlier.length - 1]);

  if (tool === "finance.get_policy") {
    return {
      department: args.department,
      autoApproveUnder: 500,
      receiptRequiredOver: 250,
      escalationApprover: "finance-approver@contoso.example"
    };
  }
  if (tool === "finance.list_pending") return { department: args.department, expenses: [] };
  if (tool === "finance.fetch_receipt") {
    return { expenseId: args.expenseId, verified: true, total: 0 };
  }
  if (tool === "finance.approve_expense") return { state: "approved", expenseId: args.expenseId };
  if (tool === "finance.escalate_expense") {
    return { state: "escalated", expenseId: args.expenseId, ticketId: "FIN-0" };
  }
  if (tool === "notify.submitter") return { state: "notified", expenseId: args.expenseId };

  return clone(args) ?? {};
}

function previewNextTool(input, entriesBefore, currentCall) {
  const preview = expenseWorkflow(input, new Set());
  let step = preview.next();

  for (const entry of entriesBefore) {
    if (step.done) return undefined;
    step = preview.next(clone(entry.resumeValue));
  }

  if (step.done || step.value.kind !== "tool" || step.value.tool !== currentCall.tool) {
    return undefined;
  }

  step = preview.next(syntheticForReorder(currentCall.tool, currentCall.arguments, entriesBefore));
  while (!step.done && step.value.kind === "confirm") {
    step = preview.next(undefined);
  }

  return !step.done && step.value.kind === "tool" ? step.value : undefined;
}

function valuesBefore(evidence, sequence) {
  const values = [];
  for (const event of evidence) {
    if (event.sequence >= sequence) break;
    if (event.arguments !== undefined) values.push(...collectScalars(event.arguments));
    if (event.result !== undefined) values.push(...collectScalars(event.result));
    if (event.output !== undefined) values.push(...collectScalars(event.output));
  }
  return values;
}

function isFilterKey(key) {
  return key === "department";
}

function buildYieldEntries(evidence, resultByCallId) {
  const entries = [];
  let toolIndex = 0;
  for (const event of evidence) {
    if (event.type === "tool_call") {
      toolIndex += 1;
      entries.push({
        kind: "tool",
        index: toolIndex,
        tool: event.tool,
        arguments: event.arguments,
        resumeValue: resultByCallId.get(event.callId)?.result
      });
    }
    if (event.type === "confirmation") {
      entries.push({ kind: "confirm", tool: event.tool, resumeValue: undefined });
    }
  }
  return entries;
}

function entriesBeforeTool(entries, index) {
  const result = [];
  for (const entry of entries) {
    if (entry.kind === "tool" && entry.index === index) break;
    result.push(entry);
  }
  return result;
}

function reconstructInput(evidence, calls) {
  const policy = calls.find((call) => call.tool === "finance.get_policy");
  const listing = calls.find((call) => call.tool === "finance.list_pending");
  const confirmation = evidence.find(
    (event) => event.type === "confirmation" && event.tool === "finance.escalate_expense"
  );

  return {
    message: "Review this cycle's pending expenses for the department.",
    data: {
      department: policy?.arguments?.department ?? listing?.arguments?.department,
      approveEscalations: Boolean(confirmation)
    }
  };
}

function discover() {
  const baseline = runContract(CONTRACT);
  const evidence = baseline.report?.evidence ?? [];
  const resultByCallId = new Map(
    evidence
      .filter((event) => event.type === "tool_result")
      .map((event) => [event.callId, event])
  );
  const calls = evidence
    .filter((event) => event.type === "tool_call")
    .map((event, offset) => ({
      index: offset + 1,
      callId: event.callId,
      tool: event.tool,
      arguments: event.arguments,
      sequence: event.sequence,
      result: resultByCallId.get(event.callId)?.result
    }));

  return {
    baseline,
    evidence,
    calls,
    resultByCallId,
    entries: buildYieldEntries(evidence, resultByCallId),
    input: reconstructInput(evidence, calls)
  };
}

// The expense example has no MCP tool manifest to consult. The side-effect
// boundary still matters: adding an extra read is not a real extra decision, so it
// is excluded for the same reason readOnlyHint excluded it in the source domain.
function readOnlyTools() {
  return new Set(["finance.get_policy", "finance.list_pending", "finance.fetch_receipt"]);
}

function leafPaths(value, prefix = "") {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [prefix];
  }
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, childValue]) =>
      leafPaths(childValue, prefix === "" ? key : `${prefix}.${key}`)
    );
  }
  return prefix === "" ? [] : [prefix];
}

function enumerateMutations(discovery) {
  const mutations = [];

  for (const call of discovery.calls) {
    mutations.push({ id: `drop-call:${call.index}`, operator: "drop-call", index: call.index });
  }

  for (const call of discovery.calls.slice(0, -1)) {
    const nextCall = discovery.calls[call.index];
    const entriesBefore = entriesBeforeTool(discovery.entries, call.index);
    const preview = previewNextTool(discovery.input, entriesBefore, call);
    if (preview?.tool === nextCall.tool) {
      mutations.push({ id: `reorder:${call.index}`, operator: "reorder", index: call.index });
    }
  }

  for (const call of discovery.calls) {
    const args = call.arguments ?? {};
    const seenValues = valuesBefore(discovery.evidence, call.sequence);
    for (const key of Object.keys(args)) {
      if (replacementFor(key, args[key], seenValues) !== undefined) {
        mutations.push({ id: `swap-arg:${call.index}:${key}`, operator: "swap-arg", index: call.index, key });
      }
      if (isFilterKey(key)) {
        mutations.push({ id: `widen-filter:${call.index}:${key}`, operator: "widen-filter", index: call.index, key });
      }
    }
  }

  const previousResultsByTool = new Map();
  for (const call of discovery.calls) {
    const previous = previousResultsByTool.get(call.tool) ?? [];
    if (previous.length > 0 && !sameValue(previous[0], call.result)) {
      mutations.push({ id: `stale-result:${call.index}`, operator: "stale-result", index: call.index });
    }
    previous.push(clone(call.result));
    previousResultsByTool.set(call.tool, previous);
  }

  // Every operator above perturbs how a call was made or whether it happened.
  // None perturbs what the agent said afterwards, so a contract could drop every
  // correlation between action and report and still score the same. These two
  // close that gap from both directions: the report diverging from the actions,
  // and an action taken on a record the selection policy never admitted.
  const baselineOutput =
    discovery.evidence.find((event) => event.type === "final")?.output ?? {};
  for (const path of leafPaths(baselineOutput)) {
    mutations.push({ id: `misreport-outcome:${path}`, operator: "misreport-outcome", path });
  }

  const readOnly = readOnlyTools();
  for (const call of discovery.calls) {
    if (readOnly.has(call.tool)) continue;
    const seen = valuesBefore(discovery.evidence, call.sequence);
    const args = call.arguments ?? {};
    const hasUnusedSibling = Object.keys(args).some(
      (key) => replacementFor(key, args[key], seen) !== undefined
    );
    if (hasUnusedSibling) {
      mutations.push({ id: `select-extra:${call.index}`, operator: "select-extra", index: call.index });
    }
  }

  return mutations;
}

function classifyRun(result) {
  if (!result.report) {
    return { classification: "INVALID", reason: "no report", findings: [] };
  }

  const ids = findingIds(result.report);
  if (
    result.report.decision.status === "runtime_failed" ||
    result.exitCode === 2 ||
    ids.includes("runtime.execution") ||
    result.report.stderr?.includes("Mutation skipped")
  ) {
    return { classification: "INVALID", reason: result.report.decision.findings[0]?.message ?? "runtime failed", findings: ids };
  }

  // A mutant that reaches the baseline's reported outcome through the baseline's
  // multiset of tool calls has not changed observable behaviour; it has only
  // re-interleaved it. Such a mutant is evidence about nothing: leaving it alive
  // is correct, and killing it is an over-block. Counting it either way would
  // make the score a measure of the operator set rather than of the contract, so
  // it is excluded from the denominator the same way an invalid mutant is.
  if (baselineFingerprint && sameFingerprint(behaviourFingerprint(result.report), baselineFingerprint)) {
    return {
      classification: "EQUIVALENT",
      reason:
        result.exitCode === 0
          ? "behaviour preserved, correctly not blocked"
          : "behaviour preserved but the contract blocked it",
      findings: ids
    };
  }

  if (result.exitCode === 0) {
    return { classification: "SURVIVOR", reason: "contract passed", findings: ids };
  }

  return { classification: "KILLED", reason: "contract failed", findings: ids };
}

function formatFindings(findings) {
  return findings.length > 0 ? findings.join(", ") : "";
}

// Two runs are behaviourally indistinguishable when they report the same outcome
// and issue the same calls with the same arguments. Bare order is deliberately
// not part of the fingerprint: re-interleaving is exactly what is being tested
// for, and a harness that treats every reordering as a behaviour change can
// never detect an unjustified one.
//
// But "order never matters" is too strong in any domain where a decision has to
// be grounded in evidence already gathered. Approving an expense and then
// fetching the receipt produces the identical set of calls and the identical
// report, and is still a different act: the approval could not have been
// informed by a receipt that had not arrived yet.
//
// So each state-changing call carries the reads that preceded it. Equivalence is
// then directional rather than equal: a write may gain context and still be the
// same act, but a write that has lost a read it previously stood on is a
// different act. Requiring the sets to be identical would flag every harmless
// interleaving of independent records as a behaviour change.
function behaviourFingerprint(report) {
  const readOnly = readOnlyTools();
  const events = toolCalls(report);
  const describe = (event) => `${event.tool}:${JSON.stringify(event.arguments)}`;
  const calls = events.map(describe).sort();

  const readsSeen = [];
  const grounding = new Map();
  for (const event of events) {
    const described = describe(event);
    if (readOnly.has(event.tool)) {
      readsSeen.push(described);
      continue;
    }
    grounding.set(described, [...readsSeen]);
  }

  const digest = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  return {
    output: digest(finalOutput(report) ?? null),
    calls: digest(calls),
    grounding
  };
}

// `left` is the mutant, `right` the baseline. Not symmetric, by design: the
// question is whether the mutant still does what the baseline did, and losing
// evidence is the direction that matters.
function sameFingerprint(left, right) {
  if (left.output !== right.output || left.calls !== right.calls) return false;
  for (const [write, baselineReads] of right.grounding) {
    const mutantReads = left.grounding.get(write);
    if (!mutantReads) return false;
    const available = new Set(mutantReads);
    if (!baselineReads.every((read) => available.has(read))) return false;
  }
  return true;
}

const discovery = discover();
const allMutations = enumerateMutations(discovery);
const mutations = allMutations.filter((mutation) => !only || mutation.id === only);
const results = [];

if (only && mutations.length === 0) {
  console.error(`Unknown mutation id: ${only}`);
  process.exit(1);
}

const baselineFingerprint = discovery.baseline.report
  ? behaviourFingerprint(discovery.baseline.report)
  : undefined;

for (const mutation of mutations) {
  const run = runContract(CONTRACT, [`--mutation=${mutation.id}`]);
  const classified = classifyRun(run);
  results.push({
    ...mutation,
    classification: classified.classification,
    exitCode: run.exitCode,
    findings: classified.findings,
    reason: classified.reason,
    stdout: run.stdout,
    stderr: run.stderr,
    reportPath: run.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("Evidence: "))
      ?.slice("Evidence: ".length)
      .trim()
  });
}

const killed = results.filter((result) => result.classification === "KILLED").length;
const survivors = results.filter((result) => result.classification === "SURVIVOR").length;
const invalid = results.filter((result) => result.classification === "INVALID").length;
const equivalent = results.filter((result) => result.classification === "EQUIVALENT");
const overBlocked = equivalent.filter((result) => result.exitCode !== 0);
const denominator = killed + survivors;
const score = denominator === 0 ? 0 : (killed / denominator) * 100;

console.log("| Mutation | Result | Exit | Findings |");
console.log("| --- | --- | --- | --- |");
for (const result of results) {
  console.log(
    `| \`${result.id}\` | ${result.classification} | ${result.exitCode} | ${formatFindings(result.findings)} |`
  );
}
console.log("");
console.log(
  `Mutation score: ${score.toFixed(1)}% (${killed} killed, ${survivors} survivors, ${invalid} invalid and ${equivalent.length} behaviour-preserving excluded).`
);
if (overBlocked.length > 0) {
  console.log(
    `\nOver-blocked ${overBlocked.length} behaviour-preserving mutant(s). Each is a false positive the corpus should also price:`
  );
  for (const result of overBlocked) {
    console.log(`  ${result.id}: ${formatFindings(result.findings)}`);
  }
}

writeFileSync(
  resolve(domainRoot, "mutation-report.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      contract: CONTRACT,
      baseline: {
        exitCode: discovery.baseline.exitCode,
        status: discovery.baseline.report?.decision.status,
        toolCalls: discovery.calls.length
      },
      summary: {
        generated: results.length,
        scorable: denominator,
        killed,
        survivors,
        invalid,
        equivalent: equivalent.length,
        excluded: equivalent.length,
        overBlocked: overBlocked.length,
        score
      },
      mutations: results
    },
    null,
    2
  )}\n`,
  "utf8"
);
