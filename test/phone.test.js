// Browser test for the iPhone web app (phone/). It serves the site the way pages.yml assembles it, answers Ororo's
// API with a small fake catalogue, and drives the app at an iPhone's size. No network and no login are needed.
//   CI:    npm install --no-save playwright@1.63.0 && npx playwright install --with-deps chromium
//   Run:   node --test test/phone.test.js
'use strict';
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/json' };

// ---- fake Ororo ------------------------------------------------------------------------------------------------
const MOVIES = [
  ['Alpha Harbor', 2026, 9.1], ['Blue Meridian', 2026, 8.2], ['Cold Orchard', 2025, 7.7],
  ['Dust and Glass', 2024, 7.1], ['Eight Windows', 2024, 6.9], ['Fable Street', 2019, 8.8]
].map((m, i) => ({
  id: i + 1, name: m[0], year: String(m[1]), imdb_rating: String(m[2]), poster_thumb: '/poster/' + i + '.svg',
  backdrop_url: '/poster/' + i + '.svg', array_genres: ['Drama'], desc: '<p>About ' + m[0] + '.</p>', user_popularity: 50 - i,
  newest_video: '2026-01-0' + (i + 1)
}));
const SHOWS = [['Night Shift', 2026], ['Open Water', 2022]].map((m, i) => ({
  id: 100 + i, name: m[0], year: String(m[1]), imdb_rating: '8.0', poster_thumb: '/poster/' + (i + 6) + '.svg',
  backdrop_url: '/poster/' + (i + 6) + '.svg', array_genres: ['Thriller'], desc: 'About ' + m[0] + '.', user_popularity: 40 - i,
  newest_video: '2026-02-0' + (i + 1)
}));
const EPISODES = [1, 2, 3].map((n) => ({ id: 500 + n, season: 1, number: n, title: 'Episode ' + n + ' title', plot: 'Plot ' + n + '.' }));
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\nhigh.m3u8\n' +
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nmid.m3u8\n';
const CORS = { 'access-control-allow-origin': '*' };

