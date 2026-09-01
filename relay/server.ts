import { Database } from "bun:sqlite";
import { createPublicKey, verify } from "node:crypto";
import type { ServerWebSocket } from "bun";

const port = Number(process.env.PORT ?? 31800);
const dataPath = process.env.DATA_PATH ?? "/data/relay.sqlite";
const maxEnvelopeBytes = 12 * 1024 * 1024;
const maxCourseBytes = 10 * 1024 * 1024;
const retentionMs = 30 * 24 * 60 * 60 * 1000;

type RelayEnvelope = {
  id: string;
  recipientDeviceId: string;
  senderDeviceId: string;
  payload: string;
  createdAt: number;
};

type ClientState = { deviceId: string; messageWindowStartedAt: number; messagesInWindow: number };

const maxSocketsPerDevice = 5;
const maxMessagesPerMinute = 120;
const maxPendingPerSender = 250;
const maxPendingBytesPerSender = 100 * 1024 * 1024;

const database = new Database(dataPath, { create: true, strict: true });
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS relay_envelopes (
    id TEXT PRIMARY KEY,
    recipient_device_id TEXT NOT NULL,
    sender_device_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS relay_devices (
    device_id TEXT PRIMARY KEY,
    signing_public_key TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS relay_pending ON relay_envelopes(recipient_device_id, created_at);
  CREATE TABLE IF NOT EXISTS relay_directory (
    device_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    avatar_style TEXT NOT NULL,
    avatar_seed TEXT NOT NULL,
    encryption_public_key TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  DROP INDEX IF EXISTS relay_directory_email;
  CREATE INDEX IF NOT EXISTS relay_directory_email_lookup ON relay_directory(email);
  CREATE INDEX IF NOT EXISTS relay_directory_name ON relay_directory(name);
  CREATE TABLE IF NOT EXISTS course_share_links (
    token TEXT PRIMARY KEY,
    creator_device_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    max_uses INTEGER NOT NULL DEFAULT 0,
    use_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS global_courses (
    video_id TEXT PRIMARY KEY,
    owner_device_id TEXT NOT NULL,
    owner_profile_json TEXT NOT NULL,
    course_json TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS global_course_revisions (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    proposer_device_id TEXT NOT NULL,
    proposer_profile_json TEXT NOT NULL,
    course_json TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS global_revisions_video ON global_course_revisions(video_id, status, created_at DESC);
  CREATE TABLE IF NOT EXISTS public_comments (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    course_id TEXT NOT NULL,
    parent_id TEXT,
    body TEXT NOT NULL,
    author_device_id TEXT NOT NULL,
    author_profile_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS public_comments_video ON public_comments(video_id, created_at);
`);
const shareLinkColumns = new Set((database.query("PRAGMA table_info(course_share_links)").all() as Array<{ name: string }>).map((column) => column.name));
if (!shareLinkColumns.has("payload_json")) database.exec("ALTER TABLE course_share_links ADD COLUMN payload_json TEXT");
if (!shareLinkColumns.has("revoked_at")) database.exec("ALTER TABLE course_share_links ADD COLUMN revoked_at INTEGER");
if (!shareLinkColumns.has("max_uses")) database.exec("ALTER TABLE course_share_links ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 0");
if (!shareLinkColumns.has("use_count")) database.exec("ALTER TABLE course_share_links ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0");
if (shareLinkColumns.has("encrypted_payload")) database.exec("ALTER TABLE course_share_links DROP COLUMN encrypted_payload");

const sockets = new Map<string, Set<ServerWebSocket<ClientState>>>();
const sendJson = (socket: ServerWebSocket<ClientState>, value: unknown) => socket.send(JSON.stringify(value));
const pendingFor = (deviceId: string) => database.query("SELECT id,recipient_device_id,sender_device_id,payload,created_at FROM relay_envelopes WHERE recipient_device_id=? AND expires_at>? ORDER BY created_at").all(deviceId, Date.now()) as Array<Record<string, unknown>>;
const deliverPending = (socket: ServerWebSocket<ClientState>) => {
  for (const row of pendingFor(socket.data.deviceId)) sendJson(socket, { type: "event", envelope: { id: row.id, recipientDeviceId: row.recipient_device_id, senderDeviceId: row.sender_device_id, payload: row.payload, createdAt: row.created_at } });
};
const validId = (value: unknown) => typeof value === "string" && value.length >= 8 && value.length <= 160;

const cleanup = () => {
  database.query("DELETE FROM relay_envelopes WHERE expires_at<=?").run(Date.now());
  database.query("DELETE FROM course_share_links WHERE expires_at<=?").run(Date.now());
};
const cleanupTimer = setInterval(cleanup, 60 * 60 * 1000);
cleanup();

const server = Bun.serve<ClientState>({
  hostname: "0.0.0.0",
  port,
  fetch(request, server) {
    const url = new URL(request.url);
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/health") {
      const pending = database.query("SELECT COUNT(*) count FROM relay_envelopes WHERE expires_at>?").get(Date.now()) as { count: number };
      const directoryProfiles = database.query("SELECT COUNT(*) count FROM relay_directory").get() as { count: number };
      const globalCourses = database.query("SELECT COUNT(*) count FROM global_courses").get() as { count: number };
      return Response.json({ ok: true, name: "vidmark-relay", version: 2, connectedDevices: sockets.size, pendingEnvelopes: pending.count, directoryProfiles: directoryProfiles.count, globalCourses: globalCourses.count });
    }
    const inviteRoute = url.pathname.match(/^\/invite\/([^/]+)$/);
    if ((request.method === "GET" || request.method === "HEAD") && inviteRoute) {
      const invite = database.query("SELECT expires_at,revoked_at,max_uses,use_count FROM course_share_links WHERE token=? AND payload_json IS NOT NULL").get(inviteRoute[1]) as Record<string, unknown> | null;
      const active = Boolean(invite && !invite.revoked_at && Number(invite.expires_at) > Date.now() && (!Number(invite.max_uses) || Number(invite.use_count) < Number(invite.max_uses)));
      if (!active) return new Response("Vidmark invite not found or expired.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      return new Response(request.method === "HEAD" ? null : "This is a Vidmark course invitation. Copy this URL into Vidmark’s Share panel to review the course before importing it.", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/ws") {
      const deviceId = url.searchParams.get("deviceId") ?? "";
      const publicKey = Buffer.from(url.searchParams.get("publicKey") ?? "", "base64url").toString("utf8");
      const timestamp = Number(url.searchParams.get("timestamp") ?? 0);
      const signature = Buffer.from(url.searchParams.get("signature") ?? "", "base64url");
      if (!validId(deviceId) || !publicKey || Math.abs(Date.now() - timestamp) > 60_000) return Response.json({ error: "Relay authentication is missing or expired." }, { status: 401 });
      const proof = `vidmark-relay-v1:${deviceId}:${timestamp}`;
      let authenticated = false;
      try { authenticated = verify(null, Buffer.from(proof), createPublicKey(publicKey), signature); } catch { authenticated = false; }
      if (!authenticated) return Response.json({ error: "Relay signature is invalid." }, { status: 401 });
      const existing = database.query("SELECT signing_public_key FROM relay_devices WHERE device_id=?").get(deviceId) as { signing_public_key: string } | null;
      if (existing && existing.signing_public_key !== publicKey) return Response.json({ error: "This device ID is already registered to another signing key." }, { status: 403 });
      const now = Date.now();
      database.query("INSERT INTO relay_devices(device_id,signing_public_key,first_seen_at,last_seen_at) VALUES (?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET last_seen_at=excluded.last_seen_at").run(deviceId, publicKey, now, now);
      if ((sockets.get(deviceId)?.size ?? 0) >= maxSocketsPerDevice) return Response.json({ error: "This device has too many active relay connections." }, { status: 429 });
      if (server.upgrade(request, { data: { deviceId, messageWindowStartedAt: Date.now(), messagesInWindow: 0 } })) return;
      return Response.json({ error: "WebSocket upgrade failed." }, { status: 500 });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
  websocket: {
    maxPayloadLength: maxEnvelopeBytes + 1024 * 1024,
    open(socket) {
      const deviceSockets = sockets.get(socket.data.deviceId) ?? new Set<ServerWebSocket<ClientState>>();
      deviceSockets.add(socket);
      sockets.set(socket.data.deviceId, deviceSockets);
      sendJson(socket, { type: "ready", deviceId: socket.data.deviceId });
      deliverPending(socket);
    },
    message(socket, raw) {
      try {
        const windowNow = Date.now();
        if (windowNow - socket.data.messageWindowStartedAt >= 60_000) {
          socket.data.messageWindowStartedAt = windowNow;
          socket.data.messagesInWindow = 0;
        }
        socket.data.messagesInWindow += 1;
        if (socket.data.messagesInWindow > maxMessagesPerMinute) throw new Error("Relay message rate limit exceeded.");
        const message = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")) as Record<string, unknown> & { type?: string; envelope?: RelayEnvelope; id?: string; requestId?: string };
        const respond = (result?: unknown, error?: string) => sendJson(socket, { type: "response", requestId: message.requestId, ok: !error, result, error });
        if (message.type === "directory_register") {
          const profile = message.profile as Record<string, unknown> | undefined;
          const encryptionPublicKey = String(message.encryptionPublicKey ?? "");
          if (!profile || !validId(profile.id) || !String(profile.name ?? "").trim() || !String(profile.email ?? "").includes("@") || !encryptionPublicKey.includes("PUBLIC KEY")) throw new Error("Directory profile is incomplete.");
          database.query(`INSERT INTO relay_directory(device_id,profile_id,name,email,avatar_style,avatar_seed,encryption_public_key,updated_at) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(device_id) DO UPDATE SET profile_id=excluded.profile_id,name=excluded.name,email=excluded.email,avatar_style=excluded.avatar_style,avatar_seed=excluded.avatar_seed,encryption_public_key=excluded.encryption_public_key,updated_at=excluded.updated_at`)
            .run(socket.data.deviceId, String(profile.id), String(profile.name).trim(), String(profile.email).trim().toLowerCase(), String(profile.avatarStyle ?? "bottts"), String(profile.avatarSeed ?? profile.name), encryptionPublicKey, Date.now());
          respond({ registered: true }); return;
        }
        if (message.type === "directory_search") {
          const query = String(message.query ?? "").trim().toLowerCase();
          if (query.length < 2) { respond([]); return; }
          const matches = database.query("SELECT device_id,profile_id,name,email,avatar_style,avatar_seed,encryption_public_key,updated_at FROM relay_directory WHERE device_id<>? AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ?) ORDER BY updated_at DESC,name LIMIT 50").all(socket.data.deviceId, `%${query}%`, `%${query}%`) as Array<Record<string, unknown>>;
          const users = new Map<string, { userId: string; deviceId: string; profile: Record<string, unknown>; encryptionPublicKey: string; devices: Array<{ deviceId: string; encryptionPublicKey: string }> }>();
          for (const row of matches) {
            const email = String(row.email).trim().toLowerCase();
            const device = { deviceId: String(row.device_id), encryptionPublicKey: String(row.encryption_public_key) };
            const existingUser = users.get(email);
            if (existingUser) existingUser.devices.push(device);
            else users.set(email, { userId: email, deviceId: device.deviceId, profile: { id: row.profile_id, name: row.name, email, avatarStyle: row.avatar_style, avatarSeed: row.avatar_seed }, encryptionPublicKey: device.encryptionPublicKey, devices: [device] });
          }
          respond([...users.values()].slice(0, 20)); return;
        }
        if (message.type === "link_create") {
          const token = String(message.token ?? ""); const payloadJson = JSON.stringify(message.payload ?? null);
          if (!validId(token) || message.payload === undefined || Buffer.byteLength(payloadJson) > maxEnvelopeBytes) throw new Error("Course share link payload is invalid or too large.");
          const expiresAt = Math.min(Number(message.expiresAt ?? Date.now() + retentionMs), Date.now() + retentionMs);
          database.query("INSERT INTO course_share_links(token,creator_device_id,payload_json,created_at,expires_at,max_uses,use_count) VALUES (?,?,?,?,?,?,0)").run(token, socket.data.deviceId, payloadJson, Date.now(), expiresAt, message.oneTime ? 1 : 0);
          respond({ token, expiresAt, oneTime: Boolean(message.oneTime) }); return;
        }
        if (message.type === "link_resolve") {
          const row = database.query("SELECT payload_json,expires_at,max_uses,use_count FROM course_share_links WHERE token=? AND payload_json IS NOT NULL AND expires_at>? AND revoked_at IS NULL AND (max_uses=0 OR use_count<max_uses)").get(String(message.token ?? ""), Date.now()) as Record<string, unknown> | null;
          if (!row) throw new Error("This course share link is missing or expired.");
          database.query("UPDATE course_share_links SET use_count=use_count+1 WHERE token=?").run(String(message.token));
          respond({ payload: JSON.parse(String(row.payload_json)), expiresAt: row.expires_at, remainingUses: Number(row.max_uses) ? Math.max(0, Number(row.max_uses) - Number(row.use_count) - 1) : null }); return;
        }
        if (message.type === "link_revoke") {
          const result = database.query("UPDATE course_share_links SET revoked_at=? WHERE token=? AND creator_device_id=? AND revoked_at IS NULL").run(Date.now(), String(message.token ?? ""), socket.data.deviceId);
          if (!result.changes) throw new Error("This invite was not found, was already revoked, or belongs to another device.");
          respond({ revoked: true }); return;
        }
        if (message.type === "global_get") {
          const row = database.query("SELECT * FROM global_courses WHERE video_id=?").get(String(message.videoId ?? "")) as Record<string, unknown> | null;
          respond(row ? { videoId: row.video_id, ownerDeviceId: row.owner_device_id, ownerProfile: JSON.parse(String(row.owner_profile_json)), course: JSON.parse(String(row.course_json)), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at } : null); return;
        }
        if (message.type === "global_publish") {
          const videoId = String(message.videoId ?? ""); const courseJson = JSON.stringify(message.course ?? null); const profile = message.profile as Record<string, unknown> | undefined;
          if (!validId(videoId) || !profile || Buffer.byteLength(courseJson) > maxCourseBytes) throw new Error("Global course payload is invalid or too large.");
          const existing = database.query("SELECT * FROM global_courses WHERE video_id=?").get(videoId) as Record<string, unknown> | null;
          if (existing && String(existing.owner_device_id) !== socket.data.deviceId) throw new Error("This video's global course is registered to another user. Submit a revision instead.");
          const baseVersion = Number(message.baseVersion ?? 0); if (existing && baseVersion !== Number(existing.version)) throw new Error(`Global revision conflict: expected ${baseVersion}, current version is ${existing.version}.`);
          const version = existing ? Number(existing.version) + 1 : 1; const timestamp = Date.now();
          database.query(`INSERT INTO global_courses(video_id,owner_device_id,owner_profile_json,course_json,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(video_id) DO UPDATE SET owner_profile_json=excluded.owner_profile_json,course_json=excluded.course_json,version=excluded.version,updated_at=excluded.updated_at`)
            .run(videoId, socket.data.deviceId, JSON.stringify(profile), courseJson, version, Number(existing?.created_at ?? timestamp), timestamp);
          respond({ videoId, ownerDeviceId: socket.data.deviceId, ownerProfile: profile, version, createdAt: Number(existing?.created_at ?? timestamp), updatedAt: timestamp }); return;
        }
        if (message.type === "global_propose_revision") {
          const videoId = String(message.videoId ?? ""); const courseJson = JSON.stringify(message.course ?? null); const profile = message.profile as Record<string, unknown> | undefined;
          const global = database.query("SELECT version,owner_device_id FROM global_courses WHERE video_id=?").get(videoId) as Record<string, unknown> | null;
          if (!global || !profile || Buffer.byteLength(courseJson) > maxCourseBytes) throw new Error("A global course must exist before proposing a revision.");
          const id = crypto.randomUUID(); const timestamp = Date.now();
          database.query("INSERT INTO global_course_revisions(id,video_id,proposer_device_id,proposer_profile_json,course_json,base_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',?,?)")
            .run(id, videoId, socket.data.deviceId, JSON.stringify(profile), courseJson, Number(global.version), timestamp, timestamp);
          const ownerDeviceId = String(global.owner_device_id); if (ownerDeviceId !== socket.data.deviceId) for (const recipient of sockets.get(ownerDeviceId) ?? []) sendJson(recipient, { type: "server_event", event: { type: "revision_invite", id, videoId, proposerProfile: profile, createdAt: timestamp } });
          respond({ id, videoId, baseVersion: global.version, status: "pending" }); return;
        }
        if (message.type === "global_list_revisions") {
          const rows = database.query("SELECT id,video_id,proposer_device_id,proposer_profile_json,base_version,status,created_at,updated_at FROM global_course_revisions WHERE video_id=? ORDER BY created_at DESC").all(String(message.videoId ?? "")) as Array<Record<string, unknown>>;
          respond(rows.map((row) => ({ id: row.id, videoId: row.video_id, proposerDeviceId: row.proposer_device_id, proposerProfile: JSON.parse(String(row.proposer_profile_json)), baseVersion: row.base_version, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }))); return;
        }
        if (message.type === "global_review_revision") {
          const revision = database.query("SELECT * FROM global_course_revisions WHERE id=?").get(String(message.revisionId ?? "")) as Record<string, unknown> | null;
          if (!revision) throw new Error("Global course revision was not found.");
          const global = database.query("SELECT * FROM global_courses WHERE video_id=?").get(String(revision.video_id)) as Record<string, unknown>;
          if (String(global.owner_device_id) !== socket.data.deviceId) throw new Error("Only the global course owner can review revisions.");
          if (String(revision.status) !== "pending") throw new Error("This revision has already been reviewed.");
          const decision = message.decision === "accepted" ? "accepted" : "rejected"; const timestamp = Date.now();
          if (decision === "accepted") database.query("UPDATE global_courses SET course_json=?,version=version+1,updated_at=? WHERE video_id=?").run(String(revision.course_json), timestamp, String(revision.video_id));
          database.query("UPDATE global_course_revisions SET status=?,updated_at=? WHERE id=?").run(decision, timestamp, String(revision.id));
          const proposerDeviceId = String(revision.proposer_device_id);
          if (proposerDeviceId !== socket.data.deviceId) for (const recipient of sockets.get(proposerDeviceId) ?? []) sendJson(recipient, { type: "server_event", event: { type: "revision_decision", id: revision.id, videoId: revision.video_id, decision, createdAt: timestamp } });
          respond({ id: revision.id, status: decision, version: decision === "accepted" ? Number(global.version) + 1 : global.version }); return;
        }
        if (message.type === "comments_list") {
          const rows = database.query("SELECT * FROM public_comments WHERE video_id=? ORDER BY created_at").all(String(message.videoId ?? "")) as Array<Record<string, unknown>>;
          respond(rows.map((row) => ({ id: row.id, videoId: row.video_id, courseId: row.course_id, parentId: row.parent_id, body: row.body, authorDeviceId: row.author_device_id, authorProfile: JSON.parse(String(row.author_profile_json)), createdAt: row.created_at, updatedAt: row.updated_at }))); return;
        }
        if (message.type === "comments_post") {
          const body = String(message.body ?? "").trim(); const profile = message.profile as Record<string, unknown> | undefined; const videoId = String(message.videoId ?? "");
          if (!validId(videoId) || !profile || !body || body.length > 5000) throw new Error("Comment must contain 1–5,000 characters.");
          const comment = { id: crypto.randomUUID(), videoId, courseId: String(message.courseId ?? videoId), parentId: message.parentId ? String(message.parentId) : undefined, body, authorDeviceId: socket.data.deviceId, authorProfile: profile, createdAt: Date.now(), updatedAt: Date.now() };
          const parent = comment.parentId ? database.query("SELECT author_device_id FROM public_comments WHERE id=? AND video_id=?").get(comment.parentId, videoId) as { author_device_id: string } | null : null;
          if (comment.parentId && !parent) throw new Error("The comment being replied to was not found for this video.");
          database.query("INSERT INTO public_comments(id,video_id,course_id,parent_id,body,author_device_id,author_profile_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
            .run(comment.id, comment.videoId, comment.courseId, comment.parentId ?? null, comment.body, comment.authorDeviceId, JSON.stringify(profile), comment.createdAt, comment.updatedAt);
          if (parent && parent.author_device_id !== socket.data.deviceId) for (const recipient of sockets.get(parent.author_device_id) ?? []) sendJson(recipient, { type: "server_event", event: { type: "comment_reply", id: comment.id, videoId, courseId: comment.courseId, parentId: comment.parentId, body: comment.body, authorDeviceId: comment.authorDeviceId, authorProfile: profile, createdAt: comment.createdAt } });
          respond(comment); return;
        }
        if (message.type === "publish" && message.envelope) {
          const envelope = message.envelope;
          if (!validId(envelope.id) || !validId(envelope.recipientDeviceId) || envelope.senderDeviceId !== socket.data.deviceId || typeof envelope.payload !== "string") throw new Error("Invalid relay envelope.");
          if (Buffer.byteLength(envelope.payload, "utf8") > maxEnvelopeBytes) throw new Error("Relay envelopes are limited to 12 MiB.");
          if (!envelope.payload.startsWith("course.") && !envelope.payload.startsWith("direct.")) throw new Error("Unsupported private delivery payload.");
          const packet = JSON.parse(Buffer.from(envelope.payload.slice(7), "base64url").toString("utf8")) as { senderPublicKey?: string };
          const directory = database.query("SELECT encryption_public_key FROM relay_directory WHERE device_id=?").get(socket.data.deviceId) as { encryption_public_key: string } | null;
          if (!directory || packet.senderPublicKey !== directory.encryption_public_key) throw new Error("Direct-share sender key does not match the registered directory key.");
          const recipient = database.query("SELECT 1 registered FROM relay_devices WHERE device_id=?").get(envelope.recipientDeviceId) as { registered: number } | null;
          if (!recipient) throw new Error("The recipient has not registered with this relay.");
          const senderUsage = database.query("SELECT COUNT(*) count,COALESCE(SUM(LENGTH(CAST(payload AS BLOB))),0) bytes FROM relay_envelopes WHERE sender_device_id=? AND expires_at>?").get(socket.data.deviceId, Date.now()) as { count: number; bytes: number };
          if (senderUsage.count >= maxPendingPerSender || senderUsage.bytes + Buffer.byteLength(envelope.payload, "utf8") > maxPendingBytesPerSender) throw new Error("This device's pending relay queue is full.");
          const createdAt = Number.isFinite(envelope.createdAt) ? envelope.createdAt : Date.now();
          database.query("INSERT OR IGNORE INTO relay_envelopes(id,recipient_device_id,sender_device_id,payload,created_at,expires_at) VALUES (?,?,?,?,?,?)")
            .run(envelope.id, envelope.recipientDeviceId, envelope.senderDeviceId, envelope.payload, createdAt, Date.now() + retentionMs);
          sendJson(socket, { type: "stored", id: envelope.id });
          for (const recipient of sockets.get(envelope.recipientDeviceId) ?? []) sendJson(recipient, { type: "event", envelope: { ...envelope, createdAt } });
          return;
        }
        if (message.type === "ack" && validId(message.id)) {
          database.query("DELETE FROM relay_envelopes WHERE id=? AND recipient_device_id=?").run(message.id!, socket.data.deviceId);
          return;
        }
        if (message.type === "ping") sendJson(socket, { type: "pong", at: Date.now() });
      } catch (error) {
        const failure = error instanceof Error ? error.message : "Invalid relay message.";
        let requestId: string | undefined;
        try { requestId = (JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")) as { requestId?: string }).requestId; } catch { /* Invalid JSON has no RPC request ID. */ }
        sendJson(socket, requestId ? { type: "response", requestId, ok: false, error: failure } : { type: "error", error: failure });
      }
    },
    close(socket) {
      const deviceSockets = sockets.get(socket.data.deviceId);
      deviceSockets?.delete(socket);
      if (!deviceSockets?.size) sockets.delete(socket.data.deviceId);
    },
  },
});

const shutdown = () => {
  clearInterval(cleanupTimer);
  server.stop(true);
  database.close();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Vidmark encrypted-envelope relay listening on 0.0.0.0:${port} with SQLite at ${dataPath}`);
