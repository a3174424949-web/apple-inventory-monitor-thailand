import {createServer} from 'node:http';
import {readFile,appendFile,mkdir,stat,rename} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {catalog as rawCatalog,storeCatalog} from './config.mjs';
import {normalizeCatalog,parseBagxFulfillment,parseFulfillmentByStore,transition} from './inventory.mjs';
import {createMonitor} from './monitor.mjs';
import {fetchFamilyInventory} from './apple.mjs';

const root=new URL('./',import.meta.url);
const products=normalizeCatalog(rawCatalog.products);
// 此前的过滤（location 必须含「省 市 区」≥3 段）只留下山东两家门店，导致地区看板只剩山东；
// 门店查询只用泰国官方 storeId（R733 / R728），与 location 文本格式无关。
const stores=[...storeCatalog.stores].sort((a,b)=>`${a.province}${a.city}${a.name}`.localeCompare(`${b.province}${b.city}${b.name}`,'en'));

// 轮询间隔（秒）。默认 120 秒，上限 900 秒；云端版本默认 900 秒。
export const DEFAULT_INTERVAL=120;
export const INTERVAL_RANGE=[120,900];

export function formatCycleLog(snapshot){
 const s=snapshot.cycleSummary;
 const base=`第 ${snapshot.cycle} 轮：家族成功 ${s.successful}/${s.families}；可取货 ${s.available}，暂无供应 ${s.unavailable}，未知 ${s.unknown}`;
 return snapshot.backoffReason?`${base}；错误 ${snapshot.backoffReason}；${snapshot.interval} 秒后重试。`:`${base}；${snapshot.interval} 秒后继续。`;
}

// 每次 Apple 接口调用的落盘日志：.local/apple-api.log（每行一条 JSON）+ 终端同步可读行
const appleApiLogPath=new URL('.local/apple-api.log',root);
let appleApiLogReady=false;
async function ensureAppleApiLogDir(){if(appleApiLogReady)return;await mkdir(new URL('.local/',root),{recursive:true}).catch(()=>{});appleApiLogReady=true;}
export async function logAppleApi(entry){
 if(!entry||typeof entry!=='object')return;
 await ensureAppleApiLogDir();
 try{try{const st=await stat(appleApiLogPath);if(st.size>5*1024*1024)await rename(appleApiLogPath,new URL('.local/apple-api.log.1',root));}catch{}}catch{}
 await appendFile(appleApiLogPath,JSON.stringify(entry)+'\n').catch(()=>{});
 const ts=new Date(entry.t||Date.now()).toLocaleString('zh-CN',{hour12:false});
 const flag=entry.ok?'OK':(entry.reason==='PAGE_NOT_FOUND'?'PAGE_NOT_FOUND':'ERR');
 const method=entry.request?.method||'GET';
 const httpStatus=entry.response?.status??entry.status;
 const bodyLen=entry.response?.bodyLen??(typeof entry.response?.body==='string'?entry.response.body.length:0);
 console.log(`[apple-api] ${ts} [${flag}] ${method} store=${entry.store} part=${entry.partNumber} http=${httpStatus} bodyLen=${bodyLen} ${entry.latencyMs}ms${entry.incognito?' [incognito]':''}${entry.coolingDown?` [cooldown Lv${(entry.cooldownStep??0)+1}]`:''}${entry.reason&&entry.reason!=='PAGE_NOT_FOUND'?` reason=${entry.reason}`:''}`);
}

