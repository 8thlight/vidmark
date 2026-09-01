import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { CourseCommentRecord, ProfileRecord, QuestionRecord, SharedProfile, SuggestionRecord, VidmarkDatabase } from "./vidmark-db";

type DeviceIdentity = { id: string; publicKey: string; privateKey: string; signingPublicKey: string; signingPrivateKey: string; fingerprint: string };
type EncryptedEnvelope = { iv: string; ciphertext: string; tag: string };
type RelayEnvelope = { id: string; recipientDeviceId: string; senderDeviceId: string; payload: string; createdAt: number };
type DirectShareEvent =
  | { type: "question"; eventId: string; courseId: string; question: QuestionRecord; authorProfile: SharedProfile }
  | { type: "note"; eventId: string; note: Record<string, unknown>; authorProfile: SharedProfile }
  | { type: "suggestion"; suggestion: SuggestionRecord };
export type DirectoryDevice = { deviceId: string; encryptionPublicKey: string };
export type DirectoryUser = { userId: string; deviceId: string; profile: SharedProfile; encryptionPublicKey: string; devices: DirectoryDevice[] };
export type GlobalCourseRecord = { videoId: string; ownerDeviceId: string; ownerProfile: SharedProfile; course: Record<string, unknown>; version: number; createdAt: number; updatedAt: number };
export type GlobalRevisionRecord = { id: string; videoId: string; proposerDeviceId: string; proposerProfile: SharedProfile; baseVersion: number; status: "pending" | "accepted" | "rejected"; createdAt: number; updatedAt: number };

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = <T>(value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest();
const fingerprint = (publicKey: string) => createHash("sha256").update(publicKey).digest("hex").match(/.{1,4}/g)?.slice(0, 4).join("-") ?? "unknown";

const encrypt = (key: Buffer, value: unknown): EncryptedEnvelope => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
};

const decrypt = <T>(key: Buffer, envelope: EncryptedEnvelope): T => {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8")) as T;
};

const profileForSharing = (profile: ProfileRecord) => ({ id: profile.id, name: profile.name, email: profile.email, avatarStyle: profile.avatarStyle, avatarSeed: profile.avatarSeed });

export class VidmarkSyncService {
  private readonly device: DeviceIdentity;
  private relaySocket?: WebSocket;
  private relayReconnectTimer?: ReturnType<typeof setTimeout>;
  private readonly relayAcks = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly relayRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private relayReady = false;
  private relayError = "";
  private stopping = false;

  constructor(private readonly store: VidmarkDatabase) {
    this.device = this.ensureDevice();
  }

  async start() {
    this.connectRelay();
    return this;
  }

  stop() {
    this.stopping = true;
    if (this.relayReconnectTimer) clearTimeout(this.relayReconnectTimer);
    this.relayReconnectTimer = undefined;
    this.relaySocket?.close();
    this.relaySocket = undefined;
    this.relayReady = false;
    for (const pending of this.relayAcks.values()) { clearTimeout(pending.timer); pending.reject(new Error("Relay stopped.")); }
    this.relayAcks.clear();
    for (const pending of this.relayRequests.values()) { clearTimeout(pending.timer); pending.reject(new Error("Relay stopped.")); }
    this.relayRequests.clear();
  }

  getStatus() {
    return {
      deviceId: this.device.id,
      transport: "hosted-relay",
      directSharesEndToEndEncrypted: true,
      relay: { url: this.store.getSyncPreferences().relayUrl, connected: this.relayReady, error: this.relayError },
    };
  }

  refreshRelay() {
    this.relaySocket?.close();
    this.relaySocket = undefined;
    this.relayReady = false;
    this.connectRelay();
  }

  async registerDirectory() {
    const profile = this.store.getProfile();
    if (!profile) return { registered: false };
    return this.relayRpc<{ registered: boolean }>({ type: "directory_register", profile: profileForSharing(profile), encryptionPublicKey: this.device.publicKey });
  }

  async searchDirectory(query: string) {
    return this.relayRpc<DirectoryUser[]>({ type: "directory_search", query });
  }

