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
  if (!expected) {
    if (process.env.MODE !== 'whatsapp') return next();
    return res.status(503).json({ error: 'يجب ضبط ADMIN_PASSWORD في متغيرات Railway لحماية لوحة الإدارة' });
  }
  if (req.headers['x-admin-password'] === expected) return next();
  res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/status', requireAdmin, (_req, res) => res.json({ ...getWhatsAppStatus(), mode: process.env.MODE || 'demo' }));
app.get('/api/config', requireAdmin, async (_req, res) => res.json(await getConfig()));
app.put('/api/config', requireAdmin, async (req, res) => {
  const requested = req.body;
  if (!requested || !Array.isArray(requested.steps) || !requested.steps.length) return res.status(400).json({ error: 'يجب إضافة خطوة واحدة على الأقل' });
  const current = await getConfig();
  const config = { ...requested, botFlow: current.botFlow || null, botFlowDraft: current.botFlowDraft || null };
  await saveConfig(config);
  await resetAllSessions();
  res.json({ ok: true, config });
});
app.get('/api/bot-flow', requireAdmin, async (_req, res) => {
  const config = await getConfig();
  res.json({
    draft: config.botFlowDraft || config.botFlow || null,
    published: config.botFlow || null
  });
});
app.put('/api/bot-flow', requireAdmin, async (req, res) => {
  const flow = req.body;
  if (!flow || !Array.isArray(flow.nodes)) return res.status(400).json({ error: 'مخطط البوت غير صالح' });
  const config = await getConfig();
  config.botFlowDraft = { ...flow, updatedAt: new Date().toISOString() };
  await saveConfig(config);
  res.json({ ok: true, flow: config.botFlowDraft });
});
app.post('/api/bot-flow/publish', requireAdmin, async (req, res) => {
  const flow = req.body;
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const startNodes = nodes.filter((node) => node.type === 'start');
  if (startNodes.length !== 1) return res.status(400).json({ error: 'يجب أن يحتوي المخطط على عقدة بداية واحدة' });
  if (!nodes.some((node) => node.type === 'end')) return res.status(400).json({ error: 'أضف عقدة نهاية قبل النشر' });
  const ids = new Set(nodes.map((node) => node.id));
  const invalidLink = nodes.some((node) =>
    (node.next && !ids.has(node.next)) || (node.options || []).some((option) => option.next && !ids.has(option.next))
  );
  if (invalidLink) return res.status(400).json({ error: 'يوجد رابط يشير إلى عقدة محذوفة' });
  const start = startNodes[0];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const reachable = new Set();
  const queue = [start.id];
  let hasReachableEnd = false;
  while (queue.length) {
    const id = queue.shift();
    if (!id || reachable.has(id)) continue;
    reachable.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (node.type === 'end') { hasReachableEnd = true; continue; }
    const links = node.type === 'buttons' ? (node.options || []).map((option) => option.next || node.next) : [node.next];
    if (!links.length || links.some((link) => !link)) {
      return res.status(400).json({ error: `أكمل ربط عقدة: ${node.message || node.type}` });
    }
    queue.push(...links);
  }
  if (!hasReachableEnd) return res.status(400).json({ error: 'يجب أن يصل المسار إلى عقدة نهاية' });
  const config = await getConfig();
  const published = { ...flow, publishedAt: new Date().toISOString() };
  config.botFlow = published;
  config.botFlowDraft = published;
  await saveConfig(config);
  await resetAllSessions();
  res.json({ ok: true, flow: published });
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
