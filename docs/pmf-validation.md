# Agent Action Contract PMF Validation

## Current Evidence

Agent Doctor has technical feasibility evidence, not product-market fit.

The current release proves that one local contract can:

- replay repeated tool calls with argument-aware and call-index-aware fixtures;
- exercise a real MCP stdio server through the official TypeScript SDK v2;
- check tools, arguments, order, outcomes, confirmation, latency, response size,
  errors, and exact MCP capability or tool-snapshot drift;
- reject contradictory policies and unreachable fixture cases before execution;
- record requested, authorized, denied, dispatched, and completed lifecycle
  evidence;
- deny configured forbidden or unconfirmed fixture and MCP calls before harness
  dispatch;
- preserve partial evidence and return stable CI exit codes;
- sanitize configured sensitive values before report persistence.

The current README reports 140 deterministic tests across 16 files and eight
live MCP cases. Those results prove implementation quality. They do not prove
that external teams have a recurring problem, can onboard independently, will
retain scenarios, or will pay.

The first reference-agent measurement is intentionally harsher. The
`em-triage-steward` contract is measured adversarially two ways, across the full
cycle:

| Metric | Start of cycle | End of cycle |
|---|---:|---:|
| Mutation score | 58.8% (20 killed / 34 scorable) | **96.7% (29 killed, 1 survivor)** |
| Survivors | 14 | **1** |
| False positives | 7 of 8 worlds (87.5%) | **8 of 11 worlds (72.7%)** |
| Over-blocked behaviour-preserving mutants | not measured | **1** (`reorder:5`) |

The absolute false-positive count matters more than the rate alone. Across the
cycle it went 7 -> 9 -> 8: it rose before it fell, and 8 of 11 is still a poor
false-positive result. The instrument is sharp at catching real defects and
still too blunt at tolerating legitimate variation.

The mutation denominator now excludes 4 invalid mutants and 4
behaviour-preserving ones. Excluding behaviour-preserving mutants is not score
inflation: a mutant that produces a byte-identical outcome via an identical
multiset of tool calls should survive, and counting it as a miss would reward an
over-strict contract. The harness proves equivalence by hashing the outcome and
call multiset against a live baseline run, rather than trusting a label.

This is the PMF trade-off to test: recall is done on this workload, but
precision is not. Removing the global `maxCalls` ceiling, the total-order
`order` list, and the `update -> escalation` precedence rule reduced
over-blocking without losing a mutant kill.

## Beachhead Hypothesis

The strongest initial user is a platform or product team shipping an agent that
retrieves organizational data and then performs a consequential, structured
action. Initial categories are:

1. Action Closure agents that create tasks, tickets, reminders, or follow-up
   records.
2. Meeting Facilitator agents that turn discussion into approved actions.
3. Engineering Delivery agents that inspect release state and mutate delivery
   systems.
4. Teams Project agents that coordinate work across calendars, tasks, issues,
   and project records.

The team already uses pull requests, owns the agent quality gate, and has
experienced at least one failure involving tool selection, arguments, approval,
workflow order, or MCP contract drift.

The narrow promise is:

> Express the expected action workflow once, replay or exercise it in CI, deny
> configured forbidden or unconfirmed calls at the harness boundary, and
> preserve ordered evidence that explains the decision.

This promise is intentionally narrower than complete agent safety, production
observability, or sandboxing.

## Why The Wedge Changed

The original wedge focused on MCP schema and tool-call regression testing. That
remains useful, but the delivered implementation now supports a stronger action
contract:

| Earlier capability | Current capability | PMF implication |
|---|---|---|
| One fixture result per tool | Ordered cases selected by arguments and call index | Real repeated-call workflows can be represented without custom fixture-selection logic |
| Post-run confirmation finding | Optional exact argument binding and pre-dispatch denial | Teams can test both detection and bounded prevention |
| Tool call plus result evidence | Explicit request-to-completion lifecycle | Reviewers can distinguish attempted, denied, and dispatched actions |
| Schema validation only | Core semantic linting | Contradictory or unreachable scenarios fail before consuming CI time |
| MCP-focused positioning | Fixture and MCP paths share one evaluator and report | Teams can adopt cheaply, then add real transport coverage |

The PMF question is no longer only whether teams want MCP conformance checks. It
is whether they will maintain deterministic action contracts as normal release
infrastructure.

## Alternatives To Beat

