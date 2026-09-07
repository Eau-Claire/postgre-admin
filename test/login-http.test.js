const {test} = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const {createApp} = require('../src/app');

test('HTTP login supports visible errors, session cookies and successful redirect', async () => {
  const original = Object.fromEntries(['SESSION_SECRET','ADMIN_USERNAME','ADMIN_PASSWORD_HASH','COOKIE_SECURE'].map(k=>[k,process.env[k]]));
  process.env.SESSION_SECRET='test-only-secret-at-least-32-characters';
  process.env.ADMIN_USERNAME='fixture-admin';
  process.env.ADMIN_PASSWORD_HASH=bcrypt.hashSync('fixture-password',4);
  process.env.COOKIE_SECURE='false';
  const server=createApp({sessionStore:new session.MemoryStore()}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try {
    const get=await fetch(base+'/login');
    assert.equal(get.status,200);
    assert.ok(!get.headers.get('content-security-policy').includes('upgrade-insecure-requests'));
    assert.equal(get.headers.get('strict-transport-security'),null);
    const html=await get.text();
    assert.match(html,/\/assets\/login.js/);
    let cookie=get.headers.get('set-cookie').split(';')[0];
    let csrf=html.match(/name="_csrf" value="([^"]+)"/)[1];
    const post=(data)=>fetch(base+'/login',{method:'POST',redirect:'manual',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf,username:'fixture-admin',password:'fixture-password',...data})});
    const wrong=await post({password:'incorrect'});
    assert.equal(wrong.status,401);
    assert.match(await wrong.text(),/Tên đăng nhập hoặc mật khẩu không đúng/);
    const missing=await post({password:''});
    assert.equal(missing.status,400);
    assert.match(await missing.text(),/nhập đầy đủ/);
    const expired=await post({_csrf:'invalid'});
    assert.equal(expired.status,403);
    assert.match(await expired.text(),/hết hạn/);
    const success=await post({});
    assert.equal(success.status,302);
    assert.equal(success.headers.get('location'),'/tables');
    const signedInCookie=success.headers.get('set-cookie').split(';')[0];
    assert.notEqual(signedInCookie,cookie);
    const table=await fetch(base+'/tables',{redirect:'manual',headers:{Cookie:signedInCookie}});
    assert.equal(table.status,200);
    assert.match(await table.text(),/Table Editor/);
    const asset=await fetch(base+'/assets/login.js');
    assert.equal(asset.status,200);
    assert.match(await asset.text(),/Đang đăng nhập/);
    cookie=signedInCookie;
    const freshPage=await fetch(base+'/login',{headers:{Cookie:cookie}});
    csrf=(await freshPage.text()).match(/name="_csrf" value="([^"]+)"/)[1];
    for(let i=0;i<7;i++)await post({password:'incorrect'});
    const limited=await post({password:'incorrect'});
    assert.equal(limited.status,429);
    assert.match(await limited.text(),/quá nhiều lần/);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    for(const [k,v] of Object.entries(original))v===undefined?delete process.env[k]:process.env[k]=v;
  }
});

test('secure-cookie misconfiguration on HTTP shows a visible error without forcing HTTPS', async () => {
  const previous={secret:process.env.SESSION_SECRET,secure:process.env.COOKIE_SECURE};
  process.env.SESSION_SECRET='test-only-secret-at-least-32-characters';
  process.env.COOKIE_SECURE='true';
  const server=createApp({sessionStore:new session.MemoryStore()}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/login');
    assert.equal(response.status,503);
    const csp=response.headers.get('content-security-policy');
    assert.ok(!csp.includes('upgrade-insecure-requests'));
    assert.ok(csp.includes("form-action 'self'"));
    assert.equal(response.headers.get('strict-transport-security'),null);
    assert.match(await response.text(),/COOKIE_SECURE=false/);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    for(const [k,v] of [['SESSION_SECRET',previous.secret],['COOKIE_SECURE',previous.secure]])v===undefined?delete process.env[k]:process.env[k]=v;
  }
});
