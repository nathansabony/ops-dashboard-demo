// Outgoing email for sign-in: password-reset links and invite links.
//
// DEMO_MODE=1: a no-op. send() returns without contacting anything, so the
// Admin tab's invite/reset buttons work without a mail server.
//
// Three ways to send, picked by which environment variables are set in the environment:
//
//   Microsoft 365 (Microsoft Graph) — sends as a real company mailbox, e.g.
//     noreply@example.com. Needs an app registration in Microsoft Entra with
//     the Mail.Send application permission (admin-consented):
//       MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET,
//       MAIL_FROM (the mailbox to send as)
//   SMTP — any provider (Resend, Postmark, SendGrid, M365 SMTP AUTH, Gmail):
//       SMTP_HOST, SMTP_PORT (587/465), SMTP_USER, SMTP_PASS, MAIL_FROM
//   File — tests only: MAIL_TRANSPORT=file, MAIL_DIR=<folder>; each email is
//     written there as JSON instead of sent.
//
// Links in an email always use DASHBOARD_PUBLIC_URL (the site's real address),
// never the Host header of the request that triggered it — otherwise anyone could
// ask for a reset email whose link points at their own site and collects the
// token. Without DASHBOARD_PUBLIC_URL, email is treated as not set up.

const fs = require('fs');
const path = require('path');

const env = k => (process.env[k] || '').trim();

const DEMO = process.env.DEMO_MODE === '1';

function transportKind() {
  if (DEMO) return 'demo';
  if (env('MAIL_TRANSPORT') === 'file' && env('MAIL_DIR')) return 'file';
  if (env('MS_GRAPH_TENANT_ID') && env('MS_GRAPH_CLIENT_ID') && env('MS_GRAPH_CLIENT_SECRET') && env('MAIL_FROM')) return 'graph';
  if (env('SMTP_HOST') && env('MAIL_FROM')) return 'smtp';
  return null;
}
function baseUrl() {
  if (DEMO) return 'http://localhost:' + (process.env.PORT || 3001);
  const u = env('DASHBOARD_PUBLIC_URL').replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+/.test(u) ? u : '';
}
function configured() { return Boolean(transportKind() && baseUrl()); }
function describe() {
  const k = transportKind();
  if (k === 'demo') return 'Demo mode: emails are not sent (nothing leaves this server).';
  if (!k) return 'Email is not set up — reset links cannot be sent. Add the MS_GRAPH_* or SMTP_* settings and MAIL_FROM in the environment.';
  if (!baseUrl()) return 'Email is set up, but DASHBOARD_PUBLIC_URL (the site address used in links) is missing.';
  return k === 'graph' ? `Sending as ${env('MAIL_FROM')} through Microsoft 365.` : k === 'smtp' ? `Sending as ${env('MAIL_FROM')} through ${env('SMTP_HOST')}.` : 'Writing emails to a folder (test mode).';
}

// ── Microsoft Graph ─────────────────────────────────────────────────────────
let graphToken = { value: '', exp: 0 };
async function graphAccessToken() {
  if (graphToken.value && Date.now() < graphToken.exp - 60000) return graphToken.value;
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env('MS_GRAPH_TENANT_ID'))}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('MS_GRAPH_CLIENT_ID'), client_secret: env('MS_GRAPH_CLIENT_SECRET'),
      scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Microsoft sign-in for email failed (${r.status} ${j.error || ''})`.trim());
  graphToken = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return graphToken.value;
}
async function sendGraph({ to, subject, text, html }) {
  const token = await graphAccessToken();
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env('MAIL_FROM'))}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { subject, body: { contentType: html ? 'HTML' : 'Text', content: html || text }, toRecipients: [{ emailAddress: { address: to } }] },
      saveToSentItems: false,
    }),
  });
  if (!r.ok) throw new Error(`Microsoft 365 refused the email (${r.status})`);
}

// ── SMTP ────────────────────────────────────────────────────────────────────
let smtp = null;
function smtpTransport() {
  if (smtp) return smtp;
  const nodemailer = require('nodemailer');
  const port = Number(env('SMTP_PORT') || 587);
  smtp = nodemailer.createTransport({
    host: env('SMTP_HOST'), port, secure: port === 465,
    auth: env('SMTP_USER') ? { user: env('SMTP_USER'), pass: env('SMTP_PASS') } : undefined,
  });
  return smtp;
}

// One email. `to` is a single address the caller took from the user store — it is
// never taken from the request.
async function send({ to, subject, text, html }) {
  const kind = transportKind();
  if (kind === 'demo') return;
  if (!kind || !baseUrl()) throw Object.assign(new Error(describe()), { code: 'MAIL_NOT_CONFIGURED' });
  if (kind === 'file') {
    fs.mkdirSync(env('MAIL_DIR'), { recursive: true });
    fs.writeFileSync(path.join(env('MAIL_DIR'), `${Date.now()}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify({ to, subject, text, html }));
    return;
  }
  if (kind === 'graph') return sendGraph({ to, subject, text, html });
  await smtpTransport().sendMail({ from: env('MAIL_FROM'), to, subject, text, html });
}

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The two emails the site sends. Plain, branded lightly, and the link both as a
// button and as text (some mail clients strip buttons).
function linkEmail({ kind, name, link, hours }) {
  const invite = kind === 'invite';
  const subject = invite ? 'Your Portfolio Management Dashboard site account' : 'Reset your Portfolio Management Dashboard password';
  const hello = name ? `Hi ${name},` : 'Hi,';
  const lead = invite
    ? 'An account has been set up for you on the Portfolio Management Dashboard site. Choose your password to sign in:'
    : 'Someone (hopefully you) asked to reset your password for the Portfolio Management Dashboard site. Choose a new one here:';
  const tail = `This link works once and expires in ${hours} hour${hours === 1 ? '' : 's'}.${invite ? '' : ' If you did not ask for this, you can ignore this email — your password has not changed.'}`;
  const text = `${hello}\n\n${lead}\n\n${link}\n\n${tail}\n`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#14342A;max-width:520px;">
    <p>${escapeHtml(hello)}</p><p>${escapeHtml(lead)}</p>
    <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#14532D;color:#FFFDFA;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold;">${invite ? 'Choose my password' : 'Reset my password'}</a></p>
    <p style="font-size:12px;color:#7D766A;">Or paste this into your browser:<br>${escapeHtml(link)}</p>
    <p style="font-size:12px;color:#7D766A;">${escapeHtml(tail)}</p></div>`;
  return { subject, text, html };
}

// "Confirm your email" after a self sign-up.
function verifyEmailMessage({ name, link }) {
  const hello = name ? `Hi ${name},` : 'Hi,';
  const lead = 'Thanks for signing up for the Portfolio Management Dashboard site. Confirm this is your email address:';
  const tail = 'An admin will give you access to the tools you need. If you did not sign up, you can ignore this email.';
  return {
    subject: 'Confirm your email — Portfolio Management Dashboard',
    text: `${hello}\n\n${lead}\n\n${link}\n\n${tail}\n`,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#14342A;max-width:520px;">
      <p>${escapeHtml(hello)}</p><p>${escapeHtml(lead)}</p>
      <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#14532D;color:#FFFDFA;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold;">Confirm my email</a></p>
      <p style="font-size:12px;color:#7D766A;">Or paste this into your browser:<br>${escapeHtml(link)}</p>
      <p style="font-size:12px;color:#7D766A;">${escapeHtml(tail)}</p></div>`,
  };
}

module.exports = { configured, describe, send, baseUrl, linkEmail, verifyEmailMessage, transportKind };
