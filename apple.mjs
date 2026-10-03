import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { classify, readMode } from './status.mjs';
import {defaults,productUrl as configuredUrl} from './config.mjs';
import {parseFulfillment} from './inventory.mjs';

const productUrl = configuredUrl(defaults);
const watch = process.argv.includes('--watch');
const headless = process.argv.includes('--check');
const messages = {
  SERVICE_ERROR:'官网请求失败；库存未知，不能加购。',
  WRONG_PRODUCT:'页面配置未通过核对；已停止。',
  UNKNOWN:'配送信息或取货入口尚不可用；库存未知。',
  NEEDS_STORE_CHECK:'取货入口可检查了；请核实泰国所选门店库存。这不是有货通知。',
};

export async function inspect(page,config=defaults,signal) {
  let fulfillmentStatus = null;
  const observe = response => {
    if (new URL(response.url()).pathname === '/th/shop/fulfillment-messages') fulfillmentStatus = response.status();
  };
  page.on('response', observe);
  try {
    const response = await page.goto(configuredUrl(config), {waitUntil:'domcontentloaded', timeout:45000});
    // 官网异步加载配送信息；超时后保留“未知”，不能当成缺货。
    await sleep(15000,undefined,{signal});
    const selected = await page.locator('input:checked').evaluateAll(inputs =>
      Object.fromEntries(inputs.map(input => [input.name,input.value])));
    const controls = page.locator('a:visible,button:visible').filter({hasText:/取货|自取|到店|รับสินค้า|รับด้วยตัวเอง|pickup/i});
    const add = page.getByRole('button',{name:/添加到购物袋|เพิ่มลงในถุง|Add to Bag/i}).first();
    return {title:await page.title(), selected, httpStatus:response?.status() ?? null,
      fulfillmentStatus, pickupControls:await controls.count(), addEnabled:await add.count() === 1 && await add.isEnabled()};
  } finally { page.off('response', observe); }
}

export async function fetchFamilyInventory(page,family,signal,target={id:'R733',name:'Central World'}) {
  if(signal?.aborted)throw new DOMException('已停止','AbortError');
  if(!page.url().startsWith('https://www.apple.com/th/'))await page.goto(family[0].productUrl,{waitUntil:'domcontentloaded',timeout:45000});
  const store=typeof target==='string'?target:target?.id;
  const storeName=typeof target==='string'?target:`Apple ${target?.name??'Central World'}`;
  const response=await page.evaluate(async({parts,store})=>{
    const params=new URLSearchParams();
    params.set('pl','true');
    params.set('mts.0','regular');
    params.set('store',store);
    parts.forEach((part,index)=>params.set(`parts.${index}`,part));
    const reply=await fetch(`/th/shop/fulfillment-messages?${params}`,{credentials:'include',headers:{Accept:'application/json'}});
    return {status:reply.status,type:reply.headers.get('content-type')??'',body:await reply.text()};
  },{parts:family.map(product=>product.partNumber),store});
  if(response.status!==200){
    const pageNotFound=response.status===541&&/Page Not Found/i.test(response.body);
    const error=new Error(pageNotFound
      ?'Apple 供货接口返回 Page Not Found：所选门店或货号配置未被识别，请检查地区/门店/型号选择后重试。'
      :`Apple 库存服务返回 ${response.status}；若持续出现，多为限流，请降低频率或在 Chrome 中正常刷新后重试。`);
    error.code=pageNotFound?'APPLE_PAGE_NOT_FOUND':`HTTP_${response.status}`;throw error;
  }
  if(!response.type.includes('json')){const error=new Error('Apple 返回的库存内容不是 JSON');error.code='INVALID_RESPONSE';throw error;}
  let payload;
  try{payload=JSON.parse(response.body);}catch{const error=new Error('Apple 库存响应无法解析');error.code='INVALID_RESPONSE';throw error;}
  return parseFulfillment(payload,family.map(product=>product.partNumber),{id:store,name:storeName},Date.now());
}

async function notify(page) {
  process.stdout.write('\x07');
  await page.bringToFront();
  await page.evaluate(message => {
    document.title = '需要检查门店库存 - ' + document.title;
    if (Notification.permission === 'granted') new Notification('Apple 取货入口状态变化', {body:message});
  }, messages.NEEDS_STORE_CHECK);
}

async function monitor(page) {
  let delay = 60000;
  let notified = false;
  while (!page.isClosed()) {
    let observation;
    try { observation = await inspect(page); }
    catch (error) {
      if (!watch || page.isClosed()) throw error;
      console.error(new Date().toISOString(), '页面读取失败', error.name, '将退避重试');
    }
    const state = observation ? classify(observation) : {code:'SERVICE_ERROR',retry:true};
    console.log(new Date().toISOString(), state.code, messages[state.code], JSON.stringify(observation ?? {}));
    if (state.code === 'NEEDS_STORE_CHECK' && !notified) { await notify(page); notified = true; }
    if (!watch || !state.retry) return;
    console.log(`${delay / 1000} 秒后再检查；Ctrl+C 停止。`);
    await sleep(delay);
    delay = state.code === 'SERVICE_ERROR' ? Math.min(delay * 2, 900000) : 60000;
  }
}

async function setup(page) {
  await page.goto(productUrl, {waitUntil:'domcontentloaded',timeout:45000});
  const terminal = createInterface({input:process.stdin,output:process.stdout});
  try {
    await terminal.question('准备模式不刷新、不购买。请在此 Chrome 中打开泰国 Apple 供货窗口，选择 Pro / 256GB / Black / Central World；保持窗口打开后回终端按回车：');
    const dialogs = page.getByRole('dialog').filter({hasText:/iPhone\s*供货情况/});
    if (await dialogs.count() !== 1) throw new Error('未找到唯一的 iPhone 供货情况窗口，未保存报告；请重新准备。');
    const controls = await dialogs.locator('button,a,label,input,select').evaluateAll(nodes => nodes.map(node => ({
      tag:node.tagName, role:node.getAttribute('role'), name:node.getAttribute('name'),
      text:node.textContent?.trim(), ariaLabel:node.getAttribute('aria-label'), disabled:node.disabled ?? null,
    })));
    const report = {time:new Date().toISOString(),title:await page.title(),text:await dialogs.innerText(),controls};
    await writeFile(new URL('./.local/setup-report.json',import.meta.url),JSON.stringify(report,null,2));
    console.log('供货窗口报告已保存到 .local/setup-report.json；未加购或下单。关闭浏览器后会保留该独立会话。');
  } finally { terminal.close(); }
}

async function main() {
  const mode = readMode(process.argv.slice(2));
  const context = await chromium.launchPersistentContext(fileURLToPath(new URL('./.local/chrome',import.meta.url)), {
    channel:'chrome', chromiumSandbox:true, headless, locale:'zh-CN', viewport:{width:1280,height:900},
  });
  try {
  await context.grantPermissions(['notifications'],{origin:'https://www.apple.com'});
    const page = context.pages()[0] ?? await context.newPage();
    console.log('诊断/页面入口监测版：不会加购或下单，未实现门店库存判断。');
    if (mode === 'setup') await setup(page);
    else await monitor(page);
    if (!headless && !page.isClosed()) { console.log('可在浏览器手动检查，关闭窗口结束。'); await new Promise(resolve => context.once('close',resolve)); }
  } finally { await context.close(); }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('运行失败：', error.name, error.message.split('\n')[0]); process.exitCode = 1; });
}
