const modelNames={'6_3inch':'iPhone 18 Pro','6_9inch':'iPhone 18 Pro Max'};
const familyIds={'6_3inch':'iphone-18-pro','6_9inch':'iphone-18-pro-max'};
const colorNames={black:'Black',silver:'Silver',glacier:'Glacier',burgundy:'Burgundy'};

export function normalizeCatalog(products){
 return products.map(row=>({
  familyId:row.familyId??familyIds[row.model]??row.model,
  modelName:row.modelName??modelNames[row.model]??row.model,
  capacity:row.capacity.toUpperCase(),colorName:row.colorName??colorNames[row.color]??row.color,
  partNumber:row.partNumber??row.part,productUrl:row.productUrl??`https://www.apple.com/th/shop/buy-iphone/${row.familyId??familyIds[row.model]??row.model}/${(row.partNumber??row.part).toLowerCase()}`,
 }));
}

export function listFamilies(products){
 const groups=new Map(),seen=new Set();
 for(const product of products){
  if(seen.has(product.partNumber))continue;seen.add(product.partNumber);
  const rows=groups.get(product.familyId)??[];rows.push(product);groups.set(product.familyId,rows);
 }
 return groups;
}

export function nextDelay(failures){return [5,10,30,60][Math.min(Math.max(failures,0),3)];}

function storesFrom(payload){
 if(Array.isArray(payload?.stores))return payload.stores;
 if(Array.isArray(payload?.body?.stores))return payload.body.stores;
 return payload?.body?.content?.pickupMessage?.stores??payload?.body?.PickupMessage?.stores;
}

function inventory(part){
 const value=String(part?.pickupDisplay??part?.pickupStatus??'').toLowerCase();
 if(['available','availabletoday','availablenow'].includes(value))return 'available';
 if(['unavailable','notavailable','not available'].includes(value))return 'unavailable';
 return 'unknown';
}

export function parseFulfillment(payload,partNumbers,target,checkedAt=Date.now()){
 const error=payload?.body?.content?.pickupMessage?.errorMessage ?? payload?.body?.errorMessage ?? payload?.body?.message;
 const result=Object.fromEntries(partNumbers.map(part=>[part,{status:'unknown',message:error?`官网查询失败：${error}`:'响应中未找到目标门店',checkedAt}]));
 const stores=storesFrom(payload);if(!Array.isArray(stores))return result;
 const name=typeof target==='string'?target:target.name,id=typeof target==='object'?target.id:null,normalize=value=>String(value??'').replace(/^Apple\s+/,'');
 const store=stores.find(row=>id&&row?.storeNumber===id||normalize(row?.storeName)===normalize(name));if(!store)return result;
 const parts=store.partsAvailability??store.parts;
 if(!parts||typeof parts!=='object')return result;
 for(const part of partNumbers){
  const row=parts[part];if(!row)continue;
  result[part]={status:inventory(row),message:row.pickupSearchQuote??row.pickupDisplay??'库存状态未知',checkedAt};
 }
 return result;
}

export function parseFulfillmentByStore(payload,partNumbers,stores,checkedAt=Date.now()){
 const result={};
 for(const store of stores){const parsed=parseFulfillment(payload,partNumbers,store,checkedAt);for(const part of partNumbers)result[`${store.id}:${part}`]=parsed[part];}
 return result;
}

export function parseBagxFulfillment(payload,products,storeName,checkedAt=Date.now()){
 const result=Object.fromEntries(products.map(product=>[product.partNumber,{status:'unknown',message:'响应中没有此配置',checkedAt}]));
 const items=payload?.body?.shoppingCart?.items;if(!items||typeof items!=='object')return result;
 const stores=Object.values(items).flatMap(item=>item?.delivery?.storeLocator?.searchResults?.d?.retailStores??[]);
 const store=stores.find(row=>row?.storeName===storeName);if(!store)return result;
 const lines=store.availability?.lineItemAvailability;if(!Array.isArray(lines))return result;
 const byName=new Map(products.map(product=>[[product.modelName,product.capacity,product.colorName].join(' ').replace(/\s+/g,' ').trim(),product]));
 for(const line of lines){
  const product=byName.get(String(line?.partName??'').replace(/\s+/g,' ').trim());if(!product||typeof line.availableNowForLine!=='boolean')continue;
  result[product.partNumber]={status:line.availableNowForLine?'available':'unavailable',message:line.availabilityQuote??(line.availableNowForLine?'可取货':'不可取货'),checkedAt,storeId:store.storeId??null};
 }
 return result;
}

export function transition(previous={status:'unknown'},next,now=Date.now(),staleAfterMs=10000){
 let snapshot=next?{...previous,...next}:{...previous};
 if(!next&&previous.checkedAt&&now-previous.checkedAt>staleAfterMs)snapshot={...previous,status:'stale'};
 return {snapshot,notify:previous.status!=='available'&&snapshot.status==='available'};
}
