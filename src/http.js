import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
export function serve(engine, token, port) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const auth = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {res.writeHead(401); res.end('{"error":"unauthorized"}'); return;}
    try {
      if (req.method !== 'POST' || req.url !== '/rpc') {res.writeHead(404); res.end('{}'); return;}
      const chunks = []; let size = 0;
      for await (const chunk of req) {size += chunk.length; if (size > 65536) throw new Error('请求过大'); chunks.push(chunk);}
      const {method, params = {}} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let value;
      if (method === 'status') value = {bridge: 'running', pending: engine.store.data.inbox.filter(j => j.status === 'pending').length, uncertainSends: engine.store.data.outbox.filter(j => j.status === 'uncertain').length};
      else if (method === 'send_message') value = await engine.send(params);
      else if (method === 'send_file') value = await engine.send({...params, message: '', file: params.file});
      else if (method === 'recent') {
        if (!engine.config.chats.some(c => c.enabled && c.name === params.to_user)) throw new Error('目标聊天未启用');
        value = engine.store.data.messages.filter(m => m.chat === params.to_user).slice(-Math.max(1, Math.min(100, params.limit || 20)));
      } else throw new Error('未知方法');
      res.end(JSON.stringify({ok: true, value}));
    } catch (e) {res.writeHead(400); res.end(JSON.stringify({ok: false, error: e.message}));}
  });
  server.requestTimeout = 100000;
  return new Promise((resolve, reject) => {server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server));});
}
