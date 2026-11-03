

const API_BASE = '/api';


class ApiRequestError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.errors = errors || [];
  }
}


async function request(path, options = {}) {
  const { method = 'GET', body, silent401 = false, headers = {} } = options;

  const config = {
    method,
    headers: { Accept: 'application/json', ...headers },

    
    
    
    
    credentials: 'same-origin',
  };

  if (body !== undefined) {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(API_BASE + path, config);
  } catch (networkError) {
    
    throw new ApiRequestError(
      'Cannot reach the server. Check that the backend is running and you are online.',
      0
    );
  }

  
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    
    if (response.status === 401 && !silent401) {
      redirectToLogin();
    }

    const message =
      (payload && payload.message) ||
      'Something went wrong. Please try again.';

    throw new ApiRequestError(message, response.status, payload && payload.errors);
  }

  return payload ? payload.data : null;
}


function redirectToLogin() {
  const onAdminPage = window.location.pathname.startsWith('/admin/');
  const loginPage = onAdminPage ? '/admin/login.html' : '/login.html';

  if (window.location.pathname !== loginPage) {
    const next = encodeURIComponent(window.location.pathname);
    window.location.href = `${loginPage}?next=${next}`;
  }
}


const api = {
  get:  (path, options)       => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  put:  (path, body, options) => request(path, { ...options, method: 'PUT', body }),
  del:  (path, options)       => request(path, { ...options, method: 'DELETE' }),

  
  raw: (path, options = {}) =>
    fetch(API_BASE + path, { credentials: 'same-origin', ...options }),

  ApiRequestError,
  redirectToLogin,
};




function formatMoney(amount, currency = 'NGN') {
  const value = Number(amount);
  if (Number.isNaN(value)) return '—';

  const symbol = currency === 'NGN' ? '₦' : `${currency} `;
  return symbol + value.toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}


function formatDate(value, withTime = true) {
  if (!value) return '—';
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return '—';

  const opts = { day: '2-digit', month: '2-digit', year: 'numeric' };
  if (withTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; }

  return date.toLocaleString('en-GB', opts);
}


function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
