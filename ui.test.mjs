import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createApp} from './server.mjs';
import {EventEmitter} from 'node:events';

test('库存看板：折叠配置、单门店型号选择、筛选、分组、键盘、断线和窄屏',async()=>{
 const launch=async()=>{const context=new EventEmitter();context.pages=()=>[{goto:async()=>{},bringToFront:async()=>{},url:()=>''}];context.close=async()=>context.emit('close');return context;};
 const app=createApp({launch});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
 const browser=await chromium.launch({channel:'chrome',chromiumSandbox:true,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900},locale:'zh-CN'});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.waitForFunction(()=>document.getElementById('connection').classList.contains('online'));
  // 已有保存过的配置 → 表单默认收起，摘要要把"在监控什么"说清楚
  assert.equal(await page.locator('#config-form.collapsed').count(),1);
  assert.equal(await page.locator('#config-fields').isVisible(),false);
  assert.match(await page.locator('#config-summary').textContent(),/山东 .*青岛万象城.*iPhone 18 Pro/);
  assert.equal(await page.locator('.card').count(),1);assert.equal(await page.locator('.family').count(),1);
  assert.equal(await page.locator('#count-unknown').textContent(),'1');
  assert.equal(await page.locator('#count-stale').textContent(),'0');
  assert.equal(await page.locator('.card').first().getByText('Chrome 扩展未连接').count(),1);
  // 数据新鲜度：没有同步过时不编造时间
  assert.equal(await page.locator('#freshness-time').textContent(),'尚无数据');
  assert.equal(await page.locator('#freshness-note').textContent(),'扩展未连接');
  await page.locator('#config-toggle').click();
  assert.equal(await page.locator('#config-form.collapsed').count(),0);
  assert.equal(await page.locator('#config-fields').isVisible(),true);
  assert.equal(await page.getByLabel('地区').locator('option').count(),17);
  assert.equal(await page.getByLabel('地区').inputValue(),'山东');
  assert.equal(await page.getByLabel('地区').getByRole('option',{name:'北京',exact:true}).count(),1);
  // 查询间隔可调，默认 120 秒（实测约 64~65 次请求触发 541 窗口，60 秒间隔几乎每小时撞一次线）
  assert.equal(await page.getByLabel('查询间隔').inputValue(),'120');
  assert.equal(await page.getByLabel('查询间隔').locator('option').count(),5);
  assert.equal(await page.getByLabel('门店').getByText('青岛万象城').count(),1);
  assert.equal(await page.locator('#store-options input[type="radio"]').count(),await page.locator('#store-options input').count());
  assert.equal(await page.locator('[data-target="store-options"]').count(),0);
  assert.equal(await page.locator('#selected-store').textContent(),'Apple 青岛万象城');
  assert.equal(await page.locator('#store-summary').textContent(),'已选门店：山东 · 青岛 · 青岛万象城');
  assert.equal(await page.getByLabel('型号').getByText('iPhone Duo').count(),0);
  assert.equal(await page.getByLabel('型号').getByText('iPhone 18 Pro Max').count(),1);
  // 颜色带色点但不影响可读文本
  assert.equal(await page.locator('#color-options .swatch').count(),4);
  // 未保存改动要能被看见
  await page.getByLabel('型号').getByText('iPhone 18 Pro Max').click();
  assert.equal(await page.locator('#save-config.dirty').count(),1);
  assert.match(await page.locator('#save-config').textContent(),/未保存修改/);
  // 0 值的筛选项禁用，避免点进空页
  assert.equal(await page.getByRole('button',{name:/可取货/}).isDisabled(),true);
  await page.getByRole('button',{name:/未知/}).click();
  assert.equal(await page.locator('.card').count(),1);
  await page.getByRole('button',{name:/全部/}).focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.card').count(),1);
  // 分组方式：按机型 / 按门店 / 按 SKU 对比
  await page.getByRole('button',{name:'按门店'}).click();
  assert.equal(await page.locator('.family>h2').textContent(),'Apple 青岛万象城');
  assert.match(await page.locator('.family>p').textContent(),/山东 · 青岛/);
  await page.getByRole('button',{name:'按 SKU 对比'}).click();
  assert.match(await page.locator('.family>p').textContent(),/MJT74CH\/A/);
  await page.getByRole('button',{name:'按机型'}).click();
  assert.equal(await page.locator('.family>h2').textContent(),'iPhone 18 Pro');
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.route('**/api/state',route=>route.abort());await page.waitForFunction(()=>document.getElementById('connection').classList.contains('offline'));
  assert.equal(await page.locator('#connection').textContent(),'连接已断开');assert.deepEqual(errors,[]);
 }finally{await browser.close();await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});

