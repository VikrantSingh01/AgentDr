# Agent Doctor Technical Reference

This document contains implementation detail for contributors and platform
teams. Start with the [README](../README.md) for the product overview.

## Execution model

Every run follows:

```text
load -> execute -> capture -> evaluate -> report
```

The child agent communicates with Agent Doctor over JSON Lines. Agent Doctor
sends `run_start` and `tool_result`; the agent emits `tool_call`,
`confirmation`, and `final` events. Call IDs must be unique and calls are
sequential: an agent must observe a pending result before another action.

Runtime guardrails cap child stdout/stderr at 1 MiB each and evidence at 10,000
events. The hard timeout starts before MCP discovery and covers the entire
execute phase. POSIX process groups receive graceful then forced termination;
the Windows fallback attempts graceful then forced termination of the direct
child only and does not guarantee descendant cleanup.

## Scenario contract

Scenarios are strict YAML or JSON validated against JSON Schema Draft 2020-12.
The source schema is [src/scenario-schema.ts](../src/scenario-schema.ts), and the
published schema is generated at
[schema/scenario-0.1.json](../schema/scenario-0.1.json).

Current deterministic assertions include:

- required and forbidden tools;
- ordered tool subsequences, run-wide and per-record precedence rules, run-wide
  maximum calls, and per-tool call floors and ceilings;
- argument subset and JSON Schema validation, optionally scoped to one call;
- derived argument equality against values observed in earlier tool results,
  optionally scoped to one call of the referenced tool, joined by producing
  arguments or results, and checked with numeric or disjunctive criteria;
- one-use, tool-scoped or exact-argument-bound confirmation before protected calls;
- optional pre-dispatch enforcement for forbidden and confirmation-protected calls;
- semantic checks for core policy contradictions, enforcement reachability,
  budget reachability, and fixture reachability;
- final status, output subset, and output schema;
- whole-run duration;
- MCP capability and tool snapshot drift;
- MCP tool error, completed-call latency, and serialized result-byte budgets.

## Conditional obligations

A `required` list is an obligation without a scope. Demanding every tool in every
run means the contract fits only the world it was recorded in: a week with no
aged bugs, or a frozen rollout, is reported as a failure even though doing
nothing was correct.

An entry may instead be an object carrying a condition over the agent's final
output:

```yaml
expect:
  tools:
    required:
      - ado.query_untriaged_bugs
      - tool: teams.post_escalation
        when:
          outcomePath: escalatedBugIds
          nonEmpty: true
      - tool: ecs.advance_rollout_ring
        when:
          outcomePath: ringAdvance.attempted
          equals: true
```

A condition may also be a disjunction. In the expense steward, notifying the
submitter is owed when the final report contains either approved expenses or
escalated expenses:

```yaml
expect:
  tools:
    required:
      - tool: notify.submitter
        when:
          $anyOf:
            - outcomePath: approved
              nonEmpty: true
            - outcomePath: escalated
              nonEmpty: true
```

The `$anyOf` object is the condition. It holds when any branch holds, and each
branch is evaluated with the same condition vocabulary, so branches may use
`equals`, `nonEmpty`, or nested `$anyOf`. If any branch reads a path that is not
present in the final report, the condition is unresolved and reports
`tool.condition_unresolved`; the missing branch is not quietly treated as false.

The relationship is a biconditional. When the condition holds and the tool was
not called, the finding is `tool.required_when`. When the condition does not hold
and the tool *was* called, the finding is `tool.forbidden_when`. An agent that
takes a consequential action and then reports that it did not is diverging from
its own account, which is a defect in its own right and not merely a relaxed
obligation.

Choose the conditioning path with care. A condition that reads the agent's
verdict about whether it acted can be escaped by declining to act and reporting
so. Anchor it to something derived from observed data instead: `escalatedBugIds`
is computed from the backlog and stays non-empty even when the agent skips the
escalation, whereas `escalated` does not.

If the referenced path is absent from the final output, the finding is
`tool.condition_unresolved`. A condition the harness could not evaluate is never
a pass. Scenario linting rejects a tool listed both unconditionally and
conditionally, a leaf condition declaring neither `equals` nor `nonEmpty`, a leaf
condition declaring both, and `nonEmpty: false`, which states no condition at
all. For conditional `$anyOf`, linting rejects fewer than two alternatives and a
condition object that combines `$anyOf` with `outcomePath`. Schema validation
also rejects unknown condition properties.

## Ordering scope and correlated precedence

