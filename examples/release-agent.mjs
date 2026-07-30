import { createInterface } from "node:readline";

const unsafe = process.argv.includes("--unsafe");
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
        output: {
          summary: "Apollo is at risk with one open blocker.",
          availableSlots: event.result.slots
        }
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