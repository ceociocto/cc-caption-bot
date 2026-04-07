/**
 * main.js - Electron main process
 *
 * Responsibilities:
 * 1. Local HTTP server for serving frontend files
 * 2. SQLite database (meetings, captions, participants tables)
 * 3. JWT token generation for Zoom Meeting SDK auth
 * 4. IPC handlers for renderer-to-main communication
 */

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────
const HTTP_PORT = 9999;
const DB_PATH = path.join(__dirname, 'captions.db');
const ENV_PATH = path.join(__dirname, '.env');

let db = null;
let mainWindow = null;

// ─── .env Loader ─────────────────────────────────────────
function loadEnv() {
  const env = {
    ZOOM_SDK_KEY: '',
    ZOOM_SDK_SECRET: '',
    ZOOM_MEETING_NUMBER: '',
    ZOOM_MEETING_PASSWORD: '',
    ZOOM_BOT_NAME: 'CC Caption Bot',
  };

  try {
    const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key in env) env[key] = val;
    }
  } catch (e) {
    console.log('[ENV] No .env file found, using defaults');
  }

  return env;
}

const envConfig = loadEnv();

// ─── SQLite Database (sql.js - pure WASM, no native rebuild) ──
async function initDB() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS meetings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_number TEXT NOT NULL,
      topic         TEXT,
      host_name     TEXT,
      started_at    TEXT DEFAULT (datetime('now', 'localtime')),
      ended_at      TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS captions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id  INTEGER NOT NULL,
      speaker     TEXT,
      text        TEXT NOT NULL,
      caption_type TEXT DEFAULT 'cc',
      received_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS participants (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id  INTEGER NOT NULL,
      user_id     TEXT,
      user_name   TEXT,
      is_host     INTEGER DEFAULT 0,
      joined_at   TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id)
    )
  `);

  saveDB();
  console.log(`[DB] SQLite initialized at ${DB_PATH}`);
}

// Persist DB to disk
function saveDB() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// ─── JWT Generation ──────────────────────────────────────
function generateJWT(sdkKey, sdkSecret, meetingNumber, role = 0) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 48 * 3600; // 48 hours max

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sdkKey,
    mn: String(meetingNumber),
    role,
    iat,
    exp,
    tokenExp: exp,
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

  const signature = crypto
    .createHmac('sha256', sdkSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

// ─── HTTP Static Server ──────────────────────────────────
function startHTTPServer() {
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
  };

  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];

    // Serve .env config as a JS global variable
    if (urlPath === '/env-config.js') {
      const config = {
        sdkKey: envConfig.ZOOM_SDK_KEY,
        sdkSecret: envConfig.ZOOM_SDK_SECRET,
        meetingNumber: envConfig.ZOOM_MEETING_NUMBER,
        meetingPassword: envConfig.ZOOM_MEETING_PASSWORD,
        userName: envConfig.ZOOM_BOT_NAME,
      };
      const js = `window.__ENV_CONFIG__ = ${JSON.stringify(config)};`;
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(js);
      return;
    }

    // Serve Zoom SDK assets from node_modules
    if (urlPath.startsWith('/zoom-sdk/')) {
      const sdkBase = path.join(__dirname, 'node_modules', '@zoom', 'meetingsdk', 'dist');
      const relPath = urlPath.replace('/zoom-sdk/', '');
      const sdkFile = path.join(sdkBase, relPath);
      const ext = path.extname(sdkFile);
      try {
        const content = fs.readFileSync(sdkFile);
        res.writeHead(200, {
          'Content-Type': mimeTypes[ext] || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(content);
        return;
      } catch (e) {
        res.writeHead(404);
        res.end('SDK file not found: ' + relPath);
        return;
      }
    }

    const filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
    const ext = path.extname(filePath);

    try {
      const content = fs.readFileSync(filePath);

      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(content);
    } catch (e) {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  return new Promise((resolve) => {
    server.listen(HTTP_PORT, () => {
      console.log(`[HTTP] Serving on http://localhost:${HTTP_PORT}`);
      resolve();
    });
  });
}

