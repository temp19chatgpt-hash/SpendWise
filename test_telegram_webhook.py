import asyncio
import os
import sys
import json
from unittest.mock import AsyncMock, patch, MagicMock
import httpx
from fastapi.testclient import TestClient

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

from main import app
from database import supabase_admin
from telegram_bot import (
    get_webhook_secret,
    save_pending_expenses,
    claim_pending_expenses_for_saving,
    mark_pending_expenses_confirmed,
    cancel_pending_expenses,
    is_duplicate_update,
)

# Bypass self-signed SSL certs for proxy environments
supabase_admin.postgrest.session = httpx.Client(
    base_url=supabase_admin.postgrest.session.base_url,
    headers=supabase_admin.postgrest.session.headers,
    verify=False,
)


def run_webhook_tests():
    with TestClient(app) as client:
        print("=== STARTING TELEGRAM WEBHOOK & PERSISTENCE TESTS ===")

        secret = get_webhook_secret()
        print(f"Active Webhook Secret: {secret[:12]}...")

        # -------------------------------------------------------------------------
        # Test 1: Secret Token Authentication & Validation
        # -------------------------------------------------------------------------
        print("\n--- Test 1: Secret Token Authentication ---")

        # Missing secret token header
        res_no_token = client.post("/api/telegram/webhook", json={"update_id": 101})
        assert res_no_token.status_code == 403, f"Expected 403, got {res_no_token.status_code}"
        print("Passed: Missing secret token rejected with 403 Forbidden")

        # Invalid secret token header
        res_bad_token = client.post(
            "/api/telegram/webhook",
            json={"update_id": 101},
            headers={"X-Telegram-Bot-Api-Secret-Token": "wrong-secret-token"},
        )
        assert res_bad_token.status_code == 403, f"Expected 403, got {res_bad_token.status_code}"
        print("Passed: Invalid secret token rejected with 403 Forbidden")

        # Valid secret token header
        res_valid = client.post(
            "/api/telegram/webhook",
            json={"update_id": 100001, "message": {"message_id": 1, "date": 1234567890, "chat": {"id": 99999, "type": "private"}, "text": "/start"}},
            headers={"X-Telegram-Bot-Api-Secret-Token": secret},
        )
        assert res_valid.status_code == 200, f"Expected 200, got {res_valid.status_code}"
        assert res_valid.json().get("ok") is True
        print("Passed: Valid secret token accepted with 200 OK")

        # -------------------------------------------------------------------------
        # Test 2: Update Deduplication (Webhook Retries)
        # -------------------------------------------------------------------------
        print("\n--- Test 2: Update Deduplication ---")
        import time
        dup_update_id = int(time.time() * 1000) % 1_000_000_000

        # First time receiving update_id
        res_first = client.post(
            "/api/telegram/webhook",
            json={"update_id": dup_update_id, "message": {"message_id": 2, "date": 1234567890, "chat": {"id": 99999, "type": "private"}, "text": "/start"}},
            headers={"X-Telegram-Bot-Api-Secret-Token": secret},
        )
        assert res_first.status_code == 200
        assert res_first.json().get("ok") is True
        assert not res_first.json().get("duplicate")

        # Second time receiving identical update_id (simulating Telegram retry)
        res_retry = client.post(
            "/api/telegram/webhook",
            json={"update_id": dup_update_id, "message": {"message_id": 2, "date": 1234567890, "chat": {"id": 99999, "type": "private"}, "text": "/start"}},
            headers={"X-Telegram-Bot-Api-Secret-Token": secret},
        )
        assert res_retry.status_code == 200
        assert res_retry.json().get("duplicate") is True
        print(f"Passed: Duplicate update {dup_update_id} identified and skipped safely.")

        # -------------------------------------------------------------------------
        # Test 3: Persistent Pending Expenses & Confirmation
        # -------------------------------------------------------------------------
        print("\n--- Test 3: Persistent Pending Expenses Storage ---")
        async def test_pending_flow():
            test_expenses = [
                {"item": "Pizza Webhook Test", "amount": 350.0, "category": "Outing & Eating Out", "expense_date": "2026-10-27"},
                {"item": "Cold Drink", "amount": 50.0, "category": "Outing & Eating Out", "expense_date": "2026-10-27"},
            ]
            total_amt = 400.0

            # Save pending expenses
            pending_id = await save_pending_expenses(
                user_id=8,
                telegram_user_id=123456789,
                chat_id=987654321,
                expenses=test_expenses,
                total=total_amt,
            )
            print(f"Saved pending expenses with ID: {pending_id}")
            assert pending_id, "Pending ID should not be empty"

            # Claim for saving
            rec, status = await claim_pending_expenses_for_saving(pending_id)
            assert status == "claimed", f"Expected 'claimed', got '{status}'"
            assert rec is not None
            assert rec["total_amount"] == total_amt or float(rec["total_amount"]) == total_amt
            print(f"Successfully claimed pending record: status={status}")

            # Try claiming again immediately (simulating double click on Confirm)
            rec2, status2 = await claim_pending_expenses_for_saving(pending_id)
            assert status2 == "already_saving", f"Expected 'already_saving', got '{status2}'"
            assert rec2 is None
            print("Passed: Concurrent claim prevented (duplicate click safe)")

            # Insert expenses into DB for User 8
            records = [
                {
                    "item": exp["item"],
                    "amount": exp["amount"],
                    "category": exp["category"],
                    "expense_date": exp["expense_date"],
                    "user_id": 8,
                }
                for exp in rec["expenses"]
            ]
            inserted = supabase_admin.table("expenses").insert(records).execute()
            assert inserted.data and len(inserted.data) == 2
            exp_ids = [r["id"] for r in inserted.data]
            print(f"Inserted {len(exp_ids)} expenses into DB: {exp_ids}")

            # Mark confirmed
            await mark_pending_expenses_confirmed(pending_id)

            # Try claiming after confirmation
            rec3, status3 = await claim_pending_expenses_for_saving(pending_id)
            assert status3 == "already_confirmed", f"Expected 'already_confirmed', got '{status3}'"
            print("Passed: Claim after confirmation safely rejected as 'already_confirmed'")

            # Clean up inserted expenses
            for eid in exp_ids:
                supabase_admin.table("expenses").delete().eq("id", eid).execute()
            print("Cleaned up test expenses.")

        asyncio.run(test_pending_flow())

        # -------------------------------------------------------------------------
        # Test 4: Pending Expense Cancellation
        # -------------------------------------------------------------------------
        print("\n--- Test 4: Pending Expense Cancellation ---")
        async def test_cancellation():
            pending_id = await save_pending_expenses(
                user_id=8,
                telegram_user_id=123456789,
                chat_id=987654321,
                expenses=[{"item": "Cancelled Item", "amount": 100.0, "category": "Grocery", "expense_date": "2026-10-27"}],
                total=100.0,
            )
            # Cancel
            cancelled = await cancel_pending_expenses(pending_id)
            assert cancelled is True or pending_id.startswith("mem_")

            # Verify claiming cancelled record fails
            rec, status = await claim_pending_expenses_for_saving(pending_id)
            assert status == "already_cancelled", f"Expected 'already_cancelled', got '{status}'"
            print("Passed: Cancelled pending expense successfully prevented from being saved.")

        asyncio.run(test_cancellation())

        # -------------------------------------------------------------------------
        # Test 5: Webhook Management Endpoints
        # -------------------------------------------------------------------------
        print("\n--- Test 5: Webhook Info Endpoint ---")
        info_res = client.get("/api/telegram/webhook-info")
        assert info_res.status_code == 200, f"Expected 200, got {info_res.status_code}"
        info_json = info_res.json()
        assert info_json.get("ok") is True
        print(f"Webhook status: secret_configured={info_json.get('secret_configured')}")

        print("\n=== ALL TELEGRAM WEBHOOK & PERSISTENCE TESTS PASSED SUCCESSFULLY! ===")


if __name__ == "__main__":
    run_webhook_tests()
