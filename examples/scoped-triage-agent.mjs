import { createInterface } from "node:readline";

const fixed = process.argv.includes("--fixed");
const input = createInterface({ input: process.stdin });
const state = {
  workItems: [],
  owners: [],
  pending: undefined
};

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function call(callId, tool, argumentsValue) {
  state.pending = { callId, tool };
  emit({ type: "tool_call", callId, tool, arguments: argumentsValue });
}

function assignFirstWorkItem() {
  call("assign-1", "assign_work_item", {
    workItemId: state.workItems[0].id,
    team: state.workItems[0].team,
    assignedTo: state.owners[0]
  });
}

function assignSecondWorkItem() {
  call("assign-2", "assign_work_item", {
    workItemId: state.workItems[1].id,
    team: state.workItems[1].team,
    assignedTo: fixed ? state.owners[1] : state.owners[0]
  });
}

input.on("line", (line) => {
  const event = JSON.parse(line);

  if (event.type === "run_start") {
    state.workItems = event.input.data.workItems;
    call("lookup-1", "lookup_owner", { team: state.workItems[0].team });
    return;
  }

  if (event.type !== "tool_result" || !state.pending) {
    process.stderr.write(`Unexpected protocol event: ${line}\n`);
    process.exitCode = 1;
    input.close();
    return;
  }

  if (event.callId !== state.pending.callId || event.tool !== state.pending.tool) {
    process.stderr.write(`Tool result did not match pending call: ${line}\n`);
    process.exitCode = 1;
    input.close();
    return;
  }

  state.pending = undefined;

  if (event.callId === "lookup-1") {
    state.owners[0] = event.result.owner;
    call("lookup-2", "lookup_owner", { team: state.workItems[1].team });
  } else if (event.callId === "lookup-2") {
    state.owners[1] = event.result.owner;
    assignFirstWorkItem();
  } else if (event.callId === "assign-1") {
    assignSecondWorkItem();
  } else if (event.callId === "assign-2") {
    emit({
      type: "final",
      status: "completed",
      output: {
        assignments: [
          { workItemId: state.workItems[0].id, assignedTo: state.owners[0] },
          {
            workItemId: state.workItems[1].id,
            assignedTo: fixed ? state.owners[1] : state.owners[0]
          }
        ]
      }
    });
    input.close();
  }
});
