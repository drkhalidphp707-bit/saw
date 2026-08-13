import crypto from 'node:crypto';
import { accountAccess, getAccount, getCloudDocument, saveCloudDocument } from './store.js';
import { processMessage } from './conversation.js';

const DEFAULT_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const processedMessages = new Map();
const diagnosticEvents = new Map();

function recordDiagnostic(accountId, type, details = {}) {
  const events = diagnosticEvents.get(accountId) || [];
  events.unshift({ at: new Date().toISOString(), type, ...details });
  diagnosticEvents.set(accountId, events.slice(0, 40));
}

const maskedNumber = (value) => {
  const number = clean(value);
  return number ? `***${number.slice(-4)}` : '';
};

function encryptionKey() {
  const secret = process.env.CREDENTIALS_ENCRYPTION_KEY || process.env.ADMIN_PASSWORD;
  if (!secret) throw new Error('اضبط CREDENTIALS_ENCRYPTION_KEY في Railway أولاً');
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function decrypt(value) {
  const [iv, tag, encrypted] = String(value || '').split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv?.length || !tag?.length || !encrypted?.length) throw new Error('بيانات اتصال Meta غير صالحة');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

const clean = (value) => String(value || '').trim();
const publicSettings = (stored, origin = '') => stored ? {
  configured: Boolean(stored.phoneNumberId && stored.accessToken),
  enabled: Boolean(stored.enabled),
  verified: Boolean(stored.lastTestedAt),
  phoneNumberId: stored.phoneNumberId || '',
  businessAccountId: stored.businessAccountId || '',
  apiVersion: stored.apiVersion || DEFAULT_VERSION,
  displayPhone: stored.displayPhone || '',
  verifiedName: stored.verifiedName || '',
  webhookUrl: origin && stored.accountId ? `${origin}/api/meta/webhook/${stored.accountId}` : '',
  verifyToken: stored.verifyToken || '',
  hasAccessToken: Boolean(stored.accessToken),
  hasAppSecret: Boolean(stored.appSecret),
  updatedAt: stored.updatedAt || null, lastTestedAt: stored.lastTestedAt || null
} : {
  configured: false, enabled: false, phoneNumberId: '', businessAccountId: '', apiVersion: DEFAULT_VERSION,
  verified: false, displayPhone: '', verifiedName: '', webhookUrl: '', verifyToken: '', hasAccessToken: false, hasAppSecret: false, updatedAt: null, lastTestedAt: null
};

export async function getCloudSettings(accountId, origin = '') {
  return publicSettings(await getCloudDocument(accountId), origin);
}

export async function saveCloudSettings(accountId, input, origin = '') {
  const previous = await getCloudDocument(accountId);
  const phoneNumberId = clean(input.phoneNumberId);
  const businessAccountId = clean(input.businessAccountId);
  const apiVersion = clean(input.apiVersion) || DEFAULT_VERSION;
  if (!/^\d+$/.test(phoneNumberId)) throw new Error('Phone Number ID غير صحيح');
  if (businessAccountId && !/^\d+$/.test(businessAccountId)) throw new Error('WhatsApp Business Account ID غير صحيح');
  if (!/^v\d+\.\d+$/.test(apiVersion)) throw new Error('إصدار Graph API غير صحيح، مثال: v25.0');
  const accessToken = clean(input.accessToken);
  const appSecret = clean(input.appSecret);
  if (!accessToken && !previous?.accessToken) throw new Error('أدخل Access Token');
  const stored = {
    accountId, phoneNumberId, businessAccountId, apiVersion, enabled: input.enabled !== false,
    accessToken: accessToken ? encrypt(accessToken) : previous.accessToken,
    appSecret: appSecret ? encrypt(appSecret) : previous?.appSecret || '',
    verifyToken: previous?.verifyToken || crypto.randomBytes(24).toString('base64url'),
    displayPhone: previous?.displayPhone || '', verifiedName: previous?.verifiedName || '',
    lastTestedAt: !accessToken && previous?.phoneNumberId === phoneNumberId && previous?.apiVersion === apiVersion ? previous?.lastTestedAt || null : null,
    updatedAt: new Date().toISOString()
  };
  await saveCloudDocument(accountId, stored);
  return publicSettings(stored, origin);
}

async function privateSettings(accountId) {
  const stored = await getCloudDocument(accountId);
  if (!stored?.accessToken || !stored.phoneNumberId) throw new Error('اتصال WhatsApp Cloud API غير مكتمل');
  return { ...stored, accessToken: decrypt(stored.accessToken), appSecret: stored.appSecret ? decrypt(stored.appSecret) : '' };
}

async function graphRequest(settings, path, options = {}) {
  const response = await fetch(`https://graph.facebook.com/${settings.apiVersion || DEFAULT_VERSION}/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${settings.accessToken}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Meta API error (${response.status})`);
  return data;
}

export async function testCloudConnection(accountId, origin = '') {
  const settings = await privateSettings(accountId);
  const data = await graphRequest(settings, `${settings.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
  let appSubscribed = null;
  if (settings.businessAccountId) {
    const subscription = await graphRequest(settings, `${settings.businessAccountId}/subscribed_apps`, { method: 'POST', body: '{}' });
    appSubscribed = subscription.success === true;
    recordDiagnostic(accountId, 'app_subscription_checked', { success: appSubscribed });
  }
  const stored = await getCloudDocument(accountId);
  const updated = { ...stored, displayPhone: data.display_phone_number || '', verifiedName: data.verified_name || '', lastTestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await saveCloudDocument(accountId, updated);
  return { ...publicSettings(updated, origin), qualityRating: data.quality_rating || null, appSubscribed };
}

export function getCloudDiagnostics(accountId) {
  return diagnosticEvents.get(accountId) || [];
}

function textFallback(reply) {
  return [reply.text, ...(reply.buttons || []).map((button, index) => `${index + 1}- ${button.label}`)].filter(Boolean).join('\n');
}

async function sendCloudPayload(settings, to, payload) {
  return graphRequest(settings, `${settings.phoneNumberId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload })
  });
}

