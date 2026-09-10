import { Database } from "bun:sqlite";
import { chapterVideos, webUrl, youtubeId } from "../app/course-source";
import bundledConceptGraph from "../data/concept-graph.json";
import questionBank from "../data/question-bank.json";
import { validateConceptGraph, type ConceptGraph } from "../app/concept-graph-types";
import { applyQuestionPatch, questionPayloadsEqual } from "../app/question-diff";

export const STARTER_COURSE_ID = "reDRM0tqhNs";
export const PUBLIC_RELAY_URL = "wss://vidmark-159-223-136-163.sslip.io/ws";

export type ProfileRecord = {
  id: string;
  name: string;
  email: string;
  avatarStyle: string;
  avatarSeed: string;
  createdAt: number;
  updatedAt: number;
};

export type QuestionRecord = {
  courseId: string;
  id: string;
  position: number;
  revision: number;
  archived: boolean;
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type ConceptGraphRecord = {
  courseId: string;
  revision: number;
  graph: ConceptGraph;
  createdAt: number;
  updatedAt: number;
};

export type SuggestionRecord = {
  id: string;
  courseId: string;
  questionId?: string;
  kind: "create" | "update" | "archive";
  status: "pending" | "accepted" | "rejected";
  title: string;
  rationale: string;
  proposedPatch: Record<string, unknown>;
  sources: unknown[];
  authorProfile?: Pick<ProfileRecord, "id" | "name" | "email" | "avatarStyle" | "avatarSeed">;
  authorDeviceId?: string;
  reviewerProfileId?: string;
  reviewNote?: string;
  createdAt: number;
  updatedAt: number;
  reviewedAt?: number;
};

export type SyncPreferences = {
  autoImportQuestions: boolean;
  relayUrl: string;
};

export type SharedProfile = Pick<ProfileRecord, "id" | "name" | "email" | "avatarStyle" | "avatarSeed">;

export type InboxRecord = {
  id: string;
  type: "course_invite" | "message" | "revision";
  title: string;
  preview: string;
  status: "unread" | "read";
  actionStatus: "pending" | "accepted" | "rejected" | "none";
  payload: Record<string, unknown>;
  senderProfile?: SharedProfile;
  senderDeviceId?: string;
  createdAt: number;
  updatedAt: number;
};

export type CourseCommentRecord = {
  id: string;
  videoId: string;
  courseId: string;
  parentId?: string;
  body: string;
  authorProfile: SharedProfile;
  authorDeviceId: string;
  createdAt: number;
  updatedAt: number;
};

export type DesktopNotificationRecord = {
  sequence: number;
  eventId: string;
  kind: "course_invite" | "question" | "message" | "revision";
  title: string;
  body: string;
  target: "inbox" | "people" | "discussion";
  entityId: string;
  createdAt: number;
};

type CourseInput = {
  id: string;
  title: string;
  source?: string;
  videoUrl?: string;
  sourceUrl?: string;
  originPrompt?: string;
  promptCredit?: string;
  transcript?: Array<{ time: number; text: string }>;
  studyGuide?: string;
  chapters?: unknown[];
  questions?: unknown[];
  researchNotes?: string;
  conceptGraph?: unknown;
  updatedAt?: number;
};

const now = () => Date.now();
const json = (value: unknown) => JSON.stringify(value ?? null);
export const youtubeVideoId = youtubeId;
const parseJson = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === "string" ? JSON.parse(value) as T : fallback; }
  catch { return fallback; }
};

const mergePatch = (target: unknown, patch: unknown): unknown => {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base = target && typeof target === "object" && !Array.isArray(target) ? target as Record<string, unknown> : {};
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete next[key];
    else next[key] = mergePatch(base[key], value);
  }
  return next;
};

export class VidmarkDatabase {
  readonly db: Database;

  constructor(readonly path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.seedBundledQuestionBank();
    this.dismissRedundantQuestionSuggestions();
  }

