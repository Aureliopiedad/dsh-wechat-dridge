import fs from 'node:fs';
import path from 'node:path';
export class Store {
  constructor(dir) {
    this.dir = dir; fs.mkdirSync(dir, {recursive: true});
    this.file = path.join(dir, 'bridge.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {sessions: {}, inbox: [], outbox: [], messages: [], baselines: {}, cursors: {}, turns: {}, pending: {}};
    // 不确定是否已经发送的操作不能自动重发，否则可能重复发送。
    for (const job of this.data.outbox) if (job.status === 'sending') job.status = 'uncertain';
    this.save();
  }
  save() {
    const temp = this.file + '.tmp';
    const fd = fs.openSync(temp, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(this.data, null, 2)); fs.fsyncSync(fd); } finally {fs.closeSync(fd);}
    fs.renameSync(temp, this.file);
  }
  ingest(events, baselines) {
    const known = new Set(this.data.messages.map(m => m.id));
    for (const event of events) {
      if (known.has(event.id)) continue;
      known.add(event.id);
      this.data.messages.push(event);
      this.data.inbox.push({...event, status: 'pending', requestId: event.id});
    }
    Object.assign(this.data.baselines, baselines);
    // inbox/outbox 历史保留用于幂等；原型阶段不自动清理投递凭据。
    this.save();
  }
  enqueueSend(id, chat, content, file = null, sessionId = null) {
    let job = this.data.outbox.find(j => j.id === id);
    if (!job) {
      job = {id, chat, content, file, sessionId, status: 'pending', createdAt: Date.now()};
      this.data.outbox.push(job); this.save();
    } else if (job.chat !== chat || job.content !== content || job.file !== file) throw new Error('相同 requestId 对应不同消息');
    return job;
  }
}
