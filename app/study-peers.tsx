"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, Globe2, Inbox, Link2, Lock, LockKeyhole, Mail, MessageCircle, Search, Send, Share2, UserRoundPen, UsersRound, X } from "lucide-react";
import { DirectoryRecipientPicker } from "./directory-recipient-picker";
import { avatarDataUri } from "./profile-onboarding";
import { QuestionDiffReview } from "./question-diff-review";
import {
  createCourseShareLink, getCourseComments, getGlobalCourse, getGlobalRevisions, getInbox, getLocalCourses, getSyncStatus,
  getStoredCourseQuestion, getStoredCourseQuestions, getSuggestions, getSyncPreferences, importCourseShareLink, importGlobalCourse, makeCoursePrivate,
  postCourseComment, publishCourse, reviewCourseInvite, reviewGlobalRevision, reviewSuggestion, revokeCourseShareLink, saveSyncPreferences, setInboxStatus,
  shareCourseWithUser, shareCourseQuestion, type CourseComment, type CourseSummary, type DirectoryUser, type GlobalCourse, type GlobalRevision,
  type InboxItem, type LearnerProfile, type QuestionSuggestion, type StoredQuestion, type SyncPreferences,
} from "./vidmark-client";

export type CollaborationTab = "inbox" | "share" | "discussion" | "people";

const defaultPreferences: SyncPreferences = { autoImportQuestions: false, relayUrl: "wss://vidmark-159-223-136-163.sslip.io/ws" };
const questionLabel = (question: StoredQuestion) => String(question.payload.question ?? question.payload.scenario ?? question.id);
const notificationTitle = (suggestion: QuestionSuggestion) => suggestion.kind === "create" ? "A new question has been added" : "A new question has been updated";

type Props = {
  open: boolean;
  initialTab: CollaborationTab;
  profile: LearnerProfile | null;
  courseId: string;
  courseTitle: string;
  videoId: string;
  onClose: () => void;
  onEditProfile: () => void;
  onQuestionsChanged: () => void;
  onCoursesChanged: () => void;
  onUnreadChange: (count: number) => void;
};