test('看板从浏览器本地恢复上次门店和型号选择',async()=>{
 const app=createApp();await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
 const browser=await chromium.launch({channel:'chrome',chromiumSandbox:true,headless:true});
 try{
  const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('appleStockSelection',JSON.stringify({storeIds:['R648'],partNumbers:['MJT74CH/A']})));
  await page.goto(base);await page.waitForFunction(()=>document.querySelector('#store-options input[value="R648"]')?.checked);
  assert.equal(await page.locator('.card').count(),1);assert.equal(await page.locator('#selected-store').textContent(),'Apple 济南恒隆广场');assert.match(await page.locator('.family>p').textContent(),/济南恒隆广场/);
 }finally{await browser.close();await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});

test('门店严格单选，切换地区会清空当前门店',async()=>{
 const app=createApp();await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
 const browser=await chromium.launch({channel:'chrome',chromiumSandbox:true,headless:true});
 try{
  const page=await browser.newPage({locale:'zh-CN'});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.waitForFunction(()=>document.getElementById('connection').classList.contains('online'));
  await page.locator('#config-toggle').click();
  // 切到北京后，默认选中的山东门店被清空
  await page.getByLabel('地区').selectOption('北京');
  assert.equal(await page.locator('#store-summary').textContent(),'尚未选择门店。');
  await page.locator('#store-options input').first().check();
  assert.match(await page.locator('#store-summary').textContent(),/已选门店：北京/);
  const second=page.locator('#store-options input').nth(1);if(await second.count()){await second.check();assert.equal(await page.locator('#store-options input:checked').count(),1);assert.equal(await page.locator('#store-options input').first().isChecked(),false);}
  // 再切到上海：北京已勾选的门店被清空
  await page.getByLabel('地区').selectOption('上海');
  assert.equal(await page.locator('#store-options input:checked').count(),0);
  assert.equal(await page.locator('#store-summary').textContent(),'尚未选择门店。');
  // 切回北京也不恢复
  await page.getByLabel('地区').selectOption('北京');
  assert.equal(await page.locator('#store-options input:checked').count(),0);
  // 最终只提交上海的一家门店
  await page.getByLabel('地区').selectOption('上海');
  const last=page.locator('#store-options input').last();
  const storeName=(await last.evaluate(node=>node.parentElement.textContent)).split('· ')[1];
  await last.check();
  await page.getByRole('button',{name:'保存并监听'}).click();
  await page.waitForFunction(name=>document.getElementById('selected-store').textContent.includes(name),storeName);
  const state=await (await fetch(base+'/api/state')).json();
  assert.equal(state.selection.storeIds.length,1);
  assert.equal(state.stores.find(store=>store.id===state.selection.storeIds[0]).province,'上海');
  // 保存成功后自动收起表单，回到看库存的主视图
  assert.equal(await page.locator('#config-form.collapsed').count(),1);
  assert.equal(await page.locator('.card').count(),1);assert.deepEqual(errors,[]);
 }finally{await browser.close();await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});

test('查询间隔可调：改间隔即提示未保存，保存后真正下发到扩展配置',async()=>{
 const app=createApp();await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
 const browser=await chromium.launch({channel:'chrome',chromiumSandbox:true,headless:true});
 try{
  const page=await browser.newPage({locale:'zh-CN'});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.waitForFunction(()=>document.getElementById('connection').classList.contains('online'));
  await page.locator('#config-toggle').click();
  assert.equal(await page.getByLabel('查询间隔').inputValue(),'120');
  assert.equal(await page.locator('#save-config.dirty').count(),0);
  // 只改间隔、门店型号都不动，也必须被识别为"有未保存修改"
  await page.getByLabel('查询间隔').selectOption('300');
  assert.equal(await page.locator('#save-config.dirty').count(),1);
  await page.getByRole('button',{name:/保存并监听/}).click();
  await page.waitForFunction(()=>document.querySelector('#config-form')?.classList.contains('collapsed'));
  // 服务端状态、扩展拿到的配置、摘要文案三处都要反映新间隔
  const state=await (await fetch(base+'/api/state')).json();
  assert.equal(state.interval,300);assert.equal(state.selection.interval,300);
  const bridge=await (await fetch(base+'/api/bridge/config',{headers:{Origin:'chrome-extension://abcdefghijklmnop'}})).json();
  assert.equal(bridge.interval,300);assert.equal(bridge.partNumbers.length,1);
  assert.match(await page.locator('#config-summary').textContent(),/300 秒一轮/);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();await app.stop();await new Promise(resolve=>app.server.close(resolve));}
});
