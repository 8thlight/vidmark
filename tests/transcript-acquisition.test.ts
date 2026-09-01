import { describe, expect, test } from "bun:test";
import { parseJson3Transcript, youtubeVideoId } from "../scripts/transcript-acquisition";

describe("course transcript acquisition", () => {
  test("extracts a YouTube video ID only from supported sources", () => {
    expect(youtubeVideoId("_4uQI4ihGVU")).toBe("_4uQI4ihGVU");
    expect(youtubeVideoId("https://www.youtube.com/watch?v=_4uQI4ihGVU")).toBe("_4uQI4ihGVU");
    expect(youtubeVideoId("https://youtu.be/_4uQI4ihGVU?t=12")).toBe("_4uQI4ihGVU");
    expect(() => youtubeVideoId("https://example.com/watch?v=_4uQI4ihGVU")).toThrow("YouTube");
  });

  test("converts YouTube json3 events into timestamped cues", () => {
    expect(parseJson3Transcript({ events: [
      { tStartMs: 1250, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
      { tStartMs: 3200, segs: [{ utf8: "Next\nconcept" }] },
      { tStartMs: 5000, segs: [] },
    ] })).toEqual([
      { time: 1.25, text: "Hello world" },
      { time: 3.2, text: "Next concept" },
    ]);
  });
});
