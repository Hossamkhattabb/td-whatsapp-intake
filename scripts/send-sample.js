// Sign a sample payload with META_APP_SECRET from .env (as Meta would) and POST it.
// Usage: npm run send-sample [-- path/to/payload.json] [-- url]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const file = process.argv[2] || path.join(__dirname, '..', 'samples', 'incoming-message.json');
const url = process.argv[3] || `http://localhost:${process.env.PORT || 3000}/webhook`;
const body = fs.readFileSync(file);
const signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET || '').update(body).digest('hex');

fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
  body,
}).then((res) => console.log(`POST ${url} -> ${res.status}`))
  .catch((err) => { console.error(err.message); process.exit(1); });
