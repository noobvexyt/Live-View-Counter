// A tiny client for an Upstash Redis database over its REST API (what Vercel's Upstash integration
// sets up). Used only by the Vercel version of the site (api/index.js). No npm packages needed.

// Vercel's integration names the variables KV_REST_API_URL / KV_REST_API_TOKEN (optionally with a prefix
// you choose when connecting the database); Upstash's own dashboard calls them UPSTASH_REDIS_REST_*.
function findDatabase(env = process.env) {
  const pairs = [['KV_REST_API_URL', 'KV_REST_API_TOKEN'], ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']];
  for (const [u, t] of pairs) if (env[u] && env[t]) return { url: env[u], token: env[t] };
  for (const key of Object.keys(env)) {
    const m = key.match(/^(.+_)(KV_REST_API_URL|UPSTASH_REDIS_REST_URL)$/);
    if (!m) continue;
    const tokenKey = m[1] + m[2].replace(/URL$/, 'TOKEN');
    if (env[key] && env[tokenKey]) return { url: env[key], token: env[tokenKey] };
  }
  return null;
}

const database = findDatabase();

export const kvReady = () => Boolean(database);

async function post(path, body) {
  if (!database) throw new Error('No database is connected.');
  let r;
  try {
    r = await fetch(database.url.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${database.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error('Can’t reach the database right now.');
  }
  let j = null;
  try { j = await r.json(); } catch { /* not JSON */ }
  if (!j) throw new Error(`Database error (${r.status}).`);
  if (!Array.isArray(j) && j.error) throw new Error(`Database: ${j.error}`);
  return j;
}

// One command, e.g. cmd('SET', 'key', 'value'). Resolves with Redis's answer.
export async function cmd(...args) {
  const j = await post('', args.map(String));
  return j.result;
}

// Several commands in one request (not atomic). Resolves with each command's answer.
export async function pipeline(commands) {
  const j = await post('/pipeline', commands.map((c) => c.map(String)));
  return j.map((x) => {
    if (x && x.error) throw new Error(`Database: ${x.error}`);
    return x ? x.result : null;
  });
}
