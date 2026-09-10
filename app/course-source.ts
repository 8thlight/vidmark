export function webUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
    return url.href;
  } catch { return ""; }
}

export function youtubeId(value: string): string {
  const validId = (id: string) => /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
  if (validId(value)) return value;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return "";
    if (url.hostname === "youtu.be") return validId(url.pathname.split("/")[1] ?? "");
    if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(url.hostname)) {
      return validId(url.searchParams.get("v") ?? url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1] ?? "");
    }
  } catch { /* A source need not be a video. */ }
  return "";
}

export type ChapterVideo = { title: string; url: string; startSeconds?: number };

export function chapterVideos(value: unknown): ChapterVideo[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Chapter videos must be an array.");
  return value.map((video) => {
    if (!video || typeof video !== "object" || !webUrl(video.url) || typeof video.title !== "string" || !video.title.trim()) throw new Error("Every chapter video needs a title and an HTTP(S) URL.");
    if (video.startSeconds !== undefined && (!Number.isFinite(video.startSeconds) || video.startSeconds < 0)) throw new Error("Video startSeconds must be a non-negative number.");
    return { title: video.title.trim(), url: webUrl(video.url), ...(video.startSeconds === undefined ? {} : { startSeconds: video.startSeconds }) };
  });
}
