// Small helpers shared by the Latch API. No Node APIs: Workers only.

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Keeper-Token',
  'Access-Control-Max-Age': '86400'
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({}, CORS, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
  });
}

export function hex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function randomHex(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

export async function sha256Hex(value) {
  const data = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return hex(new Uint8Array(digest));
}

// Compare through SHA-256 so neither the value nor its length leaks timing.
export async function secretsMatch(given, expected) {
  if (!given || !expected) return false;
  const a = await sha256Hex(given);
  const b = await sha256Hex(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bearer(request) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch (err) {
    return {};
  }
}

// A D1 counter per bucket: b returns true while the caller is under the limit.
export async function underLimit(env, bucket, limit, windowSeconds) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT hits, expires_at AS expiresAt FROM rate_limits WHERE bucket = ?')
    .bind(bucket)
    .first();
  if (!row || row.expiresAt <= now) {
    await env.DB.prepare(
      'INSERT INTO rate_limits (bucket, hits, expires_at) VALUES (?, 1, ?) ' +
      'ON CONFLICT(bucket) DO UPDATE SET hits = 1, expires_at = ?'
    ).bind(bucket, now + windowSeconds * 1000, now + windowSeconds * 1000).run();
    return true;
  }
  if (row.hits >= limit) return false;
  await env.DB.prepare('UPDATE rate_limits SET hits = hits + 1 WHERE bucket = ?').bind(bucket).run();
  return true;
}

// Sessions hold only the hash of the token, never the token itself.
export async function sessionRole(env, token) {
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT role, expires_at AS expiresAt FROM sessions WHERE token_hash = ?')
    .bind(hash)
    .first();
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    return null;
  }
  return row.role;
}

export function number(value) {
  return typeof value === 'number' && isFinite(value) && value >= 0 ? value : 0;
}

export function flag(value) {
  return value === true || value === 1 || value === '1' ? 1 : 0;
}
