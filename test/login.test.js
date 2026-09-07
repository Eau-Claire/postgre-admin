const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loginPage,sendLogin}=require('../src/views/login');
test('login feedback escapes username and never redisplays password',()=>{
  let status,html;
  sendLogin({session:{csrf:'csrf'},body:{username:'"><script>alert(1)</script>',password:'private-password'}},{status(value){status=value;return this;},type(){return this;},send(value){html=value;}},401,'credentials');
  assert.equal(status,401);
  assert.match(html,/Tên đăng nhập hoặc mật khẩu không đúng/);
  assert.match(html,/role="alert"/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('private-password'));
  assert.match(html,/&lt;script&gt;/);
});
test('login reports actionable errors and offers recovery without a session',()=>{
  for(const error of ['missing','expired','limited','configuration','unavailable']){
    const html=loginPage({error});
    assert.match(html,/role="alert"/);
    assert.match(html,/href="\/login"/);
    assert.match(html,/class="primary" disabled/);
  }
});
test('login infrastructure errors stay on the login UI and hide database details',()=>{
  const old=console.error;console.error=()=>{};
  try{
    let status,html;
    require('../src/middleware/errorHandler')(Object.assign(new Error('secret database detail'),{code:'08006'}),{path:'/login'}, {status(value){status=value;return this;},type(){return this;},send(value){html=value;}},()=>{});
    assert.equal(status,503);assert.match(html,/Không thể kết nối/);assert.ok(!html.includes('secret database detail'));
  }finally{console.error=old;}
});
