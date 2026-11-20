import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const DATA_DIR = path.resolve(process.cwd(), '.data');
const CONFIG_FILE = path.join(DATA_DIR, 'gas-config.json');

interface PersistedGasConfig {
  url: string;
  token: string;
  locked: boolean;
  updatedAt: string;
}

function readPersistedConfig(): PersistedGasConfig | null {
  const envUrl = String(process.env.APPS_SCRIPT_URL || process.env.VITE_APPS_SCRIPT_URL || '').trim();
  const envToken = String(process.env.APPS_SCRIPT_TOKEN || process.env.VITE_APPS_SCRIPT_TOKEN || '').trim();

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistedGasConfig>;
      if (parsed.url && parsed.token) {
        return {
          url: String(parsed.url).trim(),
          token: String(parsed.token).trim(),
          locked: parsed.locked !== false,
          updatedAt: parsed.updatedAt || new Date().toISOString(),
        };
      }
    }
  } catch {
    // Ignore malformed config file
  }

  if (envUrl && envToken) {
    return {
      url: envUrl,
      token: envToken,
      locked: true,
      updatedAt: new Date().toISOString(),
    };
  }
  return null;
}

function writePersistedConfig(url: string, token: string): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload: PersistedGasConfig = {
    url: url.trim(),
    token: token.trim(),
    locked: true,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(payload, null, 2), 'utf-8');
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/gas-config', (_req, res) => {
    const cfg = readPersistedConfig();
    if (!cfg) {
      res.json({ configured: false });
      return;
    }
    res.json({
      configured: true,
      url: cfg.url,
      token: cfg.token,
      locked: cfg.locked,
      persisted: true,
    });
  });

  app.post('/api/gas-config', (req, res) => {
    const url = String(req.body?.url || '').trim();
    const token = String(req.body?.token || '').trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(\?.*)?$/i.test(url) || token.length < 4) {
      res.status(400).json({ ok: false, error: 'URL atau Token Apps Script tidak valid.' });
      return;
    }
    try {
      writePersistedConfig(url, token);
      res.json({ ok: true, persisted: true });
    } catch (err: any) {
      res.status(500).json({ ok: false, persisted: false, error: err?.message || 'Gagal menyimpan konfigurasi.' });
    }
  });

  // Mount Vite middleware in development, or serve static dist in production
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Frontend server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
