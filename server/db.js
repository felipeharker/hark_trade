// Storage: Postgres when DATABASE_URL is set, otherwise a JSON file for local play.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

export async function openStore() {
  if (process.env.DATABASE_URL) return pgStore(process.env.DATABASE_URL);
  return fileStore();
}

async function pgStore(url) {
  const { default: pg } = await import('pg');
  const local = /localhost|127\.0\.0\.1/.test(url) || !url.includes('.');
  const pool = new pg.Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 4 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS world (
      id INTEGER PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS world_backups (
      id SERIAL PRIMARY KEY,
      state JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return {
    kind: 'postgres',
    async loadWorld() {
      const r = await pool.query('SELECT state FROM world WHERE id = 1');
      return r.rows[0]?.state || null;
    },
    async saveWorld(state) {
      await pool.query(
        'INSERT INTO world (id, state, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET state = $1, updated_at = now()',
        [JSON.stringify(state)],
      );
    },
    async backupWorld(state) {
      await pool.query('INSERT INTO world_backups (state) VALUES ($1)', [JSON.stringify(state)]);
      await pool.query('DELETE FROM world_backups WHERE id NOT IN (SELECT id FROM world_backups ORDER BY id DESC LIMIT 14)');
    },
    async findUser(username) {
      const r = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
      return r.rows[0] || null;
    },
    async userById(id) {
      const r = await pool.query('SELECT id, username, is_admin FROM users WHERE id = $1', [id]);
      return r.rows[0] || null;
    },
    async createUser(username, passHash) {
      const c = await pool.query('SELECT count(*)::int AS n FROM users');
      const r = await pool.query('INSERT INTO users (username, pass_hash, is_admin) VALUES ($1, $2, $3) RETURNING id, username, is_admin', [username, passHash, c.rows[0].n === 0]);
      return r.rows[0];
    },
    async setPassword(id, passHash) {
      await pool.query('UPDATE users SET pass_hash = $2 WHERE id = $1', [id, passHash]);
    },
    async listUsers() {
      const r = await pool.query('SELECT id, username, is_admin, created_at FROM users ORDER BY id');
      return r.rows;
    },
    async secret() {
      const r = await pool.query('SELECT value FROM meta WHERE key = $1', ['session_secret']);
      if (r.rows[0]) return r.rows[0].value;
      const v = crypto.randomBytes(32).toString('hex');
      await pool.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING', ['session_secret', v]);
      return (await pool.query('SELECT value FROM meta WHERE key = $1', ['session_secret'])).rows[0].value;
    },
  };
}

function fileStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = (n) => path.join(DATA_DIR, n);
  const read = (n, d) => { try { return JSON.parse(fs.readFileSync(f(n), 'utf8')); } catch { return d; } };
  const write = (n, v) => { fs.writeFileSync(f(n) + '.tmp', JSON.stringify(v)); fs.renameSync(f(n) + '.tmp', f(n)); };
  return {
    kind: 'file',
    async loadWorld() { return read('world.json', null); },
    async saveWorld(s) { write('world.json', s); },
    async backupWorld(s) { write('world.backup.json', s); },
    async findUser(u) { return read('users.json', []).find((x) => x.username.toLowerCase() === u.toLowerCase()) || null; },
    async userById(id) { const u = read('users.json', []).find((x) => x.id === id); return u ? { id: u.id, username: u.username, is_admin: u.is_admin } : null; },
    async createUser(username, pass_hash) {
      const users = read('users.json', []);
      const u = { id: users.length + 1, username, pass_hash, is_admin: users.length === 0 };
      users.push(u); write('users.json', users);
      return { id: u.id, username, is_admin: u.is_admin };
    },
    async setPassword(id, pass_hash) { const users = read('users.json', []); const u = users.find((x) => x.id === id); if (u) u.pass_hash = pass_hash; write('users.json', users); },
    async listUsers() { return read('users.json', []).map(({ pass_hash, ...u }) => u); },
    async secret() { let m = read('meta.json', {}); if (!m.secret) { m.secret = crypto.randomBytes(32).toString('hex'); write('meta.json', m); } return m.secret; },
  };
}
