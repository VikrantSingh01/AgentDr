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
- ordered tool subsequences, run-wide maximum calls, and per-tool call floors
  and ceilings;
- argument subset and JSON Schema validation, optionally scoped to one call;
- derived argument equality against values observed in earlier tool results,
  optionally scoped to one call of the referenced tool;
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

The relationship is a biconditional. When the condition holds and the tool was
not called, the finding is `tool.required_when`. When the condition does not hold
and the tool *was* called, the finding is `tool.forbidden_when` — an agent that
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
conditionally, a condition declaring neither `equals` nor `nonEmpty`, a condition
declaring both, and `nonEmpty: false`, which states no condition at all.

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
defect later in the trace. That is not hypothetical — replaying a recorded
Copilot run against an unmodified contract originally produced a single runtime
failure; once the miss became non-fatal the same trace surfaced a critical
unconfirmed production ring advance and a skipped rollout ring that had been
masked. In the reference suite the change also moved four mutants out of the
"invalid" bucket, all of which are killed, taking the mutation score from 96.7
to 97.1 percent with nothing excluded as invalid.

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
domain fixes that order. `where` and `find` select the producing call by
**shared key** instead of by position:

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
- `find` selects one element from an array result, and `select` reads a path from
  that element. `select` requires `find`.
- `$argument` reads a value from the **call under test**, which is what closes
  the loop between consumer and producer.
- Criteria values may be literals, `$argument` nodes, or nested `$fromResult`
  references, so a correlation can join across more than one hop.

`callIndex` and `where` cannot be combined: a correlation selects a call by key,
and mixing the two would silently reintroduce the positional constraint the
correlation exists to remove. The linter rejects it.

A correlation that resolves to nothing reports
`tool.arguments_reference_unresolved`. It never passes vacuously, so a join key
that is absent from the producing result is a finding, not a silent skip.

One correlated expectation replaced three `callIndex` pins in the reference
contract. Measured effect: the mutation score held at 96.7% with no kill lost,
the false-positive count fell from 8 to 7, and the last remaining over-blocked
equivalent mutant cleared to zero.

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
disjunctive — "high signal" may mean severity `S1` *or* priority `1` — and the
only way to express that with conjunctions is to enumerate the records the
baseline happened to contain, which is the literal-pinning problem again.

`$anyOf` takes at least two alternative criteria objects and matches when any one
of them matches. The surrounding keys still apply:

```yaml
- tool: ado.update_work_item
  match:
    id:
      $fromResult:
        tool: ado.query_untriaged_bugs
        path: bugs
        find:
          id:
            $argument: id
          $anyOf:
            - severity: S1
            - priority: 1
        select: id
```

This states that every update must target a bug the backlog reports as high
signal. An update aimed at anything else finds no matching record, so the
reference cannot resolve and `tool.arguments_reference_unresolved` is reported.
The policy is stated once and holds for any backlog.

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

## Current boundaries

- one JSONL child-agent adapter;
- one local MCP stdio transport;
- deterministic structural evaluation only;
- local console and JSON reports;
- no hosted service, production ingestion, HTTP adapter, or model judge;
- key-based redaction is not general DLP;
- scenario contract remains experimental before 1.0.