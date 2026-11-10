// Execute actual MCP callbacks and bridge handler source in isolated VM fixtures.
// No QQ/DSH connection or real save. This is not a Zod/stdio protocol test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CROPS, GARDEN_RULES } from '../public/room/garden-state.js';
import { serializeModelData } from '../src/qq-model-view.js';
import { apply as applyBoundary } from '../plugins/qq-agent-presets/qq-tool-restrict.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const mcp = read('src/mcp-snowluma-safe.js');
const bridge = read('src/bridge.js');
const plain = (v) => JSON.parse(JSON.stringify(v));
const actions = ['till', 'plant', 'water', 'fertilize', 'harvest', 'sell', 'buySeed', 'buyCompost', 'go', 'auto'];

function schema(kind, args) {
  const node = { kind, args, checks: [] };
  const receiver = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...params) => { target.checks.push([key, ...params]); return receiver; };
  } });
  return receiver;
}
async function registered(config = {}) {
  const tools = new Map(), calls = [];
  let response = { ok: true, accepted: true, garden: { care: { task: { phase: 'walking' } } } };
  const context = vm.createContext({
    fs: { readFileSync(file) {
      if (String(file).endsWith('config.json')) return JSON.stringify({ consoleToken: 'fixture-console-token', ...config });
      throw new Error('fixture file unavailable');
    } }, path, fileURLToPath, http: {}, URL, Buffer, AbortSignal, CROPS, GARDEN_RULES,
    serializeModelData, SENSITIVE_RE: /fixture-secret/, console: { log() {}, error() {} },
    z: new Proxy({}, { get: (_, kind) => (...args) => schema(kind, args) }),
    McpServer: class {
      tool(name, description, shape, callback) { tools.set(name, { description, shape, callback }); }
      async connect() {}
    },
    StdioServerTransport: class {},
    fetch: async (url, init) => { calls.push({ url: String(url), ...init }); return { ok: response.httpOk !== false, status: 403, json: async () => response }; }
  });
  const code = mcp.replace(/^import .+;\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../src/mcp-snowluma-safe.js', import.meta.url).href));
  await vm.runInContext('(async () => { ' + code + '\n })()', context);
  return { tools, calls, respond(value) { response = value; } };
}

function between(start, end, offset = 0) {
  const a = bridge.indexOf(start, offset), b = bridge.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'locate real handler: ' + start);
  return bridge.slice(a, b);
}
const central = between("      if (req.headers['x-agent-call'] !== undefined)", '      // CSRF 防护');
const guards = between("        if (req.headers['x-agent-token'] === '')", '        // 管理端专用 v2 接口');
const gardenHandler = between("        if ((req.method === 'GET' && url.pathname === '/api/socialV2/garden/state')", '        // ── 大平层：唯一快照');
async function request({ type = 'state', key = 'group:456', token = 'token-456', allowed = true, enabled = true, paused = false, mode = 'reserved2', socialEnabled = true, body = {}, rawBody, actionOk = true, rateCount = 0 } = {}) {
  const result = { response: null, ticks: 0, controls: [] };
  const headers = { 'x-agent-call': '1' };
  if (token !== null) headers['x-agent-token'] = token;
  const context = vm.createContext({
    req: { method: type === 'state' ? 'GET' : 'POST', headers },
    url: new URL('http://127.0.0.1/api/socialV2/garden/' + type + '?key=' + encodeURIComponent(key)),
    readBody: async () => rawBody === undefined ? ({ key, ...body }) : rawBody,
    sendJson: (data, status = 200) => { result.response = { status, data: plain(data) }; },
    isLiveAgentToken: (value) => value === 'token-456' || value === 'token-789',
    agentTokenOk: (session, value) => value === (session === 'group:456' ? 'token-456' : 'token-789'),
    v2SessionAllowed: () => allowed, v2ToolEnabled: () => enabled, canonicalV2Key: (key) => key,
    socialV2: { paused }, cfg: { socialV2: { enabled: socialEnabled } }, currentMode: mode,
    homeActTimes: Array.from({ length: rateCount }, () => Date.now()),
    homeTick: () => { result.ticks++; return { garden: { care: { task: { phase: 'walking' } } } }; },
    gardenCaretaker: { control: (action) => {
      result.controls.push(plain(action));
      return actionOk ? { ok: true, accepted: true, requestId: action.requestId, garden: { care: { task: { phase: 'walking' } } } } : { ok: false, message: '任务无法安排' };
    } },
    actGarden: () => { throw new Error('agent must queue physical work'); }, crypto
  });
  await vm.runInContext('(async () => { ' + central + '\n' + guards + '\n' + gardenHandler + '\n })()', context);
  return result;
}

