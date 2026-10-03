import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchFamilyInventory} from './apple.mjs';

test('Apple 541 Page Not Found 识别为会话接口异常',async()=>{
 const page={url:()=> 'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjt74ch/a',evaluate:async()=>({status:541,type:'text/html',body:'<title>Page Not Found - Apple</title>'})};
 await assert.rejects(()=>fetchFamilyInventory(page,[{partNumber:'MJT74CH/A'}]),error=>error.code==='APPLE_PAGE_NOT_FOUND');
});
