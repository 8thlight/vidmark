import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STARTER_COURSE_ID, VidmarkDatabase } from "./vidmark-db";
import { VidmarkSyncService } from "./vidmark-sync";

const waitFor = async <T>(read: () => T | undefined | Promise<T | undefined>, label: string, timeout = 8000): Promise<T> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const relayUrl = process.env.VIDMARK_RELAY_URL ?? "ws://127.0.0.1:31800/ws";
const relayHealthUrl = process.env.VIDMARK_RELAY_HEALTH_URL ?? relayUrl.replace(/^ws/, "http").replace(/\/ws(?:\?.*)?$/, "/health");

const root = await mkdtemp(join(tmpdir(), "vidmark-relay-check-"));
const aliceStore = new VidmarkDatabase(join(root, "alice.sqlite"));
const bobStore = new VidmarkDatabase(join(root, "bob.sqlite"));
aliceStore.saveProfile({ name: "Alice Agent", email: "alice@vidmark.local", avatarStyle: "bottts", avatarSeed: "alice" });
bobStore.saveProfile({ name: "Bob Learner", email: "bob@vidmark.local", avatarStyle: "lorelei", avatarSeed: "bob" });
const alice = await new VidmarkSyncService(aliceStore).start();
let bob = await new VidmarkSyncService(bobStore).start();

