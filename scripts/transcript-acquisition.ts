export type TranscriptCue = { time: number; text: string };

type CaptionTrack = {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
};

type Json3Caption = {
  events?: Array<{
    tStartMs?: number;
    segs?: Array<{ utf8?: string }>;
  }>;
};

type YoutubeBootstrap = {
  INNERTUBE_API_KEY?: string;
  INNERTUBE_CONTEXT?: Record<string, unknown>;
  INNERTUBE_CONTEXT_CLIENT_NAME?: string | number;
  INNERTUBE_CONTEXT_CLIENT_VERSION?: string;
  VISITOR_DATA?: string;
  PAGE_CL?: number;
  PAGE_BUILD_LABEL?: string;
};

const youtubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"]);
const youtubeUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

export const youtubeVideoId = (value: string) => {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  let url: URL;
  try { url = new URL(trimmed); }
  catch { throw new Error("The course does not have a valid YouTube URL or video ID."); }
  if (!youtubeHosts.has(url.hostname.toLowerCase())) throw new Error("Automatic transcript acquisition currently supports YouTube courses only.");
  const candidate = url.hostname.toLowerCase() === "youtu.be"
    ? url.pathname.split("/").filter(Boolean)[0]
    : url.searchParams.get("v") ?? url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/)?.[1];
  if (!candidate || !/^[A-Za-z0-9_-]{11}$/.test(candidate)) throw new Error("The course URL does not contain a valid YouTube video ID.");
  return candidate;
};

