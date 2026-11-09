import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAimpJson} from '../src/aimp/json.js';
test('AIMP strict JSON preserves authority by rejecting duplicate, invalid Unicode and unsafe numeric values',()=>{
 assert.deepEqual(parseAimpJson('{"roomId":"a","payload":{"must_understand":true}}'),{roomId:'a',payload:{must_understand:true}});
 for(const raw of ['{"act":"chat","act":"accept"}','{"x":{"a":1,"a":2}}','{"x":"\\ud800"}','{"epoch":9007199254740992}','{"budget":0.25}'])assert.throws(()=>parseAimpJson(raw));
});
