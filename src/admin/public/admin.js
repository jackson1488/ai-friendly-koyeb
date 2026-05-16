function updateTime() {
  const el = document.getElementById('current-time');
  if (el) el.textContent = new Date().toLocaleTimeString('ru-RU');
}
setInterval(updateTime, 1000);
updateTime();

function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) sidebar.classList.toggle('open');
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 200ms';
    setTimeout(() => toast.remove(), 200);
  }, 3000);
}

const params = new URLSearchParams(location.search);
if (params.get('success')) showToast('Сохранено успешно');
if (params.get('error')) showToast('Произошла ошибка', 'error');

document.querySelectorAll('[data-confirm]').forEach((el) => {
  el.addEventListener('click', (e) => {
    if (!confirm(el.dataset.confirm)) e.preventDefault();
  });
});

document.querySelectorAll('.nav-item').forEach((link) => {
  if (!link.href) return;
  const linkPath = new URL(link.href).pathname;
  if (linkPath === '/admin' && location.pathname === '/admin') {
    link.classList.add('active');
  } else if (linkPath !== '/admin' && location.pathname.startsWith(linkPath)) {
    link.classList.add('active');
  }
});