test('MCP exposes all actions and twelve crops with bounded IDs and quantities', async () => {
  const { tools } = await registered();
  const state = tools.get('qq_garden_state'), act = tools.get('qq_garden_act');
  assert.ok(state && act);
  assert.deepEqual(plain(act.shape.type.args[0]), actions);
  assert.deepEqual(plain(act.shape.cropId.args[0]), CROPS.map((c) => c.id));
  assert.ok(act.shape.plotId.checks.some(([method, n]) => method === 'max' && n === 7));
  assert.ok(act.shape.quantity.checks.some(([method, n]) => method === 'max' && n === 99));
  assert.ok(act.shape.quantity.checks.some(([method]) => method === 'int'));
  for (const tool of [state, act]) assert.ok(tool.shape.token.checks.some(([method, n]) => method === 'min' && n === 1));
  assert.match(act.description, /先走到/);
  assert.match(act.description, /只表示已安排/);
});

test('disabled flags remove garden tools during registration', async () => {
  const { tools } = await registered({ socialV2: { tools: { gardenState: false, gardenAct: false } } });
  assert.ok(!tools.has('qq_garden_state') && !tools.has('qq_garden_act'));
  assert.ok(tools.has('qq_get_prompt'));
});

test('actual MCP callbacks use authenticated agent requests and preserve pending outcome', async () => {
  const h = await registered();
  await h.tools.get('qq_garden_state').callback({ key: 'group:456', token: 'token-456' });
  assert.match(h.calls[0].url, /\/api\/socialV2\/garden\/state\?key=group%3A456$/);
  for (const type of actions) {
    const output = await h.tools.get('qq_garden_act').callback({ key: 'group:456', token: 'token-456', type, plotId: 0, cropId: 'radish', quantity: 1, enabled: true, requestId: 'job-' + type });
    const call = h.calls.at(-1);
    assert.match(call.url, /\/api\/socialV2\/garden\/act$/);
    assert.equal(call.headers['x-agent-token'], 'token-456');
    assert.equal(call.headers['x-agent-call'], '1');
    assert.equal(call.headers['x-console-token'], 'fixture-console-token');
    assert.equal(JSON.parse(call.body).token, undefined);
    assert.equal(JSON.parse(call.body).type, type);
    const data = JSON.parse(output.content[0].text);
    assert.equal(data.accepted, true);
    assert.equal(data.garden.care.task.phase, 'walking');
  }
});

test('MCP exposes business and transport failures instead of claiming success', async () => {
  const h = await registered();
  for (const response of [{ ok: false, error: '队列已满' }, { httpOk: false, error: '工具已关闭' }]) {
    h.respond(response);
    const output = await h.tools.get('qq_garden_act').callback({ key: 'group:456', token: 'token-456', type: 'harvest', plotId: 0 });
    assert.equal(output.isError, true);
    assert.ok(output.content[0].text.includes(response.error));
  }
});

test('bridge rejects missing key, absent/bad/mismatched token, disallowed session and disabled tools', async () => {
  for (const override of [{ key: '' }, { token: null }, { token: '' }, { token: 'invalid' }, { key: 'group:789' }, { allowed: false }, { enabled: false }]) {
    for (const type of ['state', 'act']) {
      const r = await request({ type, body: { type: 'harvest', plotId: 0 }, ...override });
      assert.ok([400, 403].includes(r.response.status));
      assert.equal(r.ticks, 0); assert.equal(r.controls.length, 0);
    }
  }
});

