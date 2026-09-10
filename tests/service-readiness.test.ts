import { expect, test } from "bun:test";
import { waitForServiceReadiness } from "../scripts/service-readiness";

test("readiness accepts only a complete matching session line", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encoder.encode("READY old-session\nREADY current-"));
    controller.enqueue(encoder.encode("session\n"));
  } });
  await waitForServiceReadiness(stream, "READY current-session");
  expect(stream.locked).toBe(false);
});

test("readiness rejects an incorrect session token", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode("READY old-session\n"));
    controller.close();
  } });
  await expect(waitForServiceReadiness(stream, "READY current-session")).rejects.toThrow("stopped");
  expect(stream.locked).toBe(false);
});

test("startup timeout cancels the outstanding read before releasing its lock", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await expect(waitForServiceReadiness(stream, "READY current-session", 10)).rejects.toThrow("timed out");
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});
