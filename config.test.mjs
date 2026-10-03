import test from 'node:test';
import assert from 'node:assert/strict';
import {validateConfig, productUrl, productTitle, defaults} from './config.mjs';
import {classify} from './status.mjs';

test('配置映射到官网真实货号，不接受任意网址或额外数量',()=>{
 assert.match(productUrl(defaults),/mjt74ch\/a$/);
 const c=validateConfig({...defaults,model:'6_9inch',capacity:'512gb',color:'glacier'});
 assert.match(productUrl(c),/mjye4ch\/a$/);
 assert.equal(productTitle(c),'iPhone 18 Pro Max 512GB 冰川蓝色');
 for(const change of [{model:'bad'},{color:'gold'},{quantity:2},{store:'任意门店'},{interval:0},{interval:NaN},{interval:60.5},{maxPrice:-1},{maxPrice:'100'}]) assert.throws(()=>validateConfig({...defaults,...change}));
});
test('配置检查按当前所选机型判断，不能固定为默认黑色 Pro',()=>{
 const c={...defaults,model:'6_9inch',capacity:'512gb',color:'glacier'};
 const observation={title:productTitle(c),selected:{dimensionScreensize:c.model,dimensionCapacity:c.capacity,dimensionColor:c.color},httpStatus:200,fulfillmentStatus:200,pickupControls:1,addEnabled:true};
 assert.equal(classify(observation,c).code,'NEEDS_STORE_CHECK');
 assert.equal(classify(observation,defaults).code,'WRONG_PRODUCT');
});
