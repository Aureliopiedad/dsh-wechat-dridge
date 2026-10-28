// Only generate a reviewable patch. Do not mutate an existing QQ/DSH profile.
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from '../src/config.js';
const quote = s => `'${s.replaceAll("'", "''")}'`;
const patch = `# 将此 insert 项合并到 DSH web profile 的 cordis.patch.yml；保留现有 QQ 条目。\n- insert:\n    - id: mcp-wechat-bridge\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: wechat\n        transport: stdio\n        command: ${quote(process.execPath)}\n        args:\n          - ${quote(path.join(ROOT, 'src', 'mcp-server.js'))}\n        toolCallTimeoutMs: 110000\n`;
fs.writeFileSync(path.join(ROOT, 'dsh-mcp.patch.yml'), patch);
fs.writeFileSync(path.join(ROOT, 'mcp.config.json'), JSON.stringify({mcpServers:{wechat:{command:process.execPath,args:[path.join(ROOT,'src','mcp-server.js')]}}},null,2));
console.log('已生成 dsh-mcp.patch.yml 与 mcp.config.json；没有修改 DSH 或 QQ 配置。');
