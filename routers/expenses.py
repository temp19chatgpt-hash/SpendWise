from fastapi import APIRouter, HTTPException, Query, Request
from models import (
    ExpenseResponse,
    PaginatedExpenseResponse,
    ExpenseCreate,
    ExpenseUpdate,
    ExpenseReplace,
    BudgetResponse,
    BudgetCreate,
    BudgetUpdate,
)
from database import supabase_admin
from datetime import date
import calendar


router = APIRouter()



@router.get('/api/expenses', response_model=PaginatedExpenseResponse)
def get_expenses(
    request: Request,  # NEW: access the login session
    search: str | None = None,
    category: str | None = None,
    max_amount: float | None = Query(default=None, ge=0),
    start_date: date | None = None,
    end_date: date | None = None,
    sort_by: str = "expense_date",
    order: str = "desc",
    limit: int = Query(default=10, ge=1, le=500),
    offset: int = Query(default=0, ge=0)
):
    # NEW: check the logged-in user
    user = request.session.get("user")

    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")

    allowed_sort_fields = {"expense_date", "amount", "item"}
    if sort_by not in allowed_sort_fields:
        raise HTTPException(status_code=400, detail="Invalid sort field")

    if order not in {"asc", "desc"}:
        raise HTTPException(status_code=400, detail="Order must be asc or desc")

    # CHANGED: use the server-side client and filter by owner
    query = (
        supabase_admin.table("expenses")
        .select("*", count="exact")
        .eq("user_id", user["id"])
    )

    if search:
        query = query.ilike("item", f"%{search.strip()}%")

    if category and category.strip() and category.strip().lower() != "all categories":
        query = query.ilike("category", category.strip())

    if max_amount is not None:
        query = query.lte("amount", max_amount)

    if start_date:
        query = query.gte("expense_date", start_date.isoformat())

    if end_date:
        query = query.lte("expense_date", end_date.isoformat())

    query = query.order(sort_by, desc=(order == "desc"))
    query = query.range(offset, offset + limit - 1)

    response = query.execute()

    return {
        "total": response.count,
        "limit": limit,
        "offset": offset,
        "expenses": response.data
    }


@router.get('/api/expenses/summary/monthly')
def monthly_summary(
    request: Request,
    year: int = Query(ge=2000, le=2100),
    month: int = Query(ge=1, le=12)
):
    user = request.session.get("user")

    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")

    start_date = date(year, month, 1)

    if month == 12:
        end_date = date(year + 1, 1, 1)
    else:
        end_date = date(year, month + 1, 1)

    response = (
        supabase_admin.table("expenses")
        .select("amount")
        .eq("user_id", user["id"])
        .gte("expense_date", start_date.isoformat())
        .lt("expense_date", end_date.isoformat())
        .execute()
    )

    amounts = [float(exp["amount"]) for exp in response.data]

    return {
        "year": year,
        "month": month,
        "total_expenses": len(amounts),
        "total_amount": round(sum(amounts), 2)
    }

@router.get('/api/expenses/summary/categories')
def category_summary(request: Request):
    user = request.session.get("user")

    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")

    response = (
        supabase_admin.table("expenses")
        .select("category, amount")
        .eq("user_id", user["id"])
        .execute()
    )

    summary = {}

    for expense in response.data:
        category = expense["category"]
        amount = float(expense["amount"])

        if category not in summary:
            summary[category] = {
                "total_expenses": 0,
                "total_amount": 0
            }

        summary[category]["total_expenses"] += 1
        summary[category]["total_amount"] += amount

    return [
        {
            "category": category,
            "total_expenses": values["total_expenses"],
            "total_amount": round(values["total_amount"], 2)
        }
        for category, values in summary.items()
    ]

@router.get('/api/expenses/summary')
def expense_summary(request: Request):
    user = request.session.get("user")

    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")

    response = (
        supabase_admin.table("expenses")
        .select("amount")
        .eq("user_id", user["id"])
        .execute()
    )

    amounts = [float(exp["amount"]) for exp in response.data]
    total = sum(amounts)
    count = len(amounts)

    return {
        "total_expenses": count,
        "total_amount": round(total, 2),
        "average_amount": round(total / count, 2) if count else 0
    }