export async function sendCloudReply(accountId, to, reply) {
  const settings = await privateSettings(accountId);
  if (typeof reply === 'string') return sendCloudPayload(settings, to, { type: 'text', text: { body: reply, preview_url: false } });
  const buttons = (reply?.buttons || []).filter((button) => button.label).slice(0, 10);
  if (reply?.type !== 'buttons' || !buttons.length) return null;
  if (buttons.length <= 3) {
    return sendCloudPayload(settings, to, {
      type: 'interactive', interactive: {
        type: 'button', body: { text: reply.text || 'اختر أحد الخيارات' },
        action: { buttons: buttons.map((button, index) => ({ type: 'reply', reply: { id: clean(button.id || button.label || index).slice(0, 256), title: clean(button.label).slice(0, 20) } })) }
      }
    });
  }
  return sendCloudPayload(settings, to, {
    type: 'interactive', interactive: {
      type: 'list', body: { text: reply.text || 'اختر أحد الخيارات' },
      action: { button: 'عرض الخيارات', sections: [{ title: 'الخيارات', rows: buttons.map((button, index) => ({ id: clean(button.id || button.label || index).slice(0, 200), title: clean(button.label).slice(0, 24) })) }] }
    }
  }).catch(() => sendCloudPayload(settings, to, { type: 'text', text: { body: textFallback(reply), preview_url: false } }));
}

export async function verifyCloudWebhook(accountId, mode, token, challenge) {
  const stored = await getCloudDocument(accountId);
  const actual = Buffer.from(clean(token));
  const expected = Buffer.from(stored?.verifyToken || '');
  return mode === 'subscribe' && expected.length > 0 && actual.length === expected.length && crypto.timingSafeEqual(actual, expected) ? challenge : null;
}

export async function validateCloudSignature(accountId, rawBody, signature) {
  const settings = await privateSettings(accountId);
  if (!settings.appSecret) return true;
  const expected = `sha256=${crypto.createHmac('sha256', settings.appSecret).update(rawBody).digest('hex')}`;
  const actual = clean(signature);
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function incomingText(message) {
  if (message.type === 'text') return message.text?.body || '';
  if (message.type === 'interactive') return message.interactive?.button_reply?.id || message.interactive?.button_reply?.title || message.interactive?.list_reply?.id || message.interactive?.list_reply?.title || '';
  if (message.type === 'button') return message.button?.payload || message.button?.text || '';
  return '';
}

export async function handleCloudWebhook(accountId, payload) {
  recordDiagnostic(accountId, 'webhook_received', { entries: Array.isArray(payload?.entry) ? payload.entry.length : 0 });
  const account = await getAccount(accountId);
  if (!accountAccess(account).allowed) {
    recordDiagnostic(accountId, 'webhook_ignored', { reason: 'account_access' });
    return;
  }
  const settings = await privateSettings(accountId);
  if (!settings.enabled) {
    recordDiagnostic(accountId, 'webhook_ignored', { reason: 'cloud_disabled' });
    return;
  }
  for (const entry of payload.entry || []) for (const change of entry.changes || []) {
    const value = change.value || {};
    if (value.metadata?.phone_number_id && value.metadata.phone_number_id !== settings.phoneNumberId) {
      recordDiagnostic(accountId, 'webhook_ignored', { reason: 'phone_number_id_mismatch' });
      continue;
    }
    for (const message of value.messages || []) {
      const dedupeKey = `${accountId}:${message.id || ''}`;
      const now = Date.now();
      for (const [key, timestamp] of processedMessages) if (now - timestamp > 10 * 60 * 1000) processedMessages.delete(key);
      if (message.id && processedMessages.has(dedupeKey)) continue;
      if (message.id) processedMessages.set(dedupeKey, now);
      const text = incomingText(message).trim();
      if (!text || !message.from) continue;
      recordDiagnostic(accountId, 'message_received', { messageType: message.type || '', from: maskedNumber(message.from), selection: text.slice(0, 80) });
      try {
        const contact = (value.contacts || []).find((item) => item.wa_id === message.from);
        const replies = await processMessage(accountId, `cloud-${message.from}`, text, contact?.profile?.name || '');
        recordDiagnostic(accountId, 'bot_replies_ready', { count: replies.length, to: maskedNumber(message.from) });
        for (const reply of replies) if (reply) {
          await sendCloudReply(accountId, message.from, reply);
          recordDiagnostic(accountId, 'reply_sent', { replyType: typeof reply === 'string' ? 'text' : reply.type || 'unknown', to: maskedNumber(message.from) });
        }
      } catch (error) {
        recordDiagnostic(accountId, 'message_processing_failed', { error: String(error?.message || error).slice(0, 240), from: maskedNumber(message.from) });
        throw error;
      }
    }
  }
}
