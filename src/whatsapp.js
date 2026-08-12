import fs from 'node:fs/promises';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, { DisconnectReason, generateWAMessageFromContent, proto, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { accountAccess, authDirFor, getAccount } from './store.js';
import { processMessage } from './conversation.js';

const clients = new Map();
const blankStatus = () => ({ state: 'disconnected', qr: null, phone: null, error: null, lastMessageAt: null, lastReplyAt: null });
function clientFor(accountId) {
  if (!clients.has(accountId)) clients.set(accountId, { socket: null, starting: false, reconnectTimer: null, status: blankStatus() });
  return clients.get(accountId);
}
function update(accountId, patch) { const client = clientFor(accountId); client.status = { ...client.status, ...patch }; }

export const getWhatsAppStatus = (accountId) => clientFor(accountId).status;

function unwrapMessage(content) {
  let current = content;
  for (let index = 0; index < 5 && current; index += 1) {
    const wrapped = current.ephemeralMessage?.message || current.viewOnceMessage?.message || current.viewOnceMessageV2?.message || current.viewOnceMessageV2Extension?.message || current.documentWithCaptionMessage?.message || current.editedMessage?.message;
    if (!wrapped) break;
    current = wrapped;
  }
  return current || {};
}
function getText(content) {
  const message = unwrapMessage(content);
  let nativeReply = '';
  try {
    const params = JSON.parse(message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || '{}');
    nativeReply = params.id || params.selected_id || params.title || '';
  } catch {}
  return (message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.videoMessage?.caption || message.documentMessage?.caption || message.buttonsResponseMessage?.selectedButtonId || message.buttonsResponseMessage?.selectedDisplayText || message.listResponseMessage?.singleSelectReply?.selectedRowId || message.listResponseMessage?.title || message.templateButtonReplyMessage?.selectedId || message.templateButtonReplyMessage?.selectedDisplayText || nativeReply || '').trim();
}

const fallbackButtonText = (reply) => [reply.text, ...(reply.buttons || []).map((button, index) => `${index + 1}- ${button.label}`)].filter(Boolean).join('\n');

function interactiveRelayNodes() {
  return [
    { tag: 'bot', attrs: { biz_bot: '1' } },
    {
      tag: 'biz',
      attrs: {
        actual_actors: '2',
        host_storage: '2',
        privacy_mode_ts: String(Math.floor(Date.now() / 1000) - 77980457)
      },
      content: [
        {
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
        },
        { tag: 'quality_control', attrs: { source_type: 'third_party' } }
      ]
    }
  ];
}

async function sendBotReply(socket, jid, reply) {
  if (typeof reply === 'string') return socket.sendMessage(jid, { text: reply });
  if (reply?.type !== 'buttons' || !reply.buttons?.length) return;
  const buttons = reply.buttons.filter((button) => button.label).slice(0, 10);
  try {
    const nativeButtons = buttons.length <= 3
      ? buttons.map((button) => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: String(button.label).slice(0, 20), id: button.id || button.label }) }))
      : [{ name: 'single_select', buttonParamsJson: JSON.stringify({ title: 'عرض الخيارات', sections: [{ title: 'اختر أحد الخيارات', rows: buttons.map((button) => ({ id: button.id || button.label, title: String(button.label).slice(0, 24), description: '' })) }] }) }];
    // Native-flow messages must be relayed directly as an interactiveMessage.
    // Wrapping this payload in viewOnce is silently discarded by newer clients.
    const interactiveMessage = proto.Message.InteractiveMessage.create({
      header: proto.Message.InteractiveMessage.Header.create({
        title: '', subtitle: '', hasMediaAttachment: false
      }),
      body: proto.Message.InteractiveMessage.Body.create({
        text: reply.text || 'اختر أحد الخيارات'
      }),
      footer: proto.Message.InteractiveMessage.Footer.create({
        text: 'اضغط على أحد الخيارات'
      }),
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
        buttons: nativeButtons.map((button) =>
          proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton.create(button)
        ),
        messageParamsJson: '{}',
        messageVersion: 1
      })
    });
    const outgoing = generateWAMessageFromContent(jid, { interactiveMessage }, { userJid: socket.user?.id });
    return socket.relayMessage(jid, outgoing.message, {
      messageId: outgoing.key.id,
      additionalNodes: interactiveRelayNodes()
    });
  } catch (error) {
    console.error('Interactive buttons failed, using text fallback', error);
    return socket.sendMessage(jid, { text: fallbackButtonText(reply) });
  }
}

