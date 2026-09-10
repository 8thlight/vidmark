import type { ExamQuestion } from "./exam-data";
import type { ConceptGraph } from "./concept-graph-types";
import type { SystemPromptOverrides, SystemPromptSetting } from "./system-prompts";

export const VIDMARK_LOCAL_ORIGIN = import.meta.env.VITE_VIDMARK_LOCAL_ORIGIN || "http://127.0.0.1:31417";

export type LearnerProfile = { id: string; name: string; email: string; avatarStyle: string; avatarSeed: string; createdAt: number; updatedAt: number };
export type PeerProfile = Pick<LearnerProfile, "id" | "name" | "email" | "avatarStyle" | "avatarSeed">;
export type QuestionSuggestion = { id: string; courseId: string; questionId?: string; kind: "create" | "update" | "archive"; status: "pending" | "accepted" | "rejected"; title: string; rationale: string; proposedPatch: Record<string, unknown>; sources: unknown[]; authorProfile?: PeerProfile; authorDeviceId?: string; createdAt: number; updatedAt: number };
export type SyncPreferences = { autoImportQuestions: boolean; relayUrl: string };
export type StoredQuestion = { courseId: string; id: string; position: number; revision: number; archived: boolean; payload: Record<string, unknown>; createdAt: number; updatedAt: number };
export type SharedStudyNote = { id: string; text: string; updatedAt: number; source: "text" | "voice"; courseId: string; chapterId: string; chapterTitle: string; sharedFromPeer?: boolean; readOnly?: boolean; authorProfile?: PeerProfile; authorDeviceId?: string; originalSource?: string };
export type DirectoryUser = { userId: string; deviceId: string; profile: PeerProfile; encryptionPublicKey: string; devices: Array<{ deviceId: string; encryptionPublicKey: string }> };
export type SyncStatus = { deviceId: string; relay: { url: string; connected: boolean; error?: string }; transport: "hosted-relay"; directSharesEndToEndEncrypted: true };
export type InboxItem = { id: string; type: "course_invite" | "message" | "revision"; title: string; preview: string; status: "unread" | "read"; actionStatus: "pending" | "accepted" | "rejected" | "none"; payload: Record<string, unknown>; senderProfile?: PeerProfile; senderDeviceId?: string; createdAt: number; updatedAt: number };
export type CourseSummary = { id: string; videoId: string; title: string; source: string; videoUrl: string; sourceUrl?: string; visibility: "private" | "public"; globalVersion?: number; globalOwnerDeviceId?: string; forkedFromVersion?: number; globalLocked: boolean; conceptGraphRevision?: number; revision: number; updatedAt: number };
export type GlobalCourse = { videoId: string; ownerDeviceId: string; ownerProfile: PeerProfile; course: Record<string, unknown>; version: number; createdAt: number; updatedAt: number };
export type GlobalRevision = { id: string; videoId: string; proposerDeviceId: string; proposerProfile: PeerProfile; baseVersion: number; status: "pending" | "accepted" | "rejected"; createdAt: number; updatedAt: number };
export type CourseComment = { id: string; videoId: string; courseId: string; parentId?: string; body: string; authorProfile: PeerProfile; authorDeviceId: string; createdAt: number; updatedAt: number };

