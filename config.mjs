import {readFileSync} from 'node:fs';
export const catalog=JSON.parse(readFileSync(new URL('./catalog.json',import.meta.url),'utf8'));
export const storeCatalog=JSON.parse(readFileSync(new URL('./stores.json',import.meta.url),'utf8'));
export const models={'6_3inch':'iPhone 18 Pro','6_9inch':'iPhone 18 Pro Max'};
export const colors={black:'Black',silver:'Silver',glacier:'Glacier',burgundy:'Burgundy'};
export const defaults={model:'6_3inch',color:'black',capacity:'256gb',quantity:1,store:'Central World',interval:120,maxPrice:null};
export function validateConfig(input) {
 const c={...defaults,...input};
 const match=catalog.products.find(p=>p.model===c.model&&p.color===c.color&&p.capacity===c.capacity);
 if(!match) throw new Error('请选择有效的机型、颜色和容量。');
 if(c.quantity!==1||!storeCatalog.stores.some(store=>store.name===c.store)) throw new Error('当前仅支持 1 台、泰国直营店自提。');
 if(!Number.isInteger(c.interval)||c.interval<120||c.interval>900) throw new Error('检查间隔应为 120–900 秒的整数。');
 if(c.maxPrice!==null&&(!Number.isFinite(c.maxPrice)||c.maxPrice<=0)) throw new Error('价格上限无效。');
 return Object.fromEntries(Object.keys(defaults).map(key=>[key,c[key]]));
}
export function productUrl(c) {
 const checked=validateConfig(c);
 const part=catalog.products.find(p=>p.model===checked.model&&p.color===checked.color&&p.capacity===checked.capacity).part;
 const family=checked.model==='6_9inch'?'iphone-18-pro-max':'iphone-18-pro';
 return `https://www.apple.com/th/shop/buy-iphone/${family}/${part.toLowerCase()}`;
}
export function productTitle(c) {return `${models[c.model]} ${c.capacity.toUpperCase()} ${colors[c.color]}`;}
