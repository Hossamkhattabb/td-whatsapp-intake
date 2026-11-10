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
const { createStore } = require('./store');

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

// Meta can deliver the same message more than once. The store records each
// message ID persistently so a redelivery never sends a second email.
const store = createStore();

async function processMessage(message, contact) {
  if (!(await store.claim(message.id))) {
    console.log(`Skipping duplicate delivery of message ${message.id}`);
    return;
  }
  try {
    const result = await handleIncomingMessage(message, contact);
    await store.complete(message.id, result?.emailId);
  } catch (err) {
    // 'failed' lets a later redelivery retry; Resend's idempotency key
    // (the same message ID) stops that retry from sending a second email.
    await store.fail(message.id, err.message);
    throw err;
  }
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
    if (!message?.id) continue;
    processMessage(message, contact).catch((err) => {
      console.error(`Failed to handle message ${message.id}:`, err.message);
    });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

store
  .init()
  .then(() => app.listen(PORT, () => console.log(`Listening on ${PORT} (dedup store: ${store.kind})`)))
  .catch((err) => {
    console.error('Could not initialise dedup store:', err.message);
    process.exit(1);
  });
