// index.js

import cluster from 'cluster';
import os from 'os';
import http2 from 'http2';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createBareServer } from '@tomphttp/bare-server-node';
import serveStatic from 'serve-static';
import { fetch, Agent: UndiciAgent } from 'undici';
import { Cluster } from 'puppeteer-cluster';
import Redis from 'ioredis';
import client from 'prom-client';
import LRU from 'lru-cache';
import zlib from 'zlib';
import { Agent as KeepAliveAgent } from 'agentkeepalive';
import { TextDecoder } from 'util';

// ── 設定 ─────────────────────────────────────
const PORT = process.env.PORT || 8080;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const bare = createBareServer('/bare/');

// キャッシュ設定
const memCache = new LRU({ max: 500, ttl: 1000 * 60 * 2 }); // 2分 in-memory
const redis = new Redis(process.env.REDIS_URL); // 永続・共有キャッシュ

// メトリクス設定
client.collectDefaultMetrics();
const httpCounter = new client.Counter({
  name: 'kimutichan_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['handler', 'code'],
});
const httpLatency = new client.Histogram({
  name: 'kimutichan_http_request_duration_seconds',
  help: 'Request latency',
  labelNames: ['handler'],
});

// HTTP クライアント高速化
const undiciAgent = new UndiciAgent({ keepAliveTimeout: 30000, keepAliveMaxTimeout: 60000 });
const keepAliveAgent = new KeepAliveAgent({ maxSockets: 100, freeSocketTimeout: 30000 });

// Puppeteer Cluster
let puppeteerCluster;
async function initCluster() {
  puppeteerCluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    maxConcurrency: os.cpus().length,
    puppeteerOptions: { headless: true, args: ['--no-sandbox'] },
  });

  await puppeteerCluster.task(async ({ page, data: url }) => {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    let html = await page.content();
    // charset 統一
    return html.replace(/<meta[^>]+charset=[^>]+>/i, '<meta charset="utf-8">');
  });
}

// マスターならワーカー fork
if (cluster.isMaster) {
  const cpus = os.cpus().length;
  console.log(`Master ${process.pid} → Fork ${cpus} workers`);
  for (let i = 0; i < cpus; i++) cluster.fork();
  cluster.on('exit', w => cluster.fork());
  process.exit();
}

// 各ワーカーの初期化
await initCluster();
const serve = serveStatic(STATIC_DIR, { fallthrough: false });

// GZIP＋Cache-Control ヘルパー
function send(res, data, type, maxAge = 60) {
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
  const accept = res.stream.session.socket.encrypted
    ? res.stream.session.socket._httpMessage.headers['accept-encoding']
    : '';
  if (accept && accept.includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    zlib.gzip(data, (_, buf) => res.end(buf));
  } else {
    res.end(data);
  }
}

// HTTP/2 TLS サーバ起動
const server = http2.createSecureServer(
  {
    key: fs.readFileSync(TLS_KEY_PATH),
    cert: fs.readFileSync(TLS_CERT_PATH),
  },
  async (req, res) => {
    const start = Date.now();
    const url = req.url || '';
    const handler =
      url.startsWith('/puppeteer?') ? 'puppeteer' : url.startsWith('/proxy/') ? 'decode' : bare.shouldRoute(req) ? 'bare' : 'static';

    const observe = code => {
      httpCounter.inc({ handler, code });
      httpLatency.labels(handler).observe((Date.now() - start) / 1000);
    };

    try {
      // 1) JS必須サイト → Puppeteer Cluster
      if (url.startsWith('/puppeteer?')) {
        const target = new URL('http://dummy' + url).searchParams.get('url');
        if (!target) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          observe(400);
          return res.end('Missing url');
        }
        const key = 'pp:' + target;
        let html = memCache.get(key) || await redis.get(key);
        if (!html) {
          html = await puppeteerCluster.execute(target);
          memCache.set(key, html);
          await redis.set(key, html, 'EX', 30);
        }
        send(res, html, 'text/html; charset=utf-8', 30);
        observe(200);
        return;
      }

      // 2) 文字化け対策プロキシ
      if (url.startsWith('/proxy/')) {
        const target = 'https://' + url.replace(/^\/proxy\//, '');
        const key = 'px:' + target;
        let text = memCache.get(key) || await redis.get(key);
        if (!text) {
          const rsp = await fetch(target, { agent: undiciAgent, headers: { 'User-Agent': 'Mozilla/5.0' } });
          const buf = await rsp.arrayBuffer();
          const m = (rsp.headers.get('content-type') || '').match(/charset=([^;]+)/i);
          const cs = m ? m[1].toLowerCase() : 'utf-8';
          try {
            text = new TextDecoder(cs).decode(buf);
          } catch {
            text = new TextDecoder('utf-8').decode(buf);
          }
          text = text.replace(/<meta[^>]+charset=[^>]+>/i, '<meta charset="utf-8">');
          memCache.set(key, text);
          await redis.set(key, text, 'EX', 60);
        }
        send(res, text, 'text/html; charset=utf-8', 60);
        observe(200);
        return;
      }

      // 3) bare-server-node 軽量プロキシ
      if (bare.shouldRoute(req)) {
        bare.routeRequest(req, res);
        observe(res.stream.responded ? res.stream.state : 200);
        return;
      }

      // 4) 静的ファイル
      serve(req, res, err => {
        const code = err?.statusCode || 404;
        res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(err?.stack || 'Not Found');
        observe(code);
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Error');
      observe(500);
    }
  }
);

// メトリクス
server.on('request', (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', client.register.contentType);
    return res.end(client.register.metrics());
  }
});

// WebSocket/Upgrade
server.on('upgrade', (req, socket, head) => {
  if (bare.shouldRoute(req, socket, head)) bare.routeUpgrade(req, socket, head);
  else socket.end();
});

// 起動
server.listen(PORT, () => console.log(`Worker ${process.pid} on ${PORT}`));