@router.get('/api/expenses/insights')
def get_insights(
    request: Request,
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12)
):
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")

    # Fetch all expenses for user to calculate accurate analytics
    query = (
        supabase_admin.table("expenses")
        .select("id, item, amount, category, expense_date")
        .eq("user_id", user["id"])
    )

    all_res = query.order("expense_date", desc=True).execute()
    all_data = all_res.data or []

    # Filter by specific month if requested
    period_data = []
    if year is not None and month is not None:
        start_date_str = f"{year}-{month:02d}-01"
        if month == 12:
            end_date_str = f"{year + 1}-01-01"
        else:
            end_date_str = f"{year}-{month + 1:02d}-01"

        period_data = [
            e for e in all_data
            if e.get("expense_date") and start_date_str <= e["expense_date"] < end_date_str
        ]

    # If selected period has data, use it; otherwise use all-time records
    has_period_data = len(period_data) > 0
    active_data = period_data if has_period_data else all_data

    if not active_data:
        return {
            "has_data": False,
            "is_all_time": False,
            "most_frequent_item": None,
            "highest_spending_item": None,
            "largest_transaction": None,
            "top_category": None,
            "total_items": 0,
        }

    # Aggregate item statistics
    item_counts = {}
    item_totals = {}
    item_categories = {}
    category_totals = {}
    category_counts = {}
    largest_txn = None

    for exp in active_data:
        item = (exp.get("item") or "").strip()
        amt = float(exp.get("amount") or 0)
        cat = exp.get("category") or "Other"

        if item:
            item_counts[item] = item_counts.get(item, 0) + 1
            item_totals[item] = round(item_totals.get(item, 0.0) + amt, 2)
            if item not in item_categories:
                item_categories[item] = cat

        category_totals[cat] = round(category_totals.get(cat, 0.0) + amt, 2)
        category_counts[cat] = category_counts.get(cat, 0) + 1

        if largest_txn is None or amt > float(largest_txn.get("amount") or 0):
            largest_txn = exp

    # 1. Most frequent item
    sorted_freq = sorted(item_counts.items(), key=lambda x: x[1], reverse=True)
    most_freq = None
    if sorted_freq:
        name, cnt = sorted_freq[0]
        most_freq = {
            "item": name,
            "count": cnt,
            "total_amount": item_totals.get(name, 0.0),
            "category": item_categories.get(name, "Other"),
            "avg_amount": round(item_totals.get(name, 0.0) / cnt, 2) if cnt else 0.0
        }

    # 2. Highest spending item
    sorted_spend = sorted(item_totals.items(), key=lambda x: x[1], reverse=True)
    top_spend = None
    if sorted_spend:
        name, tot = sorted_spend[0]
        top_spend = {
            "item": name,
            "total_amount": tot,
            "count": item_counts.get(name, 1),
            "category": item_categories.get(name, "Other")
        }

    # 3. Top category
    sorted_cats = sorted(category_totals.items(), key=lambda x: x[1], reverse=True)
    top_cat = None
    if sorted_cats:
        c_name, c_tot = sorted_cats[0]
        top_cat = {
            "category": c_name,
            "total_amount": c_tot,
            "count": category_counts.get(c_name, 0)
        }

    # 4. Daily average calculation
    total_spent = sum(float(e.get("amount") or 0) for e in active_data)
    today = date.today()
    if year is not None and month is not None:
        if year == today.year and month == today.month:
            days_count = max(today.day, 1)
        else:
            import calendar
            _, num_days = calendar.monthrange(year, month)
            days_count = num_days
    else:
        # All time: compute days between min and max date
        dates = [e.get("expense_date") for e in active_data if e.get("expense_date")]
        if dates:
            min_d = min(dates)
            max_d = max(dates)
            from datetime import datetime
            d_span = (datetime.fromisoformat(max_d) - datetime.fromisoformat(min_d)).days + 1
            days_count = max(d_span, 1)
        else:
            days_count = 1

    daily_avg_val = round(total_spent / max(days_count, 1), 2)
    daily_avg = {
        "amount": daily_avg_val,
        "days": days_count,
        "total_amount": round(total_spent, 2),
        "total_transactions": len(active_data)
    }

    # 5. Largest single transaction
    largest_single = None
    if largest_txn:
        largest_single = {
            "item": largest_txn.get("item"),
            "amount": round(float(largest_txn.get("amount") or 0), 2),
            "category": largest_txn.get("category"),
            "expense_date": str(largest_txn.get("expense_date"))
        }

    return {
        "has_data": True,
        "is_all_time": not has_period_data,
        "most_frequent_item": most_freq,
        "highest_spending_item": top_spend,
        "largest_transaction": largest_single,
        "top_category": top_cat,
        "daily_average": daily_avg,
        "total_items": len(active_data)
    }