A precedence rule says one call depends on another. By default it reads as a
statement about every pair: every `before` call must precede every `after` call.
That reading also forbids calling `before` again *after* the action, which is how
a careful agent verifies what it just did. `scope: first` narrows the rule to the
obligation that was actually intended: the first action must be informed:

```yaml
expect:
  tools:
    precedence:
      - before: ecs.get_rollout_status
        after: ecs.advance_rollout_ring
        scope: first
```

Under `scope: first`, reading the status, advancing the ring, then reading the
status again passes. Under the default it reports `tool.precedence`. Advancing
before ever reading still reports under both.

In both scopes, an `after` call with no `before` call anywhere in the run reports
`tool.precedence_missing`. Reading that case as vacuously true would let through
exactly the behaviour the rule exists to prevent: the dependent action ran and
its prerequisite never happened at all.

Some dependencies are per record rather than per tool. The expense steward may
fetch a receipt for one claim and approve another claim that never needed a
receipt. A global `fetch_receipt before approve_expense` rule would either demand
receipts for records below the threshold or let a receipt for one expense justify
an action on another. `correlate` makes the ordering key explicit:

```yaml
expect:
  tools:
    precedence:
      - before: finance.fetch_receipt
        after: finance.approve_expense
        correlate: [expenseId]
      - before: finance.fetch_receipt
        after: finance.escalate_expense
        correlate: [expenseId]
```

For each path in `correlate`, the evaluator reads that argument path from both
the `before` and `after` calls and builds a tuple key. An `after` call reports
`tool.precedence` only when a `before` call for the same key exists but appears
later. If no prerequisite call was ever gathered for that key, the rule is
vacuous for that record. Whether the prerequisite was required at all belongs in
argument correlations or other policy checks; correlated precedence only orders
evidence the agent chose to gather. A call missing one of the correlated argument
paths is outside that per-record check.

`correlate` cannot be combined with `scope`, because a per-record rule already
has one first prerequisite per key. Scenario linting rejects that combination,
duplicate paths inside one `correlate` list, duplicate precedence rules with the
same `before`, `after`, and `correlate` tuple, self-ordering rules, opposing
rules for the same tuple, rules contradicted by `expect.tools.order`, and a
`before` tool that is forbidden. Schema validation requires at least one
non-empty correlate path.

## Publishing the output contract

An agent cannot satisfy an output shape it was never shown. In the Copilot
replay, the agent's report was complete and correct in substance and used its own
key names, `escalated.bugIds` where the contract wanted `escalatedBugIds` and
`ringAdvance.to` where it wanted `toRing`, then was failed for vocabulary the
prompt never disclosed.

`agentdoctor interface <contract>` emits that vocabulary as prompt-ready text:

```
agentdoctor interface contracts/contract.yml
```

It collects every path the contract reads out of the final report, which is more
than the schema states. Conditional obligations read `when.outcomePath`, call
budgets read `callsMatchOutcome`, and argument expectations read `$fromOutcome`
references. None of those appear in `expect.outcome.schema` unless someone also
wrote them there, so the output names the ones that do not:

```
The schema does not require `escalatedBugIds`, `ringAdvance.fromRing`,
`ringAdvance.toRing`, so an agent reading the schema alone would not know to
report them.
```

That list is also a review signal for the contract itself. A path read but never
declared is an obligation the contract holds the agent to in private.

## Finding causality

A contract's `expect.outcome.schema` is its definition of a well-formed report.
When the report does not satisfy it, every expectation that reads a path out of
that report fails for the same reason: conditional obligations cannot resolve
their condition, `callsMatchOutcome` cannot find its array, `$fromOutcome`
references cannot resolve, and `outcome.match` cannot match.

Those findings carry `causedBy: "outcome.output_schema"`. Nothing is suppressed:
every finding is still reported, severities are unchanged, and the exit code is
unchanged. What changes is that the terminal output prints consequences beneath
the failure they follow from, so a run with one malformed report is described as
one problem rather than seven:

```
ERROR Final output failed JSON Schema validation [evidence #61]
  3 further finding(s) follow from this:
    ERROR Conditional requirement for teams.post_escalation reads final output path escalatedBugIds, which was not reported
    ERROR Arguments for ecs.advance_rollout_ring reference a prior result that was not observed: $fromOutcome.ringAdvance.fromRing
    ERROR Final output did not contain the expected values
```

`tool.arguments_reference_unresolved` is attributed only when the unresolved
reference is a `$fromOutcome`. A `$fromResult` reference reads a tool result, not
the report, so it is an independent finding.

