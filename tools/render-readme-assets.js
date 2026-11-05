#!/usr/bin/env node
/*
  Renders the README images from the real popup UI:
    store-assets/screenshots/popup.png      main view
    store-assets/screenshots/equalizer.png  EQ panel
    store-assets/banner.png                 1280x640 hero / GitHub social preview
  Requires Playwright with Chromium:  npm i -D playwright && npx playwright install chromium
  Usage: node tools/render-readme-assets.js
*/
"use strict";
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(ROOT, "store-assets", "screenshots");

// Stub of the extension APIs the popup uses, with a realistic session.
function stubChrome() {
  const icon = color => "data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='4' fill='${color}'/></svg>`);
  const sync = {
    mode: "voice", eqPreset: "vShape", eqGains: [6, 4, 2, 0, -4, -4, 0, 2, 4, 6],
    showBadge: true, rememberVolume: true, startAt100: false, overdrive: true
  };
  const local = { vol_tabs: { "3": 180 } };
  const area = data => ({
    get: (defaults, cb) => cb(Object.assign({}, typeof defaults === "object" && defaults ? defaults : {}, data)),
    set: (values, cb) => { Object.assign(data, values); if (cb) cb(); },
    remove: (_keys, cb) => { if (cb) cb(); }
  });
  const event = () => ({ addListener() {}, removeListener() {} });
  const tabs = [
    { id: 3, title: "Evening Jazz Session (Live)", color: "#ff5a5f", active: true },
    { id: 7, title: "Tech Talk Podcast, Episode 42", color: "#7c8cff" },
    { id: 9, title: "Lo-fi Beats to Study To", color: "#f5b942" },
    { id: 12, title: "City Council Meeting Stream", color: "#2ec4b6" },
    { id: 15, title: "Rainforest Ambience, 3 Hours", color: "#00d084" }
  ].map(t => ({ ...t, windowId: 1, audible: true, favIconUrl: icon(t.color) }));
  window.chrome = {
    runtime: {
      lastError: undefined,
      getURL: p => p,
      sendMessage: (message, cb) => setTimeout(() => cb && cb(
        message.type === "SS_GET_STATUS"
          ? { ok: true, mode: "whole-tab", canBoost: true, captureActive: true, engaged: true, reason: "" }
          : { ok: true, mode: "whole-tab", canBoost: true }), 0)
    },
    storage: { sync: area(sync), local: area(local), onChanged: event() },
    tabs: {
      query: (q, cb) => cb(q.active ? [tabs[0]] : tabs),
      update: (_id, _info, cb) => cb && cb(),
      onUpdated: event(), onRemoved: event(), onActivated: event()
    },
    windows: { update: (_id, _info, cb) => cb && cb() }
  };
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  const popup = await browser.newPage({ viewport: { width: 380, height: 700 }, deviceScaleFactor: 2 });
  popup.on("pageerror", e => errors.push(e.message));
  await popup.addInitScript(stubChrome);
  await popup.goto("file://" + path.join(ROOT, "SoundSphere-1.3", "popup.html"));
  await popup.waitForTimeout(500);
  // Crop to the popup's real size (body is 380 x 560 in the browser).
  const height = await popup.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
  const clip = { x: 0, y: 0, width: 380, height };
  await popup.screenshot({ path: path.join(SHOTS, "popup.png"), clip });
  await popup.click("#eqBtn");
  await popup.waitForTimeout(300);
  await popup.screenshot({ path: path.join(SHOTS, "equalizer.png"), clip });

  const banner = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  banner.on("pageerror", e => errors.push(e.message));
  await banner.goto("file://" + path.join(ROOT, "store-assets", "src", "banner.html"));
  await banner.waitForTimeout(400);
  await banner.screenshot({ path: path.join(ROOT, "store-assets", "banner.png") });

  await browser.close();
  if (errors.length) {
    console.error("Page errors:", errors);
    process.exit(1);
  }
  console.log("Rendered popup.png, equalizer.png (380x" + height + " @2x) and banner.png (1280x640).");
})();
