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
- ordered tool subsequences and maximum calls;
- argument subset and JSON Schema validation;
- one-use, tool-scoped or exact-argument-bound confirmation before protected calls;
- optional pre-dispatch enforcement for forbidden and confirmation-protected calls;
- semantic checks for core policy contradictions, enforcement reachability, and
  fixture reachability;
- final status, output subset, and output schema;
- whole-run duration;
- MCP capability and tool snapshot drift;
- MCP tool error, completed-call latency, and serialized result-byte budgets.

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
duplicate selectors and broader earlier cases that would shadow later cases. No
match is a runtime failure rather than a success-shaped fallback.

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

## Current boundaries

- one JSONL child-agent adapter;
- one local MCP stdio transport;
- deterministic structural evaluation only;
- local console and JSON reports;
- no hosted service, production ingestion, HTTP adapter, or model judge;
- key-based redaction is not general DLP;
- scenario contract remains experimental before 1.0.