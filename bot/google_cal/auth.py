from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import parse_qs, urlencode, urlparse

from aiohttp import web
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow

from bot.config import Settings
from bot.db.models import User
from bot.db.repository import Repository

SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
]


@dataclass
class PendingOAuth:
    telegram_id: int
    state: str
    created_at: datetime


class GoogleOAuthService:
    def __init__(self, settings: Settings, repo: Repository) -> None:
        self.settings = settings
        self.repo = repo
        self._pending: dict[str, PendingOAuth] = {}
        self._completed: dict[int, asyncio.Future[bool]] = {}
        self._runner: Optional[web.AppRunner] = None

    def _client_config(self) -> dict:
        return {
            "web": {
                "client_id": self.settings.google_client_id,
                "client_secret": self.settings.google_client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": [self.settings.redirect_uri],
            }
        }

    def create_auth_url(self, telegram_id: int) -> str:
        if not self.settings.google_ready:
            raise RuntimeError("Google OAuth не налаштовано (CLIENT_ID / CLIENT_SECRET)")

        state = secrets.token_urlsafe(24)
        self._pending[state] = PendingOAuth(
            telegram_id=telegram_id,
            state=state,
            created_at=datetime.now(timezone.utc),
        )
        loop = asyncio.get_running_loop()
        self._completed[telegram_id] = loop.create_future()

        params = {
            "client_id": self.settings.google_client_id,
            "redirect_uri": self.settings.redirect_uri,
            "response_type": "code",
            "scope": " ".join(SCOPES),
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
            "include_granted_scopes": "true",
        }
        return "https://accounts.google.com/o/oauth2/auth?" + urlencode(params)

    async def wait_for_completion(self, telegram_id: int, timeout: float = 300) -> bool:
        future = self._completed.get(telegram_id)
        if not future:
            return False
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
        except asyncio.TimeoutError:
            return False
        finally:
            self._completed.pop(telegram_id, None)

    def _pending_for_user(self, telegram_id: int) -> Optional[PendingOAuth]:
        for item in self._pending.values():
            if item.telegram_id == telegram_id:
                return item
        return None

    @staticmethod
    def extract_code(text: str) -> Optional[str]:
        text = text.strip()
        if text.startswith("http://") or text.startswith("https://"):
            query = parse_qs(urlparse(text).query)
            values = query.get("code") or []
            return values[0] if values else None
        if "code=" in text:
            query = parse_qs(text.split("?", 1)[-1])
            values = query.get("code") or []
            return values[0] if values else None
        # raw authorization code
        if 10 <= len(text) <= 300 and " " not in text:
            return text
        return None

    async def complete_with_code(self, telegram_id: int, code: str) -> None:
        pending = self._pending_for_user(telegram_id)
        if not pending:
            raise RuntimeError("Немає активного підключення. Натисни «Підключити календар» знову.")

        self._pending.pop(pending.state, None)
        flow = Flow.from_client_config(
            self._client_config(),
            scopes=SCOPES,
            redirect_uri=self.settings.redirect_uri,
            state=pending.state,
        )
        await asyncio.to_thread(flow.fetch_token, code=code)
        creds = flow.credentials
        expiry = creds.expiry
        if expiry and expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)

        existing = await self.repo.get_user(telegram_id)
        refresh = creds.refresh_token or (
            existing.google_refresh_token if existing else None
        )
        if not refresh:
            raise RuntimeError(
                "Google не повернув refresh token. "
                "Відкликай доступ EventPing у "
                "https://myaccount.google.com/permissions і спробуй знову."
            )

        await self.repo.update_user(
            telegram_id,
            google_refresh_token=refresh,
            google_access_token=creds.token,
            google_token_expiry=expiry,
        )
        future = self._completed.get(telegram_id)
        if future and not future.done():
            future.set_result(True)

    async def start_callback_server(self) -> None:
        app = web.Application()
        app.router.add_get("/oauth/callback", self._handle_callback)
        app.router.add_get("/health", self._health)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(
            self._runner,
            self.settings.oauth_host,
            self.settings.listen_port,
        )
        await site.start()

    async def stop_callback_server(self) -> None:
        if self._runner:
            await self._runner.cleanup()
            self._runner = None

    async def _health(self, _request: web.Request) -> web.Response:
        return web.Response(text="ok")

    async def _handle_callback(self, request: web.Request) -> web.Response:
        error = request.rel_url.query.get("error")
        if error:
            return web.Response(
                text="Авторизацію скасовано. Можна закрити вкладку і повернутися в Telegram.",
                content_type="text/html; charset=utf-8",
                status=400,
            )

        state = request.rel_url.query.get("state")
        code = request.rel_url.query.get("code")
        if not state or not code or state not in self._pending:
            return web.Response(
                text="Невірний або прострочений запит. Запустіть підключення знову в боті.",
                content_type="text/html; charset=utf-8",
                status=400,
            )

        pending = self._pending.pop(state)
        try:
            flow = Flow.from_client_config(
                self._client_config(),
                scopes=SCOPES,
                redirect_uri=self.settings.redirect_uri,
                state=state,
            )
            await asyncio.to_thread(flow.fetch_token, code=code)
            creds = flow.credentials
            expiry = creds.expiry
            if expiry and expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)

            existing = await self.repo.get_user(pending.telegram_id)
            refresh = creds.refresh_token or (
                existing.google_refresh_token if existing else None
            )
            if not refresh:
                raise RuntimeError(
                    "Google не повернув refresh token. "
                    "Спробуй ще раз (іноді допомагає відкликати доступ у "
                    "https://myaccount.google.com/permissions)."
                )

            await self.repo.update_user(
                pending.telegram_id,
                google_refresh_token=refresh,
                google_access_token=creds.token,
                google_token_expiry=expiry,
            )
            future = self._completed.get(pending.telegram_id)
            if future and not future.done():
                future.set_result(True)
        except Exception as exc:  # noqa: BLE001
            future = self._completed.get(pending.telegram_id)
            if future and not future.done():
                future.set_exception(exc)
            return web.Response(
                text=f"Помилка авторизації: {exc}",
                content_type="text/html; charset=utf-8",
                status=500,
            )

        html = """
        <!doctype html>
        <html lang="uk">
        <head>
          <meta charset="utf-8"/>
          <title>EventPing</title>
          <style>
            body { font-family: system-ui, sans-serif; background:#0f172a; color:#e2e8f0;
                   display:flex; min-height:100vh; align-items:center; justify-content:center; }
            .card { background:#1e293b; padding:2rem 2.5rem; border-radius:16px; text-align:center;
                    max-width:420px; box-shadow:0 20px 40px rgba(0,0,0,.35); }
            h1 { margin:0 0 .5rem; font-size:1.5rem; }
            p { margin:0; color:#94a3b8; line-height:1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Календар підключено</h1>
            <p>Можна закрити цю вкладку і повернутися в Telegram до EventPing.</p>
          </div>
        </body>
        </html>
        """
        return web.Response(text=html, content_type="text/html; charset=utf-8")

    def credentials_for_user(self, user: User) -> Optional[Credentials]:
        if not user.google_refresh_token:
            return None
        creds = Credentials(
            token=user.google_access_token,
            refresh_token=user.google_refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=self.settings.google_client_id,
            client_secret=self.settings.google_client_secret,
            scopes=SCOPES,
        )
        if user.google_token_expiry:
            creds.expiry = user.google_token_expiry.replace(tzinfo=None)
        return creds

    async def ensure_fresh_credentials(self, user: User) -> Optional[Credentials]:
        creds = self.credentials_for_user(user)
        if not creds:
            return None

        needs_refresh = not creds.valid or (
            creds.expired and creds.refresh_token
        )
        if needs_refresh:
            if not creds.refresh_token:
                return None
            await asyncio.to_thread(creds.refresh, Request())
            expiry = creds.expiry
            if expiry and expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            await self.repo.update_user(
                user.telegram_id,
                google_access_token=creds.token,
                google_token_expiry=expiry,
                google_refresh_token=creds.refresh_token or user.google_refresh_token,
            )
        return creds

    async def disconnect(self, telegram_id: int) -> None:
        await self.repo.update_user(
            telegram_id,
            google_refresh_token=None,
            google_access_token=None,
            google_token_expiry=None,
        )
