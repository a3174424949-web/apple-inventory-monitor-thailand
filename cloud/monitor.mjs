import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseFulfillment} from '../inventory.mjs';

const root=new URL('../',import.meta.url);
const catalog=JSON.parse(await readFile(new URL('../catalog.json',import.meta.url),'utf8'));
const storeCatalog=JSON.parse(await readFile(new URL('../stores.json',import.meta.url),'utf8'));
const products=catalog.products.map(product=>({
  ...product,
  partNumber:product.part,
  modelName:product.modelName??(product.model==='6_9inch'?'iPhone 18 Pro Max':'iPhone 18 Pro'),
  colorName:product.colorName??product.color,
}));
const stores=storeCatalog.stores;
const endpoint='https://www.apple.com/th/shop/fulfillment-messages';
const defaultInterval=120;

function selectedParts(){
  const raw=process.env.PART_NUMBERS?.split(',').map(value=>value.trim()).filter(Boolean);
  const allowed=new Set(products.map(product=>product.partNumber));
  const chosen=raw?.filter(part=>allowed.has(part));
  return chosen?.length?chosen:['MJXP4ZP/A'];
}

export function buildUrl(storeId,parts){
  const params=new URLSearchParams({fae:'true',pl:'true',store:storeId,'mts.0':'regular'});
  parts.forEach((part,index)=>params.set(`parts.${index}`,part));
  return `${endpoint}?${params}`;
}

async function requestStore(store,parts){
  const started=Date.now();
  try{
    const response=await fetch(buildUrl(store.id,parts),{
      headers:{Accept:'application/json','Accept-Language':'th-TH,th;q=0.9,en;q=0.8','User-Agent':'Mozilla/5.0 AppleInventoryMonitor/1.0'},
      signal:AbortSignal.timeout(30000),
    });
    const body=await response.text();
    let payload=null;try{payload=JSON.parse(body);}catch{}
    const status=Number(payload?.head?.status)||response.status;
    const results=status===200&&payload
      ?parseFulfillment(payload,parts,{id:store.id,name:store.name},Date.now())
      :Object.fromEntries(parts.map(part=>[part,{status:'unknown',message:status===541?'Apple 暂时限流，等待下一轮。':`Apple 返回 HTTP ${status}。`,checkedAt:Date.now()}]));
    return {storeId:store.id,status,ok:status===200&&!!payload,latencyMs:Date.now()-started,results,bodyLength:body.length};
  }catch(error){
    return {storeId:store.id,status:0,ok:false,latencyMs:Date.now()-started,error:error.message,results:Object.fromEntries(parts.map(part=>[part,{status:'unknown',message:'请求失败，库存未知。',checkedAt:Date.now()}]))};
  }
}

export async function checkInventory(){
  const parts=selectedParts();
  const checkedAt=Date.now();
  const responses=[];const inventory={};
  for(const store of stores){
    const response=await requestStore(store,parts);responses.push(response);
    for(const [part,value] of Object.entries(response.results))inventory[`${store.id}:${part}`]={...value,storeId:store.id,partNumber:part};
    // 两家店请求之间留出间隔，避免把一次轮询变成突发请求。
    if(store!==stores.at(-1))await new Promise(resolve=>setTimeout(resolve,1000));
  }
  return {projectName:'Apple库存监控-泰国两店',region:'Thailand',catalogDate:catalog.checkedAt,checkedAt,stores,products,partNumbers:parts,responses,inventory,status:responses.some(response=>response.ok)?'ok':'error'};
}

export function intervalSeconds(){
  const value=Number(process.env.POLL_INTERVAL_SECONDS||defaultInterval);
  return Number.isFinite(value)?Math.max(120,Math.min(86400,Math.floor(value))):defaultInterval;
}

export async function saveLatest(state){
  const target=new URL('./latest.json',import.meta.url);
  await mkdir(new URL('./',import.meta.url),{recursive:true});
  await writeFile(target,JSON.stringify(state,null,2)+'\n','utf8');
  return fileURLToPath(target);
}

if(process.argv[1]&&process.argv[1].replaceAll('\\','/').endsWith('/cloud/monitor.mjs')){
  const result=await checkInventory();
  const path=await saveLatest(result);
  console.log(JSON.stringify({project:result.projectName,status:result.status,checkedAt:result.checkedAt,files:[path],responses:result.responses.map(response=>({storeId:response.storeId,status:response.status,ok:response.ok,latencyMs:response.latencyMs}))},null,2));
}
