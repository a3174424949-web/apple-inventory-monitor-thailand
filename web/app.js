const $=id=>document.getElementById(id);
let state={active:false,catalog:[],stores:[],selection:{storeIds:[],partNumbers:[]},inventory:{},events:[],logs:[],interval:120},filter='all',grouping='model',connected=false,restored=false,selectionSignature='',selectorsReady=false,collapsedReady=false,collapsed=false,catalogSignature='',logsSignature='',reportedTrace=0,seenEvents=new Set(JSON.parse(sessionStorage.getItem('seenInventoryEvents')||'[]'));
const phaseLabels={idle:'未开始',starting:'启动中',checking:'检查中',waiting:'运行中',retry:'退避中',setup:'等待准备',bridge_waiting:'扩展已加载',bridge:'日常 Chrome 已连接',stopped:'已停止',error:'错误'};
const statusLabels={available:'可取货',unavailable:'暂无供应',unknown:'未知',stale:'已过期'};
const filterNames={all:'全部',available:'可取货',unavailable:'暂无供应',unknown:'未知',stale:'已过期'};
// 泰国目录使用官网的英文颜色名称，色点只用于快速扫读。
const colorSwatches={'Black':'#2a2a2c','Silver':'#e2e3e5','Glacier':'#a8c7db','Burgundy':'#7c2d3a'};
const fmt=time=>time?new Date(time).toLocaleTimeString('zh-CN',{hour12:false}):'—';
const same=(a,b)=>{const left=[...a].sort().join('\u0001'),right=[...b].sort().join('\u0001');return left===right;};
async function request(path,body){const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-Local-Action':'1'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});const value=await response.json();if(!response.ok)throw new Error(value.error||'请求失败');return value;}
const selectedStores=()=>state.stores.filter(store=>state.selection.storeIds.includes(store.id));
const selectedProducts=()=>state.catalog.filter(product=>state.selection.partNumbers.includes(product.partNumber));
const itemOf=(store,product)=>state.inventory[`${store.id}:${product.partNumber}`];
// 未知与已过期分开统计：未知=从未取到数据，已过期=曾拿到过数据但长时间没有更新
function counts(){const values=selectedStores().flatMap(store=>selectedProducts().map(product=>itemOf(store,product)?.status??'unknown'));return {all:values.length,available:values.filter(v=>v==='available').length,unavailable:values.filter(v=>v==='unavailable').length,unknown:values.filter(v=>v==='unknown').length,stale:values.filter(v=>v==='stale').length};}
const checked=id=>[...document.querySelectorAll(`#${id} input:checked`)].map(input=>input.value);
const matches=item=>filter==='all'||(item?.status??'unknown')===filter;
let pendingStores=new Set();
function checks(id,values,selected,type='checkbox'){const box=$(id);box.replaceChildren(...values.map(({value,label,swatch})=>{const row=document.createElement('label'),input=document.createElement('input');input.type=type;input.name=id;input.value=value;input.checked=selected.includes(value);if(swatch){const dot=document.createElement('i');dot.className='swatch';dot.style.background=swatch;dot.setAttribute('aria-hidden','true');row.append(input,dot,document.createTextNode(label));}else row.append(input,document.createTextNode(label));return row;}));}
// 泰国目前只有 Bangkok 地区的两家直营店，门店可同时勾选。
function orderedProvinces(){const all=[...new Set(state.stores.map(store=>store.province))].sort((a,b)=>a.localeCompare(b,'en'));const pinned=[...new Set([...selectedStores().map(store=>store.province),$('province-select').value])].filter(name=>all.includes(name));return [...pinned,...all.filter(name=>!pinned.includes(name))];}
function renderStores(){const province=$('province-select').value,rows=state.stores.filter(store=>store.province===province);checks('store-options',rows.map(store=>({value:store.id,label:`${store.city} · ${store.name}`})),[...pendingStores],'checkbox');renderStoreSummary();}
function renderStoreSummary(){const chosen=state.stores.filter(store=>pendingStores.has(store.id));$('store-summary').textContent=chosen.length?`已选门店：${chosen.map(store=>`${store.city} · ${store.name}`).join('、')}`:'尚未选择门店。';for(const option of $('province-select').options)option.textContent=option.value;}
// 收起状态下的摘要：不展开表单也能一眼看清当前在监控什么
function renderConfigSummary(){const chosen=selectedStores(),products=selectedProducts();if(!chosen.length&&!products.length){$('config-summary').textContent='尚未选择门店与型号';return;}const provinces=[...new Set(chosen.map(store=>store.province))],models=[...new Set(products.map(product=>product.modelName))];$('config-summary').textContent=`${provinces.join(' / ')||'未选地区'} · ${chosen.map(store=>store.name).join('、')||'未选门店'} · ${models.join(' / ')||'未选型号'} · ${products.length} 个配置 · ${savedInterval()} 秒一轮`;}
const capacityRank=value=>{const match=String(value).match(/^(\d+)(gb|tb)$/i);return match?Number(match[1])*(match[2].toLowerCase()==='tb'?1024:1):Number.MAX_SAFE_INTEGER;};
function currentPartNumbers(){const models=checked('model-options'),capacities=checked('capacity-options'),colors=checked('color-options');return state.catalog.filter(product=>models.includes(product.familyId)&&capacities.includes(product.capacity)&&colors.includes(product.colorName)).map(product=>product.partNumber);}
// 查询间隔：值来自 #interval-select，已保存值来自 state.selection.interval。
// 云端和本地默认使用 120 秒以上的间隔，避免连续请求触发临时限流。
const intervalValue=()=>Number($('interval-select').value)||120;
const savedInterval=()=>Number(state.selection?.interval)||120;
// 服务端允许 120–900 秒的任意整数（不只下拉里的几档）；遇到列表外的值临时补一个选项，避免显示为空
function setIntervalOptions(){const select=$('interval-select'),value=savedInterval();if(![...select.options].some(option=>Number(option.value)===value)){const option=document.createElement('option');option.value=String(value);option.textContent=`${value} 秒`;select.append(option);}select.value=String(value);}
// 未保存提示：勾选与已保存配置不一致时高亮保存按钮，避免"以为改了其实没生效"（间隔变更同样计入）
function isDirty(){return !same(pendingStores,state.selection.storeIds)||!same(currentPartNumbers(),state.selection.partNumbers)||intervalValue()!==savedInterval();}
function refreshDirty(){if(!selectorsReady)return;const dirty=isDirty(),button=$('save-config');button.classList.toggle('dirty',dirty);button.textContent=dirty?'有未保存修改 · 保存并监听':'保存并监听';}
function setConfigCollapsed(next){collapsed=next;$('config-form').classList.toggle('collapsed',next);const button=$('config-toggle');button.textContent=next?'修改':'收起';button.setAttribute('aria-expanded',String(!next));}
function renderSelectors(){
 const signature=JSON.stringify(state.selection);if(signature===selectionSignature)return;selectionSignature=signature;pendingStores=new Set(state.selection.storeIds);
 const provinces=orderedProvinces();
 $('province-select').replaceChildren(...provinces.map(name=>{const option=document.createElement('option');option.value=option.textContent=name;return option;}));
 const focus=selectedStores()[0]?.province??provinces[0];if(focus)$('province-select').value=focus;
 setIntervalOptions();
 renderStores();
 const products=state.catalog,selected=state.selection.partNumbers;
 checks('model-options',[...new Map(products.map(p=>[p.familyId,{value:p.familyId,label:p.modelName}])).values()],products.filter(p=>selected.includes(p.partNumber)).map(p=>p.familyId));
 checks('capacity-options',[...new Set(products.map(p=>p.capacity))].sort((a,b)=>capacityRank(a)-capacityRank(b)).map(value=>({value,label:value})),products.filter(p=>selected.includes(p.partNumber)).map(p=>p.capacity));
 checks('color-options',[...new Set(products.map(p=>p.colorName))].map(value=>({value,label:value,swatch:colorSwatches[value]})),products.filter(p=>selected.includes(p.partNumber)).map(p=>p.colorName));
 selectorsReady=true;renderConfigSummary();refreshDirty();
}
function cardFor(store,product,item){
 const pending=state.bridgeLoaded?'尚未检查':'Chrome 扩展未连接',data=item??{status:'unknown',message:pending};
 const card=document.createElement('article');card.className=`card ${data.status}`;
 const top=document.createElement('div'),name=document.createElement('strong'),badge=document.createElement('span');
 badge.className='badge';badge.textContent=statusLabels[data.status]??'未知';
 name.textContent=grouping==='store'?`${product.modelName} ${product.capacity} · ${product.colorName}`:grouping==='sku'?`Apple ${store.name}`:`${product.capacity} · ${product.colorName}`;
 top.append(name,badge);
 const sku=document.createElement('code');sku.textContent=grouping==='store'?`${product.partNumber} · ${store.city}`:product.partNumber;
 const message=document.createElement('p');message.textContent=data.message??pending;
 const time=document.createElement('small');time.textContent=`更新：${fmt(data.checkedAt)}`;
 card.append(top,sku,message,time);
 return card;
}
// 三种分组：按机型（默认，门店+机型一組）、按门店、按 SKU 对比（同一货号的多门店并排）
function groupOf(store,product){if(grouping==='store')return `store:${store.id}`;if(grouping==='sku')return `sku:${product.partNumber}`;return `model:${store.id}:${product.familyId}`;}
function renderCatalog(force){
 const signature=[filter,grouping,state.bridgeLoaded,JSON.stringify(state.selection),JSON.stringify(state.inventory)].join('~');
 if(!force&&signature===catalogSignature)return;catalogSignature=signature;
 const groups=new Map();
 for(const store of selectedStores())for(const product of selectedProducts()){const item=itemOf(store,product);if(!matches(item))continue;const key=groupOf(store,product),row=groups.get(key)??{store,product,items:[]};row.items.push({store,product,item});groups.set(key,row);}
 const nodes=[];
 for(const row of groups.values()){
  const section=document.createElement('section');section.className='family';
  const heading=document.createElement('h2'),place=document.createElement('p');
  if(grouping==='store'){heading.textContent=`Apple ${row.store.name}`;place.textContent=`${row.store.province} · ${row.store.city} · ${row.items.length} 个配置`;}
  else if(grouping==='sku'){heading.textContent=`${row.product.modelName} ${row.product.capacity} · ${row.product.colorName}`;place.textContent=`${row.product.partNumber} · ${row.items.length} 家门店`;}
  else{heading.textContent=row.product.modelName;place.textContent=`Apple ${row.store.name} · ${row.store.city}`;}
  section.append(heading,place);
  const grid=document.createElement('div');grid.className='cards';
  row.items.sort((a,b)=>(b.item?.status==='available')-(a.item?.status==='available'));
  for(const item of row.items)grid.append(cardFor(item.store,item.product,item.item));
  section.append(grid);nodes.push(section);
 }
 $('catalog').replaceChildren(...nodes);
 if(!nodes.length){const empty=document.createElement('p');empty.className='empty';empty.textContent=!selectedProducts().length?'尚未选择要监控的配置。':filter==='all'?'当前没有可展示的配置。':`「${filterNames[filter]}」筛选下没有配置。`;$('catalog').append(empty);}
}
function renderFreshness(){const seconds=Number(state.interval)||120;$('freshness-note').textContent=state.bridgeConnected?`约 ${seconds} 秒一轮`:state.bridgeLoaded?'等待扩展首次查询':'扩展未连接';$('freshness-time').textContent=state.lastSuccess?fmt(state.lastSuccess):'尚无数据';}
function notifyEvents(){for(const event of state.events??[]){if(seenEvents.has(event.id))continue;seenEvents.add(event.id);if(Notification.permission==='granted')new Notification(`${event.modelName} 可取货`,{body:`${event.capacity} · ${event.colorName} · Apple ${event.storeName}`});try{const audio=new AudioContext();const oscillator=audio.createOscillator();oscillator.connect(audio.destination);oscillator.start();oscillator.stop(audio.currentTime+.15);}catch{}}sessionStorage.setItem('seenInventoryEvents',JSON.stringify([...seenEvents].slice(-120)));}
function render(){
 renderSelectors();
 const shownStores=selectedStores();$('selected-store').textContent=shownStores.length?(shownStores.length>1?`${shownStores.length} 家门店：Apple ${shownStores[0].name} 等`:`Apple ${shownStores[0].name}`):'尚未选择门店';
 // 显示数据来自哪种窗口：无痕窗口有独立的空 cookie jar，会话身份与普通窗口完全不同，
 // 而「无痕里不 541」最常见的原因其实是扩展根本没在无痕中运行（零请求）。标注来源可避免误判。
 $('connection').textContent=connected?(state.bridgeIncognito===true?'本机服务已连接 · 数据来自无痕窗口':state.bridgeIncognito===false?'本机服务已连接 · 数据来自普通窗口':'本机服务已连接'):'连接已断开';$('connection').className=connected?'online':'offline';
 $('state-title').textContent=phaseLabels[state.phase]??'等待更新';$('state-message').textContent=state.message??'';
 renderFreshness();
 // 首次拿到配置后决定默认展开还是收起：已经有保存过的配置就收起表单，把首屏让给库存
 if(!collapsedReady&&state.stores.length){collapsedReady=true;setConfigCollapsed(state.selection.storeIds.length>0&&state.selection.partNumbers.length>0);}
 const values=counts();for(const [key,value] of Object.entries(values)){const node=$(`count-${key}`);if(node)node.textContent=value;}
 if(filter!=='all'&&!values[filter])filter='all';
 for(const button of document.querySelectorAll('[data-filter]')){const key=button.dataset.filter;button.classList.toggle('selected',key===filter);button.disabled=key!=='all'&&!values[key];}
 renderCatalog();
 const rows=state.logs??[],logsSignatureNext=JSON.stringify(rows.slice(-120));
 if(logsSignatureNext!==logsSignature){logsSignature=logsSignatureNext;const lines=rows.map(row=>{const line=document.createElement('div');line.className='log';const time=document.createElement('time');time.textContent=fmt(row.time);const text=document.createElement('span');text.textContent=row.message;line.append(time,text);return line;});$('log-list').replaceChildren(...lines);if(!lines.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='任务开始后，检查结果会显示在这里。';$('log-list').append(empty);}}
 notifyEvents();
 const trace=state.trace;if(trace?.parsedAt&&!trace.renderedAt&&trace.revision!==reportedTrace){reportedTrace=trace.revision;request('/api/trace',{revision:trace.revision,renderedAt:Date.now()}).then(value=>{state=value;render();}).catch(()=>{});}
}
document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{if(button.disabled)return;filter=button.dataset.filter;render();}));
document.querySelectorAll('[data-group]').forEach(button=>button.addEventListener('click',()=>{grouping=button.dataset.group;for(const other of document.querySelectorAll('[data-group]'))other.classList.toggle('selected',other===button);renderCatalog();}));
document.querySelectorAll('[data-target]').forEach(button=>button.addEventListener('click',()=>{const box=$(button.dataset.target),mode=button.dataset.mode;for(const input of box.querySelectorAll('input'))input.checked=mode==='all';refreshDirty();}));
$('config-toggle').addEventListener('click',()=>setConfigCollapsed(!collapsed));
$('province-select').addEventListener('change',()=>{renderStores();refreshDirty();});
$('config-form').addEventListener('change',event=>{if(event.target.closest('#store-options')){if(event.target.checked)pendingStores.add(event.target.value);else pendingStores.delete(event.target.value);renderStoreSummary();}refreshDirty();});
$('config-form').addEventListener('submit',async event=>{event.preventDefault();const traceStartedAt=Date.now(),error=$('config-error');error.hidden=true;const storeIds=[...pendingStores],models=checked('model-options'),capacities=checked('capacity-options'),colors=checked('color-options'),partNumbers=state.catalog.filter(p=>models.includes(p.familyId)&&capacities.includes(p.capacity)&&colors.includes(p.colorName)).map(p=>p.partNumber);if(!storeIds.length||!partNumbers.length){error.textContent='请至少选择一个门店，并至少选出一组有效的型号、容量、颜色。';error.hidden=false;return;}try{if(Notification.permission==='default')await Notification.requestPermission();const interval=intervalValue();state=await request('/api/config',{storeIds,partNumbers,interval,traceStartedAt});localStorage.setItem('appleStockSelection',JSON.stringify({storeIds,partNumbers,interval}));selectionSignature='';catalogSignature='';setConfigCollapsed(true);render();}catch(reason){error.textContent=reason.message;error.hidden=false;}});
async function poll(){try{state=await request('/api/state');if(!restored){restored=true;const saved=JSON.parse(localStorage.getItem('appleStockSelection')||'null');if(saved)state=await request('/api/config',saved);}connected=true;render();}catch{connected=false;render();}}
poll();setInterval(poll,250);setInterval(()=>{if(connected)render();},250);