export function StudyPeers({ open, initialTab, profile, courseId, courseTitle, videoId, onClose, onEditProfile, onQuestionsChanged, onCoursesChanged, onUnreadChange }: Props) {
  const [tab, setTab] = useState<CollaborationTab>(initialTab);
  const [deviceId, setDeviceId] = useState("");
  const [suggestions, setSuggestions] = useState<QuestionSuggestion[]>([]);
  const [questions, setQuestions] = useState<StoredQuestion[]>([]);
  const [preferences, setPreferences] = useState<SyncPreferences>(defaultPreferences);
  const [relayConnected, setRelayConnected] = useState(false);
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const [inboxFilter, setInboxFilter] = useState<"all" | "unread">("all");
  const [localCourse, setLocalCourse] = useState<CourseSummary | null>(null);
  const [globalCourse, setGlobalCourse] = useState<GlobalCourse | null>(null);
  const [globalRevisions, setGlobalRevisions] = useState<GlobalRevision[]>([]);
  const [comments, setComments] = useState<CourseComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [replyTo, setReplyTo] = useState<CourseComment | null>(null);
  const [shareLink, setShareLink] = useState("");
  const [oneTimeLink, setOneTimeLink] = useState(false);
  const [importLink, setImportLink] = useState("");
  const [selectedQuestionId, setSelectedQuestionId] = useState("");
  const [reviewing, setReviewing] = useState<QuestionSuggestion | null>(null);
  const [currentQuestion, setCurrentQuestion] = useState<StoredQuestion | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const refreshCore = useCallback(async () => {
    if (!profile) return;
    try {
      const [syncState, suggestionState, storedPreferences, storedQuestions, storedInbox, courses] = await Promise.all([
        getSyncStatus(), getSuggestions(courseId), getSyncPreferences(), getStoredCourseQuestions(courseId), getInbox(), getLocalCourses(),
      ]);
      setDeviceId(syncState.deviceId);
      setRelayConnected(syncState.relay.connected);
      setSuggestions(suggestionState.filter((item) => item.status === "pending"));
      setPreferences(storedPreferences);
      setQuestions(storedQuestions);
      setSelectedQuestionId((current) => current || storedQuestions[0]?.id || "");
      setInboxItems(storedInbox);
      setLocalCourse(courses.find((course) => course.id === courseId) ?? null);
      onUnreadChange(storedInbox.filter((item) => item.status === "unread").length);
    } catch (error) {
      if (open) setStatus(error instanceof Error ? error.message : "Could not load collaboration data.");
    }
  }, [courseId, onUnreadChange, open, profile]);

  const refreshPublic = useCallback(async () => {
    if (!profile || !open || (tab !== "share" && tab !== "discussion")) return;
    try {
      if (tab === "discussion") setComments(await getCourseComments(videoId));
      else {
        const [global, revisions] = await Promise.all([getGlobalCourse(videoId), getGlobalRevisions(videoId)]);
        setGlobalCourse(global);
        setGlobalRevisions(revisions);
      }
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not load public collaboration."); }
  }, [open, profile, tab, videoId]);

  useEffect(() => {
    if (!profile) return;
    const initial = window.setTimeout(() => void refreshCore(), 0);
    const timer = window.setInterval(() => void refreshCore(), 3000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [profile, refreshCore]);

  useEffect(() => { const timer = window.setTimeout(() => void refreshPublic(), 0); return () => window.clearTimeout(timer); }, [refreshPublic]);

  const run = async (action: () => Promise<void>, fallback: string) => {
    setLoading(true); setStatus("");
    try { await action(); }
    catch (error) { setStatus(error instanceof Error ? error.message : fallback); }
    finally { setLoading(false); }
  };

  const openReview = (suggestion: QuestionSuggestion) => run(async () => { setReviewing(suggestion); setCurrentQuestion(suggestion.questionId ? await getStoredCourseQuestion(suggestion.courseId, suggestion.questionId) : null); }, "Could not load your question version.");
  const decideQuestion = (suggestion: QuestionSuggestion, decision: "accepted" | "rejected") => run(async () => { await reviewSuggestion(suggestion.id, decision); if (decision === "accepted") onQuestionsChanged(); setReviewing(null); setStatus(decision === "accepted" ? "Question imported into your library." : "Question update rejected."); await refreshCore(); }, "Could not review the question.");
  const dismissDuplicateQuestion = (suggestion: QuestionSuggestion) => run(async () => { await reviewSuggestion(suggestion.id, "rejected"); setReviewing(null); setStatus("Duplicate share dismissed; your question was already current."); await refreshCore(); }, "Could not dismiss the duplicate question.");
  const updatePreferences = (next: SyncPreferences) => run(async () => { setPreferences(await saveSyncPreferences(next)); }, "Could not save sync preferences.");
  const shareSelectedQuestion = (user: DirectoryUser) => run(async () => { const result = await shareCourseQuestion(courseId, selectedQuestionId, user); setStatus(`Question shared securely with ${user.profile.name} across ${result.delivered.length} registered device${result.delivered.length === 1 ? "" : "s"}.`); }, "Could not share the question.");
  const shareToUser = (user: DirectoryUser) => run(async () => { await shareCourseWithUser(courseId, user); setStatus(`Course invitation added to ${user.profile.name}’s Vidmark inbox. No email was sent.`); }, "Could not share the course.");
  const makeCourseLink = () => run(async () => { const result = await createCourseShareLink(courseId, oneTimeLink); setShareLink(result.link); await navigator.clipboard.writeText(result.link); setStatus(`${result.oneTime ? "One-time" : "Reusable"} HTTPS invite copied. It expires in seven days.`); }, "Could not create a course link.");
  const revokeCourseLink = () => run(async () => { await revokeCourseShareLink(shareLink); setShareLink(""); setStatus("Course invite revoked."); }, "Could not revoke the course invite.");
  const resolveLink = () => run(async () => { await importCourseShareLink(importLink); setImportLink(""); setTab("inbox"); setStatus("Course link added to your inbox for review."); await refreshCore(); }, "Could not open the course link.");
  const changeInboxReadState = (item: InboxItem) => run(async () => { await setInboxStatus(item.id, item.status === "unread" ? "read" : "unread"); await refreshCore(); }, "Could not update the inbox item.");
  const decideInvite = (item: InboxItem, decision: "accepted" | "rejected") => run(async () => { await reviewCourseInvite(item.id, decision); if (decision === "accepted") onCoursesChanged(); setStatus(decision === "accepted" ? "Course imported into your library." : "Course invitation declined."); await refreshCore(); }, "Could not review the course invitation.");
  const publish = () => run(async () => { const result = await publishCourse(courseId); setStatus(result.mode === "registered_global" ? "This course is now the locked global version for its source." : result.mode === "published_revision" ? "Your fork is now the latest locked global revision." : "Your fork was submitted to the global owner for review."); await Promise.all([refreshCore(), refreshPublic()]); }, "Could not publish the course.");
  const makePrivate = () => run(async () => { await makeCoursePrivate(courseId); setStatus("Your local course is private. The locked global snapshot remains available."); await refreshCore(); }, "Could not make the course private.");
  const importGlobal = () => run(async () => { await importGlobalCourse(videoId); onCoursesChanged(); setStatus("The locked global course was imported. Editing it will automatically create a private fork."); await Promise.all([refreshCore(), refreshPublic()]); }, "Could not import the global course.");
  const decideRevision = (revision: GlobalRevision, decision: "accepted" | "rejected") => run(async () => { await reviewGlobalRevision(videoId, revision.id, decision); if (decision === "accepted") onCoursesChanged(); setStatus(`Revision ${decision}.`); await Promise.all([refreshCore(), refreshPublic()]); }, "Could not review the global revision.");
  const postComment = () => run(async () => { await postCourseComment(courseId, commentBody, replyTo?.id); setCommentBody(""); setReplyTo(null); setComments(await getCourseComments(videoId)); }, "Could not post the comment.");

  const visibleInbox = useMemo(() => inboxFilter === "unread" ? inboxItems.filter((item) => item.status === "unread") : inboxItems, [inboxFilter, inboxItems]);
  const newestSuggestion = suggestions[0];
  const isGlobalOwner = Boolean(globalCourse?.ownerDeviceId && globalCourse.ownerDeviceId === deviceId);

  return <>
    {newestSuggestion && !reviewing ? <div className="peer-question-toast" role="status"><Bell aria-hidden="true" /><span><b>{notificationTitle(newestSuggestion)}</b><small>{newestSuggestion.authorProfile?.name ?? "A Vidmark user"} included its answer and rationale.</small></span><button type="button" onClick={() => void openReview(newestSuggestion)}>Review</button></div> : null}
    {open ? <aside className="peer-drawer collaboration-drawer" aria-label="Collaboration">
      <header><div><span>VIDMARK NETWORK</span><h1>Collaboration</h1></div><button type="button" aria-label="Close collaboration" onClick={onClose}><X aria-hidden="true" /></button></header>
      <nav className="collaboration-tabs" aria-label="Collaboration sections">
        <button className={tab === "inbox" ? "active" : ""} onClick={() => setTab("inbox")}><Inbox aria-hidden="true" />Inbox{inboxItems.some((item) => item.status === "unread") ? <i>{inboxItems.filter((item) => item.status === "unread").length}</i> : null}</button>
        <button className={tab === "share" ? "active" : ""} onClick={() => setTab("share")}><Share2 aria-hidden="true" />Share</button>
        <button className={tab === "discussion" ? "active" : ""} onClick={() => setTab("discussion")}><MessageCircle aria-hidden="true" />Discussion</button>
        <button className={tab === "people" ? "active" : ""} onClick={() => setTab("people")}><UsersRound aria-hidden="true" />People</button>
      </nav>
      {tab === "inbox" ? <InboxPanel items={visibleInbox} filter={inboxFilter} loading={loading} onFilter={setInboxFilter} onToggleRead={changeInboxReadState} onDecision={decideInvite} /> : null}
      {tab === "share" ? <SharePanel courseTitle={courseTitle} videoId={videoId} localCourse={localCourse} globalCourse={globalCourse} revisions={globalRevisions} isGlobalOwner={isGlobalOwner} shareLink={shareLink} importLink={importLink} oneTimeLink={oneTimeLink} loading={loading} onShareUser={shareToUser} onCreateLink={makeCourseLink} onRevokeLink={revokeCourseLink} onOneTimeLink={setOneTimeLink} onImportLink={setImportLink} onResolveLink={resolveLink} onPublish={publish} onPrivate={makePrivate} onImportGlobal={importGlobal} onRevision={decideRevision} /> : null}
      {tab === "discussion" ? <DiscussionPanel courseTitle={courseTitle} videoId={videoId} comments={comments} body={commentBody} replyTo={replyTo} loading={loading} onBody={setCommentBody} onReply={setReplyTo} onPost={postComment} /> : null}
      {tab === "people" ? <PeoplePanel profile={profile} syncOnline={relayConnected} questions={questions} selectedQuestionId={selectedQuestionId} suggestions={suggestions} preferences={preferences} loading={loading} onEditProfile={onEditProfile} onSelectedQuestion={setSelectedQuestionId} onShareQuestion={shareSelectedQuestion} onPreferences={updatePreferences} onQuestionDecision={decideQuestion} onQuestionReview={openReview} /> : null}
      {status ? <div className="peer-status" role="status">{status}</div> : null}
    </aside> : null}
    {reviewing ? <QuestionDiffReview suggestion={reviewing} current={currentQuestion} preferences={preferences} loading={loading} onClose={() => setReviewing(null)} onDismiss={() => void dismissDuplicateQuestion(reviewing)} onImport={() => void decideQuestion(reviewing, "accepted")} onPreferencesChange={(next) => void updatePreferences(next)} /> : null}
  </>;
}

function InboxPanel({ items, filter, loading, onFilter, onToggleRead, onDecision }: { items: InboxItem[]; filter: "all" | "unread"; loading: boolean; onFilter: (value: "all" | "unread") => void; onToggleRead: (item: InboxItem) => Promise<void>; onDecision: (item: InboxItem, decision: "accepted" | "rejected") => Promise<void> }) {
  return <div className="collaboration-panel"><div className="collaboration-panel-head"><div><span>INVITATIONS & UPDATES</span><h2>Inbox</h2></div><div className="inbox-filters"><button className={filter === "all" ? "active" : ""} onClick={() => onFilter("all")}>All</button><button className={filter === "unread" ? "active" : ""} onClick={() => onFilter("unread")}>Unread</button></div></div><div className="inbox-list">{items.map((item) => <article className={`inbox-card ${item.status}`} key={item.id}><button className="inbox-main" type="button" onClick={() => void onToggleRead(item)}><span className="inbox-kind">{item.type === "course_invite" ? <Mail aria-hidden="true" /> : item.type === "revision" ? <Globe2 aria-hidden="true" /> : <MessageCircle aria-hidden="true" />}</span><span><b>{item.title}</b><small>{item.preview}</small><em>{new Date(item.createdAt).toLocaleString()}</em></span>{item.status === "unread" ? <i aria-label="Unread" /> : null}</button>{item.type === "course_invite" && item.actionStatus === "pending" ? <footer><button disabled={loading} onClick={() => void onDecision(item, "rejected")}>Decline</button><button className="primary" disabled={loading} onClick={() => void onDecision(item, "accepted")}>Import course</button></footer> : <footer><span>{item.actionStatus === "none" ? item.status : item.actionStatus}</span><button onClick={() => void onToggleRead(item)}>Mark {item.status === "unread" ? "read" : "unread"}</button></footer>}</article>)}{!items.length ? <div className="collaboration-empty"><Inbox aria-hidden="true" /><b>{filter === "unread" ? "You’re all caught up" : "Your inbox is empty"}</b><p>Shared courses and public revision requests will appear here.</p></div> : null}</div></div>;
}

function SharePanel(props: { courseTitle: string; videoId: string; localCourse: CourseSummary | null; globalCourse: GlobalCourse | null; revisions: GlobalRevision[]; isGlobalOwner: boolean; shareLink: string; importLink: string; oneTimeLink: boolean; loading: boolean; onShareUser: (user: DirectoryUser) => Promise<void>; onCreateLink: () => Promise<void>; onRevokeLink: () => Promise<void>; onOneTimeLink: (value: boolean) => void; onImportLink: (value: string) => void; onResolveLink: () => Promise<void>; onPublish: () => Promise<void>; onPrivate: () => Promise<void>; onImportGlobal: () => Promise<void>; onRevision: (revision: GlobalRevision, decision: "accepted" | "rejected") => Promise<void> }) {
  const { courseTitle, videoId, localCourse, globalCourse, revisions, isGlobalOwner, shareLink, importLink, oneTimeLink, loading } = props;
  return <div className="collaboration-panel">
    <div className="collaboration-panel-head"><div><span>CURRENT COURSE</span><h2>Share “{courseTitle}”</h2></div><span className={`visibility-pill ${localCourse?.visibility ?? "private"}`}>{localCourse?.visibility === "public" ? <Globe2 aria-hidden="true" /> : <Lock aria-hidden="true" />}{localCourse?.visibility ?? "private"}</span></div>
    <section className="share-method recipient-share-method">
      <h3><Search aria-hidden="true" />Choose who to share with</h3>
      <p>Search for a registered Vidmark user by name or email. Email addresses only search the Vidmark directory—no email is sent.</p>
      <DirectoryRecipientPicker actionLabel="Share course" disabled={loading} onSelect={props.onShareUser} />
    </section>
    <section className="global-course-card"><header><div><b>Global course for this source</b><small>Source key · {videoId}</small></div>{globalCourse ? <span>v{globalCourse.version}</span> : <span>Unregistered</span>}</header>{globalCourse ? <p>Locked by {globalCourse.ownerProfile.name}. Import it as a forkable snapshot, or submit your local changes as a revision.</p> : <p>The first public version becomes the locked global course. Future edits automatically become a private fork.</p>}<div>{localCourse?.visibility === "public" ? <button onClick={() => void props.onPrivate()} disabled={loading}><Lock aria-hidden="true" />Make local version private</button> : <button className="primary" onClick={() => void props.onPublish()} disabled={loading}><Globe2 aria-hidden="true" />{globalCourse ? "Submit or publish revision" : "Register global course"}</button>}{globalCourse && localCourse?.globalVersion !== globalCourse.version ? <button onClick={() => void props.onImportGlobal()} disabled={loading}>Import global v{globalCourse.version}</button> : null}</div>{localCourse?.forkedFromVersion ? <small className="fork-note">Private fork from global version {localCourse.forkedFromVersion}</small> : null}</section>
    {isGlobalOwner && revisions.some((revision) => revision.status === "pending") ? <section className="revision-list"><h3>Revision requests</h3>{revisions.filter((revision) => revision.status === "pending").map((revision) => <article key={revision.id}><div><b>{revision.proposerProfile.name}</b><small>Forked from v{revision.baseVersion} · {new Date(revision.createdAt).toLocaleString()}</small></div><span><button onClick={() => void props.onRevision(revision, "rejected")}>Reject</button><button className="primary" onClick={() => void props.onRevision(revision, "accepted")}>Publish</button></span></article>)}</section> : null}
    <section className="share-method"><h3><Link2 aria-hidden="true" />Invite URL</h3><p>Create a normal HTTPS bearer link that expires in seven days. Anyone with the URL can import the course, so share it like a password.</p><label className="provider-check" htmlFor="one-time-course-invite" aria-label="One-time use"><input id="one-time-course-invite" type="checkbox" checked={oneTimeLink} onChange={(event) => props.onOneTimeLink(event.target.checked)} /><span><b>One-time use</b><small>Expire the invite immediately after its first successful import.</small></span></label><button onClick={() => void props.onCreateLink()} disabled={loading}>Create and copy invite</button>{shareLink ? <><code>{shareLink}</code><button onClick={() => void props.onRevokeLink()} disabled={loading}>Revoke invite</button></> : null}<div className="import-link-row"><input value={importLink} onChange={(event) => props.onImportLink(event.target.value)} placeholder="Paste an https://…/invite/… URL" aria-label="HTTPS course invite URL" /><button onClick={() => void props.onResolveLink()} disabled={!importLink.trim()}>Open</button></div></section>
  </div>;
}

function DiscussionPanel({ courseTitle, videoId, comments, body, replyTo, loading, onBody, onReply, onPost }: { courseTitle: string; videoId: string; comments: CourseComment[]; body: string; replyTo: CourseComment | null; loading: boolean; onBody: (value: string) => void; onReply: (value: CourseComment | null) => void; onPost: () => Promise<void> }) {
  return <div className="collaboration-panel discussion-panel"><div className="collaboration-panel-head"><div><span>PUBLIC COURSE THREAD</span><h2>{courseTitle}</h2><p>Every Vidmark course using source key {videoId} shares this conversation.</p></div><MessageCircle aria-hidden="true" /></div><div className="comment-composer">{replyTo ? <div className="replying-to"><span>Replying to {replyTo.authorProfile.name}</span><button onClick={() => onReply(null)}>×</button></div> : null}<textarea value={body} onChange={(event) => onBody(event.target.value)} placeholder="Add a public comment about this video or course…" maxLength={5000} /><footer><small>{body.length}/5,000 · visible to everyone</small><button onClick={() => void onPost()} disabled={loading || !body.trim()}><Send aria-hidden="true" />Post</button></footer></div><div className="comment-thread">{comments.map((comment) => <article className={comment.parentId ? "reply" : ""} key={comment.id}><img src={avatarDataUri(comment.authorProfile.avatarStyle, comment.authorProfile.avatarSeed)} alt="" /><div><header><b>{comment.authorProfile.name}</b><time>{new Date(comment.createdAt).toLocaleString()}</time></header><p>{comment.body}</p><button onClick={() => onReply(comment)}>Reply</button></div></article>)}{!comments.length ? <div className="collaboration-empty"><MessageCircle aria-hidden="true" /><b>Start the conversation</b><p>Comments are public and associated with this course source.</p></div> : null}</div></div>;
}

function PeoplePanel(props: { profile: LearnerProfile | null; syncOnline: boolean; questions: StoredQuestion[]; selectedQuestionId: string; suggestions: QuestionSuggestion[]; preferences: SyncPreferences; loading: boolean; onEditProfile: () => void; onSelectedQuestion: (value: string) => void; onShareQuestion: (user: DirectoryUser) => Promise<void>; onPreferences: (value: SyncPreferences) => Promise<void>; onQuestionDecision: (suggestion: QuestionSuggestion, decision: "accepted" | "rejected") => Promise<void>; onQuestionReview: (suggestion: QuestionSuggestion) => Promise<void> }) {
  const { profile, syncOnline, questions, selectedQuestionId, suggestions, preferences, loading } = props;
  return <div className="collaboration-panel people-panel">{profile ? <section className="peer-device"><div className="peer-section-title"><h2>This device</h2><button type="button" onClick={props.onEditProfile}><UserRoundPen aria-hidden="true" />Edit profile</button></div><div className="peer-person"><img src={avatarDataUri(profile.avatarStyle, profile.avatarSeed)} alt="" /><span><b>{profile.name}</b><small>{profile.email}</small><em>Searchable in the Vidmark directory</em></span></div><div className={`sync-state ${syncOnline ? "online" : "offline"}`}><span aria-hidden="true" /><div><b>{syncOnline ? "Sync online" : "Sync reconnecting"}</b><small>{syncOnline ? "Ready to send and receive through Vidmark Sync." : "Changes remain on this Mac until the sync service reconnects."}</small></div></div><p><LockKeyhole aria-hidden="true" />Direct user shares are end-to-end encrypted. Public courses, discussions, directory profiles, and bearer-link bundles are stored by the sync service.</p></section> : null}<section><h2>Share a question</h2><p>Choose a registered user by name or email. They receive a notification and review the complete question, answer, and diff before importing it.</p><div className="question-share-row"><select aria-label="Question to share" value={selectedQuestionId} onChange={(event) => props.onSelectedQuestion(event.target.value)}>{questions.map((question) => <option value={question.id} key={question.id}>{questionLabel(question)}</option>)}</select></div><DirectoryRecipientPicker actionLabel="Share question" disabled={loading || !selectedQuestionId} onSelect={props.onShareQuestion} /></section><section><div className="peer-section-title"><h2>Question imports</h2><span>{suggestions.length}</span></div><p>Automatic question imports are {preferences.autoImportQuestions ? "on" : "off"}. Change this in Settings → Imports.</p>{suggestions.map((suggestion) => <article className="suggestion-row" key={suggestion.id}>{suggestion.authorProfile ? <img src={avatarDataUri(suggestion.authorProfile.avatarStyle, suggestion.authorProfile.avatarSeed)} alt="" /> : <UsersRound aria-hidden="true" />}<div><b>{suggestion.authorProfile?.name ?? "Vidmark user"}</b><strong>{notificationTitle(suggestion)}</strong><p>{suggestion.rationale}</p><small>{new Date(suggestion.createdAt).toLocaleString()}</small><span><button type="button" disabled={loading} onClick={() => void props.onQuestionDecision(suggestion, "rejected")}>Reject</button><button className="review" type="button" disabled={loading} onClick={() => void props.onQuestionReview(suggestion)}>Review</button></span></div></article>)}{!suggestions.length ? <p className="peer-empty">No question changes are waiting for review.</p> : null}</section></div>;
}
