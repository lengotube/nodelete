"""CloudPayments callback router for the terminal shared by Anonyx and Ghost.

Anonyx is the terminal's original owner, so it is the default: a callback goes
to Ghost only when it carries a Ghost marker. Nothing here may stop an Anonyx
callback: no provider API calls, and a Ghost database failure only affects the
Ghost lookup. Each service verifies the signature itself.
If this process is down, nginx sends callbacks straight to Anonyx.
"""
import asyncio
import json
import logging
import os
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from urllib.parse import parse_qsl

from aiohttp import ClientError, ClientSession, ClientTimeout, web

TYPES = ("check", "pay", "fail", "recurrent")
HOP = {"host", "connection", "content-length", "transfer-encoding", "keep-alive", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate"}
GHOST_TIMEOUT = ClientTimeout(total=25)
ANONYX_TIMEOUT = ClientTimeout(total=60)
log = logging.getLogger("ghost-router")


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
    for name in ("AccountId", "InvoiceId", "SubscriptionId", "Id"):
        values = [v for k, v in fields if isinstance(k, str) and k.lower() == name.lower()]
        if len(values) > 1 or (values and not isinstance(values[0], str)):
            raise ValueError("ambiguous field")
        result[name] = values[0] if values else ""
    return result


def destination(content_type, raw, lookup=None, kind=""):
    """Return "ghost" only on a Ghost marker, otherwise "anonyx"; never mutate bytes.

    Raises ValueError only when one callback carries markers of both services:
    Anonyx acknowledges an account it cannot read, so a Ghost payment sent there
    would be lost. The 503 makes CloudPayments retry and leaves it visible.
    """
    try:
        data = fields_from_body(content_type, raw)
    except (ValueError, UnicodeError):
        return "anonyx"
    account, invoice = data["AccountId"], data["InvoiceId"]
    subscription = data["Id"] if kind == "recurrent" else data["SubscriptionId"]
    ghost = bool(re.fullmatch(r"ghost:[1-9][0-9]{0,19}", account)) or invoice.startswith("ghost-")
    anonyx_account = bool(re.fullmatch(r"(?:rp2:(?:anon|n1):)?[1-9][0-9]{0,19}", account))
    if ghost and (anonyx_account or invoice.startswith("rp2-")):
        raise ValueError("conflicting ownership")
    if ghost:
        return "ghost"
    if not account and subscription and lookup is not None:
        try:
            if lookup(invoice, subscription):
                return "ghost"
        except (ValueError, OSError):
            log.exception("Ghost subscription lookup failed; sending the callback to Anonyx")
    return "anonyx"


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
    raw = await request.read()
    kind = request.path.rsplit("/", 1)[-1]
    try:
        target = destination(request.content_type, raw, ghost_lookup, kind)
    except ValueError:
        log.error("Callback carries markers of both services: kind=%s", kind)
        raise web.HTTPServiceUnavailable(text="Ambiguous callback")
    if target == "ghost":
        port, timeout = 8093, GHOST_TIMEOUT
    else:
        port, timeout = (8082 if kind == "recurrent" else 5082), ANONYX_TIMEOUT
    headers = [(k, v) for k, v in request.headers.items() if k.lower() not in HOP]
    try:
        async with request.app["session"].post(f"http://127.0.0.1:{port}/cp/{kind}", data=raw, headers=headers, allow_redirects=False, timeout=timeout) as response:
            body = await response.read()
            # Anonyx answers exactly as it did without the router.
            if target == "ghost" and response.status >= 400:
                raise web.HTTPServiceUnavailable(text="Callback upstream unavailable")
            response_headers = [(k, v) for k, v in response.headers.items() if k.lower() not in HOP]
            return web.Response(status=response.status, body=body, headers=response_headers)
    except (asyncio.TimeoutError, OSError, ClientError):
        raise web.HTTPServiceUnavailable(text="Callback upstream unavailable")


async def start(app):
    app["session"] = ClientSession(auto_decompress=False)


async def stop(app):
    await app["session"].close()


def build_app():
    app = web.Application(client_max_size=64 * 1024)
    app.on_startup.append(start)
    app.on_cleanup.append(stop)
    for kind in TYPES:
        app.router.add_post("/cp/" + kind, route, name=kind)
    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    web.run_app(build_app(), host="127.0.0.1", port=int(os.getenv("GHOST_CALLBACK_ROUTER_PORT", "8096")), access_log=None)