export async function startWhatsApp(accountId) {
  const client = clientFor(accountId);
  const account = await getAccount(accountId);
  if (!accountAccess(account).allowed) { update(accountId, { state: 'expired', qr: null, error: 'انتهت صلاحية الحساب' }); return; }
  if (process.env.MODE !== 'whatsapp') { update(accountId, { state: 'demo', qr: null, error: null }); return; }
  if (client.socket || client.starting) return;
  client.starting = true;
  clearTimeout(client.reconnectTimer);
  update(accountId, { state: 'connecting', error: null });
  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDirFor(accountId));
    const socket = makeWASocket({ auth: state, logger: pino({ level: process.env.LOG_LEVEL || 'silent' }), printQRInTerminal: false, browser: ['لوحة البوت', 'Chrome', '1.0.0'], markOnlineOnConnect: false });
    client.socket = socket;
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) update(accountId, { state: 'qr', qr: await QRCode.toDataURL(qr), error: null });
      if (connection === 'open') update(accountId, { state: 'connected', qr: null, phone: socket.user?.id?.split(':')[0] || null, error: null });
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        client.socket = null;
        update(accountId, { state: 'disconnected', qr: null, phone: null, error: code ? `رمز الخطأ: ${code}` : null });
        if (code !== DisconnectReason.loggedOut) client.reconnectTimer = setTimeout(() => startWhatsApp(accountId), 5000);
      }
    });
    socket.ev.on('messages.upsert', async ({ messages }) => {
      if (!accountAccess(await getAccount(accountId)).allowed) { await stopWhatsApp(accountId); return; }
      for (const message of messages) {
        const jid = message.key.remoteJidAlt || message.key.remoteJid;
        if (message.key.fromMe || !message.message || !jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;
        const text = getText(message.message);
        if (!text) continue;
        update(accountId, { lastMessageAt: new Date().toISOString(), error: null });
        try {
          const replies = await processMessage(accountId, jid, text, message.pushName || '');
          for (const reply of replies) if (reply) await sendBotReply(socket, jid, reply);
          if (replies.some(Boolean)) update(accountId, { lastReplyAt: new Date().toISOString() });
        } catch (error) { console.error('Failed to process WhatsApp message', error); update(accountId, { error: `تعذر الرد: ${error.message}` }); }
      }
    });
  } catch (error) {
    client.socket = null; update(accountId, { state: 'error', error: error.message });
    client.reconnectTimer = setTimeout(() => startWhatsApp(accountId), 5000);
  } finally { client.starting = false; }
}

export async function logoutWhatsApp(accountId) {
  const client = clientFor(accountId);
  clearTimeout(client.reconnectTimer);
  if (client.socket) { try { await client.socket.logout(); } catch {} client.socket = null; }
  await fs.rm(authDirFor(accountId), { recursive: true, force: true });
  update(accountId, blankStatus());
  if (process.env.MODE === 'whatsapp') await startWhatsApp(accountId);
}

export async function stopWhatsApp(accountId) {
  const client = clientFor(accountId); clearTimeout(client.reconnectTimer);
  if (client.socket) { try { client.socket.end(undefined); } catch {} client.socket = null; }
  update(accountId, { state: 'expired', qr: null, phone: null, error: 'الحساب غير مفعّل' });
}
