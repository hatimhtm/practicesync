'use strict';

/*
 * Mailer — the same email-alert mechanism as the practice's Hope Reminder app
 * (SMTP-over-TLS via curl, app password never in settings). Pure-function
 * coverage mirrors Hope Reminder's own MailerTests.swift.
 *
 *   node test/mailer.test.js
 */

const path = require('path');
const { parseRecipients, normalizePassword, configFrom, compose, curlArguments, SendError } = require(
  path.join(__dirname, '..', 'src', 'main', 'mailer')
);

let pass = 0; const fails = [];
const check = (n, ok) => { console.log(`${ok ? '  ok  ' : '  FAIL'}  ${n}`); ok ? pass++ : fails.push(n); };

(function testRecipientsForgiveAnySeparator() {
  console.log('# parseRecipients — any separator, typos dropped');
  for (const raw of ['a@x.com, b@y.com', 'a@x.com;b@y.com', 'a@x.com b@y.com', 'a@x.com,\n b@y.com']) {
    check(JSON.stringify(raw), JSON.stringify(parseRecipients(raw)) === JSON.stringify(['a@x.com', 'b@y.com']));
  }
  check('typos that cannot receive mail are silently dropped', JSON.stringify(parseRecipients('nonsense, a@x.com')) === JSON.stringify(['a@x.com']));
})();

(function testPasswordSpacesStripped() {
  console.log('# normalizePassword — Google-style grouped app passwords');
  check('"abcd efgh ijkl mnop" -> "abcdefghijklmnop"', normalizePassword('abcd efgh ijkl mnop') === 'abcdefghijklmnop');
})();

(function testConfigRejectsMissingPieces() {
  console.log('# configFrom — refuses to send with anything missing');
  let threw = false;
  try { configFrom({ alertEmailRecipients: '' }, { username: 'a@x.com', password: 'pw' }); } catch (e) { threw = e instanceof SendError; }
  check('no recipients -> throws', threw);

  threw = false;
  try { configFrom({ alertEmailRecipients: 'office@x.com' }, { username: '', password: 'pw' }); } catch (e) { threw = e instanceof SendError; }
  check('no sender -> throws', threw);

  threw = false;
  try { configFrom({ alertEmailRecipients: 'office@x.com' }, { username: 'a@x.com', password: '' }); } catch (e) { threw = e instanceof SendError; }
  check('no app password -> throws', threw);

  const config = configFrom({ alertEmailRecipients: 'office@x.com', smtpHost: 'smtp.gmail.com', smtpPort: 465 }, { username: 'a@x.com', password: 'abcd efgh' });
  check('valid settings -> a usable config', config.recipients.length === 1 && config.username === 'a@x.com' && config.password === 'abcdefgh');
})();

(function testMessageIsRFC5322WithCRLF() {
  console.log('# compose — RFC 5322 message, CRLF line endings');
  const message = compose({ from: 'office@example.com', to: ['a@example.com', 'b@example.com'], subject: 'Test', body: 'line one\nline two' });
  check('From header', message.includes('From: Hope Assistant <office@example.com>\r\n'));
  check('To header lists every recipient', message.includes('To: a@example.com, b@example.com\r\n'));
  check('body follows the blank line, CRLF-joined', message.includes('\r\n\r\nline one\r\nline two'));
  check('no bare LFs left (mail servers reject them)', !message.replace(/\r\n/g, '').includes('\n'));
})();

(function testCurlArgumentsCarryEveryRecipient() {
  console.log('# curlArguments — one --mail-rcpt per recipient, SMTPS + TLS');
  const args = curlArguments({ host: 'smtp.gmail.com', port: 465, username: 'u@example.com', password: 'secret', recipients: ['a@example.com', 'b@example.com'] }, '/tmp/m.eml');
  check('one --mail-rcpt per recipient', args.filter((a) => a === '--mail-rcpt').length === 2);
  check('smtps:// url with the right port', args.includes('smtps://smtp.gmail.com:465'));
  check('--ssl-reqd present', args.includes('--ssl-reqd'));
})();

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
