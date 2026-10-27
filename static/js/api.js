/**
 * SpendWise - Centralized API Client
 * Clean REST API client with credentials, JSON handling, and authentication recovery.
 */

const API = (() => {
  async function request(endpoint, options = {}) {
    const url = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

    const config = {
      ...options,
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    };

    if (config.body && typeof config.body === 'object') {
      config.body = JSON.stringify(config.body);
    }

    try {
      const response = await fetch(url, config);

      // Handle unauthenticated session
      if (response.status === 401) {
        if (!window.location.pathname.startsWith('/login')) {
          window.location.href = '/login?expired=1';
        }
        throw new Error('Your session has expired. Please sign in again.');
      }

      // Handle 204 No Content
      if (response.status === 204) {
        return null;
      }

      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

      if (!response.ok) {
        const errorDetail = (data && typeof data === 'object' && data.detail)
          ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail))
          : (typeof data === 'string' ? data : 'An unexpected error occurred.');
        throw new Error(errorDetail);
      }

      return data;
    } catch (err) {
      if (err.name === 'TypeError' && err.message.includes('fetch')) {
        throw new Error('Network error. Please check your connection and try again.');
      }
      throw err;
    }
  }

  return {
    request,
    auth: {
      me: () => request('/auth/me'),
      logout: () => request('/auth/logout', { method: 'POST' }),
    },
    expenses: {
      list: (params = {}) => {
        const cleanParams = new URLSearchParams();
        Object.entries(params).forEach(([key, val]) => {
          if (val !== undefined && val !== null && val !== '') {
            cleanParams.append(key, val);
          }
        });
        const query = cleanParams.toString();
        return request(`/api/expenses${query ? `?${query}` : ''}`);
      },
      get: (id) => request(`/api/expenses/${id}`),
      create: (data) => request('/api/expenses', { method: 'POST', body: data }),
      update: (id, data) => request(`/api/expenses/${id}`, { method: 'PATCH', body: data }),
      delete: (id) => request(`/api/expenses/${id}`, { method: 'DELETE' }),
      monthlySummary: (year, month) => request(`/api/expenses/summary/monthly?year=${year}&month=${month}`),
      categorySummary: () => request('/api/expenses/summary/categories'),
      overallSummary: () => request('/api/expenses/summary'),
      insights: (year, month) => request('/api/expenses/insights' + (year && month ? `?year=${year}&month=${month}` : '')),
    },
    telegram: {
      status: () => request('/api/telegram/status'),
      linkCode: () => request('/api/telegram/link-code', { method: 'POST' }),
      disconnect: () => request('/api/telegram/disconnect', { method: 'POST' }),
    },
    budgets: {
      list: (year, month) => {
        let q = '';
        if (year && month) q = `?year=${year}&month=${month}`;
        else if (year) q = `?year=${year}`;
        return request(`/api/budgets${q}`);
      },
      summary: (year, month) => request(`/api/budgets/summary?year=${year}&month=${month}`),
      create: (data) => request('/api/budgets', { method: 'POST', body: data }),
      update: (id, data) => request(`/api/budgets/${id}`, { method: 'PATCH', body: data }),
      delete: (id) => request(`/api/budgets/${id}`, { method: 'DELETE' }),
    },
  };
})();

// Global Toast Notification Helper
function showToast(message, type = 'info', duration = 4000) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'alert');

  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  toast.appendChild(textSpan);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-dismiss';
  closeBtn.innerHTML = '&times;';
  closeBtn.setAttribute('aria-label', 'Close toast');
  closeBtn.onclick = () => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 200);
  };
  toast.appendChild(closeBtn);

  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      if (toast.parentElement) {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 200);
      }
    }, duration);
  }
}
