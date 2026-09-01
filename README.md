# Vidmark

Vidmark is a local-first YouTube study library packaged as a native macOS app. The Swift shell opens a local Bun/Vinext workspace in its own `WKWebView`; notes, course prompts, transcripts, practice progress, and exam attempts stay on the Mac.

## Run and package

The project uses the bundled Bun runtime for production packaging and `pnpm` for dependency scripts.

```bash
pnpm install
pnpm run dev
pnpm run package:mac
open build/Vidmark.app
```

The packaged app starts its own servers when it opens:

- app: `http://127.0.0.1:3010`
- local transcription: `http://127.0.0.1:31415`
- MCP: `http://127.0.0.1:31417/mcp`
- model provider: `http://127.0.0.1:31418`
- note storage: `http://127.0.0.1:31419`

## Course origin prompts

Every imported YouTube course requires an origin prompt and prompt credit. The prompt is stored with that course and is available to agents through MCP so research, chapters, study material, and question generation can follow course-specific instructions. The bundled CCA-F prompt is credited to Drake Fish.

Vidmark always restores two bundled freeCodeCamp courses when the library opens:

- Claude Certified Architect — Foundations, with its complete study guide and 100-question bank
- Learn Kubernetes in 6 Hours – Full Course with Real-World Project, with a coordinated build prompt that requires separate transcript, documentation-research, lab, study-guide, assessment, visual-reference, and independent-QA subagents

## Local MCP server

With Vidmark open, connect an MCP client to the Streamable HTTP endpoint:

```json
{
  "mcpServers": {
    "vidmark": {
      "url": "http://127.0.0.1:31417/mcp"
    }
  }
}
```

Available tools:

- `list_courses` and `get_course`
- `upsert_course`
- `save_course_build`
- `get_transcript` and `replace_transcript`
- `list_notes`

The MCP prompt `build_vidmark_course` returns the selected course's credited origin prompt wrapped in an agent-ready build instruction.

Course build state is stored at `~/Library/Application Support/Vidmark/mcp-state.json`. The server binds only to `127.0.0.1` and rejects non-local Host headers.

## Voice notes

Voice notes are recorded as WAV audio and transcribed by the on-device Whisper worker. Saving writes the transcript and metadata to `~/Library/Application Support/Vidmark/notes/notes.json` and the recording to `~/Library/Application Support/Vidmark/notes/audio/<note-id>.wav`. The aggregate notes view and each chapter's Notes panel include a sortable recording playlist with play/pause, scrubbing, elapsed time, and an expandable transcript. Existing IndexedDB notes migrate into the disk store the next time notes load; browser storage remains a fallback if the local service is unavailable.
