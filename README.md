# Zoom Meeting SDK Web Demo

A standalone web page that demonstrates joining a Zoom meeting and capturing real-time closed captions, saving them to a local SQLite database.

## Two Ways to Run

| Method | Description | Command |
|--------|-------------|---------|
| **Web Demo** | Pure browser-based, runs via local HTTP server | `npm run web` |
| **Electron App** | Desktop app with integrated SQLite database | `npm start` |

---

## Web Demo Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the web server (default port 8080)
npm run web

# Or specify a custom port
node web-server.js 9000
```

Then open your browser to `http://localhost:8080`

---

## How the Web Demo Loads the Meeting SDK

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser                                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  web-demo.html                                          │   │
│  │  ├─ Loads Zoom SDK from local web-server.js            │   │
│  │  ├─ Generates JWT client-side (CryptoJS)               │   │
│  │  ├─ Joins meeting via Zoom Meeting SDK                 │   │
│  │  └─ Sends captions to backend API                      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              ↓ HTTP API                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  web-server.js (Node.js)                                │   │
│  │  ├─ Serves static files (web-demo.html, SDK assets)    │   │
│  │  ├─ REST API: /api/db/* for database operations        │   │
│  │  └─ SQLite (sql.js WASM) → captions.db                │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### SDK Loading Details

The Zoom Meeting SDK is loaded from **local** `node_modules` instead of CDN:

**Why local?**
- Faster loading (no network dependency)
- Works offline after first `npm install`
- Version control (use specific SDK version)
- Avoids CDN CORS issues

**How it works:**

1. **`web-server.js`** serves static files from the project directory
2. **`web-demo.html`** loads the SDK from local paths:
   ```html
   <script src="/node_modules/@zoom/meetingsdk/dist/lib/vendor/react.min.js"></script>
   <script src="/node_modules/@zoom/meetingsdk/dist/lib/vendor/react-dom.min.js"></script>
   <script src="/node_modules/@zoom/meetingsdk/dist/zoom-meeting-6.0.0.min.js"></script>
   ```

3. **SDK Configuration** uses local WASM path:
   ```javascript
   ZoomMtg.setZoomJSLib('/node_modules/@zoom/meetingsdk/dist/lib', '/av');
   ```

### Required Dependencies

```json
{
  "@zoom/meetingsdk": "^6.0.0",
  "sql.js": "^1.11.0",
  "crypto-js": "^4.2.0"
}
```

Install with:
```bash
npm install @zoom/meetingsdk sql.js crypto-js
```

---

## Features

| Feature | Web Demo | Electron App |
|---------|----------|--------------|
| Join Zoom Meeting | ✅ | ✅ |
| Real-time Caption Capture | ✅ | ✅ |
| Local SQLite Database | ✅ (via API) | ✅ (embedded) |
| Export to JSON | ✅ | ✅ |
| Runs in Browser | ✅ | ❌ (Electron) |
| Desktop Window | ❌ | ✅ |

---

## Pre-filled Credentials

The demo comes with placeholder credentials. Fill in your own:
- SDK Key: `YOUR_SDK_KEY` (from Zoom Marketplace)
- SDK Secret: `YOUR_SDK_SECRET` (from Zoom Marketplace)
- Meeting Number: `YOUR_MEETING_NUMBER`
- Meeting Password: `YOUR_MEETING_PASSWORD` (optional)
- Bot Name: `Meeting Effectiveness Analyzer`

Get your SDK credentials from: https://marketplace.zoom.us/

---

## How It Works

### 1. JWT Generation (Client-side)
Uses **CryptoJS** to generate Zoom Meeting SDK JWT tokens in the browser:
```javascript
const signature = CryptoJS.HmacSHA256(
  encodedHeader + '.' + encodedPayload,
  sdkSecret
).toString(CryptoJS.enc.Base64url);
```

### 2. Zoom SDK Initialization
```javascript
ZoomMtg.setZoomJSLib('/node_modules/@zoom/meetingsdk/dist/lib', '/av');
ZoomMtg.preLoadWasm();
ZoomMtg.prepareWebSDK();
ZoomMtg.init({ ... });
ZoomMtg.join({ signature, meetingNumber, ... });
```

### 3. Caption Capture
Listens to SDK events:
```javascript
ZoomMtg.inMeetingServiceListener('onReceiveTranscriptionMsg', (data) => {
  const caption = parseCaptionData(data);
  saveCaptionToDatabase(caption);
});
```

### 4. Database Storage
Captions are saved via REST API:
```javascript
POST /api/db/caption
{ meetingId, speaker, text, captionType }
```

Server uses **sql.js** (WASM) to store data in `captions.db`:
```javascript
db.run('INSERT INTO captions (...) VALUES (?, ?, ?, ?)', [...]);
```

---

## Database Schema

```sql
CREATE TABLE meetings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_number TEXT NOT NULL,
  topic         TEXT,
  host_name     TEXT,
  started_at    TEXT DEFAULT (datetime('now', 'localtime')),
  ended_at      TEXT
);

CREATE TABLE captions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id  INTEGER NOT NULL,
  speaker     TEXT,
  text        TEXT NOT NULL,
  caption_type TEXT DEFAULT 'cc',
  received_at TEXT DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);

CREATE TABLE participants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id  INTEGER NOT NULL,
  user_id     TEXT,
  user_name   TEXT,
  is_host     INTEGER DEFAULT 0,
  joined_at   TEXT DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/db/meeting` | POST | Create meeting record |
| `/api/db/caption` | POST | Insert caption |
| `/api/db/participant` | POST | Insert participant |
| `/api/db/meeting/:id/end` | PATCH | End meeting |
| `/api/db/captions?meetingId=N` | GET | Get captions for meeting |
| `/api/db/meetings` | GET | Get all meetings |
| `/api/db/participants?meetingId=N` | GET | Get participants |
| `/api/db/stats` | GET | Get database stats |
| `/api/db/clear` | DELETE | Clear all data |

---

## Important Notes

1. **Meeting Host**: The meeting host must enable **Closed Captions** or **AI Companion / Live Transcript** for captions to appear
2. **Same Account**: For development, join meetings hosted by the same account as the SDK app
3. **SDK Version**: This demo uses Zoom Meeting SDK v6.0.0
4. **Database**: `captions.db` is created in the project directory

---

## Troubleshooting

### Captions not appearing?
- Ensure the host has enabled CC or Live Transcription in the meeting
- Check the on-page console for event logs
- Verify SDK credentials are correct

### SDK not loading?
- Ensure `@zoom/meetingsdk` is installed (`npm install`)
- Check browser console for 404 errors on SDK files
- Verify `web-server.js` is running

### API errors?
- Check `web-server.js` console for errors
- Verify `sql.js` is installed
- Ensure `captions.db` is writable

### JWT errors?
- Verify SDK Key and Secret are correct
- Check that the meeting number is valid
- Ensure the meeting is currently active

---

## Tech Stack

| Component | Choice |
|-----------|--------|
| Zoom SDK | @zoom/meetingsdk v6.0.0 (local) |
| JWT | CryptoJS for HMAC-SHA256 |
| Database | sql.js (SQLite via WASM) |
| Server | Node.js http module |
| Storage | File-based (`captions.db`) |

---

## Links

- [Zoom Meeting SDK Docs](https://developers.zoom.us/docs/meeting-sdk/)
- [Meeting SDK Web Guide](https://developers.zoom.us/docs/meeting-sdk/web/get-started/)
- [Create a Meeting SDK App](https://developers.zoom.us/docs/meeting-sdk/create-an-app/)
- [sql.js Documentation](https://sql.js.org/)
