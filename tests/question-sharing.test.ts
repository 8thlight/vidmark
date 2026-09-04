import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { questionPayloadChanges, questionPayloadsEqual } from "../app/question-diff";
import { STARTER_COURSE_ID, VidmarkDatabase } from "../scripts/vidmark-db";
import { VidmarkSyncService } from "../scripts/vidmark-sync";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const testStore = async (name: string) => {
  const root = await mkdtemp(join(tmpdir(), `vidmark-${name}-`));
  temporaryDirectories.push(root);
  return new VidmarkDatabase(join(root, "vidmark.sqlite"));
};

describe("shared question changes", () => {
  test("compares complete question payloads independent of object key order", () => {
    const before = { id: "q-1", question: "What changed?", options: { A: { text: "Nothing", rationale: "Same payload." } }, tags: ["sync"] };
    const reordered = { tags: ["sync"], options: { A: { rationale: "Same payload.", text: "Nothing" } }, question: "What changed?", id: "q-1" };
    expect(questionPayloadsEqual(before, reordered)).toBe(true);
    expect(questionPayloadChanges(before, reordered)).toEqual([]);

    const changed = { ...reordered, options: { A: { ...reordered.options.A, rationale: "A revised rationale." } } };
    expect(questionPayloadChanges(before, changed).map((change) => change.path)).toEqual(["options.A.rationale"]);
  });

  test("dismisses existing no-change suggestions but keeps real updates", async () => {
    let store = await testStore("duplicate-suggestions");
    const question = store.listQuestions(STARTER_COURSE_ID, { limit: 1 }).questions[0]!;
    store.createSuggestion({ id: "duplicate", courseId: STARTER_COURSE_ID, questionId: question.id, kind: "update", title: "Duplicate", rationale: "No change", proposedPatch: question.payload, sources: [] });
    store.createSuggestion({ id: "changed", courseId: STARTER_COURSE_ID, questionId: question.id, kind: "update", title: "Changed", rationale: "Real change", proposedPatch: { question: "A genuinely revised question?" }, sources: [] });
    store.close();

    store = new VidmarkDatabase(store.path);
    expect(store.getSuggestion("duplicate")?.status).toBe("rejected");
    expect(store.getSuggestion("duplicate")?.reviewNote).toContain("matches the local version");
    expect(store.getSuggestion("changed")?.status).toBe("pending");
    expect(store.listDesktopNotifications(0).some((item) => item.entityId === "duplicate")).toBe(false);
    expect(store.listDesktopNotifications(0).some((item) => item.entityId === "changed")).toBe(true);
    store.close();
  });

  test("ignores an identical direct share before creating a notification", async () => {
    const store = await testStore("duplicate-delivery");
    const question = store.listQuestions(STARTER_COURSE_ID, { limit: 1 }).questions[0]!;
    const sync = new VidmarkSyncService(store);
    const receive = sync as unknown as { applySharedEvent: (event: unknown, envelope: unknown) => void };
    const profile = { id: "sender", name: "Drake Fish", email: "drake@example.com", avatarStyle: "bottts", avatarSeed: "drake" };
    const envelope = { id: "envelope", recipientDeviceId: "recipient", senderDeviceId: "sender-device", payload: "", createdAt: Date.now() };

    receive.applySharedEvent({ type: "question", eventId: "same-event", courseId: STARTER_COURSE_ID, question, authorProfile: profile }, envelope);
    expect(store.listSuggestions({ status: "pending" })).toHaveLength(0);
    expect(store.listDesktopNotifications(0)).toHaveLength(0);

    receive.applySharedEvent({ type: "question", eventId: "changed-event", courseId: STARTER_COURSE_ID, question: { ...question, payload: { ...question.payload, question: "A revised question?" } }, authorProfile: profile }, envelope);
    expect(store.listSuggestions({ status: "pending" }).map((item) => item.id)).toEqual(["changed-event"]);
    expect(store.listDesktopNotifications(0).map((item) => item.entityId)).toEqual(["changed-event"]);
    sync.stop();
    store.close();
  });
});
