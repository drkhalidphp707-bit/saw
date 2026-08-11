import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, getCustomers, initStore, resetAllSessions, saveConfig } from './store.js';
import { processMessage } from './conversation.js';
import { getWhatsAppStatus, logoutWhatsApp, startWhatsApp } from './whatsapp.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await initStore();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(root, 'public')));

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] === expected) return next();
  res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/status', requireAdmin, (_req, res) => res.json({ ...getWhatsAppStatus(), mode: process.env.MODE || 'demo' }));
app.get('/api/config', requireAdmin, async (_req, res) => res.json(await getConfig()));
app.put('/api/config', requireAdmin, async (req, res) => {
  const config = req.body;
  if (!config || !Array.isArray(config.steps) || !config.steps.length) return res.status(400).json({ error: 'يجب إضافة خطوة واحدة على الأقل' });
  await saveConfig(config);
  await resetAllSessions();
  res.json({ ok: true, config });
});
app.get('/api/customers', requireAdmin, async (_req, res) => res.json(await getCustomers()));
app.post('/api/simulate', requireAdmin, async (req, res) => {
  const { sender = '964700000000@s.whatsapp.net', text = '', name = 'زبون تجريبي' } = req.body || {};
  res.json({ replies: await processMessage(`demo-${sender}`, text, name) });
});
app.post('/api/logout', requireAdmin, async (_req, res) => {
  await logoutWhatsApp();
  res.json({ ok: true });
});
app.get(/.*/, (_req, res) => res.sendFile(path.join(root, 'public', 'index.html')));

app.listen(port, '0.0.0.0', () => {
  console.log(`Dashboard running on port ${port}`);
  startWhatsApp();
});
