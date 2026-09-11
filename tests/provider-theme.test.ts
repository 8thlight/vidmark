import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
// Guard the provider-specific theme contract; rendered interaction checks also
// exercise the cascade, radio selection, logo loading, and keyboard focus.
function declarations(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]+)\\}`))?.[1];
  if (!block) throw new Error(`Missing provider theme rule: ${selector}`);
  return Object.fromEntries(block.split(";").filter(value => value.trim()).map(value => {
    const colon = value.indexOf(":"); return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()];
  }));
}
function resolve(value: string, variables: Record<string, string>): string {
  const match = value.match(/^var\((--[\w-]+)(?:,\s*(.+))?\)$/);
  return match ? resolve(variables[match[1]] ?? match[2], variables) : value;
}
function luminance(hex: string) {
  const full = hex.length === 4 ? hex.slice(1).split("").map(value => value + value).join("") : hex.slice(1);
  return [0, 2, 4].map(offset => parseInt(full.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
for (const theme of ["light", "dark"]) for (const selected of [false, true]) test(`provider text contrast: ${theme}, ${selected ? "selected" : "unselected"}`, () => {
  const variables = { ...declarations(":root"), ...(theme === "dark" ? { ...declarations('.app-shell[data-theme="dark"]'), ...declarations('.app-shell[data-theme="dark"] .agent-harness-picker') } : {}) };
  const surface = declarations(`.agent-harness-picker .agent-provider-radio${selected ? ".selected" : ""}`);
  const background = resolve(surface.background, variables);
  expect(contrast(resolve(declarations(".agent-provider-radio b").color, variables), background)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(resolve(declarations(".agent-provider-radio small").color, variables), background)).toBeGreaterThanOrEqual(4.5);
  // The in-app server glyph inherits the label color, including when selected.
  expect(contrast(resolve(declarations(".agent-harness-picker .agent-provider-radio").color, variables), background)).toBeGreaterThanOrEqual(3);
});
test("only the monochrome OpenAI mark gets the dark-theme inversion", () => {
  expect(declarations('.app-shell[data-theme="dark"] .agent-provider-radio img[src$="/openai.svg"]').filter).toBe("brightness(0) invert(1)");
  expect(declarations(".agent-provider-radio img, .agent-provider-radio > svg").filter).toBeUndefined();
});