export function createApp({launch=()=>chromium.launchPersistentContext(fileURLToPath(new URL('.local/chrome',root)),{
 channel:'chrome',chromiumSandbox:true,headless:false,locale:'zh-CN',viewport:{width:1280,height:900},
}),fetchFamily=fetchFamilyInventory}={}){
 let job=null;
 const configWaiters=new Set();
 let selection={storeIds:['R733','R728'],partNumbers:['MJXP4ZP/A'],interval:DEFAULT_INTERVAL};
 let configRevision=0;
 const state={phase:'idle',active:false,bridgeLoaded:false,bridgeConnected:false,bridgeLastSeen:null,bridgeIncognito:null,stores,catalog:products,catalogDate:rawCatalog.checkedAt,selection,inventory:{},events:[],trace:null,cycle:0,successRate:0,interval:DEFAULT_INTERVAL,nextCheck:null,lastSuccess:null,backoffReason:null,message:'请选择泰国直营店和型号，扩展会自动同步库存。',logs:[]};
 function update(phase,message,extra={}){
  Object.assign(state,{phase,message,...extra});state.logs.push({time:Date.now(),phase,message});state.logs=state.logs.slice(-120);
 }
 async function run(current){
  try{
   current.context=await launch();
   current.context.on('close',()=>{if(current.closing)return;current.monitor?.stop();if(job===current){job=null;update('stopped','Chrome 已关闭，监控停止。',{active:false,nextCheck:null});}});
   current.page=current.context.pages()[0]??await current.context.newPage();
   await current.page.goto(products[0].productUrl,{waitUntil:'domcontentloaded',timeout:45000});
   if(current.mode==='setup'){update('setup','请在 Chrome 中正常完成位置选择或网站验证，然后返回控制台开始监控。');return;}
    current.monitor=createMonitor({catalog:products,fetchFamily:(family,signal)=>fetchFamily(current.page,family,signal,selectedStores()[0]),onState:snapshot=>{
    const phase=snapshot.backoffReason?'retry':'waiting';
    const message=snapshot.backoffReason==='APPLE_PAGE_NOT_FOUND'
     ?'Apple 供货接口向此独立 Chrome 会话返回 Page Not Found；库存未知，正在退避。可在 Chrome 中正常完成供货查询后重试。'
     :snapshot.backoffReason?`库存服务异常（${snapshot.backoffReason}），已自动退避。`:'本轮库存检查完成。';
    update(phase,formatCycleLog(snapshot),{...snapshot,active:true,message});
   }});
   update('checking','正在检查全部配置…');await current.monitor.start();
  }catch(error){if(error.name!=='AbortError')update('error',`浏览器运行失败：${error.message}`,{active:false,nextCheck:null});}
  finally{if(current.mode!=='setup'||current.stopping){current.closing=true;await current.context?.close();if(job===current)job=null;state.active=false;}}
 }
 async function stop(){
  const current=job;if(!current)return;current.stopping=true;current.monitor?.stop();current.closing=true;await current.context?.close();await current.done;if(job===current)job=null;
  update('stopped','监控已停止。',{active:false,nextCheck:null});
 }
 async function action(path){
  if(path==='/api/start')throw new Error('请使用日常 Chrome 扩展同步库存；独立 Chrome 监控已停用。');
  if(path==='/api/prepare'){
   if(job)throw new Error('已有任务运行，请先停止。');
   const current={mode:path==='/api/prepare'?'setup':'watch',closing:false,stopping:false};job=current;
   update('starting','正在打开 Google Chrome…',{active:true,inventory:{},events:[],cycle:0});current.done=run(current);return;
  }
  if(path==='/api/stop')return stop();
  if(path==='/api/focus'){if(!job?.page)throw new Error('浏览器尚未打开。');return job.page.bringToFront();}
  throw new Error('操作不存在。');
 }
 async function readJson(req,maxBytes){
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw Object.assign(new Error('请求过大。'),{status:413});chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString()||'{}');
 }
 async function applyBridgeInventory(parsed,now){
  if(job)await stop();const inventory={...state.inventory};const events=[...state.events];
  for(const [key,next] of Object.entries(parsed)){const partNumber=key.slice(key.indexOf(':')+1),product=products.find(row=>row.partNumber===partNumber),store=stores.find(row=>key.startsWith(`${row.id}:`));if(!product||!store||next.status==='unknown'&&['available','unavailable'].includes(inventory[key]?.status))continue;const change=transition(inventory[key],next,now,10000);inventory[key]=change.snapshot;if(change.notify)events.push({id:`${key}-${now}`,time:now,partNumber,...product,storeId:store.id,storeName:store.name,message:change.snapshot.message});}
  const counts=Object.values(inventory).reduce((sum,item)=>{sum[item.status]=(sum[item.status]??0)+1;return sum;},{});
  update('bridge',`日常 Chrome 已同步：可取货 ${counts.available??0}，暂无供应 ${counts.unavailable??0}，未知 ${counts.unknown??0}。`,{active:false,bridgeConnected:true,bridgeLastSeen:now,lastSuccess:now,backoffReason:null,nextCheck:null,inventory,events:events.slice(-120)});
 }
 async function acceptBagx(payload){const now=Date.now(),parsed={};for(const store of selectedStores())for(const [part,item] of Object.entries(parseBagxFulfillment(payload,selectedProducts(),`Apple ${store.name}`,now)))parsed[`${store.id}:${part}`]=item;return applyBridgeInventory(parsed,now);}
 const selectedProducts=()=>products.filter(product=>selection.partNumbers.includes(product.partNumber));
 const selectedStores=()=>stores.filter(store=>selection.storeIds.includes(store.id));
 // storeIds 按用户保存的顺序下发（门店目录按省/市/名称排序只用于界面展示），扩展据此轮转查询
 const bridgeConfig=()=>({partNumbers:selection.partNumbers,stores:selectedStores(),locations:[...new Set(selectedStores().map(store=>store.location))],storeIds:selection.storeIds.filter(id=>stores.some(store=>store.id===id)),interval:selection.interval??DEFAULT_INTERVAL,revision:configRevision,traceStartedAt:state.trace?.clickedAt??null});
 const notifyConfigWaiters=()=>{for(const finish of [...configWaiters])finish();};
 async function acceptFulfillment(result){
  const status=Number(result?.payload?.head?.status) || result?.status;
  if(status!==200||!result.payload){
    const retry=result?.retryAfter;
    const permanent=result?.reason==='PAGE_NOT_FOUND';
    const reason=permanent?'APPLE_PAGE_NOT_FOUND':`APPLE_${status??'UNKNOWN'}`;
    // 区分“门店/货号配置未被识别”（需人工修正选择）与“瞬时限流”（自动退避重试）
    const message=permanent
      ? `Apple 供货接口返回 Page Not Found：所选门店或货号配置未被识别，请检查地区/门店/型号选择（状态 ${status??'未知'}）。`
      : `日常 Chrome 库存请求失败（状态 ${status??'未知'}），${retry?`约 ${retry} 秒后重试`:'扩展将自动退避'}。若持续出现，请在 Chrome 中正常刷新或重新登录 Apple 页面后再试。`;
    update('retry',message,{bridgeLoaded:true,bridgeConnected:true,backoffReason:reason,interval:retry??state.interval,nextCheck:retry?Date.now()+retry*1000:null,needsSessionRefresh:!permanent&&(result?.coolingDown||(retry&&retry>=1800))});
    return;
  }
  const now=Date.now(),scope=result.store?selectedStores().filter(store=>store.id===result.store):selectedStores();await applyBridgeInventory(parseFulfillmentByStore(result.payload,selection.partNumbers,scope,now),now);
  if(state.trace&&state.trace.revision===result.revision)Object.assign(state.trace,{requestStartedAt:result.requestStartedAt??state.trace.requestStartedAt,responseReceivedAt:result.responseReceivedAt??now,parsedAt:Date.now()});
 }
 function acceptProgress(progress){
  if(progress?.stage==='config'&&state.trace&&state.trace.revision===progress.revision){state.trace.extensionSeenAt=progress.extensionSeenAt??Date.now();return;}
  const store=progress?.store?selectedStores().find(s=>s.id===progress.store):selectedStores()[0];
  const requested=Array.isArray(progress?.partNumbers)?progress.partNumbers:(progress?.partNumber?[progress.partNumber]:[]),parts=requested.filter(part=>selection.partNumbers.includes(part));
  if(progress?.stage!=='request'||!parts.length||!store)throw new Error('查询进度无效。');
  if(state.trace&&state.trace.revision===progress.revision)state.trace.requestStartedAt=progress.requestStartedAt??Date.now();
  const product=products.find(row=>row.partNumber===parts[0]),label=parts.length>1?`${product.modelName} 等 ${parts.length} 个配置`:`${product.modelName} ${product.capacity} ${product.colorName}（${product.partNumber}）`;update('checking',`正在查询 Apple ${store.name}：${label}。`,{bridgeLoaded:true,bridgeConnected:true});
 }
 function saveSelection(input){
  if(!Array.isArray(input?.storeIds)||input.storeIds.length<1||input.storeIds.length>2||input.storeIds.some(id=>!stores.some(store=>store.id===id)))throw new Error('请选择一家或两家泰国直营店。');
  if(!Array.isArray(input?.partNumbers)||!input.partNumbers.length||input.partNumbers.some(part=>!products.some(product=>product.partNumber===part)))throw new Error('请至少选择一个有效型号配置。');
  // 间隔是可选项：老调用方（以及浏览器里缓存的旧选择）不带该字段时沿用当前值，不因升级而报错
  const interval=input?.interval===undefined?(selection.interval??DEFAULT_INTERVAL):Number(input.interval);
  if(!Number.isInteger(interval)||interval<INTERVAL_RANGE[0]||interval>INTERVAL_RANGE[1])throw new Error(`查询间隔应为 ${INTERVAL_RANGE[0]}–${INTERVAL_RANGE[1]} 秒的整数。`);
  selection={storeIds:[...new Set(input.storeIds)],partNumbers:[...new Set(input.partNumbers)],interval};state.selection=selection;state.interval=interval;
  configRevision+=1;
  const clickedAt=Number(input?.traceStartedAt);state.trace={revision:configRevision,clickedAt:Number.isFinite(clickedAt)?clickedAt:Date.now(),savedAt:Date.now()};
  state.inventory=Object.fromEntries(Object.entries(state.inventory).filter(([key])=>selection.storeIds.some(store=>key.startsWith(`${store}:`))&&selection.partNumbers.some(part=>key.endsWith(`:${part}`))));
  const cooling=state.nextCheck>Date.now()&&state.backoffReason;
  update(cooling?'retry':'bridge_waiting',cooling?`选择已保存；当前处于退避，下次探测约 ${new Date(state.nextCheck).toLocaleTimeString('zh-CN',{hour12:false})}。`:`选择已保存，扩展将立即查询；常规间隔 ${interval} 秒。`);
  notifyConfigWaiters();
 }
 function finishTrace(input){
  const trace=state.trace;if(!trace||trace.revision!==input?.revision||!trace.parsedAt)throw new Error('追踪记录尚未完成。');trace.renderedAt=Number(input.renderedAt)||Date.now();
  const ms=(a,b)=>Math.max(0,(b??a)-(a??b)),total=ms(trace.clickedAt,trace.renderedAt),save=ms(trace.clickedAt,trace.savedAt),extension=ms(trace.savedAt,trace.extensionSeenAt),apple=ms(trace.requestStartedAt,trace.responseReceivedAt),bridge=ms(trace.responseReceivedAt,trace.parsedAt),render=ms(trace.parsedAt,trace.renderedAt);
  update(state.phase,`追踪 #${trace.revision}：总耗时 ${total}ms；保存请求 ${save}ms｜等待扩展 ${extension}ms｜Apple 请求 ${apple}ms｜解析传输 ${bridge}ms｜页面渲染/通知 ${render}ms。`);
 }
 const server=createServer(async(req,res)=>{
  const origin=`http://127.0.0.1:${server.address().port}`;
  const requestUrl=new URL(req.url,origin),pathname=requestUrl.pathname;
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"};
  const send=(code,data)=>{res.writeHead(code,headers);res.end(JSON.stringify(data));};
  if(req.headers.host!==new URL(origin).host)return send(403,{error:'只允许本机访问。'});
  try{
   if(req.method==='GET'&&req.url==='/api/state')return send(200,state);
   const extensionOrigin=req.headers.origin??'';
   if(req.method==='GET'&&pathname==='/api/bridge/watch'&&/^chrome-extension:\/\/[a-p]{16,64}$/.test(extensionOrigin)){
    const bridgeHeaders={...headers,'Access-Control-Allow-Origin':extensionOrigin};
    const known=Number(requestUrl.searchParams.get('revision'));
    if(!Number.isFinite(known)||known<configRevision){res.writeHead(200,bridgeHeaders);res.end(JSON.stringify(bridgeConfig()));return;}
    await new Promise(resolve=>{let timer;const finish=()=>{clearTimeout(timer);configWaiters.delete(finish);if(!res.writableEnded){res.writeHead(200,bridgeHeaders);res.end(JSON.stringify(bridgeConfig()));}resolve();};configWaiters.add(finish);timer=setTimeout(finish,20000);res.once('close',()=>{configWaiters.delete(finish);clearTimeout(timer);resolve();});});return;
   }
   if(['/api/bridge/config','/api/bridge/ready','/api/bridge/bagx','/api/bridge/fulfillment','/api/bridge/progress','/api/bridge/log'].includes(req.url)&&/^chrome-extension:\/\/[a-p]{16,64}$/.test(extensionOrigin)){
    const bridgeHeaders={...headers,'Access-Control-Allow-Origin':extensionOrigin,'Access-Control-Allow-Headers':'content-type,x-apple-bridge','Access-Control-Allow-Methods':'POST,OPTIONS'};
    const bridgeSend=(code,data)=>{res.writeHead(code,bridgeHeaders);res.end(data===undefined?'':JSON.stringify(data));};
    if(req.method==='OPTIONS')return bridgeSend(204);
    if(req.url==='/api/bridge/config'&&req.method==='GET')return bridgeSend(200,bridgeConfig());
    if(req.method!=='POST'||req.headers['x-apple-bridge']!=='1'||req.headers['content-type']!=='application/json')return bridgeSend(403,{error:'桥接请求无效。'});
    try{
     const payload=await readJson(req,2*1024*1024);
     // 记录最近一次桥接请求来自普通窗口还是无痕窗口，供看板标注数据来源
     if(typeof payload?.incognito==='boolean')state.bridgeIncognito=payload.incognito;
     if(req.url==='/api/bridge/ready'){if(!state.bridgeLoaded)update('bridge_waiting','Chrome 扩展已加载，等待 Apple 页面产生库存响应。',{active:false,bridgeLoaded:true,bridgeConnected:false});else state.bridgeLastSeen=Date.now();return bridgeSend(200,bridgeConfig());}
     else if(req.url==='/api/bridge/bagx')await acceptBagx(payload);
     else if(req.url==='/api/bridge/progress')acceptProgress(payload);
     else if(req.url==='/api/bridge/log')await logAppleApi(payload);
     else await acceptFulfillment(payload);
     return bridgeSend(200,{ok:true});
    }catch(error){return bridgeSend(error.status??400,{error:error instanceof SyntaxError?'响应格式不正确。':error.message});}
   }
   if(req.method==='POST'){
    if(req.headers.origin!==origin||req.headers['x-local-action']!=='1'||req.headers['content-type']!=='application/json')return send(403,{error:'请求来源无效，请从本机页面操作。'});
    const body=await readJson(req,65536);if(req.url==='/api/config')saveSelection(body);else if(req.url==='/api/trace')finishTrace(body);else await action(req.url);return send(200,state);
   }
   const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
   if(req.method!=='GET'||!files[pathname])return send(404,{error:'页面不存在。'});
   const [file,type]=files[pathname];const data=await readFile(new URL(`web/${file}`,root));res.writeHead(200,{...headers,'Content-Type':`${type}; charset=utf-8`});res.end(data);
  }catch(error){send(400,{error:error instanceof SyntaxError?'请求格式不正确。':error.message});}
 });
 return {server,stop};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const app=createApp();app.server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'端口 4318 已占用，请先关闭旧服务。':error.message);process.exitCode=1;});
 app.server.listen(4318,'127.0.0.1',()=>console.log('库存看板：http://127.0.0.1:4318'));
 process.on('SIGINT',async()=>{await app.stop();app.server.close(()=>process.exit(0));});
}
