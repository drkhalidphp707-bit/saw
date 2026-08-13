import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, destroySession, hashPassword, readSession, verifyPassword } from './auth.js';
import {
  accountAccess, accountIdentityExists, createAccount, findAccountByIdentity, getAccount, getAccounts, getConfig, getCustomers, initStore, initTenant,
  resetAllSessions, saveConfig, updateAccount
} from './store.js';
import { processMessage } from './conversation.js';
import { getWhatsAppStatus, logoutWhatsApp, startWhatsApp, stopWhatsApp } from './whatsapp.js';
import {
  getCloudDiagnostics, getCloudSettings, handleCloudWebhook, saveCloudSettings, testCloudConnection,
  validateCloudSignature, verifyCloudWebhook
} from './cloud-api.js';

const app = express();
app.set('trust proxy', 1);
const port = Number(process.env.PORT || 3000);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const authAttempts = new Map();

await initStore();
app.use(express.json({ limit: '1mb', verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
app.use(express.static(path.join(root, 'public')));

const publicAccount = (account) => {
  const { passwordHash: _passwordHash, ...safe } = account;
  return { ...safe, access: accountAccess(account) };
};
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizeUsername = (value) => String(value || '').trim().toLowerCase();
const limited = (req, key, max = 12) => {
  const id = `${key}:${req.ip}`;
  const now = Date.now();
  const attempts = (authAttempts.get(id) || []).filter((time) => now - time < 15 * 60 * 1000);
  attempts.push(now); authAttempts.set(id, attempts);
  return attempts.length > max;
};

async function requireUser(req, res, next) {
  const session = await readSession(req);
  if (!session?.accountId) return res.status(401).json({ error: 'يرجى تسجيل الدخول أولاً' });
  const account = await getAccount(session.accountId);
  if (!account) return res.status(401).json({ error: 'الحساب غير موجود' });
  req.account = account;
  next();
}
function requireAccess(req, res, next) {
  const access = accountAccess(req.account);
  if (!access.allowed) return res.status(403).json({ error: access.state === 'expired' ? 'انتهت تجربتك المجانية. تواصل مع الإدارة لتفعيل الحساب.' : 'الحساب غير مفعّل. تواصل مع الإدارة.', code: access.state });
  next();
}
function requireSystemAdmin(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(503).json({ error: 'اضبط ADMIN_PASSWORD في Railway لاستخدام لوحة الإدارة' });
  if (req.headers['x-admin-password'] !== expected) return res.status(401).json({ error: 'كلمة مرور الإدارة غير صحيحة' });
  next();
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/meta/webhook/:accountId', async (req, res) => {
  const challenge = await verifyCloudWebhook(req.params.accountId, req.query['hub.mode'], req.query['hub.verify_token'], req.query['hub.challenge']);
  if (challenge == null) return res.sendStatus(403);
  res.status(200).send(String(challenge));
});
app.post('/api/meta/webhook/:accountId', async (req, res) => {
  try {
    if (!(await validateCloudSignature(req.params.accountId, req.rawBody || Buffer.from(''), req.headers['x-hub-signature-256']))) return res.sendStatus(401);
    res.sendStatus(200);
    handleCloudWebhook(req.params.accountId, req.body).catch((error) => console.error('Meta webhook processing failed', error));
  } catch (error) { console.error('Meta webhook rejected', error); res.sendStatus(400); }
});
app.post('/api/auth/signup', async (req, res) => {
  if (limited(req, 'signup', 8)) return res.status(429).json({ error: 'محاولات كثيرة، حاول لاحقاً' });
  const { fullName, username, email, whatsapp, password, confirmPassword } = req.body || {};
  const cleanEmail = normalizeEmail(email), cleanUsername = normalizeUsername(username);
  if (String(fullName || '').trim().length < 3) return res.status(400).json({ error: 'اكتب الاسم الكامل' });
  if (!/^[a-z0-9._-]{3,30}$/.test(cleanUsername)) return res.status(400).json({ error: 'اسم المستخدم يجب أن يكون 3 أحرف إنجليزية على الأقل' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'البريد الإلكتروني غير صحيح' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'تأكيد كلمة المرور غير مطابق' });
  if (await accountIdentityExists(cleanEmail, cleanUsername)) return res.status(409).json({ error: 'البريد أو اسم المستخدم مستخدم مسبقاً' });
  const now = new Date();
  const account = {
    id: crypto.randomUUID(), fullName: String(fullName).trim(), username: cleanUsername, email: cleanEmail,
    whatsapp: String(whatsapp || '').trim(), passwordHash: await hashPassword(password), status: 'trial',
    trialStartedAt: now.toISOString(), trialEndsAt: new Date(now.getTime() + 3 * 86400000).toISOString(), createdAt: now.toISOString()
  };
  try { await createAccount(account); } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'البريد أو اسم المستخدم مستخدم مسبقاً' }); throw error; }
  await initTenant(account.id);
  await createSession(res, { accountId: account.id });
  res.status(201).json({ account: publicAccount(account) });
});
app.post('/api/auth/login', async (req, res) => {
  if (limited(req, 'login', 15)) return res.status(429).json({ error: 'محاولات كثيرة، حاول بعد قليل' });
  const identity = String(req.body?.identity || '').trim().toLowerCase();
  const account = await findAccountByIdentity(identity);
  if (!account || !(await verifyPassword(String(req.body?.password || ''), account.passwordHash))) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  await createSession(res, { accountId: account.id });
  res.json({ account: publicAccount(account) });
});
app.post('/api/auth/logout', async (req, res) => { await destroySession(req, res); res.json({ ok: true }); });
app.get('/api/auth/me', requireUser, (req, res) => res.json({ account: publicAccount(req.account), adminWhatsapp: process.env.ADMIN_WHATSAPP || '' }));

