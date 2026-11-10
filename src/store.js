// Records which WhatsApp message IDs have been handled, so a message is only
// processed once even if Meta delivers it several times.
//
// Production (DATABASE_URL set): Postgres, which survives restarts/redeploys and
// is shared by every instance. Local development without DATABASE_URL: an
// in-memory Map (lost on restart). On Render (RENDER is set) DATABASE_URL is required.

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

function createMemoryStore() {
  const rows = new Map();
  return {
    kind: 'memory',
    async init() {},
    async claim(id) {
      const row = rows.get(id);
      const stale = row?.status === 'processing' && Date.now() - row.claimedAt > STALE_CLAIM_MINUTES * 60e3;
      if (row && row.status !== 'failed' && !stale) return false;
      rows.set(id, { status: 'processing', claimedAt: Date.now() });
      return true;
    },
    async complete(id) {
      const row = rows.get(id);
      if (row) row.status = 'done';
    },
    async fail(id) {
      const row = rows.get(id);
      if (row) row.status = 'failed';
    },
    async close() {},
  };
}

function createStore() {
  if (process.env.DATABASE_URL) return createPostgresStore(process.env.DATABASE_URL);
  if (process.env.RENDER) {
    throw new Error('DATABASE_URL is required on Render: in-memory dedup is lost on every restart');
  }
  console.warn('DATABASE_URL not set: using in-memory dedup (local development only)');
  return createMemoryStore();
}

module.exports = { createStore };