@router.post("/api/budgets", status_code=201, response_model=BudgetResponse)
def create_budget(budget: BudgetCreate, request: Request):
    user = request.session.get("user")

    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")

    # Check if budget already exists for this category/year/month for the user
    existing = (
        supabase_admin.table("budgets")
        .select("*")
        .eq("user_id", user["id"])
        .eq("category", budget.category)
        .eq("year", budget.year)
        .eq("month", budget.month)
        .limit(1)
        .execute()
    )

    if existing.data:
        updated = (
            supabase_admin.table("budgets")
            .update({"monthly_limit": budget.monthly_limit})
            .eq("id", existing.data[0]["id"])
            .execute()
        )
        return updated.data[0]

    data = budget.model_dump()
    data["user_id"] = user["id"]

    try:
        response = (
            supabase_admin.table("budgets")
            .insert(data)
            .execute()
        )
        return response.data[0]
    except Exception as e:
        # If DB constraint error on (category, year, month), check and update
        fallback = (
            supabase_admin.table("budgets")
            .select("id")
            .eq("category", budget.category)
            .eq("year", budget.year)
            .eq("month", budget.month)
            .limit(1)
            .execute()
        )
        if fallback.data:
            updated = (
                supabase_admin.table("budgets")
                .update({"user_id": user["id"], "monthly_limit": budget.monthly_limit})
                .eq("id", fallback.data[0]["id"])
                .execute()
            )
            return updated.data[0]
        raise HTTPException(status_code=500, detail="Could not save budget") from e

@router.get("/api/expenses/{id}", response_model=ExpenseResponse)
def get_expense(id: int, request: Request):
    user = request.session.get("user")

    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")

    response = (
        supabase_admin.table("expenses")
        .select("*")
        .eq("id", id)
        .eq("user_id", user["id"])
        .execute()
    )

    if not response.data:
        raise HTTPException(status_code=404, detail="Expense not found")

    return response.data[0]

@router.post("/api/expenses", status_code=201, response_model=ExpenseResponse)
def create_expense(expense: ExpenseCreate, request: Request):
    user = request.session.get("user")

    if not user:
        raise HTTPException(
            status_code=401,
            detail="Not logged in"
        )

    data = expense.model_dump(mode="json")
    data["user_id"] = user["id"]

    response = (
        supabase_admin.table("expenses")
        .insert(data)
        .execute()
    )

    return response.data[0]

@router.patch('/api/expenses/{id}', response_model=ExpenseResponse)
def expense_update(id: int, update: ExpenseUpdate, request: Request):
    user = request.session.get("user")

    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")
    
    fields = update.model_dump(exclude_unset=True, mode="json")
    if not fields:
        raise HTTPException(
            status_code=400,
            detail="No fields provided"
        )

    response = (
        supabase_admin.table("expenses")
        .update(fields)
        .eq("id", id)
        .eq("user_id", user["id"])
        .execute()
    )

    if not response.data:
        raise HTTPException(status_code=404, detail="Expense not found")

    return response.data[0]



