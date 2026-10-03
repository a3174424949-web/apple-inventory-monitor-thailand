import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, readMode } from './status.mjs';

test('准备会话与监测、检查互斥；未知参数拒绝', () => {
  assert.equal(readMode([]),'open');
  for (const mode of ['setup','watch','check']) assert.equal(readMode([`--${mode}`]),mode);
  for (const args of [['--setup','--watch'],['--check','--watch'],['--setup','--check'],['--watc'],['--watch','--watch']]) {
    assert.throws(()=>readMode(args),/用法/);
  }
});

const ready = () => ({
  title: '购买 iPhone 18 Pro 256GB 黑色 - Apple (中国大陆)',
  selected: { dimensionScreensize: '6_3inch', dimensionColor: 'black', dimensionCapacity: '256gb' },
  httpStatus: 200, fulfillmentStatus: 200, pickupControls: 1, addEnabled: true,
});

test('页面恢复也不能当作指定门店有货', () => {
  assert.deepEqual(classify(ready()), { code: 'NEEDS_STORE_CHECK', retry: true });
});
test('错误机型、颜色、容量和标题均停止', () => {
  for (const [key, value] of Object.entries({dimensionScreensize:'6_9inch', dimensionColor:'silver', dimensionCapacity:'512gb'})) {
    const observation = ready();
    observation.selected[key] = value;
    assert.equal(classify(observation).code, 'WRONG_PRODUCT');
  }
  const observation = ready();
  observation.title = '购买 iPhone 18 Pro Max 256GB 黑色';
  assert.equal(classify(observation).code, 'WRONG_PRODUCT');
});
test('541、429、403 和服务器错误不可视为缺货或有货', () => {
  for (const status of [541,429,403,500]) {
    assert.deepEqual(classify({...ready(),fulfillmentStatus:status}), {code:'SERVICE_ERROR',retry:true});
    assert.equal(classify({...ready(),httpStatus:status}).code,'SERVICE_ERROR');
  }
});
test('配送请求未完成、门店入口缺失、加购不可用保持未知', () => {
  for (const change of [{fulfillmentStatus:null},{fulfillmentStatus:204},{pickupControls:0},{addEnabled:false}]) {
    assert.deepEqual(classify({...ready(),...change}),{code:'UNKNOWN',retry:true});
  }
});
