import asyncio
import hashlib
import secrets
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

from database import supabase_admin
from telegram_bot import link_telegram, get_linked_user

# Support proxy/VPN environments with self-signed root certs
supabase_admin.postgrest.session = httpx.Client(
    base_url=supabase_admin.postgrest.session.base_url,
    headers=supabase_admin.postgrest.session.headers,
    verify=False,
)


async def run_tests():
    print("=== STARTING TELEGRAM LINKING TESTS ===")

    # Ensure clean state for user 8
    supabase_admin.table("users").update({"telegram_user_id": None}).eq("id", 8).execute()

    # Scenario 1: Telegram ID already linked to a different SpendWise account
    # In DB: User 3 has telegram_user_id = 1200773893
    # User 8 wants to link with code, but Telegram sender has telegram_id = 1200773893
    print("\n--- Test 1: Telegram account already linked to another SpendWise account ---")
    # Generate a fresh linking code for User 8
    code_raw = secrets.token_hex(16)
    code_hash = hashlib.sha256(code_raw.encode("utf-8")).hexdigest()
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
    code_record = supabase_admin.table("telegram_link_codes").insert({
        "user_id": 8,
        "code_hash": code_hash,
        "expires_at": expires_at,
    }).execute()
    code_id = code_record.data[0]["id"]

    # Mock Update and Context for Telegram User 1200773893 (already linked to User 3)
    update = MagicMock()
    update.effective_user.id = 1200773893
    update.message = MagicMock()
    update.message.reply_text = AsyncMock()
    context = MagicMock()
    context.args = [code_raw]

    await link_telegram(update, context)

    # Check response
    reply = update.message.reply_text.call_args[0][0]
    print(f"Reply: {reply}")
    assert "already linked to another SpendWise account" in reply, f"Unexpected reply: {reply}"

    # Verify code was NOT consumed
    check_code = supabase_admin.table("telegram_link_codes").select("*").eq("id", code_id).execute()
    assert check_code.data[0]["used_at"] is None, "Linking code should NOT be consumed!"
    print("Passed: Code was NOT consumed, and request was rejected clearly.")

    # Verify User 3's association was NOT overwritten
    u3 = supabase_admin.table("users").select("telegram_user_id").eq("id", 3).execute()
    assert u3.data[0]["telegram_user_id"] == 1200773893, "User 3 association was modified!"
    # Verify User 8 was NOT linked
    u8 = supabase_admin.table("users").select("telegram_user_id").eq("id", 8).execute()
    assert u8.data[0]["telegram_user_id"] is None, "User 8 should remain unlinked!"
    print("Passed: Associations preserved without overwriting.")

    # Scenario 2: Telegram ID already linked to the SAME account
    print("\n--- Test 2: Telegram account already linked to the SAME SpendWise account ---")
    # Generate a fresh code for User 3 (who is already linked to 1200773893)
    code_raw_same = secrets.token_hex(16)
    code_hash_same = hashlib.sha256(code_raw_same.encode("utf-8")).hexdigest()
    code_record_same = supabase_admin.table("telegram_link_codes").insert({
        "user_id": 3,
        "code_hash": code_hash_same,
        "expires_at": expires_at,
    }).execute()
    code_id_same = code_record_same.data[0]["id"]

    update_same = MagicMock()
    update_same.effective_user.id = 1200773893
    update_same.message = MagicMock()
    update_same.message.reply_text = AsyncMock()
    context_same = MagicMock()
    context_same.args = [code_raw_same]

    await link_telegram(update_same, context_same)

    reply_same = update_same.message.reply_text.call_args[0][0]
    print(f"Reply: {reply_same}")
    assert "already linked to this SpendWise account" in reply_same, f"Unexpected reply: {reply_same}"

    # Verify code was NOT consumed
    check_code_same = supabase_admin.table("telegram_link_codes").select("*").eq("id", code_id_same).execute()
    assert check_code_same.data[0]["used_at"] is None, "Linking code should NOT be consumed for already linked account!"
    print("Passed: Handled gracefully and code was not consumed.")

    # Clean up test codes
    supabase_admin.table("telegram_link_codes").delete().in_("id", [code_id, code_id_same]).execute()

    # Scenario 3: Invalid linking code
    print("\n--- Test 3: Invalid linking code ---")
    update_inv = MagicMock()
    update_inv.effective_user.id = 999999999
    update_inv.message = MagicMock()
    update_inv.message.reply_text = AsyncMock()
    context_inv = MagicMock()
    context_inv.args = ["nonexistent_code_xyz"]

    await link_telegram(update_inv, context_inv)
    reply_inv = update_inv.message.reply_text.call_args[0][0]
    print(f"Reply: {reply_inv}")
    assert "Invalid linking code" in reply_inv

    # Scenario 4: Expired code
    print("\n--- Test 4: Expired linking code ---")
    exp_raw = secrets.token_hex(16)
    exp_hash = hashlib.sha256(exp_raw.encode("utf-8")).hexdigest()
    past_time = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    exp_record = supabase_admin.table("telegram_link_codes").insert({
        "user_id": 8,
        "code_hash": exp_hash,
        "expires_at": past_time,
    }).execute()
    exp_id = exp_record.data[0]["id"]

    update_exp = MagicMock()
    update_exp.effective_user.id = 999999999
    update_exp.message = MagicMock()
    update_exp.message.reply_text = AsyncMock()
    context_exp = MagicMock()
    context_exp.args = [exp_raw]

    await link_telegram(update_exp, context_exp)
    reply_exp = update_exp.message.reply_text.call_args[0][0]
    print(f"Reply: {reply_exp}")
    assert "code has expired" in reply_exp

    supabase_admin.table("telegram_link_codes").delete().eq("id", exp_id).execute()

    # Scenario 5: Already used code
    print("\n--- Test 5: Already used linking code ---")
    used_raw = secrets.token_hex(16)
    used_hash = hashlib.sha256(used_raw.encode("utf-8")).hexdigest()
    used_record = supabase_admin.table("telegram_link_codes").insert({
        "user_id": 8,
        "code_hash": used_hash,
        "expires_at": expires_at,
        "used_at": datetime.now(timezone.utc).isoformat(),
    }).execute()
    used_id = used_record.data[0]["id"]

    update_used = MagicMock()
    update_used.effective_user.id = 999999999
    update_used.message = MagicMock()
    update_used.message.reply_text = AsyncMock()
    context_used = MagicMock()
    context_used.args = [used_raw]

    await link_telegram(update_used, context_used)
    reply_used = update_used.message.reply_text.call_args[0][0]
    print(f"Reply: {reply_used}")
    assert "already been used" in reply_used

    supabase_admin.table("telegram_link_codes").delete().eq("id", used_id).execute()

    # Scenario 6: Database uniqueness violation simulation (e.g. concurrent linking race)
    print("\n--- Test 6: Database uniqueness violation handling ---")
    race_raw = secrets.token_hex(16)
    race_hash = hashlib.sha256(race_raw.encode("utf-8")).hexdigest()
    race_record = supabase_admin.table("telegram_link_codes").insert({
        "user_id": 8,
        "code_hash": race_hash,
        "expires_at": expires_at,
    }).execute()
    race_id = race_record.data[0]["id"]

    # Mock an APIError with 23505 when updating users
    from postgrest.exceptions import APIError
    api_error = APIError({
        "message": 'duplicate key value violates unique constraint "users_telegram_user_id_key"',
        "code": "23505",
        "details": "Key (telegram_user_id)=(888888888) already exists.",
        "hint": None
    })

    update_race = MagicMock()
    update_race.effective_user.id = 888888888
    update_race.message = MagicMock()
    update_race.message.reply_text = AsyncMock()
    context_race = MagicMock()
    context_race.args = [race_raw]

    orig_table = supabase_admin.table
    def custom_table(table_name):
        tbl = orig_table(table_name)
        if table_name == "users":
            orig_update = tbl.update
            def custom_update(*args, **kwargs):
                builder = orig_update(*args, **kwargs)
                orig_execute = builder.execute
                def custom_execute(*e_args, **e_kwargs):
                    raise api_error
                builder.execute = custom_execute
                return builder
            tbl.update = custom_update
        return tbl

    with patch.object(supabase_admin, "table", side_effect=custom_table):
        await link_telegram(update_race, context_race)

    reply_race = update_race.message.reply_text.call_args[0][0]
    print(f"Reply: {reply_race}")
    assert "already linked to another SpendWise account" in reply_race

    # Verify code was NOT consumed
    check_race_code = supabase_admin.table("telegram_link_codes").select("*").eq("id", race_id).execute()
    assert check_race_code.data[0]["used_at"] is None, "Code must NOT be consumed on uniqueness violation!"
    print("Passed: Database uniqueness violation handled gracefully and code preserved.")
    supabase_admin.table("telegram_link_codes").delete().eq("id", race_id).execute()

    # Scenario 7: Full successful link & code consumed afterwards
    print("\n--- Test 7: Successful linking & code consumption ---")
    succ_raw = secrets.token_hex(16)
    succ_hash = hashlib.sha256(succ_raw.encode("utf-8")).hexdigest()
    succ_record = supabase_admin.table("telegram_link_codes").insert({
        "user_id": 8,
        "code_hash": succ_hash,
        "expires_at": expires_at,
    }).execute()
    succ_id = succ_record.data[0]["id"]

    temp_telegram_id = 777123456
    update_succ = MagicMock()
    update_succ.effective_user.id = temp_telegram_id
    update_succ.message = MagicMock()
    update_succ.message.reply_text = AsyncMock()
    context_succ = MagicMock()
    context_succ.args = [succ_raw]

    await link_telegram(update_succ, context_succ)
    reply_succ = update_succ.message.reply_text.call_args[0][0]
    print(f"Reply: {reply_succ}")
    assert "✅ Your Telegram account is linked to SpendWise!" in reply_succ

    # Verify User 8 now has temp_telegram_id
    u8_after = supabase_admin.table("users").select("telegram_user_id").eq("id", 8).execute()
    assert u8_after.data[0]["telegram_user_id"] == temp_telegram_id, "User 8 should now be linked!"

    # Verify code IS now consumed
    check_succ_code = supabase_admin.table("telegram_link_codes").select("*").eq("id", succ_id).execute()
    assert check_succ_code.data[0]["used_at"] is not None, "Code should be consumed after successful link!"

    # Verify get_linked_user finds User 8
    found_user = await get_linked_user(temp_telegram_id)
    assert found_user is not None and found_user["id"] == 8, "get_linked_user should return User 8!"

    # Clean up User 8 link and test code
    supabase_admin.table("users").update({"telegram_user_id": None}).eq("id", 8).execute()
    # Scenario 8: Concurrent linking with same code (race condition)
    print("\n--- Test 8: Concurrent linking attempts with same code ---")
    race2_raw = secrets.token_hex(16)
    race2_hash = hashlib.sha256(race2_raw.encode("utf-8")).hexdigest()
    race2_record = supabase_admin.table("telegram_link_codes").insert({
        "user_id": 8,
        "code_hash": race2_hash,
        "expires_at": expires_at,
    }).execute()
    race2_id = race2_record.data[0]["id"]

    temp_tel_1 = 555000111
    u_race1 = MagicMock()
    u_race1.effective_user.id = temp_tel_1
    u_race1.message = MagicMock()
    u_race1.message.reply_text = AsyncMock()
    c_race1 = MagicMock()
    c_race1.args = [race2_raw]

    temp_tel_2 = 555000222
    u_race2 = MagicMock()
    u_race2.effective_user.id = temp_tel_2
    u_race2.message = MagicMock()
    u_race2.message.reply_text = AsyncMock()
    c_race2 = MagicMock()
    c_race2.args = [race2_raw]

    # Run both concurrently
    results = await asyncio.gather(
        link_telegram(u_race1, c_race1),
        link_telegram(u_race2, c_race2),
        return_exceptions=True
    )

    r1 = u_race1.message.reply_text.call_args[0][0]
    r2 = u_race2.message.reply_text.call_args[0][0]
    print(f"Concurrent reply 1: {r1}")
    print(f"Concurrent reply 2: {r2}")

    # Exactly one must have succeeded
    successes = sum(1 for r in [r1, r2] if "✅ Your Telegram account is linked to SpendWise!" in r)
    assert successes == 1, f"Expected exactly 1 success in concurrent attempt, got {successes}"

    # Verify code was consumed
    check_race2 = supabase_admin.table("telegram_link_codes").select("*").eq("id", race2_id).execute()
    assert check_race2.data[0]["used_at"] is not None

    # Clean up
    supabase_admin.table("users").update({"telegram_user_id": None}).eq("id", 8).execute()
    supabase_admin.table("telegram_link_codes").delete().eq("id", race2_id).execute()
    print("Passed: Concurrent race handled atomically. Exactly 1 succeeded, loser safely rejected.")

    print("\n=== ALL SCENARIOS PASSED SUCCESSFULLY! ===")


if __name__ == "__main__":
    asyncio.run(run_tests())
