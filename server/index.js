import {
  CORS,
  json,
  bearer,
  clientIp,
  flag,
  number,
  randomHex,
  readJson,
  secretsMatch,
  sessionRole,
  sha256Hex,
  underLimit
} from './util.js';

const DAY = 86400;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (!path.startsWith('/api/')) {
      return json({ error: 'nothing here' }, 404);
    }
    if (!env.DB) {
      return json({ error: 'the database is not bound yet' }, 503);
    }

    try {
      return await route(request, env, path);
    } catch (err) {
      // A D1 failure or a bug: answer in JSON so the page can show something.
      return json({ error: 'server error' }, 500);
    }
  }
};

async function route(
request, env, path) {
  const method = request.method;

  if (path === '/api/health' && method === 'GET') {
    return json({ ok: true, at: Date.now() });
  }

  // ------------------------------------------------------------- public reads

  if (path === '/api/status' && method === 'GET') {
    const heartbeat = await env.DB.prepare(
      'SELECT at, price, threshold, armed, paused, running, spent_today AS spentToday, ' +
      'swept_total AS sweptTotal, last_tx AS lastTx, relay, chain_id AS chainId ' +
      'FROM heartbeats ORDER BY at DESC LIMIT 1'
    ).first();
    const beats = await env.DB.prepare(
      'SELECT COUNT(*) AS ticks, COALESCE(MAX(at), 0) AS last FROM heartbeats'
    ).first();
    const waiting = await env.DB.prepare('SELECT COUNT(*) AS n FROM signups').first();
    return json({
      heartbeat: heartbeat || null,
      stats: {
        ticks: beats ? beats.ticks : 0,
        last: beats ? beats.last : 0,
        waiting: waiting ? waiting.n : 0
      }
    });
  }

  if (path === '/api/stats' && method === 'GET') {
    const waiting = await env.DB.prepare('SELECT COUNT(*) AS n FROM signups').first();
    const beats = await env.DB.prepare(
      'SELECT COUNT(*) AS ticks, COALESCE(MAX(at), 0) AS last FROM heartbeats'
    ).first();
    return json({
      waiting: waiting ? waiting.n : 0,
      ticks: beats ? beats.ticks : 0,
      last: beats ? beats.last : 0
    });
  }

  // ---------------------------------------------------------------- waitlist

  if (path === '/api/signups' && method === 'POST') {
    if (!(await underLimit(env, 'signup:' + clientIp(request), 5, DAY))) {
      return json({ error: 'too many sign-ups from this address today' }, 429);
    }
    const body = await readJson(request);
    const email = String(body.email || '').trim().toLowerCase();
    const note = String(body.note || '').trim().slice(0, 280);
    if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
      return json({ error: 'that email does not look right' }, 400);
    }
    try {
      await env.DB.prepare(
        'INSERT INTO signups (id, email, note, created_at) VALUES (?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), email, note, Date.now()).run();
    } catch (err) {
      if (String(err).toLowerCase().includes('unique')) {
        return json({ ok: true, duplicate: true });
      }
      throw err;
    }
    return json({ ok: true, duplicate: false }, 201);
  }

  // ---------------------------------------------------------------- heartbeat

  if (path === '/api/heartbeat' && method === 'POST') {
    if (!env.KEEPER_TOKEN) {
      return json({ error: 'KEEPER_TOKEN is not set on the server' }, 503);
    }
    const given = request.headers.get('X-Keeper-Token') || '';
    if (!(await secretsMatch(given, env.KEEPER_TOKEN))) {
      return json({ error: 'bad keeper token' }, 401);
    }
    if (!(await underLimit(env, 'beat:' + clientIp(request), 480, DAY))) {
      return json({ error: 'too many heartbeats today' }, 429);
    }
    const body = await readJson(request);
    const relay = typeof body.relay === 'string' && /^0x[0-9a-fA-F]{40}$/.test(body.relay)
      ? body.relay
      : null;
    const lastTx = typeof body.lastTx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(body.lastTx)
      ? body.lastTx
      : null;
    const at = Date.now();
    await env.DB.prepare(
      'INSERT INTO heartbeats (id, at, price, threshold, armed, paused, running, spent_today, ' +
      'swept_total, last_tx, relay, chain_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      crypto.randomUUID(),
      at,
      number(body.price),
      number(body.threshold),
      flag(body.armed),
      flag(body.paused),
      flag(body.running),
      number(body.spentToday),
      number(body.sweptTotal),
      lastTx,
      relay,
      Math.trunc(number(body.chainId))
    ).run();
    // Keep the table small without a cron job.
    await env.DB.prepare('DELETE FROM heartbeats WHERE at < ?').bind(at - 60 * DAY * 1000).run();
    return json({ ok: true, at }, 201);
  }

  // -------------------------------------------------------------------- admin

  if (path === '/api/admin/login' && method === 'POST') {
    if (!env.ADMIN_PASSWORD) {
      return json({ error: 'ADMIN_PASSWORD is not set on the server' }, 503);
    }
    const ip = clientIp(request);
    if (!(await underLimit(env, 'login:' + ip, 8, 900))) {
      return json({ error: 'too many attempts, try again in fifteen minutes' }, 429);
    }
    const body = await readJson(request);
    const password = String(body.password || '');
    if (!(await secretsMatch(password, env.ADMIN_PASSWORD))) {
      return json({ error: 'wrong password' }, 401);
    }
    const token = randomHex(32);
    const expiresAt = Date.now() + 12 * 3600 * 1000;
    await env.DB.prepare(
      'INSERT INTO sessions (token_hash, role, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(await sha256Hex(token), 'admin', Date.now(), expiresAt).run();
    return json({ token, expiresAt }, 201);
  }

  if (path === '/api/admin/logout' && method === 'POST') {
    const token = bearer(request);
    if (token) {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
        .bind(await sha256Hex(token))
        .run();
    }
    return json({ ok: true });
  }

  if (path === '/api/admin/signups' && method === 'GET') {
    if ((await sessionRole(env, bearer(request))) !== 'admin') {
      return json({ error: 'sign in first' }, 401);
    }
    const rows = await env.DB.prepare(
      'SELECT id, email, note, created_at AS createdAt FROM signups ORDER BY created_at DESC LIMIT 200'
    ).all();
    return json({ signups: rows.results || [] });
  }

  if (path === '/api/admin/heartbeats' && method === 'GET') {
    if ((await sessionRole(env, bearer(request))) !== 'admin') {
      return json({ error: 'sign in first' }, 401);
    }
    const rows = await env.DB.prepare(
      'SELECT at, price, threshold, armed, paused, running, spent_today AS spentToday, ' +
      'swept_total AS sweptTotal, last_tx AS lastTx, relay, chain_id AS chainId ' +
      'FROM heartbeats ORDER BY at DESC LIMIT 100'
    ).all();
    return json({ heartbeats: rows.results || [] });
  }

  const signupPath = /^\/api\/admin\/signups\/([A-Za-z0-9-]{8,64})$/.exec(path);
  if (signupPath && method === 'DELETE') {
    if ((await sessionRole(env, bearer(request))) !== 'admin') {
      return json({ error: 'sign in first' }, 401);
    }
    await env.DB.prepare('DELETE FROM signups WHERE id = ?').bind(signupPath[1]).run();
    return json({ ok: true });
  }

  return json({ error: 'no such endpoint' }, 404);
}
