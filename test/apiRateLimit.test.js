const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiRateLimiter } = require('../src/apiRateLimit');

test('API rate limit bounds writes, reads and tracked clients without trusting headers', () => {
  let now = 0;
  const limiter = new ApiRateLimiter({clock:()=>now,requests:3,writes:1,windowMs:1000,maxClients:2});
  const req = (ip,method='GET') => ({method,socket:{remoteAddress:ip},headers:{'x-forwarded-for':'spoofed'}});
  limiter.check(req('a','POST'));
  limiter.check(req('a'));
  assert.throws(()=>limiter.check(req('a','POST')), {statusCode:429});
  limiter.check(req('a'));
  assert.throws(()=>limiter.check(req('a')), {statusCode:429});
  limiter.check(req('b'));
  assert.throws(()=>limiter.check(req('c')), {statusCode:429});
  now=1000;
  limiter.check(req('c','POST'));
  limiter.check({method:'GET'});
});
