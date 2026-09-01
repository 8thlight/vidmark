import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { listSystemPromptSettings, normalizeSystemPromptOverrides, type SystemPromptOverrides } from "../app/system-prompts";

type StoredSystemPrompts = { version: 1; overrides: SystemPromptOverrides; updatedAt: number };

const fallback = (): StoredSystemPrompts => ({ version: 1, overrides: {}, updatedAt: 0 });

export const readSystemPromptOverrides = async (path: string): Promise<StoredSystemPrompts> => {
  try {
    const stored = JSON.parse(await readFile(path, "utf8")) as Partial<StoredSystemPrompts>;
    return { version: 1, overrides: normalizeSystemPromptOverrides(stored.overrides), updatedAt: Number(stored.updatedAt ?? 0) };
  } catch {
    return fallback();
  }
};

export const getSystemPromptSettings = async (path: string) => {
  const stored = await readSystemPromptOverrides(path);
  return { prompts: listSystemPromptSettings(stored.overrides), updatedAt: stored.updatedAt, storage: "local-only" as const };
};

export const writeSystemPromptOverrides = async (path: string, input: unknown) => {
  const overrides = normalizeSystemPromptOverrides(input);
  const stored: StoredSystemPrompts = { version: 1, overrides, updatedAt: Date.now() };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next`;
  await writeFile(temporary, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  return { prompts: listSystemPromptSettings(overrides), updatedAt: stored.updatedAt, storage: "local-only" as const };
};