app.get('/api/status', requireUser, requireAccess, async (req, res) => {
  const cloud = await getCloudSettings(req.account.id);
  if (cloud.enabled && cloud.configured) return res.json({ state: cloud.verified ? 'connected' : 'error', phone: cloud.displayPhone, error: cloud.verified ? null : 'احفظ البيانات واضغط اختبار الاتصال', mode: 'cloud', provider: 'cloud' });
  await startWhatsApp(req.account.id);
  res.json({ ...getWhatsAppStatus(req.account.id), mode: process.env.MODE || 'demo', provider: 'qr' });
});
app.get('/api/cloud/settings', requireUser, requireAccess, async (req, res) => res.json(await getCloudSettings(req.account.id, `${req.protocol}://${req.get('host')}`)));
app.put('/api/cloud/settings', requireUser, requireAccess, async (req, res) => {
  try {
    const settings = await saveCloudSettings(req.account.id, req.body || {}, `${req.protocol}://${req.get('host')}`);
    if (settings.enabled) await stopWhatsApp(req.account.id);
    res.json(settings);
  }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/cloud/test', requireUser, requireAccess, async (req, res) => {
  try { res.json(await testCloudConnection(req.account.id, `${req.protocol}://${req.get('host')}`)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/cloud/diagnostics', requireUser, requireAccess, (req, res) => res.json({ events: getCloudDiagnostics(req.account.id) }));
app.get('/api/config', requireUser, requireAccess, async (req, res) => res.json(await getConfig(req.account.id)));
app.put('/api/config', requireUser, requireAccess, async (req, res) => {
  const requested = req.body;
  if (!requested || !Array.isArray(requested.steps) || !requested.steps.length) return res.status(400).json({ error: 'يجب إضافة خطوة واحدة على الأقل' });
  const current = await getConfig(req.account.id);
  const config = { ...requested, botFlow: current.botFlow || null, botFlowDraft: current.botFlowDraft || null };
  await saveConfig(req.account.id, config); await resetAllSessions(req.account.id);
  res.json({ ok: true, config });
});
app.get('/api/bot-flow', requireUser, requireAccess, async (req, res) => {
  const config = await getConfig(req.account.id);
  res.json({ draft: config.botFlowDraft || config.botFlow || null, published: config.botFlow || null });
});
app.put('/api/bot-flow', requireUser, requireAccess, async (req, res) => {
  const flow = req.body;
  if (!flow || !Array.isArray(flow.nodes)) return res.status(400).json({ error: 'مخطط البوت غير صالح' });
  const config = await getConfig(req.account.id);
  config.botFlowDraft = { ...flow, updatedAt: new Date().toISOString() };
  await saveConfig(req.account.id, config);
  res.json({ ok: true, flow: config.botFlowDraft });
});
app.post('/api/bot-flow/publish', requireUser, requireAccess, async (req, res) => {
  const flow = req.body;
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const startNodes = nodes.filter((node) => node.type === 'start');
  if (startNodes.length !== 1) return res.status(400).json({ error: 'يجب أن يحتوي المخطط على عقدة بداية واحدة' });
  if (!nodes.some((node) => node.type === 'end')) return res.status(400).json({ error: 'أضف عقدة نهاية قبل النشر' });
  const ids = new Set(nodes.map((node) => node.id));
  const invalidLink = nodes.some((node) => (node.next && !ids.has(node.next)) || (node.options || []).some((option) => option.next && !ids.has(option.next)));
  if (invalidLink) return res.status(400).json({ error: 'يوجد رابط يشير إلى عقدة محذوفة' });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const reachable = new Set(), queue = [startNodes[0].id]; let hasReachableEnd = false;
  while (queue.length) {
    const id = queue.shift(); if (!id || reachable.has(id)) continue;
    reachable.add(id); const node = byId.get(id); if (!node) continue;
    if (node.type === 'end') { hasReachableEnd = true; continue; }
    const links = node.type === 'buttons' ? (node.options || []).map((option) => option.next || node.next) : [node.next];
    if (!links.length || links.some((link) => !link)) return res.status(400).json({ error: `أكمل ربط عقدة: ${node.message || node.type}` });
    queue.push(...links);
  }
  if (!hasReachableEnd) return res.status(400).json({ error: 'يجب أن يصل المسار إلى عقدة نهاية' });
  const config = await getConfig(req.account.id);
  const published = { ...flow, publishedAt: new Date().toISOString() };
  config.botFlow = published; config.botFlowDraft = published;
  await saveConfig(req.account.id, config); await resetAllSessions(req.account.id);
  res.json({ ok: true, flow: published });
});
app.get('/api/customers', requireUser, requireAccess, async (req, res) => res.json(await getCustomers(req.account.id)));
app.post('/api/simulate', requireUser, requireAccess, async (req, res) => {
  const { sender = '964700000000@s.whatsapp.net', text = '', name = 'زبون تجريبي' } = req.body || {};
  res.json({ replies: await processMessage(req.account.id, `demo-${sender}`, text, name) });
});
app.post('/api/logout', requireUser, requireAccess, async (req, res) => { await logoutWhatsApp(req.account.id); res.json({ ok: true }); });

app.get('/api/admin/accounts', requireSystemAdmin, async (_req, res) => res.json((await getAccounts()).map(publicAccount)));
app.patch('/api/admin/accounts/:id', requireSystemAdmin, async (req, res) => {
  const action = req.body?.action;
  let patch;
  if (action === 'activate') patch = { status: 'active', activatedAt: new Date().toISOString() };
  else if (action === 'suspend') patch = { status: 'suspended' };
  else if (action === 'extend') patch = { status: 'trial', trialEndsAt: new Date(Date.now() + Math.max(1, Number(req.body?.days || 3)) * 86400000).toISOString() };
  else return res.status(400).json({ error: 'الإجراء غير صحيح' });
  const account = await updateAccount(req.params.id, patch);
  if (!account) return res.status(404).json({ error: 'الحساب غير موجود' });
  if (!accountAccess(account).allowed) await stopWhatsApp(account.id);
  res.json({ account: publicAccount(account) });
});

app.get(/.*/, (_req, res) => res.sendFile(path.join(root, 'public', 'index.html')));
app.listen(port, '0.0.0.0', () => console.log(`Dashboard running on port ${port}`));
