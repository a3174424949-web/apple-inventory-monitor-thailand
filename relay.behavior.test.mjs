import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

// 行为级验证 relay.js 的退避、分级冷却与流量抵扣：源码正则断言只能确认「写了什么」，这里用虚拟时钟
// 把它真正跑起来，确认「跑出来是什么」。2026-09-22 正是靠它抓到熔断值漏写 *1000 —— 把「熔断 30 分钟」
// 跑成了 1.8 秒，而这种单位错误是任何文本断言都发现不了的。
async function driveRelay({missUntil = 5} = {}) {
  const source = await readFile(new URL('./chrome-extension/relay.js', import.meta.url), 'utf8');
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const responses = [];
  const progresses = [];
  const logs = [];
  let fetches = 0;
  let currentConfig = {partNumbers: ['MJT74CH/A'], storeIds: ['R648'], interval: 60, revision: 0};
  let configTick = () => {};
  const okJson = JSON.stringify({head: {status: '200'}, body: {stores: []}});
  const notFound = '<html><title>Page Not Found - Apple</title></html>';

  const sandbox = {
    console: {log: (...args) => logs.push(args.join(' '))},
    Math, JSON, Date, Object, Number, Promise, Error, RegExp, String, Array, Boolean, Symbol, AbortSignal,
    URL, URLSearchParams,
    setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, {fn, at: now + ms}); return id; },
    clearTimeout: id => { timers.delete(id); },
    setInterval: fn => { configTick = fn; return 0; },
    location: {origin: 'https://www.apple.com.cn', href: 'https://www.apple.com.cn/'},
    navigator: {locks: {request: async (name, options, fn) => fn({name})}},
    fetch: async () => {
      fetches += 1;
      const ok = fetches >= missUntil;
      return {
        status: ok ? 200 : 541,
        headers: {entries: () => [].values()},
        text: async () => (ok ? okJson : notFound),
      };
    },
    chrome: {
      runtime: {
        getManifest: () => ({version: '1.4.4'}),
        onMessage: {addListener: handler => { sandbox.__onRuntimeMessage = handler; }},
        sendMessage: (message, callback) => {
          if (message.type === 'fulfillment-response') responses.push({t: now, ...message.payload});
          if (message.type === 'progress') progresses.push({t: now, ...message.payload});
          if (message.type === 'get-config' && typeof callback === 'function') {
            callback(currentConfig);
          }
          return true;
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = {addEventListener: (type, handler) => { if (type === 'message') sandbox.__onMessage = handler; }, postMessage() {}};

  vm.runInContext(source, vm.createContext(sandbox));

  const flush = () => new Promise(resolve => setImmediate(resolve));
  const settle = async () => { for (let i = 0; i < 6; i += 1) await flush(); };
  const advance = async ms => {
    now += ms;
    for (let guard = 0; guard < 40; guard += 1) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      for (const [id, timer] of due) { timers.delete(id); timer.fn(); await settle(); }
    }
    await settle();
  };
  // 模拟 Apple 页面自身发出的供货查询，relay 收到后应记一次「流量额度」并做非强制唤醒
  const pageRequest = () => sandbox.__onMessage?.({
    source: sandbox.window,
    origin: 'https://www.apple.com.cn',
    data: {
      source: 'apple-stock-bridge',
      type: 'fulfillment-request',
      payload: {url: 'https://www.apple.com.cn/shop/retail/pickup-message?pl=true&store=R648', method: 'GET', headers: {}},
    },
  });
  const pageResponse = payload => sandbox.__onMessage?.({
    source: sandbox.window,
    origin: 'https://www.apple.com.cn',
    data: {source: 'apple-stock-bridge', type: 'fulfillment-page-response', payload},
  });
  const saveConfig = value => { currentConfig = value; configTick(); };
  const pushConfig = value => { currentConfig = value; sandbox.__onRuntimeMessage?.({type: 'config-changed'}); };

  await settle();
  return {responses, progresses, advance, pageRequest, pageResponse, saveConfig, pushConfig, settle, count: () => fetches, logs};
}

test('541 连击进入分级冷却并逐档升档，探测成功即恢复全速，冷却期不被唤醒打断', async () => {
  const {responses, advance, pageRequest, settle, count} = await driveRelay({missUntil: 6});

  assert.equal(count(), 1);
  assert.equal(responses[0].retryAfter, 120, '第 1 次 541 应退避 120 秒');
  assert.equal(responses[0].coolingDown, false);

  await advance(240000);
  assert.equal(count(), 2);
  assert.equal(responses[1].retryAfter, 300, '第 2 次 541 应退避 300 秒');
  assert.equal(responses[1].coolingDown, false);

  await advance(480000);
  assert.equal(count(), 3);
  // 阶梯首档是 5 分钟：实测限流窗口约 10~15 分钟，改前一刀切 1800 秒会「等过头」。
  // 冷却值必须以毫秒表达（写成 300 会被当作 0.3 秒，冷却形同虚设）。
  assert.equal(responses[2].retryAfter, 300, '首次冷却应为 300 秒而非 1800 秒');
  assert.equal(responses[2].coolingDown, true);
  assert.equal(responses[2].cooldownStep, 0);

  // 冷却期内页面自发查询不得打断等待，否则会退化成数秒一次并续期 Apple 的限流窗口
  await advance(10000);
  const beforeCasualWake = count();
  pageRequest();
  await settle();
  assert.equal(count(), beforeCasualWake, '冷却期内不应因页面自发查询而重试');

  await advance(600000);
  assert.equal(count(), 4);
  // 探测失败 = 窗口仍在：直接升档，不再重新累计 3 次连击
  assert.equal(responses[3].retryAfter, 600, '探测失败应升档到 600 秒');
  assert.equal(responses[3].cooldownStep, 1);

  await advance(900000);
  assert.equal(count(), 5);
  assert.equal(responses[4].retryAfter, 1200, '再次失败应升档到 1200 秒');
  assert.equal(responses[4].cooldownStep, 2);

  await advance(1800000);
  assert.equal(count(), 6);
  assert.equal(responses[5].retryAfter, null, '探测成功应恢复全速');
  assert.equal(responses[5].coolingDown, false, '成功后应退出冷却');
  assert.equal(responses[5].probing, false);
});

test('保存新配置在健康等待时立即查询，541 退避时不强行唤醒', async () => {
  const healthy = await driveRelay({missUntil: 1});
  assert.equal(healthy.count(), 1);
  healthy.saveConfig({partNumbers: ['MJT74CH/A'], storeIds: ['R648'], interval: 60, revision: 1});
  await healthy.settle();
  assert.equal(healthy.count(), 2, '健康状态保存后应立即查询');

  const limited = await driveRelay({missUntil: 9});
  assert.equal(limited.count(), 1);
  limited.saveConfig({partNumbers: ['MJT74CH/A'], storeIds: ['R648'], interval: 60, revision: 1});
  await limited.settle();
  assert.equal(limited.count(), 1, '541 退避期间保存不应绕过等待');
});

test('官网页面自然产生的库存响应直接转发给本机看板', async () => {
  const relay = await driveRelay({missUntil: 1});
  const before = relay.responses.length;
  const payload = {status: 200, store: 'R648', payload: {head: {status: '200'}, body: {stores: []}}};
  relay.pageResponse(payload);
  await relay.settle();
  assert.equal(relay.responses.length, before + 1);
  assert.equal(relay.responses.at(-1).store, 'R648');
  assert.deepEqual(relay.responses.at(-1).payload, payload.payload);
});

test('保存到 Apple 响应携带同一个追踪版本和阶段时间', async () => {
  const relay = await driveRelay({missUntil: 1});
  relay.saveConfig({partNumbers: ['MJT74CH/A'], storeIds: ['R648'], interval: 60, revision: 7, traceStartedAt: 100});
  await relay.settle();
  const config = relay.progresses.find(row => row.stage === 'config' && row.revision === 7);
  const request = relay.progresses.find(row => row.stage === 'request' && row.revision === 7);
  const response = relay.responses.find(row => row.revision === 7);
  assert.ok(config?.extensionSeenAt >= 0);
  assert.ok(request?.requestStartedAt >= config.extensionSeenAt);
  assert.ok(response?.responseReceivedAt >= request.requestStartedAt);
});

test('后台推送配置变化会立即唤醒健康轮询',async()=>{
 const relay=await driveRelay({missUntil:1});assert.equal(relay.count(),1);
 relay.pushConfig({partNumbers:['MJT74CH/A'],storeIds:['R648'],interval:60,revision:9,traceStartedAt:100});
 await relay.settle();assert.equal(relay.count(),2);
 assert.ok(relay.progresses.some(row=>row.stage==='config'&&row.revision===9));
});
