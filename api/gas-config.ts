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
    if (!body || typeof body === 'string') {
      try {
        const raw = typeof body === 'string'
          ? body
          : await new Promise<string>((resolve) => {
              let data = '';
              req.on('data', (chunk) => {
                data += chunk;
              });
              req.on('end', () => resolve(data));
            });
        body = JSON.parse(raw || '{}');
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
