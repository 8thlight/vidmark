import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CourseMarkdown } from "../app/course-markdown";
import { CourseChapters } from "../app/course-chapters";

const render = (text: string) => renderToStaticMarkup(<CourseMarkdown>{text}</CourseMarkdown>);

test("course Markdown renders headings, emphasis, lists, source links, and code", () => {
  const html = render('# Lesson\n\n## Exercise\n\n**Important** and *useful*. Read [the source](https://example.com/docs).\n\n1. Inspect\n2. Verify\n\n- One\n- Two\n\nUse `stop_reason`.\n\n```js\nconst x = "<test>";\n```');
  expect(html).toContain("<h3>Lesson</h3>");
  expect(html).toContain("<h4>Exercise</h4>");
  expect(html).toContain("<strong>Important</strong>");
  expect(html).toContain("<em>useful</em>");
  expect(html).toContain("<ol>"); expect(html).toContain("<ul>");
  expect(html).toContain('href="https://example.com/docs"');
  expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  expect(html).not.toContain("[the source]");
  expect(html).toContain("<code>stop_reason</code>");
  expect(html).toContain('<pre><code class="language-js">');
  expect(html).toContain("&lt;test&gt;");
});

test("GFM tables, task lists, strikethrough, bare links, and quotes render", () => {
  const html = render('| Task | Evidence |\n| --- | --- |\n| Build | Logs |\n\n- [x] Reviewed\n- [ ] Pending\n\n~~Old~~\n\nhttps://example.com/docs\n\n> Verify first.');
  expect(html).toContain('class="course-markdown-table" role="region" aria-label="Scrollable table" tabindex="0"');
  expect(html).toContain("<th>Task</th>"); expect(html).toContain("<td>Logs</td>");
  expect(html).toContain('type="checkbox" disabled="" checked=""');
  expect(html).toContain("<del>Old</del>");
  expect(html).toContain('href="https://example.com/docs"');
  expect(html).toContain("<blockquote>");
});

test("plain paragraphs and escaped Markdown retain their intended content", () => {
  const html = render('A plain lesson.\n\nSecond paragraph costs $100/month.\n\n\\*literal asterisk\\* and snake_case_identifier.');
  expect(html).toContain("<p>A plain lesson.</p>");
  expect(html).toContain("<p>Second paragraph costs $100/month.</p>");
  expect(html).toContain("*literal asterisk* and snake_case_identifier.");
});

test("untrusted course HTML, executable URLs, and local app URLs never execute", () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29) [file](file:///etc/passwd) [app](vidmark://invite/x) [relative](/settings) [protocol-relative](//example.com) [data](data:text/html,hello)\n\n[encoded](jav&#x61;script:alert%281%29)');
  expect(html).not.toMatch(/<script|<img|onerror|href=/);
  expect(html).toContain("<span>bad</span>");
  expect(html).toContain("<span>encoded</span>");
});

test("remote Markdown images require a click instead of automatically fetching", () => {
  const html = render('![Architecture diagram](https://example.com/diagram.png)');
  expect(html).not.toContain("<img"); expect(html).not.toContain('rel="preload"');
  expect(html).toContain('href="https://example.com/diagram.png"');
  expect(html).toContain("Architecture diagram ↗");
});

test("footnotes stay in the app and have distinct IDs across course sections", () => {
  const markdown = 'Evidence[^1].\n\n[^1]: The source.';
  const html = renderToStaticMarkup(<div><CourseMarkdown>{markdown}</CourseMarkdown><CourseMarkdown>{markdown}</CourseMarkdown></div>);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]);
  expect(ids.length).toBeGreaterThan(2); expect(new Set(ids).size).toBe(ids.length);
  const anchors = [...html.matchAll(/<a [^>]*href="#([^"]+)"[^>]*>/g)];
  expect(anchors.length).toBe(4);
  for (const [tag, id] of anchors) {
    expect(ids).toContain(id); expect(tag).not.toContain('target="_blank"');
  }
});

test("chapter lessons actually use Markdown without losing chapter actions", () => {
  const html = renderToStaticMarkup(<CourseChapters chapters={[{ id: "intro", title: "Intro", content: '## Read this\n\n[Installer and OS choice](https://www.youtube.com/watch?v=o3CX_Y59_74&t=78s)' }]} query="" onNotes={() => {}} />);
  expect(html).toContain('class="course-markdown chapter-content"');
  expect(html).toContain("<h4>Read this</h4>");
  expect(html).toContain('href="https://www.youtube.com/watch?v=o3CX_Y59_74&amp;t=78s"');
  expect(html).not.toContain("[Installer and OS choice]");
  expect(html).toContain("Take notes");
});
