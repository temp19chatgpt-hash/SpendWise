/**
 * SpendWise - First-Login Onboarding Experience
 * Introduces new users to manual expense tracking and Telegram bot sync.
 * Persists completion status across devices/sessions and reuses existing Telegram modal.
 */

const Onboarding = (() => {
  let isInitialized = false;

  function init() {
    if (isInitialized) return;
    isInitialized = true;

    // Connect Telegram CTA
    const btnConnect = document.getElementById('btnOnboardingConnectTelegram');
    if (btnConnect) {
      btnConnect.addEventListener('click', (e) => {
        e.preventDefault();
        dismiss(true);
      });
    }

    // Continue to Dashboard / Dismiss buttons
    document.querySelectorAll('.js-dismiss-onboarding').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        dismiss(false);
      });
    });

    // Close on backdrop click (clicks outside container)
    const modal = document.getElementById('welcomeModal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          dismiss(false);
        }
      });
    }

    // Close on Escape key press if modal is open
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const welcomeModal = document.getElementById('welcomeModal');
        if (welcomeModal && welcomeModal.classList.contains('is-open')) {
          dismiss(false);
        }
      }
    });
  }

  function check(user) {
    if (!user) return;

    // If onboarding is not completed and telegram is not yet connected, show welcome modal
    if (user.onboarding_completed === false && !user.telegram_connected) {
      // Small timeout to allow initial dashboard animations to settle
      setTimeout(() => {
        show();
      }, 250);
    }
  }

  function show() {
    init();
    const modal = document.getElementById('welcomeModal');
    if (!modal) return;

    modal.classList.add('is-open');

    // Accessibility: Focus primary action
    setTimeout(() => {
      const connectBtn = document.getElementById('btnOnboardingConnectTelegram');
      if (connectBtn) {
        connectBtn.focus();
      }
    }, 100);
  }

  async function dismiss(connectTelegram = false) {
    const modal = document.getElementById('welcomeModal');
    if (modal) {
      modal.classList.remove('is-open');
    }

    // Update in-memory user object immediately
    const user = Auth.getUser();
    if (user) {
      user.onboarding_completed = true;
    }

    // Persist completion to backend & database
    try {
      await API.user.completeOnboarding();
    } catch (err) {
      console.warn('Could not persist onboarding completion:', err);
    }

    if (connectTelegram) {
      // Reuse existing Telegram linking flow directly
      if (typeof TelegramHub !== 'undefined' && TelegramHub.open) {
        TelegramHub.open();
      }
    } else {
      // Friendly non-intrusive confirmation toast
      if (typeof showToast === 'function') {
        showToast('Welcome to SpendWise! You can connect Telegram anytime from the top bar.', 'info');
      }
    }
  }

  // Helper for testing onboarding flow
  async function reset() {
    try {
      await API.user.resetOnboarding();
      const user = Auth.getUser();
      if (user) user.onboarding_completed = false;
      show();
    } catch (err) {
      console.error('Failed to reset onboarding:', err);
    }
  }

  return {
    init,
    check,
    show,
    dismiss,
    reset,
  };
})();

// Expose to window for global access
window.Onboarding = Onboarding;
