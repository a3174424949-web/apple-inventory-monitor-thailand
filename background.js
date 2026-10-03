chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(!sender.url?.startsWith('https://www.apple.com/th/'))return;
 if(message?.type==='get-config'){
  fetch('http://127.0.0.1:4318/api/bridge/ready',{method:'POST',headers:{'Content-Type':'application/json','X-Apple-Bridge':'1'},body:'{}'}).then(response=>response.json()).then(sendResponse).catch(()=>sendResponse(null));return true;
 }
const path=message?.type==='bridge-ready'?'ready':message?.type==='bagx-response'?'bagx':message?.type==='fulfillment-response'?'fulfillment':message?.type==='progress'?'progress':message?.type==='api-log'?'log':null;if(!path)return;
const body=path==='ready'?{}:message.payload;
// 用 sender.tab 的真实窗口状态覆盖页面侧自报值：sender.tab 由浏览器填写，无法被页面伪造，
// content script 里的 chrome.extension.inIncognitoContext 在部分版本下还可能取不到。
// 有这个字段，才能回答「无痕窗口里到底有没有在轮询」——没有它就只能靠猜。
if(body&&typeof body==='object'&&typeof sender.tab?.incognito==='boolean')body.incognito=sender.tab.incognito;
 fetch(`http://127.0.0.1:4318/api/bridge/${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-Apple-Bridge':'1'},body:JSON.stringify(body)})
  .then(response=>sendResponse({ok:response.ok})).catch(()=>sendResponse({ok:false}));
 return true;
});

let watching=false,revision=-1;
async function watchConfig(){
 if(watching)return;watching=true;
  try{while(true){try{const response=await fetch(`http://127.0.0.1:4318/api/bridge/watch?revision=${revision}`);if(!response.ok)throw new Error();const config=await response.json();if(Number.isInteger(config?.revision)&&config.revision>revision){revision=config.revision;const tabs=await chrome.tabs.query({url:'https://www.apple.com/th/*'});await Promise.allSettled(tabs.map(tab=>chrome.tabs.sendMessage(tab.id,{type:'config-changed'})));}}catch{await new Promise(resolve=>setTimeout(resolve,1000));}}}
 finally{watching=false;}
}
chrome.alarms.create('config-watch',{periodInMinutes:.5});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='config-watch')watchConfig();});
watchConfig();