  async shareCourseWithUser(courseId: string, recipient: DirectoryUser) {
    const profile = this.store.getProfile();
    if (!profile) throw new Error("Create a local profile before sharing courses.");
    await this.registerDirectory();
    const devices = recipient.devices?.length ? recipient.devices : [{ deviceId: recipient.deviceId, encryptionPublicKey: recipient.encryptionPublicKey }];
    if (!devices.length || devices.some((device) => !device.deviceId || !device.encryptionPublicKey)) throw new Error("Choose a registered Vidmark user.");
    const event = { type: "course_invite", eventId: crypto.randomUUID(), bundle: this.store.exportCourseBundle(courseId), authorProfile: profileForSharing(profile), senderPublicKey: this.device.publicKey };
    await Promise.all(devices.map(async (device) => {
      const envelope = encrypt(this.sharedKey(device.encryptionPublicKey), event);
      await this.publishRelay(device.deviceId, `course.${encode({ senderPublicKey: this.device.publicKey, envelope })}`, crypto.randomUUID());
    }));
    return { eventId: event.eventId, delivered: devices.map((device) => device.deviceId), recipient: recipient.profile };
  }

  private inviteLink(token: string) {
    const relay = new URL(this.store.getSyncPreferences().relayUrl);
    relay.protocol = relay.protocol === "wss:" ? "https:" : "http:";
    relay.pathname = `/invite/${token}`;
    relay.search = "";
    relay.hash = "";
    return relay.toString();
  }

