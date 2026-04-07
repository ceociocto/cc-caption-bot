/**
 * renderer.js - Zoom Meeting SDK integration & CC caption capture
 *
 * Flow:
 * 1. Init Zoom SDK → 2. Generate JWT (via IPC to main) → 3. Join meeting
 * 4. Request CC captions → 5. Capture captions → 6. Write to SQLite (via IPC)
 *
 * Prerequisites:
 * - Zoom Meeting SDK App created at https://marketplace.zoom.us/
 * - SDK Key & Secret from the app
 * - Meeting hosted by the same account (for dev testing)
 */

const { ipcRenderer } = require('electron');

// Zoom SDK global (loaded from local npm via script tags in index.html)
const ZoomMtg = window.ZoomMtg;

// ─── DOM Elements ────────────────────────────────────────
const joinForm = document.getElementById('join-form');
const joinBtn = document.getElementById('join-btn');
const exportBtn = document.getElementById('export-btn');
const statusEl = document.getElementById('status');
const captionsEl = document.getElementById('captions');
const captionCountEl = document.getElementById('caption-count');
const meetingInfoEl = document.getElementById('meeting-info');
const participantsEl = document.getElementById('participants');
const zoomContainer = document.getElementById('zoom-meeting-container');

// ─── State ───────────────────────────────────────────────
let currentMeetingId = null;
let captionCount = 0;
let isInMeeting = false;

// ─── Zoom SDK Init ───────────────────────────────────────
function initZoomSDK() {
  if (!ZoomMtg) {
    setStatus('Zoom SDK failed to load', true);
    console.error('[ZoomSDK] window.ZoomMtg is undefined. Check script loading.');
    return;
  }

  // Set asset path only — defer preLoadWasm/prepareWebSDK to join time
  // to avoid SDK injecting full-page overlay on startup
  ZoomMtg.setZoomJSLib('/zoom-sdk/lib', '/av');

  setStatus('Ready to join');
  console.log('[ZoomSDK] Configured, local: /zoom-sdk/lib');
}

// ─── Join Meeting ────────────────────────────────────────
async function joinMeeting(sdkKey, sdkSecret, meetingNumber, password, userName) {
  setStatus('Generating JWT token...');

  // Generate JWT in main process (keeps secret secure)
  const jwtResult = await ipcRenderer.invoke('generate-jwt', {
    sdkKey,
    sdkSecret,
    meetingNumber,
    role: 0, // 0 = participant, 1 = host
  });

  if (!jwtResult.success) {
    setStatus(`JWT Error: ${jwtResult.error}`, true);
    return;
  }

  // Create meeting record in SQLite
  currentMeetingId = await ipcRenderer.invoke('db-insert-meeting', {
    meetingNumber: String(meetingNumber),
    topic: `Meeting ${meetingNumber}`,
    hostName: userName,
  });

  updateMeetingInfo({ meetingNumber, userName, meetingId: currentMeetingId });
  setStatus('Initializing Zoom SDK...');

  // Prepare SDK assets just-in-time (not on page load, to avoid black overlay)
  ZoomMtg.preLoadWasm();
  ZoomMtg.prepareWebSDK();

  // Initialize Zoom Meeting SDK (per npm docs)
  ZoomMtg.init({
    leaveUrl: window.location.origin,
    patchJsMedia: true,

    success: () => {
      setStatus('Joining meeting...');
      console.log('[ZoomSDK] Init success, joining...');

      ZoomMtg.join({
        sdkKey,
        signature: jwtResult.token,
        meetingNumber: String(meetingNumber),
        passWord: password,
        userName,

        success: (res) => {
          console.log('[ZoomSDK] Join success:', res);
          isInMeeting = true;
          setStatus('In meeting - waiting for captions');
          joinBtn.disabled = true;
          joinBtn.textContent = 'In Meeting';
          exportBtn.disabled = false;

          registerMeetingListeners();
          requestCaptions();
        },

        error: (err) => {
          console.error('[ZoomSDK] Join error:', err);
          setStatus(`Join failed: ${err.errorMessage || JSON.stringify(err)}`, true);
        },
      });
    },

    error: (err) => {
      console.error('[ZoomSDK] Init error:', err);
      setStatus(`Init failed: ${err.errorMessage || JSON.stringify(err)}`, true);
    },
  });
}

