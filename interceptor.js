(()=>{
 const publish=(type,payload)=>window.postMessage({source:'apple-stock-bridge',type,payload},location.origin);
  const isBagx=url=>{try{const parsed=new URL(url,location.href);return parsed.origin===location.origin&&parsed.pathname==='/th/shop/bagx';}catch{return false;}};
 // 只认 Apple 现网的零售自提库存接口。已被下线、恒定返回 541 的历史端点不在此列：
 // 一旦把它也当作模板捕获，relay 重放时就会被打回死接口（2026-09-22 实测事故）。
  const isPickup=url=>{try{const parsed=new URL(url,location.href);return parsed.origin===location.origin&&parsed.pathname==='/th/shop/fulfillment-messages';}catch{return false;}};
 const originalFetch=window.fetch;
 window.fetch=async(...args)=>{
  const [resource,init]=args;
  // 捕获真实发出的供货查询请求（URL + 可见请求头），供 relay 原样重放，
  // 使本工具的请求形态与真人页面一致，降低被识别为脚本而导致的 541。
  if(isPickup(resource)){try{const req=new Request(resource,init);publish('fulfillment-request',{url:req.url,method:req.method,headers:Object.fromEntries(req.headers.entries())});}catch{}}
  const response=await originalFetch(...args);
  if(isBagx(response.url)&&response.headers.get('content-type')?.includes('json'))response.clone().json().then(payload=>publish('bagx-response',payload)).catch(()=>{});
  if(isPickup(response.url)&&response.headers.get('content-type')?.includes('json'))response.clone().json().then(payload=>{const url=new URL(response.url);publish('fulfillment-page-response',{status:Number(payload?.head?.status)||response.status,store:url.searchParams.get('store'),payload});}).catch(()=>{});
  return response;
 };
 const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;
 XMLHttpRequest.prototype.open=function(method,url,...rest){this.__appleBagx=isBagx(url);return open.call(this,method,url,...rest);};
 XMLHttpRequest.prototype.send=function(...args){
  if(this.__appleBagx)this.addEventListener('load',()=>{try{const payload=this.responseType==='json'?this.response:JSON.parse(this.responseText);publish('bagx-response',payload);}catch{}},{once:true});
  return send.apply(this,args);
 };
})();
