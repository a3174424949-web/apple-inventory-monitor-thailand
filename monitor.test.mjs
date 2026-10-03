import test from 'node:test';
import assert from 'node:assert/strict';
import {createMonitor} from './monitor.mjs';

const catalog=[
 {familyId:'pro',partNumber:'A',modelName:'Pro'},
 {familyId:'max',partNumber:'B',modelName:'Max'},
];

test('每轮串行检查全部家族并在成功后使用 5 秒',async()=>{
 let active=0,maxActive=0,updates=0;
 const monitor=createMonitor({catalog,fetchFamily:async family=>{
  active++;maxActive=Math.max(maxActive,active);await Promise.resolve();active--;
  return Object.fromEntries(family.map(p=>[p.partNumber,{status:'unavailable',message:'暂无供应',checkedAt:1}]));
 },onState:()=>updates++});
 await monitor.runCycle();
 assert.equal(maxActive,1);assert.equal(updates,1);assert.equal(monitor.snapshot().interval,5);assert.equal(monitor.snapshot().cycle,1);
 assert.deepEqual(monitor.snapshot().cycleSummary,{families:2,successful:2,failed:0,available:0,unavailable:2,unknown:0});
});

test('单家族失败不阻断后续家族且按 10 秒退避',async()=>{
 const calls=[];
 const monitor=createMonitor({catalog,fetchFamily:async family=>{
  calls.push(family[0].familyId);if(family[0].familyId==='pro')throw Object.assign(new Error('HTTP 541'),{code:'HTTP_541'});
  return {B:{status:'available',message:'今天可取货',checkedAt:1}};
 }});
 await monitor.runCycle();const state=monitor.snapshot();
 assert.deepEqual(calls,['pro','max']);assert.equal(state.inventory.A.status,'unknown');assert.equal(state.inventory.B.status,'available');assert.equal(state.interval,10);
 assert.equal(state.events.length,1);
});

test('重复 available 不重复产生提醒',async()=>{
 const monitor=createMonitor({catalog:[catalog[0]],fetchFamily:async()=>({A:{status:'available',message:'今天可取货',checkedAt:Date.now()}})});
 await monitor.runCycle();await monitor.runCycle();assert.equal(monitor.snapshot().events.length,1);
});
