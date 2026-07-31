// False-positive corpus for the expense-steward reference domain.
//
// A mutation score on its own is unanchored: a contract that fails everything
// scores perfectly. This asks the opposite question — what correct behaviour
// does the contract wrongly reject.
//
// Each case is a neighbouring world, not a different agent. The workflow is the
// same frozen logic behaving correctly for the data it is given, so any non-zero
// exit is a defect in the contract or in the contract language, never in the
// agent.
//
// The contract is copied verbatim at run time and fixture files are layered on
// top, so a corpus case can never silently drift from the contract actually
// being measured.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  domainRoot,
  contractPath,
  runContract,
  toolCalls,
  findingIds,
  finalOutput,
  finalStatus
} from "./lib/harness.mjs";

const corpusRoot = resolve(domainRoot, "corpus");
const defaultFixtures = resolve(domainRoot, "fixtures");

const only = process.argv
  .find((argument) => argument.startsWith("--only="))
  ?.slice("--only=".length);

// A behaviour-preserving world is one where the agent reaches the same reported
// outcome through the same multiset of calls, only differently interleaved.
// Hashing both lets the runner prove the claim rather than take the case's word
// for it, so a case cannot smuggle in changed behaviour and count the resulting
// block as a false positive.
function behaviourFingerprint(report) {
  const calls = toolCalls(report)
    .map((event) => `${event.tool}:${JSON.stringify(event.arguments)}`)
    .sort();
  const digest = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  return { output: digest(finalOutput(report) ?? null), calls: digest(calls) };
}

function loadCases() {
  return readdirSync(corpusRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(readFileSync(join(corpusRoot, entry.name, "case.json"), "utf8")))
    .filter((testCase) => only === undefined || testCase.id === only)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function materialise(testCase) {
  const directory = mkdtempSync(join(tmpdir(), `expense-corpus-${testCase.id}-`));
  mkdirSync(join(directory, "fixtures"), { recursive: true });
  cpSync(contractPath, join(directory, "contract.yml"));
  cpSync(defaultFixtures, join(directory, "fixtures"), { recursive: true });

  const overrides = join(corpusRoot, testCase.id, "fixtures");
  if (existsSync(overrides)) {
    cpSync(overrides, join(directory, "fixtures"), { recursive: true });
  }
  return directory;
}

// Confirms the agent actually did the correct thing for this world before the
// run is allowed to count as a false positive. Without this guard a genuine
// agent bug would be published as a contract defect.
function checkAgentBehaviour(report, expectations) {
  if (report === undefined) return ["no evidence report was produced"];

  const violations = [];
  const called = new Set(toolCalls(report).map((event) => event.tool));

  for (const tool of expectations.toolsCalled ?? []) {
    if (!called.has(tool)) violations.push(`expected the agent to call ${tool}`);
  }
  for (const tool of expectations.toolsNotCalled ?? []) {
    if (called.has(tool)) violations.push(`expected the agent not to call ${tool}`);
  }
  for (const [tool, count] of Object.entries(expectations.callCounts ?? {})) {
    const actual = toolCalls(report, tool).length;
    if (actual !== count) violations.push(`expected ${count} call(s) to ${tool}, saw ${actual}`);
  }

  const output = finalOutput(report) ?? {};
  for (const [path, count] of Object.entries(expectations.outcomeCounts ?? {})) {
    const value = output[path];
    const actual = Array.isArray(value) ? value.length : undefined;
    if (actual !== count) {
      violations.push(`expected ${count} entr(ies) in ${path}, saw ${actual ?? "none"}`);
    }
  }

  if (expectations.finalStatus !== undefined && finalStatus(report) !== expectations.finalStatus) {
    violations.push(`expected final status ${expectations.finalStatus}, saw ${finalStatus(report)}`);
  }

  return violations;
}

function classify(exitCode, violations) {
  if (violations.length > 0) return "INVALID";
  if (exitCode === 0) return "ACCEPTED";
  return "FALSE POSITIVE";
}

const cases = loadCases();
const results = [];

// Recorded once from the untouched world, so an equivalence claim is checked
// against observed behaviour rather than against a hand-written expectation.
const baselineRun = runContract(contractPath, []);
const baselineFingerprint = baselineRun.report
  ? behaviourFingerprint(baselineRun.report)
  : undefined;

for (const testCase of cases) {
  const directory = materialise(testCase);
  try {
    const run = runContract(join(directory, "contract.yml"), testCase.agentArgs ?? []);
    const violations = checkAgentBehaviour(run.report, testCase.expectAgent ?? {});

    if (testCase.equivalentToBaseline) {
      if (!baselineFingerprint) {
        violations.push("baseline behaviour could not be recorded");
      } else if (!run.report) {
        violations.push("no evidence report was produced");
      } else {
        const observed = behaviourFingerprint(run.report);
        if (observed.output !== baselineFingerprint.output) {
          violations.push(
            "claimed to preserve behaviour but the reported outcome differs from the baseline"
          );
        }
        if (observed.calls !== baselineFingerprint.calls) {
          violations.push(
            "claimed to preserve behaviour but the set of tool calls differs from the baseline"
          );
        }
      }
    }

    results.push({
      id: testCase.id,
      title: testCase.title,
      verdict: classify(run.exitCode, violations),
      exitCode: run.exitCode,
      findings: run.report ? [...new Set(findingIds(run.report))] : [],
      violations,
      predicted: testCase.predictedVerdict
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const accepted = results.filter((result) => result.verdict === "ACCEPTED");
const falsePositives = results.filter((result) => result.verdict === "FALSE POSITIVE");
const invalid = results.filter((result) => result.verdict === "INVALID");

console.log("| Case | Verdict | Exit | Findings |");
console.log("| --- | --- | --- | --- |");
for (const result of results) {
  const detail =
    result.verdict === "INVALID" ? result.violations.join("; ") : result.findings.join(", ");
  console.log(`| \`${result.id}\` | ${result.verdict} | ${result.exitCode} | ${detail} |`);
}

const scored = results.length - invalid.length;
const rate = scored === 0 ? 0 : (falsePositives.length / scored) * 100;

console.log(
  `\nFalse-positive rate: ${rate.toFixed(1)}% (${falsePositives.length} of ${scored} correct-behaviour worlds rejected, ${invalid.length} invalid excluded).`
);

const surprises = results.filter(
  (result) =>
    result.predicted !== undefined &&
    result.verdict.toLowerCase().replace(" ", "-") !== result.predicted
);
if (surprises.length > 0) {
  console.log("\nCases that did not match their predicted verdict:");
  for (const surprise of surprises) {
    console.log(`  ${surprise.id}: predicted ${surprise.predicted}, observed ${surprise.verdict}`);
  }
}

writeFileSync(
  resolve(domainRoot, "corpus-report.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      contract: "examples/expense-steward/contract.yml",
      summary: {
        accepted: accepted.length,
        falsePositives: falsePositives.length,
        invalid: invalid.length,
        falsePositiveRate: rate
      },
      cases: results
    },
    undefined,
    2
  )}\n`
);

// An invalid case means the world could not be measured, which is a broken
// instrument rather than a passing result. Only a clean sweep exits 0.
process.exitCode = falsePositives.length === 0 && invalid.length === 0 ? 0 : 1;