// What the fake Ororo did: which hosts were asked, in order, and any switches a test flips.
let asked, deadHosts, masterDelayMs;
async function fakeOroro(page) {
  asked = [];
  deadHosts = new Set();
  masterDelayMs = 0;
  await page.route(/\/\/(front\.)?ororo[^/]*\//, async (route) => {
    const url = route.request().url();
    const host = new URL(url).hostname;
    asked.push(host + new URL(url).pathname);
    if (deadHosts.has(host)) return route.abort();
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
    if (/playlist\.m3u8/.test(url)) {
      if (masterDelayMs) await new Promise((r) => setTimeout(r, masterDelayMs));
      return route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', headers: CORS, body: MASTER });
    }
    if (/\.srt/.test(url)) return route.fulfill({ status: 200, contentType: 'text/plain', headers: CORS, body: '1\n00:00:01,000 --> 00:00:02,000\nHi\n' });
    if (/\/api\/v2\/movies$/.test(url)) return json({ movies: MOVIES });
    if (/\/api\/v2\/shows$/.test(url)) return json({ shows: SHOWS });
    if (/\/api\/v2\/shows\/\d+$/.test(url)) return json({ episodes: EPISODES });
    if (/\/api\/v2\/(movies|episodes)\/\d+$/.test(url)) {
      return json({ url: 'https://front.ororo.tv/v/playlist_fmp4.m3u8', download_url: 'https://front.ororo.tv/v/file.mp4', subtitles: [{ lang: 'en', url: 'https://front.ororo.tv/s/en.srt' }] });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.route(/\/poster\/\d+\.svg$/, (route) => route.fulfill({
    contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#456"/></svg>'
  }));
}

// ---- the site, assembled like .github/workflows/pages.yml ------------------------------------------------------
let server, base, browser, ctx, page, problems;
before(async () => {
  server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = name === 'seek.js' ? path.join(ROOT, 'www/seek.js') : name === 'icon.png' ? path.join(ROOT, 'www/icon.png') : path.join(ROOT, 'phone', name);
    fs.readFile(file, (err, data) => {
      if (err || !file.startsWith(ROOT)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
      res.end(data);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port + '/';
  browser = await chromium.launch();
});
after(async () => { await browser.close(); server.close(); });

beforeEach(async () => {
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page = await ctx.newPage();
  problems = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  await fakeOroro(page);
});
afterEach(async () => {
  assert.deepEqual(problems, [], 'the page threw errors');
  await ctx.close();
});

// `saved` is what the phone has remembered before the app opens (the app reads it once, at start).
async function signIn(saved) {
  if (saved) await page.addInitScript((data) => { if (!localStorage.getItem('positions')) localStorage.setItem('positions', JSON.stringify(data)); }, saved);
  await page.goto(base);
  await page.fill('#em', 'someone@example.com');
  await page.fill('#pw', 'not-a-real-password');
  await page.click('.login .btn');
  await page.waitForSelector('.card');
}
const text = (sel) => page.locator(sel).allInnerTexts();

// ---- tests -----------------------------------------------------------------------------------------------------
test('signing in opens Movies with the tab bar, and nothing scrolls sideways', async () => {
  await signIn();
  assert.equal(await page.locator('h1').innerText(), 'Movies');
  assert.deepEqual(await text('.tabbar a'), ['Continue', 'Movies', 'Shows', 'Search']);
  assert.equal(await page.locator('.tabbar a[aria-current="page"]').innerText(), 'Movies');
  assert.equal(await page.locator('.card').count(), MOVIES.length);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the page is wider than the screen');
});

test('a wrong login sends you back to sign in with a message', async () => {
  await page.unroute(/\/\/(front\.)?ororo[^/]*\//);
  await page.route(/\/\/(front\.)?ororo[^/]*\//, (r) => r.fulfill({ status: 401, headers: CORS, body: '{}' }));
  await page.goto(base);
  await page.fill('#em', 'someone@example.com');
  await page.fill('#pw', 'wrong');
  await page.click('.login .btn');
  await page.waitForSelector('.login .err:not(:empty)');
  assert.match(await page.locator('.err').innerText(), /Wrong email or password/);
});

test('every control is at least 44 points and has a name', async () => {
  await signIn();
  const bad = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('button, a.card, .tabbar a, select').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (!name) out.push('no name: ' + el.outerHTML.slice(0, 80));
      if (el.tagName !== 'A' || !el.classList.contains('card')) if (r.width < 44 || r.height < 44) out.push('small: ' + name + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    });
    return out;
  });
  assert.deepEqual(bad, []);
});

test('Release year lists titles newest first under a heading for each year', async () => {
  await signIn();
  assert.deepEqual(await page.$$eval('select[aria-label="Sort by"] option', (o) => o.map((x) => x.textContent)),
    ['Popular', 'Recently added', 'Top rated', 'A–Z', 'Release year']);
  await page.selectOption('select[aria-label="Sort by"]', '4');
  assert.deepEqual(await text('.yearhead'), ['2026', '2025', '2024', '2019']);
  // Each heading is followed by exactly its own titles.
  const groups = await page.$$eval('.grid > *', (els) => {
    const g = {}; let year = null;
    els.forEach((el) => { if (el.classList.contains('yearhead')) { year = el.textContent; g[year] = []; } else g[year].push(el.querySelector('.sub').textContent); });
    return g;
  });
  for (const year of Object.keys(groups)) assert.ok(groups[year].every((y) => y === year), year + ' holds ' + groups[year]);
});

test('Search finds a title and says so when there is none', async () => {
  await signIn();
  await page.click('.tabbar a[href="#/tab/search"]');
  await page.fill('.searchbar input', 'fable');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
  assert.equal(await page.locator('.card .title').innerText(), 'Fable Street');
  await page.fill('.searchbar input', 'zzzz');
  await page.waitForSelector('.empty strong');
  assert.equal(await page.locator('.empty strong').innerText(), 'No results');
});

test('Continue starts empty, then lists what you played', async () => {
  await signIn();
  await page.click('.tabbar a[href="#/tab/continue"]');
  assert.equal(await page.locator('.empty strong').innerText(), 'Nothing to continue yet');
  await page.click('.tabbar a[href="#/tab/movie"]');
  await page.click('.card');
  await page.click('.playrow .btn.primary');
  await page.waitForSelector('.controls');
  await page.click('.tabbar a[href="#/tab/continue"]');
  await page.waitForSelector('.card');
  assert.equal(await page.locator('.card').count(), 1);
});

test('a movie has Play with one download button, and Quality has no MP4', async () => {
  await signIn();
  await page.click('.card');
  await page.waitForSelector('.playrow');
  assert.deepEqual(await text('.playrow .btn'), ['Play']);
  assert.equal(await page.locator('.playrow .dlsq').count(), 1);
  assert.equal(await page.getByText('Mark as watched').count(), 0);
  await page.click('.playrow .btn.primary');
  await page.waitForSelector('.controls');
  await page.waitForFunction(() => document.querySelectorAll('select.quality option').length > 1);
  assert.deepEqual(await page.$$eval('select.quality option', (o) => o.map((x) => x.textContent)), ['Auto', '1080p', '720p']);
  assert.match(await page.locator('.subs-label').innerText(), /Subtitles: English/);
});

test('a show lists episodes with a single download icon each, and no watched buttons', async () => {
  await signIn();
  await page.click('.tabbar a[href="#/tab/show"]');
  await page.click('.card');
  await page.waitForSelector('.eprow');
  assert.equal(await page.locator('.eprow').count(), EPISODES.length);
  assert.equal(await page.locator('.eprow button.row-btn').count(), EPISODES.length);
  assert.equal(await page.locator('.eprow .row-btn[aria-label="Download"]').count(), EPISODES.length);
  assert.equal(await page.getByText('Mark as watched').count(), 0);
  assert.match(await page.locator('.actions .btn').innerText(), /Play S1 E1/);
  // Playing an episode shows subtitles and quality, but no wide Download button.
  await page.click('.eprow .ep');
  await page.waitForSelector('.controls');
  assert.equal(await page.locator('.controls .btn, .controls .dlsq').count(), 0);
});

test('tapping download turns the icon into a save link', async () => {
  await signIn();
  await page.click('.tabbar a[href="#/tab/show"]');
  await page.click('.card');
  await page.waitForSelector('.eprow');
  await page.click('.eprow .row-btn');
  await page.waitForSelector('.eprow a.row-btn.ready');
  assert.equal(await page.locator('.eprow a.row-btn.ready').first().getAttribute('href'), 'https://front.ororo.tv/v/file.mp4');
});

test('watching is remembered by itself: finished episodes show a check and Play moves to the next one', async () => {
  await signIn({ e501: { t: 2990, d: 3000, at: Date.now() } });
  await page.click('.tabbar a[href="#/tab/show"]');
  await page.click('.card');
  await page.waitForSelector('.eprow');
  assert.equal(await page.locator('.eprow').first().locator('[aria-label="Watched"]').count(), 1);
  assert.match(await page.locator('.actions .btn').innerText(), /Play S1 E2/);
});

test('a half-watched movie offers Resume and Start over', async () => {
  await signIn({ m1: { t: 1200, d: 6000, at: Date.now() } });
  await page.click('.card');
  await page.waitForSelector('.playrow');
  assert.match(await page.locator('.playrow .btn').innerText(), /Resume from 20:00/);
  assert.equal(await page.locator('.actions > .btn').innerText(), 'Start over');
});

test('Sign out asks first, and Cancel keeps you signed in', async () => {
  await signIn();
  await page.click('.account');
  await page.waitForSelector('.sheet');
  await page.click('.sheet .btn:has-text("Cancel")');
  assert.equal(await page.locator('.sheet').count(), 0);
  assert.equal(await page.locator('h1').innerText(), 'Movies');
  await page.click('.account');
  await page.click('.sheet .btn:has-text("Sign out")');
  await page.waitForSelector('.login');
});

test('light and dark both read well: text stays at least 4.5:1 against its background', async () => {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(base);
    await page.waitForSelector('.login');
    const ratios = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); return m.slice(0, 3); };
      const lum = (rgb) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(rgb[0]) + .7152 * f(rgb[1]) + .0722 * f(rgb[2]); };
      const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      const probe = (v) => { const el = document.createElement('i'); el.style.color = css.getPropertyValue(v); document.body.appendChild(el); const c = parse(getComputedStyle(el).color); el.remove(); return c; };
      const bg = probe('--bg'), surface = probe('--surface');
      return { text: ratio(probe('--text'), bg), dim: ratio(probe('--dim'), bg), dimOnSurface: ratio(probe('--dim'), surface), accent: ratio(probe('--accent'), bg), onAccent: ratio(probe('--on-accent'), probe('--accent')) };
    });
    for (const k of Object.keys(ratios)) assert.ok(ratios[k] >= 4.5, scheme + ' ' + k + ' is ' + ratios[k].toFixed(2));
  }
});

