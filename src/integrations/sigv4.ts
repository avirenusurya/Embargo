import crypto from 'node:crypto';

/** Minimal AWS Signature V4 signer (used for S3-compatible storage and AWS KMS). */
export async function sigv4Fetch(opts: {
  method: string; url: string; service: string; region: string; accessKey: string; secretKey: string;
  body?: Buffer | string; headers?: Record<string, string>;
}): Promise<Response> {
  const u = new URL(opts.url);
  const body = opts.body ?? '';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
  const headers: Record<string, string> = {
    host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash,
    ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${headers[k].trim()}\n`).join('');
  const canonicalQuery = [...u.searchParams.entries()].sort().map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonicalPath = u.pathname.split('/').map((p) => encodeURIComponent(decodeURIComponent(p))).join('/');
  const canonical = [opts.method, canonicalPath || '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const h = (k: Buffer | string, d: string) => crypto.createHmac('sha256', k).update(d).digest();
  const kSigning = h(h(h(h('AWS4' + opts.secretKey, date), opts.region), opts.service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete headers.host;
  return fetch(opts.url, { method: opts.method, headers, body: opts.method === 'GET' || opts.method === 'DELETE' ? undefined : (typeof body === 'string' ? body : new Uint8Array(body)) });
}