try {
  await waitFor(() => alice.getStatus().relay.connected && bob.getStatus().relay.connected ? true : undefined, "both relay connections");
  const directoryMatch = await waitFor(async () => (await alice.searchDirectory("bob@vidmark.local")).find((user) => user.profile.email === "bob@vidmark.local"), "directory email search");
  bob.stop();
  await waitFor(() => alice.getStatus().relay.connected ? true : undefined, "Alice relay connection");
  const queueBaseline = await (await fetch(relayHealthUrl)).json() as { pendingEnvelopes: number };

  const original = aliceStore.listQuestions(STARTER_COURSE_ID, { limit: 1 }).questions[0];
  if (!original) throw new Error("The starter course did not contain a question.");
  const changed = aliceStore.patchQuestion(STARTER_COURSE_ID, original.id, {
    question: "Which sync behavior preserves a shared question while its recipient is offline?",
    correctAnswer: "C",
    options: { C: { text: "Persist the encrypted envelope until acknowledgement.", rationale: "Durable store-and-forward lets an offline recipient import it later." } },
  }, original.revision);
  if (!changed) throw new Error("Alice's question update was not persisted.");
  const questionDelivery = await alice.shareQuestionWithUser(directoryMatch, changed);

  const note = { id: "relay-note-1", courseId: STARTER_COURSE_ID, chapterId: "agentic-loop-foundations", chapterTitle: "Agentic loop foundations", text: "This note crossed the encrypted Apple Container relay.", source: "text", updatedAt: Date.now(), hasAudio: false };
  aliceStore.upsertNote(note);
  const noteDelivery = await alice.shareNoteWithUser(directoryMatch, note);
  const expectedQueued = queueBaseline.pendingEnvelopes + questionDelivery.delivered.length + noteDelivery.delivered.length;
  const queued = await waitFor(async () => {
    const value = await (await fetch(relayHealthUrl)).json() as { pendingEnvelopes: number };
    return value.pendingEnvelopes === expectedQueued ? value : undefined;
  }, "offline relay queue");
  bob = await new VidmarkSyncService(bobStore).start();
  const suggestion = await waitFor(() => bobStore.listSuggestions({ status: "pending" }).find((item) => item.questionId === changed.id), "question import notification");
  const receivedNote = await waitFor(() => bobStore.listNotes(STARTER_COURSE_ID).find((item) => String(item.originalId) === note.id), "shared user note");
  if (suggestion.title !== "A new question has been updated") throw new Error(`Unexpected notification: ${suggestion.title}`);
  const autoImportDefault = bobStore.getSyncPreferences().autoImportQuestions;
  if (autoImportDefault) throw new Error("Automatic imports must be disabled by default.");

  bobStore.reviewSuggestion(suggestion.id, "accepted", bobStore.getProfile()?.id);
  const imported = bobStore.getQuestion(STARTER_COURSE_ID, changed.id);
  bobStore.saveSyncPreferences({ autoImportQuestions: true });
  const changedAgain = aliceStore.patchQuestion(STARTER_COURSE_ID, changed.id, { question: "Which relay behavior supports offline imports and automatic user-approved syncing?" }, changed.revision);
  if (!changedAgain) throw new Error("Alice's automatic-import test update was not persisted.");
  const autoEvent = await alice.shareQuestionWithUser(directoryMatch, changedAgain);
  const autoImported = await waitFor(() => bobStore.listSuggestions({ status: "accepted" }).find((item) => item.id === autoEvent.eventId), "automatic question import");

  const collaborationVideoId = crypto.randomUUID().replaceAll("-", "").slice(0, 11);
  aliceStore.upsertCourse({ id: collaborationVideoId, title: "Agentic Collaboration Test", source: "Vidmark QA", videoUrl: `https://www.youtube.com/watch?v=${collaborationVideoId}`, originPrompt: "Verify complete course collaboration.", promptCredit: "Vidmark QA" });
  aliceStore.upsertQuestion(collaborationVideoId, { ...aliceStore.listQuestions(STARTER_COURSE_ID, { limit: 1 }).questions[0]!.payload, id: "collab-q1", question: "Which version is global?" });
  aliceStore.saveConceptGraph(collaborationVideoId, {
    schemaVersion: "1.0.0",
    graphId: "collaboration-test-graph",
    title: "Agentic Collaboration Concepts",
    nodes: [
      { id: "domain-collaboration", label: "Collaboration", kind: "domain", domainId: "collaboration", summary: "Share reviewed study material with registered users." },
      { id: "encrypted-course-sharing", label: "Encrypted course sharing", kind: "concept", domainId: "collaboration", summary: "Transfer a complete course bundle without exposing private content to the relay." },
    ],
    edges: [{ source: "domain-collaboration", target: "encrypted-course-sharing", type: "contains", weight: 1, rationale: "Encrypted course transfer is part of the collaboration domain." }],
  });
  const firstGlobal = await alice.publishOrProposeCourse(collaborationVideoId);
  if (firstGlobal.mode !== "registered_global" || aliceStore.getCourse(collaborationVideoId)?.visibility !== "public") throw new Error("Alice did not register the first locked global course.");

  const directShare = await alice.shareCourseWithUser(collaborationVideoId, directoryMatch);
  const courseInvite = await waitFor(() => {
    const received = bobStore.listInbox({ status: "unread" }).find((item) => item.id === directShare.eventId);
    const relayError = String(bob.getStatus().relay.error ?? "");
    if (!received && relayError) throw new Error(`Direct course invitation failed: ${relayError}`);
    return received;
  }, "direct course invitation");
  bobStore.updateInboxItem(courseInvite.id, { status: "read" });
  if (bobStore.listInbox({ status: "unread" }).some((item) => item.id === courseInvite.id)) throw new Error("Inbox unread filtering did not update.");
  bobStore.reviewCourseInvite(courseInvite.id, "accepted");
  if (!bobStore.getCourse(collaborationVideoId) || bobStore.listQuestions(collaborationVideoId).questions.length !== 1 || bobStore.getConceptGraph(collaborationVideoId)?.graph.nodes.length !== 2) throw new Error("The complete shared course, including its concept graph, was not imported.");

  const courseLink = await alice.createCourseShareLink(collaborationVideoId);
  if (!courseLink.link.startsWith("http") || courseLink.link.includes("#") || !courseLink.link.includes("/invite/")) throw new Error("Course invite was not a normal fragment-free HTTP(S) URL.");
  const landing = await fetch(courseLink.link);
  if (!landing.ok || !(await landing.text()).includes("Vidmark course invitation")) throw new Error("Course invite URL did not serve the relay landing response.");
  const linkInvite = (await bob.importCourseShareLink(courseLink.link)).invite;
  if (linkInvite.status !== "unread" || linkInvite.type !== "course_invite") throw new Error("HTTPS invite did not create an unread course invitation.");
  const oneTimeLink = await alice.createCourseShareLink(collaborationVideoId, true);
  await bob.importCourseShareLink(oneTimeLink.link);
  let oneTimeRejected = false;
  try { await bob.importCourseShareLink(oneTimeLink.link); } catch { oneTimeRejected = true; }
  if (!oneTimeRejected) throw new Error("One-time course invite remained usable after its first import.");
  if ((await fetch(oneTimeLink.link)).status !== 404) throw new Error("Used one-time invite still appeared active over HTTP.");
  const revokedLink = await alice.createCourseShareLink(collaborationVideoId);
  await alice.revokeCourseShareLink(revokedLink.link);
  let revokedRejected = false;
  try { await bob.importCourseShareLink(revokedLink.link); } catch { revokedRejected = true; }
  if (!revokedRejected) throw new Error("Revoked course invite remained usable.");
  if ((await fetch(revokedLink.link)).status !== 404) throw new Error("Revoked invite still appeared active over HTTP.");

  const aliceGlobalQuestion = aliceStore.getQuestion(collaborationVideoId, "collab-q1");
  if (!aliceGlobalQuestion) throw new Error("Global test question was not found.");
  aliceStore.patchQuestion(collaborationVideoId, "collab-q1", { question: "Which version is the fork?" }, aliceGlobalQuestion.revision);
  const aliceFork = aliceStore.getCourse(collaborationVideoId);
  if (aliceFork?.visibility !== "private" || aliceFork.forkedFromVersion !== 1) throw new Error("Editing a locked global course did not automatically create a private fork.");

  await bob.importGlobalCourse(collaborationVideoId);
  if (bobStore.getConceptGraph(collaborationVideoId)?.graph.graphId !== "collaboration-test-graph") throw new Error("The global course did not include its concept graph.");
  const bobGlobalQuestion = bobStore.getQuestion(collaborationVideoId, "collab-q1");
  if (!bobGlobalQuestion) throw new Error("Bob did not import the global course question.");
  bobStore.patchQuestion(collaborationVideoId, "collab-q1", { question: "Bob's proposed public revision" }, bobGlobalQuestion.revision);
  const proposal = await bob.publishOrProposeCourse(collaborationVideoId);
  if (proposal.mode !== "proposed_revision") throw new Error("A non-owner fork was not submitted as a revision proposal.");
  const revision = await waitFor(async () => (await alice.listGlobalRevisions(collaborationVideoId)).find((item) => item.status === "pending"), "global revision proposal");
  await alice.reviewGlobalRevision(revision.id, "accepted", collaborationVideoId);
  const latestGlobal = await alice.getGlobalCourse(collaborationVideoId);
  if (latestGlobal?.version !== 2) throw new Error("Accepting the revision did not advance the global version.");
  const revisionDecision = await waitFor(() => bobStore.listInbox({ type: "revision" }).find((item) => item.id === `revision-decision:${revision.id}`), "revision decision notification");

  const rootComment = await alice.postComment(collaborationVideoId, "Public comment keyed by the YouTube video ID.");
  const replyComment = await bob.postComment(collaborationVideoId, "Public reply from Bob.", rootComment.id);
  const thread = await alice.listComments(collaborationVideoId);
  if (thread.length !== 2 || thread[1]?.parentId !== rootComment.id) throw new Error("Public course message threading failed.");
  const replyNotification = await waitFor(() => aliceStore.listInbox({ type: "message" }).find((item) => item.id === `comment-reply:${replyComment.id}`), "public reply notification");
  const bobDesktopNotifications = bobStore.listDesktopNotifications();
  const aliceDesktopNotifications = aliceStore.listDesktopNotifications();
  if (!bobDesktopNotifications.some((item) => item.eventId === `suggestion:${suggestion.id}` && item.target === "people")) throw new Error("Question update did not enter the desktop notification feed.");
  if (!bobDesktopNotifications.some((item) => item.eventId === `inbox:${directShare.eventId}` && item.target === "inbox")) throw new Error("Course invitation did not enter the desktop notification feed.");
  if (!aliceDesktopNotifications.some((item) => item.eventId === `inbox:comment-reply:${replyComment.id}` && item.target === "discussion")) throw new Error("Public reply did not target the desktop discussion notification.");
  const health = await (await fetch(relayHealthUrl)).json() as { ok?: boolean; connectedDevices?: number; pendingEnvelopes?: number };
  console.log(JSON.stringify({
    relay: health,
    queuedWhileBobWasOffline: queued.pendingEnvelopes - queueBaseline.pendingEnvelopes,
    users: [aliceStore.getProfile()?.name, bobStore.getProfile()?.name],
    notification: suggestion.title,
    autoImportDefault,
    autoImportVerified: autoImported.status === "accepted",
    importedQuestion: imported?.payload.question,
    importedAnswer: imported?.payload.correctAnswer,
    sharedNote: receivedNote.text,
    sharedNoteAuthor: (receivedNote.authorProfile as { name?: string } | undefined)?.name,
    directoryShareRecipient: directoryMatch.profile.email,
    courseInviteReadFilter: true,
    sharedCourseQuestions: bobStore.listQuestions(collaborationVideoId).questions.length,
    sharedCourseConceptNodes: bobStore.getConceptGraph(collaborationVideoId)?.graph.nodes.length,
    httpsInviteInbox: linkInvite.status,
    oneTimeInviteVerified: oneTimeRejected,
    revokedInviteVerified: revokedRejected,
    automaticForkFromGlobalVersion: aliceFork.forkedFromVersion,
    acceptedGlobalVersion: latestGlobal.version,
    revisionDecisionNotification: revisionDecision.title,
    publicThreadMessages: thread.length,
    publicReplyNotification: replyNotification.title,
    desktopNotificationFeeds: { alice: aliceDesktopNotifications.length, bob: bobDesktopNotifications.length },
  }, null, 2));
} finally {
  alice.stop(); bob.stop(); aliceStore.close(); bobStore.close();
  await rm(root, { recursive: true, force: true });
}
