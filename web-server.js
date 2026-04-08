#!/usr/bin/env node
/**
 * Simple HTTP server for serving the Zoom Meeting SDK web demo.
 *
 * Usage:
 *   node web-server.js [port]
 *
 * Default port: 8080
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || 8080;

// ─── Database (shared with main process) ─────────────────────
// Since web-server runs in main process, we can access db directly
let db = null;
let initSqlJs = null;

async function initDatabase() {
  if (db) return db;

  console.log('[DB] Initializing sql.js...');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  console.log('[DB] sql.js loaded');

  const DB_PATH = path.join(__dirname, 'captions.db');

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    console.log('[DB] Loaded existing database from', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('[DB] Created new database at', DB_PATH);
  }

  // Create tables
  console.log('[DB] Creating tables...');
  try {
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
    console.log('[DB] Tables created successfully');
  } catch (e) {
    console.error('[DB] Error creating tables:', e);
  }

  saveDatabase();
  console.log('[DB] Database initialized');
  return db;
}

function saveDatabase() {
  if (!db) return;
  const DB_PATH = path.join(__dirname, 'captions.db');
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript',
};

// ─── API Endpoints ─────────────────────────────────────────────
async function handleAPI(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    // Initialize DB on first API call
    await initDatabase();

    // POST /api/db/meeting - Create meeting
    if (pathname === '/api/db/meeting' && req.method === 'POST') {
      console.log('[API] POST /api/db/meeting - Headers:', req.headers);
      const body = await parseJSON(req);
      console.log('[API] Creating meeting with body:', body);

      try {
        db.run(
          'INSERT INTO meetings (meeting_number, topic, host_name) VALUES (?, ?, ?)',
          [String(body.meetingNumber), body.topic || `Meeting ${body.meetingNumber}`, body.hostName || '']
        );
        const result = db.exec('SELECT last_insert_rowid() as id');
        const meetingId = result[0].values[0][0];
        saveDatabase();
        res.writeHead(201);
        res.end(JSON.stringify({ meetingId }));
        console.log('[API] Meeting created, ID:', meetingId);
      } catch (dbErr) {
        console.error('[DB Error]', dbErr);
        throw dbErr;
      }
      return;
    }

    // POST /api/db/caption - Insert caption
    if (pathname === '/api/db/caption' && req.method === 'POST') {
      const body = await parseJSON(req);
      db.run(
        'INSERT INTO captions (meeting_id, speaker, text, caption_type) VALUES (?, ?, ?, ?)',
        [body.meetingId, body.speaker || '', body.text, body.captionType || 'transcription']
      );
      saveDatabase();
      res.writeHead(201);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // POST /api/db/participant - Insert participant
    if (pathname === '/api/db/participant' && req.method === 'POST') {
      const body = await parseJSON(req);
      db.run(
        'INSERT INTO participants (meeting_id, user_id, user_name, is_host) VALUES (?, ?, ?, ?)',
        [body.meetingId, body.userId || '', body.userName || '', body.isHost ? 1 : 0]
      );
      saveDatabase();
      res.writeHead(201);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // PATCH /api/db/meeting/:id/end - End meeting
    if (pathname.match(/^\/api\/db\/meeting\/\d+\/end$/) && req.method === 'PATCH') {
      const match = pathname.match(/\/api\/db\/meeting\/(\d+)\/end/);
      const meetingId = match[1];
      db.run(
        "UPDATE meetings SET ended_at = datetime('now', 'localtime') WHERE id = ?",
        [meetingId]
      );
      saveDatabase();
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // GET /api/db/captions?meetingId=N - Get captions for meeting
    if (pathname === '/api/db/captions' && req.method === 'GET') {
      const meetingId = url.searchParams.get('meetingId');
      const result = db.exec(
        'SELECT * FROM captions WHERE meeting_id = ? ORDER BY received_at ASC',
        [meetingId]
      );
      res.writeHead(200);
      res.end(JSON.stringify(toObjects(result)));
      return;
    }

    // GET /api/db/meetings - Get all meetings
    if (pathname === '/api/db/meetings' && req.method === 'GET') {
      const result = db.exec('SELECT * FROM meetings ORDER BY started_at DESC');
      res.writeHead(200);
      res.end(JSON.stringify(toObjects(result)));
      return;
    }

    // GET /api/db/participants?meetingId=N - Get participants for meeting
    if (pathname === '/api/db/participants' && req.method === 'GET') {
      const meetingId = url.searchParams.get('meetingId');
      const result = db.exec(
        'SELECT * FROM participants WHERE meeting_id = ? ORDER BY joined_at ASC',
        [meetingId]
      );
      res.writeHead(200);
      res.end(JSON.stringify(toObjects(result)));
      return;
    }

    // GET /api/db/export?meetingId=N - Export meeting data as JSON
    if (pathname === '/api/db/export' && req.method === 'GET') {
      const meetingId = url.searchParams.get('meetingId');
      const meetingResult = db.exec('SELECT * FROM meetings WHERE id = ?', [meetingId]);
      const captionsResult = db.exec('SELECT * FROM captions WHERE meeting_id = ? ORDER BY received_at ASC', [meetingId]);
      const participantsResult = db.exec('SELECT * FROM participants WHERE meeting_id = ? ORDER BY joined_at ASC', [meetingId]);

      const exportData = {
        meeting: toObjects(meetingResult)[0] || null,
        captions: toObjects(captionsResult),
        participants: toObjects(participantsResult),
      };

      res.writeHead(200);
      res.end(JSON.stringify(exportData, null, 2));
      return;
    }

    // GET /api/db/stats - Get database stats
    if (pathname === '/api/db/stats' && req.method === 'GET') {
      const result = db.exec('SELECT COUNT(*) as count FROM captions');
      const count = result.length > 0 ? result[0].values[0][0] : 0;
      res.writeHead(200);
      res.end(JSON.stringify({ captionCount: count }));
      return;
    }

    // DELETE /api/db/clear - Clear all data
    if (pathname === '/api/db/clear' && req.method === 'DELETE') {
      db.run('DELETE FROM captions');
      db.run('DELETE FROM meetings');
      db.run('DELETE FROM participants');
      saveDatabase();
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 404 for unknown API routes
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'API endpoint not found' }));
  } catch (err) {
    console.error('[API Error]', err);
    res.writeHead(500);
    const errorMsg = err?.message || String(err);
    res.end(JSON.stringify({ error: errorMsg }));
  }
}

function parseJSON(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let chunkCount = 0;

    req.on('data', chunk => {
      chunkCount++;
      console.log(`[parseJSON] Received chunk #${chunkCount}:`, {
        type: typeof chunk,
        isBuffer: Buffer.isBuffer(chunk),
        length: chunk?.length,
        preview: String(chunk).substring(0, 100)
      });
      // Handle both string and Buffer chunks
      body += chunk instanceof Buffer ? chunk.toString() : String(chunk);
    });

    req.on('end', () => {
      console.log(`[parseJSON] Total chunks: ${chunkCount}, Body length: ${body.length}`);
      console.log(`[parseJSON] Body preview:`, body.substring(0, 200));

      // If body is empty, return empty object
      if (!body || body.trim() === '') {
        console.log('[parseJSON] Empty body, returning {}');
        resolve({});
        return;
      }

      try {
        const parsed = JSON.parse(body);
        console.log('[parseJSON] Parsed successfully:', parsed);
        resolve(parsed);
      } catch (e) {
        console.error('[parseJSON] Parse error:', e.message);
        console.error('[parseJSON] Body that failed:', body);
        reject(e);
      }
    });
  });
}

function toObjects(result) {
  if (!result || !result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
}

const server = http.createServer(async (req, res) => {
  // API routes
  if (req.url.startsWith('/api/')) {
    await handleAPI(req, res);
    return;
  }

  let filePath = '.' + (req.url === '/' ? '/web-demo.html' : req.url);

  // Security: prevent directory traversal
  filePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  // Enable CORS for all requests
  const headers = {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Handle WASM files with proper headers
  if (ext === '.wasm') {
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 - File not found: ' + req.url);
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 - Server error: ' + err.message);
      }
      return;
    }

    res.writeHead(200, headers);
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║   Zoom Meeting SDK Web Demo Server                        ║
╠═══════════════════════════════════════════════════════════╣
║   Open your browser:                                       ║
║   http://localhost:${PORT}                                ║
║                                                           ║
║   Press Ctrl+C to stop the server                         ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
