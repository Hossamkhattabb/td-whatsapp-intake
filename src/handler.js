const { Resend } = require('resend');
const { sendWhatsAppText } = require('./whatsapp');

const resend = new Resend(process.env.RESEND_API_KEY);
// onboarding@resend.dev only delivers to your own Resend account address.
// Set EMAIL_FROM to an address on a domain verified in Resend for real clients.
const EMAIL_FROM = process.env.EMAIL_FROM || 'Top Delmon <onboarding@resend.dev>';
const EMAIL_REGEX = /[\w.+-]+@[\w-]+\.[\w.]+/;

async function handleIncomingMessage(message, contact) {
  const text = message.text?.body || '';
  const name = contact?.profile?.name || 'Client';
  const email = (text.match(EMAIL_REGEX) || [])[0];

  if (!email) {
    await sendWhatsAppText(message.from, 'Please send your email address so we can confirm your request.');
    return;
  }

  // Resend returns { data, error } instead of throwing on API errors.
  // The idempotency key makes Resend send at most one email per WhatsApp
  // message (Resend remembers keys for 24 hours), even if we retry.
  const { data, error } = await resend.emails.send({
    from: EMAIL_FROM,
    to: email,
    subject: 'We received your request',
    html: `<p>Dear ${name},</p><p>We received your message: "${text}". Our team will contact you within one working day.</p>`,
  }, { idempotencyKey: `confirmation-email/${message.id}` });

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