const responseJson = async <T>(response: Response): Promise<T> => {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Vidmark service returned ${response.status}.`);
  return body;
};

export const getProfile = async () => (await responseJson<{ profile: LearnerProfile | null }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/profile`))).profile;
export const saveProfile = async (profile: Pick<LearnerProfile, "name" | "email" | "avatarStyle" | "avatarSeed">) => (await responseJson<{ profile: LearnerProfile }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/profile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) }))).profile;
export const getSyncStatus = async () => responseJson<SyncStatus>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/sync`));
export const getSuggestions = async (courseId?: string) => (await responseJson<{ suggestions: QuestionSuggestion[] }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/suggestions${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ""}`))).suggestions;
export const reviewSuggestion = async (suggestionId: string, decision: "accepted" | "rejected") => responseJson<{ suggestion: QuestionSuggestion }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/suggestions/${encodeURIComponent(suggestionId)}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) }));
export const getSyncPreferences = async () => (await responseJson<{ preferences: SyncPreferences }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/preferences`))).preferences;
export const saveSyncPreferences = async (preferences: Partial<SyncPreferences>) => (await responseJson<{ preferences: SyncPreferences }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/preferences`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(preferences) }))).preferences;
export const getSystemPrompts = async () => responseJson<{ prompts: SystemPromptSetting[]; updatedAt: number; storage: "local-only" }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/system-prompts`));
export const saveSystemPrompts = async (overrides: SystemPromptOverrides) => responseJson<{ prompts: SystemPromptSetting[]; updatedAt: number; storage: "local-only" }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/system-prompts`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ overrides }) }));
export const getStoredCourseQuestions = async (courseId: string) => (await responseJson<{ questions: StoredQuestion[] }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/questions?courseId=${encodeURIComponent(courseId)}&limit=1000`))).questions;
export const getStoredCourseQuestion = async (courseId: string, questionId: string) => (await responseJson<{ question: StoredQuestion | null }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/questions/${encodeURIComponent(courseId)}/${encodeURIComponent(questionId)}`))).question;
export const shareCourseQuestion = async (courseId: string, questionId: string, recipient: DirectoryUser) => responseJson<{ eventId: string; delivered: string[] }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/questions/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId, questionId, recipient }) }));
export const getPeerNotes = async (courseId?: string) => (await responseJson<{ notes: SharedStudyNote[] }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/notes${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ""}`))).notes.filter((note) => note.sharedFromPeer);
export const shareStudyNote = async (note: Record<string, unknown>, recipient: DirectoryUser) => responseJson<{ eventId: string; delivered: string[] }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/notes/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note, recipient }) }));
export const getLocalCourses = async () => (await responseJson<{ courses: CourseSummary[] }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/courses`))).courses;
export const getLocalCourse = async (courseId: string) => (await responseJson<{ course: Record<string, unknown> | null }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/courses/${encodeURIComponent(courseId)}`))).course;
export const getCourseConceptGraph = async (courseId: string) => (await responseJson<{ conceptGraph: { courseId: string; revision: number; graph: ConceptGraph; createdAt: number; updatedAt: number } | null }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/concept-graph?courseId=${encodeURIComponent(courseId)}`))).conceptGraph;
export const searchVidmarkUsers = async (query: string) => (await responseJson<{ users: DirectoryUser[] }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/directory?query=${encodeURIComponent(query)}`))).users;
export const shareCourseWithUser = async (courseId: string, recipient: DirectoryUser) => responseJson<{ delivered: string[] }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/courses/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId, recipient }) }));
export const createCourseShareLink = async (courseId: string, oneTime = false) => responseJson<{ link: string; expiresAt: number; oneTime: boolean }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/courses/share-link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId, oneTime }) }));
export const importCourseShareLink = async (link: string) => responseJson<{ invite: InboxItem }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/courses/import-link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link }) }));
export const revokeCourseShareLink = async (link: string) => responseJson<{ revoked: boolean }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/courses/share-link/revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link }) }));
export const getInbox = async (status?: "read" | "unread") => (await responseJson<{ items: InboxItem[] }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/inbox${status ? `?status=${status}` : ""}`))).items;
export const setInboxStatus = async (itemId: string, status: "read" | "unread") => (await responseJson<{ item: InboxItem }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/inbox/${encodeURIComponent(itemId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }))).item;
export const reviewCourseInvite = async (itemId: string, decision: "accepted" | "rejected") => (await responseJson<{ item: InboxItem }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/inbox/${encodeURIComponent(itemId)}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) }))).item;
export const getGlobalCourse = async (videoId: string) => (await responseJson<{ global: GlobalCourse | null }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/global-course?videoId=${encodeURIComponent(videoId)}`))).global;
export const publishCourse = async (courseId: string) => responseJson<{ mode: "registered_global" | "published_revision" | "proposed_revision"; global?: GlobalCourse; revision?: GlobalRevision }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/global-course/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId }) }));
export const makeCoursePrivate = async (courseId: string) => responseJson<{ course: CourseSummary }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/global-course/private`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId }) }));
export const importGlobalCourse = async (videoId: string) => responseJson<{ global: GlobalCourse; course: Record<string, unknown> }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/global-course/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoId }) }));
export const getGlobalRevisions = async (videoId: string) => (await responseJson<{ revisions: GlobalRevision[] }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/global-course/revisions?videoId=${encodeURIComponent(videoId)}`))).revisions;
export const reviewGlobalRevision = async (videoId: string, revisionId: string, decision: "accepted" | "rejected") => responseJson<{ id: string; status: string; version: number }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/global-course/revisions/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoId, revisionId, decision }) }));
export const getCourseComments = async (videoId: string) => (await responseJson<{ comments: CourseComment[] }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/comments?videoId=${encodeURIComponent(videoId)}`))).comments;
export const postCourseComment = async (courseId: string, body: string, parentId?: string) => (await responseJson<{ comment: CourseComment }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId, body, parentId }) }))).comment;

