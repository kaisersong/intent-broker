import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { chmod } from 'node:fs/promises';

const CREDENTIALS_DIR = join(homedir(), '.intent-broker');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials');

export async function loadCredentials() {
  try {
    const raw = await readFile(CREDENTIALS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveCredentials(credentials) {
  await mkdir(CREDENTIALS_DIR, { recursive: true });
  const content = JSON.stringify(credentials, null, 2) + '\n';
  await writeFile(CREDENTIALS_FILE, content, { mode: 0o600 });
}

export async function deleteCredentials() {
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(CREDENTIALS_FILE);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
}

export function isTokenExpired(credentials) {
  if (!credentials?.jwt) return true;
  try {
    const payload = JSON.parse(
      Buffer.from(credentials.jwt.split('.')[1], 'base64url').toString()
    );
    return Date.now() >= payload.exp * 1000;
  } catch {
    return true;
  }
}

export function getJwtPayload(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  } catch {
    return null;
  }
}
