// Domain-independent mutation adapter.
//
// The seven operators below were developed against `em-triage-steward` and every
// published mutation score came from them. Leaving them there would have meant
// re-implementing them for a second domain, and a re-implementation that I tune
// until the second domain scores well is not a measurement — it is the same
// fixture-overfitting the whole project exists to price, moved up one level.
//
// So the operators live here, once, and a domain supplies only what is genuinely
// domain knowledge: the workflow generator, and a small set of hints used to
// invent a plausible substitute value. Nothing in this file names a tool, an
// argument, or a field of either domain.
//
// Operators:
//   drop-call:<n>              the nth tool call never happens
//   reorder:<n>               the nth call and the one after it swap
//   swap-arg:<n>:<key>        one argument takes a value seen elsewhere
//   widen-filter:<n>:<key>    one argument is broadened or removed
//   stale-result:<n>          the nth call is answered with an earlier result
//   misreport-outcome:<path>  the final report is perturbed, no call changes
//   select-extra:<n>          one more record is acted on than was chosen

import { createInterface } from "node:readline";

export function parseMutation(id) {
  if (!id) return { kind: "none" };

  let match = /^drop-call:(\d+)$/.exec(id);
  if (match) return { kind: "drop-call", id, n: Number(match[1]) };

  match = /^reorder:(\d+)$/.exec(id);
  if (match) return { kind: "reorder", id, n: Number(match[1]) };

  match = /^swap-arg:(\d+):(.+)$/.exec(id);
  if (match) return { kind: "swap-arg", id, n: Number(match[1]), key: match[2] };

  match = /^widen-filter:(\d+):(.+)$/.exec(id);
  if (match) return { kind: "widen-filter", id, n: Number(match[1]), key: match[2] };

  match = /^stale-result:(\d+)$/.exec(id);
  if (match) return { kind: "stale-result", id, n: Number(match[1]) };

  match = /^misreport-outcome:(.+)$/.exec(id);
  if (match) return { kind: "misreport-outcome", id, path: match[1] };

  match = /^select-extra:(\d+)$/.exec(id);
  if (match) return { kind: "select-extra", id, n: Number(match[1]) };

  return { kind: "unknown", id };
}

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
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectScalars(item, key));
  }
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([childKey, childValue]) =>
      collectScalars(childValue, childKey)
    );
  }
  return [];
}

/**
 * @param {object} options
 * @param {(input: unknown, faults: Set<string>) => Generator} options.workflow
 * @param {(tool: string, args: object) => object} [options.syntheticResult]
 *   Invents a result for a call whose real result was never observed, used by
 *   `reorder` when it has to run a later call first. Returning `undefined`
 *   makes the operator skip rather than guess.
 * @param {Array<(original: unknown, key: string) => boolean>} [options.valueFamilies]
 *   Predicates grouping values that are interchangeable in the domain, so a
 *   substituted value is plausible rather than obviously wrong. A mutant that a
 *   contract rejects on type alone measures the type check, not the contract.
 */
