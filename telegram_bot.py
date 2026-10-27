import os
import hashlib
import logging
import secrets
from datetime import datetime, timezone
from database import supabase_admin
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    ContextTypes,
    filters,
)
from telegram.request import HTTPXRequest
from gemini_parser import parse_with_gemini

load_dotenv()

logger = logging.getLogger("spendwise.telegram")
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

# In-memory storage fallback for pending expenses and processed update deduplication
_in_memory_pending: dict[str, dict] = {}
_recent_update_ids: set[int] = set()

# Application singleton instance
_bot_app_instance: Application | None = None


# ==============================================================================
# Persistent Pending Expenses Storage (Supabase + In-Memory Fallback)
# Ensures pending expenses survive Render free-tier sleep & server restarts
# ==============================================================================

async def save_pending_expenses(
    user_id: int,
    telegram_user_id: int,
    chat_id: int,
    expenses: list[dict],
    total: float,
) -> str:
    """Save pending expenses to Supabase. Falls back to in-memory store if the table
    is not yet created in Supabase."""
    try:
        res = (
            supabase_admin.table("telegram_pending_expenses")
            .insert({
                "user_id": user_id,
                "telegram_user_id": telegram_user_id,
                "chat_id": chat_id,
                "expenses": expenses,
                "total_amount": total,
                "status": "pending",
            })
            .execute()
        )
        if res.data and len(res.data) > 0:
            return str(res.data[0]["id"])
    except Exception as e:
        logger.warning(
            "Could not persist pending expense to Supabase (using in-memory fallback): %s",
            e,
        )

    # In-memory fallback
    key = f"mem_{secrets.token_hex(8)}"
    _in_memory_pending[key] = {
        "user_id": user_id,
        "telegram_user_id": telegram_user_id,
        "chat_id": chat_id,
        "expenses": expenses,
        "total_amount": total,
        "status": "pending",
        "created_at": datetime.now(timezone.utc),
    }
    return key


async def claim_pending_expenses_for_saving(
    pending_id_str: str,
    user_id: int | None = None,
    telegram_user_id: int | None = None,
) -> tuple[dict | None, str]:
    """Atomically transition status from 'pending' to 'saving'.
    Returns (record, status_msg). Prevents duplicate confirmation clicks."""
    if pending_id_str.startswith("mem_"):
        rec = _in_memory_pending.get(pending_id_str)
        if not rec:
            return None, "not_found"
        if rec["status"] == "confirmed":
            return None, "already_confirmed"
        if rec["status"] == "cancelled":
            return None, "already_cancelled"
        if rec["status"] == "saving":
            return None, "already_saving"
        rec["status"] = "saving"
        return rec, "claimed"

    try:
        pending_id = int(pending_id_str)
    except ValueError:
        return None, "not_found"

    try:
        # Atomic update: only succeeds if status is currently 'pending'
        res = (
            supabase_admin.table("telegram_pending_expenses")
            .update({"status": "saving"})
            .eq("id", pending_id)
            .eq("status", "pending")
            .execute()
        )
        if res.data and len(res.data) > 0:
            return res.data[0], "claimed"

        # Not claimed: inspect current state
        curr = (
            supabase_admin.table("telegram_pending_expenses")
            .select("*")
            .eq("id", pending_id)
            .limit(1)
            .execute()
        )
        if not curr.data:
            return None, "not_found"
        st = curr.data[0].get("status")
        if st == "confirmed":
            return None, "already_confirmed"
        if st == "cancelled":
            return None, "already_cancelled"
        if st == "saving":
            return None, "already_saving"
        return None, "expired"
    except Exception as e:
        logger.error("Error claiming pending expenses from Supabase: %s", e)
        rec = _in_memory_pending.get(pending_id_str)
        if rec and rec["status"] == "pending":
            rec["status"] = "saving"
            return rec, "claimed"
        return None, "not_found"


