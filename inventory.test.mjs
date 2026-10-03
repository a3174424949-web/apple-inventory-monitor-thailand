import test from 'node:test';
import assert from 'node:assert/strict';
import {listFamilies,normalizeCatalog,parseFulfillment,parseFulfillmentByStore,parseBagxFulfillment,transition,nextDelay} from './inventory.mjs';

test('目录规范化、按货号去重并按产品家族分组',()=>{
 const rows=normalizeCatalog([
  {part:'A',model:'6_3inch',color:'black',capacity:'256gb'},
  {part:'A',model:'6_3inch',color:'black',capacity:'256gb'},
  {part:'B',model:'6_9inch',color:'silver',capacity:'512gb'},
 ]);
 assert.deepEqual([...listFamilies(rows)].map(([id,items])=>[id,items.length]),[['iphone-18-pro',1],['iphone-18-pro-max',1]]);
 assert.equal(rows[0].partNumber,'A');
});

test('只接受 Apple 青岛万象城的明确库存（新接口 body.stores 结构）',()=>{
 const payload={body:{stores:[
  {storeNumber:'R557',storeName:'Apple 青岛万象城',partsAvailability:{A:{pickupDisplay:'available',pickupSearchQuote:'今天可取货'}}},
  {storeNumber:'R648',storeName:'Apple 济南恒隆广场',partsAvailability:{B:{pickupDisplay:'available'}}},
 ]}};
 const result=parseFulfillment(payload,['A','B'],'Apple 青岛万象城',1000);
 assert.deepEqual(result.A,{status:'available',message:'今天可取货',checkedAt:1000});
 assert.equal(result.B.status,'unknown');
});

test('明确暂无供应可判缺货，错误结构保持未知（新接口）',()=>{
 const payload={body:{stores:[{storeNumber:'R557',storeName:'Apple 青岛万象城',partsAvailability:{A:{pickupDisplay:'unavailable',pickupSearchQuote:'暂无供应'}}}]}};
 assert.equal(parseFulfillment(payload,['A'],'Apple 青岛万象城',1000).A.status,'unavailable');
 assert.equal(parseFulfillment({},['A'],'Apple 青岛万象城',1000).A.status,'unknown');
});

test('门店不支持该配置(ineligible)映射为 unknown，绝不误报缺货',()=>{
 const payload={body:{stores:[{storeNumber:'R557',storeName:'Apple 青岛万象城',partsAvailability:{A:{pickupDisplay:'ineligible'}}}]}};
 assert.equal(parseFulfillment(payload,['A'],'Apple 青岛万象城',1000).A.status,'unknown');
});

test('官网拒绝地址时显示真实错误，不误判库存',()=>{
 const payload={body:{errorMessage:'请输入有效的省/市名称或邮政编码。'}};
 const result=parseFulfillment(payload,['A'],'Apple 青岛万象城',1000).A;
 assert.deepEqual(result,{status:'unknown',message:'官网查询失败：请输入有效的省/市名称或邮政编码。',checkedAt:1000});
});

test('按多个已选门店分别解析库存',()=>{
 const payload={stores:[
  {storeName:'Apple 青岛万象城',parts:{A:{pickupDisplay:'available'}}},
  {storeName:'Apple 济南恒隆广场',parts:{A:{pickupDisplay:'unavailable'}}},
 ]};
 const result=parseFulfillmentByStore(payload,['A'],[{id:'R557',name:'青岛万象城'},{id:'R648',name:'济南恒隆广场'}],1000);
 assert.equal(result['R557:A'].status,'available');assert.equal(result['R648:A'].status,'unavailable');
});

test('商品页响应按门店编号解析无 Apple 前缀的库存',()=>{
 const payload={body:{content:{pickupMessage:{stores:[{storeName:'青岛万象城',storeNumber:'R557',partsAvailability:{A:{pickupDisplay:'unavailable',pickupSearchQuote:'暂无供应'}}}]}}}};
 assert.equal(parseFulfillmentByStore(payload,['A'],[{id:'R557',name:'青岛万象城'}],1000)['R557:A'].status,'unavailable');
});

test('退避为 5/10/30/60 秒并封顶',()=>{
 assert.deepEqual([0,1,2,3,4].map(nextDelay),[5,10,30,60,60]);
});

test('仅首次转为 available 产生提醒，有效旧结果可变 stale',()=>{
 const first=transition({status:'unknown'},{status:'available',checkedAt:1000},1000,10000);
 const same=transition(first.snapshot,{status:'available',checkedAt:2000},2000,10000);
 const stale=transition(same.snapshot,null,13001,10000);
 assert.equal(first.notify,true);assert.equal(same.notify,false);assert.equal(stale.snapshot.status,'stale');
});

test('bagx 按精确门店和商品名称解析逐行库存',()=>{
 const products=[
  {partNumber:'A',modelName:'iPhone 18 Pro',capacity:'256GB',colorName:'黑色'},
  {partNumber:'B',modelName:'iPhone 18 Pro Max',capacity:'256GB',colorName:'黑色'},
  {partNumber:'C',modelName:'iPhone 18 Pro',capacity:'512GB',colorName:'银色'},
 ];
 const payload={body:{shoppingCart:{items:{item1:{delivery:{storeLocator:{searchResults:{d:{retailStores:[{
  storeId:'R557',storeName:'Apple 青岛万象城',availability:{lineItemAvailability:[
   {partName:'iPhone 18 Pro 256GB 黑色',availableNowForLine:true,availabilityQuote:'今天 可取货'},
   {partName:'iPhone 18 Pro Max 256GB 黑色',availableNowForLine:false,availabilityQuote:'不可取货'},
  ]}}, {storeId:'OTHER',storeName:'其他门店',availability:{lineItemAvailability:[]}}
 ]}}}}}}}}};
 const result=parseBagxFulfillment(payload,products,'Apple 青岛万象城',1000);
 assert.deepEqual(result.A,{status:'available',message:'今天 可取货',checkedAt:1000,storeId:'R557'});
 assert.equal(result.B.status,'unavailable');assert.equal(result.C.status,'unknown');
});
