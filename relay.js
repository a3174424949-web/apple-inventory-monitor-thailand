const send=(...args)=>globalThis.chrome?.runtime?.sendMessage?.(...args);
let config=null,configSignature='',polling=false,claiming=false,wake=null,requestTemplate=null;
const lockName=`apple-stock-monitor-${chrome.runtime.getManifest().version}`;
// 本页面是否运行在无痕窗口。这个标记必须落进日志：无痕窗口默认不加载扩展（manifest 未声明
// incognito 键，且需在扩展详情页手动打开「允许在无痕模式下运行」），此时无痕里根本不会有本脚本，
// 也就不会有任何请求——「无痕不 541」于是可能只是「无痕没在轮询」。把它记下来，才能把猜测
// 变成本机可核对的事实（2026-09-22）。取值失败一律按 false，绝不让它影响轮询主流程。
const inIncognito=(()=>{try{return chrome.extension?.inIncognitoContext===true;}catch{return false;}})();
// 唤醒等待。allowCasual=true 时任何唤醒都能提前结束等待；false 时只接受「强制唤醒」（配置变更）。
// 退避与冷却期间必须传 false：否则页面自发查询带来的顺带唤醒会让重试绕过退避，
// 密集重试会持续续期 Apple 的临时限流窗口（2026-09-22 实测：窗口期内每 3-13 秒一次）。
const wait=(ms,allowCasual=true)=>new Promise(resolve=>{const finish=()=>{wake=null;resolve();};const timer=setTimeout(finish,ms);wake=force=>{if(force||allowCasual){clearTimeout(timer);finish();}};});
// ±30% 随机抖动，避免固定节奏被识别为脚本
const jitter=ms=>Math.round(ms*(0.7+Math.random()*0.6));
// 分级冷却阶梯（秒）：5 / 10 / 20 / 30 分钟。2026-09-22 实测 541 窗口约 10~15 分钟自行解除，
// 而原先一次性熔断 1800 秒很可能「等过头」——窗口早已解除却还在干等。
// 改为阶梯升档：首次撞线只停 5 分钟，到点先发一次探测，成功即恢复全速，失败则升下一档。
const COOLDOWN_STEPS=[300,600,1200,1800];
// Apple 现网零售自提库存接口，也是本工具唯一会请求的端点
const PICKUP_PATH='/th/shop/fulfillment-messages';
// 复用页面真实请求头。注意：2026-09-22 实测证明请求头组合对 541 无影响（裸请求与完整浏览器头结果一致、
// 限流窗口内均 541），此处保留只是让请求形态贴近真实页面，并不承担“降低 541”的职责。
const SAFE_HEADERS=['accept','accept-language','sec-ch-ua','sec-ch-ua-mobile','sec-ch-ua-platform','sec-fetch-dest','sec-fetch-mode','sec-fetch-site','sec-fetch-user','upgrade-insecure-requests'];
function templateHeaders(){if(!requestTemplate?.headers)return {};const out={};for(const key of SAFE_HEADERS){const v=requestTemplate.headers[key];if(v)out[key]=v;}return out;}
// 始终按已实测返回 200 的参数集自行构造请求：一次请求可带多个货号（parts.0..parts.N-1），但只能指定一个门店，
// 因此多选货号不增加请求数。
// 这里刻意【不】复用页面捕获到的 query 结构：页面可能仍在请求旧的供货查询端点，
// 原样重放会把请求打回旧端点（2026-09-22 线上事故：落到旧端点恒返 541 + Page Not Found）。
// 捕获到的模板只用于复用可见请求头，绝不参与路径构造。
function buildPath(storeNumber,partNumbers){
 const params=new URLSearchParams();
 params.set('pl','true');
 params.set('mts.0','regular');
 params.set('store',storeNumber);
 partNumbers.forEach((part,index)=>params.set(`parts.${index}`,part));
 return `${PICKUP_PATH}?${params}`;
}
async function poll(){
 let failures=0,consecutive541=0,downshift=1,cursor=0,lastConfig=null,cooldownLevel=0,probing=false;
 while(true){
  const current=config;
  if(!current?.partNumbers?.length||!current?.storeIds?.length){await wait(2000);continue;}
  // 轮转调度：每轮只查一个门店，并把全部已选货号合并进同一次请求。
  // 于是总请求频率恒为 1 次 / interval，与所选门店数、货号数无关——目标越多，单店被刷新的间隔越长。
  if(current!==lastConfig){lastConfig=current;cursor=0;}
  // 正常节奏取自本机配置（默认 120 秒）；过短间隔更容易触发临时限流。
  const intervalSecs=Number(current.interval)||120;
  const storeId=current.storeIds[cursor%current.storeIds.length],partNumbers=current.partNumbers;
  cursor=(cursor+1)%current.storeIds.length;
  const partLabels=partNumbers.length>1?`${partNumbers[0]} 等 ${partNumbers.length} 个货号`:partNumbers[0];
  const requestStartedAt=Date.now();
  send({type:'progress',payload:{stage:'request',store:storeId,partNumbers,revision:current.revision,requestStartedAt}});
  let status=0,payload=null,reason=null,text='';
  let httpStatus=0,respHeaders=null,reqHeaders=null;
  const requestPath=buildPath(storeId,partNumbers);
  const startedAt=requestStartedAt;
  try{
   reqHeaders=Object.assign({Accept:'application/json'},templateHeaders());
   const response=await fetch(requestPath,{method:'GET',credentials:'include',headers:reqHeaders,signal:AbortSignal.timeout(20000)});
   httpStatus=response.status;
   respHeaders=Object.fromEntries(response.headers.entries());
   text=await response.text();
   try{payload=JSON.parse(text);}catch{}
   status=Number(payload?.head?.status)||response.status;
   // Apple 的 541 一律是伪装成 404 的限流页（2026-09-22 实测：同一请求先在限流窗口内返回 541、
   // 窗口到期后自行恢复 200，与门店/货号配置无关）。此处仅作日志标记，冷却退避一律按 541 处理。
   if(status===541&&/Page Not Found/i.test(text))reason='PAGE_NOT_FOUND';
  }catch{}
  const ok=status===200&&payload;
  failures=ok?0:Math.min(failures+1,4);
  // 所有 541 都计入连击。Apple 的 541 一律伴随 "Page Not Found" 伪装页，所以此处【不能】用
  // reason 排除 PAGE_NOT_FOUND 作条件——那会让计数恒为 0，使下面的 1800 秒熔断分支永远进不去
  // （2026-09-22 实测：14 条 541 全部 cooldown=false，熔断从未生效）。
  consecutive541=status===541?consecutive541+1:0;
  if(ok)downshift=Math.max(1,downshift-1);
  // 原「出现 Page Not Found 即丢弃请求模板」的自愈已移除：2026-09-22 实测证明 541 是限流窗口、
  // 而非请求形态失效——裸请求与完整浏览器头在窗口内均 541、窗口到期后均 200，与请求头无关。
  // 保留该逻辑只会白白放弃对页面真实请求头的复用，并无保护作用。
  // 退避与分级冷却。三种来源：
  // ① 正常 → interval（默认 120 秒）；② 未达连击阈值的失败 → [120,240,300,600,900][失败数]×downshift；
  // ③ 连击 3 次、或冷却结束后的探测再次失败 → 进入 COOLDOWN_STEPS（5/10/20/30 分钟）并升档。
  // 单位必须是毫秒：阶梯值要 ×1000。此前熔断写成 1800 被当作 1.8 秒，
  // 于是“熔断 30 分钟”实际只停约 2 秒（2026-09-22 行为验证抓到：retryAfter 输出 2）。
  let delay,cooldownStep=null;
  if(probing&&!ok){
   // 探测失败 = 限流窗口仍在。不重新累计 3 次，直接升档再次冷却，
   // 否则「刚探测失败 → 又退避 3 次 → 再进冷却」会在窗口期内多打出几次请求。
   cooldownStep=Math.min(cooldownLevel,COOLDOWN_STEPS.length-1);
   delay=COOLDOWN_STEPS[cooldownStep]*1000;
   cooldownLevel=Math.min(cooldownLevel+1,COOLDOWN_STEPS.length-1);
   consecutive541=Math.max(consecutive541,3);
   downshift=Math.min(downshift*2,8);
  }else if(consecutive541>=3){
   cooldownStep=Math.min(cooldownLevel,COOLDOWN_STEPS.length-1);
   delay=COOLDOWN_STEPS[cooldownStep]*1000;
   cooldownLevel=Math.min(cooldownLevel+1,COOLDOWN_STEPS.length-1);
   probing=true;
   downshift=Math.min(downshift*2,8);
  }else{
   delay=(failures===0?intervalSecs:[60,120,300,600,900][failures])*1000*downshift;
  }
  // 探测成功 = 限流窗口确已解除：清空冷却档位与降频，恢复全速（下次再撞线从 5 分钟重新起步）
  if(ok&&probing){probing=false;cooldownLevel=0;downshift=1;}
  const coolingDown=probing||consecutive541>=3;
  const responseReceivedAt=Date.now();
  send({type:'fulfillment-response',payload:{status,store:storeId,partNumber:partLabels,partNumbers,payload,reason,retryAfter:ok?null:Math.round(delay/1000),coolingDown,cooldownStep,probing,revision:current.revision,requestStartedAt,responseReceivedAt}});
  const latencyMs=Date.now()-startedAt,apiOk=status===200&&!!payload;
  // 全量入参/出参日志：请求(method/url/headers/body) + 响应(status/headers/body)，便于逐次核对 Apple 接口
  const reqObj={method:'GET',url:location.origin+requestPath,headers:reqHeaders||{},body:null};
  let respBody=text??'',respBodyTruncated=false;
  if(typeof respBody==='string'&&respBody.length>65536){respBody=respBody.slice(0,65536);respBodyTruncated=true;}
  const respObj={status:httpStatus,headers:respHeaders||{},body:respBody,bodyTruncated:respBodyTruncated,bodyLen:(text?text.length:0)};
  send({type:'api-log',payload:{t:startedAt,store:storeId,partNumber:partLabels,partNumbers,incognito:inIncognito,request:reqObj,response:respObj,status,ok:apiOk,reason:reason||null,latencyMs,coolingDown,cooldownStep,probing,downshift}});
  console.log(`[apple-stock] ${new Date(startedAt).toLocaleString('zh-CN',{hour12:false})} ${reqObj.method} store=${storeId} part=${partLabels} http=${httpStatus} bodyLen=${respObj.bodyLen} ${apiOk?'OK':(reason==='PAGE_NOT_FOUND'?'PAGE_NOT_FOUND':'ERR')} ${latencyMs}ms${coolingDown?` [cooldown Lv${(cooldownStep??0)+1} ${Math.round(delay/1000)}s]`:''}`);
  // 失败/冷却期间等待不可被顺带唤醒打断，保证退避与熔断真正生效
  await wait(jitter(delay),failures===0);
 }
}
async function claim(){if(polling||claiming||!config)return;claiming=true;try{await navigator.locks.request(lockName,{ifAvailable:true},async lock=>{claiming=false;if(!lock)return;polling=true;try{await poll();}finally{polling=false;}});}catch{claiming=false;polling=false;}}
// revision 每次保存都会递增，所以重复保存相同配置也能立即查询；普通唤醒不会穿透失败退避。
const loadConfig=()=>send({type:'get-config'},value=>{if(!value?.partNumbers?.length||!value?.storeIds?.length){config=null;configSignature='';wake?.();return;}const signature=JSON.stringify([value.partNumbers,value.storeIds,value.interval,value.revision]);if(signature!==configSignature){config=value;configSignature=signature;send({type:'progress',payload:{stage:'config',revision:value.revision,extensionSeenAt:Date.now()}});wake?.();}claim();});
chrome.runtime.onMessage.addListener(message=>{if(message?.type==='config-changed')loadConfig();});
window.addEventListener('message',event=>{
 if(event.source!==window||event.origin!==location.origin||event.data?.source!=='apple-stock-bridge')return;
 const data=event.data;
 if(data?.type==='bagx-response'){const payload=data.payload;if(payload&&typeof payload==='object')send({type:'bagx-response',payload});return;}
 if(data?.type==='fulfillment-page-response'){const payload=data.payload;if(payload&&typeof payload==='object')send({type:'fulfillment-response',payload});return;}
 // 只接受现网接口的模板：万一页面里还跑着旧版拦截脚本，其上报的旧端点模板会被直接丢弃，
 // 避免请求被带回旧的供货查询端点。
 // 页面自然请求的响应会直接同步；这里仅保留真实请求头，不再额外唤醒一次主动查询。
 if(data?.type==='fulfillment-request'){const p=data.payload;if(typeof p?.url!=='string')return;try{if(new URL(p.url,location.href).pathname!==PICKUP_PATH)return;}catch{return;}requestTemplate={url:p.url,headers:p.headers||{}};}
});
send({type:'bridge-ready'});
loadConfig();setInterval(loadConfig,500);
