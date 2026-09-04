export type QuestionChange = { path: string; before: unknown; after: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

export const questionValuesEqual = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

export const questionPayloadsEqual = (left: Record<string, unknown>, right: Record<string, unknown>) => questionValuesEqual(left, right);

export const applyQuestionPatch = (target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (isRecord(value)) next[key] = applyQuestionPatch(isRecord(target[key]) ? target[key] : {}, value);
    else next[key] = value;
  }
  return next;
};

export const questionPayloadChanges = (before: Record<string, unknown>, after: Record<string, unknown>) => {
  const changes: QuestionChange[] = [];
  const visit = (left: unknown, right: unknown, path: string) => {
    if (questionValuesEqual(left, right)) return;
    if (isRecord(left) && isRecord(right)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      keys.forEach((key) => visit(left[key], right[key], path ? `${path}.${key}` : key));
      return;
    }
    changes.push({ path, before: left, after: right });
  };
  visit(before, after, "");
  return changes;
};
