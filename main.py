from fastapi import FastAPI, Request, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.responses import RedirectResponse
from routers.expenses import router as expenses_router
from routers.telegram_webhook import router as telegram_webhook_router
from telegram_bot import (
    get_bot_app,
    get_webhook_url,
    get_webhook_secret,
    register_webhook,
)
import os
import logging
from contextlib import asynccontextmanager
from dotenv import load_dotenv
from authlib.integrations.starlette_client import OAuth
from starlette.middleware.sessions import SessionMiddleware
from database import supabase_admin
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

load_dotenv()
logger = logging.getLogger("spendwise")

oauth = OAuth()

oauth.register(
    name="google",
    client_id=os.getenv("GOOGLE_CLIENT_ID"),
    client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={
        "scope": "openid email profile"
    }
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialize Telegram Bot application
    bot_app = None
    telegram_token = os.getenv("TELEGRAM_BOT_TOKEN")
    if telegram_token:
        try:
            bot_app = get_bot_app()
            await bot_app.initialize()
            await bot_app.start()
            logger.info("Telegram bot initialized and started.")

            # Auto-register webhook if external URL is configured (e.g. Render)
            webhook_url = get_webhook_url()
            if webhook_url:
                secret = get_webhook_secret()
                logger.info("Configuring Telegram webhook for: %s", webhook_url)
                try:
                    res = await register_webhook(bot_app, webhook_url, secret)
                    logger.info("Telegram webhook registered: %s (pending updates: %s)", res.get("url"), res.get("pending_update_count"))
                except Exception as we:
                    logger.error("Failed to auto-register Telegram webhook on startup: %s", we)
            else:
                logger.info("No Telegram webhook URL configured; running in local/on-demand mode.")
        except Exception as e:
            logger.error("Error during Telegram bot startup: %s", e)
    else:
        logger.warning("TELEGRAM_BOT_TOKEN is not set; Telegram features are inactive.")

    yield

    # Shutdown: Stop Telegram Bot cleanly
    if bot_app:
        try:
            await bot_app.stop()
            await bot_app.shutdown()
            logger.info("Telegram bot stopped cleanly.")
        except Exception as e:
            logger.warning("Error during Telegram bot shutdown: %s", e)


app = FastAPI(title="SpendWise API", lifespan=lifespan)
app.include_router(expenses_router)
app.include_router(telegram_webhook_router)

session_secret = os.getenv("SESSION_SECRET", "spendwise-default-session-secret-change-in-prod")
https_only = os.getenv("COOKIE_HTTPS_ONLY", "false").lower() in ("true", "1", "yes")

app.add_middleware(
    SessionMiddleware,
    secret_key=session_secret,
    https_only=https_only,
    same_site="lax",
)

# Ensure directories exist before mounting
os.makedirs("templates", exist_ok=True)
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


@app.get("/")
async def root(request: Request):
    user = request.session.get("user")
    if not user:
        return RedirectResponse(url="/login", status_code=303)
    return RedirectResponse(url="/overview", status_code=303)


@app.get("/overview")
@app.get("/transactions")
@app.get("/budget")
@app.get("/budgets")
@app.get("/telegram")
async def spa_view(request: Request):
    """Serve the SPA shell for all path-based tab routes."""
    user = request.session.get("user")
    if not user:
        return RedirectResponse(url="/login", status_code=303)
    return templates.TemplateResponse(
        request=request, name="dashboard.html", context={"user": user}
    )


@app.get("/login")
async def login_page(request: Request):
    user = request.session.get("user")
    if user:
        return RedirectResponse(url="/", status_code=303)
    return templates.TemplateResponse(
        request=request, name="login.html", context={}
    )


@app.get("/auth/logout")
@app.post("/auth/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/login", status_code=303)

@app.get("/auth/google/login")
async def google_login(request: Request):
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI")
    return await oauth.google.authorize_redirect(request, redirect_uri)

@app.get("/auth/google/callback")
async def google_callback(request: Request):
    token = await oauth.google.authorize_access_token(request)
    user = token.get("userinfo")

    if not user:
        user = await oauth.google.userinfo(token=token)

    if not user.get("sub") or not user.get("email"):
        raise HTTPException(
            status_code=400,
            detail="Google user information is incomplete"
        )

    if not user.get("email_verified"):
        raise HTTPException(
            status_code=400,
            detail="Google email is not verified"
        )

    response = (
    supabase_admin.table("users")
    .upsert(
        {
            "google_id": user["sub"],
            "email": user["email"],
            "name": user.get("name")
        },
        on_conflict="google_id"
    )
    .execute()
    )

    db_user = (
    supabase_admin.table("users")
    .select("id, google_id, email, name")
    .eq("google_id", user["sub"])
    .execute()
    )

    if not db_user.data:
        raise HTTPException(
            status_code=500,
            detail="Could not retrieve SpendWise user"
        )

    spendwise_user = db_user.data[0]

    request.session["user"] = {
        "id": spendwise_user["id"],
        "google_id": spendwise_user["google_id"],
        "email": spendwise_user["email"],
        "name": spendwise_user["name"]
    }

    return RedirectResponse(url="/overview", status_code=303)

@app.get("/auth/me")
async def get_current_user(request: Request):
    user = request.session.get("user")

    if not user:
        raise HTTPException(
            status_code=401,
            detail="Not logged in"
        )

    response = (
        supabase_admin.table("users")
        .select("id, google_id, email, name, telegram_user_id")
        .eq("id", user["id"])
        .execute()
    )

    if not response.data:
        raise HTTPException(
            status_code=401,
            detail="User account not found"
        )

    user_data = response.data[0]
    return {
        "id": user_data["id"],
        "google_id": user_data["google_id"],
        "email": user_data["email"],
        "name": user_data["name"],
        "telegram_connected": user_data.get("telegram_user_id") is not None,
    }

@app.get("/api/telegram/status")
async def get_telegram_status(request: Request):
    user = request.session.get("user")

    if not user or not user.get("id"):
        raise HTTPException(status_code=401, detail="Not logged in")

    response = (
        supabase_admin.table("users")
        .select("telegram_user_id")
        .eq("id", user["id"])
        .limit(1)
        .execute()
    )

    if not response.data:
        raise HTTPException(status_code=404, detail="User not found")

    telegram_user_id = response.data[0].get("telegram_user_id")
    return {
        "connected": telegram_user_id is not None,
        "bot_username": os.getenv("TELEGRAM_BOT_USERNAME", "SpendWiseExpenseBot"),
    }

@app.post("/api/telegram/disconnect")
async def disconnect_telegram(request: Request):
    user = request.session.get("user")

    if not user or not user.get("id"):
        raise HTTPException(status_code=401, detail="Not logged in")

    supabase_admin.table("users").update(
        {"telegram_user_id": None}
    ).eq("id", user["id"]).execute()

    return {"message": "Telegram account disconnected successfully"}

@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "message": "SpendWise API is running"
    }

