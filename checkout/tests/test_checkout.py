import base64
import hashlib
import hmac
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import urlencode

from aiohttp.test_utils import TestClient, TestServer

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app as checkout


class CheckoutTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.config = {
            "GHOST_CHECKOUT_PUBLIC_URL": "https://checkout.invalid/ghost",
            "GHOST_CHECKOUT_DATABASE": self.directory.name + "/payments.sqlite",
            "GHOST_CHECKOUT_INTERNAL_SECRET": "i" * 32,
            "GHOST_EVENT_SECRET": "e" * 32,
            "GHOST_EVENT_URL": "http://127.0.0.1:9/api/card-payment-event",
            "CLOUDPAYMENTS_PUBLIC_ID": "test-public",
            "CLOUDPAYMENTS_API_SECRET": "test-provider-secret",
            "GHOST_SELLER_NAME": "Test seller",
            "GHOST_SELLER_INN": "test-inn",
            "GHOST_SELLER_REGISTRATION": "test-registration",
            "GHOST_SELLER_EMAIL": "support@example.invalid",
            "GHOST_SUPPORT_URL": "https://t.me/test_support",
            "GHOST_OFFER_URL": "https://example.invalid/offer",
            "GHOST_PRIVACY_URL": "https://example.invalid/privacy",
            "GHOST_TERMS_VERSION": "test-1",
            "GHOST_RECEIPT_TAXATION": "1",
            "GHOST_RECEIPT_VAT": "none",
            "GHOST_RECEIPT_LABEL": "Ghost subscription",
        }
        self.app = checkout.build_app(self.config)
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.directory.cleanup()

    async def internal(self, path, body=None, *, secret=None, signature_path=None):
        raw = json.dumps(body or {"user_id": 123}, separators=(",", ":")).encode()
        timestamp = str(int(time.time()))
        sig = checkout.signature(secret or self.config["GHOST_CHECKOUT_INTERNAL_SECRET"], timestamp, "POST", signature_path or path, raw)
        return await self.client.post(path, data=raw, headers={"X-Ghost-Timestamp": timestamp, "X-Ghost-Signature": sig, "Content-Type": "application/json"})

    async def hook(self, path, data, *, valid=True):
        raw = urlencode(data).encode()
        digest = base64.b64encode(hmac.new(self.config["CLOUDPAYMENTS_API_SECRET"].encode(), raw, hashlib.sha256).digest()).decode()
        return await self.client.post(path, data=raw, headers={"Content-HMAC": digest if valid else "wrong", "Content-Type": "application/x-www-form-urlencoded"})

    async def order(self):
        res = await self.internal("/internal/ghost/checkout")
        self.assertEqual(res.status, 200)
        token = (await res.json())["url"].rsplit("/", 1)[-1]
        denied = await self.client.post(f"/pay/{token}/confirm", json={"accept_offer": True, "accept_recurring": False})
        self.assertEqual(denied.status, 400)
        res = await self.client.post(f"/pay/{token}/confirm", json={"accept_offer": True, "accept_recurring": True, "email": "buyer@example.invalid"})
        self.assertEqual(res.status, 200)
        return token, await res.json()

    async def test_internal_auth_binds_endpoint(self):
        res = await self.internal("/internal/ghost/cancel", signature_path="/internal/ghost/status")
        self.assertEqual(res.status, 403)
        self.assertFalse(checkout.verify_internal("x" * 32, str(int(time.time()) - 301), "x", "POST", "/test", b"{}"))

    async def test_initial_and_recurring_payments_are_validated_and_idempotent(self):
        token, order = await self.order()
        page = await self.client.get(f"/pay/{token}")
        html = await page.text()
        self.assertIn('"renew": 79', html)
        self.assertIn('"frequency": "каждые 7 дней"', html)
        self.assertIn("cfg.basePath+'/tariffs#recurrent'", html)
        self.assertNotIn('id="offer-media"', html)
        tariffs = await self.client.get('/tariffs')
        tariffs_html = await tariffs.text()
        self.assertEqual(tariffs.status, 200)
        self.assertIn('79 ₽ каждые 7 дней', tariffs_html)
        self.assertIn('/unsub', tariffs_html)
        self.assertIn('"basePath": "/ghost"', html)
        self.assertIn("cfg.basePath+'/pay/'", html)
        self.assertIn("requireEmail:true", html)
        data = {"AccountId": order["account_id"], "InvoiceId": order["invoice_id"], "TransactionId": "1234", "Amount": "10.00", "Currency": "RUB", "Token": "test-card-token", "Email": "buyer@example.invalid"}
        self.assertEqual((await (await self.hook("/cp/check", data, valid=False)).json())["code"], 13)
        wrong = {**data, "Amount": "1"}
        self.assertNotEqual((await (await self.hook("/cp/check", wrong)).json())["code"], 0)
        self.assertEqual((await (await self.hook("/cp/check", data)).json())["code"], 0)
        self.assertNotEqual((await (await self.hook("/cp/check", {**data, "TransactionId":"999"})).json())["code"], 0)
        with patch.object(checkout, "cloud_request", new=AsyncMock(return_value={"Success": True, "Model": {"Id": "provider-sub"}})) as cp:
            self.assertEqual((await (await self.hook("/cp/pay", data)).json())["code"], 0)
            self.assertEqual((await (await self.hook("/cp/pay", data)).json())["code"], 0)
            self.assertEqual(cp.await_count, 1)
            self.assertEqual(cp.await_args.args[2]["Amount"], 79)
            self.assertEqual(cp.await_args.args[2]["CustomerReceipt"]["amounts"]["electronic"], 79)
            self.assertEqual(cp.await_args.args[2]["CustomerReceipt"]["email"], "buyer@example.invalid")
            self.assertEqual(cp.await_args.args[2]["Interval"], "Week")
            self.assertEqual(cp.await_args.args[2]["Period"], 1)
        renewal = {"AccountId": order["account_id"], "TransactionId": "1235", "SubscriptionId": "provider-sub", "Amount": "79", "Currency": "RUB"}
        self.assertEqual((await (await self.hook("/cp/pay", renewal)).json())["code"], 0)
        self.assertEqual((await (await self.hook("/cp/pay", renewal)).json())["code"], 0)
        payments = self.app["db"].execute("SELECT * FROM payments ORDER BY transaction_id").fetchall()
        self.assertEqual([(p["kind"], p["amount"]) for p in payments], [("initial", 10), ("renewal", 79)])
        self.assertEqual(self.app["db"].execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 2)
        event = json.loads(self.app["db"].execute("SELECT payload FROM outbox WHERE event_id='cp:1235'").fetchone()[0])
        self.assertEqual(event["invoice_id"], "subscription:provider-sub")
        self.assertNotIn("test-card-token", str([dict(p) for p in payments]))

    async def test_regular_weekly_plan_charges_79_even_after_promo_was_used(self):
        db = self.app["db"]
        db.execute("INSERT INTO payments(transaction_id,invoice_id,user_id,kind,amount,paid_at,plan) VALUES('old','old',123,'initial',10,'now','lite')")
        status = await (await self.internal('/internal/ghost/status')).json()
        self.assertTrue(status['offer_used'])
        res = await self.internal('/internal/ghost/checkout', {'user_id': 123, 'plan': 'lite_regular'})
        self.assertEqual(res.status, 200)
        token = (await res.json())['url'].rsplit('/', 1)[-1]
        order = await (await self.client.post(f'/pay/{token}/confirm', json={'accept_offer': True, 'accept_recurring': True, 'email': 'buyer@example.invalid'})).json()
        self.assertEqual(order['amount'], 79)
        data = {'AccountId': order['account_id'], 'InvoiceId': order['invoice_id'], 'TransactionId': '9010', 'Amount': '79', 'Currency': 'RUB', 'Token': 'test-token', 'Email': 'buyer@example.invalid'}
        self.assertEqual((await (await self.hook('/cp/check', data)).json())['code'], 0)
        with patch.object(checkout, 'cloud_request', new=AsyncMock(return_value={'Success': True, 'Model': {'Id': 'regular-week'}})) as cp:
            self.assertEqual((await (await self.hook('/cp/pay', data)).json())['code'], 0)
            self.assertEqual(cp.await_args.args[2]['Amount'], 79)
        event = json.loads(db.execute("SELECT payload FROM outbox WHERE event_id='cp:9010'").fetchone()[0])
        self.assertEqual((event['plan'], event['amount'], event['period_days']), ('lite_regular', 79, 7))

    async def test_all_paid_plans_create_and_renew_with_server_prices(self):
        for user_id, plan_id in enumerate(("plus", "quarter", "prime"), start=200):
            plan = checkout.PLANS[plan_id]
            response = await self.internal('/internal/ghost/checkout', {"user_id": user_id, "plan": plan_id})
            token = (await response.json())["url"].rsplit('/', 1)[-1]
            page = await (await self.client.get('/pay/' + token)).text()
            self.assertIn(f'"renew": {plan["renew"]}', page)
            order = await (await self.client.post(f'/pay/{token}/confirm', json={"accept_offer": True, "accept_recurring": True, "email": "buyer@example.invalid"})).json()
            self.assertEqual(order["amount"], plan["first"])
            self.assertEqual(order["receipt"]["amounts"]["electronic"], plan["first"])
            data = {"AccountId": order["account_id"], "InvoiceId": order["invoice_id"], "TransactionId": str(user_id * 10), "Amount": str(plan["first"]), "Currency": "RUB", "Token": "test-token", "Email": "buyer@example.invalid"}
            self.assertEqual((await (await self.hook('/cp/check', data)).json())["code"], 0)
            with patch.object(checkout, 'cloud_request', new=AsyncMock(return_value={"Success": True, "Model": {"Id": f'sub-{user_id}'}})) as cp:
                self.assertEqual((await (await self.hook('/cp/pay', data)).json())["code"], 0)
                self.assertEqual(cp.await_args.args[2]["Amount"], plan["renew"])
                self.assertEqual(cp.await_args.args[2]["Interval"], 'Month')
                self.assertEqual(cp.await_args.args[2]["Period"], plan["months"])
            renewal = {"AccountId": order["account_id"], "SubscriptionId": f'sub-{user_id}', "TransactionId": str(user_id * 10 + 1), "Amount": str(plan["renew"]), "Currency": "RUB"}
            self.assertEqual((await (await self.hook('/cp/pay', renewal)).json())["code"], 0)
            event = json.loads(self.app["db"].execute('SELECT payload FROM outbox WHERE event_id=?', (f'cp:{user_id * 10 + 1}',)).fetchone()[0])
            self.assertEqual((event["plan"], event["period_months"], event["amount"]), (plan_id, plan["months"], plan["renew"]))

    async def test_cancel_requires_provider_confirmation_and_cannot_reactivate(self):
        self.app["db"].execute("INSERT INTO subscriptions(user_id,status,provider_id,updated_at) VALUES(123,'active','sub-1','now')")
        with patch.object(checkout, "cloud_request", new=AsyncMock(side_effect=TimeoutError())):
            res = await self.internal("/internal/ghost/cancel")
        self.assertEqual(res.status, 503)
        row = self.app["db"].execute("SELECT status FROM subscriptions WHERE user_id=123").fetchone()
        self.assertEqual(row["status"], "cancellation_pending")
        with patch.object(checkout, "cloud_request", new=AsyncMock(return_value={"Success": True})):
            res = await self.internal("/internal/ghost/cancel")
        self.assertEqual((await res.json())["status"], "cancelled")
        await self.hook("/cp/recurrent", {"AccountId": "ghost:123", "Id": "sub-1", "Status": "Active"})
        self.assertEqual(self.app["db"].execute("SELECT status FROM subscriptions WHERE user_id=123").fetchone()[0], "cancelled")

    async def test_unknown_confirmed_payment_is_recorded_for_review(self):
        data = {"AccountId": "ghost:123", "SubscriptionId": "somebody-elses", "TransactionId": "55", "Amount": "79", "Currency": "RUB"}
        self.assertEqual((await (await self.hook("/cp/pay", data)).json())["code"], 0)
        self.assertEqual(self.app["db"].execute("SELECT COUNT(*) FROM payments").fetchone()[0], 0)
        self.assertEqual(self.app["db"].execute("SELECT reason FROM payment_anomalies WHERE transaction_id='55'").fetchone()[0], "unknown_or_inactive_subscription")

    async def test_signed_callbacks_resolve_missing_account_and_reject_conflicts(self):
        _, order = await self.order()
        data = {"InvoiceId": order["invoice_id"], "TransactionId": "620", "Amount": "10", "Currency": "RUB", "Token": "token", "Email": "buyer@example.invalid"}
        self.assertNotEqual((await (await self.hook('/cp/check', {**data, 'AccountId': 'ghost:999'})).json())["code"], 0)
        self.assertEqual((await (await self.hook('/cp/check', data)).json())["code"], 0)
        with patch.object(checkout, 'cloud_request', new=AsyncMock(return_value={"Success": True, "Model": {"Id": "sub-missing-account"}})) as cp:
            self.assertEqual((await (await self.hook('/cp/pay', data)).json())["code"], 0)
            self.assertEqual(cp.await_args.args[2]["AccountId"], 'ghost:123')
        renewal = {"SubscriptionId": "sub-missing-account", "TransactionId": "621", "Amount": "79", "Currency": "RUB"}
        self.assertNotEqual((await (await self.hook('/cp/pay', {**renewal, 'AccountId': 'ghost:999'})).json())["code"], 0)
        self.assertEqual((await (await self.hook('/cp/pay', renewal)).json())["code"], 0)
        self.assertEqual((await (await self.hook('/cp/recurrent', {"Id": "sub-missing-account", "Status": "Cancelled"})).json())["code"], 0)
        self.assertEqual(self.app["db"].execute("SELECT status FROM subscriptions WHERE user_id=123").fetchone()[0], 'cancelled')

    async def test_failed_payment_releases_only_its_own_reservation(self):
        _, order = await self.order()
        data = {"AccountId": order["account_id"], "InvoiceId": order["invoice_id"], "TransactionId": "301", "Amount": "10", "Currency": "RUB", "Email": "buyer@example.invalid"}
        self.assertEqual((await (await self.hook('/cp/check', data)).json())["code"], 0)
        self.assertEqual((await (await self.hook('/cp/fail', data, valid=False)).json())["code"], 13)
        self.assertNotEqual((await (await self.hook('/cp/check', {**data, "TransactionId":"302"})).json())["code"], 0)
        self.assertEqual((await (await self.hook('/cp/fail', data)).json())["code"], 0)
        self.assertEqual((await (await self.hook('/cp/check', {**data, "TransactionId":"302"})).json())["code"], 0)

    async def test_offer_escapes_seller_identity_and_discloses_recurring(self):
        self.config["GHOST_SELLER_NAME"] = '<script>alert(1)</script>'
        response = await self.client.get('/offer')
        body = await response.text()
        self.assertEqual(response.status, 200)
        self.assertIn('&lt;script&gt;', body)
        self.assertNotIn('<script>alert(1)</script>', body)
        self.assertIn('79 ₽ каждые семь дней', body)
        self.assertIn('/unsub', body)

    async def test_second_confirmed_initial_charge_is_preserved_for_manual_review(self):
        _, order = await self.order()
        data = {"AccountId": order["account_id"], "InvoiceId": order["invoice_id"], "TransactionId": "991", "Amount": "10", "Currency": "RUB", "Token": "test-token", "Email": "buyer@example.invalid"}
        with patch.object(checkout, "cloud_request", new=AsyncMock(return_value={"Success": True, "Model": {"Id": "sub"}})):
            await self.hook('/cp/pay', data)
            self.assertEqual((await (await self.hook('/cp/pay', {**data, "TransactionId": "992"})).json())["code"], 0)
        self.assertEqual(self.app["db"].execute("SELECT COUNT(*) FROM payments").fetchone()[0], 1)
        self.assertEqual(self.app["db"].execute("SELECT reason FROM payment_anomalies WHERE transaction_id='992'").fetchone()[0], 'unexpected_or_duplicate_initial')

    async def test_ambiguous_subscription_creation_is_not_retried(self):
        _, order = await self.order()
        data = {"AccountId": order["account_id"], "InvoiceId": order["invoice_id"], "TransactionId": "201", "Amount": "10", "Currency": "RUB", "Token": "test-token", "Email": "buyer@example.invalid"}
        with patch.object(checkout, "cloud_request", new=AsyncMock(side_effect=TimeoutError())) as cp:
            self.assertEqual((await (await self.hook("/cp/pay", data)).json())["code"], 0)
            self.assertEqual((await (await self.hook("/cp/pay", data)).json())["code"], 0)
            self.assertEqual(cp.await_count, 1)
        self.assertEqual(self.app["db"].execute("SELECT status FROM subscriptions WHERE user_id=123").fetchone()[0], "needs_review")
        self.assertEqual(self.app["db"].execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
