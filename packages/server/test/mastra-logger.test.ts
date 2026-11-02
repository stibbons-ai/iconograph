import { expect, test } from "bun:test";
import { JsonLineLogger } from "../src/mastra-logger";

function capture() {
  const lines: Record<string, unknown>[] = [];
  return { lines, logger: new JsonLineLogger((line) => lines.push(line)) };
}

test("warnings and errors become one object: first message line, details, causes", () => {
  const { lines, logger } = capture();
  const at = new Date("2026-11-02T12:00:00.000Z");
  logger.debug("chatter");
  logger.info("chatter");
  logger.error("Failed to restart workflow run\n    at stack (bundle.js:1:1)", {
    runId: "r1",
    error: new Error("outer", { cause: new Error("inner") }),
    context: { attempt: { error: new Error("nested") }, at, list: [new Error("listed")] },
    level: "spoofed",
    mastra: "spoofed",
  });
  logger.warn("bare error", new Error("as a detail"));
  // Non-object details (a string would spread into its characters) are dropped.
  logger.warn("text detail", "abc", 42);
  // @mastra/hono logs errors as plain `{ message, stack }`: one line only.
  logger.error("Error calling handler", {
    error: { message: "Unexpected token", stack: "SyntaxError: Unexpected token\n    at parse" },
    seen: new Map([["a", 1]]),
    ids: new Set(["x"]),
  });
  expect(JSON.parse(JSON.stringify(lines))).toEqual([
    {
      runId: "r1",
      error: "outer: inner",
      context: { attempt: { error: "nested" }, at: "2026-11-02T12:00:00.000Z", list: ["listed"] },
      level: "error",
      mastra: "Failed to restart workflow run",
    },
    { error: "as a detail", level: "warn", mastra: "bare error" },
    { level: "warn", mastra: "text detail" },
    {
      error: { message: "Unexpected token", stack: "SyntaxError: Unexpected token" },
      seen: { a: 1 },
      ids: ["x"],
      level: "error",
      mastra: "Error calling handler",
    },
  ]);
});

test("a Mastra error keeps its id and domain", () => {
  const { lines, logger } = capture();
  const error = Object.assign(new Error("Run is owned by a live process"), {
    id: "WORKFLOW_RESTART_RUN_OWNED",
    domain: "MASTRA_WORKFLOW",
  });
  logger.error("Skipped", { error });
  expect(lines[0]?.error).toEqual({
    message: "Run is owned by a live process",
    id: "WORKFLOW_RESTART_RUN_OWNED",
    domain: "MASTRA_WORKFLOW",
  });
});

test("an entry that can't be written falls back to the message and why", () => {
  const written: Record<string, unknown>[] = [];
  let first = true;
  const logger = new JsonLineLogger((line) => {
    if (first) {
      first = false;
      throw new TypeError("BigInt value can't be serialized in JSON");
    }
    written.push(line);
  });
  expect(() => logger.error("Failed", { count: 1n })).not.toThrow();
  expect(written).toEqual([
    {
      level: "error",
      mastra: "Failed",
      loggingFailed: "BigInt value can't be serialized in JSON",
    },
  ]);
});

test("a destination that always throws never throws into Mastra", () => {
  const logger = new JsonLineLogger(() => {
    throw new Error("stderr closed");
  });
  expect(() => logger.error("Failed", { runId: "r1" })).not.toThrow();
});
