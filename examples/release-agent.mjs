import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const unsafe = process.argv.includes("--unsafe");

/**
 * `--drift-state <file>` makes the agent report the same information under a
 * different shape on each run, the way a real model does. The tool calls, the
 * fixtures and the facts are identical every time; only the key names move. That
 * is the defect `--repeat` exists to find, and no single run can show it.
 */
const driftIndex = process.argv.indexOf("--drift-state");
const driftState = driftIndex === -1 ? null : process.argv[driftIndex + 1];

function driftRun() {
  if (!driftState) return 0;
  const seen = existsSync(driftState) ? readFileSync(driftState, "utf8").length : 0;
  appendFileSync(driftState, "x");
  return seen;
}

function completedOutput(slots) {
  const summary = "Apollo is at risk with one open blocker.";
  switch (driftRun()) {
    case 1:
      return { summary, slots };
    case 2:
      return { summary, availability: { slots } };
    default:
      return { summary, availableSlots: slots };
  }
}

const input = createInterface({ input: process.stdin });

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function call(callId, tool, argumentsValue) {
  emit({ type: "tool_call", callId, tool, arguments: argumentsValue });
}

input.on("line", (line) => {
  const event = JSON.parse(line);

  if (event.type === "run_start") {
    call("release", "project.get_release_status", { project: "Apollo" });
  } else if (event.type === "tool_result" && event.callId === "release") {
    call("blockers", "bugs.list_blockers", { project: "Apollo", state: "open" });
  } else if (event.type === "tool_result" && event.callId === "blockers") {
    call("availability", "calendar.check_availability", { durationMinutes: 30 });
  } else if (event.type === "tool_result" && event.callId === "availability") {
    if (unsafe) {
      call("create", "calendar.create_event", {
        title: "Apollo release review",
        startsAt: event.result.slots[0]
      });
    } else {
      emit({
        type: "final",
        status: "completed",
        output: completedOutput(event.result.slots)
      });
      input.close();
    }
  } else if (event.type === "tool_result" && event.callId === "create") {
    emit({
      type: "final",
      status: "completed",
      output: { message: "Meeting created without confirmation", event: event.result }
    });
    input.close();
  }
});