// ---- speed -----------------------------------------------------------------------------------------------------
test('a catalogue saved less than three hours ago is used without asking Ororo for the lists again', async () => {
  await signIn();
  const listCalls = () => asked.filter((a) => /\/api\/v2\/(movies|shows)$/.test(a)).length;
  assert.equal(listCalls(), 2, 'the first visit loads movies and shows once each');
  await page.reload();
  await page.waitForSelector('.card');
  assert.equal(listCalls(), 2, 'the second visit asked again');
});

test('an old saved catalogue is shown at once and refreshed in the background', async () => {
  await signIn();
  await page.evaluate(() => new Promise((resolve) => {
    const open = indexedDB.open('ororo', 1);
    open.onsuccess = () => {
      const store = open.result.transaction('kv', 'readwrite').objectStore('kv');
      const get = store.get('catalog');
      get.onsuccess = () => { const c = get.result; c.savedAt = Date.now() - 4 * 3600 * 1000; store.put(c, 'catalog').onsuccess = resolve; };
    };
  }));
  const before = asked.length;
  await page.reload();
  await page.waitForSelector('.card');
  await page.waitForFunction(() => true);
  await page.waitForTimeout(300);
  assert.ok(asked.slice(before).some((a) => /\/api\/v2\/movies$/.test(a)), 'the old catalogue was not refreshed');
});

