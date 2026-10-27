import sys
import calendar
from datetime import date

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

import httpx
from database import supabase_admin
supabase_admin.postgrest.session = httpx.Client(
    base_url=supabase_admin.postgrest.session.base_url,
    headers=supabase_admin.postgrest.session.headers,
    verify=False,
)

from fastapi import HTTPException
from models import BudgetCreate, BudgetUpdate
from routers.expenses import (
    create_budget,
    get_budgets,
    update_budget,
    delete_budget,
    get_budget_summary,
)


class MockSessionRequest:
    def __init__(self, user_id=None):
        self.session = {"user": {"id": user_id}} if user_id is not None else {}


def run_tests():
    print("=== STARTING BUDGET & SAVINGS FEATURE TESTS ===")

    # 1. Test Authorization Checks
    print("\n--- Test 1: Authorization Checks ---")
    unauth_req = MockSessionRequest(user_id=None)
    try:
        get_budget_summary(unauth_req, year=2026, month=10)
        assert False, "Should raise 401 for unauthenticated request"
    except HTTPException as e:
        assert e.status_code == 401
        print("Passed: 401 on unauthenticated get_budget_summary")

    try:
        create_budget(BudgetCreate(category="Grocery", monthly_limit=5000.0, year=2026, month=10), unauth_req)
        assert False, "Should raise 401 on unauthenticated create_budget"
    except HTTPException as e:
        assert e.status_code == 401
        print("Passed: 401 on unauthenticated create_budget")

    # 2. Test Zero Budgets / Empty State
    print("\n--- Test 2: Empty / Zero Budgets State ---")
    # Using User 8 (who has no budgets set)
    user8_req = MockSessionRequest(user_id=8)
    summary8 = get_budget_summary(user8_req, year=2026, month=10)
    assert summary8["monthly_budget"] == 0, f"Expected 0 budget, got {summary8['monthly_budget']}"
    assert summary8["pace"]["status"] == "no_budget"
    assert len(summary8["category_budgets"]) == 0
    assert len(summary8["historical_trends"]) == 6
    print(f"Passed: Zero budgets handled gracefully. Pace headline: '{summary8['pace']['headline']}'")

    # 3. Test Budget Creation & Upsert Handling
    print("\n--- Test 3: Budget Creation and Upsert ---")
    # Clean any leftover test budgets for User 8
    supabase_admin.table("budgets").delete().eq("user_id", 8).execute()

    b1 = create_budget(
        BudgetCreate(category="Grocery", monthly_limit=3000.0, year=2026, month=10),
        user8_req
    )
    assert b1["monthly_limit"] == 3000.0
    print(f"Created budget id={b1['id']}, limit={b1['monthly_limit']}")

    # Upsert with new limit
    b1_updated = create_budget(
        BudgetCreate(category="Grocery", monthly_limit=4500.0, year=2026, month=10),
        user8_req
    )
    assert b1_updated["monthly_limit"] == 4500.0
    print(f"Upserted budget id={b1_updated['id']}, updated limit={b1_updated['monthly_limit']}")

    # Create second category budget
    b2 = create_budget(
        BudgetCreate(category="Transport", monthly_limit=2000.0, year=2026, month=10),
        user8_req
    )
    assert b2["monthly_limit"] == 2000.0
    print(f"Created second budget id={b2['id']}, limit={b2['monthly_limit']}")

    # 4. Test List and Update
    print("\n--- Test 4: List and Update Budgets ---")
    budgets_list = get_budgets(user8_req, year=2026, month=10)
    assert len(budgets_list) == 2, f"Expected 2 budgets, got {len(budgets_list)}"
    print(f"Listed {len(budgets_list)} budgets for Oct 2026")

    # Patch b2
    patched = update_budget(b2["id"], BudgetUpdate(monthly_limit=2500.0), user8_req)
    assert patched["monthly_limit"] == 2500.0
    print(f"Patched budget limit to {patched['monthly_limit']}")

    # 5. Test Calculations with Real Expenses & Budgets
    print("\n--- Test 5: Summary Calculations & Pace Metrics ---")
    # Add a temporary test expense for User 8 in Oct 2026
    exp_res = supabase_admin.table("expenses").insert({
        "user_id": 8,
        "item": "Test Supermarket",
        "amount": 1800.0,
        "category": "Grocery",
        "expense_date": "2026-10-15"
    }).execute()
    exp_id = exp_res.data[0]["id"]

    summary = get_budget_summary(user8_req, year=2026, month=10)
    # Total budget = 4500 (Grocery) + 2500 (Transport) = 7000.0
    assert summary["monthly_budget"] == 7000.0, f"Expected 7000.0, got {summary['monthly_budget']}"
    assert summary["total_spent"] >= 1800.0, f"Expected >= 1800.0, got {summary['total_spent']}"
    assert summary["remaining_budget"] == round(7000.0 - summary["total_spent"], 2)
    assert summary["percentage_used"] == round((summary["total_spent"] / 7000.0) * 100, 1)
    assert summary["days_in_month"] == 31
    assert summary["elapsed_days"] > 0
    assert summary["projected_spending"] > 0
    print(f"Total Budget: {summary['monthly_budget']}")
    print(f"Total Spent: {summary['total_spent']}")
    print(f"Remaining: {summary['remaining_budget']}")
    print(f"Usage: {summary['percentage_used']}%")
    print(f"Projected Spend: {summary['projected_spending']}")
    print(f"Projected Surplus: {summary['projected_surplus']}")
    print(f"Pace Status: {summary['pace']['status']} ({summary['pace']['headline']})")

    # Verify category budget details
    grocery_item = next((c for c in summary["category_budgets"] if c["category"] == "Grocery"), None)
    assert grocery_item is not None
    assert grocery_item["monthly_limit"] == 4500.0
    assert grocery_item["spent"] >= 1800.0
    assert grocery_item["remaining"] == round(4500.0 - grocery_item["spent"], 2)
    assert grocery_item["percentage_used"] > 0
    print(f"Grocery category: spent={grocery_item['spent']}, limit={grocery_item['monthly_limit']}, status={grocery_item['status']}")

    # Verify Savings Insights
    insights = summary["savings_insights"]
    assert len(insights) >= 1
    surplus_insight = next((i for i in insights if i["type"] == "surplus_vs_savings"), None)
    assert surplus_insight is not None
    assert surplus_insight["budget_surplus"] >= 0
    print(f"Surplus vs Savings insight: {surplus_insight['message']}")

    # 6. Test Historical Trends
    print("\n--- Test 6: Historical Trends (6 Months) ---")
    trends = summary["historical_trends"]
    assert len(trends) == 6
    for t in trends:
        assert "year" in t and "month" in t and "label" in t and "budget" in t and "spent" in t
    print(f"Trends: {[t['label'] for t in trends]}")

    # 7. Test Future Month (elapsed_days = 0)
    print("\n--- Test 7: Future Month Handling ---")
    future_summary = get_budget_summary(user8_req, year=2026, month=12)
    assert future_summary["is_current_month"] is False
    assert future_summary["elapsed_days"] == 0
    assert future_summary["days_remaining"] == 31
    print("Passed: Future month elapsed_days is 0 and days_remaining is full month")

    # 8. Test Delete Budget
    print("\n--- Test 8: Delete Budget ---")
    del_res = delete_budget(b1["id"], user8_req)
    assert del_res["message"] == "Budget deleted successfully"
    # Verify it is deleted
    remaining_budgets = get_budgets(user8_req, year=2026, month=10)
    assert len(remaining_budgets) == 1
    print(f"Deleted budget {b1['id']}. Remaining budgets: {len(remaining_budgets)}")

    # Clean up test expense and remaining test budget
    supabase_admin.table("expenses").delete().eq("id", exp_id).execute()
    supabase_admin.table("budgets").delete().eq("id", b2["id"]).execute()
    print("Cleaned up test records for user 8.")

    print("\n=== ALL BUDGET & SAVINGS TESTS PASSED SUCCESSFULLY! ===")


if __name__ == "__main__":
    run_tests()
