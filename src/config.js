import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function loadConfig(file = process.env.WECHAT_BRIDGE_CONFIG || path.join(ROOT, 'config.json')) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(c.chats)) throw new Error('chats 必须是数组');
  const names = new Set();
  const sessionIds = new Set();
  for (const chat of c.chats) {
    if (!chat.name?.trim() || !['private', 'group'].includes(chat.kind) || names.has(chat.name)) throw new Error('聊天名称必须唯一，kind 为 private/group');
    names.add(chat.name);
    if (chat.sessionId !== undefined) {
      if (typeof chat.sessionId !== 'string' || !chat.sessionId.trim()) throw new Error('sessionId 必须为非空字符串');
      if (sessionIds.has(chat.sessionId)) throw new Error('多个聊天不能绑定同一个 sessionId');
      sessionIds.add(chat.sessionId);
    }
    if (chat.enabled && chat.kind === 'group') throw new Error('C# UIA 后端不识别发送者，暂不支持群聊 senders 策略，请使用私聊');
    if (chat.kind === 'group' && chat.enabled && (!Array.isArray(chat.senders) || !chat.senders.length)) throw new Error(`群 ${chat.name} 必须明确配置 senders`);
  }
  const url = new URL(c.dsh?.baseUrl || 'http://127.0.0.1:3080');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('DSH 地址无效');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !c.dsh?.allowRemote) throw new Error('远程 DSH 需要 allowRemote=true');
  if (!['tools', 'auto'].includes(c.replyMode)) throw new Error('replyMode 必须为 tools 或 auto');
  c.http ??= {port: 3111};
  if (!Number.isInteger(c.http.port) || c.http.port < 1 || c.http.port > 65535) throw new Error('HTTP 端口无效');
  c.wechat ??= {};
  c.wake ??= {enabled:false};
  if (c.wake.enabled && (typeof c.wake.word !== 'string' || !c.wake.word.trim())) throw new Error('wake.word 必须为非空唤醒词');
  if (c.wake.enabled && (!Number.isInteger(c.wake.historyCount) || c.wake.historyCount < 1 || c.wake.historyCount > 200)) throw new Error('wake.historyCount 必须为 1～200 的整数');
  if (c.wechat.pollIntervalMs !== undefined && (!Number.isFinite(c.wechat.pollIntervalMs) || c.wechat.pollIntervalMs < 500)) throw new Error('轮询间隔至少 500ms');
  c.sessionCwd = path.resolve(ROOT, c.sessionCwd || 'state/agents');
  return c;
}
export function permitted(c, event) {
  const chat = c.chats.find(x => x.name === event.chat && x.enabled);
  if (!chat || (event.self && !chat.allowSelf) || event.type !== 'text') return false;
  if (event.kind !== chat.kind) return false;
  if (chat.kind === 'group') {
    if (!chat.senders.includes(event.sender)) return false;
    if (chat.mentionOnly && !(chat.aliases || []).some(n => event.content.includes(`@${n}`))) return false;
  }
  return true;
}
