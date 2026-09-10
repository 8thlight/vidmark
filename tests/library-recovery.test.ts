import { expect, test } from "bun:test";
import { noteBelongsToCourse, retryLibraryLoad } from "../app/library-recovery";

test("database startup retries failures and stops after recovery", async () => {
  let attempts = 0;
  let failures = 0;
  let recovered!: () => void;
  const ready = new Promise<void>(resolve => { recovered = resolve; });
  const cancel = retryLibraryLoad(async () => {
    if (++attempts < 3) throw new Error("Starting");
    recovered();
  }, () => { failures++; }, 1);
  await ready;
  await Bun.sleep(15);
  cancel();
  expect(attempts).toBe(3);
  expect(failures).toBe(2);
});

test("unmount cancels retries, including a pending failure", async () => {
  let reject!: (error: Error) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let failures = 0;
  const cancel = retryLibraryLoad(() => new Promise((_, fail) => { reject = fail; started(); }), () => { failures++; }, 1);
  await ready;
  cancel();
  reject(new Error("Unavailable"));
  await Bun.sleep(10);
  expect(failures).toBe(0);
});

test("legacy video-ID notes remain visible without rewriting their IDs", () => {
  const course = { id: "database-course", sourceKey: "reDRM0tqhNs" };
  expect(noteBelongsToCourse(course.id, course, [course])).toBe(true);
  expect(noteBelongsToCourse(course.sourceKey, course, [course])).toBe(true);
  expect(noteBelongsToCourse("unrelated", course, [course])).toBe(false);
  expect(noteBelongsToCourse(course.sourceKey, course, [course, { id: course.sourceKey }])).toBe(false);
});