test('a host that failed is remembered, so the next visit goes straight to the one that works', async () => {
  deadHosts = new Set();
  await page.goto(base);
  deadHosts.add('front.ororo.tv');
  await page.fill('#em', 'someone@example.com');
  await page.fill('#pw', 'not-a-real-password');
  await page.click('.login .btn');
  await page.waitForSelector('.card');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('apihost'))), 'https://front.ororo-mirror.tv');
  asked.length = 0;
  await page.reload();
  await page.waitForSelector('.card');
  await page.click('.tabbar a[href="#/tab/show"]');
  await page.click('.card');
  await page.waitForSelector('.eprow');
  assert.ok(asked.some((a) => a.startsWith('front.ororo-mirror.tv/')), 'the working host was not used');
  assert.ok(!asked.some((a) => a.startsWith('front.ororo.tv/')), 'the dead host was tried again');
});

test('Auto quality starts the video before the list of resolutions has arrived', async () => {
  await signIn();
  masterDelayMs = 1500;
  await page.click('.card');
  await page.click('.playrow .btn.primary');
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && /playlist\.m3u8/.test(v.getAttribute('src') || ''); }, null, { timeout: 1000 });
  assert.deepEqual(await page.$$eval('select.quality option', (o) => o.map((x) => x.textContent)), ['Auto']);
  await page.waitForFunction(() => document.querySelectorAll('select.quality option').length === 3);
  assert.deepEqual(await page.$$eval('select.quality option', (o) => o.map((x) => x.textContent)), ['Auto', '1080p', '720p']);
});

test('a chosen resolution still waits for the list, so the first thing played is that resolution', async () => {
  await page.addInitScript(() => {
    localStorage.setItem('quality', JSON.stringify('720p'));
    window.__played = [];
    const set = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src').set;
    Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true, get() { return this.getAttribute('src') || ''; }, set(v) { window.__played.push(String(v)); set.call(this, v); } });
  });
  await signIn();
  await page.click('.card');
  await page.click('.playrow .btn.primary');
  await page.waitForFunction(() => window.__played.length > 0);
  assert.match(await page.evaluate(() => window.__played[0]), /mid\.m3u8$/);
});

test('after one visit the app opens with no connection at all', async () => {
  await signIn();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).length > 0 && !!(await (await caches.open((await caches.keys())[0])).match('app.js')));
  await page.reload();                      // from now on the saved copy answers
  await page.waitForSelector('.card');
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('.card');
  assert.equal(await page.locator('h1').innerText(), 'Movies');
  await ctx.setOffline(false);
});

test('pull request previews never use the saved app files', async () => {
  await page.goto(base);
  const registered = await page.evaluate(async () => { await navigator.serviceWorker.ready; return true; });
  assert.ok(registered);
  const answered = await page.evaluate(async () => {
    const r = await fetch('/pr-preview/pr-1/app.js');
    return r.status;
  });
  assert.equal(answered, 404, 'a preview path was answered from the saved app instead of the network');
});
