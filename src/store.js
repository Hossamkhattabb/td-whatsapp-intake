// Records which WhatsApp message IDs have been handled, so a message is only
// processed once even if Meta delivers it several times.
//
// DATABASE_URL set (production on Render): Postgres, which survives restarts and
// redeploys and is shared by every instance. Otherwise (local runs): a JSON file
// in data/, which survives restarts. On Render (RENDER is set) DATABASE_URL is required.

const STALE_CLAIM_MINUTES = 10; // a 'processing' row older than this is assumed crashed
const RETENTION_DAYS = 30; // Meta stops retrying long before this

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS processed_messages (
    message_id   TEXT PRIMARY KEY,
    status       TEXT NOT NULL CHECK (status IN ('processing', 'done', 'failed')),
    claimed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    email_id     TEXT,
    error        TEXT
  )`;

// One atomic statement: insert a new row, or take over a row that failed or
// whose claim went stale. Returns a row only if this caller now owns the message,
// so two concurrent deliveries can never both win.
const CLAIM_SQL = `
  INSERT INTO processed_messages (message_id, status) VALUES ($1, 'processing')
  ON CONFLICT (message_id) DO UPDATE
    SET status = 'processing', claimed_at = now(), error = NULL
    WHERE processed_messages.status = 'failed'
       OR (processed_messages.status = 'processing'
           AND processed_messages.claimed_at < now() - make_interval(mins => ${STALE_CLAIM_MINUTES}))
  RETURNING message_id`;

function createPostgresStore(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, max: 5 });

  async function purgeOld() {
    await pool.query(
      `DELETE FROM processed_messages WHERE claimed_at < now() - make_interval(days => ${RETENTION_DAYS})`,
    );
  }

  return {
    kind: 'postgres',
    async init() {
      await pool.query(SCHEMA);
      await purgeOld();
      setInterval(() => purgeOld().catch((e) => console.error('Purge failed:', e.message)), 24 * 3600e3).unref();
    },
    async claim(id) {
      const { rowCount } = await pool.query(CLAIM_SQL, [id]);
      return rowCount === 1;
    },
    async complete(id, emailId = null) {
      await pool.query(
        `UPDATE processed_messages SET status = 'done', completed_at = now(), email_id = $2 WHERE message_id = $1`,
        [id, emailId],
      );
    },
    async fail(id, error) {
      await pool.query(
        `UPDATE processed_messages SET status = 'failed', error = $2 WHERE message_id = $1`,
        [id, String(error).slice(0, 500)],
      );
    },
    close: () => pool.end(),
  };
}

// Local default: a JSON file in data/. Survives restarts and needs no setup.
// Not for Render: its disk is wiped on every deploy and restart.
function createFileStore(filePath) {
  const fs = require('fs');
  const path = require('path');
  let rows = {};

  // Write to a temp file then rename, so a crash never leaves a half-written file.
  function save() {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows));
    fs.renameSync(tmp, filePath);
  }

  return {
    kind: `file (${path.relative(process.cwd(), filePath) || filePath})`,
    async init() {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (fs.existsSync(filePath)) rows = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600e3;
      for (const [id, row] of Object.entries(rows)) if (row.claimedAt < cutoff) delete rows[id];
      save();
    },
    // Check and set run with no await in between. Node runs this without
    // interruption, so two simultaneous deliveries cannot both claim the ID.
    async claim(id) {
      const row = rows[id];
      const stale = row?.status === 'processing' && Date.now() - row.claimedAt > STALE_CLAIM_MINUTES * 60e3;
      if (row && row.status !== 'failed' && !stale) return false;
      rows[id] = { status: 'processing', claimedAt: Date.now() };
      save();
      return true;
    },
    async complete(id, emailId = null) {
      if (!rows[id]) return;
      Object.assign(rows[id], { status: 'done', completedAt: Date.now(), emailId });
      save();
    },
    async fail(id, error) {
      if (!rows[id]) return;
      Object.assign(rows[id], { status: 'failed', error: String(error).slice(0, 500) });
      save();
    },
    async close() {},
  };
}

function createStore() {
  if (process.env.DATABASE_URL) return createPostgresStore(process.env.DATABASE_URL);
  if (process.env.RENDER) {
    throw new Error('DATABASE_URL is required on Render: its disk is wiped on every deploy/restart');
  }
  const file = process.env.DEDUP_FILE || require('path').join(__dirname, '..', 'data', 'processed-messages.json');
  return createFileStore(file);
}

module.exports = { createStore };