## Scoped expectations

Run-wide expectations overfit or under-constrain whenever a tool is called more
than once. Two selectors narrow them.

`expect.tools.budgets` bounds one tool independently of the run budget. A floor
catches a deleted call that `required` still considers satisfied, and a ceiling
catches repetition that a loose run budget would absorb:

```yaml
expect:
  tools:
    maxCalls: 6
    budgets:
      - tool: ado.get_area_owner
        minCalls: 2
        maxCalls: 2
      - tool: ado.update_work_item
        minCalls: 2
```

`callIndex` selects a single zero-based, per-tool call. It is available on an
argument expectation and inside `$fromResult`, so both sides of a derived
argument can be pinned to the same iteration:

```yaml
expect:
  tools:
    arguments:
      - tool: ado.update_work_item
        callIndex: 1
        match:
          assignedTo:
            $fromResult:
              tool: ado.get_area_owner
              path: owner
              callIndex: 1
```

Without the selectors, an argument expectation applies to every call of the tool
and `$fromResult` matches any earlier result of the referenced tool. That is
deliberately permissive: when a tool returns different correct answers across
calls, an unscoped reference cannot distinguish the right answer from the wrong
one.

Neither selector can pass vacuously. An argument expectation whose `callIndex`
matches no observed call reports `tool.arguments_call_missing`, and a
`$fromResult` whose `callIndex` resolves to nothing reports
`tool.arguments_reference_unresolved`. The linter rejects a selector that a
declared ceiling can never reach, a floor above its own ceiling, a floor on a
forbidden tool, a zero ceiling on a required tool, floors that together exceed
the run budget, and a ceiling the declared order already exceeds.

`tool.min_calls_per_tool` and `tool.arguments_call_missing` are excluded from
partial-trace evaluation, because a truncated run cannot prove that a later call
never happened.

## Fixture replay

Fixture values can be inline scalars/objects or file references:

```yaml
fixtures:
  records.lookup:
    found: true
  project.get_release_status:
    $file: fixtures/release.json
```

Repeated calls can use ordered `$cases`:

```yaml
fixtures:
  records.lookup:
    $cases:
      - callIndex: 0
        arguments: { project: Apollo }
        result: { page: 1, next: true }
      - callIndex: 1
        arguments: { project: Apollo }
        result:
          $file: fixtures/page-2.json
```

Cases are tested top to bottom. `callIndex` is zero-based per tool and
`arguments` uses deterministic subset matching. Both selectors may be combined.
A result-only case is a catch-all and must be last. The loader also rejects
duplicate selectors and broader earlier cases that would shadow later cases.

An unmatched call is answered with a tool error rather than aborting the run,
and reports `fixture.unmatched_call`. It is never a success-shaped fallback: the
run still fails. Aborting instead would be worse than useless, because a real
agent occasionally calls a tool with arguments no fixture anticipated, and
stopping there switches the instrument off at exactly that point and hides every
defect later in the trace. That is not hypothetical: replaying a recorded
Copilot run against an unmodified contract originally produced a single runtime
failure; once the miss became non-fatal the same trace surfaced a critical
unconfirmed production ring advance and a skipped rollout ring that had been
masked. In the reference suite the change also moved four mutants out of the
"invalid" bucket, all of which are killed, taking the mutation score from 96.7
to 97.1 percent with nothing excluded as invalid. Those were the numbers at the
time; the corpus has grown two operators since and the current score is 98.1
percent. A same-mutants, same-fixtures negative control that replaces only the
`expect` block scores 3.8 percent (2 killed, 51 survivors / 53 scorable), so the
current score is not explained by corpus construction alone.

Fixture replay runs the adapter live but replaces only responses to tool calls
emitted through Agent Doctor's JSONL protocol. It is not recorded full-run
playback, does not intercept arbitrary child-process side effects, and does not
make a model deterministic.

## MCP stdio backend

The MCP backend uses pinned official SDK v2 packages:

```text
@modelcontextprotocol/client 2.0.0-beta.5
@modelcontextprotocol/server 2.0.0-beta.5
```

Startup performs initialize and paginated `tools/list` under one absolute
deadline and `AbortSignal`. Calls use `tools/call` with an independent request
deadline. The proxy records:

- server name/version and negotiated capabilities;
- tool name/title/description/icons;
- input and output schemas;
- annotations, execution metadata, and `_meta`;
- call arguments, decoded result, error state, duration, and serialized SDK
  result bytes.

`resultBytes` is not raw wire size. It is the UTF-8 byte length of the serialized
SDK call result before decoding or redaction.

