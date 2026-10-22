// functions/api/submit-form.js
//
// Cloudflare Pages Function — server-side proxy to Form Hub, with
// Turnstile verification, a honeypot check, a render-timestamp check,
// and an optional KV-backed rate limit.
//
// Required env vars (Settings -> Environment Variables, encrypted):
//   FORMHUB_ORIGIN     this website’s Form Hub API origin (Step 2 below)
//   FORMHUB_KEY        this website’s Form Hub API key (Step 2 below)
//   TURNSTILE_SECRET   secret key from the Turnstile widget (Step 1 below)
//
// Optional: bind a KV namespace as RATELIMIT for a per-IP hourly cap (Step 5).

// Low-value signal on its own (client-supplied, spoofable by a bot) — kept short
// so a genuinely fast real submission (e.g. browser autofill) isn’t dropped.
// Turnstile below is the real defense; this just filters the laziest bots cheaply.
const MIN_FILL_SECONDS = 2;
const MAX_PER_HOUR = 20;
const MAX_BODY_BYTES = 20_000;
const CONTROL_FIELDS = new Set(['cf-turnstile-response', 'ts', 'hp_website']);

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  // Cheapest check first, before an API call to Turnstile is wasted on garbage:
  // reject oversized bodies and any nested object/array — a real browser form
  // submit never produces either, so seeing one here means it didn’t come from
  // this form.
  const tooBig = JSON.stringify(body).length > MAX_BODY_BYTES;
  const hasNested = Object.values(body).some((v) => v !== null && typeof v === 'object');
  if (tooBig || hasNested) {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  // Honeypot — real visitors never fill this. Respond 200 so a bot learns nothing.
  if (body.hp_website) {
    return json({ ok: true }, 200);
  }

  // Timing check — rejects submissions faster than a human could fill the form.
  const elapsed = (Date.now() - Number(body.ts || 0)) / 1000;
  if (!body.ts || elapsed < MIN_FILL_SECONDS) {
    return json({ ok: true }, 200);
  }

  // Turnstile verification. Wrapped — a network hiccup here must not crash the
  // request with a raw 500; a visitor should see a normal "something went wrong".
  const ip = request.headers.get('CF-Connecting-IP') || '';
  let outcome;
  try {
    const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: body['cf-turnstile-response'],
        remoteip: ip,
      }),
    });
    outcome = await verify.json();
  } catch {
    return json({ ok: false, error: 'turnstile_unreachable' }, 502);
  }
  if (!outcome.success) {
    return json({ ok: false, error: 'challenge_failed' }, 403);
  }

  // Optional KV rate limit — only runs if a RATELIMIT namespace is bound.
  // KV.put can throw once the free plan’s 1,000 writes/day is used up — fail
  // open here (skip the extra cap) rather than breaking real submissions over
  // an optional, best-effort check Form Hub’s own rate limit already backs up.
  if (env.RATELIMIT && ip) {
    try {
      const key = `ip:${ip}`;
      const count = Number((await env.RATELIMIT.get(key)) || 0);
      if (count >= MAX_PER_HOUR) {
        return json({ ok: false, error: 'rate_limited' }, 429);
      }
      await env.RATELIMIT.put(key, String(count + 1), { expirationTtl: 3600 });
    } catch (err) {
      // Fail open (don’t block real submissions over an optional check) — but
      // this is otherwise invisible, so log it: once KV starts throwing (e.g.
      // the free tier’s daily write quota is used up), the per-IP cap silently
      // stops working for the rest of the day unless someone is watching logs.
      console.error('RATELIMIT KV failed, continuing without per-IP cap:', err);
    }
  }

  // Forward only the real form fields — strip the Turnstile token, timestamp,
  // and honeypot. Form Hub stores whatever fields a form sends, so this stays
  // generic across forms with different fields.
  const payload = {};
  for (const [key, value] of Object.entries(body)) {
    if (!CONTROL_FIELDS.has(key)) payload[key] = value;
  }

  // Also wrapped — if Form Hub itself is unreachable, say so cleanly (502)
  // instead of letting an unhandled fetch rejection surface as a raw 500.
  let upstream;
  try {
    upstream = await fetch(`${env.FORMHUB_ORIGIN}/api/submit/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.FORMHUB_KEY}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return json({ ok: false, error: 'upstream_unreachable' }, 502);
  }

  if (!upstream.ok) {
    return json({ ok: false, error: 'upstream_failed' }, 502);
  }
  return json({ ok: true }, 200);
}

function json(data, status) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}