test('bridge retains global AI pause, mode and enabled guards', async () => {
  for (const override of [{ paused: true }, { mode: 'chat' }, { socialEnabled: false }]) {
    for (const type of ['state', 'act']) {
      const r = await request({ type, ...override });
      assert.equal(r.response.status, 403);
      assert.equal(r.ticks, 0); assert.equal(r.controls.length, 0);
    }
  }
});

test('bridge reads state once and queues each action with accepted status', async () => {
  const readState = await request();
  assert.equal(readState.response.status, 200); assert.equal(readState.ticks, 1);
  for (const type of actions) {
    const r = await request({ type: 'act', body: { type, plotId: 0, cropId: 'radish', enabled: true } });
    assert.equal(r.response.status, 200); assert.equal(r.response.data.accepted, true);
    assert.equal(r.response.data.garden.care.task.phase, 'walking');
    assert.equal(r.controls.length, 1); assert.equal(r.controls[0].key, undefined);
    assert.equal(r.controls[0].type, type);
  }
});

test('bridge rejects rate limit and coordinator failures', async () => {
  const limited = await request({ type: 'act', body: { type: 'go' }, rateCount: 120 });
  assert.equal(limited.response.status, 429); assert.equal(limited.controls.length, 0);
  const failed = await request({ type: 'act', body: { type: 'go' }, actionOk: false });
  assert.equal(failed.response.status, 400); assert.equal(failed.response.data.ok, false);
  assert.equal(failed.response.data.error, '任务无法安排');
  for (const rawBody of [null, [], 12, 'go']) {
    const malformed = await request({ type: 'act', rawBody });
    assert.equal(malformed.response.status, 400); assert.equal(malformed.controls.length, 0);
  }
});

test('request IDs are validated and scoped per authenticated session before queuing', async () => {
  for (const requestId of ['', 123, 'bad space', 'x'.repeat(81)]) {
    const r = await request({ type: 'act', body: { type: 'go', requestId } });
    assert.equal(r.response.status, 400); assert.equal(r.controls.length, 0);
  }
  const opts = { type: 'act', body: { type: 'go', requestId: 'same-job' } };
  const first = await request(opts), retried = await request(opts);
  const other = await request({ ...opts, key: 'group:789', token: 'token-789' });
  assert.equal(first.response.status, 200); assert.equal(other.response.status, 200);
  assert.equal(first.controls[0].requestId, retried.controls[0].requestId);
  assert.notEqual(first.controls[0].requestId, other.controls[0].requestId);
  assert.match(first.controls[0].requestId, /^agent-[a-f0-9]{64}$/);
  assert.equal(first.response.data.requestId, 'same-job', 'caller receives its original retry identifier');
});

test('DSH boundary allows garden MCP tools while still rejecting local/admin tools', () => {
  let guard;
  applyBoundary({ tools: { restrict() {}, guard(fn) { guard = fn; } } });
  for (const name of ['mcp__snowluma__qq_garden_state', 'mcp__snowluma__qq_garden_act']) assert.equal(guard({ name }), undefined);
  for (const name of ['pwsh', 'read', 'write', 'terminal_send', 'plugin_manager']) assert.equal(typeof guard({ name }), 'string');
});

test('source preset, shipped bundle and config teach the same complete garden protocol', () => {
  for (const file of ['dsh/agent-presets/qq-chat-v2/agent.cordis.yml', 'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml']) {
    const source = read(file);
    for (const text of ['qq_garden_state', 'qq_garden_act', '翻土', '播种', '浇水', '施肥', '采收', '出售', '买种子', '买堆肥', 'type=go', 'type=auto', 'accepted/queued 只表示任务已安排', '不能说已经收获或出售']) assert.ok(source.includes(text), file + ': ' + text);
  }
  const config = JSON.parse(read('config.example.json'));
  assert.equal(config.socialV2.tools.gardenState, true); assert.equal(config.socialV2.tools.gardenAct, true);
  const consoleUi = read('public/console.html');
  assert.match(consoleUi, /data-v2-tool="gardenState"/); assert.match(consoleUi, /data-v2-tool="gardenAct"/);
});
