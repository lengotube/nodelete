"""Isolated, fail-closed Ghost checkout. No card details are handled here."""
from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import html
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time
from urllib.parse import urlparse

from aiohttp import ClientSession, ClientTimeout, web

ROOT = Path(__file__).resolve().parent
INITIAL_AMOUNT, RENEW_AMOUNT, DAYS = 10, 79, 7
PLANS = {
    "lite": {"first": 10, "renew": 79, "days": 7, "months": 0, "interval": "Week", "period": 1, "label": "7 дней", "frequency": "каждые 7 дней"},
    "lite_regular": {"first": 79, "renew": 79, "days": 7, "months": 0, "interval": "Week", "period": 1, "label": "7 дней", "frequency": "каждые 7 дней"},
    "plus": {"first": 179, "renew": 179, "days": 0, "months": 1, "interval": "Month", "period": 1, "label": "1 месяц", "frequency": "каждый месяц"},
    "quarter": {"first": 449, "renew": 449, "days": 0, "months": 3, "interval": "Month", "period": 3, "label": "3 месяца", "frequency": "каждые 3 месяца"},
    "prime": {"first": 1290, "renew": 1290, "days": 0, "months": 12, "interval": "Month", "period": 12, "label": "1 год", "frequency": "каждый год"},
}
LOCKS: dict[int, asyncio.Lock] = {}


def signature(secret: str, timestamp: str, method: str, path: str, raw: bytes) -> str:
    prefix = f"{timestamp}.{method.upper()}.{path}.".encode()
    return hmac.new(secret.encode(), prefix + raw, hashlib.sha256).hexdigest()


def verify_internal(secret: str, timestamp: str, supplied: str, method: str, path: str, raw: bytes, now: int | None = None) -> bool:
    try:
        if not secret or abs((int(time.time()) if now is None else now) - int(timestamp)) > 300:
            return False
        return hmac.compare_digest(signature(secret, timestamp, method, path, raw), supplied or "")
    except (ValueError, TypeError):
        return False


def verify_cloudpayments(secret: str, raw: bytes, supplied: str) -> bool:
    digest = base64.b64encode(hmac.new(secret.encode(), raw, hashlib.sha256).digest()).decode()
    return bool(secret and supplied and hmac.compare_digest(digest, supplied))


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def add_period(value: datetime, plan: dict) -> datetime:
    if plan["days"]:
        return value + timedelta(days=plan["days"])
    from calendar import monthrange
    month_index = value.year * 12 + value.month - 1 + plan["months"]
    year, month = divmod(month_index, 12)
    return value.replace(year=year, month=month + 1, day=min(value.day, monthrange(year, month + 1)[1]))


def money_matches(value: str | int | float, expected: int) -> bool:
    from decimal import Decimal, InvalidOperation
    try:
        return Decimal(str(value)) == Decimal(expected)
    except (InvalidOperation, ValueError, TypeError):
        return False