const extractJsonArray = (source: string, marker: string) => {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = source.indexOf("[", markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
};

const extractJsonObject = (source: string, marker: string) => {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = source.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
};

export const parseJson3Transcript = (payload: Json3Caption): TranscriptCue[] => {
  const cues: TranscriptCue[] = [];
  for (const event of payload.events ?? []) {
    const text = (event.segs ?? []).map((segment) => segment.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (!text || !Number.isFinite(event.tStartMs)) continue;
    const cue = { time: Math.max(0, Number(event.tStartMs) / 1000), text };
    const previous = cues.at(-1);
    if (previous && previous.time === cue.time && previous.text === cue.text) continue;
    cues.push(cue);
  }
  return cues;
};

const trackName = (track: CaptionTrack) => track.name?.simpleText ?? track.name?.runs?.map((run) => run.text ?? "").join("") ?? track.languageCode ?? "Unknown";

const chooseTrack = (tracks: CaptionTrack[], preferredLanguage: string) => {
  const requested = preferredLanguage.trim().toLowerCase();
  return tracks.toSorted((left, right) => {
    const score = (track: CaptionTrack) => {
      const language = (track.languageCode ?? "").toLowerCase();
      if (requested && language === requested) return 0;
      if (requested && language.startsWith(`${requested}-`)) return 1;
      if (language === "en") return 2;
      if (language.startsWith("en-")) return 3;
      return 4;
    };
    return score(left) - score(right) || Number(left.kind === "asr") - Number(right.kind === "asr");
  })[0];
};

const fetchText = async (url: URL, label: string) => {
  const response = await fetch(url, {
    headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.8", "Cache-Control": "no-cache", "User-Agent": youtubeUserAgent },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > 20 * 1024 * 1024) throw new Error(`${label} was unexpectedly large.`);
  const text = await response.text();
  if (text.length > 20 * 1024 * 1024) throw new Error(`${label} was unexpectedly large.`);
  return text;
};

const decodeCaptionText = (value: string) => value
  .replaceAll("&amp;", "&")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"')
  .replaceAll("&#39;", "'")
  .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
  .replace(/\s+/g, " ")
  .trim();

const downloadCaptionTrack = async (track: CaptionTrack) => {
  if (!track.baseUrl) return [];
  const captionUrl = new URL(track.baseUrl);
  const captionHost = captionUrl.hostname.toLowerCase();
  if (captionUrl.protocol !== "https:" || (captionHost !== "youtube.com" && !captionHost.endsWith(".youtube.com"))) throw new Error("YouTube returned an unexpected caption source.");
  captionUrl.searchParams.set("fmt", "json3");
  const jsonText = await fetchText(captionUrl, "YouTube caption track");
  if (jsonText.trim()) {
    try {
      const cues = parseJson3Transcript(JSON.parse(jsonText) as Json3Caption);
      if (cues.length) return cues;
    } catch { /* Try the XML representation below. */ }
  }
  captionUrl.searchParams.delete("fmt");
  const xml = await fetchText(captionUrl, "YouTube caption track");
  const cues: TranscriptCue[] = [];
  for (const match of xml.matchAll(/<text\b[^>]*\bstart="([0-9.]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    const time = Number(match[1]);
    const text = decodeCaptionText(match[2] ?? "");
    if (Number.isFinite(time) && text) cues.push({ time, text });
  }
  return cues;
};

const acquireFromAndroidPlayer = async (page: string, videoId: string, preferredLanguage: string) => {
  const configStart = page.indexOf("ytcfg.set({");
  const configJson = configStart < 0 ? null : extractJsonObject(page.slice(configStart + "ytcfg.set(".length), "");
  if (!configJson) return null;
  let config: YoutubeBootstrap;
  try { config = JSON.parse(configJson) as YoutubeBootstrap; }
  catch { return null; }
  if (!config.INNERTUBE_API_KEY) return null;
  const endpoint = new URL("https://www.youtube.com/youtubei/v1/player");
  endpoint.searchParams.set("key", config.INNERTUBE_API_KEY);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json", "User-Agent": youtubeUserAgent },
    body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", hl: preferredLanguage || "en" } }, videoId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return null;
  const payload = await response.json() as { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } } };
  const tracks = payload.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = chooseTrack(tracks.filter((candidate) => candidate.baseUrl), preferredLanguage);
  if (!track) return null;
  const cues = await downloadCaptionTrack(track);
  return cues.length ? { track, cues } : null;
};

const parseTranscriptEndpoint = (payload: unknown): TranscriptCue[] => {
  const cues: TranscriptCue[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const renderer = record.transcriptSegmentRenderer;
    if (renderer && typeof renderer === "object" && !Array.isArray(renderer)) {
      const segment = renderer as Record<string, unknown>;
      const snippet = segment.snippet as { runs?: Array<{ text?: string }> } | undefined;
      const text = (snippet?.runs ?? []).map((run) => run.text ?? "").join("").replace(/\s+/g, " ").trim();
      const startMs = Number(segment.startMs);
      if (text && Number.isFinite(startMs)) cues.push({ time: Math.max(0, startMs / 1000), text });
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(payload);
  return cues.toSorted((left, right) => left.time - right.time);
};

const acquireFromTranscriptEndpoint = async (page: string, watchUrl: URL) => {
  const configStart = page.indexOf("ytcfg.set({");
  const configJson = configStart < 0 ? null : extractJsonObject(page.slice(configStart + "ytcfg.set(".length), "");
  const paramsMatch = page.match(/"getTranscriptEndpoint":\{"params":("(?:\\.|[^"\\])*")/);
  if (!configJson || !paramsMatch?.[1]) {
    if (process.env.VIDMARK_TRANSCRIPT_DEBUG === "1") console.error("Vidmark transcript endpoint bootstrap was missing.");
    return null;
  }
  let config: YoutubeBootstrap;
  let params: string;
  try {
    config = JSON.parse(configJson) as YoutubeBootstrap;
    params = JSON.parse(paramsMatch[1]) as string;
  } catch (error) {
    if (process.env.VIDMARK_TRANSCRIPT_DEBUG === "1") console.error("Vidmark transcript endpoint bootstrap could not be parsed.", error);
    return null;
  }
  if (!config.INNERTUBE_API_KEY || !config.INNERTUBE_CONTEXT) {
    if (process.env.VIDMARK_TRANSCRIPT_DEBUG === "1") console.error("Vidmark transcript endpoint context was missing.", Object.keys(config));
    return null;
  }
  const client = config.INNERTUBE_CONTEXT.client;
  const existingClient = client && typeof client === "object" && !Array.isArray(client) ? client as Record<string, unknown> : {};
  const visitorData = config.VISITOR_DATA ?? (typeof existingClient.visitorData === "string" ? existingClient.visitorData : undefined);
  const endpoint = new URL("https://www.youtube.com/youtubei/v1/get_transcript");
  endpoint.searchParams.set("key", config.INNERTUBE_API_KEY);
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.8",
    "Content-Type": "application/json",
    "Origin": "https://www.youtube.com",
    "Referer": watchUrl.toString(),
    "User-Agent": youtubeUserAgent,
    "X-Goog-AuthUser": "0",
    "X-Youtube-Bootstrap-Logged-In": "false",
  };
  if (config.INNERTUBE_CONTEXT_CLIENT_NAME != null) headers["X-Youtube-Client-Name"] = String(config.INNERTUBE_CONTEXT_CLIENT_NAME);
  if (config.INNERTUBE_CONTEXT_CLIENT_VERSION) headers["X-Youtube-Client-Version"] = config.INNERTUBE_CONTEXT_CLIENT_VERSION;
  if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;
  if (config.PAGE_CL != null) headers["X-Youtube-Page-CL"] = String(config.PAGE_CL);
  if (config.PAGE_BUILD_LABEL) headers["X-Youtube-Page-Label"] = config.PAGE_BUILD_LABEL;
  for (const parameterValue of [...new Set([params, decodeURIComponent(params)])]) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ context: { ...config.INNERTUBE_CONTEXT, client: { ...existingClient, originalUrl: watchUrl.toString() } }, params: parameterValue }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      if (process.env.VIDMARK_TRANSCRIPT_DEBUG === "1") console.error("Vidmark transcript endpoint failed.", response.status, await response.text());
      continue;
    }
    const payload = await response.json();
    const cues = parseTranscriptEndpoint(payload);
    if (cues.length) return cues;
    if (process.env.VIDMARK_TRANSCRIPT_DEBUG === "1") console.error("Vidmark transcript endpoint returned no recognized cues.", JSON.stringify(payload).slice(0, 1000));
  }
  return null;
};

export const acquireYouTubeTranscript = async (videoUrlOrId: string, preferredLanguage = "en") => {
  const videoId = youtubeVideoId(videoUrlOrId);
  const watchUrl = new URL("https://www.youtube.com/watch");
  watchUrl.searchParams.set("v", videoId);
  watchUrl.searchParams.set("hl", preferredLanguage || "en");
  const page = await fetchText(watchUrl, "YouTube video page");
  const android = await acquireFromAndroidPlayer(page, videoId, preferredLanguage);
  if (android) return {
    videoId,
    language: android.track.languageCode ?? preferredLanguage,
    trackName: trackName(android.track),
    automaticallyGenerated: android.track.kind === "asr",
    sourceUrl: watchUrl.toString(),
    acquiredAt: new Date().toISOString(),
    cues: android.cues,
  };
  const endpointCues = await acquireFromTranscriptEndpoint(page, watchUrl);
  if (endpointCues?.length) return {
    videoId,
    language: preferredLanguage || "en",
    trackName: "YouTube transcript panel",
    automaticallyGenerated: false,
    sourceUrl: watchUrl.toString(),
    acquiredAt: new Date().toISOString(),
    cues: endpointCues,
  };
  const tracksJson = extractJsonArray(page, '"captionTracks":');
  if (!tracksJson) throw new Error("YouTube did not expose a public caption track for this video. Import a timestamped transcript manually or use a source you are authorized to access.");
  let tracks: CaptionTrack[];
  try { tracks = JSON.parse(tracksJson) as CaptionTrack[]; }
  catch { throw new Error("YouTube returned caption metadata in an unsupported format."); }
  const track = chooseTrack(tracks.filter((candidate) => candidate.baseUrl), preferredLanguage);
  if (!track?.baseUrl) throw new Error("YouTube did not expose a usable public caption track for this video.");

  const cues = await downloadCaptionTrack(track);
  if (!cues.length) throw new Error("The selected YouTube caption track contained no usable timestamped cues.");
  return {
    videoId,
    language: track.languageCode ?? preferredLanguage,
    trackName: trackName(track),
    automaticallyGenerated: track.kind === "asr",
    sourceUrl: watchUrl.toString(),
    acquiredAt: new Date().toISOString(),
    cues,
  };
};
