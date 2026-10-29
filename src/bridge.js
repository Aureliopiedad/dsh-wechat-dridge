import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig, ROOT} from './config.js';
import {Store} from './store.js';
import {Worker} from './worker.js';
import {Engine} from './engine.js';
import {serve} from './http.js';
import {NodeApiClient} from './dsh-client.js';

const config = loadConfig();
const stateDir = path.join(ROOT, 'state');
fs.mkdirSync(stateDir, {recursive: true});
// Bind the control socket first: a second instance must not start a worker or mutate state.
const tokenFile = path.join(stateDir, 'mcp-token');
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('hex'), {mode: 0o600});
const token = fs.readFileSync(tokenFile, 'utf8').trim();
let engine;
const facade = new Proxy({}, {get: (_, key) => {if (!engine) throw new Error('bridge 正在启动'); return typeof engine[key] === 'function' ? engine[key].bind(engine) : engine[key];}});
const server = await serve(facade, token, config.http.port);
const store = new Store(stateDir);
for (const chat of config.chats.filter(c => c.enabled && c.sessionId)) {
  store.data.sessions[chat.name] = chat.sessionId;
}
store.save();
const api = new NodeApiClient(config.dsh.baseUrl, undefined, {token: config.dsh.authToken || '', tokenExplicit: Boolean(config.dsh.authToken), allowRemote: Boolean(config.dsh.allowRemote)});
const worker = new Worker(config); worker.start();
engine = new Engine(config, store, worker, api);
const abort = new AbortController();
function stop() {abort.abort(); worker.stop(); server.close();}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
for (const sid of Object.values(store.data.sessions)) api.events.follow(sid);

async function pump() {
  let backoff = 1000;
  while (!abort.signal.aborted) {
    try {
      for await (const env of api.events.mux({}, abort.signal, () => {backoff = 1000;})) {
        await engine.frame(env.payload);
      }
    } catch (e) {if (!abort.signal.aborted) console.error('[DSH 事件流]', e.message);}
    if (!abort.signal.aborted) {await delay(backoff, undefined, {signal: abort.signal}).catch(() => {}); backoff = Math.min(30000, backoff * 2);}
  }
}
const pumping = pump();
console.error(`wechat-bridge 已启动，控制接口 127.0.0.1:${config.http.port}，replyMode=${config.replyMode}`);
try {
  while (!abort.signal.aborted) {
    await engine.poll();
    await engine.expirePending();
    await engine.drain();
    await engine.flushOutbox();
    await delay(config.wechat.pollIntervalMs || 3000, undefined, {signal: abort.signal}).catch(() => {});
  }
} finally {stop(); await pumping;}
