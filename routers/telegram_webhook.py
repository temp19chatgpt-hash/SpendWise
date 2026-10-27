import logging
import os
from fastapi import APIRouter, HTTPException, Header, Request, Response
from telegram import Update
from telegram_bot import (
    get_bot_app,
    ensure_bot_initialized,
    get_webhook_secret,
    get_webhook_url,
    is_duplicate_update,
    register_webhook,
    delete_webhook,
)

logger = logging.getLogger("spendwise.webhook")
router = APIRouter(prefix="/api/telegram", tags=["Telegram Webhook"])


@router.post("/webhook")
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: str | None = Header(
        default=None, alias="X-Telegram-Bot-Api-Secret-Token"
    ),
):
    """
    Secure webhook endpoint called by Telegram servers whenever a user interacts
    with the SpendWise Telegram bot.
    Validates the X-Telegram-Bot-Api-Secret-Token header and deduplicates updates.
    """
    expected_secret = get_webhook_secret()
    if expected_secret:
        if (
            not x_telegram_bot_api_secret_token
            or x_telegram_bot_api_secret_token != expected_secret
        ):
            logger.warning("Rejected Telegram webhook request: invalid or missing secret token")
            raise HTTPException(status_code=403, detail="Invalid secret token")

    try:
        update_data = await request.json()
    except Exception as e:
        logger.error("Failed to parse Telegram webhook JSON: %s", e)
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    update_id = update_data.get("update_id")

    # 1. Update deduplication: prevent duplicate processing on Telegram webhook retries
    if is_duplicate_update(update_id):
        logger.info("Ignoring duplicate update_id: %s", update_id)
        return {"ok": True, "duplicate": True}

    # 2. Process Telegram Update via python-telegram-bot
    try:
        bot_app = await ensure_bot_initialized()
        update = Update.de_json(data=update_data, bot=bot_app.bot)
        if update:
            await bot_app.process_update(update)
    except Exception as e:
        logger.error("Error processing Telegram update %s: %s", update_id, e, exc_info=True)
        # Always return 200 OK so Telegram does not get stuck in infinite retry loops
        return Response(
            content='{"ok": false, "error": "Internal processing error"}',
            media_type="application/json",
            status_code=200,
        )

    return {"ok": True}


@router.get("/webhook-info")
async def get_webhook_status():
    """Retrieve current Telegram webhook registration info directly from Telegram Bot API."""
    try:
        bot_app = await ensure_bot_initialized()
        info = await bot_app.bot.get_webhook_info()
        configured_url = get_webhook_url()
        secret = get_webhook_secret()

        return {
            "ok": True,
            "configured_webhook_url": configured_url,
            "secret_configured": bool(secret),
            "telegram_webhook": {
                "url": info.url,
                "has_custom_certificate": info.has_custom_certificate,
                "pending_update_count": info.pending_update_count,
                "last_error_date": info.last_error_date,
                "last_error_message": info.last_error_message,
                "max_connections": info.max_connections,
                "ip_address": info.ip_address,
            },
        }
    except Exception as e:
        logger.error("Failed to query Telegram webhook info: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/register-webhook")
async def manual_register_webhook(request: Request):
    """Manually register or update the webhook with Telegram."""
    # Only allow logged in admin or pass optional url in body
    try:
        body = await request.json()
    except Exception:
        body = {}

    url = body.get("url") or get_webhook_url()
    if not url:
        raise HTTPException(
            status_code=400,
            detail="No webhook URL provided. Set RENDER_EXTERNAL_URL or WEBHOOK_URL in environment.",
        )

    try:
        bot_app = await ensure_bot_initialized()
        result = await register_webhook(
            bot_app,
            webhook_url=url,
            drop_pending_updates=body.get("drop_pending_updates", False),
        )
        return {"message": "Webhook registered successfully", "details": result}
    except Exception as e:
        logger.error("Manual webhook registration failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Registration failed: {e}")


@router.post("/delete-webhook")
async def manual_delete_webhook():
    """Delete current webhook from Telegram (allows switching back to polling)."""
    try:
        bot_app = await ensure_bot_initialized()
        success = await delete_webhook(bot_app)
        return {"ok": success, "message": "Webhook deleted. Polling can now be used."}
    except Exception as e:
        logger.error("Failed to delete webhook: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
