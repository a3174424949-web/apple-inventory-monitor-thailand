import {setTimeout as sleep} from 'node:timers/promises';
import {listFamilies,nextDelay,transition} from './inventory.mjs';

export function createMonitor({catalog,fetchFamily,onState=()=>{},clock={sleep}}){
 let stopped=false,failures=0,abort=new AbortController();
 let state={inventory:{},events:[],cycle:0,interval:5,nextCheck:null,lastSuccess:null,backoffReason:null,successRate:0};
 const publish=()=>onState(structuredClone(state));
 return {
  async runCycle(){
   let failed=0,successful=0;
   for(const family of listFamilies(catalog).values()){
    try{
     const rows=await fetchFamily(family,abort.signal);successful++;
     for(const product of family){
      const change=transition(state.inventory[product.partNumber],rows[product.partNumber],Date.now(),10000);
      state.inventory[product.partNumber]=change.snapshot;
      if(change.notify)state.events.push({id:`${product.partNumber}-${Date.now()}`,time:Date.now(),partNumber:product.partNumber,...product,message:change.snapshot.message});
     }
    }catch(error){
     failed++;state.backoffReason=error.code??error.name??'REQUEST_FAILED';
     for(const product of family)state.inventory[product.partNumber]={...(state.inventory[product.partNumber]??{}),status:'unknown',message:'本轮检查失败',checkedAt:Date.now()};
    }
   }
   failures=failed?failures+1:0;
   const counts={available:0,unavailable:0,unknown:0};
   for(const item of Object.values(state.inventory)){const key=item.status==='available'?'available':item.status==='unavailable'?'unavailable':'unknown';counts[key]++;}
   const interval=nextDelay(failures);
   state={...state,events:state.events.slice(-120),cycle:state.cycle+1,interval,nextCheck:Date.now()+interval*1000,successRate:catalog.length?Math.round(successful/listFamilies(catalog).size*100):0,lastSuccess:failed?state.lastSuccess:Date.now(),backoffReason:failed?state.backoffReason:null,cycleSummary:{families:listFamilies(catalog).size,successful,failed,...counts}};
   publish();return structuredClone(state);
  },
  async start(){
   while(!stopped){await this.runCycle();try{await clock.sleep(state.interval*1000,undefined,{signal:abort.signal});}catch(error){if(error.name!=='AbortError')throw error;}}
  },
  stop(){stopped=true;abort.abort();},
  snapshot(){return structuredClone(state);},
 };
}
