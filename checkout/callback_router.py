"""Optional isolated CloudPayments callback router; NOT deployed automatically."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from urllib.parse import parse_qsl

from aiohttp import ClientError, ClientSession, ClientTimeout, web

TYPES = ("check", "pay", "fail", "recurrent")
HOP = {"host", "connection", "content-length", "transfer-encoding", "keep-alive", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate"}


def fields_from_body(content_type, raw):
    if content_type == "application/x-www-form-urlencoded":
        fields = parse_qsl(raw.decode("utf-8", errors="strict"), keep_blank_values=True, strict_parsing=True)
    elif content_type == "application/json":
        fields = json.loads(raw, object_pairs_hook=list)
        if not isinstance(fields, list) or not all(isinstance(p, tuple) and len(p) == 2 for p in fields):
            raise ValueError("invalid JSON object")
    else:
        raise ValueError("unsupported content type")
    result = {}
    for name in ("AccountId", "InvoiceId", "SubscriptionId", "TransactionId", "Id"):
        values = [v for k, v in fields if isinstance(k, str) and k.lower() == name.lower()]
        if len(values) > 1 or (values and not isinstance(values[0], str)):
            raise ValueError("ambiguous field")
        result[name] = values[0] if values else ""
    return result


def destination(content_type, raw, lookup=None, kind="", resolved_account=""):
    """Route only when identifiers prove one owner; never mutate request bytes."""
    data = fields_from_body(content_type, raw)
    def one(name): return data[name]

    account, invoice = one("AccountId"), one("InvoiceId")
    if resolved_account:
        if account and account != resolved_account:
            raise ValueError("account conflict")
        account = resolved_account
    subscription = one("Id") if kind == "recurrent" else one("SubscriptionId")
    evidence = set()
    if account:
        if re.fullmatch(r"ghost:[1-9][0-9]{0,19}", account): evidence.add("ghost")
        elif re.fullmatch(r"(?:rp2:(?:anon|n1):)?[1-9][0-9]{0,19}", account): evidence.add("anonyx")
        else: raise ValueError("unrecognized account")
    if invoice.startswith("ghost-"):
        evidence.add("ghost")
    elif invoice.startswith("rp2-"):
        evidence.add("anonyx")
    # For absent account, a prefix is not enough: verify the exact order or
    # subscription exists locally before forwarding any signed notification.
    needs_lookup = (not account and (invoice.startswith("ghost-") or subscription)) or (account and "anonyx" in evidence and bool(subscription))
    if needs_lookup:
        if lookup is None:
            raise ValueError("ownership lookup unavailable")
        if lookup(invoice, subscription): evidence.add("ghost")
        elif invoice.startswith("ghost-"): raise ValueError("unknown ghost order")
    if len(evidence) != 1:
        raise ValueError("ambiguous ownership")
    return evidence.pop()


def recognized_account(account):
    return bool(re.fullmatch(r"(?:ghost:|rp2:(?:anon|n1):)?[1-9][0-9]{0,19}", account))


def verify_provider_signature(request, raw):
    public_id, secret = os.getenv("CLOUDPAYMENTS_PUBLIC_ID", ""), os.getenv("CLOUDPAYMENTS_API_SECRET", "")
    if not public_id or not secret:
        raise ValueError("provider credentials unavailable")
    signature = base64.b64encode(hmac.new(secret.encode(), raw, hashlib.sha256).digest()).decode()
    if not hmac.compare_digest(signature, request.headers.get("Content-HMAC", "")):
        raise web.HTTPForbidden(text="Invalid callback signature")
    return public_id, secret


async def provider_account(request, raw, data, kind):
    public_id, secret = verify_provider_signature(request, raw)
    tx = data["TransactionId"]
    sub = data["Id"] if kind == "recurrent" else data["SubscriptionId"]
    if tx and not re.fullmatch(r"[0-9]{1,20}", tx): raise ValueError("invalid transaction")
    if sub and not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", sub): raise ValueError("invalid subscription")
    checks = []
    if tx: checks.append(("/payments/get", {"TransactionId": int(tx)}))
    if sub: checks.append(("/subscriptions/get", {"Id": sub}))
    if not checks: raise ValueError("no provider identifier")
    auth = base64.b64encode(f"{public_id}:{secret}".encode()).decode()
    accounts = set()
    limiter = request.app.get("provider_limit")
    acquired = False
    try:
        if limiter is not None:
            await asyncio.wait_for(limiter.acquire(), timeout=0.5)
            acquired = True
        for path, payload in checks:
            async with request.app["session"].post("https://api.cloudpayments.ru" + path, json=payload,
                    headers={"Authorization": "Basic " + auth}, timeout=ClientTimeout(total=5), allow_redirects=False) as resp:
                if resp.status != 200: raise ValueError("provider lookup unavailable")
                result = await resp.json()
                model = result.get("Model") if result.get("Success") is True else None
                account = model.get("AccountId") if isinstance(model, dict) else None
                if not isinstance(account, str) or not recognized_account(account): raise ValueError("provider ownership unclear")
                accounts.add(account)
    except (ClientError, asyncio.TimeoutError, OSError) as exc:
        raise ValueError("provider lookup unavailable") from exc
    finally:
        if acquired: limiter.release()
    if len(accounts) != 1: raise ValueError("provider ownership conflict")
    return accounts.pop()


def ghost_lookup(invoice, subscription):
    path = os.environ.get("GHOST_CHECKOUT_DATABASE", "")
    if not path or not Path(path).is_file():
        raise ValueError("ownership database unavailable")
    try:
        with closing(sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
            if invoice and db.execute("SELECT 1 FROM orders WHERE invoice_id=?", (invoice,)).fetchone(): return True
            if subscription and db.execute("SELECT 1 FROM subscriptions WHERE provider_id=?", (subscription,)).fetchone(): return True
    except sqlite3.Error as exc:
        raise ValueError("ownership lookup failed") from exc
    return False


async def route(request):
    if request.headers.get("Content-Encoding", "identity").lower() != "identity":
        raise web.HTTPServiceUnavailable(text="Unsupported callback encoding")
    raw = await request.read()
    try:
        kind = request.path.rsplit("/", 1)[-1]
        data = fields_from_body(request.content_type, raw)
        resolved = ""
        if not recognized_account(data["AccountId"]):
            sub = data["Id"] if kind == "recurrent" else data["SubscriptionId"]
            if data["TransactionId"] or sub:
                resolved = await provider_account(request, raw, data, kind)
            else:
                verify_provider_signature(request, raw)
        target = destination(request.content_type, raw, ghost_lookup, kind, resolved)
    except (ValueError, UnicodeError, json.JSONDecodeError):
        raise web.HTTPServiceUnavailable(text="Ambiguous callback")
    if target == "ghost":
        port = 8093
    else:
        port = 8082 if kind == "recurrent" else 5082
    headers = [(k, v) for k, v in request.headers.items() if k.lower() not in HOP]
    try:
        async with request.app["session"].post(f"http://127.0.0.1:{port}/cp/{kind}", data=raw, headers=headers, allow_redirects=False) as response:
            body = await response.read()
            if response.status >= 400:
                raise web.HTTPServiceUnavailable(text="Callback upstream unavailable")
            response_headers = [(k, v) for k, v in response.headers.items() if k.lower() not in HOP]
            return web.Response(status=response.status, body=body, headers=response_headers)
    except (asyncio.TimeoutError, OSError, ClientError):
        raise web.HTTPServiceUnavailable(text="Callback upstream unavailable")


async def start(app):
    app["session"] = ClientSession(timeout=ClientTimeout(total=25), auto_decompress=False)


async def stop(app):
    await app["session"].close()


def build_app():
    app = web.Application(client_max_size=64 * 1024)
    app["provider_limit"] = asyncio.Semaphore(8)
    app.on_startup.append(start)
    app.on_cleanup.append(stop)
    for kind in TYPES:
        app.router.add_post("/cp/" + kind, route, name=kind)
    return app


if __name__ == "__main__":
    web.run_app(build_app(), host="127.0.0.1", port=int(os.getenv("GHOST_CALLBACK_ROUTER_PORT", "8096")), access_log=None)
