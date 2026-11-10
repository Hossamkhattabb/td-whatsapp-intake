# td-whatsapp-intake

A small service that receives client WhatsApp messages through the Meta Cloud API webhook
and sends the client a confirmation email through Resend.

## Run locally

    cp .env.example .env   # or use the provided .env; it is git-ignored, never commit it
    npm install
    npm start

In a second terminal, send the sample message signed with `META_APP_SECRET` from `.env`, the way Meta signs it:

    npm run send-sample                       # samples/incoming-message.json
    npm run send-sample -- path/to/other.json

`.env` is loaded from the project root whichever directory you start from. Only `META_APP_SECRET`
is required to start. The others print a warning, and their feature fails cleanly without them.
Locally, handled message IDs are stored in `data/processed-messages.json`, so a resend is skipped
even after a restart. Delete that file to reset.

## Deploy on Render

- Build command: `npm install` · Start command: `npm start`
- The server listens on `process.env.PORT`, which Render sets.
- Set every variable from `.env.example` in the service's **Environment** settings. There is no `.env` file on Render.
- Create a Render Postgres database and set `DATABASE_URL` to its **Internal Database URL**. The table is created on startup.
- Health check path: `/health`
- Meta webhook callback URL: `https://<your-service>.onrender.com/webhook`, with the verify token set to `META_VERIFY_TOKEN`.

## Environment variables

| Name | Purpose |
|---|---|
| `META_VERIFY_TOKEN` | Your chosen string, checked during Meta's GET verification |
| `META_APP_SECRET` | Meta App Secret, used to check `X-Hub-Signature-256` on every POST |
| `META_ACCESS_TOKEN` | Token for sending WhatsApp messages (use a System User token in production) |
| `WHATSAPP_PHONE_NUMBER_ID` | The business phone number ID |
| `RESEND_API_KEY` | Resend API key |
| `DATABASE_URL` | Postgres for message dedup. Required on Render; optional locally (a JSON file in `data/` is used instead) |
| `EMAIL_FROM` | Optional. Sender on a domain verified in Resend |

The server refuses to start if any required variable is missing.

## Webhook behavior

- `GET /webhook` returns `hub.challenge` as plain text when `hub.verify_token` matches.
- `POST /webhook` checks the HMAC-SHA256 signature of the raw body with `crypto.timingSafeEqual`. A bad or missing signature gets `401`.
- Valid requests get `200` immediately and are processed afterwards. Every message in the payload is handled. Status updates (no `messages`) are ignored.
- Each WhatsApp message ID is recorded in Postgres and also sent to Resend as the idempotency key, so Meta's retries never send a duplicate email. See [docs/DUPLICATES.md](docs/DUPLICATES.md).
- The client's name and message are HTML-escaped in the email, and a plain-text version is included.
- Non-text messages (images, voice notes…) get a request to send text. Reactions and system messages are ignored.
- Resend `{ error }` results are checked. On failure, the client is told the email could not be sent.
