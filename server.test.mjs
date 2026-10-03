import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createApp,formatCycleLog} from './server.mjs';

function fakeContext(){
 const context=new EventEmitter();const page={goto:async()=>{},bringToFront:async()=>{},url:()=>''};
 context.pages=()=>[page];context.close=async()=>context.emit('close');return context;
}
async function listen(app){await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${app.server.address().port}`;}
function post(base,path,origin=base){return fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Local-Action':'1'},body:'{}'});}

test('本机 API 保留来源保护、目录状态、重复任务和停止',async()=>{
 const context=fakeContext();const app=createApp({launch:async()=>context});const base=await listen(app);
 try{
  assert.equal((await post(base,'/api/prepare','https://evil.example')).status,403);
  const legacy=await post(base,'/api/start');assert.equal(legacy.status,400);assert.match((await legacy.json()).error,/日常 Chrome 扩展/);
  assert.equal((await post(base,'/api/prepare')).status,200);
  assert.equal((await post(base,'/api/start')).status,400);
  const state=await (await fetch(base+'/api/state')).json();
  assert.equal(state.catalog.length,32);assert.equal(state.catalog.some(product=>product.familyId==='iphone-duo'),false);assert.equal(state.stores.some(store=>store.id==='R557'&&store.province==='山东'),true);
  assert.deepEqual(state.selection.storeIds,['R557']);
  assert.doesNotMatch(JSON.stringify(state),/cookie|token|authorization/i);
  assert.equal((await post(base,'/api/stop')).status,200);
  assert.equal((await (await fetch(base+'/api/state')).json()).active,false);
 }finally{await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});

test('只接受单门店与多型号组合，并拒绝空选或多选门店',async()=>{
 const app=createApp({launch:async()=>fakeContext()});const base=await listen(app);
 try{
  const state=await (await fetch(base+'/api/state')).json();
  const max=state.catalog.find(product=>product.familyId==='iphone-18-pro-max');assert.ok(max);
  const empty=await fetch(base+'/api/config',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Local-Action':'1'},body:JSON.stringify({storeIds:[],partNumbers:['MJT74CH/A']})});
  assert.equal(empty.status,400);
  const multiple=await fetch(base+'/api/config',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Local-Action':'1'},body:JSON.stringify({storeIds:['R557','R648'],partNumbers:['MJT74CH/A',max.partNumber]})});assert.equal(multiple.status,400);
  const saved=await fetch(base+'/api/config',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Local-Action':'1'},body:JSON.stringify({storeIds:['R648'],partNumbers:['MJT74CH/A',max.partNumber]})});assert.equal(saved.status,200);
  const config=await (await fetch(base+'/api/bridge/config',{headers:{Origin:'chrome-extension://abcdefghijklmnop'}})).json();
  assert.deepEqual(config.partNumbers,['MJT74CH/A',max.partNumber]);assert.equal(config.stores.length,1);assert.deepEqual(config.storeIds,['R648']);
 }finally{await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});

test('全部地区的门店都可单选，跨省组合会被拒绝',async()=>{
 const app=createApp();const base=await listen(app);
 try{
  const state=await(await fetch(base+'/api/state')).json();
  assert.equal(state.stores.length,49);
  assert.equal(new Set(state.stores.map(store=>store.province)).size,17);
  for(const id of ['R557','R648','R471','R643','R502'])assert.ok(state.stores.some(store=>store.id===id),`缺少门店 ${id}`);
  const saved=await fetch(base+'/api/config',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Local-Action':'1'},body:JSON.stringify({storeIds:['R557','R471'],partNumbers:['MJT74CH/A']})});assert.equal(saved.status,400);
 }
 finally{await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});

test('Chrome 意外关闭后任务恢复为停止状态',async()=>{
 const context=fakeContext();const app=createApp({launch:async()=>context});const base=await listen(app);
 try{await post(base,'/api/prepare');context.emit('close');await new Promise(resolve=>setImmediate(resolve));assert.equal((await (await fetch(base+'/api/state')).json()).phase,'stopped');}
 finally{await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});

test('轮询日志包含轮次、家族结果、状态统计、错误码和重试时间',()=>{
 const text=formatCycleLog({cycle:3,interval:60,backoffReason:'APPLE_PAGE_NOT_FOUND',cycleSummary:{families:2,successful:0,failed:2,available:0,unavailable:0,unknown:32}});
 assert.equal(text,'第 3 轮：家族成功 0/2；可取货 0，暂无供应 0，未知 32；错误 APPLE_PAGE_NOT_FOUND；60 秒后重试。');
});

test('Chrome 扩展桥接只接受扩展来源并写入 bagx 库存',async()=>{
 const app=createApp({launch:async()=>fakeContext()});const base=await listen(app);
 const payload={body:{shoppingCart:{items:{item1:{delivery:{storeLocator:{searchResults:{d:{retailStores:[{
  storeId:'R557',storeName:'Apple 青岛万象城',availability:{lineItemAvailability:[{partName:'iPhone 18 Pro 256GB 黑色',availableNowForLine:true,availabilityQuote:'今天 可取货'}]}
 }]}}}}}}}}};
 const send=origin=>fetch(base+'/api/bridge/bagx',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Apple-Bridge':'1'},body:JSON.stringify(payload)});
 try{
  assert.equal((await send('https://evil.example')).status,403);
  assert.equal((await send('chrome-extension://abcdefghijklmnop')).status,200);
  const state=await (await fetch(base+'/api/state')).json();
  assert.equal(state.inventory['R557:MJT74CH/A'].status,'available');assert.equal(state.cartPartNumbers,undefined);assert.equal(state.bridgeConnected,true);assert.equal(state.phase,'bridge');
 }finally{await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});

test('Chrome 扩展心跳可标记已加载但尚未收到库存',async()=>{
 const app=createApp({launch:async()=>fakeContext()});const base=await listen(app);
 try{
  const response=await fetch(base+'/api/bridge/ready',{method:'POST',headers:{Origin:'chrome-extension://abcdefghijklmnop','Content-Type':'application/json','X-Apple-Bridge':'1'},body:'{}'});
  assert.equal(response.status,200);const ready=await response.json();assert.equal(ready.partNumbers.length,1);assert.deepEqual(ready.locations,['山东 青岛 市南区']);
  const state=await (await fetch(base+'/api/state')).json();
  assert.equal(state.bridgeLoaded,true);assert.equal(state.bridgeConnected,false);assert.equal(state.phase,'bridge_waiting');
  // 扩展未上报来源窗口时必须保持未知：默认成“普通窗口”会掩盖「无痕里扩展根本没运行」这一最常见情况
  assert.equal(state.bridgeIncognito,null);
  await fetch(base+'/api/bridge/ready',{method:'POST',headers:{Origin:'chrome-extension://abcdefghijklmnop','Content-Type':'application/json','X-Apple-Bridge':'1'},body:JSON.stringify({incognito:true})});
  assert.equal((await (await fetch(base+'/api/state')).json()).bridgeIncognito,true);
 }finally{await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});

test('扩展取得单选配置并提交 fulfillment 库存',async()=>{
 const app=createApp({launch:async()=>fakeContext()});const base=await listen(app);const headers={Origin:'chrome-extension://abcdefghijklmnop','X-Apple-Bridge':'1'};
 try{
  const configResponse=await fetch(base+'/api/bridge/config',{headers:{Origin:headers.Origin}});assert.equal(configResponse.status,200);
  const config=await configResponse.json();assert.equal(config.partNumbers.length,1);
  // 默认间隔 120 秒（2026-09-22 实测约 64~65 次请求即触发 541 拦截窗口，60 秒≈每小时撞一次）
  assert.equal(config.interval,120);
  const payload={head:{status:'200'},body:{stores:[{storeNumber:'R557',storeName:'Apple 青岛万象城',partsAvailability:{'MJT74CH/A':{pickupDisplay:'available',pickupSearchQuote:'今天可取货'}}}]}};
  const response=await fetch(base+'/api/bridge/fulfillment',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({status:200,store:'R557',payload})});assert.equal(response.status,200);
  await fetch(base+'/api/bridge/fulfillment',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({status:200,store:'R557',payload:{}})});
  const state=await (await fetch(base+'/api/state')).json();assert.equal(state.inventory['R557:MJT74CH/A'].status,'available');assert.equal(state.inventory['R557:MJT84CH/A'],undefined);assert.equal(state.phase,'bridge');
 }finally{await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});

test('扩展查询开始时写入门店和 SKU 进度日志',async()=>{
 const app=createApp();const base=await listen(app),headers={Origin:'chrome-extension://abcdefghijklmnop','X-Apple-Bridge':'1','Content-Type':'application/json'};
 try{const response=await fetch(base+'/api/bridge/progress',{method:'POST',headers,body:JSON.stringify({stage:'request',store:'R557',partNumber:'MJT74CH/A'})});assert.equal(response.status,200);const state=await(await fetch(base+'/api/state')).json();assert.equal(state.phase,'checking');assert.match(state.logs.at(-1).message,/青岛万象城.*MJT74CH\/A/);}
 finally{await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});

test('查询间隔可配置：保存后下发到扩展，非法值被拒',async()=>{
 const app=createApp();const base=await listen(app),headers={Origin:base,'X-Local-Action':'1','Content-Type':'application/json'};
 const save=body=>fetch(base+'/api/config',{method:'POST',headers,body:JSON.stringify(body)});
 try{
  // 默认 120 秒：实测约 64~65 次请求触发 541 窗口，60 秒间隔几乎每小时必撞线
  const initial=await(await fetch(base+'/api/bridge/config',{headers:{Origin:'chrome-extension://abcdefghijklmnop'}})).json();
  assert.equal(initial.interval,120);
  assert.equal(initial.revision,0);
  // 改成 300 秒后必须真的下发（此前 bridgeConfig 把它硬编码成 60，前端显示与生效值不一致）
  assert.equal((await save({storeIds:['R557'],partNumbers:['MJT74CH/A'],interval:300})).status,200);
  const saved=await(await fetch(base+'/api/bridge/config',{headers:{Origin:'chrome-extension://abcdefghijklmnop'}})).json();
  assert.equal(saved.interval,300);assert.equal(saved.revision,1);
  assert.equal((await(await fetch(base+'/api/state')).json()).interval,300);
  // 不带 interval 的老调用方沿用当前值，不因升级而报错
  assert.equal((await save({storeIds:['R648'],partNumbers:['MJT74CH/A']})).status,200);
  assert.equal((await(await fetch(base+'/api/state')).json()).interval,300);
  assert.equal((await(await fetch(base+'/api/bridge/config',{headers:{Origin:'chrome-extension://abcdefghijklmnop'}})).json()).revision,2);
  // 越界与非整数必须被拒
  for(const interval of [10,901,60.5,'abc',null])assert.equal((await save({storeIds:['R557'],partNumbers:['MJT74CH/A'],interval})).status,400);
  assert.equal((await(await fetch(base+'/api/state')).json()).interval,300);
 }finally{await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});

test('541 退避期间保存配置保留旧结果并显示下次探测时间',async()=>{
 const app=createApp();const base=await listen(app);
 const extensionHeaders={Origin:'chrome-extension://abcdefghijklmnop','X-Apple-Bridge':'1','Content-Type':'application/json'};
 const pageHeaders={Origin:base,'X-Local-Action':'1','Content-Type':'application/json'};
 try{
  const payload={head:{status:'200'},body:{stores:[{storeNumber:'R557',storeName:'Apple 青岛万象城',partsAvailability:{'MJT74CH/A':{pickupDisplay:'available',pickupSearchQuote:'今天可取货'}}}]}};
  await fetch(base+'/api/bridge/fulfillment',{method:'POST',headers:extensionHeaders,body:JSON.stringify({status:200,store:'R557',payload})});
  await fetch(base+'/api/bridge/fulfillment',{method:'POST',headers:extensionHeaders,body:JSON.stringify({status:541,store:'R557',retryAfter:300,payload:null})});
  const response=await fetch(base+'/api/config',{method:'POST',headers:pageHeaders,body:JSON.stringify({storeIds:['R557'],partNumbers:['MJT74CH/A'],interval:120})});
  const state=await response.json();
  assert.equal(state.inventory['R557:MJT74CH/A'].status,'available');
  assert.ok(state.nextCheck>Date.now());
  assert.match(state.message,/退避.*下次探测/);
 }finally{await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});

test('记录从保存点击到页面渲染通知的分段耗时',async()=>{
 const app=createApp();const base=await listen(app);
 const extensionHeaders={Origin:'chrome-extension://abcdefghijklmnop','X-Apple-Bridge':'1','Content-Type':'application/json'};
 const pageHeaders={Origin:base,'X-Local-Action':'1','Content-Type':'application/json'};
 try{
  const clickedAt=Date.now()-100;
  let state=await(await fetch(base+'/api/config',{method:'POST',headers:pageHeaders,body:JSON.stringify({storeIds:['R557'],partNumbers:['MJT74CH/A'],interval:120,traceStartedAt:clickedAt})})).json();
  const revision=1,savedAt=state.trace.savedAt;
  await fetch(base+'/api/bridge/progress',{method:'POST',headers:extensionHeaders,body:JSON.stringify({stage:'config',revision,extensionSeenAt:savedAt+10})});
  await fetch(base+'/api/bridge/progress',{method:'POST',headers:extensionHeaders,body:JSON.stringify({stage:'request',revision,store:'R557',partNumbers:['MJT74CH/A'],requestStartedAt:savedAt+20})});
  const payload={head:{status:'200'},body:{stores:[{storeNumber:'R557',partsAvailability:{'MJT74CH/A':{pickupDisplay:'unavailable',pickupSearchQuote:'暂无供应'}}}]}};
  await fetch(base+'/api/bridge/fulfillment',{method:'POST',headers:extensionHeaders,body:JSON.stringify({status:200,store:'R557',revision,requestStartedAt:savedAt+20,responseReceivedAt:savedAt+40,payload})});
  state=await(await fetch(base+'/api/trace',{method:'POST',headers:pageHeaders,body:JSON.stringify({revision,renderedAt:savedAt+60})})).json();
  assert.equal(state.trace.revision,revision);
  assert.equal(state.trace.renderedAt,savedAt+60);
  assert.match(state.logs.at(-1).message,/追踪 #1：总耗时.*保存请求.*等待扩展.*Apple 请求.*解析传输.*页面渲染\/通知/);
 }finally{await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});

test('扩展长轮询在保存配置后立即收到新 revision',async()=>{
 const app=createApp();const base=await listen(app);
 const extensionOrigin='chrome-extension://abcdefghijklmnop';
 const pageHeaders={Origin:base,'X-Local-Action':'1','Content-Type':'application/json'};
 try{
  const pending=fetch(base+'/api/bridge/watch?revision=0',{headers:{Origin:extensionOrigin}});
  await new Promise(resolve=>setTimeout(resolve,20));
  await fetch(base+'/api/config',{method:'POST',headers:pageHeaders,body:JSON.stringify({storeIds:['R557'],partNumbers:['MJT74CH/A'],interval:120})});
  const response=await pending;assert.equal(response.status,200);
  const config=await response.json();assert.equal(config.revision,1);assert.deepEqual(config.storeIds,['R557']);
 }finally{await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});
