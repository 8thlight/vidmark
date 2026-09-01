import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STARTER_COURSE_ID, VidmarkDatabase } from "../scripts/vidmark-db";

const graph = (id: string, label: string) => ({
  schemaVersion: "1.0.0",
  graphId: id,
  title: `${label} graph`,
  nodes: [
    { id: `${id}-domain`, label, kind: "domain" as const, domainId: id, summary: `${label} domain.` },
    { id: `${id}-concept`, label: `${label} concept`, kind: "concept" as const, domainId: id, summary: `${label} concept.` },
  ],
  edges: [{ source: `${id}-domain`, target: `${id}-concept`, type: "contains", weight: 1, rationale: `${label} contains its concept.` }],
});

let root = "";
let alice: VidmarkDatabase;
let bob: VidmarkDatabase;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vidmark-concept-graphs-"));
  alice = new VidmarkDatabase(join(root, "alice.sqlite"));
  bob = new VidmarkDatabase(join(root, "bob.sqlite"));
});

afterAll(async () => {
  alice.close();
  bob.close();
  await rm(root, { recursive: true, force: true });
});

describe("course concept graphs", () => {
  test("seeds the bundled graph into the starter course", () => {
    const stored = alice.getConceptGraph(STARTER_COURSE_ID);
    expect(stored?.graph.graphId).toBe("cca-f-foundations-concept-graph");
    expect(stored?.graph.nodes.length).toBeGreaterThan(1);
  });

  test("keeps one independently revisioned graph per course", () => {
    alice.upsertCourse({ id: "course-a", title: "Course A", videoUrl: "https://youtube.com/watch?v=aaaaaaaaaaa" });
    alice.upsertCourse({ id: "course-b", title: "Course B", videoUrl: "https://youtube.com/watch?v=bbbbbbbbbbb" });
    const first = alice.saveConceptGraph("course-a", graph("alpha", "Alpha"));
    alice.saveConceptGraph("course-b", graph("beta", "Beta"));
    const second = alice.saveConceptGraph("course-a", { ...graph("alpha", "Alpha revised"), graphId: "alpha" }, first.revision);

    expect(second.revision).toBe(2);
    expect(alice.getConceptGraph("course-a")?.graph.title).toBe("Alpha revised graph");
    expect(alice.getConceptGraph("course-b")?.graph.title).toBe("Beta graph");
    expect(() => alice.saveConceptGraph("course-a", graph("alpha", "Stale"), 1)).toThrow("Revision conflict");
  });

  test("exports and imports the graph with a complete course bundle", () => {
    const bundle = alice.exportCourseBundle("course-a");
    expect(bundle.version).toBe(2);
    expect(bundle.course.conceptGraph?.graphId).toBe("alpha");

    bob.importCourseBundle(bundle);
    expect(bob.getConceptGraph("course-a")?.graph.graphId).toBe("alpha");
    expect(bob.getCourse("course-a")?.conceptGraphRevision).toBe(1);
  });

  test("forks a locked global course when its graph changes", () => {
    alice.setCourseCollaboration("course-a", { visibility: "public", globalVersion: 4, globalOwnerDeviceId: "alice", globalLocked: true });
    const current = alice.getConceptGraph("course-a")!;
    alice.saveConceptGraph("course-a", { ...current.graph, description: "A local graph revision." }, current.revision);
    const course = alice.getCourse("course-a");
    expect(course?.visibility).toBe("private");
    expect(course?.forkedFromVersion).toBe(4);
    expect(course?.globalLocked).toBe(false);
  });
});
