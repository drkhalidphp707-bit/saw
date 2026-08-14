import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanExpiredDatabaseSessions, databaseEnabled, initDatabase, pool } from './database.js';

const dataDir = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || './data');
const tenantsDir = path.join(dataDir, 'tenants');
const accountsFile = path.join(dataDir, 'accounts.json');
const appSessionsFile = path.join(dataDir, 'app-sessions.json');

export const defaultConfig = {
  botName: 'المساعد الآلي', enabled: true,
  welcomeText: 'أهلاً وسهلاً بك 🌟\nيرجى اختيار محافظتك:', completionText: 'تم تسجيل معلوماتك بنجاح ✅\nسنتواصل معك قريباً.', fallbackText: 'عذراً، الاختيار غير صحيح. يرجى المحاولة مرة أخرى.',
  steps: [
    { id: 'province', type: 'choice', question: 'من أي محافظة؟\n1- بغداد\n2- الأنبار', field: 'المحافظة', options: [{ label: 'بغداد', aliases: ['1', 'بغداد'] }, { label: 'الأنبار', aliases: ['2', 'الانبار', 'الأنبار', 'انبار'] }] },
    { id: 'phone', type: 'phone', question: 'يرجى كتابة رقم الهاتف:', field: 'رقم الهاتف' }
  ], botFlow: null, botFlowDraft: null
};

async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') console.error(`Failed to read ${file}`, error); return structuredClone(fallback); } }
async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temp, JSON.stringify(value, null, 2)); await fs.rename(temp, file); }
const tenantFiles = (accountId) => { if (!/^[a-zA-Z0-9-]+$/.test(String(accountId))) throw new Error('Invalid account id'); const dir = path.join(tenantsDir, String(accountId)); return { dir, config:path.join(dir,'config.json'), customers:path.join(dir,'customers.json'), sessions:path.join(dir,'sessions.json'), cloud:path.join(dir,'cloud.json'), auth:path.join(dir,'whatsapp-auth') }; };

