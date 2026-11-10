# Requirement (b): no duplicate emails

## The problem

Meta delivers webhooks *at least once*. If our server is slow to answer, returns an error, or is
waking up on Render, Meta sends the same message again, sometimes much later. The starter code
emailed on every delivery, so one WhatsApp message could produce several confirmation emails.

Answering `200` immediately (step 2) makes retries rarer, but it does not stop them. A cold start
or a network drop between Meta and Render can still cause a redelivery. So the server has to
recognise a message it has already handled.

## The key: the WhatsApp message ID

Every incoming message has a unique ID (`messages[].id`, for example `wamid.HBgL…`). Meta keeps
the same ID across redeliveries, so it identifies "this message" exactly. We use it in two
places:

1. **Our own record** (`src/store.js`): before handling a message, the server *claims* its ID
   in a `processed_messages` table. If the ID is already there, the delivery is skipped.
2. **Resend's idempotency key** (`src/handler.js`): the email is sent with
   `idempotencyKey: "confirmation-email/<message id>"`. If the same key reaches Resend again
   within 24 hours, Resend returns the original result and sends nothing.

The two layers cover different failures. Our record stops repeat processing. Resend's key
covers the gap where the email went out but we crashed, or the WhatsApp reply failed, before
the message was marked done. Retrying then cannot send a second email.

## Why a persistent store

The first version kept seen IDs in memory. That list is lost on every Render restart,
redeploy or free-tier sleep, which is exactly when Meta tends to retry. It is also not shared if
the service runs more than one instance. The IDs therefore live in **Render Postgres**,
connected with `DATABASE_URL`:

```sql
CREATE TABLE processed_messages (
  message_id   TEXT PRIMARY KEY,           -- the WhatsApp message ID
  status       TEXT NOT NULL,              -- 'processing' | 'done' | 'failed'
  claimed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  email_id     TEXT,                       -- Resend email ID, for tracing
  error        TEXT
);
```

The claim is a single atomic statement (`INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING`).
When two deliveries of the same message arrive at the same moment, the primary key guarantees
only one of them gets a row back and goes on to send the email.

| Status of existing row | What a new delivery does |
|---|---|
| none | claims it and processes it |
| `done` | skips it |
| `processing`, under 10 minutes old | skips it (another delivery is working on it) |
| `processing`, over 10 minutes old | takes it over (the earlier attempt probably crashed) |
| `failed` | takes it over and retries; Resend's key prevents a second email |

Rows older than 30 days are deleted daily. Meta stops retrying long before then.

Postgres was chosen over Render Key Value (Redis) because Render's free Key Value instance keeps
data only in memory, which would bring back the restart problem. Note: Render's *free*
Postgres expires after 30 days, so production needs a paid instance.

**Running locally** (no `DATABASE_URL`): the same records are kept in
`data/processed-messages.json`. It needs no setup and still survives restarts. Writes go through a
temp file and a rename, so a crash can't corrupt it. The claim check runs without any `await`, so
two simultaneous deliveries can't both win. On Render (where the `RENDER` variable is set) the
server refuses to start without `DATABASE_URL`, because Render's disk is wiped on deploy.

## How it was tested

Tested locally against a real PostgreSQL 16, with the calls to Meta and Resend faked:

| Scenario | Result |
|---|---|
| First delivery | 1 email sent, with `Idempotency-Key: confirmation-email/wamid…`; row `done` |
| 5 redeliveries at the same moment | all answered `200`, all skipped, no email |
| Server restarted, then redelivered | skipped: the record survived the restart |
| WhatsApp reply fails after the email was sent | row `failed`; the next delivery retries with the **same** idempotency key, so real Resend would not send it twice |
| Started with `RENDER=true` and no `DATABASE_URL` | refuses to start |
| Local file store: sample sent, server restarted, sample sent again | second one skipped |

## Limits

- Resend remembers idempotency keys for 24 hours. A retry of a `failed` message after that
  could send a second email. Meta's retries normally stop well before then.
- Because we answer `200` before processing, Meta does not redeliver after *our own* failures.
  A `failed` row is only retried if Meta happens to send the message again. Re-sending failed
  messages automatically would need a background job, which is not built yet.
- Dedup is per message, not per request. If a client sends two separate messages that both
  contain their email address, they get two confirmation emails, by design.
