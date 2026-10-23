/**
 * Read-only HTTP API for the Mini App home screen.
 *
 * Runs inside the bot process on the VPS (same storage as the bot) and listens
 * on 127.0.0.1 only. A reverse proxy with HTTPS (see deploy/setup-dashboard-api.sh)
 * exposes it, and Vercel forwards /api/dashboard to it (see vercel.json).
 *
 * Every request must carry Telegram Mini App `initData`; the user id is taken
 * from the verified signature, so a viewer can only read their own summary.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { checkCryptoCheckout, createCryptoCheckout, getDashboard, getLedgerExport, processPlategaCallback, trackFunnelEvent } from "../api/telegram.js";

const MAX_AGE_SECONDS = 24 * 60 * 60;

export function verifyInitData(initData, token = process.env.TELEGRAM_BOT_TOKEN) {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const params = new URLSearchParams(initData || "");
  const hash = params.get("hash");
  if (!hash) throw new Error("Missing signature");
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = Buffer.from(createHmac("sha256", secret).update(dataCheckString).digest("hex"), "hex");
  const provided = Buffer.from(hash, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error("Invalid signature");
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate < Math.floor(Date.now() / 1000) - MAX_AGE_SECONDS) throw new Error("Session expired");
  const user = JSON.parse(params.get("user") || "null");
  if (!user?.id) throw new Error("No user");
  return user;
}

const send = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

const readBody = (request, limit = 16 * 1024) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > limit) { reject(new Error("Body too large")); request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  request.on("error", reject);
});

// Accounting panel export. Needs LEDGER_EXPORT_TOKEN; without it the path does not exist.
// The public proxy forwards only /api/dashboard, /api/funnel and /health, so this stays local.
async function ledgerExport(request, response) {
  const token = process.env.LEDGER_EXPORT_TOKEN;
  if (!token || request.method !== "GET") return send(response, 404, { ok: false });
  const expected = Buffer.from(token);
  const provided = Buffer.from(String(request.headers["x-ledger-token"] || ""));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return send(response, 404, { ok: false });
  try {
    const params = new URL(request.url, "http://localhost").searchParams;
    const data = await getLedgerExport({
      paymentsSince: Number(params.get("payments_since")) || 0,
      visitsSince: Number(params.get("visits_since")) || 0,
      includeUsers: params.get("users") === "1"
    });
    return send(response, 200, { ok: true, ...data });
  } catch (error) {
    console.error("Ledger export failed", error);
    return send(response, 500, { ok: false });
  }
}

export function startDashboardApi({ port = Number(process.env.DASHBOARD_PORT) || 8787, host = process.env.DASHBOARD_HOST || "127.0.0.1" } = {}) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/health") return send(response, 200, { ok: true });
    if (path === "/api/ledger") return ledgerExport(request, response);
    if (path === "/api/platega-callback") {
      if (request.method !== "POST") return send(response, 405, { ok: false });
      try {
        const body = JSON.parse((await readBody(request)) || "{}");
        await processPlategaCallback(request.headers, body);
        return send(response, 200, { ok: true });
      } catch (error) {
        console.error("Platega callback failed", error);
        return send(response, 401, { ok: false });
      }
    }
    if (path !== "/api/dashboard" && path !== "/api/funnel" && path !== "/api/crypto") return send(response, 404, { ok: false });
    if (request.method !== "POST") return send(response, 405, { ok: false });
    let user;
    try {
      const body = JSON.parse((await readBody(request)) || "{}");
      user = verifyInitData(body.initData);
      if (path === "/api/crypto") {
        if (body.action === "create") return send(response, 200, { ok: true, ...await createCryptoCheckout(user, body.plan) });
        if (body.action === "status") return send(response, 200, { ok: true, ...await checkCryptoCheckout(user.id, String(body.transactionId || "")) });
        return send(response, 400, { ok: false, message: "Unknown crypto action" });
      }
      if (path === "/api/funnel") {
        await trackFunnelEvent(user.id, body.stage);
        return send(response, 200, { ok: true });
      }
      const data = await getDashboard(user.id, { tzOffset: body.tzOffset });
      return send(response, 200, { ok: true, ...data });
    } catch (error) {
      if (!user) return send(response, 401, { ok: false, message: "Unauthorized" });
      console.error("Dashboard API failed", error);
      return send(response, 500, { ok: false, message: error.message || "Unable to process request" });
    }
  });
  server.listen(port, host, () => console.log(`Dashboard API listening on http://${host}:${port}`));
  return server;
}