// ─── Electron Window ─────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'Zoom CC Caption Capture Demo',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false, // Needed for Zoom SDK CDN + WASM loading
    },
  });

  mainWindow.loadURL(`http://localhost:${HTTP_PORT}`);

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.openDevTools();
  });

  // Application menu with DevTools toggle
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I' },
        { role: 'reload' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
      ],
    },
  ]));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── IPC Handlers ────────────────────────────────────────

// Generate JWT token (keeps SDK secret in main process)
ipcMain.handle('generate-jwt', (_, { sdkKey, sdkSecret, meetingNumber, role }) => {
  try {
    const token = generateJWT(sdkKey, sdkSecret, meetingNumber, role);
    return { success: true, token };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Insert meeting record
ipcMain.handle('db-insert-meeting', (_, { meetingNumber, topic, hostName }) => {
  db.run(
    'INSERT INTO meetings (meeting_number, topic, host_name) VALUES (?, ?, ?)',
    [meetingNumber, topic || null, hostName || null]
  );
  const result = db.exec('SELECT last_insert_rowid() as id');
  const id = result[0].values[0][0];
  saveDB();
  console.log(`[DB] Meeting #${id} created: ${meetingNumber}`);
  return id;
});

// Insert caption record
ipcMain.handle('db-insert-caption', (_, { meetingId, speaker, text, captionType }) => {
  db.run(
    'INSERT INTO captions (meeting_id, speaker, text, caption_type) VALUES (?, ?, ?, ?)',
    [meetingId, speaker || '', text, captionType || 'cc']
  );
  saveDB();
  const result = db.exec('SELECT last_insert_rowid() as id');
  return result[0].values[0][0];
});

// Insert participant record
ipcMain.handle('db-insert-participant', (_, { meetingId, userId, userName, isHost }) => {
  db.run(
    'INSERT INTO participants (meeting_id, user_id, user_name, is_host) VALUES (?, ?, ?, ?)',
    [meetingId, userId || '', userName || '', isHost ? 1 : 0]
  );
  saveDB();
});

// Update meeting end time
ipcMain.handle('db-end-meeting', (_, { meetingId }) => {
  db.run(
    "UPDATE meetings SET ended_at = datetime('now', 'localtime') WHERE id = ?",
    [meetingId]
  );
  saveDB();
});

// Query captions for a meeting
ipcMain.handle('db-get-captions', (_, { meetingId }) => {
  const result = db.exec(
    'SELECT * FROM captions WHERE meeting_id = ? ORDER BY received_at ASC',
    [meetingId]
  );
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
});

// Query all meetings
ipcMain.handle('db-get-meetings', () => {
  const result = db.exec('SELECT * FROM meetings ORDER BY started_at DESC');
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
});

// Query participants for a meeting
ipcMain.handle('db-get-participants', (_, { meetingId }) => {
  const result = db.exec(
    'SELECT * FROM participants WHERE meeting_id = ? ORDER BY joined_at ASC',
    [meetingId]
  );
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
});

// Export captions as JSON
ipcMain.handle('db-export-captions-json', (_, { meetingId }) => {
  const meetingResult = db.exec('SELECT * FROM meetings WHERE id = ?', [meetingId]);
  const captionsResult = db.exec('SELECT * FROM captions WHERE meeting_id = ? ORDER BY received_at ASC', [meetingId]);
  const participantsResult = db.exec('SELECT * FROM participants WHERE meeting_id = ? ORDER BY joined_at ASC', [meetingId]);

  const toObjects = (result) => {
    if (!result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      cols.forEach((c, i) => obj[c] = row[i]);
      return obj;
    });
  };

  return JSON.stringify({
    meeting: toObjects(meetingResult)[0] || null,
    captions: toObjects(captionsResult),
    participants: toObjects(participantsResult),
  }, null, 2);
});

// ─── App Lifecycle ───────────────────────────────────────
app.on('ready', async () => {
  await initDB();
  await startHTTPServer();
  console.log('[ENV] Config loaded:', JSON.stringify(envConfig, null, 2));
  createWindow();
});

app.on('window-all-closed', () => {
  if (db) {
    saveDB();
    db.close();
    console.log('[DB] Connection closed');
  }
  app.quit();
});

app.on('before-quit', () => {
  if (db) {
    saveDB();
    db.close();
  }
});
