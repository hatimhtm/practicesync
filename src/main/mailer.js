'use strict';

/*
 * Email alerts — the same approach as the practice's Hope Reminder app: sends
 * through the agency's OWN mailbox (Gmail, iCloud, any SMTP) — free, no
 * third-party reminder service, and no outside company holding patient
 * names. Transport is the system's `curl`, which has spoken SMTP-over-TLS for
 * twenty years; the app password lives in the OS keychain (via store.js's
 * safeStorage-encrypted creds.bin), never in settings.json.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

class SendError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind || 'transport'; // 'notConfigured' | 'transport'
  }
}

/** Recipients however people type them: commas, semicolons, spaces or new
 *  lines between addresses all work. Typos that can't receive mail (no "@",
 *  no ".") are silently dropped, not sent to. */
function parseRecipients(raw) {
  return String(raw || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes('@') && s.includes('.'));
}

/** Google shows app passwords in groups ("abcd efgh ijkl mnop") and people
 *  paste them exactly like that. Spaces are never part of the password —
 *  strip them everywhere. */
function normalizePassword(raw) {
  return String(raw || '').replace(/\s+/g, '');
}

/** Build a ready-to-send Config from settings + the smtp creds, or throw a
 *  SendError describing exactly what's missing (never guess). */
function configFrom(settings, smtpCreds) {
  const recipients = parseRecipients(settings.alertEmailRecipients);
  if (!recipients.length) throw new SendError('add at least one recipient', 'notConfigured');
  const username = String((smtpCreds && smtpCreds.username) || '').trim();
  if (!username.includes('@')) throw new SendError('add the sending email address', 'notConfigured');
  const password = normalizePassword(smtpCreds && smtpCreds.password);
  if (!password) throw new SendError('add the app password', 'notConfigured');
  return {
    host: settings.smtpHost || 'smtp.gmail.com',
    port: settings.smtpPort || 465,
    username,
    password,
    recipients,
  };
}

/** RFC 5322 message. CRLF line endings are not optional. */
function compose({ from, to, subject, body }) {
  const date = new Date().toUTCString().replace('GMT', '+0000');
  const headers = [
    `From: Hope Assistant <${from}>`,
    `To: ${to.join(', ')}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  return headers.join('\r\n') + '\r\n\r\n' + String(body || '').replace(/\n/g, '\r\n');
}

function curlArguments(config, messageFile) {
  const args = ['--url', `smtps://${config.host}:${config.port}`, '--ssl-reqd', '--mail-from', config.username];
  for (const r of config.recipients) args.push('--mail-rcpt', r);
  args.push('--user', `${config.username}:${config.password}`, '--upload-file', messageFile, '--silent', '--show-error', '--max-time', '45');
  return args;
}

function friendlyCurlError(code, detail) {
  if (code === 67) {
    return 'The mail server rejected the sign-in. For Gmail this means the app password is wrong — '
      + 'generate one at myaccount.google.com/apppasswords (2-Step Verification must be on).';
  }
  if (code === 6 || code === 7 || code === 28) {
    return 'Could not reach the mail server — check the internet connection and the server name.';
  }
  return detail || `Sending failed (curl exit ${code}).`;
}

/** Send one email now. `config` is from configFrom(). Rejects with a
 *  SendError carrying a friendly message on any failure. */
function send({ subject, body, config }) {
  return new Promise((resolve, reject) => {
    const message = compose({ from: config.username, to: config.recipients, subject, body });
    const tmp = path.join(os.tmpdir(), `hope-mail-${crypto.randomUUID()}.eml`);
    fs.writeFileSync(tmp, message, 'utf8');
    const cleanup = () => { try { fs.unlinkSync(tmp); } catch {} };
    execFile('/usr/bin/curl', curlArguments(config, tmp), { timeout: 50000 }, (err, _stdout, stderr) => {
      cleanup();
      if (!err) return resolve();
      const code = typeof err.code === 'number' ? err.code : -1;
      reject(new SendError(friendlyCurlError(code, String(stderr || '').trim()), 'transport'));
    });
  });
}

module.exports = { SendError, parseRecipients, normalizePassword, configFrom, compose, curlArguments, friendlyCurlError, send };
