/**
 * SpendWise - Budget & Savings Module
 * Handles Budget Overview, Category Limits, Spending Pace, Savings Insights,
 * Monthly Comparisons, and Historical Trends Visualization.
 */

// Defensive fallback: ensure API.budgets is always defined even if api.js was cached from an earlier version
(function ensureBudgetApi() {
  async function fallbackFetch(endpoint, options = {}) {
    if (typeof API !== 'undefined' && typeof API.request === 'function') {
      return API.request(endpoint, options);
    }
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
    const response = await fetch(url, config);
    if (response.status === 401) {
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login?expired=1';
      }
      throw new Error('Your session has expired. Please sign in again.');
    }
    if (response.status === 204) return null;
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
  }

  const budgetMethods = {
    list: (year, month) => {
      let q = '';
      if (year && month) q = `?year=${year}&month=${month}`;
      else if (year) q = `?year=${year}`;
      return fallbackFetch(`/api/budgets${q}`);
    },
    summary: (year, month) => fallbackFetch(`/api/budgets/summary?year=${year}&month=${month}`),
    create: (data) => fallbackFetch('/api/budgets', { method: 'POST', body: data }),
    update: (id, data) => fallbackFetch(`/api/budgets/${id}`, { method: 'PATCH', body: data }),
    delete: (id) => fallbackFetch(`/api/budgets/${id}`, { method: 'DELETE' }),
  };

  if (typeof window !== 'undefined') {
    if (typeof window.API === 'undefined') {
      window.API = { budgets: budgetMethods };
    } else if (!window.API.budgets) {
      window.API.budgets = budgetMethods;
    }
  }
})();