// ─── Register Meeting Event Listeners ────────────────────
function registerMeetingListeners() {
  // --- CC + Live Transcription (Zoom AI) — single event for both ---
  ZoomMtg.inMeetingServiceListener('onReceiveTranscriptionMsg', onTranscriptionReceived);

  // --- Live transcription toggle ---
  ZoomMtg.inMeetingServiceListener('onLiveTranscriptionOn', onLiveTranscriptionToggle);

  // --- Participant events ---
  ZoomMtg.inMeetingServiceListener('onUserJoin', onUserJoin);
  ZoomMtg.inMeetingServiceListener('onUserLeave', onUserLeave);

  // --- Meeting status ---
  ZoomMtg.inMeetingServiceListener('onMeetingStatus', onMeetingStatus);

  // --- Active speaker ---
  ZoomMtg.inMeetingServiceListener('onActiveSpeaker', onActiveSpeaker);

  console.log('[Events] All meeting listeners registered');
}

// ─── Caption Handlers ────────────────────────────────────

function onTranscriptionReceived(data) {
  // onReceiveTranscriptionMsg fires for both CC and AI live transcription
  console.log('[Transcription] Received:', JSON.stringify(data));

  const caption = parseCaptionData(data);
  if (!caption.text) return;

  addCaptionToUI(caption);
  saveCaptionToDB(caption, caption.captionType || 'transcription');
}

function onLiveTranscriptionToggle(data) {
  console.log('[Transcription] Live transcription toggle:', JSON.stringify(data));
  setStatus(data ? 'Live transcription ON - receiving captions' : 'Live transcription OFF');
}

/**
 * Parse transcription data from Zoom SDK onReceiveTranscriptionMsg event.
 * Logs raw data on first call so we can adjust if the format differs.
 */
let _firstTranscriptionLogged = false;
function parseCaptionData(data) {
  if (!_firstTranscriptionLogged) {
    console.log('[Transcription] Raw data structure:', JSON.stringify(data));
    _firstTranscriptionLogged = true;
  }

  // data may be string (JSON) or object
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) {}
  }

  return {
    text: data.captionMsg || data.msg || data.text || data.message || data.ttstext || '',
    speaker: data.speakerName || data.speaker || data.userName || data.senderName || '',
    captionType: data.captionType || data.type || (data.isLive ? 'live-transcription' : 'cc'),
    timestamp: data.ttstime || data.timestamp || new Date().toISOString(),
  };
}

// ─── Participant Handlers ────────────────────────────────

async function onUserJoin(data) {
  console.log('[Participants] User joined:', data);
  const users = Array.isArray(data) ? data : (data.userList || [data]);

  for (const user of users) {
    const name = user.userName || user.name || 'Unknown';
    const isHost = user.isHost || user.bCoHost || false;

    addParticipantToUI(name, isHost);

    if (currentMeetingId) {
      await ipcRenderer.invoke('db-insert-participant', {
        meetingId: currentMeetingId,
        userId: user.userId || user.userGUID || '',
        userName: name,
        isHost,
      });
    }
  }
}

function onUserLeave(data) {
  console.log('[Participants] User left:', data);
}

function onMeetingStatus(data) {
  console.log('[Meeting] Status changed:', data);
  const status = data.meetingStatus;

  if (status === 'disconnect' || status === 'ended' || status === 0) {
    setStatus('Meeting ended');
    isInMeeting = false;
    joinBtn.disabled = false;
    joinBtn.textContent = 'Join Meeting';

    if (currentMeetingId) {
      ipcRenderer.invoke('db-end-meeting', { meetingId: currentMeetingId });
    }
  }
}

function onActiveSpeaker(data) {
  // Track who is currently speaking (useful for future real-time interaction)
}

// ─── Request / Start Captions ────────────────────────────

function requestCaptions() {
  try {
    if (typeof ZoomMtg.isSupportCC === 'function') {
      const supported = ZoomMtg.isSupportCC();
      console.log(`[CC] isSupportCC: ${supported}`);
    }

    if (typeof ZoomMtg.startCC === 'function') {
      ZoomMtg.startCC();
      console.log('[CC] startCC() called');
    } else {
      console.log('[CC] startCC() not available — host must enable captions manually');
    }

    // Log all available inMeetingServiceListener-capable methods for debugging
    const methods = Object.keys(ZoomMtg).filter(k => typeof ZoomMtg[k] === 'function');
    console.log('[CC] Available ZoomMtg methods:', methods.join(', '));
  } catch (e) {
    console.log('[CC] Could not auto-start CC:', e.message);
  }

  setStatus('In meeting — host must enable CC or AI transcription for captions to appear');
}