### Discovery commands

```bash
agentdoctor mcp inspect -- node server.mjs
agentdoctor mcp snapshot tools.json -- node server.mjs
```

Snapshot comparison is exact after canonicalization. Tool order does not
matter, but names must be unique. Object-key order is ignored. Only actual
input/output schemas normalize the order-insensitive `required`, `enum`, and
`type` arrays; metadata and capability arrays remain ordered.

## MCP result handling

Agent Doctor keeps structured and unstructured MCP content when they carry
different information. A metadata-free text block that exactly mirrors
`structuredContent` can collapse to the structured value. Annotations, mixed
content, and top-level metadata preserve the full envelope.

Tool-level `isError` results and protocol-level errors are distinct. Both leave
inspectable evidence, while protocol/runtime failures normally exit `2`.

## Custom tool backends

The package root exports `runAgentDoctor`, `ToolBackendFactory`, `ToolBackend`,
the report and evidence types, and `createRedactor`. A custom backend lets a host
route protocol-mediated tool calls to a transport other than fixtures or MCP:

```typescript
import { runAgentDoctor, type ToolBackendFactory } from "agentdoctor";

const backendFactory: ToolBackendFactory = ({ scenario, fixtures, cwd }) => ({
  redaction: { keys: ["accessToken"] },
  async start(timeoutMs) {
    return [];
  },
  async call(tool, argumentsValue) {
    return {
      result: await dispatch(tool, argumentsValue),
      source: "custom",
      durationMs: 0,
      resultBytes: 0
    };
  },
  async close() {}
});

await runAgentDoctor({
  scenarioPath: "contract.yml",
  command: ["node", "agent.mjs"],
  toolBackendFactory: backendFactory
});
```

The factory is called once after scenario loading. It receives deeply read-only,
frozen snapshots of the validated scenario and fully resolved fixtures, plus the
absolute working directory. Mutating those snapshots cannot alter the
authoritative contract or evidence evaluation. The factory must return a backend
synchronously so asynchronous initialization stays inside the timed execution
lifecycle. It must not acquire resources or include sensitive values in thrown
errors before returning the descriptor, because no accepted backend exists yet
to own cleanup or redaction. The backend has three lifecycle methods and one
optional privacy setting:

| Method | Contract |
|---|---|
| `start(timeoutMs)` | Perform asynchronous setup before the child starts. The implementation must honor the supplied hard timeout. Return `[]` for custom transports; only validated `mcp_discovery` events are accepted as startup evidence. |
| `call(tool, argumentsValue)` | Dispatch one authorized call and return its adapter payload, evidence metadata, source, duration, and serialized byte count. Calls are sequential. |
| `close()` | Release resources once after startup, including agent, authorization, and startup failures. A cleanup failure becomes a runtime finding while preserving captured evidence. |
| `redaction` | Optional key-based `RedactionOptions` applied by Agent Doctor to diagnostics and the complete report after evaluation. Structural report keys are rejected. |

`ToolBackendCallResult.result` is sent to the agent adapter. Optional
`evidenceResult` replaces it in `tool_result` evidence, so it is also the value
seen by `$fromResult` and other evaluators. Use it when the adapter needs a field
that the evidence model must never retain. If an evaluator must inspect a field
but the persisted report must redact it, omit `evidenceResult` and declare the
field in `redaction.keys` instead. Evaluation then sees the raw value and
persistence sees the sanitized copy. Use the exported `createRedactor` with the
same options when constructing a sanitized `evidenceResult`.

Agent Doctor owns report redaction rather than accepting an arbitrary report
transform. Keys such as `decision`, `status`, `findings`, `severity`,
`evidence`, and lifecycle fields are reserved and rejected during backend
setup. Agent Doctor snapshots accepted options before `start`, so later mutation
cannot bypass validation. This makes the rule that a backend cannot rewrite a
verdict enforceable.

Set `isError: true` for a completed tool call that returned an application-level
error. Throw from `call` only for a transport or runtime failure that should
terminate execution and produce exit `2`. The `source` value is a stable label
in evidence; MCP-only latency, response-size, discovery, and schema checks do
not apply to a custom source.

Setting `toolBackendFactory` replaces all automatic fixture dispatch. The
resolved fixture map in the factory context is available for an intentional
fallback, but Agent Doctor does not consult it after a custom backend is chosen.
Custom backends and `scenario.mcp` are mutually exclusive because otherwise a
run could silently skip configured discovery and conformance checks.

