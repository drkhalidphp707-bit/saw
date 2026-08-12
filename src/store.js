import fs from 'node:fs/promises';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || './data');
const tenantsDir = path.join(dataDir, 'tenants');
const accountsFile = path.join(dataDir, 'accounts.json');
const appSessionsFile = path.join(dataDir, 'app-sessions.json');

export const defaultConfig = {
  botName: 'المساعد الآلي', enabled: true,
  welcomeText: 'أهلاً وسهلاً بك 🌟\nيرجى اختيار محافظتك:',
  completionText: 'تم تسجيل معلوماتك بنجاح ✅\nسنتواصل معك قريباً.',
  fallbackText: 'عذراً، الاختيار غير صحيح. يرجى المحاولة مرة أخرى.',
  steps: [
    { id: 'province', type: 'choice', question: 'من أي محافظة؟\n1- بغداد\n2- الأنبار', field: 'المحافظة', options: [
      { label: 'بغداد', aliases: ['1', 'بغداد'] },
      { label: 'الأنبار', aliases: ['2', 'الانبار', 'الأنبار', 'انبار'] }
    ]},
    { id: 'phone', type: 'phone', question: 'يرجى كتابة رقم الهاتف:', field: 'رقم الهاتف' }
  ],
  botFlow: null, botFlowDraft: null
};

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') console.error(`Failed to read ${file}`, error);
    return structuredClone(fallback);
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}

const tenantFiles = (accountId) => {
  if (!/^[a-zA-Z0-9-]+$/.test(String(accountId))) throw new Error('Invalid account id');
  const dir = path.join(tenantsDir, String(accountId));
  return {
    dir, config: path.join(dir, 'config.json'), customers: path.join(dir, 'customers.json'),
    sessions: path.join(dir, 'sessions.json'), auth: path.join(dir, 'whatsapp-auth')
  };
};

export async function initStore() {
  await fs.mkdir(tenantsDir, { recursive: true });
  for (const [file, fallback] of [[accountsFile, []], [appSessionsFile, {}]]) {
    try { await fs.access(file); } catch { await writeJson(file, fallback); }
  }
}

export async function initTenant(accountId) {
  const files = tenantFiles(accountId);
  for (const [file, fallback] of [[files.config, defaultConfig], [files.customers, []], [files.sessions, {}]]) {
    try { await fs.access(file); } catch { await writeJson(file, fallback); }
  }
}

export const getAccounts = () => readJson(accountsFile, []);
export const saveAccounts = (items) => writeJson(accountsFile, items);
export async function getAccount(accountId) { return (await getAccounts()).find((item) => item.id === accountId) || null; }
export async function updateAccount(accountId, patch) {
  const accounts = await getAccounts();
  const index = accounts.findIndex((item) => item.id === accountId);
  if (index < 0) return null;
  accounts[index] = { ...accounts[index], ...patch, updatedAt: new Date().toISOString() };
  await saveAccounts(accounts);
  return accounts[index];
}

export const getAppSessions = () => readJson(appSessionsFile, {});
export const saveAppSessions = (items) => writeJson(appSessionsFile, items);
export const getConfig = (accountId) => readJson(tenantFiles(accountId).config, defaultConfig);
export const saveConfig = (accountId, config) => writeJson(tenantFiles(accountId).config, config);
export const getCustomers = (accountId) => readJson(tenantFiles(accountId).customers, []);
export const saveCustomers = (accountId, items) => writeJson(tenantFiles(accountId).customers, items);
export const getSessions = (accountId) => readJson(tenantFiles(accountId).sessions, {});
export const saveSessions = (accountId, items) => writeJson(tenantFiles(accountId).sessions, items);
export const authDirFor = (accountId) => tenantFiles(accountId).auth;
export const resetAllSessions = (accountId) => saveSessions(accountId, {});

export function accountAccess(account) {
  if (!account) return { allowed: false, state: 'missing', daysLeft: 0 };
  if (account.status === 'active') return { allowed: true, state: 'active', daysLeft: null };
  if (account.status === 'suspended') return { allowed: false, state: 'suspended', daysLeft: 0 };
  const remaining = new Date(account.trialEndsAt).getTime() - Date.now();
  return { allowed: remaining > 0, state: remaining > 0 ? 'trial' : 'expired', daysLeft: Math.max(0, Math.ceil(remaining / 86400000)) };
}