type BankPayload = {
  id?: string; sectionId?: string; domainId?: string; difficulty?: ExamQuestion["difficulty"]; mode?: ExamQuestion["mode"]; scenario?: string; question?: string;
  options?: Record<"A" | "B" | "C" | "D", { text?: string; rationale?: string }>;
  correctAnswer?: "A" | "B" | "C" | "D"; grading?: { temptingDistractor?: "A" | "B" | "C" | "D"; principle?: string; hinge?: string; missType?: "judgment" | "recall" };
  sources?: Array<{ label?: string; url?: string }>;
};

export const getCourseQuestions = async (courseId: string, fallback: ExamQuestion[]) => {
  try {
    const result = await responseJson<{ questions: StoredQuestion[] }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/questions?courseId=${encodeURIComponent(courseId)}&limit=1000`));
    if (!result.questions.length) return fallback;
    const chapterBySection = new Map(fallback.map((question) => [question.sectionId, question.chapter]));
    return result.questions.map((stored, index): ExamQuestion => {
      const value = stored.payload as BankPayload;
      const source = value.sources?.[0];
      return {
        id: index + 1, bankId: String(value.id ?? stored.id), chapter: chapterBySection.get(String(value.sectionId)) ?? String(value.sectionId ?? "Course"), sectionId: String(value.sectionId ?? "course"), domain: (["architecture", "tools", "code", "prompting", "context"].includes(String(value.domainId)) ? value.domainId : "architecture") as ExamQuestion["domain"], difficulty: value.difficulty ?? "standard", mode: value.mode ?? "standard",
        scenario: [value.scenario, value.question].filter(Boolean).join("\n\n"),
        options: { A: value.options?.A?.text ?? "", B: value.options?.B?.text ?? "", C: value.options?.C?.text ?? "", D: value.options?.D?.text ?? "" },
        rationales: { A: value.options?.A?.rationale ?? "", B: value.options?.B?.rationale ?? "", C: value.options?.C?.rationale ?? "", D: value.options?.D?.rationale ?? "" },
        correct: value.correctAnswer ?? "A", tempting: value.grading?.temptingDistractor ?? "B", principle: value.grading?.principle ?? "", hinge: value.grading?.hinge ?? "", missType: value.grading?.missType ?? "judgment", sourceLabel: source?.label ?? "Vidmark course source", sourceUrl: source?.url ?? "https://modelcontextprotocol.io/",
      };
    });
  } catch { return fallback; }
};
export const createLocalCourse = async (course: { id: string; title: string; source: string; sourceUrl: string; videoUrl: string; originPrompt: string; promptCredit: string }) => responseJson<{ course: Record<string, unknown> }>(await fetch(`${VIDMARK_LOCAL_ORIGIN}/api/courses`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(course) }));
