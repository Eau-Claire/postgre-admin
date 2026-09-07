'use strict';
const form = document.querySelector('.login-card');
const button = form.querySelector('button');
const error = document.getElementById('login-error');
let submitting = false;
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  submitting = true;
  button.disabled = true;
  button.textContent = 'Đang đăng nhập…';
  error.textContent = '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(form.action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams(new FormData(form)),
      signal: controller.signal,
    });
    if (response.ok && new URL(response.url).pathname === '/tables') {
      window.location.assign('/tables');
      return;
    }
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    const token = page.querySelector('input[name="_csrf"]');
    if (token) form.elements._csrf.value = token.value;
    error.textContent = page.getElementById('login-error')?.textContent.trim() ||
      (response.ok
        ? 'Không lưu được phiên đăng nhập. Kiểm tra cookie của trình duyệt và cấu hình HTTP/HTTPS, rồi tải lại trang.'
        : response.status === 429
          ? 'Bạn đã thử quá nhiều lần. Vui lòng đợi 15 phút rồi thử lại.'
          : 'Dịch vụ đăng nhập gặp lỗi. Vui lòng tải lại trang và thử lại.');
    form.elements.password.value = '';
    form.elements.password.focus();
  } catch (err) {
    error.textContent = err.name === 'AbortError'
      ? 'Đăng nhập quá thời gian chờ. Kiểm tra kết nối rồi thử lại.'
      : 'Không kết nối được máy chủ. Kiểm tra mạng và địa chỉ HTTP/HTTPS rồi thử lại.';
  } finally {
    clearTimeout(timer);
    submitting = false;
    button.disabled = false;
    button.textContent = 'Đăng nhập →';
  }
});
