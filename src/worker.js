import {spawn} from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import {ROOT} from './config.js';
export class Worker {
  constructor(config) { this.config = config; this.nextId = 0; this.pending = new Map(); }
  start() {
    const p = this.config.python || {};
    this.child = spawn(p.command || 'py', [...(p.args || ['-3.12']), '-u', path.join(ROOT, 'python', 'worker.py')], {cwd: ROOT, windowsHide: true, stdio: ['pipe','pipe','pipe']});
    this.child.stderr.on('data', b => process.stderr.write(b));
    readline.createInterface({input: this.child.stdout}).on('line', line => {
      let msg; try {msg = JSON.parse(line);} catch {console.error('[worker] 非协议输出:', line); return;}
      const req = this.pending.get(msg.id); if (!req) return;
      this.pending.delete(msg.id); clearTimeout(req.timer);
      msg.error ? req.reject(new Error(msg.error)) : req.resolve(msg.result);
    });
    const fail = e => {this.dead = true; for (const req of this.pending.values()) {clearTimeout(req.timer); req.reject(e);} this.pending.clear();};
    this.child.stdin.on('error', fail);
    this.child.on('error', fail); this.child.on('exit', code => fail(new Error(`微信 worker 退出: ${code}`)));
  }
  call(method, params = {}) {
    if (this.dead) return Promise.reject(new Error('微信 worker 已停止，请重启 bridge'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.pending.delete(id); this.dead = true; this.child.kill(); reject(new Error('微信操作超时，结果不确定；请检查界面后重启 bridge'));}, 90000);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(JSON.stringify({id, method, params}) + '\n');
    });
  }
  stop() {this.child?.kill();}
}
