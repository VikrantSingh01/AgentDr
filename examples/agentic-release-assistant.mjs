import { createInterface } from "node:readline";

const regression = process.argv
  .find((argument) => argument.startsWith("--regression="))
  ?.slice("--regression=".length);
const input = createInterface({ input: process.stdin });
const state = {
  request: undefined,
  observations: new Map(),
  pendingCall: undefined,
  callSequence: 0,
  finished: false
};

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function callTool(tool, argumentsValue) {
  const callId = `call-${++state.callSequence}`;
  state.pendingCall = { callId, tool };
  emit({ type: "tool_call", callId, tool, arguments: argumentsValue });
}

function finish(status, output) {
  state.finished = true;
  emit({ type: "final", status, output });
  input.close();
}

function buildReleaseSummary() {
  const release = state.observations.get("project.get_release_status");
  const blockers = state.observations.get("bugs.list_blockers");
  const hallucinated = regression === "hallucinated-summary";

  return {
    project: release.project,
    risk: hallucinated ? "ready" : release.status,
    openBlockers: hallucinated ? 0 : blockers.open.length,
    blockerIds: blockers.open.map((blocker) => blocker.id)
  };
}

function chooseNextAction() {
  if (!state.observations.has("project.get_release_status")) {
    return {
      type: "tool",
      tool: "project.get_release_status",
      arguments: { project: state.request.data.project }
    };
  }
  if (!state.observations.has("bugs.list_blockers")) {
    return {
      type: "tool",
      tool: "bugs.list_blockers",
      arguments: { project: state.request.data.project, state: "open" }
    };
  }
  if (!state.observations.has("calendar.check_availability")) {
    return {
      type: "tool",
      tool: "calendar.check_availability",
      arguments: { durationMinutes: state.request.data.durationMinutes }
    };
  }
  if (!state.request.data.createMeeting) {
    return { type: "final", status: "completed" };
  }
  if (!state.request.data.confirmed && regression !== "unconfirmed-mutation") {
    return { type: "final", status: "awaiting_confirmation" };
  }
  if (!state.observations.has("calendar.create_event")) {
    const availability = state.observations.get("calendar.check_availability");
    return {
      type: "mutation",
      tool: "calendar.create_event",
      arguments: {
        title: state.request.data.meetingTitle,
        startsAt: availability.slots[0],
        durationMinutes: state.request.data.durationMinutes
      }
    };
  }
  return { type: "final", status: "completed" };
}

function advance() {
  if (state.finished || state.pendingCall) return;

  const action = chooseNextAction();
  if (action.type === "tool") {
    callTool(action.tool, action.arguments);
    return;
  }
  if (action.type === "mutation") {
    if (regression !== "unconfirmed-mutation") {
      emit({
        type: "confirmation",
        confirmed: true,
        tool: action.tool,
        source: "input.data.confirmed"
      });
    }
    callTool(action.tool, action.arguments);
    return;
  }

  const availability = state.observations.get("calendar.check_availability");
  const createdEvent = state.observations.get("calendar.create_event");
  finish(action.status, {
    release: buildReleaseSummary(),
    availableSlots: availability.slots,
    ...(createdEvent
      ? {
          meeting: {
            status: createdEvent.status,
            eventId: createdEvent.eventId
          }
        }
      : {})
  });
}

input.on("line", (line) => {
  const event = JSON.parse(line);
  if (event.type === "run_start") {
    state.request = event.input;
    advance();
    return;
  }
  if (event.type !== "tool_result" || !state.pendingCall) {
    process.stderr.write(`Unexpected protocol event: ${line}\n`);
    process.exitCode = 1;
    input.close();
    return;
  }
  if (
    event.callId !== state.pendingCall.callId ||
    event.tool !== state.pendingCall.tool
  ) {
    process.stderr.write(`Tool result did not match the pending call: ${line}\n`);
    process.exitCode = 1;
    input.close();
    return;
  }

  state.observations.set(event.tool, event.result);
  state.pendingCall = undefined;
  advance();
});