import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('扩展权限仅限 Apple 页面和本机桥接，不申请 Cookie 权限',async()=>{
 const manifest=JSON.parse(await readFile(new URL('./chrome-extension/manifest.json',import.meta.url),'utf8'));
 assert.equal(manifest.manifest_version,3);
 assert.equal(manifest.version,'1.4.9');
 assert.deepEqual(manifest.host_permissions,['https://www.apple.com.cn/*','http://127.0.0.1:4318/*']);
 assert.equal(manifest.permissions?.includes('cookies')??false,false);
 assert.equal(manifest.content_scripts.some(entry=>entry.world==='MAIN'&&entry.run_at==='document_start'),true);
 assert.equal(manifest.content_scripts.some(entry=>entry.world==='ISOLATED'&&entry.js.includes('relay.js')),true);
 const interceptor=await readFile(new URL('./chrome-extension/interceptor.js',import.meta.url),'utf8');
 const relay=await readFile(new URL('./chrome-extension/relay.js',import.meta.url),'utf8');
 const background=await readFile(new URL('./chrome-extension/background.js',import.meta.url),'utf8');
 // 扩展转发 bagx 与页面自然产生的零售自提响应（不读取/外传 Cookie 或令牌）
 assert.match(interceptor,/bagx-response/);
 assert.match(interceptor,/fulfillment-request/);
 assert.match(interceptor,/fulfillment-page-response/);
 assert.match(interceptor,/retail\/pickup-message/);
 assert.doesNotMatch(interceptor,/cookie/i);
 assert.match(relay,/retail\/pickup-message/);assert.match(relay,/set\('pl','true'\)/);assert.match(relay,/parts\.\$\{index\}/);assert.match(relay,/set\('store',storeNumber\)/);assert.match(relay,/storeIds/);
 assert.match(relay,/cursor%current\.storeIds\.length/);assert.match(relay,/partNumbers\.forEach/);assert.match(relay,/partNumbers=current\.partNumbers/);
 assert.match(relay,/bagx-response/);assert.match(relay,/\[60,120,300,600,900\]/);
 assert.match(relay,/navigator\.locks/);assert.match(relay,/ifAvailable:true/);
 assert.match(relay,/const send=\(\.\.\.args\).*sendMessage\?\.\(\.\.\.args\)/);
 assert.match(relay,/payload\?\.head\?\.status/);assert.match(relay,/finally\{polling=false/);
 // 分级冷却：首档 5 分钟（实测窗口 10~15 分钟，一刀切 1800 秒会「等过头」）；
 // 探测失败直接升档不重新累计连击，探测成功则清空档位恢复全速
 assert.match(relay,/COOLDOWN_STEPS=\[300,600,1200,1800\]/);
 assert.match(relay,/delay=COOLDOWN_STEPS\[cooldownStep\]\*1000/);
 assert.match(relay,/probing&&!ok/);
 assert.match(relay,/if\(ok&&probing\)\{probing=false;cooldownLevel=0;downshift=1;\}/);
 assert.match(relay,/retryAfter:ok\?null/);
 assert.doesNotMatch(relay,/pageCredit/);
 // 回归防线：旧的供货端点绝不允许重新出现在链路上——既不能被捕获，也不能参与重放
 // （2026-09-22 实测事故：模板重放会把请求打回旧端点）
 assert.doesNotMatch(interceptor,/fulfillment-messages/);
 assert.doesNotMatch(relay,/fulfillment-messages/);
 assert.match(relay,/PICKUP_PATH='\/shop\/retail\/pickup-message'/);
 assert.doesNotMatch(relay,/requestTemplate\?\.url/);
 assert.match(relay,/pathname!==PICKUP_PATH/);
 // 541 兼容性防线（2026-09-22 定性：541 是 Apple 的临时限流窗口，约 10-15 分钟自行解除，
 // 与请求头组合、端点、门店配置均无关；窗口期内密集重试会续期）。以下三条防止已知
 // 会削弱防护的写法回来：
 // 1) 熔断计数不得再用 reason 排除 PAGE_NOT_FOUND，否则计数恒为 0、1800 秒熔断永不生效
 assert.doesNotMatch(relay,/reason!=='PAGE_NOT_FOUND'/);
 assert.match(relay,/consecutive541=status===541\?consecutive541\+1:0/);
 // 4) 无痕来源标记必须保留：无痕窗口默认不加载扩展，所以「无痕里不 541」很可能只是「无痕没在轮询」。
 //    该标记是把这个猜测变成可核对事实的唯一端到端证据（relay 自报 + background 用 sender.tab 覆写）。
 assert.match(relay,/incognito:inIncognito/);
 assert.match(background,/sender\.tab\?\.incognito/);
 // 2) 退避与冷却期间的等待不得被顺带唤醒打断，否则会退化成数秒一次并续期限流窗口
 assert.match(relay,/wait\(jitter\(delay\),failures===0\)/);
 // 3) 541 时丢弃请求模板的旧“自愈”已移除：实测请求头与 541 无关，丢模板只会白白放弃头部复用
 assert.doesNotMatch(relay,/PAGE_NOT_FOUND'\)requestTemplate/);
 // 正常节奏必须真正读取本机配置的 interval；默认 120 秒（实测约 64~65 次请求触发 541 窗口，60 秒≈每小时撞一次）
 assert.match(relay,/const intervalSecs=Number\(current\.interval\)\|\|120/);
 assert.match(relay,/failures===0\?intervalSecs/);
 // 配置签名必须包含 interval：此前只比 [partNumbers,storeIds]，导致「只改间隔、门店型号不动」时
 // 扩展一直按旧间隔轮询，看板显示的新间隔与实际生效值不一致
 assert.match(relay,/signature=JSON\.stringify\(\[value\.partNumbers,value\.storeIds,value\.interval,value\.revision\]\)/);
 assert.match(relay,/type:'progress'/);assert.match(background,/message\?\.type==='progress'\?'progress'/);assert.match(background,/api\/bridge\/\$\{path\}/);
 assert.match(relay,/configSignature/);assert.match(relay,/wake\?\.\(\)/);assert.doesNotMatch(relay,/wake\?\.\(true\)/);assert.match(relay,/setInterval\(loadConfig,500\)/);
 assert.match(relay,/AbortSignal\.timeout\(20000\)/);
 assert.match(background,/api\/bridge\/ready/);assert.doesNotMatch(background,/api\/bridge\/config/);
 assert.match(background,/api\/bridge\/watch\?revision=/);
 assert.match(background,/chrome\.tabs\.sendMessage/);
 assert.match(relay,/type==='config-changed'/);
});
