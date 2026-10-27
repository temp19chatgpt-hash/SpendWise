/**
 * SpendWise - Expenses Management Module
 * Handles Expense CRUD, modals, category classifications, and transaction tables.
 */

const Expenses = (() => {
  const CATEGORIES = [
    { id: 'Grocery', label: 'Grocery', badgeClass: 'badge-grocery' },
    { id: 'Outing & Eating Out', label: 'Outing & Eating Out', badgeClass: 'badge-outing' },
    { id: 'Transport', label: 'Transport', badgeClass: 'badge-transport' },
    { id: 'Travel & Accommodation', label: 'Travel & Accommodation', badgeClass: 'badge-travel' },
    { id: 'Rent & Housing', label: 'Rent & Housing', badgeClass: 'badge-housing' },
    { id: 'Utilities & Bills', label: 'Utilities & Bills', badgeClass: 'badge-bills' },
    { id: 'Medical & Healthcare', label: 'Medical & Healthcare', badgeClass: 'badge-medical' },
    { id: 'Fitness & Supplements', label: 'Fitness & Supplements', badgeClass: 'badge-fitness' },
    { id: 'Clothing & Footwear', label: 'Clothing & Footwear', badgeClass: 'badge-clothing' },
    { id: 'Shopping & Electronics', label: 'Shopping & Electronics', badgeClass: 'badge-shopping' },
    { id: 'Household Supplies & Maintenance', label: 'Household Supplies', badgeClass: 'badge-household' },
    { id: 'Personal Care', label: 'Personal Care', badgeClass: 'badge-personal' },
    { id: 'Office Expense', label: 'Office Expense', badgeClass: 'badge-office' },
    { id: 'Miscellaneous', label: 'Miscellaneous', badgeClass: 'badge-misc' },
  ];

  // Transactions table state
  let currentPage = 1;
  const pageSize = 10;
  let totalExpenses = 0;
  let searchDebounceTimer = null;

  // Currency Formatter for Indian Rupee (₹)
  function formatCurrency(amount) {
    const num = Number(amount) || 0;
    return '₹ ' + num.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  // Date Formatter preserving calendar date (No UTC shift)
  function formatDate(dateString) {
    if (!dateString) return '';
    const parts = dateString.split('-');
    if (parts.length !== 3) return dateString;

    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    const localDate = new Date(year, month, day);

    // Today / Yesterday check
    const today = new Date();
    const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const yesterdayDate = new Date(todayDate);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);

    if (localDate.getTime() === todayDate.getTime()) return 'Today';
    if (localDate.getTime() === yesterdayDate.getTime()) return 'Yesterday';

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${day} ${months[month]}, ${year}`;
  }

  // Get Category Badge metadata
  function getCategoryMeta(categoryName) {
    const match = CATEGORIES.find(c => c.id.toLowerCase() === (categoryName || '').toLowerCase());
    return match || { label: categoryName || 'Other', badgeClass: 'badge-misc' };
  }

  // Render Category Badge HTML
  function renderCategoryBadge(categoryName) {
    const meta = getCategoryMeta(categoryName);
    return `<span class="badge ${meta.badgeClass}"><span class="badge-dot"></span>${escapeHtml(meta.label)}</span>`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // Populate Category Select Dropdowns (add/edit forms use hardcoded list)
  function populateCategoryDropdowns() {
    const formSelects = [
      document.getElementById('addExpenseCategory'),
      document.getElementById('editExpenseCategory'),
    ];

    formSelects.forEach(sel => {
      if (!sel) return;
      const existingVal = sel.value;
      sel.innerHTML = '';
      CATEGORIES.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat.id;
        opt.textContent = cat.label;
        sel.appendChild(opt);
      });
      if (existingVal) sel.value = existingVal;
    });

    // Filter dropdown: load real category names from the DB so nothing is missed
    populateFilterCategoryDropdown();
  }

  // Populate the transactions filter dropdown from actual DB categories
  async function populateFilterCategoryDropdown() {
    const sel = document.getElementById('txCategoryFilter');
    if (!sel) return;
    const existingVal = sel.value;

    try {
      const data = await API.expenses.categorySummary();
      const categories = (data || []).sort((a, b) => a.category.localeCompare(b.category));
      const dbCatNames = new Set(categories.map(c => c.category));

      sel.innerHTML = '<option value="">All Categories</option>';

      // First add all actual DB categories
      categories.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat.category;
        const meta = CATEGORIES.find(c => c.id.toLowerCase() === cat.category.toLowerCase());
        opt.textContent = meta ? meta.label : cat.category;
        sel.appendChild(opt);
      });

      // Then add hardcoded categories not yet in DB (for future use)
      CATEGORIES.forEach(cat => {
        if (!dbCatNames.has(cat.id)) {
          const opt = document.createElement('option');
          opt.value = cat.id;
          opt.textContent = cat.label;
          sel.appendChild(opt);
        }
      });

      if (existingVal) sel.value = existingVal;
    } catch (err) {
      // Fallback to hardcoded list if API fails
      sel.innerHTML = '<option value="">All Categories</option>';
      CATEGORIES.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat.id;
        opt.textContent = cat.label;
        sel.appendChild(opt);
      });
      if (existingVal) sel.value = existingVal;
    }
  }

  // Set default date for Add Expense
  function resetAddForm() {
    const form = document.getElementById('addExpenseForm');
    if (!form) return;
    form.reset();

    const dateInput = document.getElementById('addExpenseDate');
    if (dateInput) {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      dateInput.value = `${yyyy}-${mm}-${dd}`;
    }
  }

  // Open Add Modal
  function openAddModal() {
    resetAddForm();
    const modal = document.getElementById('addExpenseModal');
    if (modal) {
      modal.classList.add('is-open');
      setTimeout(() => document.getElementById('addExpenseItem')?.focus(), 50);
    }
  }

  // Handle Add Submit
  async function handleAddExpense(e) {
    e.preventDefault();
    const btn = document.getElementById('btnSaveNewExpense');
    const itemInput = document.getElementById('addExpenseItem');
    const amountInput = document.getElementById('addExpenseAmount');
    const categoryInput = document.getElementById('addExpenseCategory');
    const dateInput = document.getElementById('addExpenseDate');

    const item = itemInput.value.trim();
    const amount = parseFloat(amountInput.value);
    const category = categoryInput.value;
    const expenseDate = dateInput.value;

    if (!item) {
      showToast('Please enter an item description.', 'error');
      itemInput.focus();
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      showToast('Please enter a valid positive amount.', 'error');
      amountInput.focus();
      return;
    }
    if (!category) {
      showToast('Please choose a category.', 'error');
      categoryInput.focus();
      return;
    }
    if (!expenseDate) {
      showToast('Please pick a date.', 'error');
      dateInput.focus();
      return;
    }

    if (btn) btn.classList.add('btn-loading');

    try {
      await API.expenses.create({
        item,
        amount,
        category,
        expense_date: expenseDate,
      });

      showToast(`Added "${item}" (₹${amount.toFixed(2)})`, 'success');
      closeModals();
      resetAddForm();

      // Refresh Dashboard & Transactions
      if (window.Dashboard) {
        window.Dashboard.refreshAll();
      }
    } catch (err) {
      showToast(err.message || 'Failed to save expense', 'error');
    } finally {
      if (btn) btn.classList.remove('btn-loading');
    }
  }

  // Open Edit Modal
  async function openEditModal(expenseId) {
    const modal = document.getElementById('editExpenseModal');
    if (!modal) return;

    try {
      const expense = await API.expenses.get(expenseId);
      document.getElementById('editExpenseId').value = expense.id;
      document.getElementById('editExpenseItem').value = expense.item;
      document.getElementById('editExpenseAmount').value = expense.amount;
      document.getElementById('editExpenseCategory').value = expense.category;
      document.getElementById('editExpenseDate').value = expense.expense_date;

      modal.classList.add('is-open');
      document.getElementById('editExpenseItem')?.focus();
    } catch (err) {
      showToast(err.message || 'Could not load expense details', 'error');
    }
  }

  // Handle Edit Submit
  async function handleEditExpense(e) {
    e.preventDefault();
    const btn = document.getElementById('btnUpdateExpense');
    const id = document.getElementById('editExpenseId').value;
    const item = document.getElementById('editExpenseItem').value.trim();
    const amount = parseFloat(document.getElementById('editExpenseAmount').value);
    const category = document.getElementById('editExpenseCategory').value;
    const expenseDate = document.getElementById('editExpenseDate').value;

    if (!item || isNaN(amount) || amount <= 0) {
      showToast('Please check the entered values.', 'error');
      return;
    }

    if (btn) btn.classList.add('btn-loading');

    try {
      await API.expenses.update(id, {
        item,
        amount,
        category,
        expense_date: expenseDate,
      });

      showToast('Expense updated successfully!', 'success');
      closeModals();

      if (window.Dashboard) {
        window.Dashboard.refreshAll();
      }
    } catch (err) {
      showToast(err.message || 'Failed to update expense', 'error');
    } finally {
      if (btn) btn.classList.remove('btn-loading');
    }
  }

  // Open Delete Modal
  function openDeleteModal(expenseId, itemName, expenseDate, amount) {
    const modal = document.getElementById('deleteExpenseModal');
    if (!modal) return;

    document.getElementById('deleteExpenseTargetId').value = expenseId;
    document.getElementById('deleteExpenseItemName').textContent = itemName;
    document.getElementById('deleteExpenseItemDate').textContent = formatDate(expenseDate);
    document.getElementById('deleteExpenseItemAmount').textContent = formatCurrency(amount);

    modal.classList.add('is-open');
  }

  // Handle Delete Confirmation
  async function handleConfirmDelete() {
    const btn = document.getElementById('btnConfirmDeleteExpense');
    const id = document.getElementById('deleteExpenseTargetId').value;
    if (!id) return;

    if (btn) btn.classList.add('btn-loading');

    try {
      await API.expenses.delete(id);
      showToast('Expense deleted.', 'info');
      closeModals();

      if (window.Dashboard) {
        window.Dashboard.refreshAll();
      }
    } catch (err) {
      showToast(err.message || 'Failed to delete expense', 'error');
    } finally {
      if (btn) btn.classList.remove('btn-loading');
    }
  }

  function closeModals() {
    document.querySelectorAll('.modal-backdrop').forEach(modal => {
      modal.classList.remove('is-open');
    });
  }

  // Load Transactions Page Table
  async function loadTransactions() {
    const tbody = document.getElementById('fullTransactionsTableBody');
    if (!tbody) return;

    const search = document.getElementById('txSearchInput')?.value.trim();
    const category = document.getElementById('txCategoryFilter')?.value;
    const startDate = document.getElementById('txStartDateFilter')?.value;
    const endDate = document.getElementById('txEndDateFilter')?.value;
    const sortVal = document.getElementById('txSortFilter')?.value || 'expense_date:desc';
    const [sortBy, order] = sortVal.split(':');

    const offset = (currentPage - 1) * pageSize;

    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 2.5rem;">
          <div class="spinner" style="margin: 0 auto 0.75rem;"></div>
          <div class="text-muted" style="font-size: 0.875rem;">Loading transactions...</div>
        </td>
      </tr>
    `;

    try {
      const res = await API.expenses.list({
        search,
        category,
        start_date: startDate,
        end_date: endDate,
        sort_by: sortBy,
        order,
        limit: pageSize,
        offset,
      });

      totalExpenses = res.total || 0;
      updatePaginationControls();

      if (!res.expenses || res.expenses.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5">
              <div class="empty-state">
                <div class="empty-state-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                  </svg>
                </div>
                <div class="empty-state-title">No transactions found</div>
                <div class="empty-state-desc">Try adjusting your filters or search terms, or add a new expense.</div>
                <button class="btn btn-outline btn-sm" onclick="Expenses.openAddModal()">Add Expense</button>
              </div>
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = res.expenses.map(exp => `
        <tr>
          <td style="color: var(--text-secondary); font-size: 0.875rem; white-space: nowrap;">
            ${formatDate(exp.expense_date)}
          </td>
          <td>
            <div style="font-weight: 600; color: var(--text-primary);">${escapeHtml(exp.item)}</div>
          </td>
          <td>${renderCategoryBadge(exp.category)}</td>
          <td class="text-right">
            <span class="amount-serif" style="font-size: 1.0625rem; font-weight: 600;">
              ${formatCurrency(exp.amount)}
            </span>
          </td>
          <td class="text-right">
            <div class="table-actions">
              <button class="btn btn-ghost btn-icon btn-sm" onclick="Expenses.openEditModal(${exp.id})" title="Edit Expense">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
              </button>
              <button class="btn btn-ghost btn-icon btn-sm text-danger" onclick="Expenses.openDeleteModal(${exp.id}, '${escapeHtml(exp.item).replace(/'/g, "\\'")}', '${exp.expense_date}', ${exp.amount})" title="Delete Expense">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
              </button>
            </div>
          </td>
        </tr>
      `).join('');

    } catch (err) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--danger); padding: 2rem;">
            Failed to load transactions: ${escapeHtml(err.message)}
          </td>
        </tr>
      `;
    }
  }

  function updatePaginationControls() {
    const infoEl = document.getElementById('paginationInfo');
    const prevBtn = document.getElementById('btnPrevPage');
    const nextBtn = document.getElementById('btnNextPage');

    const start = totalExpenses === 0 ? 0 : (currentPage - 1) * pageSize + 1;
    const end = Math.min(currentPage * pageSize, totalExpenses);

    if (infoEl) {
      infoEl.textContent = `Showing ${start} - ${end} of ${totalExpenses} expenses`;
    }
    if (prevBtn) {
      prevBtn.disabled = currentPage <= 1;
    }
    if (nextBtn) {
      nextBtn.disabled = end >= totalExpenses;
    }
  }

  function init() {
    populateCategoryDropdowns();

    // Add Expense modal triggers
    document.getElementById('btnOpenAddExpense')?.addEventListener('click', openAddModal);
    document.getElementById('addExpenseForm')?.addEventListener('submit', handleAddExpense);
    document.getElementById('editExpenseForm')?.addEventListener('submit', handleEditExpense);
    document.getElementById('btnConfirmDeleteExpense')?.addEventListener('click', handleConfirmDelete);

    // Close modal triggers
    document.querySelectorAll('.js-close-modal').forEach(btn => {
      btn.addEventListener('click', closeModals);
    });

    document.querySelectorAll('.modal-backdrop').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModals();
      });
    });

    // Transactions filters
    document.getElementById('txSearchInput')?.addEventListener('input', () => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        currentPage = 1;
        loadTransactions();
      }, 300);
    });

    document.getElementById('txCategoryFilter')?.addEventListener('change', () => {
      currentPage = 1;
      loadTransactions();
    });

    document.getElementById('txStartDateFilter')?.addEventListener('change', () => {
      currentPage = 1;
      loadTransactions();
    });

    document.getElementById('txEndDateFilter')?.addEventListener('change', () => {
      currentPage = 1;
      loadTransactions();
    });

    document.getElementById('txSortFilter')?.addEventListener('change', () => {
      currentPage = 1;
      loadTransactions();
    });

    document.getElementById('btnResetFilters')?.addEventListener('click', () => {
      const search = document.getElementById('txSearchInput');
      const cat = document.getElementById('txCategoryFilter');
      const start = document.getElementById('txStartDateFilter');
      const end = document.getElementById('txEndDateFilter');
      const sort = document.getElementById('txSortFilter');

      if (search) search.value = '';
      if (cat) cat.value = '';
      if (start) start.value = '';
      if (end) end.value = '';
      if (sort) sort.value = 'expense_date:desc';

      currentPage = 1;
      loadTransactions();
    });

    // Pagination buttons
    document.getElementById('btnPrevPage')?.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage--;
        loadTransactions();
      }
    });

    document.getElementById('btnNextPage')?.addEventListener('click', () => {
      if (currentPage * pageSize < totalExpenses) {
        currentPage++;
        loadTransactions();
      }
    });
  }

  function filterByCategory(categoryName) {
    const catSelect = document.getElementById('txCategoryFilter');
    if (catSelect) {
      catSelect.value = categoryName || '';
    }
    currentPage = 1;
    loadTransactions();
  }

  return {
    init,
    CATEGORIES,
    formatCurrency,
    formatDate,
    renderCategoryBadge,
    openAddModal,
    openEditModal,
    openDeleteModal,
    loadTransactions,
    filterByCategory,
  };
})();
