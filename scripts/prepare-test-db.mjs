// Crea (si falta) la base de pruebas `<DB>_test` y le aplica las migraciones.
// Nunca toca la base de desarrollo.
import 'dotenv/config';
import { execSync } from 'node:child_process';
import pg from 'pg';

const dev = new URL(process.env.DATABASE_URL);
const testDb = `${dev.pathname.slice(1)}_test`;
const admin = new URL(dev);
admin.pathname = '/postgres';
const test = new URL(dev);
test.pathname = `/${testDb}`;

const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDb]);
if (!rowCount) await client.query(`CREATE DATABASE "${testDb}"`);
await client.end();

execSync('pnpm exec prisma migrate deploy', {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: test.toString() },
});
