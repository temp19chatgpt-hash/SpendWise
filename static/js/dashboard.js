/**
 * SpendWise - Dashboard Orchestration & Visualizations
 * Timeline Chart, Category Distribution, Metrics, and Tab Navigation
 */

const Dashboard = (() => {
  let activeYear = new Date().getFullYear();
  let activeMonth = new Date().getMonth() + 1; // 1-12
  let currentTab = 'overview';
  let chartMode = 'amount'; // 'amount' | 'count'

  // Initialize Year and Month dropdowns
  function initPeriodSelectors() {
    const yearSelect = document.getElementById('yearSelect');
    const monthSelect = document.getElementById('monthSelect');
    if (!yearSelect || !monthSelect) return;

    const currentYear = new Date().getFullYear();
    yearSelect.innerHTML = '';
    for (let y = currentYear - 2; y <= currentYear + 1; y++) {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      if (y === activeYear) opt.selected = true;
      yearSelect.appendChild(opt);
    }

    monthSelect.value = activeMonth;

    yearSelect.addEventListener('change', () => {
      activeYear = parseInt(yearSelect.value, 10);
      refreshOverview();
      if (currentTab === 'budget' && typeof Budget !== 'undefined') {
        Budget.loadBudgetSummary(activeYear, activeMonth);
      }
    });

    monthSelect.addEventListener('change', () => {
      activeMonth = parseInt(monthSelect.value, 10);
      refreshOverview();
      if (currentTab === 'budget' && typeof Budget !== 'undefined') {
        Budget.loadBudgetSummary(activeYear, activeMonth);
      }
    });
  }

  // Load Monthly Summary & Overview Metrics
  async function loadMetrics() {
    const totalAmountEl = document.getElementById('statTotalAmount');
    const totalCountEl = document.getElementById('statTotalCount');
    const averageAmountEl = document.getElementById('statAverageAmount');
    const periodSubtextEl = document.getElementById('statPeriodSubtext');

    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    if (periodSubtextEl) {
      periodSubtextEl.textContent = `${months[activeMonth - 1]} ${activeYear}`;
    }

    try {
      const summary = await API.expenses.monthlySummary(activeYear, activeMonth);
      const count = summary.total_expenses || 0;
      const total = summary.total_amount || 0;
      const avg = count > 0 ? (total / count) : 0;

      if (totalAmountEl) totalAmountEl.textContent = Expenses.formatCurrency(total);
      if (totalCountEl) totalCountEl.textContent = count.toLocaleString('en-IN');
      if (averageAmountEl) averageAmountEl.textContent = Expenses.formatCurrency(avg);

    } catch (err) {
      console.warn('Failed to load monthly summary:', err);
      if (totalAmountEl) totalAmountEl.textContent = '₹ 0.00';
      if (totalCountEl) totalCountEl.textContent = '0';
      if (averageAmountEl) averageAmountEl.textContent = '₹ 0.00';
    }
  }

  // Curated item color palette (distinct, readable on white)
  const ITEM_COLORS = [
    '#059669', // Emerald
    '#2563EB', // Royal Blue
    '#D97706', // Amber Orange
    '#7C3AED', // Violet Purple
    '#DC2626', // Crimson Red
    '#0891B2', // Cyan Teal
    '#DB2777', // Pink Rose
    '#4F46E5', // Indigo
    '#EA580C', // Deep Orange
    '#16A34A', // Green
    '#9333EA', // Purple
    '#0D9488', // Dark Teal
    '#B45309', // Warm Amber
    '#4338CA', // Dark Indigo
  ];
  let itemColorMap = {}; // item -> color
  let allMonthExpenses = []; // cached for item mode
  let selectedItem = '';

  function getItemColor(itemName) {
    if (!itemName) return ITEM_COLORS[0];
    const key = itemName.trim().toLowerCase();
    if (!itemColorMap[key]) {
      let hash = 0;
      for (let i = 0; i < key.length; i++) {
        hash = (hash << 5) - hash + key.charCodeAt(i);
        hash |= 0;
      }
      const colorIndex = Math.abs(hash) % ITEM_COLORS.length;
      itemColorMap[key] = ITEM_COLORS[colorIndex];
    }
    return itemColorMap[key];
  }

  // Load SpendWise Original 1: Daily Spending Timeline Chart
  async function loadTimeline() {
    const container = document.getElementById('timelineChartContainer');
    const subtitle = document.getElementById('timelineSubtitle');
    if (!container) return;

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (subtitle) {
      if (chartMode === 'count') {
        subtitle.textContent = `Daily transaction count for ${months[activeMonth - 1]} ${activeYear}`;
      } else if (chartMode === 'item' && selectedItem) {
        subtitle.textContent = `Daily trend for "${selectedItem}" in ${months[activeMonth - 1]} ${activeYear}`;
      } else {
        subtitle.textContent = `Daily spending distribution for ${months[activeMonth - 1]} ${activeYear}`;
      }
    }

    const daysInMonth = new Date(activeYear, activeMonth, 0).getDate();
    const mm = String(activeMonth).padStart(2, '0');
    const startDate = `${activeYear}-${mm}-01`;
    const endDate = `${activeYear}-${mm}-${String(daysInMonth).padStart(2, '0')}`;

    try {
      const res = await API.expenses.list({
        start_date: startDate,
        end_date: endDate,
        limit: 500,
        sort_by: 'expense_date',
        order: 'asc',
      });

      allMonthExpenses = res.expenses || [];

      const dailyTotals = new Array(daysInMonth + 1).fill(0);
      const dailyCounts = new Array(daysInMonth + 1).fill(0);

      allMonthExpenses.forEach(exp => {
        const parts = (exp.expense_date || '').split('-');
        if (parts.length === 3) {
          const d = parseInt(parts[2], 10);
          if (d >= 1 && d <= daysInMonth) {
            dailyTotals[d] += parseFloat(exp.amount) || 0;
            dailyCounts[d] += 1;
          }
        }
      });

      // Populate item picker with unique items from this month
      populateItemPicker(allMonthExpenses);

      if (chartMode === 'item') {
        renderItemTimelineSVG(container, daysInMonth);
      } else {
        renderTimelineSVG(container, dailyTotals, dailyCounts, daysInMonth);
      }

    } catch (err) {
      container.innerHTML = `
        <div style="height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 0.875rem;">
          Could not load timeline data.
        </div>
      `;
    }
  }

  // Populate item picker dropdown with unique item names from this month
  function populateItemPicker(expenses) {
    const sel = document.getElementById('itemPickerSelect');
    if (!sel) return;

    // Count items and sums
    const itemCounts = {};
    const itemSums = {};
    expenses.forEach(e => {
      const k = (e.item || '').trim();
      if (k) {
        itemCounts[k] = (itemCounts[k] || 0) + 1;
        itemSums[k] = (itemSums[k] || 0) + (parseFloat(e.amount) || 0);
      }
    });

    const sorted = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]);

    if (sorted.length === 0) {
      sel.innerHTML = '<option value="">No items recorded</option>';
      selectedItem = '';
      return;
    }

    // Determine current selected item
    const hasCurrent = selectedItem && sorted.some(([n]) => n.toLowerCase() === selectedItem.toLowerCase());
    if (!hasCurrent) {
      selectedItem = sorted[0][0];
    }

    sel.innerHTML = '';
    sorted.forEach(([name, cnt]) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = `${name} (${cnt}x · ₹${Math.round(itemSums[name])})`;
      if (name.toLowerCase() === selectedItem.toLowerCase()) {
        opt.selected = true;
      }
      sel.appendChild(opt);
    });

    sel.value = selectedItem;
  }

  // Render Item-level daily timeline
  function renderItemTimelineSVG(container, daysInMonth) {
    const sel = document.getElementById('itemPickerSelect');
    if (!selectedItem && sel && sel.value) {
      selectedItem = sel.value;
    }

    if (!selectedItem && allMonthExpenses.length > 0) {
      const firstExp = allMonthExpenses.find(e => (e.item || '').trim());
      if (firstExp) {
        selectedItem = firstExp.item.trim();
        if (sel) sel.value = selectedItem;
      }
    }

    if (!selectedItem) {
      container.innerHTML = `<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:0.875rem;">No items recorded for this month.</div>`;
      return;
    }

    const color = getItemColor(selectedItem);
    const dailyAmts = new Array(daysInMonth + 1).fill(0);
    const dailyCnts = new Array(daysInMonth + 1).fill(0);
    let itemTotal = 0;
    let itemTxns = 0;

    allMonthExpenses.forEach(exp => {
      if ((exp.item || '').trim().toLowerCase() === selectedItem.toLowerCase()) {
        const parts = (exp.expense_date || '').split('-');
        if (parts.length === 3) {
          const d = parseInt(parts[2], 10);
          if (d >= 1 && d <= daysInMonth) {
            const amt = parseFloat(exp.amount) || 0;
            dailyAmts[d] += amt;
            dailyCnts[d] += 1;
            itemTotal += amt;
            itemTxns += 1;
          }
        }
      }
    });

    // Update legend
    const legendDot = document.getElementById('chartLegendDot');
    const legendText = document.getElementById('chartLegendText');
    if (legendDot) legendDot.style.background = color;
    if (legendText) legendText.textContent = `${selectedItem} (${itemTxns} txn${itemTxns === 1 ? '' : 's'} · ${Expenses.formatCurrency(itemTotal)})`;

    // Update subtitle
    const subtitle = document.getElementById('timelineSubtitle');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (subtitle) {
      subtitle.textContent = `Daily spend trend for "${selectedItem}" in ${months[activeMonth - 1]} ${activeYear}`;
    }

    renderTimelineSVGWithColor(container, dailyAmts, dailyCnts, daysInMonth, color, selectedItem);
  }

  // Render SVG Timeline Bar Chart — realistic with gradients, Y-axis, grid
  function renderTimelineSVG(container, dailyTotals, dailyCounts, daysInMonth) {
    const isCountMode = (chartMode === 'count');
    const metricValues = isCountMode ? dailyCounts : dailyTotals;
    const color = isCountMode ? '#2563EB' : 'var(--brand-primary)';
    const colorHex = isCountMode ? '#2563EB' : '#1B6B45';
    renderTimelineSVGWithColor(container, metricValues, dailyCounts, daysInMonth, colorHex, isCountMode ? 'Txn Count' : 'Daily Total', dailyTotals);
  }

  function renderTimelineSVGWithColor(container, metricValues, dailyCounts, daysInMonth, color, label, dailyTotalsOverride) {
    const isCountMode = (chartMode === 'count');
    const maxVal = Math.max(...metricValues.slice(1), 1);
    const hasData = metricValues.slice(1).some(v => v > 0);

    if (!hasData) {
      container.innerHTML = `
        <div class="empty-state" style="padding: 2.5rem 1rem;">
          <div class="empty-state-icon" style="width: 44px; height: 44px; margin-bottom: 0.75rem;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="20" x2="18" y2="10"></line>
              <line x1="12" y1="20" x2="12" y2="4"></line>
              <line x1="6" y1="20" x2="6" y2="14"></line>
            </svg>
          </div>
          <div style="font-size: 0.9375rem; font-weight: 600; color: var(--text-primary); margin-bottom: 0.25rem;">
            ${chartMode === 'item' ? `No data for "${selectedItem}" this month` : 'No expenses recorded this month'}
          </div>
          <div style="font-size: 0.8125rem; color: var(--text-muted); margin-bottom: 1rem;">
            Send a message to your Telegram bot or click "Add Expense".
          </div>
          <button class="btn btn-outline btn-sm" onclick="Expenses.openAddModal()">Add Expense</button>
        </div>
      `;
      return;
    }

    const width = 640;
    const height = 220;
    const paddingLeft = 52;  // wider for Y-axis labels
    const paddingRight = 16;
    const paddingTop = 24;
    const paddingBottom = 32;

    const chartWidth = width - paddingLeft - paddingRight;
    const chartHeight = height - paddingTop - paddingBottom;
    const colWidth = chartWidth / daysInMonth;
    const barWidth = Math.max(colWidth * 0.62, 4);
    const baselineY = paddingTop + chartHeight;
    const gradId = `barGrad_${color.replace(/[^a-z0-9]/gi, '')}`;

    // Y-axis grid lines & labels (4 levels)
    let gridSvg = '';
    const gridLevels = 4;
    for (let i = 0; i <= gridLevels; i++) {
      const yVal = (maxVal / gridLevels) * i;
      const yPos = baselineY - (yVal / maxVal) * chartHeight;
      const label_y = isCountMode
        ? Math.round(yVal).toString()
        : (yVal >= 1000 ? `${(yVal / 1000).toFixed(1)}k` : Math.round(yVal).toString());
      gridSvg += `
        <line x1="${paddingLeft}" y1="${yPos.toFixed(1)}" x2="${width - paddingRight}" y2="${yPos.toFixed(1)}"
              stroke="#E5E7EB" stroke-width="1" stroke-dasharray="${i === 0 ? 'none' : '3,3'}" />
        <text class="timeline-axis-label" x="${paddingLeft - 6}" y="${(yPos + 4).toFixed(1)}" text-anchor="end">${label_y}</text>
      `;
    }

    let barsSvg = '';
    let labelsSvg = '';
    let peakDay = -1;
    let peakVal = 0;

    for (let day = 1; day <= daysInMonth; day++) {
      if (metricValues[day] > peakVal) { peakVal = metricValues[day]; peakDay = day; }
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const val = metricValues[day];
      const amt = dailyTotalsOverride ? dailyTotalsOverride[day] : metricValues[day];
      const cnt = dailyCounts[day];

      const barHeight = val > 0 ? Math.max((val / maxVal) * chartHeight, 6) : 2;
      const x = paddingLeft + (day - 1) * colWidth + (colWidth - barWidth) / 2;
      const y = baselineY - barHeight;
      const isPeak = day === peakDay && val > 0;
      const rx = Math.min(barWidth / 2, 4);
      const barFill = val > 0 ? (isPeak ? color : `url(#${gradId})`) : '#E5E7EB';

      barsSvg += `
        <rect
          class="timeline-bar${isPeak ? ' is-peak' : ''}"
          fill="${barFill}"
          style="fill: ${barFill} !important;"
          x="${x.toFixed(1)}"
          y="${y.toFixed(1)}"
          width="${barWidth.toFixed(1)}"
          height="${barHeight.toFixed(1)}"
          rx="${rx}"
          data-day="${day}"
          data-amount="${amt.toFixed(2)}"
          data-count="${cnt}"
          data-label="${label}"
        />
      `;

      if (day === 1 || day % 5 === 0 || day === daysInMonth) {
        labelsSvg += `
          <text class="timeline-axis-label" x="${(x + barWidth / 2).toFixed(1)}" y="${height - 8}">${day}</text>
        `;
      }
    }

    container.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" style="width: 100%; height: 100%; overflow: visible;" id="timelineChartSvg">
        <defs>
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.9"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0.45"/>
          </linearGradient>
        </defs>
        ${gridSvg}
        ${barsSvg}
        ${labelsSvg}
      </svg>
      <div id="chartTooltip" class="chart-tooltip"></div>
    `;

    // Hover tooltips
    const svgEl = document.getElementById('timelineChartSvg');
    const tooltip = document.getElementById('chartTooltip');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    svgEl.querySelectorAll('.timeline-bar').forEach(bar => {
      bar.addEventListener('mouseenter', () => {
        const day = bar.getAttribute('data-day');
        const amount = parseFloat(bar.getAttribute('data-amount')) || 0;
        const count = parseInt(bar.getAttribute('data-count'), 10) || 0;
        const barLabel = bar.getAttribute('data-label') || '';

        if (chartMode === 'item') {
          tooltip.innerHTML = `
            <div><strong>${day} ${months[activeMonth - 1]}:</strong> ${Expenses.formatCurrency(amount)}</div>
            <div style="font-size:0.72rem;color:#9CA3AF;margin-top:2px;">${count} purchase${count === 1 ? '' : 's'} of ${barLabel}</div>
          `;
        } else if (chartMode === 'count') {
          tooltip.innerHTML = `
            <div><strong>${day} ${months[activeMonth - 1]}:</strong> ${count} txn${count === 1 ? '' : 's'}</div>
            <div style="font-size:0.72rem;color:#9CA3AF;margin-top:2px;">${Expenses.formatCurrency(amount)} total</div>
          `;
        } else {
          tooltip.innerHTML = `
            <div><strong>${day} ${months[activeMonth - 1]}:</strong> ${Expenses.formatCurrency(amount)}</div>
            <div style="font-size:0.72rem;color:#9CA3AF;margin-top:2px;">${count} transaction${count === 1 ? '' : 's'}</div>
          `;
        }
        tooltip.style.opacity = '1';

        const rect = bar.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const left = rect.left - containerRect.left + rect.width / 2;
        const top = rect.top - containerRect.top;
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
      });
      bar.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; });
    });
  }

  // Load SpendWise Original 2: Interactive Category Breakdown
  async function loadCategoryBreakdown() {
    const container = document.getElementById('categoryBreakdownContainer');
    const badge = document.getElementById('categoryTotalBadge');
    if (!container) return;

    try {
      const data = await API.expenses.categorySummary();
      const categories = (data || []).sort((a, b) => b.total_amount - a.total_amount);
      const grandTotal = categories.reduce((sum, c) => sum + (c.total_amount || 0), 0);

      if (badge) {
        badge.textContent = `${categories.length} categories`;
      }

      if (categories.length === 0) {
        container.innerHTML = `
          <div class="empty-state" style="padding: 2.5rem 1rem;">
            <div style="font-size: 0.875rem; color: var(--text-muted);">No categorized spending recorded yet.</div>
          </div>
        `;
        return;
      }

      container.innerHTML = `
        <div class="category-bars-list">
          ${categories.map(cat => {
            const pct = grandTotal > 0 ? ((cat.total_amount / grandTotal) * 100).toFixed(1) : 0;
            return `
              <div class="category-bar-row" role="button" tabindex="0" data-category="${escapeHtml(cat.category)}" data-amount="${cat.total_amount}" data-count="${cat.total_expenses}" data-pct="${pct}" title="Click to view all ${escapeHtml(cat.category)} transactions">
                <div class="category-row-meta">
                  <div class="category-name-badge">
                    ${Expenses.renderCategoryBadge(cat.category)}
                    <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal;">${cat.total_expenses} item${cat.total_expenses === 1 ? '' : 's'}</span>
                  </div>
                  <div style="text-align: right;">
                    <span class="category-amount-val amount-serif">${Expenses.formatCurrency(cat.total_amount)}</span>
                    <span style="font-size: 0.75rem; color: var(--text-muted); margin-left: 0.35rem;">(${pct}%)</span>
                  </div>
                </div>
                <div class="category-track">
                  <div class="category-fill" style="width: ${pct}%;"></div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
        <div class="category-floating-tooltip" id="categoryFloatingTooltip"></div>
      `;

      // Attach Category Click & Hover Interactions
      const tooltip = document.getElementById('categoryFloatingTooltip');
      container.querySelectorAll('.category-bar-row').forEach(row => {
        const catName = row.getAttribute('data-category');
        const amt = parseFloat(row.getAttribute('data-amount')) || 0;
        const cnt = parseInt(row.getAttribute('data-count'), 10) || 0;
        const pct = row.getAttribute('data-pct');

        // Click row -> Filter transactions tab
        const navigateToFiltered = () => {
          Expenses.filterByCategory(catName);
          switchTab('transactions');
          window.location.hash = 'transactions';
          showToast(`Filtered transactions by "${catName}"`, 'info', 2500);
        };

        row.addEventListener('click', navigateToFiltered);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            navigateToFiltered();
          }
        });

        // Hover tooltip display
        row.addEventListener('mouseenter', (e) => {
          if (!tooltip) return;
          tooltip.innerHTML = `
            <div class="cat-tip-title">
              <span>${escapeHtml(catName)}</span>
              <span style="color: #34D399; font-weight: 700;">${pct}%</span>
            </div>
            <div class="cat-tip-detail">
              <span>Total Spent:</span>
              <strong style="color: #FFFFFF;">${Expenses.formatCurrency(amt)}</strong>
            </div>
            <div class="cat-tip-detail">
              <span>Recorded:</span>
              <span>${cnt} expense${cnt === 1 ? '' : 's'}</span>
            </div>
            <div class="cat-tip-hint">Click to filter transactions &rarr;</div>
          `;
          tooltip.classList.add('is-visible');
          positionCategoryTooltip(e, row, container, tooltip);
        });

        row.addEventListener('mousemove', (e) => {
          if (!tooltip) return;
          positionCategoryTooltip(e, row, container, tooltip);
        });

        row.addEventListener('mouseleave', () => {
          if (!tooltip) return;
          tooltip.classList.remove('is-visible');
        });
      });

    } catch (err) {
      container.innerHTML = `
        <div style="color: var(--text-muted); font-size: 0.875rem; text-align: center; padding: 2rem;">
          Could not load category breakdown.
        </div>
      `;
    }
  }

  // Position Category Floating Tooltip accurately
  function positionCategoryTooltip(e, row, container, tooltip) {
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    
    let top = (rowRect.top - containerRect.top) - 10;
    let left = e.clientX - containerRect.left + 15;

    if (left + 210 > containerRect.width) {
      left = containerRect.width - 220;
    }
    if (left < 8) left = 8;
    if (top < 0) top = (rowRect.bottom - containerRect.top) + 8;

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  // Load Recent Transactions for Overview
  async function loadRecentTransactions() {
    const tbody = document.getElementById('recentTransactionsTableBody');
    if (!tbody) return;

    try {
      const res = await API.expenses.list({
        limit: 5,
        sort_by: 'expense_date',
        order: 'desc',
      });

      const list = res.expenses || [];
      if (list.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5" style="text-align: center; padding: 2rem; color: var(--text-muted); font-size: 0.875rem;">
              No transactions recorded yet. Click <strong>Add Expense</strong> or message your Telegram bot.
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = list.map(exp => `
        <tr>
          <td style="color: var(--text-secondary); font-size: 0.875rem; white-space: nowrap;">
            ${Expenses.formatDate(exp.expense_date)}
          </td>
          <td>
            <div style="font-weight: 600; color: var(--text-primary);">${escapeHtml(exp.item)}</div>
          </td>
          <td>${Expenses.renderCategoryBadge(exp.category)}</td>
          <td class="text-right">
            <span class="amount-serif" style="font-size: 1.0625rem; font-weight: 600;">
              ${Expenses.formatCurrency(exp.amount)}
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
          <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">
            Unable to load recent transactions.
          </td>
        </tr>
      `;
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // Load Spending Insights (Most Frequent, Top Category, Daily Average)
  async function loadInsights() {
    const freqVal = document.getElementById('statFrequentItem');
    const freqSub = document.getElementById('statFrequentItemSub');
    const spendVal = document.getElementById('statHighestSpend');
    const spendSub = document.getElementById('statHighestSpendSub');
    const largeVal = document.getElementById('statLargestTxn');
    const largeSub = document.getElementById('statLargestTxnSub');

    if (!freqVal && !spendVal && !largeVal) return;

    try {
      // Primary: call our dedicated backend insights endpoint
      const data = await API.expenses.insights(activeYear, activeMonth);

      if (data && data.has_data) {
        // Insight 1: Most frequent item
        if (freqVal) {
          if (data.most_frequent_item) {
            const item = data.most_frequent_item;
            freqVal.textContent = item.item;
            if (freqSub) {
              const countStr = `${item.count} purchase${item.count === 1 ? '' : 's'}`;
              const amtStr = Expenses.formatCurrency(item.total_amount);
              freqSub.textContent = `${countStr} · ${amtStr}${data.is_all_time ? ' (all-time)' : ''}`;
            }
          } else {
            freqVal.textContent = '—';
            if (freqSub) freqSub.textContent = 'No expenses recorded';
          }
        }

        // Insight 2: Top Category (highest cumulative spend in a category)
        if (spendVal) {
          if (data.top_category) {
            const cat = data.top_category;
            spendVal.textContent = cat.category;
            if (spendSub) {
              const amtStr = Expenses.formatCurrency(cat.total_amount);
              const txnStr = `${cat.count} txn${cat.count === 1 ? '' : 's'}`;
              spendSub.textContent = `${amtStr} · ${txnStr}${data.is_all_time ? ' (all-time)' : ''}`;
            }
          } else {
            spendVal.textContent = '—';
            if (spendSub) spendSub.textContent = 'No expenses recorded';
          }
        }

        // Insight 3: Daily Average — avg spend per day
        if (largeVal) {
          if (data.daily_average && data.daily_average.amount !== undefined) {
            const avg = data.daily_average;
            largeVal.textContent = Expenses.formatCurrency(avg.amount);
            if (largeSub) {
              const daysStr = `${avg.days} day${avg.days === 1 ? '' : 's'}`;
              const txnStr = `${avg.total_transactions} txn${avg.total_transactions === 1 ? '' : 's'}`;
              largeSub.textContent = `Avg per day (${daysStr}) · ${txnStr}${data.is_all_time ? ' (all-time)' : ''}`;
            }
          } else {
            largeVal.textContent = '—';
            if (largeSub) largeSub.textContent = 'No expenses recorded';
          }
        }
        return;
      }
    } catch (err) {
      console.warn('API.expenses.insights request failed, using client fallback:', err);
    }

    // Fallback: client-side computation from recent expense records
    try {
      const res = await API.expenses.list({ limit: 200, sort_by: 'expense_date', order: 'desc' });
      const list = res.expenses || [];
      if (list.length === 0) {
        if (freqVal) freqVal.textContent = '—';
        if (freqSub) freqSub.textContent = 'No expenses recorded yet';
        if (spendVal) spendVal.textContent = '—';
        if (spendSub) spendSub.textContent = 'No expenses recorded yet';
        if (largeVal) largeVal.textContent = '—';
        if (largeSub) largeSub.textContent = 'No expenses recorded yet';
        return;
      }

      // Most frequent item
      const counts = {};
      const sums = {};
      const catTotals = {};
      const catCounts = {};
      list.forEach(e => {
        const k = (e.item || '').trim();
        const cat = e.category || 'Other';
        if (k) {
          counts[k] = (counts[k] || 0) + 1;
          sums[k] = (sums[k] || 0) + (parseFloat(e.amount) || 0);
        }
        catTotals[cat] = (catTotals[cat] || 0) + (parseFloat(e.amount) || 0);
        catCounts[cat] = (catCounts[cat] || 0) + 1;
      });
      const topFreq = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (freqVal && topFreq) {
        freqVal.textContent = topFreq[0];
        if (freqSub) freqSub.textContent = `${topFreq[1]} purchases · ${Expenses.formatCurrency(sums[topFreq[0]] || 0)}`;
      }

      // Top category
      const topCat = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0];
      if (spendVal && topCat) {
        spendVal.textContent = topCat[0];
        if (spendSub) spendSub.textContent = `${Expenses.formatCurrency(topCat[1])} · ${catCounts[topCat[0]] || 1} txns`;
      }

      // Daily average (fallback: total / days elapsed)
      if (largeVal && list.length > 0) {
        const totalAmt = list.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
        const now = new Date();
        const isCurrentMonth = (activeYear === now.getFullYear() && activeMonth === (now.getMonth() + 1));
        const daysElapsed = isCurrentMonth ? now.getDate() : new Date(activeYear, activeMonth, 0).getDate();
        const dailyAvg = daysElapsed > 0 ? totalAmt / daysElapsed : 0;
        largeVal.textContent = Expenses.formatCurrency(dailyAvg);
        if (largeSub) largeSub.textContent = `Over ${daysElapsed} day${daysElapsed === 1 ? '' : 's'} · ${list.length} txns`;
      }
    } catch (fallbackErr) {
      console.warn('Fallback insights calculation failed:', fallbackErr);
    }
  }

  // Refresh Overview View
  function refreshOverview() {
    loadMetrics();
    loadTimeline();
    loadCategoryBreakdown();
    loadRecentTransactions();
    loadInsights();
    loadBudgetCompactCard();
  }

  // Load Budget Compact Card on Overview tab
  async function loadBudgetCompactCard() {
    if (typeof Budget !== 'undefined' && Budget.renderDashboardCompactCard) {
      try {
        const summary = await API.budgets.summary(activeYear, activeMonth);
        Budget.renderDashboardCompactCard(summary);
      } catch (err) {
        console.warn('Could not load budget compact card:', err);
      }
    }
  }

  // Refresh All Data
  function refreshAll() {
    refreshOverview();
    if (currentTab === 'transactions') {
      Expenses.loadTransactions();
    } else if (currentTab === 'budget') {
      if (typeof Budget !== 'undefined' && Budget.loadBudgetSummary) {
        Budget.loadBudgetSummary(activeYear, activeMonth);
      }
    }
  }

  // Tab Navigation Handling
  function switchTab(tabName) {
    currentTab = tabName;
    const overviewSection = document.getElementById('overviewSection');
    const transactionsSection = document.getElementById('transactionsSection');
    const budgetSection = document.getElementById('budgetSection');
    const pageTitle = document.getElementById('currentViewTitle');
    const periodPicker = document.getElementById('periodPickerWrap');

    document.querySelectorAll('.sidebar-nav .nav-link, .mobile-bottom-nav .bottom-nav-item').forEach(link => {
      link.classList.toggle('active', link.getAttribute('data-tab') === tabName);
    });

    if (tabName === 'transactions') {
      if (overviewSection) overviewSection.style.display = 'none';
      if (budgetSection) budgetSection.style.display = 'none';
      if (transactionsSection) transactionsSection.style.display = 'block';
      if (pageTitle) pageTitle.textContent = 'All Transactions';
      if (periodPicker) periodPicker.style.display = 'none';
      Expenses.loadTransactions();
    } else if (tabName === 'budget') {
      if (overviewSection) overviewSection.style.display = 'none';
      if (transactionsSection) transactionsSection.style.display = 'none';
      if (budgetSection) budgetSection.style.display = 'block';
      if (pageTitle) pageTitle.textContent = 'Budget & Savings';
      if (periodPicker) periodPicker.style.display = 'flex';
      if (typeof Budget !== 'undefined' && Budget.loadBudgetSummary) {
        Budget.loadBudgetSummary(activeYear, activeMonth);
      }
    } else {
      if (budgetSection) budgetSection.style.display = 'none';
      if (transactionsSection) transactionsSection.style.display = 'none';
      if (overviewSection) overviewSection.style.display = 'block';
      if (pageTitle) pageTitle.textContent = 'Spending Overview';
      if (periodPicker) periodPicker.style.display = 'flex';
      refreshOverview();
    }

    // Close mobile drawer if open
    document.getElementById('appSidebar')?.classList.remove('is-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('is-visible');
  }

  // Navigate using History API — updates URL without reload
  function navigate(tabName) {
    const pathMap = { overview: '/overview', transactions: '/transactions', budget: '/budget' };
    const path = pathMap[tabName] || '/overview';
    if (window.location.pathname !== path) {
      history.pushState({ tab: tabName }, '', path);
    }
    switchTab(tabName);
  }

  // Set Chart Mode ('amount' | 'count' | 'item')
  function setChartMode(mode) {
    chartMode = mode;
    const btnAmount = document.getElementById('btnModeAmount');
    const btnCount = document.getElementById('btnModeCount');
    const btnItem = document.getElementById('btnModeItem');
    const itemPicker = document.getElementById('itemPickerWrap');
    const container = document.getElementById('timelineChartContainer');
    const legendDot = document.getElementById('chartLegendDot');
    const legendText = document.getElementById('chartLegendText');

    if (btnAmount) btnAmount.classList.toggle('active', mode === 'amount');
    if (btnCount) btnCount.classList.toggle('active', mode === 'count');
    if (btnItem) btnItem.classList.toggle('active', mode === 'item');

    if (itemPicker) {
      itemPicker.style.display = (mode === 'item') ? 'inline-flex' : 'none';
    }

    const daysInMonth = new Date(activeYear, activeMonth, 0).getDate();

    // Instant UI update from cached data if available
    if (allMonthExpenses && allMonthExpenses.length > 0 && container) {
      if (mode === 'item') {
        populateItemPicker(allMonthExpenses);
        renderItemTimelineSVG(container, daysInMonth);
      } else {
        const dailyTotals = new Array(daysInMonth + 1).fill(0);
        const dailyCounts = new Array(daysInMonth + 1).fill(0);
        allMonthExpenses.forEach(exp => {
          const parts = (exp.expense_date || '').split('-');
          if (parts.length === 3) {
            const d = parseInt(parts[2], 10);
            if (d >= 1 && d <= daysInMonth) {
              dailyTotals[d] += parseFloat(exp.amount) || 0;
              dailyCounts[d] += 1;
            }
          }
        });
        if (legendDot) legendDot.style.background = (mode === 'count') ? '#2563EB' : 'var(--brand-primary)';
        if (legendText) legendText.textContent = (mode === 'count') ? 'Txn Count' : 'Daily Total';
        renderTimelineSVG(container, dailyTotals, dailyCounts, daysInMonth);
      }
    } else {
      if (mode === 'amount') {
        if (legendDot) legendDot.style.background = 'var(--brand-primary)';
        if (legendText) legendText.textContent = 'Daily Total';
      } else if (mode === 'count') {
        if (legendDot) legendDot.style.background = '#2563EB';
        if (legendText) legendText.textContent = 'Txn Count';
      }
    }

    // Always fetch fresh data from server
    loadTimeline();
  }

  // Select Item from Dropdown
  function selectItem(itemName) {
    selectedItem = itemName;
    if (chartMode === 'item') {
      const container = document.getElementById('timelineChartContainer');
      const daysInMonth = new Date(activeYear, activeMonth, 0).getDate();
      if (container) renderItemTimelineSVG(container, daysInMonth);
    }
  }

  function init() {
    initPeriodSelectors();

    function closeMobileSidebar() {
      document.getElementById('appSidebar')?.classList.remove('is-open');
      document.getElementById('sidebarBackdrop')?.classList.remove('is-visible');
    }

    // Unified Sidebar Toggle function for desktop collapse and mobile drawer
    function toggleSidebar() {
      const sidebar = document.getElementById('appSidebar');
      const backdrop = document.getElementById('sidebarBackdrop');
      if (!sidebar) return;
      if (window.innerWidth <= 768) {
        const willOpen = !sidebar.classList.contains('is-open');
        sidebar.classList.toggle('is-open', willOpen);
        backdrop?.classList.toggle('is-visible', willOpen);
      } else {
        const isCollapsed = sidebar.classList.toggle('is-collapsed');
        try {
          localStorage.setItem('spendwise_sidebar_collapsed', isCollapsed ? '1' : '0');
        } catch (e) {}
      }
    }

    // Topbar mobile hamburger button
    document.getElementById('mobileMenuBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSidebar();
    });

    // Sidebar hamburger toggle button (inside desktop sidebar header)
    document.getElementById('sidebarToggleBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSidebar();
    });

    // Mobile close button (X inside mobile drawer)
    document.getElementById('closeSidebarBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileSidebar();
    });

    // Close mobile sidebar on backdrop click
    document.getElementById('sidebarBackdrop')?.addEventListener('click', () => {
      closeMobileSidebar();
    });

    // Close mobile sidebar on outside click
    document.addEventListener('click', (e) => {
      const sidebar = document.getElementById('appSidebar');
      const mobileBtn = document.getElementById('mobileMenuBtn');
      const sidebarBtn = document.getElementById('sidebarToggleBtn');
      if (sidebar && sidebar.classList.contains('is-open')) {
        if (!sidebar.contains(e.target) && !mobileBtn?.contains(e.target) && !sidebarBtn?.contains(e.target)) {
          closeMobileSidebar();
        }
      }
    });

    // Restore desktop collapsed state preference
    try {
      if (window.innerWidth > 768 && localStorage.getItem('spendwise_sidebar_collapsed') === '1') {
        document.getElementById('appSidebar')?.classList.add('is-collapsed');
      }
    } catch (e) {}

    // Timeline chart view mode button click listeners
    document.getElementById('btnModeAmount')?.addEventListener('click', () => setChartMode('amount'));
    document.getElementById('btnModeCount')?.addEventListener('click', () => setChartMode('count'));
    document.getElementById('btnModeItem')?.addEventListener('click', () => setChartMode('item'));
    document.getElementById('itemPickerSelect')?.addEventListener('change', (e) => selectItem(e.target.value));

    // Tab switcher links — use History API, not hash
    document.querySelectorAll('[data-tab]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = link.getAttribute('data-tab');
        if (tab === 'telegram') {
          // Telegram is a modal, not a real route
          document.getElementById('telegramModal')?.classList.add('is-open');
          return;
        }
        navigate(tab);
      });
    });

    document.getElementById('btnViewAllTransactions')?.addEventListener('click', (e) => {
      e.preventDefault();
      navigate('transactions');
    });

    // Read initial tab from path
    const pathTabMap = { '/transactions': 'transactions', '/overview': 'overview', '/budget': 'budget', '/budgets': 'budget' };
    const initialTab = pathTabMap[window.location.pathname] || 'overview';
    switchTab(initialTab);

    // Handle browser Back / Forward
    window.addEventListener('popstate', (e) => {
      const tab = (e.state && e.state.tab) ? e.state.tab
        : (pathTabMap[window.location.pathname] || 'overview');
      switchTab(tab);
    });

    // Seed initial history state so Back works from the first page
    history.replaceState({ tab: initialTab }, '', window.location.pathname);

    // Initial load
    refreshOverview();
  }

  return {
    init,
    refreshAll,
    refreshOverview,
    switchTab,
    navigate,
    setChartMode,
    selectItem,
  };
})();

// Assign to window immediately so inline attributes like onclick="Dashboard.setChartMode(...)" work instantly
window.Dashboard = Dashboard;
window.Expenses = Expenses;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  Auth.init();
  Expenses.init();
  TelegramHub.init();
  if (typeof Budget !== 'undefined' && Budget.init) {
    Budget.init();
  }
  Dashboard.init();
});