const getDocument = async (accountId, kind, fallback) => {
  if (!databaseEnabled) return readJson(tenantFiles(accountId)[kind], fallback);
  const result = await pool.query('SELECT data FROM tenant_documents WHERE account_id = $1 AND kind = $2', [accountId, kind]);
  return result.rows[0]?.data ?? structuredClone(fallback);
};
const saveDocument = async (accountId, kind, data) => {
  if (!databaseEnabled) return writeJson(tenantFiles(accountId)[kind], data);
  await pool.query(`INSERT INTO tenant_documents (account_id, kind, data) VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (account_id, kind) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [accountId, kind, JSON.stringify(data)]);
};

async function migrateFilesToDatabase() {
  const count = Number((await pool.query('SELECT COUNT(*) AS count FROM accounts')).rows[0].count);
  if (count) return;
  const oldAccounts = await readJson(accountsFile, []);
  for (const account of oldAccounts) {
    await createAccount(account);
    const files = tenantFiles(account.id);
    await saveDocument(account.id, 'config', await readJson(files.config, defaultConfig));
    await saveDocument(account.id, 'customers', await readJson(files.customers, []));
    await saveDocument(account.id, 'sessions', await readJson(files.sessions, {}));
  }
  const oldSessions = await readJson(appSessionsFile, {});
  for (const [tokenHash, session] of Object.entries(oldSessions)) if (new Date(session.expiresAt).getTime() > Date.now()) await putAppSession(tokenHash, session);
  if (oldAccounts.length) console.log(`Migrated ${oldAccounts.length} accounts to PostgreSQL`);
}

export async function initStore() {
  await fs.mkdir(tenantsDir, { recursive: true });
  if (databaseEnabled) { await initDatabase(); await migrateFilesToDatabase(); await cleanExpiredDatabaseSessions(); return; }
  for (const [file, fallback] of [[accountsFile, []], [appSessionsFile, {}]]) try { await fs.access(file); } catch { await writeJson(file, fallback); }
}
export async function initTenant(accountId) {
  if (databaseEnabled) { await saveDocument(accountId, 'config', defaultConfig); await saveDocument(accountId, 'customers', []); await saveDocument(accountId, 'sessions', {}); return; }
  const files=tenantFiles(accountId); for(const [file,fallback] of [[files.config,defaultConfig],[files.customers,[]],[files.sessions,{}]]) try{await fs.access(file);}catch{await writeJson(file,fallback);}
}

export async function getAccounts() { if (!databaseEnabled) return readJson(accountsFile, []); return (await pool.query('SELECT data FROM accounts ORDER BY created_at DESC')).rows.map((row) => row.data); }
export async function saveAccounts(items) { if (!databaseEnabled) return writeJson(accountsFile, items); for (const item of items) await createAccount(item, true); }
export async function createAccount(account, allowUpdate = false) {
  if (!databaseEnabled) { const items=await getAccounts(); if(items.some(x=>x.id===account.id||x.email===account.email||x.username===account.username)) throw Object.assign(new Error('الحساب موجود مسبقاً'),{code:'23505'}); items.push(account); await saveAccounts(items); return account; }
  const conflict = allowUpdate ? 'ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, username=EXCLUDED.username, data=EXCLUDED.data, updated_at=NOW()' : '';
  await pool.query(`INSERT INTO accounts (id,email,username,data,created_at) VALUES ($1,$2,$3,$4::jsonb,$5) ${conflict}`, [account.id,account.email,account.username,JSON.stringify(account),account.createdAt||new Date().toISOString()]); return account;
}
export async function getAccount(accountId) { if (!databaseEnabled) return (await getAccounts()).find(x=>x.id===accountId)||null; return (await pool.query('SELECT data FROM accounts WHERE id=$1',[accountId])).rows[0]?.data||null; }
export async function findAccountByIdentity(identity) { if (!databaseEnabled) return (await getAccounts()).find(x=>x.email===identity||x.username===identity)||null; return (await pool.query('SELECT data FROM accounts WHERE email=$1 OR username=$1 LIMIT 1',[identity])).rows[0]?.data||null; }
export async function accountIdentityExists(email, username) { if (!databaseEnabled) return (await getAccounts()).some(x=>x.email===email||x.username===username); return Boolean((await pool.query('SELECT 1 FROM accounts WHERE email=$1 OR username=$2 LIMIT 1',[email,username])).rowCount); }
export async function updateAccount(accountId, patch) { const account=await getAccount(accountId); if(!account)return null; const updated={...account,...patch,updatedAt:new Date().toISOString()}; if(!databaseEnabled){const items=await getAccounts();items[items.findIndex(x=>x.id===accountId)]=updated;await saveAccounts(items);}else await pool.query('UPDATE accounts SET email=$2,username=$3,data=$4::jsonb,updated_at=NOW() WHERE id=$1',[accountId,updated.email,updated.username,JSON.stringify(updated)]);return updated; }

export async function putAppSession(tokenHash, session) { if(!databaseEnabled){const sessions=await readJson(appSessionsFile,{});sessions[tokenHash]=session;return writeJson(appSessionsFile,sessions);}await pool.query(`INSERT INTO app_sessions(token_hash,data,expires_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(token_hash) DO UPDATE SET data=EXCLUDED.data,expires_at=EXCLUDED.expires_at`,[tokenHash,JSON.stringify(session),session.expiresAt]); }
export async function getAppSession(tokenHash) { if(!databaseEnabled)return (await readJson(appSessionsFile,{}))[tokenHash]||null;return (await pool.query('SELECT data FROM app_sessions WHERE token_hash=$1 AND expires_at>NOW()',[tokenHash])).rows[0]?.data||null; }
export async function deleteAppSession(tokenHash) { if(!databaseEnabled){const sessions=await readJson(appSessionsFile,{});delete sessions[tokenHash];return writeJson(appSessionsFile,sessions);}await pool.query('DELETE FROM app_sessions WHERE token_hash=$1',[tokenHash]); }

export const getConfig=(id)=>getDocument(id,'config',defaultConfig); export const saveConfig=(id,data)=>saveDocument(id,'config',data);
export const getCustomers=(id)=>getDocument(id,'customers',[]); export const saveCustomers=(id,data)=>saveDocument(id,'customers',data);
export const getSessions=(id)=>getDocument(id,'sessions',{}); export const saveSessions=(id,data)=>saveDocument(id,'sessions',data);
export const getCloudDocument=(id)=>getDocument(id,'cloud',null); export const saveCloudDocument=(id,data)=>saveDocument(id,'cloud',data);
export const getBroadcastHistory=(id)=>getDocument(id,'broadcast',[]); export const saveBroadcastHistory=(id,data)=>saveDocument(id,'broadcast',data);
export const authDirFor=(id)=>tenantFiles(id).auth; export const resetAllSessions=(id)=>saveSessions(id,{});
export function accountAccess(account){if(!account)return{allowed:false,state:'missing',daysLeft:0};if(account.status==='active')return{allowed:true,state:'active',daysLeft:null};if(account.status==='suspended')return{allowed:false,state:'suspended',daysLeft:0};const remaining=new Date(account.trialEndsAt).getTime()-Date.now();return{allowed:remaining>0,state:remaining>0?'trial':'expired',daysLeft:Math.max(0,Math.ceil(remaining/86400000))};}
