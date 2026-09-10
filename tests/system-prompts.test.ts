import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeCourseBuildPrompt, vidmarkMasterCourseBuildPrompt } from "../app/course-prompts";
import { getSystemPrompt, listSystemPromptSettings, renderSystemPrompt } from "../app/system-prompts";
import { readSystemPromptOverrides, writeSystemPromptOverrides } from "../scripts/system-prompt-store";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("local system prompt overrides", () => {
  test("reading sources retain requested exam scope without fabricated media", () => {
    expect(vidmarkMasterCourseBuildPrompt).toContain("Do not downgrade a requested exam-preparation course");
    expect(vidmarkMasterCourseBuildPrompt).toContain("original, source-grounded material");
    expect(vidmarkMasterCourseBuildPrompt).toContain("practice drills without fabricated media");
  });
  test("lists every model instruction with its built-in default", () => {
    const prompts = listSystemPromptSettings();
    expect(prompts.map((prompt) => prompt.id)).toEqual(["questionFactCheck", "artifactContract", "cliCoordinator", "courseBuilderMaster", "coordinatorRuntime", "coordinatorContinue", "specialist", "connectionProbe"]);
    expect(prompts.every((prompt) => !prompt.overridden && prompt.defaultValue === prompt.effectiveValue)).toBe(true);
  });

  test("persists only recognized non-empty overrides in a local file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vidmark-system-prompts-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "system-prompts.json");
    await writeSystemPromptOverrides(path, { coordinatorContinue: "Keep going locally.", connectionProbe: "", unknownPrompt: "ignored" });
    const stored = await readSystemPromptOverrides(path);
    expect(stored.overrides).toEqual({ coordinatorContinue: "Keep going locally." });
    expect(getSystemPrompt("coordinatorContinue", stored.overrides)).toBe("Keep going locally.");
  });

  test("applies master and template overrides to the actual execution text", () => {
    const built = composeCourseBuildPrompt("Local course", "course-1", "Course brief", "A. Author", "Local master");
    expect(built.startsWith("Local master\n\nCOURSE TO BUILD")).toBe(true);
    expect(built).not.toContain(vidmarkMasterCourseBuildPrompt);
    expect(renderSystemPrompt("specialist", { specialist: "Act as {{role}} only." }, { role: "QA" })).toBe("Act as QA only.");
  });
});
