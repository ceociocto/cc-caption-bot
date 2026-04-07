#!/usr/bin/env node
/**
 * jwt.js - Standalone JWT token generator for Zoom Meeting SDK
 *
 * Usage:
 *   node jwt.js <sdkKey> <sdkSecret> <meetingNumber> [role]
 *
 * Examples:
 *   node jwt.js abc123 xyz456 1234567890        # Join as participant (role=0)
 *   node jwt.js abc123 xyz456 1234567890 1       # Join as host (role=1)
 *
 * The generated token is valid for 48 hours.
 */

const crypto = require('crypto');

function generateJWT(sdkKey, sdkSecret, meetingNumber, role = 0) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 48 * 3600;

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

// ─── CLI ─────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.length < 3) {
  console.log(`
Zoom Meeting SDK JWT Generator

Usage:
  node jwt.js <sdkKey> <sdkSecret> <meetingNumber> [role]

Arguments:
  sdkKey         - Your Zoom Meeting SDK App Key
  sdkSecret      - Your Zoom Meeting SDK App Secret
  meetingNumber  - The meeting number to join
  role           - 0 (participant, default) or 1 (host)

Example:
  node jwt.js abc123 xyz456 1234567890
  node jwt.js abc123 xyz456 1234567890 1
  `);
  process.exit(1);
}

const [sdkKey, sdkSecret, meetingNumber, roleStr] = args;
const role = parseInt(roleStr || '0', 10);

const token = generateJWT(sdkKey, sdkSecret, meetingNumber, role);

console.log('─── Zoom Meeting SDK JWT ───');
console.log(`SDK Key:        ${sdkKey}`);
console.log(`Meeting Number: ${meetingNumber}`);
console.log(`Role:           ${role === 1 ? 'Host' : 'Participant'}`);
console.log(`Expires:        ${new Date(Date.now() + 48 * 3600 * 1000).toISOString()}`);
console.log(`\nToken:\n${token}`);
