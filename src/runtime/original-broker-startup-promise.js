// Finite adapter for this entry's actual import/start/close Promises. It owns no
// resource or authority; the one surrounding original custody Root stays live.
import { types } from 'node:util';
const NativePromise = Promise, then = Promise.prototype.then, apply = Reflect.apply;
const keys = Reflect.ownKeys, descriptor = Object.getOwnPropertyDescriptor, own = Object.hasOwn;
const prototype = Object.getPrototypeOf;
const unknown = Object.freeze(Object.defineProperty(Object.create(null), 'unknown', { get() {} }));
export function observeOriginalBrokerPromise(stock, retained, raw) {
  retained.push(raw);
  const scan = () => {
    for (const name of keys(raw)) {
      const field = descriptor(raw, name);
      if (!field || !own(field, 'value')) { stock.inventory(unknown); continue; }
      if (name === 'constructor' && field.value === NativePromise) continue;
      stock.inventory(field.value);
    }
  };
  if (!types.isPromise(raw) || types.isProxy(raw) || prototype(raw) !== NativePromise.prototype) {
    stock.inventory(unknown);
    throw Error('BROKER_ORIGINAL_PROMISE_UNCONFIRMED');
  }
  scan();
  return new NativePromise((yes, no) => {
    apply(then, raw, [value => {
      try { scan(); yes({ value }); }
      catch (error) { stock.inventory(error); no(error); }
    }, error => {
      try { scan(); stock.inventory(error); }
      catch (secondary) { retained.push(secondary); stock.inventory(secondary); }
      no(error);
    }]);
  });
}
