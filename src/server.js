// Load .env BEFORE anything reads process.env (including ./handler, which
// creates the Resend client at require time). On Render there is no .env file;
// variables come from the service's Environment settings and dotenv is a no-op.
require('dotenv').config();

const REQUIRED_ENV = [
  'META_VERIFY_TOKEN',
  'META_APP_SECRET',
  'META_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'RESEND_API_KEY',
];
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const crypto = require('crypto');
const express = require('express');
const { handleIncomingMessage } = require('./handler');

const { META_VERIFY_TOKEN, META_APP_SECRET } = process.env;
const PORT = process.env.PORT || 3000;

const app = express();

// Meta webhook verification handshake: echo hub.challenge as plain text.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN && challenge) {
    return res.status(200).type('text/plain').send(String(challenge));
  }
  return res.sendStatus(403);
});

// Meta signs the exact raw body: X-Hub-Signature-256: sha256=<hex HMAC-SHA256>.
function isValidSignature(rawBody, header) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', META_APP_SECRET).update(rawBody).digest();
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  // timingSafeEqual throws on different lengths, so check that first.
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

// Meta retries deliveries, so remember recently handled message IDs to avoid
// sending the same confirmation email twice. In-memory only: it resets on
// restart/redeploy and is not shared between instances.
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
const seenMessages = new Map();
function alreadySeen(id) {
  const now = Date.now();
  for (const [key, at] of seenMessages) {
    if (now - at < SEEN_TTL_MS) break; // Map keeps insertion order: oldest first
    seenMessages.delete(key);
  }
  if (seenMessages.has(id)) return true;
  seenMessages.set(id, now);
  return false;
}

// Collect every message in the payload. Status updates (sent/delivered/read)
// arrive with `statuses` and no `messages`, so they yield nothing.
function extractMessages(body) {
  const results = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!Array.isArray(value?.messages)) continue;
      const contacts = value.contacts ?? [];
      for (const message of value.messages) {
        const contact = contacts.find((c) => c.wa_id === message.from) ?? contacts[0];
        results.push({ message, contact });
      }
    }
  }
  return results;
}

// Raw body parser on this route only, so the signature is checked against the
// exact bytes Meta sent (express.json() would discard them).
app.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  if (!isValidSignature(rawBody, req.get('X-Hub-Signature-256'))) {
    return res.sendStatus(401);
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }

  // Acknowledge immediately; slow or failed responses make Meta retry.
  res.sendStatus(200);

  for (const { message, contact } of extractMessages(body)) {
    if (!message?.id || alreadySeen(message.id)) continue;
    handleIncomingMessage(message, contact).catch((err) => {
      console.error(`Failed to handle message ${message.id}:`, err.message);
    });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