def configuration() -> dict[str, str]:
    names = ["GHOST_CHECKOUT_PUBLIC_URL", "GHOST_CHECKOUT_DATABASE", "GHOST_CHECKOUT_INTERNAL_SECRET", "GHOST_EVENT_SECRET", "GHOST_EVENT_URL", "CLOUDPAYMENTS_PUBLIC_ID", "CLOUDPAYMENTS_API_SECRET", "GHOST_SELLER_NAME", "GHOST_SELLER_INN", "GHOST_SELLER_REGISTRATION", "GHOST_SELLER_EMAIL", "GHOST_SUPPORT_URL", "GHOST_OFFER_URL", "GHOST_PRIVACY_URL", "GHOST_TERMS_VERSION", "GHOST_RECEIPT_TAXATION", "GHOST_RECEIPT_VAT", "GHOST_RECEIPT_LABEL"]
    result = {name: os.environ.get(name, "").strip() for name in names}
    missing = [name for name, value in result.items() if not value]
    if missing:
        raise RuntimeError("Missing required checkout configuration: " + ", ".join(missing))
    for name in ("GHOST_CHECKOUT_PUBLIC_URL", "GHOST_OFFER_URL", "GHOST_PRIVACY_URL", "GHOST_SUPPORT_URL"):
        parsed = urlparse(result[name])
        if parsed.scheme != "https" or not parsed.netloc:
            raise RuntimeError(f"{name} must be an HTTPS URL")
    endpoint = urlparse(result["GHOST_EVENT_URL"])
    if endpoint.scheme not in ("https", "http") or not endpoint.hostname or (endpoint.scheme == "http" and endpoint.hostname not in ("127.0.0.1", "localhost", "::1")):
        raise RuntimeError("GHOST_EVENT_URL must use HTTPS or localhost HTTP")
    if len(result["GHOST_CHECKOUT_INTERNAL_SECRET"]) < 32 or len(result["GHOST_EVENT_SECRET"]) < 32 or result["GHOST_CHECKOUT_INTERNAL_SECRET"] == result["GHOST_EVENT_SECRET"]:
        raise RuntimeError("Internal and event secrets must be distinct and at least 32 characters")
    verified = os.environ.get("GHOST_PROVIDER_TOKENIZATION_VERIFIED") == "1" and os.environ.get("GHOST_PROVIDER_RECEIPTS_VERIFIED") == "1"
    if not verified and os.environ.get("GHOST_PROVIDER_UNVERIFIED_DEPLOYMENT_ACKNOWLEDGED") != "1":
        raise RuntimeError("Verify provider tokenization and fiscal receipt configuration before enabling checkout")
    if not result["GHOST_RECEIPT_TAXATION"].isdigit() or int(result["GHOST_RECEIPT_TAXATION"]) not in range(6) or (result["GHOST_RECEIPT_VAT"] != "none" and not result["GHOST_RECEIPT_VAT"].isdigit()):
        raise RuntimeError("Invalid receipt taxation or VAT configuration")
    return result


def customer_receipt(config: dict, amount: int, email: str) -> dict:
    vat = config["GHOST_RECEIPT_VAT"]
    return {"Items": [{"label": config["GHOST_RECEIPT_LABEL"], "price": amount, "quantity": 1, "amount": amount, "vat": None if vat == "none" else int(vat), "method": 4, "object": 4}], "taxationSystem": int(config["GHOST_RECEIPT_TAXATION"]), "email": email, "isBso": False, "amounts": {"electronic": amount}}