Pre-dispatch authorization is backend-independent. A denied call produces
`requested` and `denied` evidence and never invokes `call`. This controls only
dispatch routed through the harness. Out-of-band network, filesystem,
subprocess, or native MCP activity remains outside Agent Doctor's boundary.

The backend is not an evaluator plugin. Scenario expectations remain the only
source of deterministic findings, and backend code cannot waive, downgrade, or
replace them. Startup output is runtime-validated and cannot inject tool calls,
confirmations, lifecycle states, or final outcomes. This keeps a contract
portable across fixture, MCP, and custom dispatch paths.

## Confirmation safety

Confirmation is explicit evidence:

```json
{"type":"confirmation","confirmed":true,"tool":"calendar.create_event","source":"user-dialog","arguments":{"title":"Apollo review","durationMinutes":30}}
```

It satisfies the contract for one subsequent call to the same tool. With
`expect.confirmation.bindArguments: true`, its `arguments` must exactly match the
subsequent call structurally. A
confirmation for another tool, a reused confirmation, or `confirmed: false`
does not satisfy it. This event remains adapter-attested: Agent Doctor can check
the structural argument binding but does not independently authenticate a user,
principal, tenant, issuance time, or expiry. Production adapters remain
responsible for those guarantees.

## Pre-dispatch enforcement

Set `enforcement.preDispatch: true` to check forbidden-tool and confirmation
policies before a protocol-mediated call reaches a fixture or MCP server. The
harness records `requested`, then either `authorized` and `dispatched`, or
`denied`. Successful backend completion adds `completed`; denied requests have
no dispatch, completion, or tool-result evidence.

Authorization denial fails the run with critical exit code `3`. Because the
current JSONL protocol has no negotiated denial-response event, the harness
terminates the adapter and persists partial evidence. This mode prevents only
dispatches controlled by Agent Doctor. It cannot prevent an adapter from using
network, filesystem, subprocess, native MCP, or other out-of-band capabilities.

## Trust boundaries

Scenario files can launch adapter and MCP server commands and therefore are
trusted code. Run scenarios from untrusted sources only in an appropriately
isolated environment.

Agent Doctor observes events cooperatively emitted over JSONL and MCP calls made
through its harness proxy. Observe mode evaluates after events arrive;
enforcement mode adds a pre-dispatch gate for configured, harness-mediated
calls. The runner is not a sandbox or complete side-effect monitor. The MCP path
validates server interaction through the harness; it does not exercise a child
agent's own native MCP client stack.

## Partial failures

When execution fails, Agent Doctor persists the evidence collected so far. It
retains MCP findings plus observable forbidden-tool, argument, call-budget, and
confirmation findings. Critical safety findings keep exit `3` even when a later
runtime failure also occurs.

## Redaction boundary

Evaluation uses raw in-memory evidence. Immediately before persistence,
`redactRunReport` sanitizes the complete report and returns that sanitized copy.
For custom backend runs, the backend's validated declarative redaction options
are passed through that same trusted report sanitizer.

The sanitizer handles nested values, JSON strings, common key/value diagnostic
text, split command flags, final output, stderr, and MCP diagnostics. It applies
special JSON Schema handling only at real MCP discovery schema paths, preserving
sensitive property names while removing data-bearing defaults, constants,
examples, and enums, including composed schemas.

Ordinary result data cannot impersonate discovery to gain a schema exemption.
Redaction keys that overlap report, evidence, MCP, or JSON Schema structural
vocabulary are rejected during scenario loading.

GitHub Actions annotations escape `%`, carriage return, and line feed. Human
finding lines also render newlines literally so result text cannot inject a
workflow command.

## Reports

Reports are written to:

```text
.agentdoctor/runs/<scenario-id>-<timestamp>.json
```

They include run identity, command, timing, graph transitions, ordered evidence,
decision, findings, and captured diagnostics. `agentdoctor inspect` validates the
report envelope and prints the event sequence.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Passed |
| `1` | Quality or conformance failure |
| `2` | Configuration, protocol, or runtime failure |
| `3` | Critical safety failure |

## Test and release commands

```bash
npm run check
npm run test:mcp
npm run snapshot:mcp
npm run record:mcp
npm run record:readme
npm pack --dry-run
```

CI runs Node.js 20, 22, and 24 on Windows and Ubuntu, regenerates the scenario
schema and MCP tool snapshot, runs the fixture smoke test, and validates the npm
package.

## Derived arguments

`expect.tools.arguments[].match` compares literal values by default. An argument
whose correct value is only known from an earlier tool result is bound with
`$fromResult`:

```yaml
expect:
  tools:
    arguments:
      - tool: calendar.create_event
        match:
          startsAt:
            $fromResult:
              tool: calendar.check_availability
              path: slots.0
      - tool: ecs.advance_rollout_ring
        match:
          toRing:
            $fromResult:
              tool: ecs.get_rollout_status
              path: currentRing
              sequence: [ring0, ring1, ring1_5, ring2]
              offset: 1
```

`path` is a dot path into the result, and numeric segments index arrays. The
argument must equal the referenced value in at least one `tool_result` from
`tool` recorded strictly before the call under test. "At least one" rather than
"the most recent" is deliberate, because an agent may legitimately cache a lookup
and reuse it after unrelated intervening calls.

That default is permissive when a tool returns a different correct value on each
call, since any of them satisfies the reference. `callIndex` narrows the
reference to one zero-based call of the referenced tool, which is what makes
"the owner assigned on the second update came from the second lookup"
expressible. See [Scoped expectations](#scoped-expectations).

## Correlated arguments

`callIndex` buys precision at a price: it encodes an ordering the domain may not
require. Pinning the second update to the second lookup rejects a run that
performs the same two updates in the opposite order, even though nothing in the
domain fixes that order. `where`, `whereResult`, and `find` select the producing
call by evidence instead of by position:

```yaml
expect:
  tools:
    arguments:
      - tool: ado.update_work_item
        match:
          assignedTo:
            $fromResult:
              tool: ado.get_area_owner
              path: owner
              where:
                areaPath:
                  $fromResult:
                    tool: ado.query_untriaged_bugs
                    path: bugs
                    find:
                      id:
                        $argument: id
                    select: areaPath
```

Read aloud: *the assignee on this update must be the owner returned by the
area-owner lookup for the area of the bug this update is about.*

- `where` constrains the **arguments** of the producing call. Only results whose
  originating call matches every key are considered.
- `whereResult` constrains the **result** of the producing call. Use it when the
  selector is known only after the call returns, such as a receipt lookup that
  returns whether it was verified.
- `find` selects one element from an array result, and `select` reads a path from
  that element. `select` requires `find`.
- `$argument` reads a value from the **call under test**, which is what closes
  the loop between consumer and producer.
- Criteria values may be literals, `$argument` nodes, nested `$fromResult`
  references, comparison objects, or value-position `$anyOf`, so a correlation
  can join across more than one hop.

The expense steward uses result-side selection and numeric criteria together. An
approval may target only an expense below the policy's auto-approve limit, and an
expense above the receipt threshold must have a receipt lookup whose result came
back verified:

```yaml
- tool: finance.approve_expense
  match:
    expenseId:
      $fromResult:
        tool: finance.list_pending
        path: expenses
        find:
          id:
            $argument: expenseId
          amount:
            $lessThan:
              $fromResult:
                tool: finance.get_policy
                path: autoApproveUnder
          $anyOf:
            - amount:
                $lessThan:
                  $fromResult:
                    tool: finance.get_policy
                    path: receiptRequiredOver
            - id:
                $fromResult:
                  tool: finance.fetch_receipt
                  path: expenseId
                  whereResult:
                    verified: true
        select: id
```

The comparison operators are `$lessThan`, `$atMost`, `$greaterThan`, and
`$atLeast`. They are criteria values. The subject is the value read from the
criteria path. The accepted bound forms are a literal number, `$argument`, or
`$fromResult`; reference bounds resolve through the same machinery as other
criteria values. Both subject and bound must be finite numbers. A string such as
`"100"` does not compare as 100; the criterion does not match, and a reference
with no matching candidate reports
`tool.arguments_reference_unresolved`.

The linter rejects a comparison bound that is not a number, `$argument`, or
`$fromResult`, and it rejects a comparison object that has any sibling key. A
comparison object with both `$lessThan` and `$atLeast` is invalid because the
operator must be the only property of that object. Nested `$fromResult` bounds
are validated with the same reference rules as other criteria values. An
`$argument` bound reads from the call under test.

`callIndex` cannot be combined with `where` or `whereResult`: a correlation
selects a call by key, and mixing the two would silently reintroduce the
positional constraint the correlation exists to remove. The linter rejects either
combination.

A correlation that resolves to nothing reports
`tool.arguments_reference_unresolved`. It never passes vacuously, so a join key
that is absent from the producing result is a finding, not a silent skip.

One correlated expectation replaced three `callIndex` pins in the reference
contract. Measured effect at the time: the mutation score held at 96.7% with no
kill lost, the false-positive count fell from 8 to 7, and the last remaining
over-blocked equivalent mutant cleared to zero. Both numbers have moved since,
the corpus has grown and the remaining false positives have been closed, but
the shape of that result is the point: precision improved without costing
recall.

With `sequence`, the expected value is the element `offset` positions after the
observed value inside the declared domain. This expresses ordering over argument
values, which `expect.tools.order` does not: `order` constrains tool names only.
`offset` requires `sequence` and defaults to `1`.

The reference resolves against recorded tool evidence, never against the agent's
final output, so an agent that reports one value and dispatches another is
detected rather than trusted.

A reference that cannot resolve, because the referenced tool was never called
before the call under test, the path is absent, the observed value falls outside
the declared sequence, or a declared `callIndex` selects a call that never
happened, produces
`tool.arguments_reference_unresolved`. An observation the harness could not make
is reported explicitly and is never treated as a pass. Scenario linting rejects a
reference to a forbidden tool, a reference whose target the declared `order`
places later, and a `callIndex` beyond the referenced tool's declared ceiling,
because none can ever resolve.

## Selection policies

A join criterion is a conjunction by default. Real selection policies are often
disjunctive: an expense is escalatable if it is at or above the auto-approve
limit, or if the receipt lookup came back unverified. Enumerating the ids in one
fixture would pin the contract to that fixture instead of stating the policy.

Criteria-level `$anyOf` is a key inside `where`, `whereResult`, or `find`. Its
branches are criteria objects, and it matches when any branch matches. Sibling
criteria keys still apply:

```yaml
- tool: finance.escalate_expense
  match:
    expenseId:
      $fromResult:
        tool: finance.list_pending
        path: expenses
        find:
          id:
            $argument: expenseId
          $anyOf:
            - amount:
                $atLeast:
                  $fromResult:
                    tool: finance.get_policy
                    path: autoApproveUnder
            - id:
                $fromResult:
                  tool: finance.fetch_receipt
                  path: expenseId
                  whereResult:
                    verified: false
        select: id
```

Read with the surrounding `id` key, this says: choose the pending expense whose
id is the current escalation's `expenseId`, and require either an amount at or
above the policy limit or a receipt result for that id whose `verified` flag is
false. An escalation aimed at anything else finds no matching record, so the
reference cannot resolve and `tool.arguments_reference_unresolved` is reported.
Linting rejects criteria-level `$anyOf` unless it is an array of at least two
alternatives. Each alternative is then validated as its own criteria object.

## Mutually exclusive expected values

`$anyOf` can also appear where an expected value appears. This is a different
construct from criteria-level `$anyOf`: the branches are expected values, not
criteria objects. The expense steward uses it to make a notification agree with
whichever action actually changed that expense:

```yaml
- tool: notify.submitter
  match:
    decision:
      $anyOf:
        - $fromResult:
            tool: finance.approve_expense
            path: state
            where:
              expenseId:
                $argument: expenseId
        - $fromResult:
            tool: finance.escalate_expense
            path: state
            where:
              expenseId:
                $argument: expenseId
```

In an argument or outcome `match` tree, `walk` tries each branch against the
actual value and the value matches if any branch matches. Inside result-reference
criteria, `resolveExpectedValues` handles the same shape as a value and returns
the union of the candidate sets from its branches. These are separate matchers,
and both support `$anyOf`.

The union is not a weakening. Each branch still has to resolve from real
evidence. If every branch resolves to nothing, the enclosing reference is
unresolvable and the call is reported. For an argument expectation, that report
is `tool.arguments_reference_unresolved`. A notification
for an expense that was neither approved nor escalated therefore fails instead of
passing through an empty disjunction.

For match trees, scenario linting rejects a `$anyOf` that is not an array of at
least two alternatives, and rejects a `$anyOf` object that has any sibling key.
The same check recurses into every branch, so a malformed nested disjunction is
reported before evaluation.

## Derived outcomes

`expect.outcome.match` accepts `$fromResult` on the same terms as an argument
expectation. Pinning the outcome to the values one baseline run produced makes
the contract a snapshot test: every correct run over different data is rejected,
and the literal only catches misreporting in the single world it was recorded
from. Correlating it to what the tools actually returned holds in every world and
catches the divergence in all of them:

```yaml
expect:
  outcome:
    status: completed
    match:
      rollout:
        currentRing:
          $fromResult:
            tool: ecs.get_rollout_status
            path: currentRing
```

An unresolvable reference here reports `outcome.reference_unresolved` rather than
passing.

`$fromOutcome` reads a path in the final output from inside an *argument*
expectation, which states the converse: what the agent did must agree with what
it reported doing.

```yaml
- tool: ecs.advance_rollout_ring
  match:
    fromRing:
      $fromOutcome: ringAdvance.fromRing
    toRing:
      $fromOutcome: ringAdvance.toRing
```

Writing this as an argument expectation rather than an outcome expectation is
deliberate. It is scoped to the calls that actually happened, so it says nothing
in the worlds where the action was correctly not taken, whereas the same
constraint placed in `outcome.match` would fail every such world. A missing
reported path is `tool.arguments_reference_unresolved`, never a pass. Scenario
linting rejects `$fromOutcome` inside `outcome.match`, where it would compare the
final output against itself and could never fail.

## Reported counts

Agents report how much work they did, and that number is a claim like any other.
Freezing it turns the contract into a snapshot test; leaving it unconstrained lets
an agent inflate or deflate its own workload and pass. `length: true` resolves a
`$fromResult` to the size of the collection at `path` instead of its value, so the
claim is tied to the set that was actually retrieved:

```yaml
expect:
  outcome:
    match:
      reviewed:
        $fromResult:
          tool: ado.query_untriaged_bugs
          path: bugs
          length: true
```

A count is only meaningful over a collection. Pointing `length` at an object or a
string leaves the reference unresolved rather than counting keys or characters,
which would otherwise pass for the wrong reason. `length` cannot be combined with
`sequence`, because a count has no position in a declared sequence.

## Conditional outcome expectations

Some facts about the report are only checkable in the worlds where the action
happened. Correlating a reported pull request id to the call that produced it is
correct when the agent advanced a ring, and meaningless when a policy freeze
correctly stopped it. Placed in `outcome.match`, such a correlation resolves to
nothing in every quiet world and rejects a run that was right.

`expect.outcome.when` scopes an outcome expectation to the worlds a condition
selects, using the same condition vocabulary as a conditional obligation:

```yaml
expect:
  outcome:
    status: completed
    when:
      - when:
          outcomePath: ringAdvance.attempted
          equals: true
        match:
          ringAdvance:
            pullRequestId:
              $fromResult:
                tool: ecs.advance_rollout_ring
                path: pullRequestId
```

The condition is read from the agent's own report, so it cannot be satisfied by
staying silent: reporting `attempted: true` without the matching call is already
`tool.forbidden_when`, and reporting it with a fabricated pull request id is
`outcome.output_subset`. A condition whose path is missing reports
`tool.condition_unresolved` rather than skipping the assertion it guards.

## Output shape stability

A contract judges one run at a time. That makes an entire defect class invisible:
a report whose *shape* depends on the run. Three GitHub Copilot runs against an
identical prompt and identical fixtures produced 23 paths that appeared in some
runs and not others: the ring advance reported as `ringAdvance` in two runs and
`rollout.advanceAttempt` in the third, an owner reported as `routed[].owner` then
`routed[].assignedTo`, the reviewed set as `reviewed.bugs`, `reviewed.bugIds`,
and `reviewed.untriagedBugs`. Every one of those reports is internally coherent.
The defect exists only between runs.

`--repeat N` runs the same contract N times and compares the shape of the final
report across them:

```bash
agentdoctor test contracts/contract.yml --repeat 3 -- node agent/agent.mjs
```

```
Output shape across runs
  Stable across 3 runs: 18 paths, identical in every run.
```

Each run keeps its own verdict and the worst exit code wins, so a repeat run is
never a softer gate than a single one. Instability alone raises the exit code to
1: it is a defect, but it is not a safety violation.

Two rules keep this from firing on correct behaviour:

- **Array indices are collapsed.** `routed.0.id` and `routed.1.id` both become
  `routed[].id`, and an element never contributes a path of its own. An agent
  that handles three records in one run and two in the next is doing its job, not
  changing its shape.
- **A run that never reported is excluded, not treated as empty.** Counting a
  crash as a report with no paths would mark every other path unstable and bury
  the real failure under noise it caused. Below two reporting runs, the output
  says stability was not measured rather than claiming it held.

## Current boundaries

- one JSONL child-agent adapter;
- one local MCP stdio transport;
- deterministic structural evaluation only;
- local console and JSON reports;
- no hosted service, production ingestion, HTTP adapter, or model judge;
- key-based redaction is not general DLP;
- scenario contract remains experimental before 1.0.