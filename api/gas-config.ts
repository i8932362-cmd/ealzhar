import type { IncomingMessage, ServerResponse } from 'http';

let memoryConfig: { url: string; token: string; locked: boolean } | null = null;

function readEnvConfig(): { url: string; token: string; locked: boolean } | null {
  const url = String(process.env.APPS_SCRIPT_URL || process.env.VITE_APPS_SCRIPT_URL || '').trim();
  const token = String(process.env.APPS_SCRIPT_TOKEN || process.env.VITE_APPS_SCRIPT_TOKEN || '').trim();
  if (url && token) {
    return { url, token, locked: true };
  }
  return memoryConfig;
}

export default async function handler(
  req: IncomingMessage & { body?: any; method?: string },
  res: ServerResponse & { status?: (code: number) => any; json?: (data: any) => void }
) {
  const sendJson = (statusCode: number, data: unknown) => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(data));
  };

  if (req.method === 'GET') {
    const cfg = readEnvConfig();
    if (!cfg) {
      sendJson(200, { configured: false });
      return;
    }
    sendJson(200, {
      configured: true,
      url: cfg.url,
      token: cfg.token,
      locked: cfg.locked,
      persisted: Boolean(process.env.APPS_SCRIPT_URL || process.env.VITE_APPS_SCRIPT_URL),
    });
    return;
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (!body || typeof body === 'string' || Buffer.isBuffer(body)) {
      try {
        const raw = typeof body === 'string'
          ? body
          : Buffer.isBuffer(body)
            ? body.toString('utf8')
            : await new Promise<string>((resolve) => {
                const chunks: Buffer[] = [];
                req.on('data', (chunk) => {
                  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
                });
                req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                req.on('error', () => resolve('{}'));
              });
        const parsed = JSON.parse(raw || '{}');
        body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        body = {};
      }
    }

    const url = String(body?.url || '').trim();
    const token = String(body?.token || '').trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(\?.*)?$/i.test(url) || token.length < 4) {
      sendJson(400, { ok: false, error: 'URL atau Token Apps Script tidak valid.' });
      return;
    }

    memoryConfig = { url, token, locked: true };
    sendJson(200, {
      ok: true,
      persisted: Boolean(process.env.APPS_SCRIPT_URL || process.env.VITE_APPS_SCRIPT_URL),
    });
    return;
  }

  sendJson(405, { error: 'Method not allowed' });
}