- framework-specific trace inspection;
- hand-written integration tests around each agent;
- prompt snapshots and exact-text assertions;
- hosted evaluation suites that require trace upload;
- pure LLM-judge gates that are non-reproducible and expensive per run;
- pure static checks that cannot see semantic drift in grounded free-text payloads;
- manually running MCP Inspector after changes;
- approval logic embedded only in prompts or application conditionals;
- production monitoring that finds the failure after deployment.

Agent Doctor must be materially faster to author, review, and diagnose than
these alternatives. Portability and deterministic output are not sufficient if
scenario maintenance is expensive.

The differentiated product hypothesis is hybrid but contained: deterministic
checks now carry almost all assertion volume at near-zero marginal cost, while a
future local SLM handles only the measured residual semantic edge case that opts
in. Once the deterministic layer can scope an assertion to a call, to a count,
and to the data, it catches every structural defect in this workload. The single
surviving defect is `swap-arg:7:summary`, a free-text escalation summary swapped
for different prose. That edge must be local for zero egress and compliance,
grounded in existing evidence, advisory by default, auditable in the report, and
excluded from the headline mutation and false-positive metrics unless explicitly
included.

## Product Boundaries To Test In Interviews

These boundaries may be acceptable, or they may block adoption:

- the child adapter must speak the JSONL protocol;
- observation is cooperative, so out-of-band filesystem, network, subprocess,
  native MCP, and other child activity is neither comprehensively observed nor
  controlled;
- enforcement controls only calls routed through the harness;
- confirmation events are adapter-attested and can carry exact arguments, but
  authenticated identity, tenant, issuance, and expiry are not represented or
  verified;
- MCP calls are made by the harness proxy and do not test the child agent's
  native MCP client implementation;
- scenarios and their commands are trusted local code;
- the current topology is one adapter, one MCP server, and sequential calls;
- retrieval grounding, citations, multi-turn sessions, HTTP, concurrency, and
  production trace ingestion are not implemented;
- configured key-based redaction is not general data-loss prevention.

Do not hide these constraints during discovery. Measure which ones prevent a
real pilot from starting or remaining in CI.

## Problem Interview

Ask about the last incident, not desired features:

1. What agent change caused the last pre-release or production failure?
2. Which action was requested, with what arguments, and what should have
   happened?
3. Was the action read-only, mutating, or destructive?
4. How was approval represented, and what exactly did it authorize?
5. How was the failure discovered and reproduced?
6. How long did diagnosis take, and who participated?
7. What test existed before the incident? Why did it miss the failure?
8. Would a deterministic pull-request check have blocked a legitimate change?
9. Which test data and traces may not leave the developer machine or CI runner?
10. Who owns the quality gate, and who can approve a blocking policy?
11. Does the workflow repeat a tool with different arguments or use data from
    one tool in another?
12. What would make the team remove the check after two weeks?
13. Which natural-language payloads must be semantically faithful to structured
    evidence, and would the team accept a local-only advisory SLM check for them?

Do not demo Agent Doctor until the incident timeline, current workaround,
frequency, and owner are understood.

## Pilot Design

### Phase 1: Represent A Real Failure

1. Select one consequential workflow and one recent sanitized failure.
2. Record current reproduction and diagnosis time.
3. Build the thinnest JSONL adapter around existing framework callbacks.
4. Express the workflow with fixtures first.
5. Record unsupported requirements rather than extending the product during
   onboarding.

Exit criterion: the real failure is represented without a framework fork or a
model judge.

### Phase 2: Run In Observe Mode

1. Add a non-blocking pull-request check for ten pull requests.
2. Seed one known tool, argument, confirmation, or ordering regression.
3. Measure runtime, false findings, authoring effort, and diagnosis time.
4. Ask a partner engineer to maintain the scenario without project-team edits.
5. Exercise a real MCP server when the partner owns one.

Exit criterion: the team trusts the evidence enough to use it during review.

### Phase 3: Enable Selective Enforcement

1. Select one forbidden or confirmation-protected harness-mediated call.
2. Enable `enforcement.preDispatch`.
3. Verify that denial produces requested and denied evidence without dispatch,
   result, or completion.
4. Run argument-change, missing-confirmation, repeated-confirmation, and backend
   failure cases.
5. Document every action path that can bypass the harness.

Exit criterion: the team accepts the bounded enforcement claim and keeps the
gate enabled.

### Phase 4: Test Retention And Commercial Intent

1. Leave scenario ownership with the partner for the two-week pilot.
2. Ask the team to keep, remove, or expand the check.
3. Record maintenance time and every false block.
4. Ask which missing integration would unlock broader deployment.
5. Identify the budget owner and purchasing path.