@app.post("/api/telegram/link-code")
async def create_telegram_link_code(request: Request):
    user = request.session.get("user")

    if not user or not user.get("id"):
        raise HTTPException(
            status_code=401,
            detail="Please sign in to SpendWise first.",
        )

    user_id = user["id"]

    code = secrets.token_hex(16)
    code_hash = hashlib.sha256(code.encode("utf-8")).hexdigest()

    expires_at = (
        datetime.now(timezone.utc) + timedelta(minutes=5)
    ).isoformat()

    try:
        supabase_admin.table("telegram_link_codes").insert({
            "user_id": user_id,
            "code_hash": code_hash,
            "expires_at": expires_at,
        }).execute()

    except Exception:
        raise HTTPException(
            status_code=500,
            detail="Could not generate a Telegram linking code.",
        ) from None

    return {
        "code": code,
        "expires_in_seconds": 300,
        "message": "Send /link followed by this code to your SpendWise Telegram bot.",
    }



# Catch-all: any unknown path serves the SPA if logged in, else redirects to login.
# This must be registered LAST so it doesn't shadow API routes.
@app.get("/{full_path:path}")
async def spa_catchall(request: Request, full_path: str):
    user = request.session.get("user")
    if not user:
        return RedirectResponse(url="/login", status_code=303)
    # Redirect unrecognised paths to /overview rather than 404
    return RedirectResponse(url="/overview", status_code=303)