// ─── UI Updates ──────────────────────────────────────────

function addCaptionToUI({ speaker, text, timestamp }) {
  const empty = captionsEl.querySelector('.empty-state');
  if (empty) empty.remove();

  const time = new Date().toLocaleTimeString();
  const el = document.createElement('div');
  el.className = 'caption-item';
  el.innerHTML = `
    <span class="caption-time">${time}</span>
    <span class="caption-speaker">${escapeHTML(speaker || 'Speaker')}</span>
    <span class="caption-text">${escapeHTML(text)}</span>
  `;
  captionsEl.appendChild(el);
  captionsEl.scrollTop = captionsEl.scrollHeight;

  captionCount++;
  captionCountEl.textContent = `${captionCount} caption${captionCount !== 1 ? 's' : ''}`;
}

function addParticipantToUI(name, isHost) {
  const existing = participantsEl.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (existing) return;

  const el = document.createElement('div');
  el.className = 'participant-item';
  el.dataset.name = name;
  el.innerHTML = `
    <span class="participant-dot"></span>
    <span class="participant-name">${escapeHTML(name)}</span>
    ${isHost ? '<span class="participant-host">Host</span>' : ''}
  `;
  participantsEl.appendChild(el);
}

function updateMeetingInfo({ meetingNumber, userName, meetingId }) {
  meetingInfoEl.innerHTML = `
    <div class="info-item">
      <span class="info-label">Meeting ID</span>
      <span class="info-value">${escapeHTML(meetingNumber)}</span>
    </div>
    <div class="info-item">
      <span class="info-label">DB Record</span>
      <span class="info-value">#${meetingId}</span>
    </div>
    <div class="info-item">
      <span class="info-label">Bot Name</span>
      <span class="info-value">${escapeHTML(userName)}</span>
    </div>
    <div class="info-item">
      <span class="info-label">Status</span>
      <span class="info-value" style="color: #4caf50;">Connected</span>
    </div>
  `;
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = `status-bar${isError ? ' error' : isInMeeting ? ' connected' : ''}`;
  console.log(`[Status] ${msg}`);
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Save Caption to SQLite ──────────────────────────────

async function saveCaptionToDB({ speaker, text }, captionType) {
  if (!currentMeetingId) return;

  try {
    await ipcRenderer.invoke('db-insert-caption', {
      meetingId: currentMeetingId,
      speaker: speaker || '',
      text,
      captionType,
    });
  } catch (e) {
    console.error('[DB] Failed to save caption:', e);
  }
}

// ─── Export Captions ─────────────────────────────────────

exportBtn.addEventListener('click', async () => {
  if (!currentMeetingId) return;

  const json = await ipcRenderer.invoke('db-export-captions-json', {
    meetingId: currentMeetingId,
  });

  const { dialog } = require('electron').remote || require('@electron/remote');
  const fs = require('fs');
  const path = require('path');
  const exportPath = path.join(__dirname, `captions_meeting_${currentMeetingId}.json`);
  fs.writeFileSync(exportPath, json, 'utf-8');
  setStatus(`Exported to ${exportPath}`);
  console.log(`[Export] Saved to ${exportPath}`);
});

// ─── Form Handler ────────────────────────────────────────

joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const sdkKey = document.getElementById('sdk-key').value.trim();
  const sdkSecret = document.getElementById('sdk-secret').value.trim();
  const meetingNumber = document.getElementById('meeting-number').value.trim().replace(/\s/g, '');
  const password = document.getElementById('meeting-password').value.trim();
  const userName = document.getElementById('user-name').value.trim() || 'CC Caption Bot';

  if (!sdkKey || !sdkSecret || !meetingNumber) {
    setStatus('Please fill in SDK Key, SDK Secret, and Meeting Number', true);
    return;
  }

  joinBtn.disabled = true;
  joinBtn.textContent = 'Joining...';

  await joinMeeting(sdkKey, sdkSecret, meetingNumber, password, userName);
});

// ─── Initialize ──────────────────────────────────────────

// Pre-fill form with .env defaults (injected via /env-config.js)
const env = window.__ENV_CONFIG__;
if (env) {
  for (const [id, key] of [
    ['sdk-key', 'sdkKey'],
    ['sdk-secret', 'sdkSecret'],
    ['meeting-number', 'meetingNumber'],
    ['meeting-password', 'meetingPassword'],
    ['user-name', 'userName'],
  ]) {
    if (env[key]) document.getElementById(id).value = env[key];
  }
}

initZoomSDK();