Exit criterion: retained use plus explicit commercial intent.

## SLM edge validation rule

Do not add a model to improve-looking metrics before the next deterministic
contract is fixed. The SLM layer is designed, not shipped. The vocabulary gaps
from the previous review are now largely closed by call-indexed arguments,
call-indexed `$fromResult`, per-tool budgets, `callsMatchOutcome`, `distinct`,
and strict `precedence`. The remaining deterministic gap is a relational join:
being able to say "this argument must equal the result of the lookup that
corresponds to this record," correlated by a shared key rather than by call
position. That join, not the SLM, is the next precision fix aimed at the 8 false
positives and the 1 over-blocked equivalent mutant. It is not a recall fix;
recall is done on this workload.

The first acceptable SLM pilot follows that join. It is non-blocking,
local-only, and limited to semantic faithfulness of text to structured evidence,
such as a summary count matching `bugIds`.

If evaluated, SLM findings must be reported as a distinct severity with model id,
prompt inputs, and raw response. They must not change mutation score or corpus
false-positive rate unless the experiment explicitly opts those metrics in, and
no-model availability must report `not_evaluated` rather than pass.

## Scorecard

| Signal | Continue threshold |
|---|---:|
| Problem interviews | 6 of 10 report at least two relevant failures in the previous six months |
| Beachhead concentration | 4 of those 6 fit Action Closure, Facilitator, Engineering Delivery, or Teams Project workflows |
| Scenario expressiveness | 4 real failures represented without framework forks |
| Initial authoring | Median under 30 minutes, including the adapter |
| Additional scenario authoring | Median under 15 minutes |
| Independent onboarding | End-to-end under 60 minutes without project-team edits |
| Pull-request retention | 2 teams keep checks after the two-week pilot |
| Pilot precision | No critical false block across at least 20 pull requests and 50 protected or policy-relevant requests |
| Diagnosis value | Median time to identify the failing event under 10 minutes across at least 4 seeded or real failures |
| Unseeded value | At least one meaningful real regression caught |
| Enforcement adoption | 1 team keeps a bounded pre-dispatch policy enabled |
| Maintenance | Median partner-owned scenario update under 15 minutes, with no update over 60 minutes |
| Commercial intent | Within 30 days after the pilot, 1 buyer confirms funding and a dated purchasing step, or signs a paid design-partner agreement |

A critical false block is a critical finding that both the partner workflow
owner and Agent Doctor reviewer agree rejected compliant intended behavior.
Disagreements remain unresolved findings and must be reported separately. Pilot
precision must include the total number of pull requests, tool requests,
protected requests, policy-relevant requests, denials, and adjudicated false
blocks.

## Evidence To Capture

For every pilot, record:

- agent category, framework, backend, and workflow type;
- prior incident and current workaround;
- adapter and first-scenario authoring time;
- number of scenario changes per pull request;
- seeded and unseeded findings;
- false blocks, adjudication outcomes, disagreements, and ignored findings;
- total tool, protected, policy-relevant, denied, and dispatched requests;
- diagnosis time before and after Agent Doctor;
- unsupported assertions or topology requirements;
- observe-mode and enforcement-mode usage;
- whether the partner independently changed the contract;
- retention decision and reason;
- buyer-confirmed funding, dated purchasing step, or paid agreement.

Use sanitized data. Do not upload partner reports without explicit approval.

## Highest-Value Discovery Questions

The next design-partner conversations should determine:

1. Is the strongest pain approval-bound mutation, MCP drift, or workflow
   regression?
2. Is the JSONL adapter cost acceptable, or is a native Microsoft Agents SDK,
   WorkIQ, or framework adapter required before evaluation?
3. Do teams need cross-tool data references before repeated-call fixtures are
   useful?
4. Which identity and approval properties must be independently verified?
5. Does the buyer sit in the agent product team, platform engineering,
   developer experience, security, or compliance?
6. Will teams accept a local JSON report, or do they require JUnit, SARIF, HTML,
   or hosted trend reporting?

## Decision

- **Proceed:** every scorecard threshold is met, including buyer-confirmed
  commercial intent within 30 days.
- **Revise:** pain and retention are real, but adapter cost, expressiveness, or
  evidence quality prevents broader adoption.
- **Narrow:** one agent category retains the product while others require
  different semantics or integrations.
- **Stop:** teams prefer existing tests, remove the check after the pilot, or
  cannot identify an owner for the gate.

No download, star, seeded test, internal benchmark, test count, or enforcement
demo should be reported as product-market fit.
