import pg from 'pg';

const { Pool } = pg;
export const databaseEnabled = Boolean(process.env.DATABASE_URL);
export const pool = databaseEnabled ? new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_SIZE || 10) }) : null;

if (pool) pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error', error));

export async function initDatabase() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_sessions (
    token_hash TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS app_sessions_expires_idx ON app_sessions (expires_at)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tenant_documents (
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, kind)
  )`);
}

export async function cleanExpiredDatabaseSessions() {
  if (pool) await pool.query('DELETE FROM app_sessions WHERE expires_at <= NOW()');
}
