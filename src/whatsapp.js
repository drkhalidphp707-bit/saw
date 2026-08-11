import fs from 'node:fs/promises';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { authDir } from './store.js';
import { processMessage } from './conversation.js';

let socket;
let reconnectTimer;
let status = { state: 'disconnected', qr: null, phone: null, error: null };
const listeners = new Set();

function update(patch) {
  status = { ...status, ...patch };
  for (const listener of listeners) listener(status);
}

export const getWhatsAppStatus = () => status;
export const onWhatsAppStatus = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };

export async function startWhatsApp() {
  if (process.env.MODE !== 'whatsapp') {
    update({ state: 'demo', qr: null, error: null });
    return;
  }
  if (socket) return;
  clearTimeout(reconnectTimer);
  update({ state: 'connecting', error: null });
  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    socket = makeWASocket({
      auth: state,
      logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
      printQRInTerminal: false,
      browser: ['لوحة البوت', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false
    });
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) update({ state: 'qr', qr: await QRCode.toDataURL(qr), error: null });
      if (connection === 'open') {
        update({ state: 'connected', qr: null, phone: socket.user?.id?.split(':')[0] || null, error: null });
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        socket = undefined;
        update({ state: 'disconnected', qr: null, phone: null, error: code ? `رمز الخطأ: ${code}` : null });
        if (code !== DisconnectReason.loggedOut) reconnectTimer = setTimeout(startWhatsApp, 5000);
      }
    });
    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const message of messages) {
        if (message.key.fromMe || !message.message || message.key.remoteJid?.endsWith('@g.us')) continue;
        const text = message.message.conversation || message.message.extendedTextMessage?.text;
        if (!text) continue;
        const replies = await processMessage(message.key.remoteJid, text, message.pushName || '');
        for (const reply of replies) {
          if (reply) await socket.sendMessage(message.key.remoteJid, { text: reply });
        }
      }
    });
  } catch (error) {
    socket = undefined;
    update({ state: 'error', error: error.message });
    reconnectTimer = setTimeout(startWhatsApp, 5000);
  }
}

export async function logoutWhatsApp() {
  clearTimeout(reconnectTimer);
  if (socket) {
    try { await socket.logout(); } catch {}
    socket = undefined;
  }
  await fs.rm(authDir, { recursive: true, force: true });
  update({ state: 'disconnected', qr: null, phone: null, error: null });
  if (process.env.MODE === 'whatsapp') await startWhatsApp();
}
