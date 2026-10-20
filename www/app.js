/*
 * Ororo TV for Samsung TVs (Tizen): browse ororo.tv's movies and shows with the remote and play them with subtitles.
 * Talks to Ororo's API (the one its Kodi add-ons use) with the account's email and password (HTTP Basic).
 * Written for the Chromium 76 inside Tizen 6: ES2017, no optional chaining.
 */
(function () {
  'use strict';

  var API_HOSTS = ['https://front.ororo.tv', 'https://front.ororo-mirror.tv', 'https://ororo.tv'];
  var COLS = 7;          // posters per row, matches .grid in style.css
  var CHUNK = 70;        // posters added to the page at a time
  var KEYS = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'enter', 10009: 'back', 27: 'back', 8: 'back',
    415: 'play', 19: 'pause', 10252: 'playpause', 413: 'stop', 417: 'ff', 412: 'rw', 32: 'playpause'
  };
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
  function langName(code) { return LANGS[code] || String(code || '').toUpperCase(); }

  var toastTimer;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 5000);
  }
  function busy(on, text) {
    document.getElementById('busy').hidden = !on;
    $(document, '.busy-text').textContent = text || '';
  }
  function exitApp() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* in a browser there's nothing to exit */ }
  }
  function screensaver(on) {
    try {
      var s = webapis.appcommon.AppCommonScreenSaverState;
      webapis.appcommon.setScreenSaver(on ? s.SCREEN_SAVER_ON : s.SCREEN_SAVER_OFF);
    } catch (e) {}
  }

  // ---------------------------------------------------------------- Ororo's API

  var activeHost = null;

  function creds() { return load('creds', null) || window.ORORO_CREDENTIALS || null; }

  function httpError(status) {
    var msg = status === 401 ? 'Wrong email or password.'
      : status === 402 ? 'Your Ororo plan doesn’t cover this, or today’s free limit is used up.'
      : 'Ororo answered with an error (' + status + ').';
    var e = new Error(msg);
    e.status = status;
    return e;
  }

  function timed(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
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
      if (i >= hosts.length) return Promise.reject(new Error('Can’t reach Ororo. Check the TV’s internet connection.'));
      return timed(fetch(hosts[i] + '/api/v2' + path, { headers: headers }), 40000).then(function (res) {
        activeHost = hosts[i];
        if (!res.ok) throw httpError(res.status);
        return res.json().catch(function () { throw new Error('Ororo sent an answer this app doesn’t understand.'); });
      }, function () { return attempt(i + 1); });
    }
    return attempt(0);
  }

  function abs(u) {
    if (!u) return '';
    if (u.indexOf('//') === 0) return 'https:' + u;
    if (u.charAt(0) === '/') return (activeHost || API_HOSTS[0]) + u;
    return u;
  }

  // ---------------------------------------------------------------- catalogue, progress, history

  var catalog = { movie: [], show: [] }, byId = { movie: {}, show: {} };

  function slim(kind, r) {
    return {
      kind: kind, id: r.id, name: r.name || r.title || '', year: r.year || '',
      poster: abs(r.poster_thumb || r.poster), backdrop: abs(r.backdrop_url),
      rating: parseFloat(r.imdb_rating) || 0, genres: r.array_genres || [], desc: plain(r.desc),
      pop: +r.user_popularity || 0, fresh: Date.parse(r.newest_video || r.updated_at || '') || 0
    };
  }

  function loadCatalog() {
    return Promise.all([api('/movies'), api('/shows')]).then(function (res) {
      catalog.movie = (res[0].movies || []).map(function (r) { return slim('movie', r); });
      catalog.show = (res[1].shows || []).map(function (r) { return slim('show', r); });
      ['movie', 'show'].forEach(function (k) {
        byId[k] = {};
        catalog[k].forEach(function (it) { byId[k][it.id] = it; });
      });
    });
  }

  // Where each movie (m123) or episode (e456) was left: {t: seconds, d: duration}.
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

  // ---------------------------------------------------------------- screens and focus

  var stack = [], focused = null;

  function top() { return stack[stack.length - 1]; }

  function push(s) {
    var prev = top();
    if (prev) { prev.last = focused; prev.el.hidden = true; }
    stack.push(s);
    document.getElementById('app').appendChild(s.el);
    focus(s.start || $(s.el, '.f'));
  }

  function pop() {
    var s = stack.pop();
    if (s.close) s.close();
    s.el.remove();
    var prev = top();
    if (!prev) return exitApp();
    prev.el.hidden = false;
    var target = prev.last && prev.el.contains(prev.last) ? prev.last : $(prev.el, '.f');
    if (prev.shown) target = prev.shown() || target;
    focus(target);
  }

  function reset(s) {
    while (stack.length) {
      var x = stack.pop();
      if (x.close) x.close();
      x.el.remove();
    }
    push(s);
  }

  function focus(el) {
    if (!el) return;
    if (focused) focused.classList.remove('focus');
    focused = el;
    el.classList.add('focus');
    reveal(el);
    var s = top();
    if (s && s.focused) s.focused(el);
  }

  // Scrolls the nearest .scroll / .hscroll box so the element sits inside it with some room.
  function reveal(el) {
    var box = el.parentElement && el.parentElement.closest('.scroll, .hscroll');
    if (!box) return;
    var r = el.getBoundingClientRect(), b = box.getBoundingClientRect(), pad = 70;
    if (box.classList.contains('hscroll')) {
      if (r.left < b.left + pad) box.scrollLeft -= b.left + pad - r.left;
      else if (r.right > b.right - pad) box.scrollLeft += r.right - (b.right - pad);
    } else {
      if (r.top < b.top + pad) box.scrollTop -= b.top + pad - r.top;
      else if (r.bottom > b.bottom - pad) box.scrollTop += r.bottom - (b.bottom - pad);
    }
  }

  function move(dir) {
    var s = top();
    if (!focused || !s.el.contains(focused)) return focus($(s.el, '.f'));
    var target = s.grid && focused.classList.contains('g') ? gridMove(s.grid, dir) : null;
    if (target === false) return;
    if (!target) target = nearest(s, dir);
    if (target) focus(target);
  }

  // Posters move by index: fast with thousands of them. false = stay put, null = leave the grid.
  function gridMove(grid, dir) {
    var i = +focused.dataset.i, n;
    if (dir === 'left') return i % COLS ? grid.item(i - 1) : false;
    if (dir === 'right') {
      grid.ensure(i + 1);
      return (i + 1) % COLS && i + 1 < grid.count() ? grid.item(i + 1) : false;
    }
    if (dir === 'down') {
      grid.ensure(i + COLS);
      n = grid.count();
      if (i + COLS < n) return grid.item(i + COLS);
      return Math.floor(i / COLS) < Math.floor((n - 1) / COLS) ? grid.item(n - 1) : false;
    }
    return i >= COLS ? grid.item(i - COLS) : null;
  }

  // Everything else moves to the closest element in that direction, measured on screen.
  function nearest(s, dir) {
    var a = focused.getBoundingClientRect(), best = null, bestScore = Infinity;
    var list = Array.prototype.slice.call(s.el.querySelectorAll('.f:not(.g)'));
    if (s.grid && s.grid.count()) list.push(s.grid.item(0));
    list.forEach(function (el) {
      if (el === focused || el.offsetParent === null) return;
      var b = el.getBoundingClientRect(), main, cross;
      var dx = (b.left + b.width / 2) - (a.left + a.width / 2), dy = (b.top + b.height / 2) - (a.top + a.height / 2);
      if (dir === 'right') { if (b.left < a.right - 4) return; main = b.left - a.right; cross = Math.abs(dy); }
      else if (dir === 'left') { if (b.right > a.left + 4) return; main = a.left - b.right; cross = Math.abs(dy); }
      else if (dir === 'down') { if (b.top < a.bottom - 4) return; main = b.top - a.bottom; cross = Math.abs(dx); }
      else { if (b.bottom > a.top + 4) return; main = a.top - b.bottom; cross = Math.abs(dx); }
      var score = main + cross * 2;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    return best;
  }

  function activate(el) {
    if (el.tagName === 'INPUT') el.focus();   // opens the TV's keyboard
    else el.click();
  }

  document.addEventListener('keydown', function (e) {
    var input = document.activeElement;
    if (input && input.tagName === 'INPUT') {
      // The TV keyboard's Done (65376) / Cancel (65385); Enter and Escape in a browser.
      if (e.keyCode === 65376 || e.keyCode === 13) { e.preventDefault(); input.blur(); move('down'); }
      else if (e.keyCode === 65385 || e.keyCode === 10009 || e.keyCode === 27) { e.preventDefault(); input.blur(); }
      return;
    }
    var k = KEYS[e.keyCode], s = top();
    if (!k || !s) return;
    e.preventDefault();
    if (!document.getElementById('busy').hidden && k !== 'back') return;
    if (s.key && s.key(k)) return;
    if (k === 'back') { if (!s.back || !s.back()) pop(); }
    else if (k === 'left' || k === 'right' || k === 'up' || k === 'down') move(k);
    else if (k === 'enter' && focused && s.el.contains(focused)) activate(focused);
  });

  function onClick(el, fn) { el.addEventListener('click', fn); return el; }

  function handle(err) {
    busy(false);
    if (err && err.status === 401) { reset(loginScreen(err.message)); return; }
    toast((err && err.message) || 'Something went wrong.');
  }

  // ---------------------------------------------------------------- login

  function loginScreen(message) {
    var s = { el: h('div', 'screen') };
    s.el.innerHTML =
      '<div class="login"><div class="brand">ororo<span>tv</span></div>' +
      '<p class="note">Sign in with your ororo.tv email and password.<br>Press OK on a field to type.</p>' +
      '<label>Email</label><input class="f" type="email" autocomplete="off" spellcheck="false">' +
      '<label>Password</label><input class="f" type="password">' +
      '<div class="btn f">Sign in</div><p class="err"></p></div>';
    var inputs = s.el.querySelectorAll('input'), err = $(s.el, '.err');
    var c = creds();
    if (c) inputs[0].value = c.user;
    err.textContent = message || '';
    onClick($(s.el, '.btn'), function () {
      var user = inputs[0].value.trim(), pass = inputs[1].value;
      if (!user || !pass) { err.textContent = 'Type both your email and your password.'; return; }
      store('creds', { user: user, pass: pass });
      start();
    });
    s.back = function () { exitApp(); return true; };
    return s;
  }

  function messageScreen(text) {
    var s = { el: h('div', 'screen') };
    var box = h('div', 'message', text);
    box.appendChild(h('br'));
    box.appendChild(onClick(h('div', 'btn f', 'Try again'), start));
    s.el.appendChild(box);
    return s;
  }

  // ---------------------------------------------------------------- home: tabs and the poster grid

  var SORTS = [['pop', 'Popular'], ['fresh', 'New'], ['rating', 'Top rated'], ['name', 'A–Z']];

  function homeScreen() {
    var s = { el: h('div', 'screen home') };
    s.el.innerHTML =
      '<div class="top"><div class="brand">ororo<span>tv</span></div><div class="tabs"></div></div>' +
      '<div class="search-bar" hidden><input class="f" type="text" placeholder="Search movies and shows" spellcheck="false"></div>' +
      '<div class="grid-box scroll"><div class="grid"></div><div class="empty" hidden></div></div>';
    var tabsEl = $(s.el, '.tabs'), searchBar = $(s.el, '.search-bar'), input = $(s.el, 'input');
    var gridEl = $(s.el, '.grid'), box = $(s.el, '.grid-box'), empty = $(s.el, '.empty');
    var items = [], rendered = 0, tab = null, sortIdx = load('sort', 0), cache = {};
    var lazy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var p = en.target;
        if (p.dataset.src) p.style.backgroundImage = 'url("' + p.dataset.src + '")';
        lazy.unobserve(p);
      });
    }, { root: box, rootMargin: '700px 0px' });

    var tabs = {};
    [['continue', 'Continue'], ['movie', 'Movies'], ['show', 'Shows'], ['search', 'Search']].forEach(function (t) {
      tabs[t[0]] = tabsEl.appendChild(h('div', 'tab f', t[1]));
      tabs[t[0]].dataset.tab = t[0];
    });
    var sortBtn = tabsEl.appendChild(onClick(h('div', 'tab sort f'), function () {
      sortIdx = (sortIdx + 1) % SORTS.length;
      store('sort', sortIdx);
      sortBtn.textContent = 'Sort: ' + SORTS[sortIdx][1];
      show(tab, true);
    }));
    sortBtn.textContent = 'Sort: ' + SORTS[sortIdx][1];
    tabsEl.appendChild(onClick(h('div', 'tab out f', 'Sign out'), function () { forget('creds'); reset(loginScreen()); }));

    function card(item, i) {
      var el = h('div', 'card f g');
      el.dataset.i = i;
      var poster = el.appendChild(h('div', 'poster'));
      if (item.poster) { poster.dataset.src = item.poster; lazy.observe(poster); }
      else poster.appendChild(h('div', 'ph', item.name));
      var p = item.kind === 'movie' ? posOf('movie', item.id) : null;
      if (p && !finished(p) && fraction(p) > 0.02) {
        var bar = poster.appendChild(h('div', 'bar'));
        bar.appendChild(h('i')).style.width = (fraction(p) * 100).toFixed(1) + '%';
      }
      el.appendChild(h('div', 'title', item.name + (item.year ? ' (' + item.year + ')' : '')));
      return onClick(el, function () { openDetails(item); });
    }
    function renderMore() {
      var frag = document.createDocumentFragment(), end = Math.min(items.length, rendered + CHUNK);
      for (; rendered < end; rendered++) frag.appendChild(card(items[rendered], rendered));
      gridEl.appendChild(frag);
    }
    s.grid = {
      item: function (i) { return gridEl.children[i]; },
      count: function () { return rendered; },
      ensure: function (i) { while (i >= rendered && rendered < items.length) renderMore(); }
    };
    function setItems(list, emptyText) {
      items = list;
      rendered = 0;
      gridEl.innerHTML = '';
      box.scrollTop = 0;
      renderMore();
      empty.hidden = list.length > 0;
      empty.textContent = emptyText || '';
    }
    function sorted(kind) {
      var key = SORTS[sortIdx][0], id = kind + ':' + key;
      if (!cache[id]) {
        cache[id] = catalog[kind].slice().sort(key === 'name'
          ? function (a, b) { return a.name.localeCompare(b.name); }
          : function (a, b) { return b[key] - a[key] || b.pop - a.pop; });
      }
      return cache[id];
    }
    var searchTimer;
    function search() {
      var q = input.value.trim().toLowerCase();
      if (!q) return setItems([], 'Press OK on the search box to type a title.');
      var hits = catalog.movie.concat(catalog.show).filter(function (it) { return it.name.toLowerCase().indexOf(q) >= 0; });
      hits.sort(function (a, b) {
        var sa = a.name.toLowerCase().indexOf(q) === 0, sb = b.name.toLowerCase().indexOf(q) === 0;
        return (sb - sa) || (b.pop - a.pop);
      });
      setItems(hits, 'Nothing found for “' + input.value.trim() + '”.');
    }
    input.addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(search, 350); });

    function show(name, force) {
      if (name === tab && !force) return;
      tab = name;
      Object.keys(tabs).forEach(function (k) { tabs[k].classList.toggle('on', k === name); });
      sortBtn.hidden = name !== 'movie' && name !== 'show';
      searchBar.hidden = name !== 'search';
      if (name === 'continue') setItems(continueItems(), 'Nothing here yet.');
      else if (name === 'search') search();
      else setItems(sorted(name), 'Ororo returned an empty list.');
    }

    s.focused = function (el) {
      if (el.dataset.tab) show(el.dataset.tab);
      if (el.classList.contains('g') && +el.dataset.i > rendered - 3 * COLS) renderMore();
    };
    s.shown = function () {
      tabs['continue'].hidden = !continueItems().length;
      if (tab === 'continue') {
        show('continue', true);
        return s.grid.item(0) || tabs['continue'];
      }
      return null;
    };
    // Back from the posters jumps to the tabs; back on the tabs leaves the app.
    s.back = function () {
      if (focused && focused.dataset.tab) { exitApp(); return true; }
      focus(tabs[tab]);
      return true;
    };

    var hasHistory = continueItems().length > 0;
    tabs['continue'].hidden = !hasHistory;
    show(hasHistory ? 'continue' : 'movie');
    s.start = tabs[tab];
    return s;
  }

  // ---------------------------------------------------------------- details

  function openDetails(item) { push(item.kind === 'movie' ? movieScreen(item) : showScreen(item)); }

  function detailsBase(item, cls) {
    var el = h('div', 'screen details ' + cls);
    el.innerHTML = '<div class="backdrop"></div><div class="shade"></div><div class="info"><h1></h1><div class="meta"></div><p class="desc"></p></div>';
    if (item.backdrop || item.poster) $(el, '.backdrop').style.backgroundImage = 'url("' + (item.backdrop || item.poster) + '")';
    $(el, 'h1').textContent = item.name;
    $(el, '.meta').textContent = [item.year, item.rating ? '★ ' + item.rating.toFixed(1) : '', item.genres.slice(0, 3).join(', ')]
      .filter(Boolean).join('   ·   ');
    $(el, '.desc').textContent = item.desc;
    return el;
  }

  function movieScreen(item) {
    var s = { el: detailsBase(item, 'movie') };
    var actions = $(s.el, '.info').appendChild(h('div', 'actions'));
    function build() {
      actions.innerHTML = '';
      var at = resumeAt(posOf('movie', item.id));
      var media = { kind: 'movie', id: item.id, title: item.name, sub: [item.year].filter(Boolean).join(''), item: item };
      if (at) {
        actions.appendChild(onClick(h('div', 'btn f', '▶  Resume from ' + clock(at)), function () { play(media, at); }));
        actions.appendChild(onClick(h('div', 'btn f', 'Play from start'), function () { play(media, 0); }));
      } else {
        actions.appendChild(onClick(h('div', 'btn f', '▶  Play'), function () { play(media, 0); }));
      }
      return actions.firstChild;
    }
    s.start = build();
    s.shown = build;
    return s;
  }

  function showScreen(item) {
    var s = { el: detailsBase(item, 'show') };
    var info = $(s.el, '.info');
    var loading = info.appendChild(h('div', 'loading', 'Loading episodes…'));
    var seasonsEl = info.appendChild(h('div', 'seasons hscroll'));
    var epsEl = info.appendChild(h('div', 'eps scroll'));
    var episodes = [], seasons = [], current = null, lastId = null;

    function epLabel(ep) { return 'Season ' + ep.season + ' · Episode ' + ep.number + (ep.title ? ' · ' + ep.title : ''); }
    function next() {
      // The episode after the last one finished, or the one in progress.
      var lastSeen = -1;
      episodes.forEach(function (ep, i) { if (posOf('episode', ep.id)) lastSeen = i; });
      if (lastSeen < 0) return episodes[0];
      return finished(posOf('episode', episodes[lastSeen].id)) && episodes[lastSeen + 1] ? episodes[lastSeen + 1] : episodes[lastSeen];
    }
    function renderSeason(season) {
      current = season;
      Array.prototype.forEach.call(seasonsEl.children, function (c) { c.classList.toggle('on', +c.dataset.season === season); });
      epsEl.innerHTML = '';
      epsEl.scrollTop = 0;
      episodes.forEach(function (ep, i) {
        if (ep.season !== season) return;
        var row = h('div', 'ep f');
        row.dataset.id = ep.id;
        row.appendChild(h('div', 'n', ep.number));
        var txt = row.appendChild(h('div', 'txt'));
        txt.appendChild(h('div', 'et', ep.title || 'Episode ' + ep.number));
        if (ep.plot) txt.appendChild(h('div', 'plot', plain(ep.plot)));
        var state = row.appendChild(h('div', 'state')), p = posOf('episode', ep.id);
        if (finished(p)) state.textContent = '✓ Watched';
        else if (fraction(p) > 0.02) state.appendChild(h('div', 'mini')).appendChild(h('i')).style.width = (fraction(p) * 100).toFixed(1) + '%';
        epsEl.appendChild(onClick(row, function () { playEpisode(i); }));
      });
    }
    function rowFor(id) { return $(epsEl, '.ep[data-id="' + id + '"]'); }
    function playEpisode(i) {
      var ep = episodes[i];
      lastId = ep.id;
      play({
        kind: 'episode', id: ep.id, title: item.name, sub: epLabel(ep), item: item, episodes: episodes, index: i,
        onChange: function (other) { lastId = other.id; }
      }, resumeAt(posOf('episode', ep.id)));
    }
    function focusEpisode(ep) {
      if (!ep) return;
      if (ep.season !== current) renderSeason(ep.season);
      focus(rowFor(ep.id));
    }

    api('/shows/' + item.id).then(function (d) {
      loading.remove();
      episodes = (d.episodes || []).map(function (ep) {
        return { id: ep.id, season: +ep.season || 1, number: +ep.number || 0, title: ep.title || ep.name || '', plot: ep.plot || ep.desc || '' };
      }).sort(function (a, b) { return a.season - b.season || a.number - b.number; });
      if (!episodes.length) { info.appendChild(h('div', 'loading', 'No episodes yet.')); return; }
      episodes.forEach(function (ep) { if (seasons.indexOf(ep.season) < 0) seasons.push(ep.season); });
      seasons.forEach(function (n) {
        var chip = seasonsEl.appendChild(h('div', 'chip f', 'Season ' + n));
        chip.dataset.season = n;
        onClick(chip, function () { focus($(epsEl, '.ep')); });
      });
      var n = next();
      renderSeason(n.season);
      if (top() === s) focusEpisode(n);
      else s.last = rowFor(n.id);
    }).catch(function (e) {
      loading.textContent = 'Couldn’t load the episodes.';
      handle(e);
    });

    s.focused = function (el) {
      if (el.dataset.season && +el.dataset.season !== current) renderSeason(+el.dataset.season);
    };
    s.shown = function () {
      // Back from the player: redraw the ticks and progress, and stand on the episode that was playing.
      var ep = episodes.filter(function (x) { return x.id === lastId; })[0];
      if (!ep) return null;
      renderSeason(ep.season);
      return rowFor(ep.id);
    };
    return s;
  }

  // ---------------------------------------------------------------- player

  function play(media, at) {
    remember(media.item.kind, media.item.id);
    push(playerScreen(media, at));
  }

  function playerScreen(media, startAt) {
    var s = { el: h('div', 'screen player') };
    s.el.innerHTML =
      '<video preload="auto"></video><div class="subs"></div><div class="paused-icon" hidden>❚❚</div>' +
      '<div class="osd"><div class="ttl"></div><div class="sub"></div><div class="track"><i></i></div>' +
      '<div class="row"><span class="time"></span><span class="hint"></span></div>' +
      '<div class="osd-actions"><div class="pbtn cc"></div></div></div>' +
      '<div class="menu" hidden><div class="menu-title">Subtitles</div><div class="menu-list"></div><div class="menu-note"></div></div>';
    var video = $(s.el, 'video'), subsEl = $(s.el, '.subs'), pausedIcon = $(s.el, '.paused-icon');
    var bar = $(s.el, '.track i'), timeEl = $(s.el, '.time'), hintEl = $(s.el, '.hint');
    var sources = [], srcIndex = 0, resume = 0, subsList = [], subIdx = -1, cues = [], shownText = '', sentKeys = '';
    var ccBtn = $(s.el, '.cc'), menu = $(s.el, '.menu'), menuList = $(s.el, '.menu-list'), menuNote = $(s.el, '.menu-note');
    var ccFocus = false, menuIdx = 0, subError = '';
    var osdTimer, saveTimer, subTimer, seekTarget = null, seekTimer, seekStep = 10, lastSeek = 0, closed = false;

    function key() { return media.kind === 'movie' ? 'movie' : 'episode'; }
    function save() {
      if (video.currentTime > 0 && isFinite(video.duration)) savePos(key(), media.id, video.currentTime, video.duration);
    }
    function osd(on) {
      clearTimeout(osdTimer);
      s.el.classList.toggle('osd-on', on);
      if (on && !video.paused && !ccFocus && menu.hidden) osdTimer = setTimeout(function () { s.el.classList.remove('osd-on'); }, 4000);
      renderOsd();
    }
    function renderOsd() {
      var t = seekTarget != null ? seekTarget : video.currentTime, d = video.duration;
      bar.style.width = (isFinite(d) && d ? Math.min(100, t / d * 100) : 0).toFixed(2) + '%';
      timeEl.textContent = clock(t) + (isFinite(d) ? '  /  ' + clock(d) : '');
      hintEl.textContent = ccFocus ? 'OK  choose subtitles    ◀ ▶ seek' : '◀ ▶ seek    ▼ subtitles    OK pause';
      ccBtn.textContent = 'CC   Subtitles: ' + (subIdx < 0 ? 'Off' : subLabel(subIdx));
      ccBtn.classList.toggle('focus', ccFocus);
    }

    // The subtitles list: Off, then every language Ororo has for this video.
    function subLabel(i) {
      var lang = subsList[i].lang, same = subsList.filter(function (x) { return x.lang === lang; }).length;
      var nth = subsList.slice(0, i + 1).filter(function (x) { return x.lang === lang; }).length;
      return langName(lang) + (same > 1 ? ' ' + nth : '');
    }
    function openMenu() {
      menuIdx = subIdx + 1;
      menu.hidden = false;
      renderMenu();
      osd(true);
    }
    function closeMenu() {
      menu.hidden = true;
      osd(true);
    }
    function renderMenu() {
      menuList.innerHTML = '';
      ['Off'].concat(subsList.map(function (x, i) { return subLabel(i); })).forEach(function (label, i) {
        var row = menuList.appendChild(h('div', 'menu-item' + (i === menuIdx ? ' on' : '')));
        row.appendChild(h('span', '', label));
        if (i === subIdx + 1) row.appendChild(h('span', 'tick', '✓'));
      });
      var on = menuList.children[menuIdx];
      if (on) on.scrollIntoView({ block: 'nearest' });
      menuNote.textContent = !subsList.length
        ? 'Ororo has no subtitles for this video.' + (sentKeys ? ' (It sent: ' + sentKeys + ')' : '')
        : subError ? 'Last problem: ' + subError : '';
    }

    // Subtitles: fetched and drawn here (bigger and easier to read than the TV's own), the TV's <track> if that fails.
    function parseSubs(text) {
      var out = [];
      text.replace(/^﻿/, '').replace(/\r/g, '').split(/\n\s*\n/).forEach(function (block) {
        var lines = block.split('\n'), j = 0;
        while (j < lines.length && lines[j].indexOf('-->') < 0) j++;
        if (j === lines.length) return;
        var times = lines[j].split('-->'), from = toSec(times[0]), to = toSec(times[1]);
        var body = lines.slice(j + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
        if (body && !isNaN(from) && !isNaN(to)) out.push({ s: from, e: to, t: body });
      });
      return out.sort(function (a, b) { return a.s - b.s; });
    }
    function toSec(str) {
      var m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(str || '');
      return m ? (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]) + +('0.' + m[4]) : NaN;
    }
    function tickSubs() {
      var t = video.currentTime, lo = 0, hi = cues.length - 1, i = -1, text = '';
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (cues[mid].s <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
      for (var k = Math.max(0, i - 2); k <= i; k++) if (cues[k].e >= t) text += (text ? '\n' : '') + cues[k].t;
      if (text !== shownText) { shownText = text; subsEl.textContent = text; }
    }
    function dropTracks() {
      Array.prototype.forEach.call(video.querySelectorAll('track'), function (t) { t.remove(); });
    }
    function setSub(i, quiet) {
      subIdx = i;
      cues = [];
      shownText = '';
      subsEl.textContent = '';
      dropTracks();
      if (!quiet) store('sublang', i < 0 ? 'off' : subsList[i].lang);
      renderOsd();
      if (i < 0) return;
      var sub = subsList[i];
      subText(sub.url).then(function (text) {
        if (subIdx !== i) return;
        cues = parseSubs(text);
        if (!cues.length) toast('Subtitles: the ' + langName(sub.lang) + ' file came back empty or unreadable.');
      }).catch(function (err) {
        if (subIdx !== i) return;
        subError = err.message;
        toast('Subtitles didn’t load (' + err.message + '). Trying the TV’s own subtitles.');
        var tr = h('track');
        tr.kind = 'subtitles';
        tr.srclang = sub.lang;
        tr.src = sub.url;
        tr.default = true;
        video.appendChild(tr);
        try { video.textTracks[video.textTracks.length - 1].mode = 'showing'; } catch (e) {}
      });
    }
    // Plain first; with the account's login if the file is behind it.
    function subText(url) {
      function get(opts) {
        return fetch(url, opts).then(function (r) {
          if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
          return r.text();
        });
      }
      return get({}).catch(function (e) {
        return get({ headers: { Authorization: basicAuth() } }).catch(function (e2) {
          throw new Error((e.status ? e.message : 'blocked') + ' / ' + (e2.status ? e2.message : 'blocked') + ', ' + url.slice(0, 60));
        });
      });
    }
    // Ororo sends [{lang, url}]; accept a {lang: url} map and other field names too.
    function subtitleList(raw) {
      if (!raw) return [];
      var list = Array.isArray(raw) ? raw : Object.keys(raw).map(function (k) {
        return typeof raw[k] === 'string' ? { lang: k, url: raw[k] } : Object.assign({ lang: k }, raw[k]);
      });
      return list.map(function (x) {
        var url = x && (x.url || x.file || x.src || x.link || x.path);
        return url ? { lang: x.lang || x.language || x.locale || x.code || '', url: abs(url) } : null;
      }).filter(Boolean);
    }
    function pickSub() {
      var pref = load('sublang', 'en'), langs = subsList.map(function (x) { return x.lang; });
      if (pref === 'off') return -1;
      var i = langs.indexOf(pref);
      return i >= 0 ? i : langs.indexOf('en');
    }

    function trySource(i) {
      srcIndex = i;
      video.src = sources[i];
      video.load();
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    }
    function begin(at) {
      busy(true, media.sub || media.title);
      osd(true);
      $(s.el, '.ttl').textContent = media.title;
      $(s.el, '.sub').textContent = media.sub || '';
      api((media.kind === 'movie' ? '/movies/' : '/episodes/') + media.id).then(function (d) {
        if (closed) return;
        var url = d.url ? String(d.url).replace('playlist_fmp4.m3u8', 'playlist.m3u8') : '';
        sources = [url, d.download_url].filter(Boolean).map(abs);
        if (!sources.length) throw new Error('Ororo didn’t give a video for this one.');
        subsList = subtitleList(d.subtitles || d.subs || d.subtitle_files);
        sentKeys = Object.keys(d).join(', ');
        if (!subsList.length && d.subtitles) sentKeys += ' — subtitles: ' + JSON.stringify(d.subtitles).slice(0, 120);
        setSub(pickSub(), true);
        resume = at || 0;
        trySource(0);
      }).catch(function (e) {
        handle(e);
        if (!closed) pop();
      });
    }

    video.addEventListener('loadedmetadata', function () {
      if (resume) { video.currentTime = resume; resume = 0; }
    });
    video.addEventListener('playing', function () {
      busy(false);
      pausedIcon.hidden = true;
      screensaver(false);
      osd(s.el.classList.contains('osd-on'));
    });
    video.addEventListener('pause', function () {
      pausedIcon.hidden = false;
      screensaver(true);
      save();
      osd(true);
    });
    video.addEventListener('waiting', function () { if (!video.paused) busy(true); });
    video.addEventListener('timeupdate', function () { if (s.el.classList.contains('osd-on')) renderOsd(); });
    video.addEventListener('error', function () {
      if (closed) return;
      if (srcIndex + 1 < sources.length) { trySource(srcIndex + 1); return; }
      busy(false);
      toast('This video won’t play on this TV.');
      pop();
    });
    video.addEventListener('ended', function () {
      savePos(key(), media.id, video.duration, video.duration);
      var nextEp = media.episodes && media.episodes[media.index + 1];
      if (!nextEp) { pop(); return; }
      media.index++;
      media.id = nextEp.id;
      media.sub = 'Season ' + nextEp.season + ' · Episode ' + nextEp.number + (nextEp.title ? ' · ' + nextEp.title : '');
      if (media.onChange) media.onChange(nextEp);
      toast('Next: ' + media.sub);
      begin(resumeAt(posOf('episode', nextEp.id)));
    });

    function seekBy(sign) {
      if (!isFinite(video.duration)) return;
      var now = Date.now();
      seekStep = now - lastSeek < 600 ? Math.min(seekStep * 1.5, 300) : 10;   // hold the button to go faster
      lastSeek = now;
      if (seekTarget == null) seekTarget = video.currentTime;
      seekTarget = Math.max(0, Math.min(video.duration - 3, seekTarget + sign * seekStep));
      osd(true);
      clearTimeout(seekTimer);
      seekTimer = setTimeout(function () {
        video.currentTime = seekTarget;
        seekTarget = null;
        cues.length && tickSubs();
      }, 650);
    }
    function toggle() {
      var p;
      if (video.paused) { p = video.play(); if (p && p.catch) p.catch(function () {}); }
      else video.pause();
    }

    s.key = function (k) {
      if (!menu.hidden) {
        if (k === 'up') menuIdx = Math.max(0, menuIdx - 1);
        else if (k === 'down') menuIdx = Math.min(subsList.length, menuIdx + 1);
        else if (k === 'enter') { setSub(menuIdx - 1); closeMenu(); return true; }
        else if (k === 'back' || k === 'left') { closeMenu(); return true; }
        else if (k === 'playpause' || k === 'play' || k === 'pause') { toggle(); return true; }
        else return true;
        renderMenu();
        return true;
      }
      if (k === 'enter' && ccFocus) openMenu();
      else if (k === 'enter' || k === 'playpause') toggle();
      else if (k === 'play') { if (video.paused) toggle(); }
      else if (k === 'pause') { if (!video.paused) video.pause(); }
      else if (k === 'left' || k === 'rw') { ccFocus = false; seekBy(-1); }
      else if (k === 'right' || k === 'ff') { ccFocus = false; seekBy(1); }
      else if (k === 'down') { ccFocus = true; osd(true); }
      else if (k === 'up') { ccFocus = false; osd(true); }
      else if (k === 'back' && ccFocus) { ccFocus = false; osd(false); }
      else if (k === 'stop') pop();
      else return false;
      return true;
    };
    s.close = function () {
      closed = true;
      save();
      clearInterval(saveTimer);
      clearInterval(subTimer);
      clearTimeout(osdTimer);
      clearTimeout(seekTimer);
      busy(false);
      screensaver(true);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
    saveTimer = setInterval(save, 10000);
    subTimer = setInterval(function () { if (cues.length) tickSubs(); }, 150);
    begin(startAt);
    return s;
  }

  // ---------------------------------------------------------------- start

  function start() {
    if (!creds()) { reset(loginScreen()); return; }
    busy(true, 'Loading Ororo…');
    loadCatalog().then(function () {
      busy(false);
      reset(homeScreen());
    }, function (e) {
      busy(false);
      if (e.status === 401) reset(loginScreen(e.message));
      else reset(messageScreen(e.message || 'Couldn’t load Ororo.'));
    });
  }

  try {
    tizen.tvinputdevice.registerKeyBatch(['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind']);
  } catch (e) { /* not on a TV */ }
  start();
})();