@router.put('/api/expenses/{id}', response_model=ExpenseResponse)
def replace_expense(id: int, updated: ExpenseReplace, request: Request):
    user = request.session.get("user")

    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")

    response = (
        supabase_admin.table("expenses")
        .update(updated.model_dump(mode="json"))
        .eq("id", id)
        .eq("user_id", user["id"])
        .execute()
    )

    if not response.data:
        raise HTTPException(status_code=404, detail="Expense not found")

    return response.data[0]

@router.delete('/api/expenses/{id}')
def delete_expense(id: int, request: Request):
    user = request.session.get("user")

    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")

    response = (
        supabase_admin.table("expenses")
        .delete()
        .eq("id", id)
        .eq("user_id", user["id"])
        .execute()
    )

    if not response.data:
        raise HTTPException(status_code=404, detail="Expense not found")

    return {"message": "Successfully deleted"}



# NOTE: /api/expenses/summary and /api/expenses/insights are now defined above
# (before /api/expenses/{id}) to avoid FastAPI matching them as path parameters.

@router.get("/api/budgets/summary")
def get_budget_summary(
    request: Request,
    year: int = Query(ge=2000, le=2100),
    month: int = Query(ge=1, le=12)
):
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")

    # 1. Fetch user's budgets for this period
    budget_res = (
        supabase_admin.table("budgets")
        .select("id, category, monthly_limit, year, month")
        .eq("user_id", user["id"])
        .eq("year", year)
        .eq("month", month)
        .execute()
    )
    budgets_data = budget_res.data or []

    # 2. Fetch user's expenses for this period
    start_date_str = f"{year}-{month:02d}-01"
    if month == 12:
        end_date_str = f"{year + 1}-01-01"
    else:
        end_date_str = f"{year}-{month + 1:02d}-01"

    exp_res = (
        supabase_admin.table("expenses")
        .select("id, item, amount, category, expense_date")
        .eq("user_id", user["id"])
        .gte("expense_date", start_date_str)
        .lt("expense_date", end_date_str)
        .execute()
    )
    expenses_data = exp_res.data or []

    # 3. Fetch user's expenses for previous period (for comparison)
    if month == 1:
        prev_year = year - 1
        prev_month = 12
    else:
        prev_year = year
        prev_month = month - 1

    prev_start_str = f"{prev_year}-{prev_month:02d}-01"
    if prev_month == 12:
        prev_end_str = f"{prev_year + 1}-01-01"
    else:
        prev_end_str = f"{prev_year}-{prev_month + 1:02d}-01"

    prev_exp_res = (
        supabase_admin.table("expenses")
        .select("amount, category")
        .eq("user_id", user["id"])
        .gte("expense_date", prev_start_str)
        .lt("expense_date", prev_end_str)
        .execute()
    )
    prev_expenses_data = prev_exp_res.data or []

    # 4. Time calculations
    _, days_in_month = calendar.monthrange(year, month)
    today = date.today()

    if (year, month) == (today.year, today.month):
        elapsed_days = min(today.day, days_in_month)
        is_current_month = True
    elif (year, month) < (today.year, today.month):
        elapsed_days = days_in_month
        is_current_month = False
    else:
        elapsed_days = 0
        is_current_month = False

    days_remaining = max(0, days_in_month - elapsed_days)
    elapsed_pct = round((elapsed_days / days_in_month) * 100, 1) if days_in_month else 0.0

    # 5. Totals & Pace
    total_budget = round(sum(float(b.get("monthly_limit") or 0) for b in budgets_data), 2)
    total_spent = round(sum(float(e.get("amount") or 0) for e in expenses_data), 2)
    remaining_budget = round(total_budget - total_spent, 2)
    pct_used = round((total_spent / total_budget) * 100, 1) if total_budget > 0 else 0.0

    daily_avg_spent = round(total_spent / max(1, elapsed_days), 2) if elapsed_days > 0 else 0.0
    projected_spending = round(daily_avg_spent * days_in_month, 2) if elapsed_days > 0 else total_spent
    projected_surplus = round(total_budget - projected_spending, 2) if total_budget > 0 else 0.0
    safe_daily_spend = round(max(0.0, remaining_budget) / max(1, days_remaining), 2) if days_remaining > 0 and total_budget > 0 else 0.0

    if total_budget == 0:
        pace_status = "no_budget"
        pace_headline = "No Budget Set"
        pace_message = "Set category budgets below to activate pacing and savings insights."
        pace_diff_pct = 0.0
    elif total_spent > total_budget:
        pace_status = "over_budget"
        pace_headline = "Budget Exceeded"
        over_val = round(total_spent - total_budget, 2)
        pace_message = f"You have exceeded your monthly budget by ₹{over_val:,.2f}."
        pace_diff_pct = round(pct_used - elapsed_pct, 1)
    elif elapsed_days == 0:
        pace_status = "on_track"
        pace_headline = "Month Ahead"
        pace_message = f"Ready for the month with a planned budget of ₹{total_budget:,.2f}."
        pace_diff_pct = 0.0
    else:
        pace_diff_pct = round(pct_used - elapsed_pct, 1)
        if pace_diff_pct > 15:
            pace_status = "danger"
            pace_headline = "Overspending Alert"
            pace_message = f"You have spent {pct_used}% of your budget in {elapsed_pct}% of the month. Slow down to avoid running out."
        elif pace_diff_pct > 5:
            pace_status = "warning"
            pace_headline = "Ahead of Pace"
            pace_message = f"Spending pace ({pct_used}%) is ahead of elapsed days ({elapsed_pct}%)."
        else:
            pace_status = "on_track"
            pace_headline = "Spending on Track"
            pace_message = f"Great pacing! You have used {pct_used}% of your budget with {100 - elapsed_pct:.1f}% of the month remaining."

    # 6. Categories breakdown
    cat_spend = {}
    for e in expenses_data:
        c = e.get("category") or "Other"
        cat_spend[c] = round(cat_spend.get(c, 0.0) + float(e.get("amount") or 0), 2)

    budgeted_cats = []
    budgeted_cat_names = set()
    for b in budgets_data:
        c_name = b["category"]
        limit = float(b["monthly_limit"])
        spent = cat_spend.get(c_name, 0.0)
        rem = round(limit - spent, 2)
        cat_pct = round((spent / limit) * 100, 1) if limit > 0 else 0.0

        if spent > limit:
            cat_status = "danger"
        elif cat_pct >= 80:
            cat_status = "warning"
        else:
            cat_status = "normal"

        budgeted_cats.append({
            "id": b["id"],
            "category": c_name,
            "monthly_limit": limit,
            "spent": spent,
            "remaining": rem,
            "percentage_used": cat_pct,
            "status": cat_status,
        })
        budgeted_cat_names.add(c_name)

    budgeted_cats.sort(key=lambda x: x["percentage_used"], reverse=True)

    unbudgeted_cats = []
    for c_name, spent in cat_spend.items():
        if c_name not in budgeted_cat_names and spent > 0:
            unbudgeted_cats.append({
                "category": c_name,
                "spent": spent,
            })
    unbudgeted_cats.sort(key=lambda x: x["spent"], reverse=True)

    # 7. Monthly Comparison
    prev_total_spent = round(sum(float(e.get("amount") or 0) for e in prev_expenses_data), 2)
    spend_diff = round(total_spent - prev_total_spent, 2)
    spend_diff_pct = round(((total_spent - prev_total_spent) / prev_total_spent) * 100, 1) if prev_total_spent > 0 else 0.0

    prev_cat_spend = {}
    for e in prev_expenses_data:
        c = e.get("category") or "Other"
        prev_cat_spend[c] = round(prev_cat_spend.get(c, 0.0) + float(e.get("amount") or 0), 2)

    all_compare_cats = set(cat_spend.keys()).union(set(prev_cat_spend.keys()))
    category_comparisons = []
    spending_reductions = []

    for c in all_compare_cats:
        curr_c_spent = cat_spend.get(c, 0.0)
        prev_c_spent = prev_cat_spend.get(c, 0.0)
        c_diff = round(curr_c_spent - prev_c_spent, 2)
        c_diff_pct = round(((curr_c_spent - prev_c_spent) / prev_c_spent) * 100, 1) if prev_c_spent > 0 else (100.0 if curr_c_spent > 0 else 0.0)

        comp_item = {
            "category": c,
            "current_spent": curr_c_spent,
            "prev_spent": prev_c_spent,
            "diff": c_diff,
            "pct_change": c_diff_pct,
            "reduced": c_diff < 0,
        }
        category_comparisons.append(comp_item)
        if c_diff < 0 and prev_c_spent > 0:
            spending_reductions.append({
                "category": c,
                "saved_amount": abs(c_diff),
                "pct_change": abs(c_diff_pct),
                "prev_spent": prev_c_spent,
                "current_spent": curr_c_spent,
            })

    category_comparisons.sort(key=lambda x: abs(x["diff"]), reverse=True)
    spending_reductions.sort(key=lambda x: x["saved_amount"], reverse=True)

    # 8. Historical Trends (Last 6 Months) — Batched for instant performance
    min_m_offset = month - 5
    min_y_offset = year
    while min_m_offset <= 0:
        min_m_offset += 12
        min_y_offset -= 1
    window_start_str = f"{min_y_offset}-{min_m_offset:02d}-01"

    all_window_exp_res = (
        supabase_admin.table("expenses")
        .select("amount, expense_date")
        .eq("user_id", user["id"])
        .gte("expense_date", window_start_str)
        .lt("expense_date", end_date_str)
        .execute()
    )
    all_window_expenses = all_window_exp_res.data or []

    all_window_bud_res = (
        supabase_admin.table("budgets")
        .select("monthly_limit, year, month")
        .eq("user_id", user["id"])
        .gte("year", min_y_offset)
        .execute()
    )
    all_window_budgets = all_window_bud_res.data or []

    trend_spend_map = {}
    for exp in all_window_expenses:
        ed = exp.get("expense_date")
        if ed and len(ed) >= 7:
            try:
                y = int(ed[:4])
                m = int(ed[5:7])
                trend_spend_map[(y, m)] = round(trend_spend_map.get((y, m), 0.0) + float(exp.get("amount") or 0), 2)
            except Exception:
                pass

    trend_budget_map = {}
    for b in all_window_budgets:
        y = b.get("year")
        m = b.get("month")
        if y and m:
            trend_budget_map[(y, m)] = round(trend_budget_map.get((y, m), 0.0) + float(b.get("monthly_limit") or 0), 2)

    trends = []
    for i in range(5, -1, -1):
        m_offset = month - i
        y_offset = year
        while m_offset <= 0:
            m_offset += 12
            y_offset -= 1

        m_name = calendar.month_abbr[m_offset] + f" '{str(y_offset)[-2:]}"
        m_spent = trend_spend_map.get((y_offset, m_offset), 0.0)
        m_budget = trend_budget_map.get((y_offset, m_offset), 0.0)
        m_surplus = round(max(0.0, m_budget - m_spent), 2) if m_budget > 0 else 0.0

        trends.append({
            "year": y_offset,
            "month": m_offset,
            "label": m_name,
            "budget": m_budget,
            "spent": m_spent,
            "savings": m_surplus,
        })

    # 9. Savings Insights (Distinguishing Budget Surplus vs Actual Savings)
    savings_insights = []
    budget_surplus = max(0.0, remaining_budget)
    projected_savings = max(0.0, projected_surplus)

    savings_insights.append({
        "type": "surplus_vs_savings",
        "title": "Surplus vs. Actual Savings",
        "budget_surplus": budget_surplus,
        "projected_savings": projected_savings,
        "message": (
            f"You have ₹{budget_surplus:,.2f} in unspent budget allocation. "
            f"At your current pace of ₹{daily_avg_spent:,.2f}/day, your projected month-end savings is ₹{projected_savings:,.2f}."
            if total_budget > 0 else
            "Set category budgets to calculate your surplus and projected savings."
        )
    })

    if safe_daily_spend > 0 and days_remaining > 0:
        savings_insights.append({
            "type": "daily_safe",
            "title": "Daily Spending Guardrail",
            "amount": safe_daily_spend,
            "days_remaining": days_remaining,
            "message": f"To stay within budget, limit spending to ₹{safe_daily_spend:,.2f}/day for the remaining {days_remaining} days."
        })

    discretionary_cats = ["Outing & Eating Out", "Shopping & Electronics", "Clothing & Footwear", "Miscellaneous"]
    discretionary_spend = sum(cat_spend.get(dc, 0.0) for dc in discretionary_cats)
    if discretionary_spend > 0:
        savings_insights.append({
            "type": "discretionary",
            "title": "Discretionary Spending",
            "amount": discretionary_spend,
            "message": f"Flexible spending accounts for ₹{discretionary_spend:,.2f} this month. Trimming 15% here could save ~₹{round(discretionary_spend * 0.15, 2):,.2f}."
        })

    if spending_reductions:
        top_reduction = spending_reductions[0]
        savings_insights.append({
            "type": "reduction_win",
            "title": "Top Spending Cut",
            "category": top_reduction["category"],
            "amount": top_reduction["saved_amount"],
            "message": f"You cut spending on {top_reduction['category']} by ₹{top_reduction['saved_amount']:,.2f} ({top_reduction['pct_change']:.0f}%) compared to last month!"
        })

    return {
        "year": year,
        "month": month,
        "is_current_month": is_current_month,
        "days_in_month": days_in_month,
        "elapsed_days": elapsed_days,
        "days_remaining": days_remaining,
        "elapsed_pct": elapsed_pct,
        "monthly_budget": total_budget,
        "total_spent": total_spent,
        "remaining_budget": remaining_budget,
        "percentage_used": pct_used,
        "is_over_budget": total_spent > total_budget if total_budget > 0 else False,
        "daily_avg_spent": daily_avg_spent,
        "projected_spending": projected_spending,
        "projected_surplus": projected_surplus,
        "safe_daily_spend": safe_daily_spend,
        "pace": {
            "status": pace_status,
            "headline": pace_headline,
            "message": pace_message,
            "diff_pct": pace_diff_pct,
            "elapsed_pct": elapsed_pct,
            "budget_pct": pct_used,
        },
        "category_budgets": budgeted_cats,
        "unbudgeted_categories": unbudgeted_cats,
        "monthly_comparison": {
            "prev_year": prev_year,
            "prev_month": prev_month,
            "prev_total_spent": prev_total_spent,
            "spend_diff": spend_diff,
            "spend_diff_pct": spend_diff_pct,
            "category_comparisons": category_comparisons,
            "spending_reductions": spending_reductions,
        },
        "historical_trends": trends,
        "savings_insights": savings_insights,
    }

