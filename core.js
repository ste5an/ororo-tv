/*
 * What the TV app (www/app.js) and the iPhone app (phone/app.js) share: small helpers, Ororo's API, the catalogue,
 * where each video was left, and the watch history. No UI in here, so it can be tested on its own.
 * Loaded before app.js on both, so it must run on the TV's Chromium 76: ES2017, no optional chaining.
 *
 * Each app calls configure() once before the first api() call: {creds, unreachable, skipMs, rememberHost, httpsOnly}.
 */
(function (root) {
  'use strict';

  var API_HOSTS = ['https://front.ororo.tv', 'https://front.ororo-mirror.tv', 'https://ororo.tv'];
  var LANGS = {
    en: 'English', ru: 'Русский', uk: 'Українська', es: 'Español', de: 'Deutsch', fr: 'Français', it: 'Italiano',
    pt: 'Português', pl: 'Polski', tr: 'Türkçe', hy: 'Հայերեն', ja: '日本語', zh: '中文', ko: '한국어', ar: 'العربية',
    he: 'עברית', cs: 'Čeština', nl: 'Nederlands', sv: 'Svenska', ro: 'Română', el: 'Ελληνικά', hu: 'Magyar'
  };

  // ---------------------------------------------------------------- small helpers

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function $(scope, sel) { return scope.querySelector(sel); }
  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* full or blocked: not worth failing over */ }
  }
  function forget(key) { try { localStorage.removeItem(key); } catch (e) {} }
  function clock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var hh = Math.floor(sec / 3600), mm = Math.floor(sec / 60) % 60, ss = sec % 60;
    return (hh ? hh + ':' + (mm < 10 ? '0' : '') : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
  }
  function plain(html) { return String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
  function langName(code) { return LANGS[code] || String(code || '?').toUpperCase(); }

  function timed(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  // ---------------------------------------------------------------- Ororo's API

  var opts = {
    creds: function () { return load('creds', null); },
    unreachable: 'Can’t reach Ororo. Check your internet connection.',
    skipMs: 40000,       // a host that doesn't answer in this long is skipped; the last one always gets 40 s
    rememberHost: false, // save the host that answered as `apihost` and try it first next launch
    httpsOnly: false     // turn http:// URLs from the API into https://
  };
  var activeHost = null;

  function configure(o) {
    Object.keys(o).forEach(function (k) { opts[k] = o[k]; });
    if (opts.rememberHost) {
      activeHost = load('apihost', null);
      if (API_HOSTS.indexOf(activeHost) < 0) activeHost = null;
    }
  }

  function creds() { return opts.creds(); }

  function httpError(status) {
    var e = new Error(status === 401 ? 'Wrong email or password.'
      : status === 402 ? 'Your Ororo plan doesn’t cover this, or today’s free limit is used up.'
      : 'Ororo answered with an error (' + status + ').');
    e.status = status;
    return e;
  }

  function basicAuth() {
    var c = creds() || { user: '', pass: '' };
    return 'Basic ' + btoa(unescape(encodeURIComponent(c.user + ':' + c.pass)));
  }

  function api(path) {
    if (!creds()) return Promise.reject(httpError(401));
    var headers = { Accept: 'application/json', Authorization: basicAuth() };
    var hosts = activeHost ? [activeHost].concat(API_HOSTS.filter(function (x) { return x !== activeHost; })) : API_HOSTS.slice();
    function attempt(i) {
      if (i >= hosts.length) return Promise.reject(new Error(opts.unreachable));
      var ctrl = new AbortController(), timer = setTimeout(function () { ctrl.abort(); }, i < hosts.length - 1 ? opts.skipMs : 40000);
      return fetch(hosts[i] + '/api/v2' + path, { headers: headers, signal: ctrl.signal }).then(function (res) {
        clearTimeout(timer);
        if (opts.rememberHost && activeHost !== hosts[i]) store('apihost', hosts[i]);
        activeHost = hosts[i];
        if (!res.ok) throw httpError(res.status);
        return res.json().catch(function () { throw new Error('Ororo sent an answer this app doesn’t understand.'); });
      }, function () { clearTimeout(timer); return attempt(i + 1); });
    }
    return attempt(0);
  }

  function abs(u) {
    if (!u) return '';
    if (u.indexOf('//') === 0) return 'https:' + u;
    if (u.charAt(0) === '/') return (activeHost || API_HOSTS[0]) + u;
    return opts.httpsOnly ? u.replace(/^http:\/\//, 'https://') : u;
  }

  // Only Ororo's own hosts ever get the account login.
  function isOroroHost(u) {
    var m = /^(https:\/\/[^\/?#]+)/i.exec(String(u || ''));
    return !!m && API_HOSTS.indexOf(m[1].toLowerCase()) >= 0;
  }
  // A URL from the API, made safe inside CSS url("…").
  function cssUrl(u) { return 'url("' + String(u).replace(/["\\\n\r]/g, function (c) { return encodeURIComponent(c); }) + '")'; }

  // ---------------------------------------------------------------- catalogue, progress, history

  // Filled in place by setCatalog, so the apps can keep their own references to these two objects.
  var catalog = { movie: [], show: [] }, byId = { movie: {}, show: {} };

  function slim(kind, r) {
    return {
      kind: kind, id: r.id, name: r.name || r.title || '', year: r.year || '',
      poster: abs(r.poster_thumb || r.poster), backdrop: abs(r.backdrop_url),
      rating: parseFloat(r.imdb_rating) || 0, genres: r.array_genres || [], desc: plain(r.desc),
      pop: +r.user_popularity || 0, fresh: Date.parse(r.newest_video || r.updated_at || '') || 0
    };
  }

  function setCatalog(data) {
    catalog.movie = data.movie;
    catalog.show = data.show;
    ['movie', 'show'].forEach(function (k) {
      byId[k] = {};
      catalog[k].forEach(function (it) { byId[k][it.id] = it; });
    });
  }

  // The whole catalogue from Ororo → {movie: [...], show: [...]}, already set as the current one.
  function loadCatalog() {
    return Promise.all([api('/movies'), api('/shows')]).then(function (res) {
      var data = {
        movie: (res[0].movies || []).map(function (r) { return slim('movie', r); }),
        show: (res[1].shows || []).map(function (r) { return slim('show', r); })
      };
      setCatalog(data);
      return data;
    });
  }

  // Where each movie (m123) or episode (e456) was left: {t: seconds, d: duration, at: when}.
  var positions = load('positions', {});
  function posKey(kind, id) { return (kind === 'movie' ? 'm' : 'e') + id; }
  function posOf(kind, id) { return positions[posKey(kind, id)] || null; }
  function savePos(kind, id, t, d) {
    if (!(t > 0) || !isFinite(d)) return;
    positions[posKey(kind, id)] = { t: Math.floor(t), d: Math.floor(d), at: Date.now() };
    store('positions', positions);
  }
  function finished(p) { return !!(p && p.d && p.t >= Math.min(p.d - 90, p.d * 0.95)); }
  function resumeAt(p) { return p && p.t > 30 && !finished(p) ? p.t : 0; }
  function fraction(p) { return p && p.d ? Math.min(1, p.t / p.d) : 0; }

  // Recently watched movies and shows, newest first: [{kind, id}].
  function remember(kind, id) {
    var list = load('history', []).filter(function (x) { return !(x.kind === kind && x.id === id); });
    list.unshift({ kind: kind, id: id });
    store('history', list.slice(0, 40));
  }
  function continueItems() {
    return load('history', []).map(function (x) { return byId[x.kind][x.id]; }).filter(Boolean);
  }

  var OroroCore = {
    API_HOSTS: API_HOSTS, LANGS: LANGS,
    h: h, $: $, load: load, store: store, forget: forget, clock: clock, plain: plain, langName: langName, timed: timed,
    configure: configure, creds: creds, httpError: httpError, basicAuth: basicAuth, api: api, abs: abs,
    isOroroHost: isOroroHost, cssUrl: cssUrl,
    catalog: catalog, byId: byId, slim: slim, setCatalog: setCatalog, loadCatalog: loadCatalog,
    posOf: posOf, savePos: savePos, finished: finished, resumeAt: resumeAt, fraction: fraction,
    remember: remember, continueItems: continueItems
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = OroroCore;
  else root.OroroCore = OroroCore;
})(this);