export function runMutationAdapter(options) {
  const { workflow, syntheticResult, valueFamilies = [] } = options;

  const faults = new Set(
    process.argv
      .filter((argument) => argument.startsWith("--fault="))
      .map((argument) => argument.slice("--fault=".length))
  );

  const mutation = parseMutation(
    process.argv.find((argument) => argument.startsWith("--mutation="))?.slice("--mutation=".length)
  );

  // An id the adapter cannot parse used to run the baseline silently, which made
  // a typo look like a behaviour-preserving mutant instead of a broken
  // measurement. Failing loudly turns it into a row the harness cannot mistake.
  if (mutation.kind === "unknown") {
    process.stderr.write(`Unknown mutation id: ${mutation.id}\n`);
    process.exit(1);
  }

  const input = createInterface({ input: process.stdin });

  let iterator;
  let runInput;
  let pendingCall;
  let callSequence = 0;
  let toolSequence = 0;
  let finished = false;
  let skippedMutation = false;

  const history = [];
  const actualResultsByTool = new Map();
  const seenValues = [];

  function emit(event) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }

  function abort(message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    finished = true;
    input.close();
  }

  function rememberValues(value) {
    for (const entry of collectScalars(value)) seenValues.push(entry);
  }

  function rememberActualResult(tool, result) {
    const list = actualResultsByTool.get(tool) ?? [];
    list.push(clone(result));
    actualResultsByTool.set(tool, list);
    rememberValues(result);
  }

  function earlierResults(tool) {
    return actualResultsByTool.get(tool) ?? [];
  }

  function syntheticForDrop(tool) {
    const earlier = earlierResults(tool);
    return earlier.length > 0 ? clone(earlier[earlier.length - 1]) : {};
  }

  function syntheticForReorder(tool, args) {
    const earlier = earlierResults(tool);
    if (earlier.length > 0) return clone(earlier[earlier.length - 1]);
    const invented = syntheticResult?.(tool, clone(args) ?? {});
    return invented === undefined ? (clone(args) ?? {}) : clone(invented);
  }

  function firstCandidate(candidates, predicate) {
    return candidates.find((candidate) => predicate(candidate.value, candidate.key))?.value;
  }

  function replacementFor(key, original) {
    if (!["string", "number", "boolean", "null"].includes(primitiveType(original))) {
      return undefined;
    }

    const candidates = seenValues.filter(
      (candidate) =>
        primitiveType(candidate.value) === primitiveType(original) &&
        !sameValue(candidate.value, original)
    );

    const sameKey = firstCandidate(candidates, (_value, candidateKey) => candidateKey === key);
    if (sameKey !== undefined) return clone(sameKey);

    for (const family of valueFamilies) {
      if (!family(original, key)) continue;
      const match = firstCandidate(candidates, (value, candidateKey) => family(value, candidateKey));
      if (match !== undefined) return clone(match);
    }

    const sameType = candidates[0]?.value;
    return sameType === undefined ? undefined : clone(sameType);
  }

  // Perturbs the final report without touching a single tool call, which models
  // an agent that did the right thing and then said something else. Every other
  // operator changes what the agent *did*; none changed what it *reported*, so a
  // contract could drop every correlation between action and report and the
  // score would not move. That blindness cost two real detections.
  function misreportedOutput(output, path) {
    const keys = path.split(".");
    const mutated = clone(output);
    let parent = mutated;
    for (const key of keys.slice(0, -1)) {
      if (parent === null || typeof parent !== "object") return undefined;
      parent = parent[key];
    }
    if (parent === null || typeof parent !== "object") return undefined;

    const leaf = keys[keys.length - 1];
    if (!Object.hasOwn(parent, leaf)) return undefined;
    const original = parent[leaf];

    if (Array.isArray(original)) {
      if (original.length === 0) return undefined;
      parent[leaf] = original.slice(0, -1);
      return mutated;
    }
    if (primitiveType(original) === "boolean") {
      parent[leaf] = !original;
      return mutated;
    }
    const replacement = replacementFor(leaf, original);
    if (replacement === undefined) return undefined;
    parent[leaf] = replacement;
    return mutated;
  }

  function widenedArguments(args, key) {
    if (!Object.hasOwn(args, key)) return undefined;
    const widened = clone(args);
    const value = widened[key];

    if (typeof value === "string" && value.includes("\\")) {
      const index = value.lastIndexOf("\\");
      if (index > 0) {
        widened[key] = value.slice(0, index);
        return widened;
      }
    }

    if (typeof value === "string") {
      widened[key] = "*";
      return widened;
    }

    delete widened[key];
    return widened;
  }

  function argumentsForIntent(intent, index) {
    const args = clone(intent.arguments ?? {});

    if (mutation.kind === "swap-arg" && mutation.n === index) {
      if (Object.hasOwn(args, mutation.key)) {
        const replacement = replacementFor(mutation.key, args[mutation.key]);
        if (replacement !== undefined) {
          args[mutation.key] = replacement;
        } else {
          skippedMutation = true;
        }
      } else {
        skippedMutation = true;
      }
    }

    if (mutation.kind === "widen-filter" && mutation.n === index) {
      const widened = widenedArguments(args, mutation.key);
      if (widened) return widened;
      skippedMutation = true;
    }

    return args;
  }

  function emitConfirmation(intent) {
    emit({
      type: "confirmation",
      confirmed: true,
      tool: intent.tool,
      source: intent.source,
      arguments: intent.arguments
    });
    rememberValues(intent.arguments);
  }

  function issueToolCall(intent, args, onResult) {
    const callId = `call-${++callSequence}`;
    pendingCall = { callId, tool: intent.tool, intent, onResult };
    emit({ type: "tool_call", callId, tool: intent.tool, arguments: args });
    rememberValues(args);
  }

  function previewNextToolAfter(currentIntent, synthetic) {
    const preview = workflow(runInput, faults);
    let step = preview.next();

    for (const entry of history) {
      if (step.done) return undefined;
      step = preview.next(clone(entry.resumeValue));
    }

    if (step.done || step.value.kind !== currentIntent.kind || step.value.tool !== currentIntent.tool) {
      return undefined;
    }

    step = preview.next(clone(synthetic));
    const confirmations = [];
    while (!step.done && step.value.kind === "confirm") {
      confirmations.push(clone(step.value));
      step = preview.next(undefined);
    }

    if (step.done || step.value.kind !== "tool") return undefined;
    return { confirmations, intent: clone(step.value) };
  }

  function consumeReorderedResults(currentIntent, currentResult, nextIntent, nextResult) {
    history.push({ intent: currentIntent, resumeValue: clone(currentResult) });

    let step;
    try {
      step = iterator.next(currentResult);
    } catch (error) {
      abort(`Workflow failure: ${error.message}`);
      return;
    }

    while (!step.done && step.value.kind === "confirm") {
      emitConfirmation(step.value);
      history.push({ intent: step.value, resumeValue: undefined });
      try {
        step = iterator.next(undefined);
      } catch (error) {
        abort(`Workflow failure: ${error.message}`);
        return;
      }
    }

    if (step.done) {
      abort("Reorder mutation could not return the buffered result to a tool intent");
      return;
    }

    if (step.value.kind !== "tool" || step.value.tool !== nextIntent.tool) {
      abort("Reorder mutation predicted a different next tool than the workflow yielded");
      return;
    }

    history.push({ intent: step.value, resumeValue: clone(nextResult) });

    try {
      step = iterator.next(nextResult);
    } catch (error) {
      abort(`Workflow failure: ${error.message}`);
      return;
    }

    processStep(step);
  }

  function beginReorder(intent) {
    const synthetic = syntheticForReorder(intent.tool, intent.arguments ?? {});
    const preview = previewNextToolAfter(intent, synthetic);
    if (!preview) {
      skippedMutation = true;
      issueToolCall(intent, clone(intent.arguments ?? {}), (result) => resumeTool(intent, result));
      return;
    }

    for (const confirmation of preview.confirmations) emitConfirmation(confirmation);

    issueToolCall(preview.intent, clone(preview.intent.arguments ?? {}), (nextResult) => {
      rememberActualResult(preview.intent.tool, nextResult);
      issueToolCall(intent, clone(intent.arguments ?? {}), (currentResult) => {
        rememberActualResult(intent.tool, currentResult);
        consumeReorderedResults(intent, currentResult, preview.intent, nextResult);
      });
    });
  }

  function resumeTool(intent, result) {
    const index = pendingCall?.index ?? toolSequence;
    const earlier = earlierResults(intent.tool);
    let resumeValue = result;

    if (mutation.kind === "stale-result" && mutation.n === index) {
      if (earlier.length > 0) {
        resumeValue = clone(earlier[0]);
      } else {
        skippedMutation = true;
      }
    }

    rememberActualResult(intent.tool, result);
    history.push({ intent, resumeValue: clone(resumeValue) });
    advance(resumeValue);
  }

  function handleToolIntent(intent) {
    const index = ++toolSequence;

    if (mutation.kind === "drop-call" && mutation.n === index) {
      const synthetic = syntheticForDrop(intent.tool);
      history.push({ intent, resumeValue: clone(synthetic) });
      advance(synthetic);
      return;
    }

    if (mutation.kind === "reorder" && mutation.n === index) {
      beginReorder(intent);
      return;
    }

    // Acts on one more record than the agent decided to act on, using a value
    // the agent had already retrieved but deliberately left alone. The report is
    // left untouched, so the mutant is an action the agent never claimed to take.
    if (mutation.kind === "select-extra" && mutation.n === index) {
      const args = argumentsForIntent(intent, index);
      const extra = clone(args);
      let mutated = false;
      for (const key of Object.keys(extra)) {
        const replacement = replacementFor(key, extra[key]);
        if (replacement !== undefined) {
          extra[key] = replacement;
          mutated = true;
          break;
        }
      }
      if (!mutated) {
        skippedMutation = true;
        issueToolCall(intent, args, (result) => resumeTool(intent, result));
        pendingCall.index = index;
        return;
      }
      issueToolCall(intent, extra, () => {
        issueToolCall(intent, args, (result) => resumeTool(intent, result));
        pendingCall.index = index;
      });
      return;
    }

    const args = argumentsForIntent(intent, index);
    issueToolCall(intent, args, (result) => resumeTool(intent, result));
    pendingCall.index = index;
  }

  function processStep(step) {
    if (finished) return;

    if (step.done) {
      finished = true;
      let output = step.value.output;
      if (mutation.kind === "misreport-outcome") {
        const misreported = misreportedOutput(output, mutation.path);
        if (misreported === undefined) {
          skippedMutation = true;
        } else {
          output = misreported;
        }
      }
      if (skippedMutation && mutation.kind !== "none") {
        process.stderr.write(`Mutation skipped: ${mutation.id}\n`);
      }
      emit({ type: "final", status: step.value.status, output });
      input.close();
      return;
    }

    const intent = step.value;
    if (intent.kind === "confirm") {
      emitConfirmation(intent);
      history.push({ intent, resumeValue: undefined });
      advance(undefined);
      return;
    }

    handleToolIntent(intent);
  }

  function advance(resumeValue) {
    if (finished) return;

    let step;
    try {
      step = iterator.next(resumeValue);
    } catch (error) {
      abort(`Workflow failure: ${error.message}`);
      return;
    }

    processStep(step);
  }

  input.on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      abort(`Unparseable protocol line: ${line}`);
      return;
    }

    if (event.type === "run_start") {
      runInput = event.input;
      rememberValues(event.input);
      iterator = workflow(event.input, faults);
      advance(undefined);
      return;
    }

    if (event.type !== "tool_result" || !pendingCall) {
      abort(`Unexpected protocol event: ${line}`);
      return;
    }

    if (event.callId !== pendingCall.callId || event.tool !== pendingCall.tool) {
      abort(`Tool result did not match the pending call: ${line}`);
      return;
    }

    const handler = pendingCall.onResult;
    pendingCall = undefined;
    handler(event.result);
  });
}