async def mark_pending_expenses_confirmed(pending_id_str: str):
    """Mark a pending expense batch as confirmed after successful database insertion."""
    if pending_id_str.startswith("mem_"):
        if pending_id_str in _in_memory_pending:
            _in_memory_pending[pending_id_str]["status"] = "confirmed"
        return
    try:
        pending_id = int(pending_id_str)
        supabase_admin.table("telegram_pending_expenses").update(
            {"status": "confirmed"}
        ).eq("id", pending_id).execute()
    except Exception as e:
        logger.warning("Failed to mark pending expense confirmed in Supabase: %s", e)


async def cancel_pending_expenses(pending_id_str: str) -> bool:
    """Mark a pending expense batch as cancelled."""
    if pending_id_str.startswith("mem_"):
        if pending_id_str in _in_memory_pending:
            _in_memory_pending[pending_id_str]["status"] = "cancelled"
            return True
        return False
    try:
        pending_id = int(pending_id_str)
        res = (
            supabase_admin.table("telegram_pending_expenses")
            .update({"status": "cancelled"})
            .eq("id", pending_id)
            .eq("status", "pending")
            .execute()
        )
        return bool(res.data)
    except Exception as e:
        logger.warning("Failed to cancel pending expense in Supabase: %s", e)
        return False


async def revert_pending_expenses_status(pending_id_str: str):
    """Revert status back to 'pending' if insertion failed."""
    if pending_id_str.startswith("mem_"):
        if pending_id_str in _in_memory_pending:
            _in_memory_pending[pending_id_str]["status"] = "pending"
        return
    try:
        pending_id = int(pending_id_str)
        supabase_admin.table("telegram_pending_expenses").update(
            {"status": "pending"}
        ).eq("id", pending_id).eq("status", "saving").execute()
    except Exception as e:
        logger.warning("Failed to revert pending expense status in Supabase: %s", e)


# ==============================================================================
# Telegram Update Deduplication (Webhook Retries)
# ==============================================================================

def is_duplicate_update(update_id: int | None) -> bool:
    """Check if update_id was already processed to prevent duplicate executions
    when Telegram retries webhooks on network timeouts."""
    if not update_id:
        return False
    if update_id in _recent_update_ids:
        return True

    try:
        supabase_admin.table("telegram_processed_updates").insert({"update_id": update_id}).execute()
        _recent_update_ids.add(update_id)
        if len(_recent_update_ids) > 10000:
            _recent_update_ids.clear()
        return False
    except Exception as e:
        err_str = str(e)
        if "23505" in err_str or "duplicate" in err_str.lower() or "unique" in err_str.lower():
            _recent_update_ids.add(update_id)
            return True
        # If table does not exist or transient network glitch, keep in memory set
        _recent_update_ids.add(update_id)
        if len(_recent_update_ids) > 10000:
            _recent_update_ids.clear()
        return False


# ==============================================================================
# Telegram Bot Core Handlers
# ==============================================================================

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 Welcome to SpendWise!\n\n"
        "🔗 First, connect your account:\n"
        "1. Sign in to SpendWise with Google.\n"
        "2. Generate a linking code.\n"
        "3. Send /link YOUR_CODE here.\n\n"
        "Example: /link abc123xyz\n\n"
        "Once connected, send your expenses to get started!"
    )


