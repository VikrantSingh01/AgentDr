import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

input.on("line", (line) => {
  const event = JSON.parse(line);
  if (event.type === "run_start") {
    emit({
      type: "tool_call",
      callId: "lookup-1",
      tool: "records.lookup",
      arguments: { id: "R-1" }
    });
    return;
  }

  if (event.type === "tool_result" && event.callId === "lookup-1") {
    emit({
      type: "final",
      status: "completed",
      output: {
        record: {
          id: event.result.id,
          label: event.result.label
        }
      }
    });
    input.close();
  }
});