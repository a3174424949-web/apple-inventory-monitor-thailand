import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {checkInventory,intervalSeconds,saveLatest} from './monitor.mjs';

const port=Number(process.env.PORT||4318);
const host=process.env.HOST||'0.0.0.0';
const interval=intervalSeconds();
const cooldownSteps=[900,1800,3600];
let activeInterval=interval,rateLimitStreak=0,timer=null;
let state={projectName:'Apple库存监控-泰国两店',status:'starting',checkedAt:null,inventory:{},responses:[],configuredIntervalSeconds:interval,pollIntervalSeconds:interval,rateLimitStreak:0,message:'云端服务正在启动。'};
let running=false;

async function cycle(){
  if(running)return state;
  running=true;state={...state,status:'checking',message:'正在查询泰国两家 Apple Store。'};
  try{
    const next=await checkInventory();
    const rateLimited=next.responses?.some(response=>response.status===541);
    if(rateLimited){
      rateLimitStreak=Math.min(rateLimitStreak+1,cooldownSteps.length);
      activeInterval=cooldownSteps[rateLimitStreak-1];
    }else if(next.status==='ok'){
      rateLimitStreak=0;activeInterval=interval;
    }else{
      activeInterval=interval;
    }
    const message=rateLimited
      ?`Apple 暂时限流，已暂停 ${Math.round(activeInterval/60)} 分钟后再试。库存保持未知。`
      :next.status==='ok'?'本轮查询完成。':'本轮没有取得有效库存响应，库存按未知处理。';
    state={...next,configuredIntervalSeconds:interval,pollIntervalSeconds:activeInterval,rateLimitStreak,nextCheckAt:Date.now()+activeInterval*1000,message};
    await saveLatest(state);
  }catch(error){activeInterval=interval;state={...state,status:'error',configuredIntervalSeconds:interval,pollIntervalSeconds:activeInterval,checkedAt:Date.now(),nextCheckAt:Date.now()+activeInterval*1000,message:`云端查询失败：${error.message}`};}
  finally{running=false;}
  return state;
}

function scheduleNext(){
  clearTimeout(timer);
  timer=setTimeout(async()=>{await cycle();scheduleNext();},activeInterval*1000);
}

const page=await readFile(new URL('./index.html',import.meta.url));
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  res.setHeader('Cache-Control','no-store');
  if(url.pathname==='/api/state'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(state));return;}
  if(url.pathname==='/'||url.pathname==='/index.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(page);return;}
  res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Not found');
});

server.listen(port,host,()=>console.log(`Apple库存监控-泰国两店云端服务：http://${host}:${port}；正常间隔 ${interval} 秒`));
await cycle();
scheduleNext();
process.on('SIGTERM',()=>{clearTimeout(timer);server.close(()=>process.exit(0));});
process.on('SIGINT',()=>{clearTimeout(timer);server.close(()=>process.exit(0));});
