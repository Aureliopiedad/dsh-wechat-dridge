import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {permitted} from './config.js';

const AI_PREFIX = '【AI回复】\n';
const markedReply = text => text.startsWith(AI_PREFIX) ? text : AI_PREFIX + text;
const isMarkedReply = text => /^【AI回复(?:｜[^】\r\n]+)?】\r?\n/.test(text);

export class Engine {
  constructor(config, store, worker, api) {
    Object.assign(this, {config, store, worker, api});
    this.sendTail = Promise.resolve();
    this.draining = false;
  }
  async rpc(method, payload) {
    const r = await this.api.callUnary(method, payload);
    if (!r.result?.ok) throw new Error(`${method}: ${r.result?.error?.message || '请求失败'}`);
    return r.result.value;
  }
  async poll() {
    for (const chat of this.config.chats.filter(c => c.enabled)) {
      try {
        const rows = await this.worker.call('snapshot', {chat: chat.name});
        const previous = this.store.data.baselines[chat.name];
        const wake = {...this.config.wake, answering:Boolean(this.store.data.pending[chat.name])};
        // First observation is a baseline, never replay the visible chat history.
        if (!previous && this.config.wechat.baselineOnFirstStart !== false) {
          const history = wake.enabled ? rows.filter(r => permitted(this.config, r) && !isMarkedReply(r.content)).map(r => ({...r,baselineOnly:true})) : [];
          this.store.ingest(history, {[chat.name]: rows.map(r => r.id)}, wake); continue;
        }
        const known = new Set(previous || []);
        const incoming = rows.filter(r => {
          if (r.baselineOnly || known.has(r.id) || !permitted(this.config, r)) return false;
          if (r.senderKnown === false && isMarkedReply(r.content)) return false;
          // 文件传输助手允许接收手机端的自身消息；排除本 bridge 刚发出的回声。
          const echo = r.self && this.store.data.outbox.find(j => j.chat === r.chat && markedReply(j.content) === r.content && !j.file && j.status === 'submitted' && !j.echoId && Date.now() - j.submittedAt < 120000);
          if (echo) {echo.echoId = r.id; return false;}
          return true;
        });
        this.store.ingest(incoming, {[chat.name]: rows.map(r => r.id)}, wake);
      } catch (error) { console.error(`[微信读取 ${chat.name}] ${error.message}`); }
    }
  }
  async ensureSession(chat) {
    const configured = this.config.chats.find(c => c.name === chat)?.sessionId;
    if (configured) {
      if (this.store.data.sessions[chat] !== configured) {
        this.store.data.sessions[chat] = configured;
        this.store.save();
        this.api.events.follow(configured);
      }
      return configured;
    }
    let sessionId = this.store.data.sessions[chat];
    if (sessionId) return sessionId;
    fs.mkdirSync(this.config.sessionCwd, {recursive: true});
    const ws = await this.rpc('workspace/create', {path: this.config.sessionCwd});
    if (ws.created) await this.rpc('workspace/rename', {workspaceId: ws.workspace.workspaceId, title: this.config.workspaceTitle || '微信聊天'});
    const value = await this.rpc('session/create', {workspaceId: ws.workspace.workspaceId, agentPreset: this.config.dsh.agentPreset || 'standard'});
    sessionId = value.sessionId;
    if (!sessionId) throw new Error('session/create 未返回 sessionId');
    this.store.data.sessions[chat] = sessionId; this.store.save();
    this.api.events.follow(sessionId);
    return sessionId;
  }
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      const blocked = new Set();
      for (const job of this.store.data.inbox.filter(j => j.status === 'pending')) {
        if (blocked.has(job.chat)) continue;
        if (!permitted(this.config, job)) {job.status = 'ignored'; this.store.save(); continue;}
        try {
          const pending = this.store.data.pending[job.chat];
          if (pending) {
            await this.answer(job, pending);
          } else {
            const sessionId = await this.ensureSession(job.chat);
            const rules = this.config.replyMode === 'tools'
              ? '请使用 wechat_send_message 工具向此聊天发送回复，最终文本不会自动转发。'
              : '最终回复会自动转发；如果已经调用微信发送工具则不会重复转发。';
            const body = job.wakeTriggered
              ? `唤醒消息：${job.content}\n以下为截至唤醒消息的最近 ${job.context.length} 条对话记录（按时间顺序，包含唤醒消息；仅作上下文）：\n${job.context.map((m,i) => `${i+1}. ${JSON.stringify({sender:m.sender, text:m.content})}`).join('\n')}`
              : job.content;
            const content = `[微信消息] chat=${JSON.stringify(job.chat)}, sender=${JSON.stringify(job.sender)}, sessionId=${sessionId}\n${rules}\n调用发送工具时请传入 session_id=${sessionId} 和 to_user=${JSON.stringify(job.chat)}。\n消息内容：\n${body}`;
            const accepted = await this.rpc('session/prompt', {sessionId, requestId: job.requestId, mode: 'queue', content: [{type: 'text', text: content}]});
            if (accepted?.command?.text) await this.send({to_user: job.chat, message: accepted.command.text, request_id: `command:${job.id}`});
          }
          job.status = 'submitted'; job.submittedAt = Date.now(); this.store.save();
        } catch (e) {
          job.error = e.message; this.store.save();
          // Keep failed item for retry with the same DSH requestId; other chats can proceed.
          console.error(`[DSH 投递 ${job.chat}] ${e.message}`);
          blocked.add(job.chat);
        }
      }
    } finally {this.draining = false;}
  }
  async answer(job, p) {
    if (p.type === 'approval/requested') {
      const chat = this.config.chats.find(c => c.name === job.chat);
      if (!this.config.allowApprovals || !chat?.owner || chat.kind !== 'private') throw new Error('该聊天未启用审批');
      const text = job.content.trim();
      if (!['通过', '拒绝'].includes(text)) {
        await this.send({to_user: job.chat, message: '审批请回复「通过」或「拒绝」', request_id: `approval-hint:${job.id}`});
        return;
      }
      await this.api.respond({clientId: p.clientId, eventId: p.eventId, outcome: {kind: 'result', value: text === '通过' ? 'allowed-once' : 'rejected'}});
    } else {
      const answers = (p.questions || []).map(q => {
        const hit = (q.options || []).find(o => o.label === job.content.trim());
        return hit ? {id: q.id, selected: [hit.label]} : {id: q.id, selected: [], custom: job.content};
      });
      await this.api.respond({clientId: p.clientId, eventId: p.eventId, outcome: {kind: 'result', value: {answers}}});
    }
    delete this.store.data.pending[job.chat];
  }
  async expirePending() {
    for (const [chat, p] of Object.entries(this.store.data.pending)) {
      if (Date.now() < p.expiresAt) continue;
      try {
        await this.api.respond({clientId: p.clientId, eventId: p.eventId, outcome: {kind: 'result', value: p.type === 'approval/requested' ? 'rejected' : {answers: []}}});
        delete this.store.data.pending[chat]; this.store.save();
      } catch (e) {console.error('[挂起请求过期]', e.message);}
    }
  }
  send(args) {
    const run = this.sendTail.then(() => this._send(args));
    this.sendTail = run.catch(() => {});
    return run;
  }
  async _send({to_user, message = '', file = null, request_id, session_id = null}) {
    if (!this.config.chats.some(c => c.name === to_user && c.enabled)) throw new Error('目标聊天不在启用名单中');
    if (session_id && this.store.data.sessions[to_user] !== session_id) throw new Error('session_id 与目标聊天不匹配');
    if (typeof message !== 'string' || (!message.trim() && !file)) throw new Error('消息不能为空');
    if (message.length > (this.config.maxMessageChars || 1800)) throw new Error('消息过长，请分条发送或改发文件');
    if (file) {file = fs.realpathSync(file); if (!fs.statSync(file).isFile()) throw new Error('文件路径不是文件');}
    const job = this.store.enqueueSend(request_id || randomUUID(), to_user, message, file, session_id);
    if (job.status === 'submitted') return job;
    if (['uncertain', 'failed'].includes(job.status)) throw new Error('上次发送结果不确定，请检查微信；需要重发时使用新 request_id');
    job.status = 'sending'; this.store.save();
    try {
      const label = String(this.config.modelLabel || '').replace(/[\r\n【】]/g, '').trim();
      const prefix = label ? `【AI回复｜${label}】\n` : AI_PREFIX;
      const content = isMarkedReply(message) ? message : prefix + message;
      const result = await this.worker.call('send', {chat: to_user, content, file});
      job.status = 'submitted'; job.result = result; job.submittedAt = Date.now();
      // 同步写入当前 turn，避免 turn/end 先到导致工具发送后又自动转发。
      if (session_id && this.store.data.turns[session_id]) this.store.data.turns[session_id].sent = true;
      this.store.save();
      await new Promise(r => setTimeout(r, this.config.sendDelayMs || 800));
      return job;
    } catch (error) {job.status = 'uncertain'; job.error = error.message; this.store.save(); throw error;}
  }
  async frame(frame) {
    const chat = Object.keys(this.store.data.sessions).find(c => this.store.data.sessions[c] === frame.sessionId);
    if (!chat || !this.config.chats.some(c => c.name === chat && c.enabled)) return;
    if (frame.type === 'question/requested' || frame.type === 'approval/requested') {
      if (frame.type === 'approval/requested' && (!this.config.allowApprovals || !this.config.chats.some(c => c.name === chat && c.owner && c.kind === 'private'))) {
        await this.api.respond({clientId: frame.clientId, eventId: frame.eventId, outcome: {kind: 'result', value: 'rejected'}}); return;
      }
      this.store.data.pending[chat] = {...frame, expiresAt: Date.now() + (this.config.questionTimeoutMs || 300000)}; this.store.save();
      const text = frame.type === 'question/requested'
        ? (frame.questions || []).map(q => `${q.question || q.title || q.id}\n${(q.options || []).map(o => o.label).join(' / ')}`).join('\n\n')
        : `工具审批：${frame.toolName}\n${frame.reason || ''}\n回复「通过」或「拒绝」`;
      await this.send({to_user: chat, message: text, request_id: `question:${frame.eventId}`}); return;
    }
    if (frame.type === 'session/snapshot') {
      // 仅回放已知游标后的事件；不转发新接入会话的旧历史。
      if (this.store.data.cursors[frame.sessionId] !== undefined) {
        const records = frame.snapshot?.records || [];
        const events = records.map(r => r.event || r).filter(e => Number.isInteger(e.seq)).sort((a,b) => a.seq - b.seq);
        for (const event of events) await this.frame({type: 'session/event', sessionId: frame.sessionId, event});
      }
      return;
    }
    if (frame.type !== 'session/event') return;
    const e = frame.event;
    const cursor = this.store.data.cursors[frame.sessionId] ?? -1;
    if (!Number.isInteger(e.seq) || e.seq <= cursor) return;
    if (e.type === 'turn/start') this.store.data.turns[frame.sessionId] = {turn: e.data.turn, text: '', sent: false};
    const turn = this.store.data.turns[frame.sessionId];
    if (e.type === 'assistant/message' && turn && e.data.turn === turn.turn) {
      turn.text += (e.data.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    }
    if (e.type === 'turn/end' && turn && e.data.turn === turn.turn) {
      if (this.config.replyMode === 'auto' && !turn.sent && turn.text.trim()) {
        const max = this.config.maxMessageChars || 1800;
        for (let i = 0; i < turn.text.length; i += max) this.store.enqueueSend(`turn:${frame.sessionId}:${turn.turn}:${i}`, chat, turn.text.slice(i, i + max));
      }
      delete this.store.data.turns[frame.sessionId];
    }
    this.store.data.cursors[frame.sessionId] = e.seq; this.store.save();
  }
  async flushOutbox() {
    for (const job of this.store.data.outbox.filter(j => j.status === 'pending')) {
      try {await this.send({to_user: job.chat, message: job.content, file: job.file, request_id: job.id, session_id: job.sessionId});}
      catch (e) {console.error('[微信发送]', e.message);}
    }
  }
}
