import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
import {permitted} from '../src/config.js';
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const config = {chats:[{name:'Alice',kind:'private',enabled:true}], wechat:{}, dsh:{agentPreset:'standard'}, sessionCwd:dir, replyMode:'tools', sendDelayMs:1, ...extra};
  const store = new Store(dir); let rows = []; const sends = [], calls = [];
  const worker = {call: async (m,p) => {if(m==='snapshot') return rows; sends.push(p); return {status:'submitted'};}};
  const api = {callUnary: async (m,p) => {calls.push([m,p]); return {result:{ok:true,value:m==='workspace/create'?{created:false,workspace:{workspaceId:'w'}}:m==='session/create'?{sessionId:'s'}:{}}};},events:{follow(){}},respond:async p=>calls.push(['respond',p])};
  return {engine:new Engine(config,store,worker,api),store,worker,api,sends,calls,setRows:r=>rows=r,dir};
}
const row = (id, content='hello', more={}) => ({id,chat:'Alice',kind:'private',sender:'Alice',content,type:'text',self:false,...more});
test('首次仅建立基线，后续消息持久化且不会重复提交', async t=>{
  const f=fixture(t); f.setRows([row('old')]); await f.engine.poll(); assert.equal(f.store.data.inbox.length,0);
  f.setRows([row('old'),row('new')]); await f.engine.poll(); await f.engine.poll(); await f.engine.drain();
  assert.equal(f.store.data.inbox.length,1); assert.equal(f.store.data.inbox[0].status,'submitted');
  assert.equal(f.calls.filter(([m])=>m==='session/prompt').length,1);
});
test('DSH 故障保留消息，恢复后 requestId 不变',async t=>{
  const f=fixture(t); f.store.data.sessions.Alice='s'; f.store.ingest([row('id')],{});
  const real=f.api.callUnary; f.api.callUnary=async()=>{throw Error('offline');}; await f.engine.drain();
  assert.equal(f.store.data.inbox[0].status,'pending'); f.api.callUnary=real; await f.engine.drain();
  assert.equal(f.calls[0][1].requestId,'id');
});
test('发送幂等与目标/session 绑定',async t=>{
  const f=fixture(t); f.store.data.sessions.Alice='s';
  const a={to_user:'Alice',message:'hi',request_id:'send1',session_id:'s'};
  await Promise.all([f.engine.send(a),f.engine.send(a)]); assert.equal(f.sends.length,1);
  await assert.rejects(f.engine.send({...a,message:'different'}),/不同消息/);
  await assert.rejects(f.engine.send({...a,to_user:'Bob'}),/名单/);
  await assert.rejects(f.engine.send({...a,session_id:'other'}),/不匹配/);
});
test('发送失败不自动重试；重启保留 uncertain 状态',async t=>{
  const f=fixture(t); f.worker.call=async()=>{throw Error('timeout');};
  const a={to_user:'Alice',message:'hi',request_id:'x'};
  await assert.rejects(f.engine.send(a)); await assert.rejects(f.engine.send(a),/不确定/);
  const recovered=new Store(f.dir); assert.equal(recovered.data.outbox[0].status,'uncertain');
});
test('tools 模式不自动发最终文本，auto 模式发一次',async t=>{
  for(const replyMode of ['tools','auto']) {
    const f=fixture(t,{replyMode}); f.store.data.sessions.Alice='s';
    for(const event of [{seq:1,type:'turn/start',data:{turn:'t'}},{seq:2,type:'assistant/message',data:{turn:'t',message:{content:[{type:'text',text:'reply'}]}}},{seq:3,type:'turn/end',data:{turn:'t'}}]) await f.engine.frame({type:'session/event',sessionId:'s',event});
    await f.engine.flushOutbox(); assert.equal(f.sends.length,replyMode==='auto'?1:0);
  }
});
test('工具已发送后 auto 模式不重复转发',async t=>{
  const f=fixture(t,{replyMode:'auto'}); f.store.data.sessions.Alice='s';
  await f.engine.frame({type:'session/event',sessionId:'s',event:{seq:1,type:'turn/start',data:{turn:'t'}}});
  await f.engine.send({to_user:'Alice',message:'tool reply',request_id:'x',session_id:'s'});
  await f.engine.frame({type:'session/event',sessionId:'s',event:{seq:2,type:'assistant/message',data:{turn:'t',message:{content:[{type:'text',text:'final'}]}}}});
  await f.engine.frame({type:'session/event',sessionId:'s',event:{seq:3,type:'turn/end',data:{turn:'t'}}});
  await f.engine.flushOutbox(); assert.equal(f.sends.length,1);
});
test('群聊必须满足发送者名单与 @ 条件，自身消息默认忽略',()=>{
  const c={chats:[{name:'G',kind:'group',enabled:true,senders:['A'],mentionOnly:true,aliases:['Bot']}]};
  assert.equal(permitted(c,row('x','@Bot hi',{chat:'G',kind:'group',sender:'A'})),true);
  assert.equal(permitted(c,row('x','@Bot hi',{chat:'G',kind:'group',sender:'B'})),false);
  assert.equal(permitted(c,row('x','hi',{chat:'G',kind:'group',sender:'A'})),false);
});
test('重连快照回放游标后的未结束回合，不重发历史完成回合',async t=>{
  const f=fixture(t,{replyMode:'auto'}); f.store.data.sessions.Alice='s';
  await f.engine.frame({type:'session/event',sessionId:'s',event:{seq:1,type:'turn/start',data:{turn:'t'}}});
  const snapshot={records:[{event:{seq:2,type:'assistant/message',data:{turn:'t',message:{content:[{type:'text',text:'recovered'}]}}}},{event:{seq:3,type:'turn/end',data:{turn:'t'}}}]};
  await f.engine.frame({type:'session/snapshot',sessionId:'s',snapshot}); await f.engine.frame({type:'session/snapshot',sessionId:'s',snapshot});
  await f.engine.flushOutbox(); assert.equal(f.sends.length,1);
});
