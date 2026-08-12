import fs from 'node:fs/promises';
import path from 'node:path';

const dataDir = path.resolve(
  process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || './data'
);
const files = {
  config: path.join(dataDir, 'config.json'),
  customers: path.join(dataDir, 'customers.json'),
  sessions: path.join(dataDir, 'sessions.json')
};

const defaultConfig = {
  botName: 'المساعد الآلي',
  enabled: true,
  welcomeText: 'أهلاً وسهلاً بك 🌟\nيرجى اختيار محافظتك:',
  completionText: 'تم تسجيل معلوماتك بنجاح ✅\nسنتواصل معك قريباً.',
  fallbackText: 'عذراً، الاختيار غير صحيح. يرجى المحاولة مرة أخرى.',
  steps: [
    {
      id: 'province',
      type: 'choice',
      question: 'من أي محافظة؟\n1- بغداد\n2- الأنبار',
      field: 'المحافظة',
      options: [
        { label: 'بغداد', aliases: ['1', 'بغداد'] },
        { label: 'الأنبار', aliases: ['2', 'الانبار', 'الأنبار', 'انبار'] }
      ]
    },
    {
      id: 'phone',
      type: 'phone',
      question: 'يرجى كتابة رقم الهاتف:',
      field: 'رقم الهاتف'
    }
  ],
  botFlow: null,
  botFlowDraft: null
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Failed to read ${file}`, error);
    return structuredClone(fallback);
  }
}

async function writeJson(file, value) {
  await fs.mkdir(dataDir, { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}

export async function initStore() {
  await fs.mkdir(dataDir, { recursive: true });
  for (const [key, fallback] of [['config', defaultConfig], ['customers', []], ['sessions', {}]]) {
    try { await fs.access(files[key]); } catch { await writeJson(files[key], fallback); }
  }
}

export const getConfig = () => readJson(files.config, defaultConfig);
export const saveConfig = (config) => writeJson(files.config, config);
export const getCustomers = () => readJson(files.customers, []);
export const saveCustomers = (items) => writeJson(files.customers, items);
export const getSessions = () => readJson(files.sessions, {});
export const saveSessions = (items) => writeJson(files.sessions, items);
export const authDir = path.join(dataDir, 'whatsapp-auth');

export async function resetAllSessions() {
  await saveSessions({});
}