async def get_linked_user(telegram_id: int):
    result = (
        supabase_admin.table("users")
        .select("id")
        .eq("telegram_user_id", telegram_id)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    telegram_user = update.effective_user

    if not telegram_user or not update.message:
        return

    try:
        user = await get_linked_user(telegram_user.id)
    except Exception:
        await update.message.reply_text(
            "SpendWise is temporarily unavailable. Please try again later."
        )
        return

    if not user:
        await update.message.reply_text(
            "Your Telegram account isn't connected yet.\n\n"
            "Sign in to SpendWise and send /link YOUR_CODE here."
        )
        return

    message = update.message.text

    await update.message.reply_text(
        "Processing your expenses. Please wait..."
    )

    try:
        expenses = await parse_with_gemini(message)
    except ValueError as e:
        await update.message.reply_text(f"⚠️ {e}")
        return
    except Exception:
        await update.message.reply_text(
            "Gemini is temporarily unavailable. Please try again later."
        )
        return

    if not expenses:
        await update.message.reply_text(
            "I couldn't find any expenses.\n\n"
            "Try this format:\n\n"
            "20 Oct:\n"
            "Tea 20\n"
            "Lunch 150"
        )
        return

    total = sum(expense["amount"] for expense in expenses)

    preview = "Expense preview:\n\n"
    for expense in expenses:
        preview += (
            f"{expense['expense_date']} | "
            f"{expense['item']} | "
            f"{expense['category']} | "
            f"₹{expense['amount']:.2f}\n"
        )
    preview += f"\nTotal: ₹{total:.2f}"

    # Persist pending expenses to Supabase (survives Render sleeps and restarts)
    pending_id = await save_pending_expenses(
        user_id=user["id"],
        telegram_user_id=telegram_user.id,
        chat_id=update.effective_chat.id,
        expenses=expenses,
        total=total,
    )

    # Also keep in context user_data for backward compatibility
    if hasattr(context, "user_data") and context.user_data is not None:
        context.user_data["pending_expenses"] = expenses
        context.user_data["pending_id"] = pending_id

    keyboard = [
        [
            InlineKeyboardButton("✅ Confirm", callback_data=f"confirm:{pending_id}"),
            InlineKeyboardButton("❌ Cancel", callback_data=f"cancel:{pending_id}"),
        ]
    ]

    reply_markup = InlineKeyboardMarkup(keyboard)

    await update.message.reply_text(
        preview,
        reply_markup=reply_markup,
    )


async def handle_confirmation(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    query = update.callback_query
    if not query or not update.effective_user:
        return

    callback_data = query.data or ""
    action, _, pending_id_str = callback_data.partition(":")

    # Handle Cancellation
    if action == "cancel":
        if pending_id_str:
            await cancel_pending_expenses(pending_id_str)
        if hasattr(context, "user_data") and context.user_data is not None:
            context.user_data.pop("pending_expenses", None)
            context.user_data.pop("confirmation_status", None)
            context.user_data.pop("pending_id", None)

        await query.answer()
        await query.edit_message_text("❌ Expense entry cancelled.")
        return

    # Handle Confirmation
    if action != "confirm":
        await query.answer()
        return

    # 1. If we have a pending_id_str from the callback_data
    if pending_id_str:
        rec, status_result = await claim_pending_expenses_for_saving(
            pending_id_str,
            telegram_user_id=update.effective_user.id,
        )

        if status_result == "already_confirmed":
            await query.answer("These expenses were already saved.")
            await query.edit_message_text("✅ These expenses were already saved.")
            return

        if status_result == "already_cancelled":
            await query.answer("This entry was cancelled.")
            await query.edit_message_text("❌ Expense entry cancelled.")
            return

        if status_result == "already_saving":
            await query.answer("Your expenses are being saved.")
            return

        if status_result != "claimed" or not rec:
            await query.answer()
            await query.edit_message_text(
                "This preview has expired or was already handled. "
                "Please send your expenses again."
            )
            return

        pending_expenses = rec["expenses"]
        user_id = rec["user_id"]

    else:
        # Fallback to in-memory context user_data for legacy messages
        pending_expenses = context.user_data.get("pending_expenses") if hasattr(context, "user_data") else None
        if not pending_expenses:
            await query.answer()
            await query.edit_message_text(
                "This preview has expired or was already handled. "
                "Please send your expenses again."
            )
            return

        if context.user_data.get("confirmation_status") == "saving":
            await query.answer("Your expenses are being saved.")
            return

        context.user_data["confirmation_status"] = "saving"
        try:
            user = await get_linked_user(update.effective_user.id)
            user_id = user["id"] if user else None
        except Exception:
            user_id = None

        if not user_id:
            context.user_data.pop("confirmation_status", None)
            await query.edit_message_text(
                "Your Telegram account isn't linked to SpendWise. "
                "Please connect it first."
            )
            return

    await query.answer()

    # Insert into Supabase expenses table
    try:
        records = [
            {
                "item": expense["item"],
                "amount": expense["amount"],
                "category": expense["category"],
                "expense_date": expense["expense_date"],
                "user_id": user_id,
            }
            for expense in pending_expenses
        ]

        response = supabase_admin.table("expenses").insert(records).execute()

        if response.data is None or len(response.data) != len(records):
            raise RuntimeError("Not all expenses were saved.")

        total = sum(expense["amount"] for expense in pending_expenses)
        count = len(pending_expenses)

        # Mark confirmed in persistent store
        if pending_id_str:
            await mark_pending_expenses_confirmed(pending_id_str)

        if hasattr(context, "user_data") and context.user_data is not None:
            context.user_data.pop("pending_expenses", None)
            context.user_data.pop("confirmation_status", None)
            context.user_data.pop("pending_id", None)

        await query.edit_message_text(
            f"✅ Successfully saved {count} expense(s)!\n\n"
            f"Total: ₹{total:.2f}"
        )

    except Exception as e:
        logger.error("Failed to save confirmed expenses: %s", e)
        if pending_id_str:
            await revert_pending_expenses_status(pending_id_str)

        if hasattr(context, "user_data") and context.user_data is not None:
            context.user_data.pop("confirmation_status", None)

        await query.edit_message_text(
            "⚠️ Couldn't confirm that your expenses were saved. "
            "Please check your SpendWise expenses before retrying."
        )


async def link_telegram(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    if not update.effective_user or not update.message:
        return

    if not context.args or len(context.args) != 1:
        await update.message.reply_text(
            "Please send your linking code like this:\n"
            "/link YOUR_CODE"
        )
        return

    code = context.args[0].strip()
    code_hash = hashlib.sha256(code.encode("utf-8")).hexdigest()
    telegram_id = update.effective_user.id

    try:
        # 1. Fetch linking code from Supabase
        result = (
            supabase_admin.table("telegram_link_codes")
            .select("*")
            .eq("code_hash", code_hash)
            .limit(1)
            .execute()
        )

        if not result.data:
            await update.message.reply_text(
                "Invalid linking code. Generate a new one on SpendWise."
            )
            return

        link = result.data[0]

        # 2. Check if the code was already used
        if link.get("used_at") is not None or link.get("used") is True:
            await update.message.reply_text(
                "This code has already been used. Generate a new one."
            )
            return

        # 3. Check if the code has expired
        expires_at = datetime.fromisoformat(
            link["expires_at"].replace("Z", "+00:00")
        )

        if expires_at <= datetime.now(timezone.utc):
            await update.message.reply_text(
                "This code has expired. Generate a new one on SpendWise."
            )
            return

        user_id = link["user_id"]

        # 4. Fetch the SpendWise account associated with this linking code
        user_result = (
            supabase_admin.table("users")
            .select("id, telegram_user_id")
            .eq("id", user_id)
            .limit(1)
            .execute()
        )

        if not user_result.data:
            await update.message.reply_text(
                "SpendWise account not found. Please try again."
            )
            return

        target_user = user_result.data[0]
        target_telegram_id = target_user.get("telegram_user_id")

        # 5. Check if this SpendWise account is already linked to another Telegram account
        if target_telegram_id is not None and target_telegram_id != telegram_id:
            await update.message.reply_text(
                "This SpendWise account is already linked to another Telegram account. Disconnect it first."
            )
            return

        # 6. Check whether the Telegram ID is already associated with any user in Supabase
        existing_owner_res = (
            supabase_admin.table("users")
            .select("id")
            .eq("telegram_user_id", telegram_id)
            .limit(1)
            .execute()
        )

        if existing_owner_res.data:
            existing_owner_id = existing_owner_res.data[0]["id"]
            if existing_owner_id == user_id:
                await update.message.reply_text(
                    "Your Telegram account is already linked to this SpendWise account."
                )
                return
            else:
                await update.message.reply_text(
                    "This Telegram account is already linked to another SpendWise account. "
                    "Disconnect it from that account first before linking."
                )
                return

        # 7. Attempt to link the Telegram ID to the SpendWise user.
        try:
            update_user_res = (
                supabase_admin.table("users")
                .update({"telegram_user_id": telegram_id})
                .eq("id", user_id)
                .is_("telegram_user_id", "null")
                .execute()
            )
        except Exception as e:
            err_str = str(e)
            is_unique_violation = (
                getattr(e, "code", None) == "23505"
                or "23505" in err_str
                or "users_telegram_user_id_key" in err_str
                or "duplicate key" in err_str.lower()
            )
            if is_unique_violation:
                try:
                    curr_check = (
                        supabase_admin.table("users")
                        .select("id")
                        .eq("telegram_user_id", telegram_id)
                        .limit(1)
                        .execute()
                    )
                    if curr_check.data and curr_check.data[0]["id"] == user_id:
                        await update.message.reply_text(
                            "Your Telegram account is already linked to this SpendWise account."
                        )
                        return
                except Exception:
                    pass

                await update.message.reply_text(
                    "This Telegram account is already linked to another SpendWise account. "
                    "Disconnect it from that account first before linking."
                )
                return
            raise

        if not update_user_res.data:
            fresh_user = (
                supabase_admin.table("users")
                .select("telegram_user_id")
                .eq("id", user_id)
                .limit(1)
                .execute()
            )
            fresh_tel_id = (
                fresh_user.data[0].get("telegram_user_id")
                if fresh_user.data
                else None
            )
            if fresh_tel_id == telegram_id:
                await update.message.reply_text(
                    "Your Telegram account is already linked to this SpendWise account."
                )
            else:
                await update.message.reply_text(
                    "This SpendWise account is already linked to another Telegram account. Disconnect it first."
                )
            return

        # 8. Successful link! Consume the linking code
        claim = (
            supabase_admin.table("telegram_link_codes")
            .update({"used_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", link["id"])
            .is_("used_at", "null")
            .execute()
        )

        if not claim.data:
            # Race condition rollback
            supabase_admin.table("users").update(
                {"telegram_user_id": None}
            ).eq("id", user_id).eq("telegram_user_id", telegram_id).execute()

            await update.message.reply_text(
                "This code has already been used. Generate a new one."
            )
            return

        await update.message.reply_text(
            "✅ Your Telegram account is linked to SpendWise!\n\n"
            "You can now send your expenses here."
        )

    except Exception as e:
        err_str = str(e)
        if (
            getattr(e, "code", None) == "23505"
            or "23505" in err_str
            or "users_telegram_user_id_key" in err_str
            or "duplicate key" in err_str.lower()
        ):
            await update.message.reply_text(
                "This Telegram account is already linked to another SpendWise account. "
                "Disconnect it from that account first before linking."
            )
            return

        await update.message.reply_text(
            "Something went wrong while linking your account. "
            "Please try again or generate a new code."
        )


# ==============================================================================
# Telegram Application Factory & Webhook Management
# ==============================================================================

def create_telegram_app() -> Application:
    """Build and configure the python-telegram-bot Application instance."""
    if not TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is missing from .env")

    verify_ssl = os.getenv("TELEGRAM_SSL_VERIFY", "true").lower() not in ("false", "0", "no")
    httpx_kwargs = {} if verify_ssl else {"verify": False}

    request = HTTPXRequest(
        http_version="1.1",
        connection_pool_size=16,
        httpx_kwargs=httpx_kwargs,
    )

    app = Application.builder().token(TOKEN).request(request).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("link", link_telegram))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.add_handler(CallbackQueryHandler(handle_confirmation))

    return app


def get_bot_app() -> Application:
    """Get or create singleton telegram Application instance."""
    global _bot_app_instance
    if _bot_app_instance is None:
        _bot_app_instance = create_telegram_app()
    return _bot_app_instance


async def ensure_bot_initialized() -> Application:
    """Ensure bot application is initialized and running."""
    app = get_bot_app()
    if not getattr(app, "_initialized", False):
        await app.initialize()
    if not getattr(app, "_running", False):
        await app.start()
    return app


def get_webhook_secret() -> str:
    """Get secret token for Telegram webhook validation (X-Telegram-Bot-Api-Secret-Token)."""
    secret = os.getenv("TELEGRAM_WEBHOOK_SECRET")
    if secret:
        return secret.strip()
    seed = os.getenv("SESSION_SECRET") or TOKEN or "spendwise_secret_token"
    return hashlib.sha256(f"spendwise_webhook_{seed}".encode("utf-8")).hexdigest()[:64]


def get_webhook_url() -> str | None:
    """Retrieve full webhook HTTPS URL from environment variables."""
    explicit_url = os.getenv("TELEGRAM_WEBHOOK_URL") or os.getenv("WEBHOOK_URL")
    if explicit_url:
        url = explicit_url.strip()
        if not url.endswith("/api/telegram/webhook"):
            url = f"{url.rstrip('/')}/api/telegram/webhook"
        return url

    # Render automatically sets RENDER_EXTERNAL_URL (e.g. https://spendwise.onrender.com)
    render_url = os.getenv("RENDER_EXTERNAL_URL") or os.getenv("WEBHOOK_BASE_URL")
    if render_url:
        url = render_url.strip()
        return f"{url.rstrip('/')}/api/telegram/webhook"

    return None


async def register_webhook(
    app: Application,
    webhook_url: str | None = None,
    secret_token: str | None = None,
    drop_pending_updates: bool = False,
) -> dict:
    """Register the webhook with Telegram Bot API."""
    url = webhook_url or get_webhook_url()
    if not url:
        raise ValueError("No webhook URL configured (set WEBHOOK_URL or RENDER_EXTERNAL_URL)")

    secret = secret_token or get_webhook_secret()

    await app.bot.set_webhook(
        url=url,
        secret_token=secret,
        allowed_updates=["message", "callback_query"],
        drop_pending_updates=drop_pending_updates,
        max_connections=40,
    )

    info = await app.bot.get_webhook_info()
    return {
        "ok": True,
        "url": info.url,
        "has_custom_certificate": info.has_custom_certificate,
        "pending_update_count": info.pending_update_count,
        "last_error_date": info.last_error_date,
        "last_error_message": info.last_error_message,
        "max_connections": info.max_connections,
        "ip_address": info.ip_address,
    }


async def delete_webhook(app: Application, drop_pending_updates: bool = False) -> bool:
    """Delete webhook from Telegram (switches back to polling if desired)."""
    return await app.bot.delete_webhook(drop_pending_updates=drop_pending_updates)


# ==============================================================================
# CLI Entrypoint for Local Polling
# ==============================================================================

def main():
    """Run bot in long-polling mode (for local testing)."""
    if not TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is missing from .env")

    import asyncio

    app = get_bot_app()

    # When running polling, remove any existing webhook to prevent conflicts
    async def cleanup_and_poll():
        try:
            print("Checking existing webhook status...")
            await app.bot.delete_webhook(drop_pending_updates=False)
            print("Webhook cleared. Starting long polling...")
        except Exception as e:
            print(f"Notice: could not clear webhook ({e}). Starting polling anyway.")

    asyncio.run(cleanup_and_poll())

    print("SpendWise Telegram bot is running in long-polling mode...")
    app.run_polling()


if __name__ == "__main__":
    main()
