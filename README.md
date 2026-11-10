# td-whatsapp-intake

A small service that receives client WhatsApp messages through the Meta Cloud API webhook
and sends the client a confirmation email through Resend.

## Run locally

    cp .env.example .env   # fill in real values; .env is git-ignored, never commit it
    npm install
    npm start

## Deploy on Render

- Build command: `npm install` · Start command: `npm start`
- The server listens on `process.env.PORT`, which Render sets.
- Set every variable from `.env.example` in the service's **Environment** settings. There is no `.env` file on Render.
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
| `EMAIL_FROM` | Optional. Sender on a domain verified in Resend |

The server refuses to start if any required variable is missing.

## Webhook behavior

- `GET /webhook` returns `hub.challenge` as plain text when `hub.verify_token` matches.
- `POST /webhook` checks the HMAC-SHA256 signature of the raw body with `crypto.timingSafeEqual`. A bad or missing signature gets `401`.
- Valid requests get `200` immediately and are processed afterwards. Every message in the payload is handled. Status updates (no `messages`) are ignored.
- Message IDs that were already handled are skipped, so Meta's retries don't send duplicate emails. This memory resets when the server restarts.
- Resend `{ error }` results are checked. On failure, the client is told the email could not be sent.
