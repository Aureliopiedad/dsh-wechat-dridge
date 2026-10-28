import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {buildMcp} from '../src/mcp-server.js';
import {NodeApiClient} from '../src/dsh-client.js';
import {WebSocketServer} from 'ws';
import {serve} from '../src/http.js';
test('真实 MCP SDK 握手、列出工具、调用工具、schema 校验',async()=>{
  const calls=[];
  const server=buildMcp(async(method,params)=>{calls.push({method,params});return {content:[{type:'text',text:JSON.stringify({status:'submitted'})}]};});
  const client=new Client({name:'test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const listed=await client.listTools(); assert.equal(listed.tools.length,4);
    const result=await client.callTool({name:'wechat_send_message',arguments:{to_user:'Alice',message:'hello',request_id:'r',session_id:'s'}});
    assert.equal(result.isError,undefined); assert.equal(calls[0].method,'send_message');
    const invalid=await client.callTool({name:'wechat_send_message',arguments:{to_user:'Alice',message:'hello'}});
    assert.equal(invalid.isError,true); assert.equal(calls.length,1);
  } finally {await client.close();await server.close();}
});
test('复用 DSH 客户端实际生成 slash RPC、args/request、稳定 requestId',async()=>{
  const api=new NodeApiClient('http://127.0.0.1:3080');
  const seen=[];
  api.doFetch=async(url,options)=>{
    const message=JSON.parse(options.body); seen.push({url:String(url),message});
    return new Response(JSON.stringify({type:'server-response',rpcId:message.rpcId,result:{ok:true,value:{accepted:true}}}),{headers:{'Content-Type':'application/json'}});
  };
  const result=await api.callUnary('session/prompt',{sessionId:'s',requestId:'stable',mode:'queue',content:[]});
  assert.equal(result.result.ok,true);
  assert.ok(seen[0].url.endsWith('/api/session/prompt'));
  assert.equal(seen[0].message.payload.args.request.requestId,'stable');
});
test('本机 HTTP 控制接口拒绝无凭据请求，授权请求可调用发送',async()=>{
  const sent=[];
  const engine={send:async p=>{sent.push(p);return {status:'submitted'};}};
  const server=await serve(engine,'test-token',0);
  try {
    const url=`http://127.0.0.1:${server.address().port}/rpc`;
    const bad=await fetch(url,{method:'POST',body:'{}'}); assert.equal(bad.status,401);
    const good=await fetch(url,{method:'POST',headers:{Authorization:'Bearer test-token'},body:JSON.stringify({method:'send_message',params:{to_user:'Alice',message:'hi'}})});
    assert.equal((await good.json()).value.status,'submitted'); assert.equal(sent.length,1);
  } finally {await new Promise(r=>server.close(r));}
});
test('真实 WebSocket mux 发送 Cookie、订阅会话、接收事件并关闭',async()=>{
  const wss=new WebSocketServer({port:0,host:'127.0.0.1'});
  await new Promise(r=>wss.once('listening',r));
  let cookie,follow;
  wss.on('connection',(socket,req)=>{
    cookie=req.headers.cookie;
    socket.on('message',data=>{
      const frame=JSON.parse(data);
      if(frame.endpoint==='session/follow') {
        follow=frame.payload.args.request.address.sessionId;
        socket.send(JSON.stringify({type:'item',streamId:frame.streamId,value:{type:'event',event:{seq:1,type:'turn/start',data:{turn:'t'}}}}));
      }
    });
  });
  const api=new NodeApiClient(`http://127.0.0.1:${wss.address().port}`);
  api.ensureAuth=async()=>{api.cookie='test-cookie=ok';return api.cookie;};
  api.events.follow('s');
  const abort=new AbortController();
  const timer=setTimeout(()=>abort.abort(),3000);
  try {
    for await(const env of api.events.mux({},abort.signal)) {
      assert.equal(env.payload.sessionId,'s'); assert.equal(env.payload.event.type,'turn/start');break;
    }
    assert.equal(cookie,'test-cookie=ok'); assert.equal(follow,'s');
  } finally {clearTimeout(timer);abort.abort();for(const c of wss.clients)c.terminate();await new Promise(r=>wss.close(r));}
});
