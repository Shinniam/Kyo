// server.js
import { createServer as createBareServer } from '@tomphttp/bare-server-node';
import serveStatic from 'serve-static';
import { fetch, Agent as UndiciAgent } from 'undici';
import { Cluster } from 'puppeteer-cluster';
import Redis from 'ioredis';
import LRU from 'lru-cache';
import client from 'prom-client';
import zlib from 'zlib';
import { Agent as KeepAliveAgent } from 'agentkeepalive';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, 'static');
const bare       = createBareServer('/bare/');
const serve      = serveStatic(STATIC_DIR, { fallthrough: false });

// キャッシュ設定
const memCache = new LRU({ max: 500, ttl: 1000 * 60 * 2 });
const redis    = new Redis(process.env.REDIS_URL);

// メトリクス設定
client.collectDefaultMetrics();
const httpCounter = new client.Counter({
  name: 'kimutichan_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['handler','code']
});
const httpLatency = new client.Histogram({
  name: 'kimutichan_http_request_duration_seconds',
  help: 'Request latency',
  labelNames: ['handler']
});

// HTTP クライアント高速化
const undiciAgent    = new UndiciAgent({ keepAliveTimeout: 30000, keepAliveMaxTimeout: 60000 });
const keepAliveAgent = new KeepAliveAgent({ maxSockets:100, freeSocketTimeout:30000 });

// Puppeteer Cluster (Incognito対応)
let puppeteerCluster;
async function initCluster() {
  puppeteerCluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    maxConcurrency: require('os').cpus().length,
    puppeteerOptions: { headless: true, args: ['--no-sandbox'] }
  });
  await puppeteerCluster.task(async ({ data: url, browser }) => {
    const ctx  = await browser.createIncognitoBrowserContext();
    const page = await ctx.newPage();
    await page.setUserAgent('Mozilla/5.0');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    let html = await page.content();
    await page.close();
    await ctx.close();
    return html.replace(/<meta[^>]+charset=[^>]+>/i, '<meta charset="utf-8">');
  });
}
initCluster();

// レスポンス送信ヘルパー（GZIP + Cache-Control）
function send(res, data, contentType, maxAge = 60) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
  const accepts = res.socket.serverResponse
    ? res.socket.serverResponse.getHeader('accept-encoding') || ''
    : '';
  if (accepts.includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    return zlib.gzip(data, (_, buf) => res.end(buf));
  }
  res.end(data);
}

export async function createBareHandler(req, res) {
  const start   = Date.now();
  const url     = req.url || '';
  const handler = url.startsWith('/puppeteer?') ? 'puppeteer'
                : url.startsWith('/proxy/')     ? 'decode'
                : bare.shouldRoute(req)         ? 'bare'
                : url === '/metrics'             ? 'metrics'
                : 'static';

  const observe = code => {
    httpCounter.inc({ handler, code });
    httpLatency.labels(handler).observe((Date.now() - start) / 1000);
  };

  // /metrics エンドポイント
  if (handler === 'metrics') {
    res.setHeader('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
    observe(200);
    return;
  }

  // /puppeteer?url=… JS必須サイト
  if (handler === 'puppeteer') {
    const target = new URL('http://x' + url).searchParams.get('url');
    if (!target) {
      res.writeHead(400, {'Content-Type':'text/plain; charset=utf-8'});
      res.end('Missing url');
      observe(400);
      return;
    }
    const key  = 'pp:' + target;
    let html   = memCache.get(key) || await redis.get(key);
    if (!html) {
      html = await puppeteerCluster.execute(target);
      memCache.set(key, html);
      await redis.set(key, html, 'EX', 30);
    }
    send(res, html, 'text/html; charset=utf-8', 30);
    observe(200);
    return;
  }

  // /proxy/… 文字化け対策プロキシ
  if (handler === 'decode') {
    const target = 'https://' + url.slice(7);
    const key    = 'px:' + target;
    let text     = memCache.get(key) || await redis.get(key);
    if (!text) {
      const rsp = await fetch(target, { agent: undiciAgent, headers:{'User-Agent':'Mozilla/5.0'} });
      const buf = await rsp.arrayBuffer();
      const m   = (rsp.headers.get('content-type')||'').match(/charset=([^;]+)/i);
      const cs  = m ? m[1].toLowerCase() : 'utf-8';
      try { text = new TextDecoder(cs).decode(buf); }
      catch{ text = new TextDecoder('utf-8').decode(buf); }
      text = text.replace(/<meta[^>]+charset=[^>]+>/i,'<meta charset="utf-8">');
      memCache.set(key, text);
      await redis.set(key, text, 'EX', 60);
    }
    send(res, text, 'text/html; charset=utf-8', 60);
    observe(200);
    return;
  }

  // /bare/... 軽量プロキシ
  if (handler === 'bare') {
    bare.routeRequest(req, res);
    observe(200);
    return;
  }

  // 静的ファイル
  serve(req, res, err => {
    const code = err?.statusCode || 404;
    res.writeHead(code, {'Content-Type':'text/plain; charset=utf-8'});
    res.end(err?.stack || 'Not Found');
    observe(code);
  });
}
