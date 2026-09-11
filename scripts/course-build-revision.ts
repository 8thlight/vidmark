import type { VidmarkDatabase } from "./vidmark-db";

// Own writes advance the build baseline. Reads never silently adopt another
// writer's changes: a conflicting build must restart from the current course.
export function courseBuildRevision(store: VidmarkDatabase, courseId: string) {
  let expected = Number(store.getCourse(courseId)?.revision);
  return {
    run<T>(action: () => T): T {
      return store.db.transaction(() => {
        if (store.getCourse(courseId)?.revision !== expected) throw new Error("Course revision conflict. Another writer changed this course; restart the build from its current content. No artifacts saved.");
        const result = action();
        expected = Number(store.getCourse(courseId)?.revision);
        return result;
      }).immediate();
    },
  };
}
