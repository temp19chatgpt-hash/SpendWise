/**
 * SpendWise - Telegram Integration Module
 * Handles Telegram linking code generation, real-time status polling, and account disconnects.
 */

const TelegramHub = (() => {
  let pollInterval = null;
  let timerInterval = null;
  let remainingSeconds = 300;
  let botUsername = 'SpendWiseExpenseBot';

  async function checkStatus() {
    try {
      const data = await API.telegram.status();
      botUsername = data.bot_username || 'SpendWiseExpenseBot';
      updateStatusBadge(data.connected);
      return data;
    } catch (err) {
      console.warn('Failed to check Telegram status:', err);
      return { connected: false, bot_username: 'SpendWiseExpenseBot' };
    }
  }

  function updateStatusBadge(isConnected) {
    const badges = document.querySelectorAll('.js-telegram-status-badge');
    badges.forEach(badge => {
      if (isConnected) {
        badge.className = 'badge badge-connected js-telegram-status-badge';
        badge.innerHTML = '<span class="badge-dot"></span> Telegram Connected';
      } else {
        badge.className = 'badge badge-disconnected js-telegram-status-badge';
        badge.innerHTML = '<span class="badge-dot"></span> Telegram Disconnected';
      }
    });

    const bannerActions = document.querySelectorAll('.js-telegram-action-btn');
    bannerActions.forEach(btn => {
      if (isConnected) {
        btn.textContent = 'Manage Connection';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-outline');
      } else {
        btn.textContent = 'Connect Telegram';
        btn.classList.remove('btn-outline');
        btn.classList.add('btn-primary');
      }
    });
  }

  async function openModal() {
    const modal = document.getElementById('telegramModal');
    if (!modal) return;

    modal.classList.add('is-open');

    // Check status first
    const status = await checkStatus();
    if (status.connected) {
      showConnectedView();
    } else {
      showConnectStartView();
    }
  }

  function closeModal() {
    const modal = document.getElementById('telegramModal');
    if (modal) modal.classList.remove('is-open');
    stopPolling();
    stopTimer();
  }

  function showConnectStartView() {
    const content = document.getElementById('telegramModalContent');
    if (!content) return;

    content.innerHTML = `
      <div style="text-align: center; padding: 1rem 0;">
        <div class="empty-state-icon" style="background: #EBF7FF; color: #2AABEE; margin: 0 auto 1.25rem;">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.52 2.77-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
          </svg>
        </div>
        <h3 style="margin-bottom: 0.5rem;">Connect SpendWise to Telegram</h3>
        <p style="font-size: 0.9375rem; margin-bottom: 1.5rem;">
          Message your daily expenses like <code>"Tea 20"</code> or <code>"Lunch 180"</code>. Gemini categorizes them instantly and saves them to your account.
        </p>

        <div style="background: var(--bg-surface-subtle); padding: 1.25rem; border-radius: var(--radius-md); text-align: left; margin-bottom: 1.5rem; font-size: 0.875rem;">
          <div style="font-weight: 600; margin-bottom: 0.5rem; color: var(--text-primary);">How it works:</div>
          <ol style="padding-left: 1.25rem; display: flex; flex-direction: column; gap: 0.35rem; color: var(--text-secondary);">
            <li>Click <strong>Generate Linking Code</strong> below.</li>
            <li>Open <strong>@${botUsername}</strong> in Telegram.</li>
            <li>Send <code>/link YOUR_CODE</code> to the bot.</li>
          </ol>
        </div>

        <button id="btnGenerateLinkCode" class="btn btn-primary btn-lg w-full">
          Generate Linking Code
        </button>
      </div>
    `;

    document.getElementById('btnGenerateLinkCode')?.addEventListener('click', generateCode);
  }

  async function generateCode() {
    const btn = document.getElementById('btnGenerateLinkCode');
    if (btn) btn.classList.add('btn-loading');

    try {
      const res = await API.telegram.linkCode();
      showActiveCodeView(res.code, res.expires_in_seconds || 300);
    } catch (err) {
      showToast(err.message || 'Failed to generate linking code', 'error');
      if (btn) btn.classList.remove('btn-loading');
    }
  }

  function showActiveCodeView(code, seconds) {
    remainingSeconds = seconds;
    const content = document.getElementById('telegramModalContent');
    if (!content) return;

    content.innerHTML = `
      <div>
        <div style="text-align: center; margin-bottom: 1.25rem;">
          <h3 style="margin-bottom: 0.35rem;">Send this code to the bot</h3>
          <p style="font-size: 0.875rem;">Open Telegram and send this command to link your account:</p>
        </div>

        <div class="telegram-code-box">
          <div style="font-size: 0.8125rem; color: var(--text-muted); font-weight: 600;">LINKING COMMAND</div>
          <div class="code-display" id="linkCommandText">/link ${code}</div>
          <button id="btnCopyCode" class="btn btn-outline btn-sm" style="margin-top: 0.25rem;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Copy Command
          </button>
          <div class="code-timer">
            <span class="pulse-indicator"></span>
            Waiting for Telegram confirmation... (<span id="countdownTimer">${formatTimer(remainingSeconds)}</span> remaining)
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1.5rem;">
          <a href="https://t.me/${botUsername}" target="_blank" rel="noopener noreferrer" class="btn btn-primary w-full">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.52 2.77-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
            </svg>
            Open @${botUsername} in Telegram
          </a>
          <button id="btnCancelLinking" class="btn btn-ghost w-full">Cancel</button>
        </div>
      </div>
    `;

    document.getElementById('btnCopyCode')?.addEventListener('click', () => {
      const command = `/link ${code}`;
      navigator.clipboard.writeText(command).then(() => {
        showToast('Command copied to clipboard!', 'success', 2500);
      }).catch(() => {
        showToast('Failed to copy. Please select and copy manually.', 'info');
      });
    });

    document.getElementById('btnCancelLinking')?.addEventListener('click', () => {
      stopPolling();
      stopTimer();
      showConnectStartView();
    });

    startTimer();
    startPolling();
  }

  function startTimer() {
    stopTimer();
    timerInterval = setInterval(() => {
      remainingSeconds--;
      const timerEl = document.getElementById('countdownTimer');
      if (timerEl) {
        timerEl.textContent = formatTimer(remainingSeconds);
      }
      if (remainingSeconds <= 0) {
        stopTimer();
        stopPolling();
        showToast('Linking code expired. Please generate a new one.', 'warning');
        showConnectStartView();
      }
    }, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function formatTimer(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function startPolling() {
    stopPolling();
    pollInterval = setInterval(async () => {
      try {
        const res = await API.telegram.status();
        if (res.connected) {
          stopPolling();
          stopTimer();
          showToast('Telegram account linked successfully!', 'success');
          updateStatusBadge(true);
          showConnectedView();
        }
      } catch (err) {
        // Silently continue polling
      }
    }, 3000);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  function showConnectedView() {
    const content = document.getElementById('telegramModalContent');
    if (!content) return;

    content.innerHTML = `
      <div style="text-align: center; padding: 1rem 0;">
        <div class="empty-state-icon" style="background: var(--success-light); color: var(--success); margin: 0 auto 1.25rem;">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>
        <h3 style="margin-bottom: 0.35rem;">Telegram is Connected!</h3>
        <p style="font-size: 0.9375rem; color: var(--text-secondary); margin-bottom: 1.5rem;">
          Your SpendWise account is actively linked with <strong>@${botUsername}</strong>.
        </p>

        <div style="background: var(--bg-surface-subtle); border-radius: var(--radius-md); padding: 1.25rem; text-align: left; font-size: 0.875rem; margin-bottom: 1.5rem;">
          <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.5rem;">Quick Tips for Recording:</div>
          <ul style="padding-left: 1.25rem; display: flex; flex-direction: column; gap: 0.35rem; color: var(--text-secondary);">
            <li>Send single items: <code>Tea 20</code></li>
            <li>Send multiple items with dates:
              <pre style="background: #FFF; padding: 0.5rem; border-radius: 4px; margin-top: 0.25rem; font-family: var(--font-mono); font-size: 0.8125rem;">20 Oct:\nTea 20\nLunch 150</pre>
            </li>
            <li>The bot previews all expenses before saving.</li>
          </ul>
        </div>

        <div style="display: flex; gap: 0.75rem;">
          <a href="https://t.me/${botUsername}" target="_blank" rel="noopener noreferrer" class="btn btn-outline" style="flex: 1;">
            Open Bot
          </a>
          <button id="btnDisconnectTelegram" class="btn btn-danger-outline" style="flex: 1;">
            Disconnect
          </button>
        </div>
      </div>
    `;

    document.getElementById('btnDisconnectTelegram')?.addEventListener('click', disconnectTelegram);
  }

  async function disconnectTelegram() {
    if (!confirm('Are you sure you want to disconnect your Telegram account from SpendWise?')) {
      return;
    }

    const btn = document.getElementById('btnDisconnectTelegram');
    if (btn) btn.classList.add('btn-loading');

    try {
      await API.telegram.disconnect();
      showToast('Telegram disconnected successfully.', 'info');
      updateStatusBadge(false);
      showConnectStartView();
    } catch (err) {
      showToast(err.message || 'Failed to disconnect Telegram', 'error');
      if (btn) btn.classList.remove('btn-loading');
    }
  }

  function init() {
    checkStatus();

    // Attach trigger clicks
    document.querySelectorAll('.js-open-telegram-modal').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openModal();
      });
    });

    document.querySelectorAll('.js-close-telegram-modal').forEach(btn => {
      btn.addEventListener('click', closeModal);
    });

    const modal = document.getElementById('telegramModal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
      });
    }
  }

  return {
    init,
    open: openModal,
    close: closeModal,
    checkStatus,
  };
})();
