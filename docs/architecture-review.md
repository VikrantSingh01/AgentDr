# Agent Doctor Architecture Review

Review date: 2026-07-30

This review separates what Agent Doctor demonstrates today from the controls a
production enforcement system would require. The current product is a local,
deterministic behavioral contract tester. It observes cooperative JSONL events
and harness-mediated MCP calls, evaluates them after they occur, and fails the
run when evidence violates a scenario.

It is not currently a sandbox, a complete side-effect monitor, or a
pre-dispatch authorization gateway.

## Executive assessment

The core `scenario -> execute -> evidence -> evaluate -> decision` loop is a
sound base for regression testing. Ordered evidence, strict process protocol,
stable exit codes, partial-failure reporting, report-boundary redaction, and a
real MCP stdio proxy make the MVP useful in local development and CI.

The largest architectural risk is confusing detection with prevention. The
runner can reject a run after observing a protected call, but an adapter or
child process can perform activity outside the observed protocol. Confirmation
is likewise asserted by the adapter rather than independently established by
the harness. Those boundaries are now explicit in product documentation; they
remain implementation work for any enforcement-grade mode.

## Findings

| Priority | Finding | Current consequence | Status |
|---|---|---|---|
| Critical | Evaluation is post-observation, not pre-dispatch enforcement. | A mediated or out-of-band side effect may occur before the run fails. | Boundary documented; policy-gate architecture required. |
| Critical | Confirmation is adapter-attested. | The harness cannot prove who approved which arguments, under which identity, or for how long. | Boundary documented; harness-controlled capability required. |
| High | Observation is cooperative and incomplete. | A child process can bypass JSONL and use files, network, subprocesses, or another client directly. | Boundary documented; isolation and instrumentation required. |
| High | Scenario commands execute as trusted local code. | An untrusted scenario can launch arbitrary adapter or MCP commands with runner privileges. | Trust warning documented; isolated execution mode required. |
| High | The MCP flow is harness-proxied. | It validates the server and requested calls but not the child agent's own native MCP client implementation. | Demo wording corrected; native-client adapter needed for that claim. |
| High | Safety contracts are opt-in. | Destructive tools or MCP annotations do not automatically require confirmation or prohibition. | Open product decision and policy-layer work. |
| Medium | Snapshot checks classify exact normalized drift only. | A change is not automatically categorized as compatible, breaking, or certified safe. | Terminology corrected; compatibility analyzer is future work. |
| Medium | Scenario semantics are not linted. | A schema-valid scenario may be vacuous, contradictory, or unable to exercise its assertions. | Semantic linting planned. |
| Medium | Reports lack tamper-evident provenance. | Evidence does not independently prove the scenario, executable, fixtures, or report were unchanged. | Manifest and signing design planned. |
| Medium | Execution topology is narrow. | The MVP supports one child adapter, one stdio MCP server, and sequential calls. | Multi-server, parallel, streaming, and HTTP support planned. |
| Medium | Key-based redaction is not DLP. | Unknown, encoded, positional, or free-text secrets can remain in reports. | Boundary documented; minimize and sanitize test data. |

Priorities describe architecture and product risk, not disclosed security
vulnerabilities in the repository.

## Addressed in this release

- Replaced prevention language with precise detection and run-failure language.
- Labeled the safety regression as fixture-backed and stated that no external
  calendar API is called.
- Added the required JSONL adapter integration contract to the README.
- Identified confirmation as adapter-attested evidence.
- Clarified that fixture replay substitutes only mediated tool responses.
- Clarified that MCP execution uses a harness proxy rather than a native child
  MCP client.
- Documented trusted scenario commands, report redaction limits, and isolation
  guidance.
- Rebuilt marketing media from generated evidence with exact event names and
  explicit exit codes.
- Added static final frames, literal CLI inspect output, compact report-derived
  summaries, and normalized post-redaction reports beside animated demos.

These changes improve the accuracy of the release. They do not close the
underlying enforcement, identity, or isolation gaps.

## Prioritized roadmap

### 1. Introduce an enforcement-capable invocation boundary

Move protected operations behind a harness-owned dispatch API. Evaluate policy
before forwarding a call, produce separate `requested`, `authorized`,
`dispatched`, and `completed` evidence, and fail closed when authorization is
missing or evidence cannot be persisted. Keep the current observe-and-test mode
for frameworks that cannot delegate dispatch.

Acceptance criteria:

- a denied call never reaches the fixture, MCP server, or external connector;
- reports distinguish attempted calls from dispatched calls;
- crash and timeout tests prove fail-closed behavior at the dispatch boundary;
- product language uses “prevent” only for calls routed through this mode.

### 2. Make confirmation harness-controlled and bound

Represent approval as a short-lived, one-use capability issued by a trusted
host integration. Bind it to the authenticated principal, tenant, tool, a
canonical digest of arguments, policy version, nonce, issuance time, and
expiry. Consume it atomically at dispatch.

Acceptance criteria:

- changing the tool or arguments invalidates approval;
- replay, expiry, wrong-principal, and wrong-tenant cases are rejected;
- reports identify the verifier and binding fields without persisting secrets.

### 3. Add isolation and explicit trust modes

Offer a documented isolated runner using platform primitives appropriate to the
host, with restricted network, filesystem, environment, child processes, and
resource limits. Treat Windows descendant-process cleanup as an explicit gap
until a Job Object or equivalent containment strategy is implemented.

### 4. Add scenario policy and semantic linting

Derive an inventory of mutating or destructive tools from configured policy and
MCP annotations, while requiring explicit review rather than assuming server
metadata is authoritative. Detect contradictions, unreachable required calls,
duplicate assertions, protected tools without confirmation policy, and fixtures
that cannot satisfy argument or outcome schemas.

### 5. Add provenance and reproducibility manifests

Record hashes for the scenario, fixtures, adapter command or package, MCP
snapshot, policy, Agent Doctor version, runtime, and environment metadata.
Canonicalize and sign the final manifest where organizational trust requires
it. Preserve a clear distinction between reproducible inputs and inherently
nondeterministic model execution.

### 6. Broaden adapters and topology

Add native MCP-client observation, multiple servers, parallel and streaming
calls, and an HTTP transport. Framework adapters should preserve the same
evidence vocabulary while documenting which activity each integration can and
cannot observe.

### 7. Classify MCP compatibility separately from drift

Keep exact snapshot comparison as the deterministic primitive. Add a separate,
versioned compatibility analyzer for schema and metadata changes, with reasons
and confidence grounded in protocol rules. Do not label drift checks as
certification.

## Release bar

The MVP is suitable for deterministic regression testing when teams accept its
cooperative adapter and trusted-runner model. An enforcement-grade claim should
wait until roadmap items 1 through 3 are implemented and independently tested.
Product-market fit remains an empirical question: the relevant evidence is
whether external teams keep useful scenarios in pull requests with acceptable
maintenance cost and false-failure rates.