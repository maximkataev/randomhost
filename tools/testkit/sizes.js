"use strict";
/*
 * Размеры вьюпортов и UA для матриц приёмки (IMPLEMENTATION-PLAN §6.2а, T-W0-03).
 * phoneSizes() — телефоны (портрет + ландшафт), tvSizes() — ТВ/проектор.
 * iPhone UA обязателен: у plinko isMobile определяется по UA (память mobile-layout-check).
 * Тот же список зеркалит tools/testkit/pw_kit.py (PHONE_SIZES/TV_SIZES) — менять в обоих.
 */
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// «старый движок проектора» — Chromium 80–83 (a100f48/d0ce365)
const OLD_PROJECTOR_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Safari/537.36";

const PHONES = [
  { name: "320x568", width: 320, height: 568, note: "iPhone SE 1" },
  { name: "320x268", width: 320, height: 268, note: "320x568 с экранной клавиатурой" },
  { name: "375x667", width: 375, height: 667, note: "iPhone 8" },
  { name: "390x844", width: 390, height: 844, note: "iPhone 14" },
  { name: "412x915", width: 412, height: 915, note: "Android" },
  { name: "568x320", width: 568, height: 320, landscape: true },
  { name: "667x375", width: 667, height: 375, landscape: true },
  { name: "844x390", width: 844, height: 390, landscape: true },
  { name: "915x412", width: 915, height: 412, landscape: true },
];
const TVS = [
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1024x768", width: 1024, height: 768 },
];

/** Телефоны: [{name,width,height,landscape?,viewport,userAgent,isMobile,hasTouch,deviceScaleFactor}].
 *  opts: {orientation:"portrait"|"landscape", ua:"android"} */
function phoneSizes(opts) {
  opts = opts || {};
  const ua = opts.ua === "android" ? ANDROID_UA : IPHONE_UA;
  let l = PHONES;
  if (opts.orientation === "portrait") l = l.filter((s) => !s.landscape);
  if (opts.orientation === "landscape") l = l.filter((s) => s.landscape);
  return l.map((s) => Object.assign({ userAgent: ua, deviceScaleFactor: 2, isMobile: true, hasTouch: true, viewport: { width: s.width, height: s.height } }, s));
}
/** ТВ/проектор. opts: {oldProjector:true} — UA Chromium 80. */
function tvSizes(opts) {
  opts = opts || {};
  const ua = opts.oldProjector ? OLD_PROJECTOR_UA : DESKTOP_UA;
  return TVS.map((s) => Object.assign({ userAgent: ua, deviceScaleFactor: 1, isMobile: false, hasTouch: false, viewport: { width: s.width, height: s.height } }, s));
}
module.exports = { phoneSizes, tvSizes, IPHONE_UA, ANDROID_UA, DESKTOP_UA, OLD_PROJECTOR_UA };