const Budget = (() => {
  let currentSummary = null;
  let activeYear = new Date().getFullYear();
  let activeMonth = new Date().getMonth() + 1;
  let deletingBudgetId = null;

  // Currency helper
  function formatCurrency(amount) {
    if (typeof Expenses !== 'undefined' && Expenses.formatCurrency) {
      return Expenses.formatCurrency(amount);
    }
    const num = Number(amount) || 0;
    return '₹ ' + num.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  // Load summary from API and render all views
  async function loadBudgetSummary(year, month) {
    activeYear = year || activeYear;
    activeMonth = month || activeMonth;

    const loadingSpinner = document.getElementById('budgetLoadingState');
    const contentArea = document.getElementById('budgetContentArea');
    if (loadingSpinner) loadingSpinner.style.display = 'flex';
    if (contentArea) contentArea.style.opacity = '0.5';

    try {
      const summary = await API.budgets.summary(activeYear, activeMonth);
      currentSummary = summary;

      renderOverview(summary);
      renderPaceBanner(summary);
      renderCategoryBudgets(summary);
      renderSavingsInsights(summary);
      renderMonthlyComparison(summary);
      renderHistoricalTrends(summary);
      renderDashboardCompactCard(summary);

    } catch (err) {
      console.error('Failed to load budget summary:', err);
      showToast('Could not load budget data: ' + err.message, 'danger');
    } finally {
      if (loadingSpinner) loadingSpinner.style.display = 'none';
      if (contentArea) contentArea.style.opacity = '1';
    }
  }

  // 1. Budget Overview KPI Cards
  function renderOverview(data) {
    const totalBudgetEl = document.getElementById('budgetStatTotalBudget');
    const totalSpentEl = document.getElementById('budgetStatTotalSpent');
    const spentPercentBadge = document.getElementById('budgetStatSpentPercentBadge');
    const remainingEl = document.getElementById('budgetStatRemaining');
    const remainingLabelEl = document.getElementById('budgetStatRemainingLabel');
    const remainingSubtextEl = document.getElementById('budgetStatRemainingSubtext');
    const projectedEl = document.getElementById('budgetStatProjected');
    const projectedSubtextEl = document.getElementById('budgetStatProjectedSubtext');

    if (totalBudgetEl) totalBudgetEl.textContent = formatCurrency(data.monthly_budget);
    if (totalSpentEl) totalSpentEl.textContent = formatCurrency(data.total_spent);

    if (spentPercentBadge) {
      if (data.monthly_budget > 0) {
        spentPercentBadge.textContent = `${data.percentage_used}% used`;
        spentPercentBadge.className = 'badge ' + (
          data.percentage_used > 100 ? 'badge-danger' :
          data.percentage_used >= 80 ? 'badge-warning' : 'badge-success'
        );
        spentPercentBadge.style.display = 'inline-flex';
      } else {
        spentPercentBadge.style.display = 'none';
      }
    }

    if (remainingEl && remainingLabelEl && remainingSubtextEl) {
      if (data.monthly_budget === 0) {
        remainingLabelEl.textContent = 'Budget Unset';
        remainingEl.textContent = '—';
        remainingEl.className = 'metric-value';
        remainingSubtextEl.textContent = 'Add category budgets below';
      } else if (data.is_over_budget) {
        const overAmt = Math.abs(data.remaining_budget);
        remainingLabelEl.textContent = 'Budget Deficit';
        remainingEl.textContent = '- ' + formatCurrency(overAmt);
        remainingEl.className = 'metric-value amount-serif text-danger';
        remainingSubtextEl.textContent = `Over budget by ${formatCurrency(overAmt)}`;
      } else {
        remainingLabelEl.textContent = 'Remaining Budget';
        remainingEl.textContent = formatCurrency(data.remaining_budget);
        remainingEl.className = 'metric-value amount-serif text-success';
        remainingSubtextEl.textContent = `${(100 - data.percentage_used).toFixed(1)}% of budget left`;
      }
    }

    if (projectedEl && projectedSubtextEl) {
      projectedEl.textContent = formatCurrency(data.projected_spending);
      if (data.monthly_budget > 0) {
        if (data.projected_surplus >= 0) {
          projectedSubtextEl.innerHTML = `<span class="text-success font-semibold">Projected Surplus: ${formatCurrency(data.projected_surplus)}</span>`;
        } else {
          projectedSubtextEl.innerHTML = `<span class="text-danger font-semibold">Projected Deficit: ${formatCurrency(Math.abs(data.projected_surplus))}</span>`;
        }
      } else {
        projectedSubtextEl.textContent = `Daily pace: ${formatCurrency(data.daily_avg_spent)}/day`;
      }
    }
  }

  // 2. Spending Pace Banner
  function renderPaceBanner(data) {
    const bannerWrap = document.getElementById('budgetPaceBanner');
    if (!bannerWrap) return;

    const pace = data.pace || {};
    const status = pace.status || 'no_budget';

    let badgeClass = 'badge-muted';
    let badgeText = pace.headline || 'No Budget';
    let iconSvg = '';

    if (status === 'on_track') {
      badgeClass = 'badge-success';
      iconSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
    } else if (status === 'warning') {
      badgeClass = 'badge-warning';
      iconSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    } else if (status === 'danger' || status === 'over_budget') {
      badgeClass = 'badge-danger';
      iconSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    } else {
      badgeClass = 'badge-info';
      iconSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    }

    const elapsedPct = Math.min(100, Math.max(0, data.elapsed_pct));
    const budgetPct = Math.min(100, Math.max(0, data.percentage_used));

    bannerWrap.innerHTML = `
      <div class="pace-banner-inner">
        <div class="pace-header">
          <div class="pace-header-left">
            <span class="pace-icon ${status}">${iconSvg}</span>
            <div>
              <div class="pace-title-row">
                <span class="pace-title">${pace.headline}</span>
                <span class="badge ${badgeClass}">${badgeText}</span>
              </div>
              <p class="pace-message">${pace.message}</p>
            </div>
          </div>
          ${data.days_remaining > 0 && data.monthly_budget > 0 ? `
            <div class="pace-guardrail-card">
              <span class="guardrail-label">Safe Daily Allowance</span>
              <span class="guardrail-amount amount-serif">${formatCurrency(data.safe_daily_spend)}</span>
              <span class="guardrail-sub">for next ${data.days_remaining} day${data.days_remaining !== 1 ? 's' : ''}</span>
            </div>
          ` : ''}
        </div>

        ${data.monthly_budget > 0 ? `
          <div class="pace-comparison-bars">
            <div class="pace-bar-row">
              <div class="pace-bar-meta">
                <span>Month Timeline</span>
                <span class="font-semibold">${data.elapsed_days} of ${data.days_in_month} days (${elapsedPct}%)</span>
              </div>
              <div class="progress-bar-track">
                <div class="progress-bar-fill progress-fill-timeline" style="width: ${elapsedPct}%;"></div>
              </div>
            </div>

            <div class="pace-bar-row">
              <div class="pace-bar-meta">
                <span>Budget Consumed</span>
                <span class="font-semibold">${formatCurrency(data.total_spent)} of ${formatCurrency(data.monthly_budget)} (${data.percentage_used}%)</span>
              </div>
              <div class="progress-bar-track">
                <div class="progress-bar-fill ${data.percentage_used > 100 ? 'progress-fill-danger' : data.percentage_used >= 80 ? 'progress-fill-warning' : 'progress-fill-success'}" style="width: ${budgetPct}%;"></div>
              </div>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  // 3. Category Budgets & Unbudgeted Categories
  function renderCategoryBudgets(data) {
    const container = document.getElementById('categoryBudgetsList');
    const countBadge = document.getElementById('categoryBudgetsCountBadge');
    const unbudgetedContainer = document.getElementById('unbudgetedCategoriesList');
    const unbudgetedSection = document.getElementById('unbudgetedSection');

    const budgeted = data.category_budgets || [];
    const unbudgeted = data.unbudgeted_categories || [];

    if (countBadge) {
      countBadge.textContent = `${budgeted.length} configured`;
    }

    if (!container) return;

    if (budgeted.length === 0) {
      container.innerHTML = `
        <div class="empty-state-card" style="padding: 2.5rem 1.5rem; text-align: center;">
          <div class="empty-state-icon" style="margin-bottom: 0.75rem; color: var(--text-muted);">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"></path>
              <path d="M3 5v14a2 2 0 0 0 2 2h16v-5"></path>
              <path d="M18 12a2 2 0 0 0 0 4h4v-4Z"></path>
            </svg>
          </div>
          <h4 style="font-size: 1.05rem; font-weight: 600; margin-bottom: 0.35rem; color: var(--text-primary);">No Budgets Configured</h4>
          <p style="color: var(--text-secondary); font-size: 0.875rem; max-width: 380px; margin: 0 auto 1.25rem;">
            Set monthly spending limits on your categories to take control of your cash flow and identify potential savings.
          </p>
          <button class="btn btn-primary btn-sm" onclick="Budget.openSetBudgetModal()">
            + Set Category Budget
          </button>
        </div>
      `;
    } else {
      container.innerHTML = budgeted.map(item => {
        const catMeta = (typeof Expenses !== 'undefined' && Expenses.getCategoryMeta)
          ? Expenses.getCategoryMeta(item.category)
          : { badgeClass: 'badge-misc', label: item.category };

        const pct = item.percentage_used;
        const barWidth = Math.min(100, Math.max(0, pct));
        const statusClass = item.status === 'danger' ? 'danger' : (item.status === 'warning' ? 'warning' : 'success');
        const badgeLabel = item.status === 'danger' ? 'Over Budget' : (item.status === 'warning' ? 'Caution' : 'On Track');

        return `
          <div class="budget-card-item">
            <div class="budget-item-top">
              <div class="budget-item-cat">
                <span class="badge ${catMeta.badgeClass}">${catMeta.label}</span>
                <span class="badge badge-subtle-${statusClass}">${badgeLabel}</span>
              </div>
              <div class="budget-item-actions">
                <button class="btn btn-ghost btn-xs" title="Edit budget" onclick="Budget.openSetBudgetModal('${escapeHtml(item.category)}', ${item.monthly_limit})">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 20h9"></path>
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                  </svg>
                  <span>Edit</span>
                </button>
                <button class="btn btn-ghost btn-xs text-danger" title="Delete budget" onclick="Budget.confirmDeleteBudget(${item.id}, '${escapeHtml(item.category)}')">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </button>
              </div>
            </div>

            <div class="budget-numbers-row">
              <div>
                <span class="budget-num-label">Spent</span>
                <div class="budget-num-val amount-serif">${formatCurrency(item.spent)}</div>
              </div>
              <div class="text-center">
                <span class="budget-num-label">Usage</span>
                <div class="budget-num-val font-semibold ${item.status === 'danger' ? 'text-danger' : (item.status === 'warning' ? 'text-warning' : '')}">${pct}%</div>
              </div>
              <div class="text-right">
                <span class="budget-num-label">Limit</span>
                <div class="budget-num-val amount-serif">${formatCurrency(item.monthly_limit)}</div>
              </div>
            </div>

            <div class="progress-bar-track" style="height: 7px; margin-top: 0.5rem;">
              <div class="progress-bar-fill progress-fill-${statusClass}" style="width: ${barWidth}%;"></div>
            </div>

            <div class="budget-item-bottom">
              <span class="text-muted text-xs">
                ${item.remaining >= 0 ? `${formatCurrency(item.remaining)} remaining` : `<span class="text-danger font-semibold">Exceeded by ${formatCurrency(Math.abs(item.remaining))}</span>`}
              </span>
            </div>
          </div>
        `;
      }).join('');
    }

    // Render unbudgeted categories with spend
    if (unbudgetedSection && unbudgetedContainer) {
      if (unbudgeted.length > 0) {
        unbudgetedSection.style.display = 'block';
        unbudgetedContainer.innerHTML = unbudgeted.map(u => {
          const catMeta = (typeof Expenses !== 'undefined' && Expenses.getCategoryMeta)
            ? Expenses.getCategoryMeta(u.category)
            : { badgeClass: 'badge-misc', label: u.category };

          return `
            <div class="unbudgeted-item-row">
              <div style="display: flex; align-items: center; gap: 0.5rem;">
                <span class="badge ${catMeta.badgeClass}">${catMeta.label}</span>
                <span class="text-secondary text-sm">Spent: <strong class="amount-serif">${formatCurrency(u.spent)}</strong></span>
              </div>
              <button class="btn btn-outline btn-xs" onclick="Budget.openSetBudgetModal('${escapeHtml(u.category)}', ${Math.ceil(u.spent / 100) * 100})">
                + Set Limit
              </button>
            </div>
          `;
        }).join('');
      } else {
        unbudgetedSection.style.display = 'none';
      }
    }
  }

  // 4. Savings Insights (Distinguishing Budget Surplus vs Actual Savings)
  function renderSavingsInsights(data) {
    const container = document.getElementById('savingsInsightsContainer');
    if (!container) return;

    const insights = data.savings_insights || [];

    if (insights.length === 0) {
      container.innerHTML = `
        <div class="empty-state-card" style="padding: 1.5rem; text-align: center; color: var(--text-muted);">
          No insights available for this period.
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="savings-cards-grid">
        ${insights.map(item => {
          let badgeColor = 'var(--brand-primary)';
          let iconSvg = '';

          if (item.type === 'surplus_vs_savings') {
            badgeColor = '#257A54';
            iconSvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>';
          } else if (item.type === 'daily_safe') {
            badgeColor = '#2B6CB0';
            iconSvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
          } else if (item.type === 'discretionary') {
            badgeColor = '#C2781E';
            iconSvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>';
          } else {
            badgeColor = '#059669';
            iconSvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>';
          }

          return `
            <div class="insight-box-card">
              <div class="insight-box-header">
                <span class="insight-box-icon" style="color: ${badgeColor}; background: ${badgeColor}15;">
                  ${iconSvg}
                </span>
                <span class="insight-box-title">${item.title}</span>
              </div>
              <div class="insight-box-content">
                <p class="insight-box-message">${item.message}</p>
                ${item.type === 'surplus_vs_savings' && data.monthly_budget > 0 ? `
                  <div class="surplus-distinction-grid">
                    <div class="surplus-distinction-item">
                      <span class="distinction-tag">Unspent Budget Surplus</span>
                      <span class="distinction-amount amount-serif ${data.remaining_budget >= 0 ? 'text-success' : 'text-danger'}">
                        ${data.remaining_budget >= 0 ? formatCurrency(data.remaining_budget) : '-' + formatCurrency(Math.abs(data.remaining_budget))}
                      </span>
                      <span class="distinction-hint">Remaining from planned allocation</span>
                    </div>
                    <div class="surplus-distinction-item">
                      <span class="distinction-tag">Projected Net Savings</span>
                      <span class="distinction-amount amount-serif ${data.projected_surplus >= 0 ? 'text-success' : 'text-danger'}">
                        ${data.projected_surplus >= 0 ? formatCurrency(data.projected_surplus) : '-' + formatCurrency(Math.abs(data.projected_surplus))}
                      </span>
                      <span class="distinction-hint">Estimated month-end result</span>
                    </div>
                  </div>
                ` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // 5. Monthly Comparison
  function renderMonthlyComparison(data) {
    const container = document.getElementById('monthlyComparisonContainer');
    if (!container) return;

    const comp = data.monthly_comparison || {};
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const prevMonthName = months[(comp.prev_month || 1) - 1];
    const currMonthName = months[(data.month || 1) - 1];

    const diff = comp.spend_diff || 0;
    const diffPct = comp.spend_diff_pct || 0;
    const isReduction = diff < 0;

    const catChanges = comp.category_comparisons || [];
    const reductions = comp.spending_reductions || [];

    container.innerHTML = `
      <div class="comparison-summary-banner ${isReduction ? 'comparison-favorable' : (diff > 0 ? 'comparison-unfavorable' : '')}">
        <div class="comparison-banner-left">
          <span class="comparison-banner-title">
            ${isReduction ? '🎉 Spending Reduced' : (diff > 0 ? '📈 Spending Increased' : '⚖️ Spending Consistent')}
          </span>
          <p class="comparison-banner-desc">
            ${diff === 0 && comp.prev_total_spent === 0 ? 'No previous month data to compare.' :
              `You spent <strong>${formatCurrency(Math.abs(diff))}</strong> (${Math.abs(diffPct)}%) ${isReduction ? 'less' : 'more'} in ${currMonthName} compared to ${prevMonthName}.`
            }
          </p>
        </div>
        <div class="comparison-totals-pill">
          <div>
            <span class="text-xs text-muted">${prevMonthName}:</span>
            <span class="font-semibold amount-serif">${formatCurrency(comp.prev_total_spent)}</span>
          </div>
          <div>
            <span class="text-xs text-muted">${currMonthName}:</span>
            <span class="font-semibold amount-serif">${formatCurrency(data.total_spent)}</span>
          </div>
        </div>
      </div>

      ${reductions.length > 0 ? `
        <div class="spending-cuts-showcase">
          <span class="showcase-title">🏆 Top Spending Cuts vs ${prevMonthName}:</span>
          <div class="cuts-tags-wrap">
            ${reductions.slice(0, 3).map(r => `
              <span class="cut-tag">
                <strong>${r.category}</strong>: Saved ${formatCurrency(r.saved_amount)} (${r.pct_change.toFixed(0)}% cut)
              </span>
            `).join('')}
          </div>
        </div>
      ` : ''}

      ${catChanges.length > 0 ? `
        <div class="table-responsive" style="margin-top: 1rem;">
          <table class="data-table">
            <thead>
              <tr>
                <th>Category</th>
                <th class="text-right">${prevMonthName}</th>
                <th class="text-right">${currMonthName}</th>
                <th class="text-right">Change</th>
              </tr>
            </thead>
            <tbody>
              ${catChanges.map(c => `
                <tr>
                  <td><span class="font-medium">${c.category}</span></td>
                  <td class="text-right amount-serif text-muted">${formatCurrency(c.prev_spent)}</td>
                  <td class="text-right amount-serif font-semibold">${formatCurrency(c.current_spent)}</td>
                  <td class="text-right font-medium ${c.reduced ? 'text-success' : (c.diff > 0 ? 'text-danger' : 'text-muted')}">
                    ${c.diff < 0 ? '↓ ' : (c.diff > 0 ? '↑ ' : '')}${formatCurrency(Math.abs(c.diff))}
                    <span class="text-xs">(${c.pct_change > 0 ? '+' : ''}${c.pct_change.toFixed(0)}%)</span>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<p class="text-muted text-sm text-center py-4">No category changes recorded.</p>'}
    `;
  }

  // 6. Historical Trends SVG Chart (Last 6 Months)
  function renderHistoricalTrends(data) {
    const container = document.getElementById('historicalTrendsChartContainer');
    if (!container) return;

    const trends = data.historical_trends || [];
    if (trends.length === 0) {
      container.innerHTML = '<p class="text-muted text-center py-6">No historical data available.</p>';
      return;
    }

    const svgWidth = 600;
    const svgHeight = 220;
    const padding = { top: 25, right: 20, bottom: 40, left: 65 };
    const chartW = svgWidth - padding.left - padding.right;
    const chartH = svgHeight - padding.top - padding.bottom;

    // Find max value for Y-scale
    const maxVal = Math.max(
      1000,
      ...trends.map(t => Math.max(t.budget || 0, t.spent || 0))
    ) * 1.15;

    // Grid lines
    const gridSteps = 4;
    let gridSvg = '';
    for (let i = 0; i <= gridSteps; i++) {
      const yVal = (maxVal / gridSteps) * i;
      const yPos = padding.top + chartH - (yVal / maxVal) * chartH;
      gridSvg += `
        <line x1="${padding.left}" y1="${yPos}" x2="${svgWidth - padding.right}" y2="${yPos}" stroke="#E2E8E0" stroke-width="1" stroke-dasharray="${i === 0 ? '0' : '3,3'}"/>
        <text x="${padding.left - 8}" y="${yPos + 4}" fill="#7A8C83" font-size="10" text-anchor="end" font-family="Plus Jakarta Sans">₹${(yVal >= 1000 ? (yVal / 1000).toFixed(0) + 'k' : yVal.toFixed(0))}</text>
      `;
    }

    // Bars
    const groupWidth = chartW / trends.length;
    const barWidth = Math.min(22, (groupWidth - 14) / 2);
    let barsSvg = '';

    trends.forEach((t, i) => {
      const groupX = padding.left + i * groupWidth + (groupWidth / 2);

      const bH = (t.budget / maxVal) * chartH;
      const bY = padding.top + chartH - bH;
      const bX = groupX - barWidth - 2;

      const sH = (t.spent / maxVal) * chartH;
      const sY = padding.top + chartH - sH;
      const sX = groupX + 2;

      const isOver = t.budget > 0 && t.spent > t.budget;
      const spentColor = isOver ? '#DC2626' : '#22543D';

      barsSvg += `
        <!-- Budget Bar (Planned) -->
        <rect class="trend-bar-budget" x="${bX}" y="${bY}" width="${barWidth}" height="${Math.max(1, bH)}" rx="3" fill="#8EA893" opacity="0.85">
          <title>${t.label} Budget: ${formatCurrency(t.budget)}</title>
        </rect>
        <!-- Spent Bar (Actual) -->
        <rect class="trend-bar-spent" x="${sX}" y="${sY}" width="${barWidth}" height="${Math.max(1, sH)}" rx="3" fill="${spentColor}">
          <title>${t.label} Spent: ${formatCurrency(t.spent)}${isOver ? ' (Over budget)' : ''}</title>
        </rect>
        <!-- Month Label -->
        <text x="${groupX}" y="${svgHeight - 12}" fill="#4A5B53" font-size="11" font-weight="500" text-anchor="middle" font-family="Plus Jakarta Sans">${t.label}</text>
      `;
    });

    container.innerHTML = `
      <svg viewBox="0 0 ${svgWidth} ${svgHeight}" preserveAspectRatio="xMidYMid meet" style="width: 100%; height: 100%; min-height: 200px;">
        ${gridSvg}
        ${barsSvg}
      </svg>
    `;
  }

  // 7. Compact Summary Card on Overview Tab
  function renderDashboardCompactCard(data) {
    const cardContainer = document.getElementById('overviewBudgetCompactCard');
    if (!cardContainer) return;

    if (!data || data.monthly_budget === 0) {
      cardContainer.innerHTML = `
        <div class="overview-budget-compact">
          <div class="compact-left">
            <div class="compact-title-row">
              <span class="font-semibold text-sm">Monthly Budget & Pace</span>
              <span class="badge badge-info text-xs">Unconfigured</span>
            </div>
            <p class="text-xs text-muted" style="margin-top: 2px;">
              You have spent <strong>${formatCurrency(data ? data.total_spent : 0)}</strong> this month with no budget limits set.
            </p>
          </div>
          <button class="btn btn-outline btn-xs" onclick="Dashboard.navigate('budget')">
            Set Budget &rarr;
          </button>
        </div>
      `;
      return;
    }

    const pct = data.percentage_used;
    const barWidth = Math.min(100, Math.max(0, pct));
    const statusClass = data.is_over_budget ? 'danger' : (pct >= 80 ? 'warning' : 'success');
    const badgeLabel = data.pace ? data.pace.headline : 'On Track';

    cardContainer.innerHTML = `
      <div class="overview-budget-compact">
        <div class="compact-header-row">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span class="font-semibold text-sm">Monthly Budget</span>
            <span class="badge badge-subtle-${statusClass} text-xs">${badgeLabel}</span>
          </div>
          <a href="/budget" class="text-xs font-semibold text-brand hover-underline" onclick="event.preventDefault(); Dashboard.navigate('budget');">
            Manage Budget &rarr;
          </a>
        </div>

        <div class="compact-progress-row">
          <div class="progress-bar-track" style="height: 8px;">
            <div class="progress-bar-fill progress-fill-${statusClass}" style="width: ${barWidth}%;"></div>
          </div>
        </div>

        <div class="compact-footer-row">
          <span class="text-xs text-muted">
            Spent: <strong class="amount-serif font-semibold text-primary">${formatCurrency(data.total_spent)}</strong> of ${formatCurrency(data.monthly_budget)} (${pct}%)
          </span>
          <span class="text-xs ${data.is_over_budget ? 'text-danger font-semibold' : 'text-success'}">
            ${data.is_over_budget ? `Over by ${formatCurrency(Math.abs(data.remaining_budget))}` : `${formatCurrency(data.remaining_budget)} left`}
          </span>
        </div>
      </div>
    `;
  }

  // Modal open for Set / Edit Budget
  function openSetBudgetModal(categoryName, existingLimit) {
    const modal = document.getElementById('setBudgetModal');
    const categorySelect = document.getElementById('budgetModalCategory');
    const limitInput = document.getElementById('budgetModalLimit');
    const titleEl = document.getElementById('setBudgetModalTitle');
    const yearInput = document.getElementById('budgetModalYear');
    const monthInput = document.getElementById('budgetModalMonth');

    if (!modal) return;

    if (yearInput) yearInput.value = activeYear;
    if (monthInput) monthInput.value = activeMonth;

    // Populate category dropdown
    if (categorySelect && typeof Expenses !== 'undefined' && Expenses.CATEGORIES) {
      categorySelect.innerHTML = Expenses.CATEGORIES.map(c => `
        <option value="${c.id}" ${c.id.toLowerCase() === (categoryName || '').toLowerCase() ? 'selected' : ''}>
          ${c.label}
        </option>
      `).join('');
    }

    if (existingLimit && limitInput) {
      limitInput.value = existingLimit;
      if (titleEl) titleEl.textContent = `Edit Budget: ${categoryName}`;
    } else {
      if (limitInput) limitInput.value = '';
      if (titleEl) titleEl.textContent = 'Set Category Budget';
    }

    modal.classList.add('is-open');
    if (limitInput) limitInput.focus();
  }

  // Handle Save Budget submission
  async function handleBudgetSubmit(e) {
    e.preventDefault();
    const category = document.getElementById('budgetModalCategory')?.value;
    const limit = parseFloat(document.getElementById('budgetModalLimit')?.value);
    const year = parseInt(document.getElementById('budgetModalYear')?.value || activeYear, 10);
    const month = parseInt(document.getElementById('budgetModalMonth')?.value || activeMonth, 10);

    if (!category || isNaN(limit) || limit <= 0) {
      showToast('Please provide a valid category and monthly limit greater than 0.', 'warning');
      return;
    }

    try {
      await API.budgets.create({
        category,
        monthly_limit: limit,
        year,
        month,
      });

      showToast(`Budget for ${category} saved successfully!`, 'success');
      document.getElementById('setBudgetModal')?.classList.remove('is-open');
      loadBudgetSummary(activeYear, activeMonth);

    } catch (err) {
      console.error('Failed to save budget:', err);
      showToast('Could not save budget: ' + err.message, 'danger');
    }
  }

  // Confirm delete budget
  function confirmDeleteBudget(budgetId, categoryName) {
    deletingBudgetId = budgetId;
    const modal = document.getElementById('deleteBudgetModal');
    const nameEl = document.getElementById('deleteBudgetCategoryName');
    if (nameEl) nameEl.textContent = categoryName;
    if (modal) modal.classList.add('is-open');
  }

  // Execute delete budget
  async function executeDeleteBudget() {
    if (!deletingBudgetId) return;

    try {
      await API.budgets.delete(deletingBudgetId);
      showToast('Budget deleted successfully.', 'success');
      document.getElementById('deleteBudgetModal')?.classList.remove('is-open');
      deletingBudgetId = null;
      loadBudgetSummary(activeYear, activeMonth);

    } catch (err) {
      console.error('Failed to delete budget:', err);
      showToast('Could not delete budget: ' + err.message, 'danger');
    }
  }

  // Helper escape
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function init() {
    // Form submit listener
    document.getElementById('setBudgetForm')?.addEventListener('submit', handleBudgetSubmit);

    // Confirm delete listener
    document.getElementById('btnConfirmDeleteBudget')?.addEventListener('click', executeDeleteBudget);

    // Close modals
    document.querySelectorAll('.js-close-budget-modal').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('setBudgetModal')?.classList.remove('is-open');
        document.getElementById('deleteBudgetModal')?.classList.remove('is-open');
        deletingBudgetId = null;
      });
    });

    // Close on backdrop click
    ['setBudgetModal', 'deleteBudgetModal'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', (e) => {
        if (e.target.id === id) {
          document.getElementById(id)?.classList.remove('is-open');
          deletingBudgetId = null;
        }
      });
    });
  }

  return {
    init,
    loadBudgetSummary,
    openSetBudgetModal,
    confirmDeleteBudget,
    renderDashboardCompactCard,
  };
})();

window.Budget = Budget;
