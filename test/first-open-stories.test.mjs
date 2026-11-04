import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

async function launch({ cloud = {}, connected = false, search = "", local = {}, cloudError = false } = {}) {
  const created = [];
  const stored = {};
  const frames = [], fetches = [];
  let closed = 0;
  const element = { innerHTML: "", classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, querySelector() { return { textContent: "" }; } };
  const body = { ...element, classList: { toggled: [], toggle(name, on) { this.toggled.push([name, on]); } }, append(node) { created.push(node); } };
  const tg = {
    initData: "signed-user", ready() {}, expand() {}, close() { closed++; }, isVersionAtLeast: () => true,
    CloudStorage: {
      getItem(key, done) { done(cloudError ? new Error("nope") : null, cloud[key] || ""); },
      setItem(key, value) { stored[key] = value; }
    }
  };
  const context = {
    window: { Telegram: { WebApp: tg } },
    document: {
      querySelector(selector) { return selector === ".stories-overlay" ? (created[0] || null) : element; }, querySelectorAll() { return []; },
      documentElement: {}, body, activeElement: null,
      createElement(tag) { const node = { append() {}, remove() {}, focus() {}, contentWindow: {} }; if (tag === "iframe") frames.push(node); return node; }
    },
    location: { search, href: "https://example.test/" }, history: { replaceState() {} },
    localStorage: { getItem: (key) => local[key] ?? null, setItem(key, value) { local[key] = value; } },
    URL, URLSearchParams, Date, AbortController, Promise, setTimeout, clearTimeout, scrollTo() {}, alert() {}, navigator: {},
    fetch: async (url, options) => { fetches.push([url, options?.body]); return url === "/api/dashboard"
      ? { ok: true, json: async () => ({ ok: true, connected }) }
      : { ok: true, json: async () => ({ ok: true }) }; }
  };
  runInNewContext(readFileSync(new URL("../public/app.js", import.meta.url), "utf8"), context);
  await new Promise((resolve) => setTimeout(resolve, 40));
  return { frames, fetches, closedCount: () => closed, opened: created.length, stored, local, revealed: body.classList.toggled.some(([name, on]) => name === "booting" && on === false) };
}

test("the stories open on the very first launch and are marked as seen", async () => {
  const run = await launch();
  assert.equal(run.opened, 1);
  assert.equal(run.stored.ghost_stories_seen, "1");
  assert.equal(run.local.ghost_stories_seen, "1");
  assert.ok(run.revealed);
});

test("they do not open again, also on another device", async () => {
  const run = await launch({ cloud: { ghost_stories_seen: "1" } });
  assert.equal(run.opened, 0);
  assert.ok(run.revealed);
  assert.equal((await launch({ local: { ghost_stories_seen: "1" } })).opened, 0);
});

test("a user who already connected Ghost skips them for good", async () => {
  const run = await launch({ connected: true });
  assert.equal(run.opened, 0);
  assert.equal(run.stored.ghost_stories_seen, "1");
});

test("they never interrupt a link to a specific screen, and stay closed when storage fails", async () => {
  const link = await launch({ search: "?screen=plans" });
  assert.equal(link.opened, 0);
  assert.equal(link.stored.ghost_stories_seen, undefined);
  const failed = await launch({ cloudError: true });
  assert.equal(failed.opened, 0);
  assert.ok(failed.revealed);
});

test("the instruction button in the stories does what the settings button does", async () => {
  const run = await launch();
  const [frame] = run.frames;
  frame.onload();
  assert.equal(typeof frame.contentWindow.onGhostStoriesDone, "function");
  await frame.contentWindow.onGhostStoriesVideo();
  const action = run.fetches.find(([url]) => url === "/api/app-action");
  assert.equal(JSON.parse(action[1]).action, "settings");
  assert.equal(run.closedCount(), 1);
});
