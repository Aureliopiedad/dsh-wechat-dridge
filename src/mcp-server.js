import fs from 'node:fs';
import path from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {pathToFileURL} from 'node:url';
import {ROOT, loadConfig} from './config.js';
let config;
async function call(method, params) {
  try {
    const token = fs.readFileSync(path.join(ROOT, 'state', 'mcp-token'), 'utf8').trim();
    const r = await fetch(`http://127.0.0.1:${config.http.port}/rpc`, {method: 'POST', headers: {'Content-Type':'application/json', Authorization:`Bearer ${token}`}, body: JSON.stringify({method, params}), signal: AbortSignal.timeout(100000)});
    const body = await r.json();
    if (!r.ok || !body.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return {content: [{type: 'text', text: JSON.stringify(body.value)}]};
  } catch (e) {return {isError: true, content: [{type:'text', text: `微信 bridge 调用失败：${e.message}。请确认 npm start 正在运行。`}]};}
}
const target = z.string().min(1).describe('已启用聊天的精确名称');
const requestId = z.string().min(1).max(200).describe('本次发送的唯一标识；重试必须使用同一标识，避免重复发送');
const sessionId = z.string().min(1).describe('当前微信消息提示中提供的 DSH sessionId，必须与目标聊天匹配');
export function buildMcp(invoke = call) {
const server = new McpServer({name: 'wechat', version: '0.1.0'});
server.registerTool('wechat_send_message', {description:'向已启用的微信聊天发送一条文本。结果 submitted 表示 UI 操作成功，不代表对方送达确认。', inputSchema:{to_user:target, message:z.string().min(1), request_id:requestId, session_id:sessionId}}, args => invoke('send_message', args));
server.registerTool('wechat_send_file', {description:'向当前微信聊天发送一个本地文件。', inputSchema:{to_user:target, file:z.string().min(1), request_id:requestId, session_id:sessionId}}, args => invoke('send_file', args));
server.registerTool('wechat_get_recent_messages', {description:'读取 bridge 启动后捕获的消息；不是微信完整历史记录。', inputSchema:{to_user:target, limit:z.number().int().min(1).max(100).optional()}}, args => invoke('recent', args));
server.registerTool('wechat_status', {description:'查询 bridge 队列和不确定发送状态。', inputSchema:{}}, () => invoke('status', {}));
return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  config = loadConfig();
  await buildMcp().connect(new StdioServerTransport());
}
