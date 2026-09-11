import { memo, useId } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { webUrl } from "./course-source";

const plugins = [remarkGfm];
// Shared/agent-authored courses are untrusted. Only explicit web links and
// document footnotes are navigable; never interpret raw HTML or app/file URLs.
function courseUrl(url: string, property: string): string {
  return property === "href" && url.startsWith("#") ? url : webUrl(url);
}

type MarkdownNode = { properties?: Record<string, unknown>; children?: MarkdownNode[] };
// remark scopes footnote targets, but leaves its accessible label ID global.
// Scope that label too because chapters and the guide share the same document.
function scopeFootnoteLabel({ prefix }: { prefix: string }) {
  return function transform(node: MarkdownNode) {
    if (node.properties?.id === "footnote-label") node.properties.id = `${prefix}footnote-label`;
    if (Array.isArray(node.properties?.ariaDescribedBy)) node.properties.ariaDescribedBy = node.properties.ariaDescribedBy.map(id => id === "footnote-label" ? `${prefix}footnote-label` : id);
    node.children?.forEach(transform);
  };
}

const components: Components = {
  h1: "h3", h2: "h4", h3: "h5", h4: "h6", h5: "h6", h6: "h6",
  a: ({ href, children, ...props }) => {
    delete props.node; // The syntax-tree node is not a DOM attribute.
    return href
      ? <a {...props} href={href} target={href.startsWith("#") ? undefined : "_blank"} rel={href.startsWith("#") ? undefined : "noopener noreferrer"}>{children}</a>
      : <span>{children}</span>;
  },
  // Do not fetch third-party images just by opening a shared course.
  img: ({ src, alt }) => typeof src === "string" && src
    ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || "Open image"} ↗</a>
    : <span>{alt}</span>,
  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Overflow tables must be keyboard-scrollable in WKWebView.
  table: ({ children }) => <div className="course-markdown-table" role="region" aria-label="Scrollable table" tabIndex={0}><table>{children}</table></div>,
};

export const CourseMarkdown = memo(function CourseMarkdown({ children, className = "" }: { children: string; className?: string }) {
  const id = useId();
  const prefix = `course-${id}-`;
  return <div className={`course-markdown ${className}`.trim()}>
    <Markdown remarkPlugins={plugins} remarkRehypeOptions={{ clobberPrefix: prefix }} rehypePlugins={[[scopeFootnoteLabel, { prefix }]]} components={components} urlTransform={courseUrl} skipHtml>{children}</Markdown>
  </div>;
});
