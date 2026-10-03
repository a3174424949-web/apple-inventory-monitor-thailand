import test from 'node:test';
import assert from 'node:assert/strict';
import {buildUrl,intervalSeconds} from './monitor.mjs';

test('库存请求使用泰国 fulfillment-messages 端点和门店编号',()=>{
  const url=new URL(buildUrl('R733',['MJRP4ZP/A','MJRQ4ZP/A']));
  assert.equal(url.origin,'https://www.apple.com');
  assert.equal(url.pathname,'/th/shop/fulfillment-messages');
  assert.equal(url.searchParams.get('store'),'R733');
  assert.equal(url.searchParams.get('parts.0'),'MJRP4ZP/A');
  assert.equal(url.searchParams.get('parts.1'),'MJRQ4ZP/A');
});

test('云端轮询间隔至少 120 秒',()=>{
  const previous=process.env.POLL_INTERVAL_SECONDS;
  process.env.POLL_INTERVAL_SECONDS='30';assert.equal(intervalSeconds(),120);
  process.env.POLL_INTERVAL_SECONDS='900';assert.equal(intervalSeconds(),900);
  if(previous===undefined)delete process.env.POLL_INTERVAL_SECONDS;else process.env.POLL_INTERVAL_SECONDS=previous;
});
