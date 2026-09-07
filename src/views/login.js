const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const messages = {
  transport: 'Ứng dụng yêu cầu cookie HTTPS nhưng bạn đang truy cập qua HTTP. Hãy dùng địa chỉ HTTPS qua reverse proxy; nếu chạy nội bộ bằng HTTP, đặt COOKIE_SECURE=false rồi tạo lại container.',
  credentials: 'Tên đăng nhập hoặc mật khẩu không đúng. Vui lòng kiểm tra và thử lại.',
  missing: 'Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.',
  expired: 'Phiên đăng nhập đã hết hạn. Vui lòng thử đăng nhập lại.',
  limited: 'Bạn đã thử đăng nhập quá nhiều lần. Vui lòng đợi 15 phút rồi thử lại.',
  configuration: 'Đăng nhập chưa được cấu hình đầy đủ. Vui lòng liên hệ quản trị viên.',
  unavailable: 'Không thể kết nối dịch vụ đăng nhập lúc này. Vui lòng tải lại trang và thử lại.',
};
function loginPage({csrf='', username='', error=''}={}) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Đăng nhập · UAV PMS</title><link rel="stylesheet" href="/assets/style.css"><script src="/assets/login.js" defer></script></head><body class="login"><form method="post" action="/login" class="login-card"><div class="brand">UAV <span>PMS</span></div><h1>Database workspace</h1><p class="muted">Đăng nhập để quản lý dữ liệu của nhóm.</p><div class="error" id="login-error" role="alert" aria-live="polite">${messages[error] || ''}</div><input type="hidden" name="_csrf" value="${escape(csrf)}"><label>Tên đăng nhập<input name="username" autocomplete="username" value="${escape(username)}" required autofocus></label><label>Mật khẩu<input type="password" name="password" autocomplete="current-password" required ${error==='credentials'?'aria-invalid="true" aria-describedby="login-error"':''}></label><button class="primary" ${csrf?'':'disabled'}>Đăng nhập →</button>${error?'<p><a href="/login">Tải lại trang đăng nhập</a></p>':''}<p class="muted">Truy cập nội bộ · Tài khoản giới hạn quyền</p></form></body></html>`;
}
function sendLogin(req,res,status,error) {
  return res.status(status).type('html').send(loginPage({csrf:req.session?.csrf,username:typeof req.body?.username==='string'?req.body.username:'',error}));
}
module.exports={loginPage,sendLogin};
