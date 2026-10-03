import {defaults,productTitle} from './config.mjs';
export function readMode(args) {
  if (args.length > 1 || args.some(arg => !['--setup','--watch','--check'].includes(arg))) {
    throw new Error('用法：node apple.mjs [--setup 或 --watch 或 --check]');
  }
  return args[0]?.slice(2) ?? 'open';
}

export function classify(observation,config=defaults) {
  const {httpStatus, fulfillmentStatus, title, selected, pickupControls, addEnabled} = observation;
  if ([httpStatus, fulfillmentStatus].some(status => status >= 400)) {
    return {code:'SERVICE_ERROR', retry:true};
  }
  const expected = {dimensionScreensize:config.model, dimensionColor:config.color, dimensionCapacity:config.capacity};
  const correct = Object.entries(expected).every(([key,value]) => selected?.[key] === value);
  if (!correct || !(title ?? '').replace(/\s+/g,' ').includes(productTitle(config))) {
    return {code:'WRONG_PRODUCT', retry:false};
  }
  if (httpStatus !== 200 || fulfillmentStatus !== 200 || !pickupControls || !addEnabled) {
    return {code:'UNKNOWN', retry:true};
  }
  return {code:'NEEDS_STORE_CHECK', retry:true};
}
