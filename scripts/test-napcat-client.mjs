#!/usr/bin/env node
// NapCat/OneBot 11 适配器离线测试：不启动 NapCat，只验证 HTTP action、事件分发和消息格式。
import assert from 'node:assert/strict';
import http from 'node:http';
import { NapCatClient } from '../src/napcat-client.js';

const calls = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const action = req.url.replace(/^\/+/, '');
  calls.push({ action, auth: req.headers.authorization, body: body ? JSON.parse(body) : {} });
  res.setHeader('content-type', 'application/json');
  if (action === 'get_login_info') {
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: 'NapCat 测试' } }));
  } else if (action === 'send_private_msg') {
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 } }));
  } else if (action === 'send_group_msg') {
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 43 } }));
  } else {
    res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: 'not implemented' }));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const client = new NapCatClient({ url: 'ws://127.0.0.1:1', httpUrl: `http://127.0.0.1:${port}`, accessToken: 'test-token', reconnect: false });

const login = await client.getLoginInfo();
assert.equal(login.user_id, 10001);
assert.equal(calls[0].auth, 'Bearer test-token');

let privateEvent = null;
let groupEvent = null;
let noticeEvent = null;
client.onPrivateMessage((event) => { privateEvent = event; });
client.onGroupMessage((event) => { groupEvent = event; });
client.onNotice('notify', (event) => { noticeEvent = event; });
client._dispatch({ post_type: 'message', message_type: 'private', user_id: 2, raw_message: 'hi' });
client._dispatch({ post_type: 'message', message_type: 'group', group_id: 3, raw_message: 'hello' });
client._dispatch({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke' });
assert.equal(privateEvent.user_id, 2);
assert.equal(groupEvent.group_id, 3);
assert.equal(noticeEvent.sub_type, 'poke');

await client.sendPrivateMessage(2, 'hi');
await client.sendGroupMessage(3, [{ type: 'text', data: { text: 'hello' } }]);
assert.equal(calls.find((c) => c.action === 'send_private_msg').body.user_id, 2);
assert.equal(calls.find((c) => c.action === 'send_group_msg').body.group_id, 3);
assert.equal(Array.isArray(calls.find((c) => c.action === 'send_group_msg').body.message), true);

server.close();
console.log('NapCat 适配器测试通过：HTTP action、token、私聊/群聊/notice 分发、消息数组格式');
