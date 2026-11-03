import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from aiohttp.test_utils import make_mocked_request

spec = importlib.util.spec_from_file_location("callback_router", Path(__file__).resolve().parents[1] / "callback_router.py")
router = importlib.util.module_from_spec(spec)
spec.loader.exec_module(router)
FORM = "application/x-www-form-urlencoded"


def broken_lookup(invoice, subscription):
    raise ValueError("ownership database unavailable")


class RoutingTest(unittest.TestCase):
    def test_ghost_markers(self):
        self.assertEqual(router.destination(FORM, b"AccountId=ghost%3A123&Amount=10"), "ghost")
        self.assertEqual(router.destination("application/json", b'{"AccountId":"ghost:123"}'), "ghost")
        self.assertEqual(router.destination(FORM, b"InvoiceId=ghost-order"), "ghost")
        self.assertEqual(router.destination(FORM, b"SubscriptionId=sub", lambda i, s: True, "pay"), "ghost")
        self.assertEqual(router.destination(FORM, b"Id=sub", lambda i, s: True, "recurrent"), "ghost")

    def test_everything_else_is_anonyx(self):
        for raw in (b"AccountId=123", b"AccountId=rp2%3Aanon%3A123", b"AccountId=rp2%3An1%3A123", b"InvoiceId=rp2-order",
                    b"AccountId=abc", b"AccountId=ghost%3Aabc", b"Amount=1", b"", b"AccountId=1&AccountId=2", b"\xff"):
            with self.subTest(raw=raw):
                self.assertEqual(router.destination(FORM, raw, broken_lookup, "pay"), "anonyx")
        self.assertEqual(router.destination("text/plain", b"AccountId=ghost%3A1"), "anonyx")
        self.assertEqual(router.destination("application/json", b"not json"), "anonyx")

    def test_anonyx_subscription_never_touches_ghost(self):
        def fail(invoice, subscription):
            raise AssertionError("Ghost lookup must not run for an Anonyx account")
        self.assertEqual(router.destination(FORM, b"AccountId=123&SubscriptionId=sub", fail, "pay"), "anonyx")
        self.assertEqual(router.destination(FORM, b"AccountId=123&Id=sub", fail, "recurrent"), "anonyx")

    def test_ghost_database_failure_does_not_block(self):
        self.assertEqual(router.destination(FORM, b"SubscriptionId=sub", broken_lookup, "pay"), "anonyx")
        self.assertEqual(router.destination(FORM, b"SubscriptionId=sub", lambda i, s: False, "pay"), "anonyx")

    def test_both_services_marked_is_refused(self):
        for raw in (b"AccountId=ghost%3A123&InvoiceId=rp2-order", b"AccountId=123&InvoiceId=ghost-order"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                router.destination(FORM, raw)

    def test_real_read_only_lookup(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "payments.sqlite3"
            db = sqlite3.connect(path)
            db.execute("CREATE TABLE orders(invoice_id TEXT)")
            db.execute("CREATE TABLE subscriptions(provider_id TEXT)")
            db.execute("INSERT INTO orders VALUES('ghost-abc')")
            db.execute("INSERT INTO subscriptions VALUES('sub-abc')")
            db.commit()
            db.close()
            with patch.dict(router.os.environ, {"GHOST_CHECKOUT_DATABASE": str(path)}):
                self.assertTrue(router.ghost_lookup("ghost-abc", ""))
                self.assertTrue(router.ghost_lookup("", "sub-abc"))
                self.assertFalse(router.ghost_lookup("ghost-missing", "sub-missing"))


class ForwardingTest(unittest.IsolatedAsyncioTestCase):
    def session(self, status=200):
        class Response:
            headers = {"Content-Type": "application/json"}
            async def read(self): return b'{"code":0}'
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
        Response.status = status

        class Session:
            def post(self, url, **kwargs):
                self.url, self.kwargs = url, kwargs
                return Response()
        return Session()

    def request(self, path, payload, session):
        request = make_mocked_request("POST", path, headers={"Content-Type": FORM, "Content-HMAC": "signature"}, app={"session": session})
        async def read(): return payload
        request.read = read
        return request

    async def test_exact_body_signature_and_port(self):
        for path, payload, port in (("/cp/pay", b"AccountId=ghost%3A123&Amount=10", 8093),
                                    ("/cp/recurrent", b"AccountId=ghost%3A123&Id=x", 8093),
                                    ("/cp/check", b"AccountId=123&Amount=1", 5082),
                                    ("/cp/pay", b"AccountId=rp2%3Aanon%3A123&Amount=1", 5082),
                                    ("/cp/recurrent", b"AccountId=123&Id=x", 8082)):
            session = self.session()
            response = await router.route(self.request(path, payload, session))
            self.assertEqual(response.status, 200)
            self.assertEqual(session.url, f"http://127.0.0.1:{port}{path}")
            self.assertEqual(session.kwargs["data"], payload)
            self.assertIn(("Content-HMAC", "signature"), session.kwargs["headers"])

    async def test_anonyx_status_is_passed_through(self):
        response = await router.route(self.request("/cp/check", b"AccountId=123", self.session(403)))
        self.assertEqual(response.status, 403)

    async def test_ghost_error_makes_provider_retry(self):
        with self.assertRaises(router.web.HTTPServiceUnavailable):
            await router.route(self.request("/cp/pay", b"AccountId=ghost%3A123", self.session(500)))


if __name__ == "__main__":
    unittest.main()
