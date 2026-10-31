/** GitHub repos (Parts 11.4, 17.8): GitHub App (preferred) or fine-grained read-only token. */
import crypto from 'node:crypto';
import { config } from '../config.ts';
import type { Queryable } from '../db/index.ts';
import { HttpError } from '../util.ts';
import { getIntegration } from '../integrations/store.ts';

const API = 'https://api.github.com';
export const DEFAULT_PATHS = ['README*', 'docs/**', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'tsconfig.json', 'Dockerfile', 'docker-compose.yml', '*.config.*', 'ARCHITECTURE*', 'CONTRIBUTING*'];

export function globToRegex(g: string) {
  const re = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`, 'i');
}
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.github.appId }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), config.github.appPrivateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

export async function githubToken(q: Queryable, ws: string): Promise<string> {
  const integ = await getIntegration(q, ws, 'github');
  if (!integ?.credentials) throw new HttpError(400, 'not_connected', 'GitHub is not connected for this workspace');
  const c = integ.credentials;
  if (c.type === 'token') return c.token;
  if (c.type === 'app') {
    const r = await fetch(`${API}/app/installations/${c.installation_id}/access_tokens`, { method: 'POST', headers: { authorization: `Bearer ${appJwt()}`, accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new HttpError(502, 'github_error', `GitHub App token failed ${r.status}`);
    return ((await r.json()) as any).token;
  }
  throw new HttpError(400, 'bad_credentials');
}

async function gh(token: string, path: string, accept = 'application/vnd.github+json') {
  const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'embargo' } });
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, 'github_error', `GitHub ${path} → ${r.status}`);
  return accept.includes('raw') ? r.text() : r.json();
}

export async function listRepoFiles(token: string, repo: string, ref: string, patterns = DEFAULT_PATHS) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new HttpError(400, 'bad_repo');
  const commit: any = await gh(token, `/repos/${repo}/commits/${encodeURIComponent(ref)}`);
  const tree: any = await gh(token, `/repos/${repo}/git/trees/${commit.sha}?recursive=1`);
  const res = patterns.map(globToRegex);
  const files = (tree.tree as any[]).filter((t) => t.type === 'blob' && t.size < 500_000 && res.some((r) => r.test(t.path)));
  return { commit: commit.sha as string, files: files.map((f) => ({ path: f.path as string, sha: f.sha as string, size: f.size as number })) };
}

export async function fetchRepoFile(token: string, repo: string, path: string, ref: string) {
  return (await gh(token, `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, 'application/vnd.github.raw')) as string;
}

export function verifyGithubSignature(raw: Buffer, sig: string | undefined) {
  if (!config.github.webhookSecret || !sig) return false;
  const exp = 'sha256=' + crypto.createHmac('sha256', config.github.webhookSecret).update(raw).digest('hex');
  return exp.length === sig.length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(sig));
}