  close() { this.db.close(); }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        avatar_style TEXT NOT NULL,
        avatar_seed TEXT NOT NULL,
        is_local INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS profiles_one_local ON profiles(is_local) WHERE is_local = 1;
      CREATE TABLE IF NOT EXISTS courses (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'YouTube',
        video_url TEXT NOT NULL DEFAULT '',
        origin_prompt TEXT NOT NULL DEFAULT '',
        prompt_credit TEXT NOT NULL DEFAULT '',
        study_guide TEXT,
        research_notes TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_cues (
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        time REAL NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY(course_id, position)
      );
      CREATE INDEX IF NOT EXISTS transcript_search ON transcript_cues(course_id, time);
      CREATE TABLE IF NOT EXISTS chapters (
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        position INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(course_id, id)
      );
      CREATE TABLE IF NOT EXISTS questions (
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        position INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(course_id, id)
      );
      CREATE INDEX IF NOT EXISTS questions_order ON questions(course_id, archived, position);
      CREATE TABLE IF NOT EXISTS concept_graphs (
        course_id TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
        schema_version TEXT NOT NULL DEFAULT '1.0.0',
        payload_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS suggestions (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        question_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('create','update','archive')),
        status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        proposed_patch_json TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        author_profile_json TEXT,
        author_device_id TEXT,
        reviewer_profile_id TEXT,
        review_note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        reviewed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS suggestions_status ON suggestions(course_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        chapter_id TEXT NOT NULL,
        chapter_title TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        has_audio INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        private_key TEXT,
        signing_public_key TEXT,
        signing_private_key TEXT,
        fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_log (
        id TEXT PRIMARY KEY,
        actor_profile_id TEXT,
        actor_device_id TEXT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox_items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('course_invite','message','revision')),
        title TEXT NOT NULL,
        preview TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('unread','read')),
        action_status TEXT NOT NULL DEFAULT 'pending' CHECK(action_status IN ('pending','accepted','rejected','none')),
        payload_json TEXT NOT NULL,
        sender_profile_json TEXT,
        sender_device_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_status ON inbox_items(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS course_comments (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        parent_id TEXT,
        body TEXT NOT NULL,
        author_profile_json TEXT NOT NULL,
        author_device_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS comments_video ON course_comments(video_id, created_at);
      CREATE TABLE IF NOT EXISTS desktop_notifications (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('course_invite','question','message','revision')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        target TEXT NOT NULL CHECK(target IN ('inbox','people','discussion')),
        entity_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS desktop_notifications_sequence ON desktop_notifications(sequence);
    `);
    try { this.db.exec("ALTER TABLE devices ADD COLUMN signing_public_key TEXT"); } catch { /* Already migrated. */ }
    try { this.db.exec("ALTER TABLE devices ADD COLUMN signing_private_key TEXT"); } catch { /* Already migrated. */ }
    try { this.db.exec("ALTER TABLE courses ADD COLUMN video_id TEXT NOT NULL DEFAULT ''"); } catch { /* Already migrated. */ }
    try { this.db.exec("ALTER TABLE courses ADD COLUMN source_url TEXT NOT NULL DEFAULT ''"); } catch { /* Already migrated. */ }
    try { this.db.exec("ALTER TABLE courses ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'"); } catch { /* Already migrated. */ }
    try { this.db.exec("ALTER TABLE courses ADD COLUMN global_version INTEGER"); } catch { /* Already migrated. */ }
    try { this.db.exec("ALTER TABLE courses ADD COLUMN global_owner_device_id TEXT"); } catch { /* Already migrated. */ }
    try { this.db.exec("ALTER TABLE courses ADD COLUMN forked_from_version INTEGER"); } catch { /* Already migrated. */ }
    try { this.db.exec("ALTER TABLE courses ADD COLUMN global_locked INTEGER NOT NULL DEFAULT 0"); } catch { /* Already migrated. */ }
    this.db.exec("UPDATE courses SET video_id=id WHERE video_id='' OR video_id IS NULL");
  }

  private seedBundledQuestionBank() {
    const timestamp = now();
    this.db.query(`INSERT OR IGNORE INTO courses(id,title,source,video_url,origin_prompt,prompt_credit,active,created_at,updated_at)
      VALUES (?,?,?,?,?,?,1,?,?)`).run(STARTER_COURSE_ID, "Claude Certified Architect — Foundations", "freeCodeCamp.org", `https://www.youtube.com/watch?v=${STARTER_COURSE_ID}`, "", "Drake Fish", timestamp, timestamp);
    this.db.query(`INSERT OR IGNORE INTO concept_graphs(course_id,schema_version,payload_json,revision,created_at,updated_at) VALUES (?,?,?,1,?,?)`)
      .run(STARTER_COURSE_ID, String(bundledConceptGraph.schemaVersion ?? "1.0.0"), json(bundledConceptGraph), timestamp, timestamp);
    const count = this.db.query("SELECT COUNT(*) AS count FROM questions WHERE course_id = ?").get(STARTER_COURSE_ID) as { count: number };
    if (count.count > 0) return;
    const insert = this.db.query(`INSERT INTO questions(course_id,id,position,payload_json,revision,archived,created_at,updated_at) VALUES (?,?,?,?,1,0,?,?)`);
    this.db.transaction(() => {
      questionBank.questions.forEach((question, index) => insert.run(STARTER_COURSE_ID, question.id, index, json(question), timestamp, timestamp));
      this.db.query("INSERT OR REPLACE INTO app_meta(key,value) VALUES ('question_bank_metadata', ?)").run(json({ title: questionBank.title, disclaimer: questionBank.disclaimer, domains: questionBank.domains, sections: questionBank.sections }));
    })();
  }

  private dismissRedundantQuestionSuggestions() {
    const pending = this.db.query("SELECT id,course_id,question_id,proposed_patch_json FROM suggestions WHERE status='pending' AND kind='update' AND question_id IS NOT NULL").all() as Array<Record<string, unknown>>;
    const timestamp = now();
    this.db.transaction(() => {
      for (const row of pending) {
        const current = this.getQuestion(String(row.course_id), String(row.question_id));
        if (!current) continue;
        const patch = parseJson<Record<string, unknown>>(row.proposed_patch_json, {});
        const proposed = applyQuestionPatch(current.payload, patch);
        if (!questionPayloadsEqual(current.payload, proposed)) continue;
        const id = String(row.id);
        this.db.query("UPDATE suggestions SET status='rejected',review_note=?,reviewed_at=?,updated_at=? WHERE id=?")
          .run("Automatically dismissed because the incoming question matches the local version.", timestamp, timestamp, id);
        this.db.query("DELETE FROM desktop_notifications WHERE kind='question' AND entity_id=?").run(id);
      }
    })();
  }

  getProfile(): ProfileRecord | null {
    const row = this.db.query("SELECT id,name,email,avatar_style,avatar_seed,created_at,updated_at FROM profiles WHERE is_local = 1").get() as Record<string, unknown> | null;
    return row ? { id: String(row.id), name: String(row.name), email: String(row.email), avatarStyle: String(row.avatar_style), avatarSeed: String(row.avatar_seed), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) } : null;
  }

  saveProfile(input: { name: string; email: string; avatarStyle: string; avatarSeed: string }) {
    const existing = this.getProfile();
    const timestamp = now();
    const profile: ProfileRecord = { id: existing?.id ?? crypto.randomUUID(), name: input.name.trim(), email: input.email.trim().toLowerCase(), avatarStyle: input.avatarStyle, avatarSeed: input.avatarSeed, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp };
    this.db.query(`INSERT INTO profiles(id,name,email,avatar_style,avatar_seed,is_local,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,avatar_style=excluded.avatar_style,avatar_seed=excluded.avatar_seed,is_local=1,updated_at=excluded.updated_at`)
      .run(profile.id, profile.name, profile.email, profile.avatarStyle, profile.avatarSeed, profile.createdAt, profile.updatedAt);
    return profile;
  }

  getSyncPreferences(): SyncPreferences {
    const preferredRelayUrl = process.env.VIDMARK_RELAY_URL ?? PUBLIC_RELAY_URL;
    const preferences = this.getMeta<SyncPreferences>("sync_preferences", {
      autoImportQuestions: false,
      relayUrl: preferredRelayUrl,
    });
    return preferences;
  }

  saveSyncPreferences(input: Partial<SyncPreferences>) {
    const current = this.getSyncPreferences();
    const relayUrl = input.relayUrl?.trim() ?? current.relayUrl;
    if (relayUrl && !/^wss?:\/\//i.test(relayUrl)) throw new Error("Relay URL must begin with ws:// or wss://.");
    const preferences: SyncPreferences = {
      autoImportQuestions: input.autoImportQuestions ?? current.autoImportQuestions,
      relayUrl,
    };
    this.setMeta("sync_preferences", preferences);
    return preferences;
  }

  upsertCourse(input: CourseInput & { active?: boolean }) {
    const existing = this.db.query("SELECT * FROM courses WHERE id = ?").get(input.id) as Record<string, unknown> | null;
    const timestamp = now();
    const videoUrl = input.videoUrl ?? String(existing?.video_url ?? "");
    const sourceUrl = input.sourceUrl ?? String(existing?.source_url || videoUrl);
    if (sourceUrl && !webUrl(sourceUrl)) throw new Error("Course source URL must use HTTP(S).");
    if (videoUrl && !webUrl(videoUrl)) throw new Error("Course video URL must use HTTP(S).");
    const videoId = youtubeVideoId(videoUrl) || String(existing?.video_id ?? input.id);
    const nextValues = [input.title, input.source ?? String(existing?.source ?? "YouTube"), videoUrl, input.originPrompt ?? String(existing?.origin_prompt ?? ""), input.promptCredit ?? String(existing?.prompt_credit ?? ""), input.studyGuide ?? existing?.study_guide ?? null, input.researchNotes ?? existing?.research_notes ?? null];
    const previousValues = existing ? [existing.title, existing.source, existing.video_url, existing.origin_prompt, existing.prompt_credit, existing.study_guide, existing.research_notes] : [];
    if (existing && (sourceUrl !== String(existing.source_url || existing.video_url || "") || nextValues.some((value, index) => value !== previousValues[index]))) this.prepareCourseMutation(input.id);
    this.db.query(`INSERT INTO courses(id,title,source,video_url,origin_prompt,prompt_credit,study_guide,research_notes,active,revision,created_at,updated_at,video_id)
      VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,source=excluded.source,video_url=excluded.video_url,
      origin_prompt=excluded.origin_prompt,prompt_credit=excluded.prompt_credit,study_guide=COALESCE(excluded.study_guide,courses.study_guide),
      research_notes=COALESCE(excluded.research_notes,courses.research_notes),active=excluded.active,video_id=excluded.video_id,revision=courses.revision+1,updated_at=excluded.updated_at`)
      .run(input.id, input.title, String(nextValues[1] ?? "YouTube"), videoUrl, String(nextValues[3] ?? ""), String(nextValues[4] ?? ""), input.studyGuide ?? null, input.researchNotes ?? null, (input.active ?? Boolean(existing?.active)) ? 1 : 0, Number(existing?.created_at ?? timestamp), timestamp, videoId);
    this.db.query("UPDATE courses SET source_url=? WHERE id=?").run(sourceUrl, input.id);
    if (input.transcript) this.replaceTranscript(input.id, input.transcript);
    if (input.chapters) this.replaceChapters(input.id, input.chapters);
    if (input.questions) this.replaceQuestions(input.id, input.questions);
    if (input.conceptGraph) this.saveConceptGraph(input.id, input.conceptGraph);
    return this.getCourse(input.id);
  }

  listCourses() {
    return (this.db.query(`SELECT c.*, (SELECT COUNT(*) FROM transcript_cues t WHERE t.course_id=c.id) transcript_count,
      (SELECT COUNT(*) FROM chapters ch WHERE ch.course_id=c.id) chapter_count,
      (SELECT COUNT(*) FROM questions q WHERE q.course_id=c.id AND q.archived=0) question_count,
      (SELECT revision FROM concept_graphs cg WHERE cg.course_id=c.id) concept_graph_revision FROM courses c ORDER BY active DESC, updated_at DESC`).all() as Array<Record<string, unknown>>)
      .map((row) => ({ id: row.id, videoId: row.video_id || row.id, title: row.title, source: row.source, sourceUrl: row.source_url || row.video_url, videoUrl: row.video_url, promptCredit: row.prompt_credit, promptExcerpt: String(row.origin_prompt).slice(0, 240), transcriptCues: row.transcript_count, chapters: row.chapter_count, questions: row.question_count, conceptGraphRevision: row.concept_graph_revision ?? null, active: Boolean(row.active), revision: row.revision, visibility: row.visibility, globalVersion: row.global_version, globalOwnerDeviceId: row.global_owner_device_id, forkedFromVersion: row.forked_from_version, globalLocked: Boolean(row.global_locked), updatedAt: row.updated_at }));
  }

  getCourse(courseId: string) {
    const row = this.db.query("SELECT * FROM courses WHERE id = ?").get(courseId) as Record<string, unknown> | null;
    if (!row) return null;
    const conceptGraph = this.getConceptGraph(courseId);
    return { id: row.id, videoId: row.video_id || row.id, title: row.title, source: row.source, sourceUrl: row.source_url || row.video_url, videoUrl: row.video_url, coursePrompt: row.origin_prompt, promptCredit: row.prompt_credit, studyGuide: row.study_guide, researchNotes: row.research_notes, conceptGraph: conceptGraph?.graph ?? null, conceptGraphRevision: conceptGraph?.revision ?? null, active: Boolean(row.active), revision: row.revision, visibility: row.visibility, globalVersion: row.global_version, globalOwnerDeviceId: row.global_owner_device_id, forkedFromVersion: row.forked_from_version, globalLocked: Boolean(row.global_locked), updatedAt: row.updated_at, transcript: this.getTranscript(courseId, undefined, 100000).cues, chapters: this.listChapters(courseId), questions: this.listQuestions(courseId, { includeArchived: true, limit: 10000 }).questions };
  }

  getConceptGraph(courseId: string): ConceptGraphRecord | null {
    const row = this.db.query("SELECT * FROM concept_graphs WHERE course_id=?").get(courseId) as Record<string, unknown> | null;
    if (!row) return null;
    return { courseId: String(row.course_id), revision: Number(row.revision), graph: parseJson<ConceptGraph>(row.payload_json, { nodes: [], edges: [] }), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }

  saveConceptGraph(courseId: string, input: unknown, expectedRevision?: number) {
    if (!this.db.query("SELECT 1 present FROM courses WHERE id=?").get(courseId)) throw new Error(`Course ${courseId} was not found.`);
    const graph = validateConceptGraph(input);
    const existing = this.getConceptGraph(courseId);
    if (expectedRevision !== undefined && existing?.revision !== expectedRevision) throw new Error(`Revision conflict: expected ${expectedRevision}, current concept graph revision is ${existing?.revision ?? 0}.`);
    if (existing && json(existing.graph) === json(graph)) return existing;
    this.prepareCourseMutation(courseId);
    const timestamp = now();
    this.db.query(`INSERT INTO concept_graphs(course_id,schema_version,payload_json,revision,created_at,updated_at) VALUES (?,?,?,1,?,?)
      ON CONFLICT(course_id) DO UPDATE SET schema_version=excluded.schema_version,payload_json=excluded.payload_json,revision=concept_graphs.revision+1,updated_at=excluded.updated_at`)
      .run(courseId, String(graph.schemaVersion ?? "1.0.0"), json(graph), existing?.createdAt ?? timestamp, timestamp);
    this.touchCourse(courseId);
    this.log("upsert", "concept_graph", courseId, { revision: (existing?.revision ?? 0) + 1, nodes: graph.nodes.length, edges: graph.edges.length });
    return this.getConceptGraph(courseId)!;
  }

  replaceTranscript(courseId: string, cues: Array<{ time: number; text: string }>) {
    const current = this.getTranscript(courseId, undefined, 100000).cues as Array<{ time: number; text: string }>;
    if (current.length === cues.length && current.every((cue, index) => cue.time === cues[index]?.time && cue.text === cues[index]?.text)) return;
    this.prepareCourseMutation(courseId);
    this.db.transaction(() => {
      this.db.query("DELETE FROM transcript_cues WHERE course_id = ?").run(courseId);
      const insert = this.db.query("INSERT INTO transcript_cues(course_id,position,time,text) VALUES (?,?,?,?)");
      cues.forEach((cue, index) => insert.run(courseId, index, cue.time, cue.text));
      this.touchCourse(courseId);
    })();
  }

  getTranscript(courseId: string, query?: string, limit = 250) {
    const needle = query?.trim();
    const rows = needle
      ? this.db.query("SELECT time,text FROM transcript_cues WHERE course_id=? AND text LIKE ? ORDER BY position LIMIT ?").all(courseId, `%${needle}%`, limit)
      : this.db.query("SELECT time,text FROM transcript_cues WHERE course_id=? ORDER BY position LIMIT ?").all(courseId, limit);
    const total = this.db.query("SELECT COUNT(*) count FROM transcript_cues WHERE course_id=?").get(courseId) as { count: number };
    return { courseId, totalCues: total.count, returned: rows.length, cues: rows };
  }

  replaceChapters(courseId: string, chapters: unknown[]) {
    const normalized = chapters.map((chapter) => {
      if (!chapter || typeof chapter !== "object" || Array.isArray(chapter)) throw new Error("Each chapter must be an object.");
      const value = chapter as Record<string, unknown>;
      return { ...value, videos: chapterVideos(value.videos) };
    });
    this.prepareCourseMutation(courseId);
    const timestamp = now();
    this.db.transaction(() => {
      this.db.query("DELETE FROM chapters WHERE course_id=?").run(courseId);
      const insert = this.db.query("INSERT INTO chapters(course_id,id,position,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?)");
      normalized.forEach((chapter, index) => {
        const value = chapter && typeof chapter === "object" ? chapter as Record<string, unknown> : { value: chapter };
        insert.run(courseId, String(value.id ?? `chapter-${index + 1}`), index, json(value), timestamp, timestamp);
      });
      this.touchCourse(courseId);
    })();
  }

  listChapters(courseId: string) {
    return (this.db.query("SELECT id,position,payload_json,revision,updated_at FROM chapters WHERE course_id=? ORDER BY position").all(courseId) as Array<Record<string, unknown>>)
      .map((row) => ({ ...parseJson<Record<string, unknown>>(row.payload_json, {}), id: row.id, position: row.position, revision: row.revision, updatedAt: row.updated_at }));
  }

  replaceQuestions(courseId: string, questions: unknown[]) {
    this.prepareCourseMutation(courseId);
    const timestamp = now();
    this.db.transaction(() => {
      this.db.query("DELETE FROM questions WHERE course_id=?").run(courseId);
      const insert = this.db.query("INSERT INTO questions(course_id,id,position,payload_json,revision,archived,created_at,updated_at) VALUES (?,?,?,?,1,0,?,?)");
      questions.forEach((question, index) => {
        const value = question && typeof question === "object" ? question as Record<string, unknown> : { value: question };
        insert.run(courseId, String(value.id ?? value.bankId ?? `question-${index + 1}`), index, json(value), timestamp, timestamp);
      });
      this.touchCourse(courseId);
    })();
  }

  listQuestions(courseId: string, options: { includeArchived?: boolean; query?: string; limit?: number; offset?: number } = {}) {
    const includeArchived = options.includeArchived ?? false;
    const limit = Math.min(1000, Math.max(1, options.limit ?? 250));
    const offset = Math.max(0, options.offset ?? 0);
    const clauses = ["course_id = ?", includeArchived ? "1=1" : "archived = 0"];
    const params: Array<string | number> = [courseId];
    if (options.query?.trim()) { clauses.push("payload_json LIKE ?"); params.push(`%${options.query.trim()}%`); }
    const rows = this.db.query(`SELECT * FROM questions WHERE ${clauses.join(" AND ")} ORDER BY position LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<Record<string, unknown>>;
    const total = this.db.query(`SELECT COUNT(*) count FROM questions WHERE ${clauses.join(" AND ")}`).get(...params) as { count: number };
    return { courseId, total: total.count, offset, returned: rows.length, questions: rows.map((row) => this.questionFromRow(row)) };
  }

  getQuestion(courseId: string, questionId: string) {
    const row = this.db.query("SELECT * FROM questions WHERE course_id=? AND id=?").get(courseId, questionId) as Record<string, unknown> | null;
    return row ? this.questionFromRow(row) : null;
  }

  upsertQuestion(courseId: string, payload: Record<string, unknown>, expectedRevision?: number, position?: number) {
    const questionId = String(payload.id ?? payload.bankId ?? "").trim();
    if (!questionId) throw new Error("Question id is required.");
    const existing = this.getQuestion(courseId, questionId);
    if (expectedRevision !== undefined && existing && existing.revision !== expectedRevision) throw new Error(`Revision conflict: expected ${expectedRevision}, current revision is ${existing.revision}.`);
    this.prepareCourseMutation(courseId);
    const timestamp = now();
    const nextPosition = position ?? existing?.position ?? Number((this.db.query("SELECT COALESCE(MAX(position),-1)+1 next FROM questions WHERE course_id=?").get(courseId) as { next: number }).next);
    this.db.query(`INSERT INTO questions(course_id,id,position,payload_json,revision,archived,created_at,updated_at) VALUES (?,?,?,?,1,0,?,?)
      ON CONFLICT(course_id,id) DO UPDATE SET position=excluded.position,payload_json=excluded.payload_json,revision=questions.revision+1,archived=0,updated_at=excluded.updated_at`)
      .run(courseId, questionId, nextPosition, json({ ...payload, id: questionId }), existing?.createdAt ?? timestamp, timestamp);
    this.touchCourse(courseId);
    this.log("upsert", "question", questionId, { courseId, revision: (existing?.revision ?? 0) + 1 });
    return this.getQuestion(courseId, questionId);
  }

  patchQuestion(courseId: string, questionId: string, patch: Record<string, unknown>, expectedRevision?: number) {
    const existing = this.getQuestion(courseId, questionId);
    if (!existing) throw new Error(`Question ${questionId} was not found.`);
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) throw new Error(`Revision conflict: expected ${expectedRevision}, current revision is ${existing.revision}.`);
    const merged = mergePatch(existing.payload, patch) as Record<string, unknown>;
    return this.upsertQuestion(courseId, { ...merged, id: questionId }, existing.revision, existing.position);
  }

  archiveQuestion(courseId: string, questionId: string, expectedRevision?: number) {
    const existing = this.getQuestion(courseId, questionId);
    if (!existing) throw new Error(`Question ${questionId} was not found.`);
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) throw new Error(`Revision conflict: expected ${expectedRevision}, current revision is ${existing.revision}.`);
    this.prepareCourseMutation(courseId);
    this.db.query("UPDATE questions SET archived=1,revision=revision+1,updated_at=? WHERE course_id=? AND id=?").run(now(), courseId, questionId);
    this.touchCourse(courseId);
    this.log("archive", "question", questionId, { courseId });
    return this.getQuestion(courseId, questionId);
  }

  createSuggestion(input: Omit<SuggestionRecord, "id" | "status" | "createdAt" | "updatedAt"> & { id?: string; status?: SuggestionRecord["status"]; notify?: boolean }) {
    const timestamp = now();
    const existing = input.id ? this.getSuggestion(input.id) : null;
    const { notify = true, ...suggestionInput } = input;
    const suggestion: SuggestionRecord = { ...suggestionInput, id: input.id ?? crypto.randomUUID(), status: input.status ?? "pending", createdAt: timestamp, updatedAt: timestamp };
    this.db.query(`INSERT INTO suggestions(id,course_id,question_id,kind,status,title,rationale,proposed_patch_json,sources_json,author_profile_json,author_device_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=suggestions.status,title=excluded.title,rationale=excluded.rationale,
      proposed_patch_json=excluded.proposed_patch_json,sources_json=excluded.sources_json,updated_at=excluded.updated_at`)
      .run(suggestion.id, suggestion.courseId, suggestion.questionId ?? null, suggestion.kind, suggestion.status, suggestion.title, suggestion.rationale, json(suggestion.proposedPatch), json(suggestion.sources), suggestion.authorProfile ? json(suggestion.authorProfile) : null, suggestion.authorDeviceId ?? null, suggestion.createdAt, suggestion.updatedAt);
    if (!existing && suggestion.status === "pending" && notify) this.addDesktopNotification({ eventId: `suggestion:${suggestion.id}`, kind: "question", title: suggestion.title, body: suggestion.rationale, target: "people", entityId: suggestion.id });
    this.log("create", "suggestion", suggestion.id, { courseId: suggestion.courseId, questionId: suggestion.questionId });
    return this.getSuggestion(suggestion.id)!;
  }

  listSuggestions(options: { courseId?: string; status?: SuggestionRecord["status"] } = {}) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.courseId) { clauses.push("course_id=?"); params.push(options.courseId); }
    if (options.status) { clauses.push("status=?"); params.push(options.status); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.query(`SELECT * FROM suggestions ${where} ORDER BY updated_at DESC`).all(...params) as Array<Record<string, unknown>>).map((row) => this.suggestionFromRow(row));
  }

  getSuggestion(id: string) {
    const row = this.db.query("SELECT * FROM suggestions WHERE id=?").get(id) as Record<string, unknown> | null;
    return row ? this.suggestionFromRow(row) : null;
  }

  reviewSuggestion(id: string, decision: "accepted" | "rejected", reviewerProfileId?: string, reviewNote?: string) {
    const suggestion = this.getSuggestion(id);
    if (!suggestion) throw new Error(`Suggestion ${id} was not found.`);
    if (suggestion.status !== "pending") throw new Error(`Suggestion ${id} has already been ${suggestion.status}.`);
    this.db.transaction(() => {
      if (decision === "accepted") {
        if (suggestion.kind === "create") this.upsertQuestion(suggestion.courseId, suggestion.proposedPatch);
        else if (suggestion.kind === "update" && suggestion.questionId) this.patchQuestion(suggestion.courseId, suggestion.questionId, suggestion.proposedPatch);
        else if (suggestion.kind === "archive" && suggestion.questionId) this.archiveQuestion(suggestion.courseId, suggestion.questionId);
      }
      const timestamp = now();
      this.db.query("UPDATE suggestions SET status=?,reviewer_profile_id=?,review_note=?,reviewed_at=?,updated_at=? WHERE id=?")
        .run(decision, reviewerProfileId ?? null, reviewNote ?? null, timestamp, timestamp, id);
      this.log("review", "suggestion", id, { decision });
    })();
    return this.getSuggestion(id);
  }

  upsertNote(note: Record<string, unknown>) {
    if (!note.id) return;
    this.db.query(`INSERT INTO notes(id,course_id,chapter_id,chapter_title,text,source,updated_at,has_audio,payload_json) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET course_id=excluded.course_id,chapter_id=excluded.chapter_id,chapter_title=excluded.chapter_title,text=excluded.text,source=excluded.source,updated_at=excluded.updated_at,has_audio=excluded.has_audio,payload_json=excluded.payload_json
      WHERE excluded.updated_at >= notes.updated_at`)
      .run(String(note.id), String(note.courseId ?? ""), String(note.chapterId ?? "unsorted"), String(note.chapterTitle ?? "Unsorted"), String(note.text ?? ""), String(note.source ?? "text"), Number(note.updatedAt ?? now()), note.hasAudio ? 1 : 0, json(note));
  }

  listNotes(courseId?: string, query?: string) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (courseId) { clauses.push("course_id=?"); params.push(courseId); }
    if (query?.trim()) { clauses.push("(text LIKE ? OR chapter_title LIKE ?)"); params.push(`%${query.trim()}%`, `%${query.trim()}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.query(`SELECT payload_json FROM notes ${where} ORDER BY updated_at DESC`).all(...params) as Array<{ payload_json: string }>).map((row) => parseJson<Record<string, unknown>>(row.payload_json, {}));
  }

  exportCourseBundle(courseId: string) {
    const course = this.getCourse(courseId);
    if (!course) throw new Error(`Course ${courseId} was not found.`);
    return { version: 2, exportedAt: now(), course };
  }

  importCourseBundle(bundle: Record<string, unknown>, options: { visibility?: "private" | "public"; globalVersion?: number; globalOwnerDeviceId?: string; globalLocked?: boolean } = {}) {
    const course = bundle.course && typeof bundle.course === "object" ? bundle.course as Record<string, unknown> : bundle;
    const id = String(course.id ?? course.videoId ?? "").trim();
    if (!id) throw new Error("The shared course does not contain an ID.");
    const questions = Array.isArray(course.questions) ? course.questions.map((question) => question && typeof question === "object" && "payload" in question ? (question as { payload: unknown }).payload : question) : [];
    const saved = this.upsertCourse({ id, title: String(course.title ?? `Course · ${id}`), source: String(course.source ?? "YouTube"), sourceUrl: String(course.sourceUrl ?? course.videoUrl ?? ""), videoUrl: String(course.videoUrl ?? (!course.sourceUrl && youtubeId(String(course.videoId ?? id)) ? `https://www.youtube.com/watch?v=${course.videoId ?? id}` : "")), originPrompt: String(course.coursePrompt ?? course.originPrompt ?? "Build a well-researched course from this video."), promptCredit: String(course.promptCredit ?? "Course creator"), studyGuide: course.studyGuide === undefined ? undefined : String(course.studyGuide ?? ""), researchNotes: course.researchNotes === undefined ? undefined : String(course.researchNotes ?? ""), active: true });
    if (Array.isArray(course.transcript)) this.replaceTranscript(id, course.transcript as Array<{ time: number; text: string }>);
    if (Array.isArray(course.chapters)) this.replaceChapters(id, course.chapters);
    if (questions.length) this.replaceQuestions(id, questions);
    if (course.conceptGraph) this.saveConceptGraph(id, course.conceptGraph);
    this.db.query("UPDATE courses SET visibility=?,global_version=?,global_owner_device_id=?,forked_from_version=?,global_locked=? WHERE id=?")
      .run(options.visibility ?? "private", options.globalVersion ?? null, options.globalOwnerDeviceId ?? null, options.globalVersion ?? null, options.globalLocked ? 1 : 0, id);
    return this.getCourse(String(saved?.id ?? id));
  }

  setCourseCollaboration(courseId: string, input: { visibility: "private" | "public"; globalVersion?: number; globalOwnerDeviceId?: string; globalLocked?: boolean }) {
    if (!this.getCourse(courseId)) throw new Error(`Course ${courseId} was not found.`);
    this.db.query("UPDATE courses SET visibility=?,global_version=COALESCE(?,global_version),global_owner_device_id=COALESCE(?,global_owner_device_id),global_locked=?,updated_at=? WHERE id=?")
      .run(input.visibility, input.globalVersion ?? null, input.globalOwnerDeviceId ?? null, input.globalLocked ? 1 : 0, now(), courseId);
    return this.getCourse(courseId);
  }

  addInboxItem(input: Omit<InboxRecord, "status" | "actionStatus" | "createdAt" | "updatedAt"> & { status?: InboxRecord["status"]; actionStatus?: InboxRecord["actionStatus"]; createdAt?: number; notificationTarget?: DesktopNotificationRecord["target"] }) {
    const timestamp = input.createdAt ?? now();
    const existing = this.getInboxItem(input.id);
    this.db.query(`INSERT INTO inbox_items(id,type,title,preview,status,action_status,payload_json,sender_profile_json,sender_device_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,preview=excluded.preview,payload_json=excluded.payload_json,sender_profile_json=excluded.sender_profile_json,updated_at=excluded.updated_at`)
      .run(input.id, input.type, input.title, input.preview, input.status ?? "unread", input.actionStatus ?? "pending", json(input.payload), input.senderProfile ? json(input.senderProfile) : null, input.senderDeviceId ?? null, timestamp, timestamp);
    if (!existing && (input.status ?? "unread") === "unread") this.addDesktopNotification({ eventId: `inbox:${input.id}`, kind: input.type, title: input.title, body: input.preview, target: input.notificationTarget ?? "inbox", entityId: input.id });
    return this.getInboxItem(input.id)!;
  }

  addDesktopNotification(input: Omit<DesktopNotificationRecord, "sequence" | "createdAt"> & { createdAt?: number }) {
    this.db.query("INSERT OR IGNORE INTO desktop_notifications(event_id,kind,title,body,target,entity_id,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(input.eventId, input.kind, input.title, input.body, input.target, input.entityId, input.createdAt ?? now());
  }

  listDesktopNotifications(after = 0, limit = 50) {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return (this.db.query("SELECT * FROM desktop_notifications WHERE sequence>? ORDER BY sequence LIMIT ?").all(after, safeLimit) as Array<Record<string, unknown>>).map((row): DesktopNotificationRecord => ({
      sequence: Number(row.sequence), eventId: String(row.event_id), kind: row.kind as DesktopNotificationRecord["kind"], title: String(row.title), body: String(row.body), target: row.target as DesktopNotificationRecord["target"], entityId: String(row.entity_id), createdAt: Number(row.created_at),
    }));
  }

  desktopUnreadCount() {
    const inbox = this.db.query("SELECT COUNT(*) count FROM inbox_items WHERE status='unread'").get() as { count: number };
    const suggestions = this.db.query("SELECT COUNT(*) count FROM suggestions WHERE status='pending'").get() as { count: number };
    return Number(inbox.count) + Number(suggestions.count);
  }

  listInbox(options: { status?: "unread" | "read"; type?: InboxRecord["type"] } = {}) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.status) { clauses.push("status=?"); params.push(options.status); }
    if (options.type) { clauses.push("type=?"); params.push(options.type); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.query(`SELECT * FROM inbox_items ${where} ORDER BY updated_at DESC`).all(...params) as Array<Record<string, unknown>>).map((row) => this.inboxFromRow(row));
  }

  getInboxItem(id: string) {
    const row = this.db.query("SELECT * FROM inbox_items WHERE id=?").get(id) as Record<string, unknown> | null;
    return row ? this.inboxFromRow(row) : null;
  }

  updateInboxItem(id: string, input: { status?: "unread" | "read"; actionStatus?: InboxRecord["actionStatus"] }) {
    if (!this.getInboxItem(id)) throw new Error(`Inbox item ${id} was not found.`);
    this.db.query("UPDATE inbox_items SET status=COALESCE(?,status),action_status=COALESCE(?,action_status),updated_at=? WHERE id=?")
      .run(input.status ?? null, input.actionStatus ?? null, now(), id);
    return this.getInboxItem(id)!;
  }

  reviewCourseInvite(id: string, decision: "accepted" | "rejected") {
    const item = this.getInboxItem(id);
    if (!item || item.type !== "course_invite") throw new Error(`Course invitation ${id} was not found.`);
    if (item.actionStatus !== "pending") throw new Error(`Course invitation ${id} has already been ${item.actionStatus}.`);
    if (decision === "accepted") this.importCourseBundle(item.payload, { visibility: "private", globalVersion: Number(item.payload.globalVersion || 0) || undefined, globalOwnerDeviceId: String(item.payload.globalOwnerDeviceId ?? "") || undefined });
    return this.updateInboxItem(id, { status: "read", actionStatus: decision });
  }

  upsertCourseComment(comment: CourseCommentRecord) {
    this.db.query(`INSERT INTO course_comments(id,video_id,course_id,parent_id,body,author_profile_json,author_device_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,author_profile_json=excluded.author_profile_json,updated_at=excluded.updated_at`)
      .run(comment.id, comment.videoId, comment.courseId, comment.parentId ?? null, comment.body, json(comment.authorProfile), comment.authorDeviceId, comment.createdAt, comment.updatedAt);
    return comment;
  }

  cacheCourseComments(comments: CourseCommentRecord[]) {
    this.db.transaction(() => comments.forEach((comment) => this.upsertCourseComment(comment)))();
    return this.listCourseComments(comments[0]?.videoId ?? "");
  }

  listCourseComments(videoId: string) {
    return (this.db.query("SELECT * FROM course_comments WHERE video_id=? ORDER BY created_at").all(videoId) as Array<Record<string, unknown>>).map((row): CourseCommentRecord => ({ id: String(row.id), videoId: String(row.video_id), courseId: String(row.course_id), parentId: row.parent_id ? String(row.parent_id) : undefined, body: String(row.body), authorProfile: parseJson<SharedProfile>(row.author_profile_json, { id: "", name: "Unknown", email: "", avatarStyle: "bottts", avatarSeed: "unknown" }), authorDeviceId: String(row.author_device_id), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }));
  }

  getMeta<T>(key: string, fallback: T): T {
    const row = this.db.query("SELECT value FROM app_meta WHERE key=?").get(key) as { value: string } | null;
    return row ? parseJson(row.value, fallback) : fallback;
  }

  setMeta(key: string, value: unknown) { this.db.query("INSERT OR REPLACE INTO app_meta(key,value) VALUES (?,?)").run(key, json(value)); }

  private prepareCourseMutation(courseId: string) {
    const row = this.db.query("SELECT global_locked,global_version FROM courses WHERE id=?").get(courseId) as { global_locked: number; global_version: number | null } | null;
    if (row?.global_locked) this.db.query("UPDATE courses SET visibility='private',global_locked=0,forked_from_version=global_version,updated_at=? WHERE id=?").run(now(), courseId);
  }

  private touchCourse(courseId: string) { this.db.query("UPDATE courses SET revision=revision+1,updated_at=? WHERE id=?").run(now(), courseId); }

  private questionFromRow(row: Record<string, unknown>): QuestionRecord {
    return { courseId: String(row.course_id), id: String(row.id), position: Number(row.position), revision: Number(row.revision), archived: Boolean(row.archived), payload: parseJson<Record<string, unknown>>(row.payload_json, {}), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }

  private suggestionFromRow(row: Record<string, unknown>): SuggestionRecord {
    return { id: String(row.id), courseId: String(row.course_id), questionId: row.question_id ? String(row.question_id) : undefined, kind: row.kind as SuggestionRecord["kind"], status: row.status as SuggestionRecord["status"], title: String(row.title), rationale: String(row.rationale), proposedPatch: parseJson(row.proposed_patch_json, {}), sources: parseJson(row.sources_json, []), authorProfile: row.author_profile_json ? parseJson(row.author_profile_json, undefined) : undefined, authorDeviceId: row.author_device_id ? String(row.author_device_id) : undefined, reviewerProfileId: row.reviewer_profile_id ? String(row.reviewer_profile_id) : undefined, reviewNote: row.review_note ? String(row.review_note) : undefined, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), reviewedAt: row.reviewed_at ? Number(row.reviewed_at) : undefined };
  }

  private inboxFromRow(row: Record<string, unknown>): InboxRecord {
    return { id: String(row.id), type: row.type as InboxRecord["type"], title: String(row.title), preview: String(row.preview), status: row.status as InboxRecord["status"], actionStatus: row.action_status as InboxRecord["actionStatus"], payload: parseJson<Record<string, unknown>>(row.payload_json, {}), senderProfile: row.sender_profile_json ? parseJson<SharedProfile | undefined>(row.sender_profile_json, undefined) : undefined, senderDeviceId: row.sender_device_id ? String(row.sender_device_id) : undefined, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }

  private log(action: string, entityType: string, entityId: string, details: unknown) {
    const profile = this.getProfile();
    this.db.query("INSERT INTO activity_log(id,actor_profile_id,action,entity_type,entity_id,details_json,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), profile?.id ?? null, action, entityType, entityId, json(details), now());
  }
}