  private inviteToken(link: string) {
    let invite: URL;
    try { invite = new URL(link.trim()); } catch { throw new Error("Paste a complete HTTPS Vidmark invite URL."); }
    const relay = new URL(this.store.getSyncPreferences().relayUrl);
    const relayProtocol = relay.protocol === "wss:" ? "https:" : "http:";
    const match = invite.pathname.match(/^\/invite\/([^/?#]+)$/);
    if (!match || invite.protocol !== relayProtocol || invite.host !== relay.host) throw new Error("This invite URL does not belong to the configured Vidmark relay.");
    return match[1];
  }

  async createCourseShareLink(courseId: string, oneTime = false) {
    const profile = this.store.getProfile();
    if (!profile) throw new Error("Create a local profile before sharing courses.");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const payload = { bundle: this.store.exportCourseBundle(courseId), authorProfile: profileForSharing(profile), senderDeviceId: this.device.id };
    await this.relayRpc({ type: "link_create", token, payload, expiresAt, oneTime });
    return { link: this.inviteLink(token), expiresAt, oneTime };
  }

  async importCourseShareLink(link: string) {
    const token = this.inviteToken(link);
    const result = await this.relayRpc<{ payload: { bundle: Record<string, unknown>; authorProfile: SharedProfile; senderDeviceId: string }; expiresAt: number }>({ type: "link_resolve", token });
    const payload = result.payload;
    const course = payload.bundle.course as Record<string, unknown> | undefined;
    const item = this.store.addInboxItem({ id: `link:${token}`, type: "course_invite", title: `${payload.authorProfile.name} shared a course`, preview: String(course?.title ?? "Course invitation"), payload: payload.bundle, senderProfile: payload.authorProfile, senderDeviceId: payload.senderDeviceId });
    return { invite: item };
  }

  async revokeCourseShareLink(link: string) {
    const token = this.inviteToken(link);
    return this.relayRpc<{ revoked: boolean }>({ type: "link_revoke", token });
  }

  async getGlobalCourse(videoId: string) {
    return this.relayRpc<GlobalCourseRecord | null>({ type: "global_get", videoId });
  }

  async publishOrProposeCourse(courseId: string) {
    const profile = this.store.getProfile(); if (!profile) throw new Error("Create a local profile before publishing courses.");
    const bundle = this.store.exportCourseBundle(courseId); const course = bundle.course as Record<string, unknown>; const videoId = String(course.videoId ?? course.id);
    const existing = await this.getGlobalCourse(videoId);
    if (!existing || existing.ownerDeviceId === this.device.id) {
      const published = await this.relayRpc<Omit<GlobalCourseRecord, "course">>({ type: "global_publish", videoId, course: bundle, profile: profileForSharing(profile), baseVersion: existing?.version ?? 0 });
      this.store.setCourseCollaboration(courseId, { visibility: "public", globalVersion: published.version, globalOwnerDeviceId: this.device.id, globalLocked: true });
      return { mode: existing ? "published_revision" : "registered_global", global: published };
    }
    const revision = await this.relayRpc<GlobalRevisionRecord>({ type: "global_propose_revision", videoId, course: bundle, profile: profileForSharing(profile) });
    this.store.setCourseCollaboration(courseId, { visibility: "private", globalVersion: existing.version, globalOwnerDeviceId: existing.ownerDeviceId, globalLocked: false });
    return { mode: "proposed_revision", revision, global: existing };
  }

  setCoursePrivate(courseId: string) {
    return this.store.setCourseCollaboration(courseId, { visibility: "private", globalLocked: false });
  }

  async importGlobalCourse(videoId: string) {
    const global = await this.getGlobalCourse(videoId); if (!global) throw new Error("No global course is registered for this video.");
    const imported = this.store.importCourseBundle(global.course, { visibility: "public", globalVersion: global.version, globalOwnerDeviceId: global.ownerDeviceId, globalLocked: true });
    return { global, course: imported };
  }

  async listGlobalRevisions(videoId: string) {
    return this.relayRpc<GlobalRevisionRecord[]>({ type: "global_list_revisions", videoId });
  }

  async reviewGlobalRevision(revisionId: string, decision: "accepted" | "rejected", videoId: string) {
    const result = await this.relayRpc<{ id: string; status: string; version: number }>({ type: "global_review_revision", revisionId, decision });
    if (decision === "accepted") await this.importGlobalCourse(videoId);
    return result;
  }

  async listComments(videoId: string) {
    const comments = await this.relayRpc<CourseCommentRecord[]>({ type: "comments_list", videoId });
    this.store.cacheCourseComments(comments);
    return comments;
  }

  async postComment(courseId: string, body: string, parentId?: string) {
    const profile = this.store.getProfile(); if (!profile) throw new Error("Create a local profile before commenting.");
    const course = this.store.getCourse(courseId) as Record<string, unknown> | null; if (!course) throw new Error(`Course ${courseId} was not found.`);
    const comment = await this.relayRpc<CourseCommentRecord>({ type: "comments_post", videoId: String(course.videoId ?? courseId), courseId, parentId, body, profile: profileForSharing(profile) });
    this.store.upsertCourseComment(comment);
    return comment;
  }

  async shareQuestionWithUser(recipient: DirectoryUser, question: QuestionRecord) {
    const profile = this.store.getProfile();
    if (!profile) throw new Error("Create a local profile before sharing questions.");
    const eventId = crypto.randomUUID();
    const event: DirectShareEvent = { type: "question", eventId, courseId: question.courseId, question, authorProfile: profileForSharing(profile) };
    return { eventId, delivered: await this.shareDirectoryEvent(recipient, event) };
  }

  async shareNoteWithUser(recipient: DirectoryUser, note: Record<string, unknown>) {
    const profile = this.store.getProfile();
    if (!profile) throw new Error("Create a local profile before sharing notes.");
    const eventId = crypto.randomUUID();
    const event: DirectShareEvent = { type: "note", eventId, note: { ...note, audio: undefined, audioUrl: undefined, hasAudio: false }, authorProfile: profileForSharing(profile) };
    return { eventId, delivered: await this.shareDirectoryEvent(recipient, event) };
  }

  async shareSuggestionWithUser(recipient: DirectoryUser, suggestion: SuggestionRecord) {
    const profile = this.store.getProfile();
    if (!profile) throw new Error("Create a local profile before sharing suggestions.");
    const event: DirectShareEvent = { type: "suggestion", suggestion: { ...suggestion, authorProfile: profileForSharing(profile), authorDeviceId: this.device.id } };
    return { ok: true, suggestionId: suggestion.id, delivered: await this.shareDirectoryEvent(recipient, event) };
  }

  private async shareDirectoryEvent(recipient: DirectoryUser, event: DirectShareEvent) {
    await this.registerDirectory();
    const devices = recipient.devices?.length ? recipient.devices : [{ deviceId: recipient.deviceId, encryptionPublicKey: recipient.encryptionPublicKey }];
    if (!devices.length || devices.some((device) => !device.deviceId || !device.encryptionPublicKey)) throw new Error("Choose a registered Vidmark user.");
    await Promise.all(devices.map(async (device) => {
      const envelope = encrypt(this.sharedKey(device.encryptionPublicKey), event);
      await this.publishRelay(device.deviceId, `direct.${encode({ senderPublicKey: this.device.publicKey, envelope })}`, crypto.randomUUID());
    }));
    return devices.map((device) => device.deviceId);
  }

  private connectRelay() {
    if (this.stopping || this.relaySocket) return;
    const relayUrl = this.store.getSyncPreferences().relayUrl;
    if (!relayUrl) return;
    try {
      const timestamp = Date.now();
      const proof = `vidmark-relay-v1:${this.device.id}:${timestamp}`;
      const signature = sign(null, Buffer.from(proof), createPrivateKey(this.device.signingPrivateKey)).toString("base64url");
      const url = new URL(relayUrl);
      url.searchParams.set("deviceId", this.device.id);
      url.searchParams.set("publicKey", Buffer.from(this.device.signingPublicKey).toString("base64url"));
      url.searchParams.set("timestamp", String(timestamp));
      url.searchParams.set("signature", signature);
      const socket = new WebSocket(url);
      this.relaySocket = socket;
      socket.addEventListener("open", () => { this.relayError = ""; });
      socket.addEventListener("message", (message) => { void this.handleRelayMessage(String(message.data)); });
      socket.addEventListener("error", () => { this.relayError = "Could not reach the sync relay."; });
      socket.addEventListener("close", () => {
        if (this.relaySocket === socket) this.relaySocket = undefined;
        this.relayReady = false;
        if (!this.stopping) this.relayReconnectTimer = setTimeout(() => this.connectRelay(), 1500);
      });
    } catch (error) {
      this.relayError = error instanceof Error ? error.message : "Could not configure the sync relay.";
      if (!this.stopping) this.relayReconnectTimer = setTimeout(() => this.connectRelay(), 3000);
    }
  }

  private async handleRelayMessage(raw: string) {
    const message = JSON.parse(raw) as { type?: string; id?: string; requestId?: string; ok?: boolean; result?: unknown; error?: string; envelope?: RelayEnvelope; event?: Record<string, unknown> };
    if (message.type === "ready") { this.relayReady = true; this.relayError = ""; void this.registerDirectory().catch((error) => { this.relayError = error instanceof Error ? error.message : "Could not register the learner directory profile."; }); return; }
    if (message.type === "response" && message.requestId) {
      const pending = this.relayRequests.get(message.requestId);
      if (pending) { clearTimeout(pending.timer); this.relayRequests.delete(message.requestId); if (message.ok) pending.resolve(message.result); else pending.reject(new Error(message.error ?? "Relay request failed.")); }
      return;
    }
    if (message.type === "server_event" && message.event?.type === "revision_invite") {
      const profile = message.event.proposerProfile as SharedProfile;
      this.store.addInboxItem({ id: `revision:${String(message.event.id)}`, type: "revision", title: `${profile?.name ?? "A collaborator"} proposed a course revision`, preview: `Review the proposed public revision for video ${String(message.event.videoId ?? "")}.`, payload: message.event, senderProfile: profile, createdAt: Number(message.event.createdAt ?? Date.now()) });
      return;
    }
    if (message.type === "server_event" && message.event?.type === "revision_decision") {
      const decision = message.event.decision === "accepted" ? "accepted" : "rejected";
      this.store.addInboxItem({ id: `revision-decision:${String(message.event.id)}`, type: "revision", title: `Your course revision was ${decision}`, preview: `The global course owner ${decision} your proposed update for video ${String(message.event.videoId ?? "")}.`, payload: message.event, actionStatus: "none", createdAt: Number(message.event.createdAt ?? Date.now()) });
      return;
    }
    if (message.type === "server_event" && message.event?.type === "comment_reply") {
      const profile = message.event.authorProfile as SharedProfile;
      this.store.addInboxItem({ id: `comment-reply:${String(message.event.id)}`, type: "message", title: `${profile?.name ?? "A collaborator"} replied to your comment`, preview: String(message.event.body ?? "Open the public course discussion to read the reply."), payload: message.event, senderProfile: profile, senderDeviceId: String(message.event.authorDeviceId ?? "") || undefined, actionStatus: "none", notificationTarget: "discussion", createdAt: Number(message.event.createdAt ?? Date.now()) });
      return;
    }
    if (message.type === "stored" && message.id) {
      const pending = this.relayAcks.get(message.id);
      if (pending) { clearTimeout(pending.timer); this.relayAcks.delete(message.id); pending.resolve(); }
      return;
    }
    if (message.type === "error") { this.relayError = message.error ?? "Relay rejected a message."; return; }
    if (message.type !== "event" || !message.envelope) return;
    try {
      await this.receiveRelayEnvelope(message.envelope);
      this.relaySocket?.send(JSON.stringify({ type: "ack", id: message.envelope.id }));
    } catch (error) {
      this.relayError = error instanceof Error ? error.message : "An encrypted direct share could not be processed.";
    }
  }

  private async receiveRelayEnvelope(relayEnvelope: RelayEnvelope) {
    if (relayEnvelope.recipientDeviceId !== this.device.id) throw new Error("Relay envelope recipient did not match this device.");
    if (relayEnvelope.payload.startsWith("course.")) {
      const packet = decode<{ senderPublicKey: string; envelope: EncryptedEnvelope }>(relayEnvelope.payload.slice(7));
      const event = decrypt<{ type: "course_invite"; eventId: string; bundle: Record<string, unknown>; authorProfile: SharedProfile; senderPublicKey: string }>(this.sharedKey(packet.senderPublicKey), packet.envelope);
      if (event.type !== "course_invite" || event.senderPublicKey !== packet.senderPublicKey) throw new Error("Encrypted course invitation is invalid.");
      const course = event.bundle.course as Record<string, unknown> | undefined;
      this.store.addInboxItem({ id: event.eventId, type: "course_invite", title: `${event.authorProfile.name} shared a course`, preview: String(course?.title ?? "Course invitation"), payload: event.bundle, senderProfile: event.authorProfile, senderDeviceId: relayEnvelope.senderDeviceId, createdAt: relayEnvelope.createdAt });
      return;
    }
    if (relayEnvelope.payload.startsWith("direct.")) {
      const packet = decode<{ senderPublicKey: string; envelope: EncryptedEnvelope }>(relayEnvelope.payload.slice(7));
      const event = decrypt<DirectShareEvent>(this.sharedKey(packet.senderPublicKey), packet.envelope);
      this.applySharedEvent(event, relayEnvelope);
      return;
    }
    throw new Error("Unsupported relay payload.");
  }

  private applySharedEvent(event: DirectShareEvent, relayEnvelope: RelayEnvelope) {
    if (event.type === "question") {
      const existing = this.store.getQuestion(event.courseId, event.question.id);
      const autoImport = this.store.getSyncPreferences().autoImportQuestions;
      const suggestion = this.store.createSuggestion({
        id: event.eventId,
        courseId: event.courseId,
        questionId: event.question.id,
        kind: existing ? "update" : "create",
        status: "pending",
        title: existing ? "A new question has been updated" : "A new question has been added",
        rationale: `${event.authorProfile.name} shared a complete question and answer for review.`,
        proposedPatch: event.question.payload,
        sources: Array.isArray(event.question.payload.sources) ? event.question.payload.sources : [],
        authorProfile: event.authorProfile,
        authorDeviceId: relayEnvelope.senderDeviceId,
        notify: !autoImport,
      });
      if (autoImport && suggestion.status === "pending") this.store.reviewSuggestion(suggestion.id, "accepted", this.store.getProfile()?.id, "Automatically imported by user preference.");
    } else if (event.type === "note") {
      const originalId = String(event.note.id ?? event.eventId);
      this.store.upsertNote({ ...event.note, id: `shared:${relayEnvelope.senderDeviceId}:${originalId}`, originalId, source: "text", originalSource: event.note.source, sharedFromPeer: true, readOnly: true, authorProfile: event.authorProfile, authorDeviceId: relayEnvelope.senderDeviceId, updatedAt: Number(event.note.updatedAt ?? Date.now()), hasAudio: false });
      this.store.addInboxItem({ id: `note:${event.eventId}`, type: "message", title: `${event.authorProfile.name} shared a study note`, preview: String(event.note.text ?? "Open course notes to review it."), payload: { courseId: event.note.courseId, noteId: originalId }, senderProfile: event.authorProfile, senderDeviceId: relayEnvelope.senderDeviceId, actionStatus: "none", createdAt: relayEnvelope.createdAt });
    } else if (event.type === "suggestion") {
      this.store.createSuggestion({ ...event.suggestion, id: event.suggestion.id, status: "pending" });
    }
  }

  private async publishRelay(recipientDeviceId: string, payload: string, id: string) {
    const deadline = Date.now() + 5000;
    while (!this.relayReady && Date.now() < deadline) {
      if (!this.relaySocket) this.connectRelay();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!this.relayReady || !this.relaySocket) throw new Error(this.relayError || "The sync relay is unavailable.");
    const envelope: RelayEnvelope = { id, recipientDeviceId, senderDeviceId: this.device.id, payload, createdAt: Date.now() };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.relayAcks.delete(id); reject(new Error("The relay did not acknowledge the update.")); }, 5000);
      this.relayAcks.set(id, { resolve, reject, timer });
      this.relaySocket!.send(JSON.stringify({ type: "publish", envelope }));
    });
  }

  private async relayRpc<T = unknown>(message: Record<string, unknown>): Promise<T> {
    const deadline = Date.now() + 5000;
    while (!this.relayReady && Date.now() < deadline) {
      if (!this.relaySocket) this.connectRelay();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!this.relayReady || !this.relaySocket) throw new Error(this.relayError || "The sync relay is unavailable.");
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.relayRequests.delete(requestId); reject(new Error("The relay request timed out.")); }, 10_000);
      this.relayRequests.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      this.relaySocket!.send(JSON.stringify({ ...message, requestId }));
    });
  }

  private ensureDevice(): DeviceIdentity {
    const row = this.store.db.query("SELECT * FROM devices WHERE private_key IS NOT NULL LIMIT 1").get() as Record<string, unknown> | null;
    if (row) {
      let signingPublicKey = row.signing_public_key ? String(row.signing_public_key) : "";
      let signingPrivateKey = row.signing_private_key ? String(row.signing_private_key) : "";
      if (!signingPublicKey || !signingPrivateKey) {
        const signingPair = generateKeyPairSync("ed25519");
        signingPublicKey = signingPair.publicKey.export({ format: "pem", type: "spki" }).toString();
        signingPrivateKey = signingPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
        this.store.db.query("UPDATE devices SET signing_public_key=?,signing_private_key=?,updated_at=? WHERE id=?").run(signingPublicKey, signingPrivateKey, Date.now(), String(row.id));
      }
      return { id: String(row.id), publicKey: String(row.public_key), privateKey: String(row.private_key), signingPublicKey, signingPrivateKey, fingerprint: String(row.fingerprint) };
    }
    const pair = generateKeyPairSync("x25519");
    const signingPair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const signingPublicKey = signingPair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const signingPrivateKey = signingPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const device: DeviceIdentity = { id: crypto.randomUUID(), publicKey, privateKey, signingPublicKey, signingPrivateKey, fingerprint: fingerprint(publicKey) };
    const timestamp = Date.now();
    this.store.db.query("INSERT INTO devices(id,public_key,private_key,signing_public_key,signing_private_key,fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(device.id, device.publicKey, device.privateKey, device.signingPublicKey, device.signingPrivateKey, device.fingerprint, timestamp, timestamp);
    return device;
  }

  private sharedKey(recipientPublicKey: string) {
    const secret = diffieHellman({ privateKey: createPrivateKey(this.device.privateKey), publicKey: createPublicKey(recipientPublicKey) });
    return sha256(Buffer.concat([Buffer.from("vidmark-direct-v1"), secret]));
  }
}
