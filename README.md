# Agent Doctor

Agent Doctor is a local-first CI safety gate for tool-using agents. It runs a
scenario through an explicit graph, records observable JSONL evidence, and
blocks unsafe or regressed tool behavior.

## Quick start

```bash
npm install
npm run build
agentdoctor init
node dist/src/cli.js test examples/release-safety.yml -- node examples/release-agent.mjs
```

`agentdoctor init [path]` creates a starter scenario without overwriting an
existing file.

The safe example exits `0`. Its intentionally unsafe variant calls a mutating
tool without confirmation and exits `3`:

```bash
node dist/src/cli.js test examples/release-safety.yml -- node examples/release-agent.mjs --unsafe
```

The separator is optional for shell wrappers that consume `--`.

Run reports are written to `.agentdoctor/runs`. Inspect one with:

```bash
node dist/src/cli.js inspect .agentdoctor/runs/<run>.json
```

## Execution graph

```text
load -> execute <-> agent tool loop -> capture -> evaluate -> report
```

During execution, Agent Doctor starts the configured child process and sends:

```json
{"type":"run_start","scenarioId":"release-safety","input":{"message":"..."}}
```

The agent writes one JSON object per line. A tool request is answered from the
scenario fixture, allowing repeatable tests without external side effects:

```json
{"type":"tool_call","callId":"1","tool":"calendar.check_availability","arguments":{"durationMinutes":30}}
{"type":"tool_result","callId":"1","tool":"calendar.check_availability","result":{"slots":["..."]}}
{"type":"final","status":"completed","output":{}}
```

Adapters can emit
`{"type":"confirmation","confirmed":true,"tool":"calendar.create_event"}`
when they have observable user-confirmation evidence. A confirmation authorizes
one subsequent call to the named tool. Agent Doctor never infers confirmation
from hidden model reasoning.

## Contracts

Version `0.1` scenarios support:

- required, forbidden, ordered, and maximum tool calls;
- argument subset and JSON Schema checks;
- confirmation before configured mutations;
- expected final status and structured output subsets;
- final-output JSON Schema checks;
- duration budgets;
- inline tool fixtures, including strings and scalars;
- file-backed fixtures through `{"$file":"fixtures/result.json"}`.

The published schema is at `schema/scenario-0.1.json`.

## Agentic sample

The Engineering Release Assistant in
`examples/agentic-release-assistant.mjs` uses a state-driven plan-act-observe
loop. It chooses its next tool from accumulated evidence, emits explicit
confirmation before creating a meeting, and returns a structured summary.

```bash
npm run build
npm run demo
```

Two seeded regressions demonstrate different CI decisions:

```bash
node dist/src/cli.js test examples/agentic-release-contract.yml -- node examples/agentic-release-assistant.mjs --regression=hallucinated-summary
node dist/src/cli.js test examples/agentic-release-contract.yml -- node examples/agentic-release-assistant.mjs --regression=unconfirmed-mutation
```

The first exits `1` for an incorrect structured outcome. The second exits `3`
for a critical confirmation-boundary violation.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | All contracts passed |
| 1 | Quality contract failed |
| 2 | Configuration or runtime failed |
| 3 | Critical safety contract failed |

## Development

```bash
npm run check
npm run test:e2e
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and
[SECURITY.md](SECURITY.md) for private vulnerability reporting guidance.

## License

Apache-2.0. See [LICENSE](LICENSE).