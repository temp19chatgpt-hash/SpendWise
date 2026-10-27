/**
 * SpendWise - Auth & Session Helper
 */

const Auth = (() => {
  let currentUser = null;

  async function init() {
    try {
      const user = await API.auth.me();
      currentUser = user;
      updateUserUI(user);
      return user;
    } catch (err) {
      // If we are on an authenticated view and me() fails, API client redirects to /login
      console.warn('Auth check failed:', err.message);
      return null;
    }
  }

  function updateUserUI(user) {
    if (!user) return;

    const nameElements = document.querySelectorAll('.js-user-name');
    nameElements.forEach(el => { el.textContent = user.name || user.email.split('@')[0]; });

    const emailElements = document.querySelectorAll('.js-user-email');
    emailElements.forEach(el => { el.textContent = user.email || ''; });

    const avatarElements = document.querySelectorAll('.js-user-avatar');
    avatarElements.forEach(el => {
      const initial = (user.name || user.email || 'S')[0].toUpperCase();
      el.textContent = initial;
    });
  }

  async function handleLogout(e) {
    if (e) e.preventDefault();
    try {
      await API.auth.logout();
      window.location.href = '/login';
    } catch (err) {
      window.location.href = '/login';
    }
  }

  return {
    init,
    getUser: () => currentUser,
    logout: handleLogout,
  };
})();
