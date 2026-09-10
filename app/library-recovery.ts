// Keep SQLite authoritative: a failed read must never trigger a stale cache write.
export function retryLibraryLoad(load: () => Promise<unknown>, onError: () => void, delay = 2000) {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout>;
  const attempt = async () => {
    try { await load(); }
    catch {
      if (cancelled) return;
      onError();
      timer = setTimeout(() => { void attempt(); }, delay);
    }
  };
  timer = setTimeout(() => { void attempt(); }, 0);
  return () => { cancelled = true; clearTimeout(timer); };
}

export function noteBelongsToCourse(noteCourseId: string, course: { id: string; sourceKey?: string }, courses: Array<{ id: string }>) {
  if (noteCourseId === course.id) return true;
  // An explicit database ID takes precedence over a legacy video-ID alias.
  return noteCourseId === course.sourceKey && !courses.some(candidate => candidate.id === noteCourseId);
}