@router.get("/api/budgets", response_model=list[BudgetResponse])
def get_budgets(
    request: Request,
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12)
):
    user = request.session.get("user")

    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")

    query = (
        supabase_admin.table("budgets")
        .select("*")
        .eq("user_id", user["id"])
    )

    if year is not None:
        query = query.eq("year", year)

    if month is not None:
        query = query.eq("month", month)

    response = (
        query.order("year", desc=True)
        .order("month", desc=True)
        .execute()
    )

    return response.data

@router.patch("/api/budgets/{id}", response_model=BudgetResponse)
def update_budget(id: int, budget: BudgetUpdate, request: Request):
    user = request.session.get("user")

    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")

    fields = budget.model_dump(exclude_unset=True, mode="json")

    if not fields:
        raise HTTPException(status_code=400, detail="No fields provided")

    response = (
        supabase_admin.table("budgets")
        .update(fields)
        .eq("id", id)
        .eq("user_id", user["id"])
        .execute()
    )

    if not response.data:
        raise HTTPException(status_code=404, detail="Budget not found")

    return response.data[0]

@router.delete("/api/budgets/{id}")
def delete_budget(id: int, request: Request):
    user = request.session.get("user")

    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")

    response = (
        supabase_admin.table("budgets")
        .delete()
        .eq("id", id)
        .eq("user_id", user["id"])
        .execute()
    )

    if not response.data:
        raise HTTPException(status_code=404, detail="Budget not found")

    return {"message": "Budget deleted successfully"}