def initialize_database(path: str) -> sqlite3.Connection:
    directory = Path(path).resolve().parent
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    os.close(fd)
    db = sqlite3.connect(path, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.executescript("""
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS links (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (invoice_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, status TEXT NOT NULL, terms_version TEXT NOT NULL, consent_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS subscriptions (user_id INTEGER PRIMARY KEY, status TEXT NOT NULL, provider_id TEXT UNIQUE, next_at TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payments (transaction_id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, user_id INTEGER NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, paid_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, delivered_at TEXT, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS payment_anomalies (transaction_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, invoice_id TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL, recorded_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_checks (user_id INTEGER PRIMARY KEY, transaction_id TEXT UNIQUE NOT NULL, invoice_id TEXT NOT NULL, created_at TEXT NOT NULL);
    """)
    db.execute("DROP INDEX IF EXISTS one_paid_intro")
    for table in ("links", "orders", "subscriptions", "payments"):
        columns = {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
        if "plan" not in columns:
            db.execute(f"ALTER TABLE {table} ADD COLUMN plan TEXT NOT NULL DEFAULT 'lite'")
    return db


async def cloud_request(app: web.Application, path: str, payload: dict) -> dict:
    config = app["config"]
    auth = base64.b64encode(f'{config["CLOUDPAYMENTS_PUBLIC_ID"]}:{config["CLOUDPAYMENTS_API_SECRET"]}'.encode()).decode()
    async with app["session"].post("https://api.cloudpayments.ru" + path, json=payload, headers={"Authorization": "Basic " + auth}) as response:
        if response.status != 200:
            raise RuntimeError("CloudPayments request failed")
        result = await response.json(content_type=None)
        if not isinstance(result, dict):
            raise RuntimeError("Invalid provider response")
        return result


async def authenticate(request: web.Request) -> tuple[dict, int]:
    raw = await request.read()
    if not verify_internal(request.app["config"]["GHOST_CHECKOUT_INTERNAL_SECRET"], request.headers.get("X-Ghost-Timestamp", ""), request.headers.get("X-Ghost-Signature", ""), request.method, request.path, raw):
        raise web.HTTPForbidden()
    try:
        body = json.loads(raw)
        user_id = body["user_id"]
        if type(user_id) is not int or not 0 < user_id < 2**63:
            raise ValueError()
        return body, user_id
    except (ValueError, TypeError, KeyError):
        raise web.HTTPBadRequest()


def row_for_link(db: sqlite3.Connection, token: str) -> sqlite3.Row | None:
    if len(token) != 43:
        return None
    return db.execute("SELECT * FROM links WHERE token=? AND expires_at>?", (token, int(time.time()))).fetchone()


async def internal_checkout(request: web.Request) -> web.Response:
    body, user_id = await authenticate(request)
    plan = body.get("plan", "lite")
    if plan not in PLANS:
        raise web.HTTPBadRequest()
    db = request.app["db"]
    if plan == "lite" and db.execute("SELECT 1 FROM payments WHERE user_id=? AND kind='initial' AND plan='lite'", (user_id,)).fetchone():
        return web.json_response({"ok": False, "error": "offer_already_used"}, status=409)
    if db.execute("SELECT 1 FROM subscriptions WHERE user_id=? AND status NOT IN ('cancelled','expired','rejected')", (user_id,)).fetchone():
        return web.json_response({"ok": False, "error": "subscription_exists"}, status=409)
    token = secrets.token_urlsafe(32)
    db.execute("INSERT INTO links(token,user_id,expires_at,plan) VALUES(?,?,?,?)", (token, user_id, int(time.time()) + 3600, plan))
    return web.json_response({"ok": True, "url": request.app["config"]["GHOST_CHECKOUT_PUBLIC_URL"].rstrip("/") + "/pay/" + token})


async def internal_status(request: web.Request) -> web.Response:
    _, user_id = await authenticate(request)
    row = request.app["db"].execute("SELECT status,next_at,plan FROM subscriptions WHERE user_id=?", (user_id,)).fetchone()
    plan = PLANS.get(row["plan"]) if row else None
    return web.json_response({"ok": True, "offer_used": bool(request.app["db"].execute("SELECT 1 FROM payments WHERE user_id=? AND kind='initial' AND plan='lite'", (user_id,)).fetchone()), "subscription": None if not row else {"status": row["status"], "plan": row["plan"], "amount": plan["renew"], "period_days": plan["days"], "period_months": plan["months"], "next_at": row["next_at"]}})


async def internal_cancel(request: web.Request) -> web.Response:
    _, user_id = await authenticate(request)
    async with LOCKS.setdefault(user_id, asyncio.Lock()):
        db = request.app["db"]
        row = db.execute("SELECT * FROM subscriptions WHERE user_id=?", (user_id,)).fetchone()
        if not row:
            return web.json_response({"ok": False, "error": "no_subscription"}, status=404)
        if row["status"] in ("cancelled", "expired", "rejected"):
            return web.json_response({"ok": True, "status": "cancelled"})
        if not row["provider_id"]:
            return web.json_response({"ok": False, "error": "provider_subscription_needs_review"}, status=409)
        db.execute("UPDATE subscriptions SET status='cancellation_pending', updated_at=? WHERE user_id=?", (iso(utc_now()), user_id))
        try:
            result = await cloud_request(request.app, "/subscriptions/cancel", {"Id": row["provider_id"]})
        except Exception:
            return web.json_response({"ok": False, "error": "cancellation_unconfirmed"}, status=503)
        if not result.get("Success"):
            return web.json_response({"ok": False, "error": "cancellation_unconfirmed"}, status=502)
        db.execute("UPDATE subscriptions SET status='cancelled', next_at=NULL, updated_at=? WHERE user_id=?", (iso(utc_now()), user_id))
        return web.json_response({"ok": True, "status": "cancelled"})


async def page(request: web.Request) -> web.Response:
    row = row_for_link(request.app["db"], request.match_info["token"])
    if not row:
        raise web.HTTPNotFound()
    # Configuration is inserted as JSON, with < escaped to prevent script breakout.
    cfg = request.app["config"]
    values = {"offer": cfg["GHOST_OFFER_URL"], "privacy": cfg["GHOST_PRIVACY_URL"], "support": cfg["GHOST_SUPPORT_URL"], "seller": cfg["GHOST_SELLER_NAME"], "publicId": cfg["CLOUDPAYMENTS_PUBLIC_ID"], "token": request.match_info["token"], "basePath": urlparse(cfg["GHOST_CHECKOUT_PUBLIC_URL"]).path.rstrip("/"), "plan": PLANS[row["plan"]]}
    rendered = (ROOT / "pay.html").read_text().replace("__CONFIG__", json.dumps(values, ensure_ascii=False).replace("<", "\\u003c"))
    return web.Response(text=rendered, content_type="text/html", headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"})


async def offer(request: web.Request) -> web.Response:
    cfg = request.app["config"]
    values = {"terms_version": cfg["GHOST_TERMS_VERSION"], "seller_name": cfg["GHOST_SELLER_NAME"], "seller_inn": cfg["GHOST_SELLER_INN"], "seller_registration": cfg["GHOST_SELLER_REGISTRATION"], "seller_email": cfg["GHOST_SELLER_EMAIL"], "privacy_url": cfg["GHOST_PRIVACY_URL"], "support_url": cfg["GHOST_SUPPORT_URL"]}
    rendered = (ROOT / "offer.html").read_text()
    for key, value in values.items():
        rendered = rendered.replace("{{" + key + "}}", html.escape(value, quote=True))
    return web.Response(text=rendered, content_type="text/html", headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


async def tariffs(request: web.Request) -> web.Response:
    cfg = request.app["config"]
    rendered = (ROOT / "tariffs.html").read_text()
    for key, value in {"offer_url": cfg["GHOST_OFFER_URL"], "privacy_url": cfg["GHOST_PRIVACY_URL"], "support_url": cfg["GHOST_SUPPORT_URL"]}.items():
        rendered = rendered.replace("{{" + key + "}}", html.escape(value, quote=True))
    return web.Response(text=rendered, content_type="text/html", headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


async def confirm(request: web.Request) -> web.Response:
    row = row_for_link(request.app["db"], request.match_info["token"])
    if not row:
        raise web.HTTPNotFound()
    try:
        body = await request.json()
    except Exception:
        raise web.HTTPBadRequest()
    if body.get("accept_offer") is not True or body.get("accept_recurring") is not True:
        return web.json_response({"ok": False, "error": "consent_required"}, status=400)
    email = body.get("email", "")
    if not isinstance(email, str) or len(email) > 254 or email.count("@") != 1 or any(c.isspace() for c in email) or not all(email.split("@")):
        return web.json_response({"ok": False, "error": "email_required"}, status=400)
    user_id = row["user_id"]
    async with LOCKS.setdefault(user_id, asyncio.Lock()):
        db = request.app["db"]
        plan_id, plan = row["plan"], PLANS[row["plan"]]
        if (plan_id == "lite" and db.execute("SELECT 1 FROM payments WHERE user_id=? AND kind='initial' AND plan='lite'", (user_id,)).fetchone()) or db.execute("SELECT 1 FROM subscriptions WHERE user_id=? AND status NOT IN ('cancelled','expired','rejected')", (user_id,)).fetchone():
            return web.json_response({"ok": False, "error": "offer_unavailable"}, status=409)
        # A single live order prevents two browser clicks creating two charges.
        existing = db.execute("SELECT invoice_id FROM orders WHERE user_id=? AND plan=? AND status='new' ORDER BY created_at DESC LIMIT 1", (user_id, plan_id)).fetchone()
        invoice = existing["invoice_id"] if existing else "ghost-" + secrets.token_hex(16)
        if not existing:
            now = iso(utc_now())
            db.execute("INSERT INTO orders(invoice_id,user_id,status,terms_version,consent_at,created_at,plan) VALUES(?,?,?,?,?,?,?)", (invoice, user_id, "new", request.app["config"]["GHOST_TERMS_VERSION"], now, now, plan_id))
        return web.json_response({"ok": True, "invoice_id": invoice, "account_id": f"ghost:{user_id}", "amount": plan["first"], "currency": "RUB", "email": email, "receipt": customer_receipt(request.app["config"], plan["first"], email)})


def verified_webhook(request: web.Request, raw: bytes) -> bool:
    return verify_cloudpayments(request.app["config"]["CLOUDPAYMENTS_API_SECRET"], raw, request.headers.get("Content-HMAC", ""))


def webhook_user(db: sqlite3.Connection, data, *, recurrent: bool = False) -> int | None:
    """Resolve signed provider events without ever changing their original body."""
    account = data.get("AccountId", "")
    if account and (not account.startswith("ghost:") or not account[6:].isdigit()):
        return None
    candidates = set()
    if account:
        candidates.add(int(account[6:]))
    invoice = data.get("InvoiceId", "")
    provider_id = data.get("Id" if recurrent else "SubscriptionId", "")
    if invoice:
        row = db.execute("SELECT user_id FROM orders WHERE invoice_id=?", (invoice,)).fetchone()
        if row:
            candidates.add(row["user_id"])
    if provider_id:
        row = db.execute("SELECT user_id FROM subscriptions WHERE provider_id=?", (provider_id,)).fetchone()
        if row:
            candidates.add(row["user_id"])
    return next(iter(candidates)) if len(candidates) == 1 else None


async def cloud_check(request: web.Request) -> web.Response:
    raw = await request.read()
    if not verified_webhook(request, raw):
        return web.json_response({"code": 13})
    data = await request.post()
    db = request.app["db"]
    user_id = webhook_user(db, data)
    if user_id is None:
        return web.json_response({"code": 10})
    subscription_id = data.get("SubscriptionId")
    if subscription_id:
        row = db.execute("SELECT * FROM subscriptions WHERE provider_id=?", (subscription_id,)).fetchone()
        valid = row and row["user_id"] == user_id and row["status"] in ("active", "pastdue") and data.get("Currency") == "RUB" and money_matches(data.get("Amount"), PLANS[row["plan"]]["renew"])
    else:
        row = db.execute("SELECT * FROM orders WHERE invoice_id=?", (data.get("InvoiceId", ""),)).fetchone()
        tx = data.get("TransactionId", "")
        email = data.get("Email", "")
        valid = row and row["user_id"] == user_id and row["status"] == "new" and data.get("Currency") == "RUB" and money_matches(data.get("Amount"), PLANS[row["plan"]]["first"]) and str(tx).isdigit() and "@" in email and not db.execute("SELECT 1 FROM subscriptions WHERE user_id=? AND status NOT IN ('cancelled','expired','rejected')", (row["user_id"],)).fetchone() and (row["plan"] != "lite" or not db.execute("SELECT 1 FROM payments WHERE user_id=? AND kind='initial' AND plan='lite'", (row["user_id"],)).fetchone())
        if valid:
            reservation = db.execute("SELECT transaction_id FROM payment_checks WHERE user_id=?", (row["user_id"],)).fetchone()
            if reservation:
                valid = reservation["transaction_id"] == tx
            else:
                db.execute("INSERT INTO payment_checks VALUES(?,?,?,?)", (row["user_id"], tx, row["invoice_id"], iso(utc_now())))
    return web.json_response({"code": 0 if valid else 10})


def queue_payment(db: sqlite3.Connection, *, tx: str, invoice: str, user_id: int, kind: str, amount: int, paid_at: str, plan_id: str) -> None:
    plan = PLANS[plan_id]
    event = {"event_id": "cp:" + tx, "user_id": user_id, "kind": kind, "amount": amount, "currency": "RUB", "period_days": plan["days"], "period_months": plan["months"], "plan": plan_id, "paid_at": paid_at, "invoice_id": invoice}
    db.execute("INSERT INTO payments(transaction_id,invoice_id,user_id,kind,amount,paid_at,plan) VALUES(?,?,?,?,?,?,?)", (tx, invoice, user_id, kind, amount, paid_at, plan_id))
    db.execute("INSERT INTO outbox(event_id,payload) VALUES(?,?)", (event["event_id"], json.dumps(event, ensure_ascii=False, separators=(",", ":"))))


def record_payment_anomaly(db: sqlite3.Connection, *, tx: str, invoice: str, user_id: int, kind: str, amount: int, reason: str) -> None:
    db.execute("INSERT OR IGNORE INTO payment_anomalies VALUES(?,?,?,?,?,?,?)", (tx, user_id, invoice, kind, amount, reason, iso(utc_now())))


async def cloud_pay(request: web.Request) -> web.Response:
    raw = await request.read()
    if not verified_webhook(request, raw):
        return web.json_response({"code": 13})
    data = await request.post()
    tx = data.get("TransactionId", "")
    db = request.app["db"]
    user_id = webhook_user(db, data)
    if user_id is None or not tx or not str(tx).isdigit() or data.get("Currency") != "RUB":
        return web.json_response({"code": 10})
    account = f"ghost:{user_id}"
    async with LOCKS.setdefault(user_id, asyncio.Lock()):
        if db.execute("SELECT 1 FROM payments WHERE transaction_id=?", (tx,)).fetchone():
            return web.json_response({"code": 0})
        if db.execute("SELECT 1 FROM payment_anomalies WHERE transaction_id=?", (tx,)).fetchone():
            return web.json_response({"code": 0})
        provider_id = data.get("SubscriptionId")
        kind = "renewal" if provider_id else "initial"
        # Some subscription renewals have no InvoiceId. Use the already
        # authenticated provider subscription as a stable event reference.
        invoice = data.get("InvoiceId") or (f"subscription:{provider_id}" if provider_id else "")
        if kind == "renewal":
            sub = db.execute("SELECT * FROM subscriptions WHERE user_id=? AND provider_id=?", (user_id, provider_id)).fetchone()
            if not sub or sub["status"] not in ("active", "pastdue", "cancellation_pending"):
                record_payment_anomaly(db, tx=tx, invoice=invoice, user_id=user_id, kind=kind, amount=str(data.get("Amount", ""))[:64], reason="unknown_or_inactive_subscription")
                request.app.logger.error("Confirmed payment requires review: transaction=%s", tx)
                return web.json_response({"code": 0})
        else:
            order = db.execute("SELECT * FROM orders WHERE invoice_id=? AND user_id=? AND status='new'", (invoice, user_id)).fetchone()
            if not order or (order["plan"] == "lite" and db.execute("SELECT 1 FROM payments WHERE user_id=? AND kind='initial' AND plan='lite'", (user_id,)).fetchone()) or db.execute("SELECT 1 FROM subscriptions WHERE user_id=? AND status NOT IN ('cancelled','expired','rejected')", (user_id,)).fetchone():
                record_payment_anomaly(db, tx=tx, invoice=invoice, user_id=user_id, kind=kind, amount=str(data.get("Amount", ""))[:64], reason="unexpected_or_duplicate_initial")
                request.app.logger.error("Confirmed payment requires review: transaction=%s", tx)
                return web.json_response({"code": 0})
        plan_id = sub["plan"] if kind == "renewal" else order["plan"]
        plan = PLANS[plan_id]
        amount = plan["renew"] if kind == "renewal" else plan["first"]
        if not money_matches(data.get("Amount"), amount):
            record_payment_anomaly(db, tx=tx, invoice=invoice, user_id=user_id, kind=kind, amount=str(data.get("Amount", ""))[:64], reason="unexpected_amount")
            request.app.logger.error("Confirmed payment has unexpected amount: transaction=%s", tx)
            return web.json_response({"code": 0})
        paid_at = iso(utc_now())
        db.execute("BEGIN IMMEDIATE")
        try:
            queue_payment(db, tx=tx, invoice=invoice, user_id=user_id, kind=kind, amount=amount, paid_at=paid_at, plan_id=plan_id)
            if kind == "initial":
                db.execute("UPDATE orders SET status='paid' WHERE invoice_id=?", (invoice,))
                db.execute("DELETE FROM payment_checks WHERE user_id=? AND transaction_id=?", (user_id, tx))
                db.execute("INSERT INTO subscriptions(user_id,status,next_at,updated_at,plan) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,provider_id=NULL,next_at=excluded.next_at,updated_at=excluded.updated_at,plan=excluded.plan", (user_id, "creating", iso(add_period(utc_now(), plan)), paid_at, plan_id))
            else:
                db.execute("UPDATE subscriptions SET next_at=?,updated_at=? WHERE user_id=? AND status IN ('active','pastdue')", (iso(add_period(utc_now(), plan)), paid_at, user_id))
            db.execute("COMMIT")
        except Exception:
            db.execute("ROLLBACK")
            raise
        if kind == "initial":
            token = data.get("Token")
            next_at = add_period(utc_now(), plan)
            if not token or "@" not in data.get("Email", ""):
                db.execute("UPDATE subscriptions SET status='needs_review',updated_at=? WHERE user_id=?", (iso(utc_now()), user_id))
            else:
                try:
                    result = await cloud_request(request.app, "/subscriptions/create", {"Token": token, "AccountId": account, "Description": f"Ghost: подписка {plan['renew']} ₽ / {plan['label']}", "Amount": plan["renew"], "Currency": "RUB", "RequireConfirmation": False, "StartDate": next_at.strftime("%Y-%m-%dT%H:%M:%S"), "Interval": plan["interval"], "Period": plan["period"], "Email": data.get("Email", ""), "CustomerReceipt": customer_receipt(request.app["config"], plan["renew"], data.get("Email", ""))})
                    provider_id = (result.get("Model") or {}).get("Id") if result.get("Success") else None
                    db.execute("UPDATE subscriptions SET status=?,provider_id=?,next_at=?,updated_at=? WHERE user_id=?", ("active" if provider_id else "needs_review", provider_id, iso(next_at), iso(utc_now()), user_id))
                except Exception:
                    # The bank may have created the subscription despite a timeout.
                    # Never automatically retry creation or assume cancellation.
                    db.execute("UPDATE subscriptions SET status='needs_review',updated_at=? WHERE user_id=?", (iso(utc_now()), user_id))
        return web.json_response({"code": 0})


async def cloud_fail(request: web.Request) -> web.Response:
    raw = await request.read()
    if not verified_webhook(request, raw):
        return web.json_response({"code": 13})
    data = await request.post()
    tx = data.get("TransactionId", "")
    user_id = webhook_user(request.app["db"], data)
    if user_id is None or not str(tx).isdigit():
        return web.json_response({"code": 10})
    request.app["db"].execute("DELETE FROM payment_checks WHERE user_id=? AND transaction_id=?", (user_id, tx))
    return web.json_response({"code": 0})


async def cloud_recurrent(request: web.Request) -> web.Response:
    raw = await request.read()
    if not verified_webhook(request, raw):
        return web.json_response({"code": 13})
    data = await request.post()
    user_id = webhook_user(request.app["db"], data, recurrent=True)
    if user_id is None:
        return web.json_response({"code": 10})
    provider_id = data.get("Id", "")
    status = str(data.get("Status", "")).lower()
    if status not in ("active", "pastdue", "cancelled", "rejected", "expired"):
        return web.json_response({"code": 10})
    async with LOCKS.setdefault(user_id, asyncio.Lock()):
        db = request.app["db"]
        row = db.execute("SELECT * FROM subscriptions WHERE user_id=? AND provider_id=?", (user_id, provider_id)).fetchone()
        if not row:
            return web.json_response({"code": 10})
        # Ignore out-of-order events that would reactivate a cancelled subscription.
        if row["status"] in ("cancelled", "cancellation_pending") and status not in ("cancelled", "rejected", "expired"):
            return web.json_response({"code": 0})
        db.execute("UPDATE subscriptions SET status=?,updated_at=? WHERE user_id=?", (status, iso(utc_now()), user_id))
    return web.json_response({"code": 0})


async def deliver_outbox(app: web.Application) -> None:
    db, cfg = app["db"], app["config"]
    url = cfg["GHOST_EVENT_URL"]
    path = urlparse(url).path or "/"
    for row in db.execute("SELECT event_id,payload FROM outbox WHERE delivered_at IS NULL ORDER BY rowid LIMIT 20").fetchall():
        raw = row["payload"].encode()
        timestamp = str(int(time.time()))
        headers = {"content-type": "application/json", "X-Ghost-Timestamp": timestamp, "X-Ghost-Signature": signature(cfg["GHOST_EVENT_SECRET"], timestamp, "POST", path, raw)}
        try:
            async with app["session"].post(url, data=raw, headers=headers) as response:
                body = await response.json(content_type=None)
                if response.status == 200 and body.get("ok") is True:
                    db.execute("UPDATE outbox SET delivered_at=?,attempts=attempts+1 WHERE event_id=?", (iso(utc_now()), row["event_id"]))
                    continue
        except Exception:
            pass
        db.execute("UPDATE outbox SET attempts=attempts+1 WHERE event_id=?", (row["event_id"],))


async def worker(app: web.Application) -> None:
    while True:
        try:
            await deliver_outbox(app)
        except asyncio.CancelledError:
            raise
        except Exception:
            app.logger.exception("Ghost payment outbox failed")
        await asyncio.sleep(15)


async def start(app: web.Application) -> None:
    app["db"] = initialize_database(app["config"]["GHOST_CHECKOUT_DATABASE"])
    # A previous crash during provider creation leaves an ambiguous outcome;
    # an operator must reconcile it instead of attempting a duplicate creation.
    app["db"].execute("UPDATE subscriptions SET status='needs_review',updated_at=? WHERE status='creating'", (iso(utc_now()),))
    app["session"] = ClientSession(timeout=ClientTimeout(total=15))
    app["worker"] = asyncio.create_task(worker(app))


async def stop(app: web.Application) -> None:
    app["worker"].cancel()
    try:
        await app["worker"]
    except asyncio.CancelledError:
        pass
    await app["session"].close()
    app["db"].close()


def build_app(config: dict[str, str] | None = None) -> web.Application:
    app = web.Application(client_max_size=32 * 1024)
    app["config"] = config or configuration()
    app.on_startup.append(start)
    app.on_cleanup.append(stop)
    async def logo(request: web.Request) -> web.Response:
        return web.FileResponse(ROOT / "ghost-avatar.png")
    async def offer_art(request: web.Request) -> web.Response:
        return web.FileResponse(ROOT / "offer-art.png")
    app.add_routes([web.post("/internal/ghost/checkout", internal_checkout), web.post("/internal/ghost/status", internal_status), web.post("/internal/ghost/cancel", internal_cancel), web.get("/assets/ghost-avatar.png", logo), web.get("/assets/offer-art.png", offer_art), web.get("/offer", offer), web.get("/tariffs", tariffs), web.get("/pay/{token}", page), web.post("/pay/{token}/confirm", confirm), web.post("/cp/check", cloud_check), web.post("/cp/pay", cloud_pay), web.post("/cp/fail", cloud_fail), web.post("/cp/recurrent", cloud_recurrent)])
    return app


if __name__ == "__main__":
    web.run_app(build_app(), host="127.0.0.1", port=int(os.environ.get("GHOST_CHECKOUT_PORT", "8093")), access_log=None)
