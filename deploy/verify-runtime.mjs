import http from 'node:http';

const base = process.env.AGENT_DECK_BASE || 'http://127.0.0.1:3842';
const runtime = process.env.AGENT_RUNTIME_URL || 'http://127.0.0.1:3852';

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on('data', d => chunks.push(Buffer.from(d)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode || 500) >= 400) reject(new Error(`${url} ${res.statusCode} ${text}`));
        else resolve(text);
      });
    }).on('error', reject);
  });
}

const webStatus = await get(`${base}/api/status`).catch(e => `ERR ${e.message}`);
const runtimeHealth = await get(`${runtime}/healthz`).catch(e => `ERR ${e.message}`);
console.log(JSON.stringify({ webStatus: webStatus.slice(0, 500), runtimeHealth }, null, 2));
