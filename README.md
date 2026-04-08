# Zoom CC Caption Capture

Electron app that joins a Zoom meeting via the Meeting SDK, captures live transcription / closed-caption text in real-time, and saves merged captions to a local SQLite database.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Electron Main Process (main.js)                     │
│  ├─ HTTP server :9999 → serves index.html + SDK      │
│  ├─ SQLite (sql.js / WASM) → captions.db             │
│  ├─ JWT generation (keeps SDK Secret server-side)     │
│  └─ IPC handlers: insert/query captions, meetings,    │
│                    participants                        │
├──────────────────────────────────────────────────────┤
│  Renderer Process (renderer.js + index.html)          │
│  ├─ Zoom Meeting SDK (Client View, loaded via script) │
│  ├─ onReceiveTranscriptionMsg → capture captions      │
│  ├─ Dedup + merge buffer (same speaker fragments)     │
│  └─ UI: live captions, participants, controls         │
└──────────────────────────────────────────────────────┘
```

### Key Files

| File | Role |
|---|---|
| `main.js` | Electron main process: HTTP server, SQLite, JWT, IPC |
| `renderer.js` | Zoom SDK init/join, caption capture, buffering, UI |
| `index.html` | UI layout + Zoom SDK script tags |
| `jwt.js` | Standalone CLI JWT generator (for quick testing) |
| `.env` | SDK credentials and meeting defaults (gitignored) |
| `captions.db` | SQLite database (auto-created at runtime) |

### Database Schema

```
meetings      → id, meeting_number, topic, host_name, started_at, ended_at
captions      → id, meeting_id (FK), speaker, text, caption_type, received_at
participants  → id, meeting_id (FK), user_id, user_name, is_host, joined_at
```

## Prerequisites

- **Node.js** >= 18
- **Zoom account** with a [Meeting SDK app](https://marketplace.zoom.us/) (Server-to-Server OAuth or legacy JWT)
- A **Zoom meeting** to join (hosted by the same account for dev testing)
- Host must **enable CC or AI Companion / Live Transcript** in the meeting for captions to appear

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url>
cd zoom-meeting-sdk-demo
npm install

# 2. Configure credentials
cp .env.example .env
# Edit .env with your SDK Key, Secret, and a test meeting number

# 3. Run
npm start
```

The app opens an Electron window. If `.env` is configured, the form is pre-filled — just click **Join Meeting**.

### Manual JWT (optional)

```bash
node jwt.js <sdkKey> <sdkSecret> <meetingNumber> [role]
# role: 0 = participant (default), 1 = host
```

The app generates JWTs automatically via IPC, so this CLI is only needed for debugging.

## How Caption Capture Works

1. App joins the meeting as a participant (bot name: "CC Caption Bot")
2. Registers `onReceiveTranscriptionMsg` listener on the Zoom SDK
3. On each caption event:
   - **Dedup**: same `msgId:text` pair is only processed once (SDK fires each event twice)
   - **Buffer**: captions from the same speaker are buffered for up to 3 seconds
   - **Merge**: if the new text is a progressive refinement of the buffered text (overlapping words), it replaces the buffer; otherwise the previous buffer is flushed as one DB record and a new buffer starts
   - **Flush triggers**: speaker change, 3s silence, `done=true`, or meeting end
4. UI shows each caption in real-time; DB stores the merged, deduplicated result

## Tech Stack

| Component | Choice | Why |
|---|---|---|
| Runtime | Electron 33 | Zoom Meeting SDK Client View requires a browser env |
| Zoom SDK | @zoom/meetingsdk 5.x (Client View) | Captures in-meeting CC/transcription |
| Database | sql.js (SQLite via WASM) | Zero native rebuild, single-file DB |
| Auth | HMAC-SHA256 JWT (inline) | No external JWT library needed |
| HTTP | Node.js `http` module | Serves SDK assets from node_modules locally |

## Links

- [Zoom Meeting SDK Docs](https://developers.zoom.us/docs/meeting-sdk/)
- [Meeting SDK Reference (Client View)](https://developers.zoom.us/docs/meeting-sdk/client-view/reference/)
- [Create a Meeting SDK App](https://developers.zoom.us/docs/meeting-sdk/create-an-app/)
- [Meeting SDK Auth (JWT)](https://developers.zoom.us/docs/meeting-sdk/auth/)
- [Caption / Live Transcription Events](https://developers.zoom.us/docs/meeting-sdk/client-view/reference/caption-control/)
- [sql.js — SQLite compiled to WASM](https://sql.js.org/)
- [Electron Docs](https://www.electronjs.org/docs/)

## Development Notes

- `webSecurity: false` is set in Electron to allow the Zoom SDK to load its WASM and media modules from the local HTTP server
- The Zoom Meeting container (`#zoom-meeting-container`) is hidden (1px, opacity 0) — the SDK runs headlessly in the background while captions are captured from events
- The SDK script tags in `index.html` load vendor libs (React, Redux, Lodash) and `zoom-meeting-5.x.x.min.js` from `node_modules/@zoom/meetingsdk/dist/`
- `captions.db` is persisted to disk on every write (via `db.export()`) — safe for small-scale use, may need optimization for high-volume scenarios
- DevTools opens automatically; check the **Console** tab for `[Caption]` and `[DB Flush]` logs
