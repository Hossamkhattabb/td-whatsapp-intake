const { Resend } = require('resend');
const { sendWhatsAppText } = require('./whatsapp');

// Created on first use, so a missing key fails one email instead of crashing startup.
let resend;
function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  resend ??= new Resend(process.env.RESEND_API_KEY);
  return resend;
}

// onboarding@resend.dev only delivers to your own Resend account address.
// Set EMAIL_FROM to an address on a domain verified in Resend for real clients.
const EMAIL_FROM = process.env.EMAIL_FROM || 'Top Delmon <onboarding@resend.dev>';
// Every dot must be followed by more characters, so "me@x.com." does not keep the final full stop.
const EMAIL_REGEX = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
// Message types a client sends on purpose that we cannot read. Reactions,
// system and "unsupported" messages are ignored without a reply.
const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts']);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

async function handleIncomingMessage(message, contact) {
  if (message.type !== 'text') {
    if (MEDIA_TYPES.has(message.type)) {
      await sendWhatsAppText(message.from, 'Please send your request as a text message, including your email address.');
    }
    return { emailId: null };
  }

  const text = message.text?.body || '';
  const name = contact?.profile?.name || 'Client';
  const email = (text.match(EMAIL_REGEX) || [])[0];

  if (!email) {
    await sendWhatsAppText(message.from, 'Please send your email address so we can confirm your request.');
    return { emailId: null };
  }

  // The client controls both name and text, so escape them before putting them in HTML.
  const safeName = escapeHtml(name);
  const safeText = escapeHtml(text);

  // Resend returns { data, error } instead of throwing on API errors.
  // The idempotency key makes Resend send at most one email per WhatsApp
  // message (Resend remembers keys for 24 hours), even if we retry.
  const client = getResend();
  const { data, error } = client
    ? await client.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: 'We received your request',
      html: `<p>Dear ${safeName},</p><p>We received your message: "${safeText}". Our team will contact you within one working day.</p>`,
      text: `Dear ${name},\n\nWe received your message: "${text}". Our team will contact you within one working day.`,
    }, { idempotencyKey: `confirmation-email/${message.id}` })
    : { data: null, error: { name: 'missing_api_key', message: 'RESEND_API_KEY is not set' } };

  if (error) {
    console.error(`Resend failed for message ${message.id}:`, error.name, error.message);
    await sendWhatsAppText(
      message.from,
      'Thank you. We received your request, but we could not send the confirmation email. Our team will contact you.',
    );
    return { emailId: null };
  }

  console.log(`Confirmation email ${data?.id} sent for message ${message.id}`);
  await sendWhatsAppText(message.from, 'Thank you. A confirmation email has been sent.');
  return { emailId: data?.id ?? null };
}

module.exports = { handleIncomingMessage };
