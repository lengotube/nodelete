import importlib.util
from pathlib import Path
import unittest
import sqlite3
import tempfile
import base64
import hashlib
import hmac
from unittest.mock import patch
from aiohttp.test_utils import make_mocked_request

spec = importlib.util.spec_from_file_location("callback_router", Path(__file__).resolve().parents[1] / "callback_router.py")
router = importlib.util.module_from_spec(spec)
spec.loader.exec_module(router)


class RoutingTest(unittest.TestCase):
    def test_namespaced_ghost(self):
        self.assertEqual(router.destination("application/x-www-form-urlencoded", b"AccountId=ghost%3A123&Amount=10"), "ghost")
        self.assertEqual(router.destination("application/json", b'{"AccountId":"ghost:123"}'), "ghost")

    def test_legacy_account(self):
        self.assertEqual(router.destination("application/x-www-form-urlencoded", b"AccountId=123"), "anonyx")
        self.assertEqual(router.destination("application/x-www-form-urlencoded", b"AccountId=rp2%3Aanon%3A123"), "anonyx")
        self.assertEqual(router.destination("application/x-www-form-urlencoded", b"AccountId=rp2%3An1%3A123"), "anonyx")

    def test_ambiguous_rejected(self):
        for payload in (b"Amount=10", b"AccountId=123&AccountId=ghost%3A123", b"AccountId=ghost%3Aabc", b"AccountId=other%3A123"):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                router.destination("application/x-www-form-urlencoded", payload)
        with self.assertRaises(ValueError):
            router.destination("application/json", b'{"AccountId":"123","AccountId":"ghost:123"}')

    def test_missing_account_with_known_identifiers(self):
        lookup = lambda invoice, subscription: (invoice, subscription) in {("ghost-order", ""), ("", "ghost-sub")}
        self.assertEqual(router.destination("application/x-www-form-urlencoded", b"InvoiceId=ghost-order", lookup, "pay"), "ghost")
        self.assertEqual(router.destination("application/x-www-form-urlencoded", b"SubscriptionId=ghost-sub", lookup, "pay"), "ghost")
        self.assertEqual(router.destination("application/x-www-form-urlencoded", b"Id=ghost-sub", lookup, "recurrent"), "ghost")
        self.assertEqual(router.destination("application/x-www-form-urlencoded", b"InvoiceId=rp2-order", lookup, "pay"), "anonyx")
        with self.assertRaises(ValueError):
            router.destination("application/x-www-form-urlencoded", b"InvoiceId=ghost-unknown", lookup, "pay")
        with self.assertRaises(ValueError):
            router.destination("application/x-www-form-urlencoded", b"SubscriptionId=unknown", lookup, "pay")

    def test_conflicting_identity_and_invoice(self):
        for raw in (b"AccountId=123&InvoiceId=ghost-order", b"AccountId=ghost%3A123&InvoiceId=rp2-order"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                router.destination("application/x-www-form-urlencoded", raw)

    def test_real_read_only_ownership_lookup(self):
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / "checkout.sqlite"
            with sqlite3.connect(database) as db:
                db.execute("CREATE TABLE orders(invoice_id TEXT)")
                db.execute("CREATE TABLE subscriptions(provider_id TEXT)")
                db.execute("INSERT INTO orders VALUES ('ghost-abc')")
                db.execute("INSERT INTO subscriptions VALUES ('sub-abc')")
            db.close()
            with patch.dict(router.os.environ, {"GHOST_CHECKOUT_DATABASE": str(database)}):
                self.assertTrue(router.ghost_lookup("ghost-abc", ""))
                self.assertTrue(router.ghost_lookup("", "sub-abc"))
                self.assertFalse(router.ghost_lookup("ghost-missing", "sub-missing"))


class ForwardTest(unittest.IsolatedAsyncioTestCase):
    async def test_exact_body_and_signature_and_routes(self):
        class Response:
            status = 200
            headers = {"Content-Type": "application/json"}
            async def read(self): return b'{"code":0}'
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass

        class Session:
            def post(self, url, **kwargs):
                self.url, self.kwargs = url, kwargs
                return Response()

        for path, payload, port in (("/cp/pay", b"AccountId=ghost%3A123&Amount=10", 8093),
                                    ("/cp/check", b"AccountId=123&Amount=1", 5082),
                                    ("/cp/pay", b"AccountId=rp2%3Aanon%3A123&Amount=1", 5082),
                                    ("/cp/pay", b"AccountId=rp2%3An1%3A123&Amount=1", 5082),
                                    ("/cp/recurrent", b"AccountId=123&Id=x", 8082)):
            session = Session()
            request = make_mocked_request("POST", path, headers={"Content-Type": "application/x-www-form-urlencoded", "Content-HMAC": "signature"}, app={"session": session})
            async def read(): return payload
            request.read = read
            with patch.object(router, "ghost_lookup", return_value=False):
                response = await router.route(request)
            self.assertEqual(response.status, 200)
            self.assertEqual(session.url, f"http://127.0.0.1:{port}{path}")
            self.assertEqual(session.kwargs["data"], payload)
            self.assertIn(("Content-HMAC", "signature"), session.kwargs["headers"])

    async def test_resolve_missing_account_through_provider_and_preserve_body(self):
        raw = b"TransactionId=123&Amount=10"
        signature = base64.b64encode(hmac.new(b"secret", raw, hashlib.sha256).digest()).decode()
        class Response:
            status = 200
            headers = {"Content-Type": "application/json"}
            def __init__(self, provider): self.provider = provider
            async def json(self): return {"Success": True, "Model": {"AccountId": "ghost:123"}}
            async def read(self): return b'{"code":0}'
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
        class Session:
            def __init__(self): self.calls = []
            def post(self, url, **kwargs):
                self.calls.append((url, kwargs))
                return Response(url.startswith("https://"))
        session = Session()
        request = make_mocked_request("POST", "/cp/pay", headers={"Content-Type": "application/x-www-form-urlencoded", "Content-HMAC": signature}, app={"session": session})
        async def read(): return raw
        request.read = read
        with patch.dict(router.os.environ, {"CLOUDPAYMENTS_PUBLIC_ID": "test", "CLOUDPAYMENTS_API_SECRET": "secret"}):
            response = await router.route(request)
        self.assertEqual(response.status, 200)
        self.assertEqual(session.calls[0][0], "https://api.cloudpayments.ru/payments/get")
        self.assertEqual(session.calls[1][0], "http://127.0.0.1:8093/cp/pay")
        self.assertEqual(session.calls[1][1]["data"], raw)
        self.assertIn(("Content-HMAC", signature), session.calls[1][1]["headers"])

    async def test_invalid_signature_never_calls_provider(self):
        class Session:
            def post(self, *args, **kwargs): raise AssertionError("unexpected network")
        raw = b"TransactionId=123"
        request = make_mocked_request("POST", "/cp/pay", headers={"Content-Type": "application/x-www-form-urlencoded", "Content-HMAC": "wrong"}, app={"session": Session()})
        async def read(): return raw
        request.read = read
        with patch.dict(router.os.environ, {"CLOUDPAYMENTS_PUBLIC_ID": "test", "CLOUDPAYMENTS_API_SECRET": "secret"}):
            with self.assertRaises(router.web.HTTPForbidden):
                await router.route(request)

    async def test_provider_subscription_and_conflict(self):
        raw = b"TransactionId=123&SubscriptionId=sub-abc"
        signature = base64.b64encode(hmac.new(b"secret", raw, hashlib.sha256).digest()).decode()
        class Response:
            status = 200
            def __init__(self, account): self.account = account
            async def json(self): return {"Success": True, "Model": {"AccountId": self.account}}
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
        class Session:
            def post(self, url, **kwargs): return Response("ghost:123" if url.endswith("payments/get") else "123")
        request = make_mocked_request("POST", "/cp/pay", headers={"Content-Type": "application/x-www-form-urlencoded", "Content-HMAC": signature}, app={"session": Session()})
        async def read(): return raw
        request.read = read
        with patch.dict(router.os.environ, {"CLOUDPAYMENTS_PUBLIC_ID": "test", "CLOUDPAYMENTS_API_SECRET": "secret"}):
            with self.assertRaises(router.web.HTTPServiceUnavailable):
                await router.route(request)

    async def test_provider_rate_limit_does_not_ack(self):
        raw = b"TransactionId=123"
        signature = base64.b64encode(hmac.new(b"secret", raw, hashlib.sha256).digest()).decode()
        class Response:
            status = 429
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
        class Session:
            def post(self, url, **kwargs): return Response()
        request = make_mocked_request("POST", "/cp/pay", headers={"Content-Type": "application/x-www-form-urlencoded", "Content-HMAC": signature}, app={"session": Session()})
        async def read(): return raw
        request.read = read
        with patch.dict(router.os.environ, {"CLOUDPAYMENTS_PUBLIC_ID": "test", "CLOUDPAYMENTS_API_SECRET": "secret"}):
            with self.assertRaises(router.web.HTTPServiceUnavailable):
                await router.route(request)
