/*
 * Ororo TV for iPhone: a web app (Safari → Share → Add to Home Screen) for ororo.tv's movies and shows.
 * Same Ororo API and storage keys as the TV app (www/app.js), laid out for touch. Playback uses the iPhone's own
 * video controls (full screen, AirPlay); subtitles become <track>s so they show there too.
 */
(function () {
  'use strict';

  var API_HOSTS = ['https://front.ororo.tv', 'https://front.ororo-mirror.tv', 'https://ororo.tv'];
  var FRESH_MS = 3 * 3600 * 1000; // a saved catalogue this young is used as it is
  var CHUNK = 60;          // posters added at a time while scrolling
  var STEP = 10;           // seconds per −10 / +10 tap
  var LANGS = {
    en: 'English', ru: 'Русский', uk: 'Українська', es: 'Español', de: 'Deutsch', fr: 'Français', it: 'Italiano',
    pt: 'Português', pl: 'Polski', tr: 'Türkçe', hy: 'Հայերեն', ja: '日本語', zh: '中文', ko: '한국어', ar: 'العربية',
    he: 'עברית', cs: 'Čeština', nl: 'Nederlands', sv: 'Svenska', ro: 'Română', el: 'Ελληνικά', hu: 'Magyar'
  };

  // ---------------------------------------------------------------- helpers

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
  function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }
  function forget(key) { try { localStorage.removeItem(key); } catch (e) {} }
  function clock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var hh = Math.floor(sec / 3600), mm = Math.floor(sec / 60) % 60, ss = sec % 60;
    return (hh ? hh + ':' + (mm < 10 ? '0' : '') : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
  }
  function plain(html) { return String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
  function langName(code) { return LANGS[code] || String(code || '?').toUpperCase(); }

  var toastTimer;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4500);
  }

  // ---------------------------------------------------------------- Ororo's API (as in the TV app)

  // The host that answered last time goes first, so a dead one doesn't cost a wait on every launch.
  var activeHost = load('apihost', null);
  if (API_HOSTS.indexOf(activeHost) < 0) activeHost = null;
  function creds() { return load('creds', null); }
  function basicAuth() {
    var c = creds() || { user: '', pass: '' };
    return 'Basic ' + btoa(unescape(encodeURIComponent(c.user + ':' + c.pass)));
  }
  function httpError(status) {
    var e = new Error(status === 401 ? 'Wrong email or password.'
      : status === 402 ? 'Your Ororo plan doesn’t cover this, or today’s free limit is used up.'
      : 'Ororo answered with an error (' + status + ').');
    e.status = status;
    return e;
  }
  function api(path) {
    if (!creds()) return Promise.reject(httpError(401));
    var headers = { Accept: 'application/json', Authorization: basicAuth() };
    var hosts = activeHost ? [activeHost].concat(API_HOSTS.filter(function (x) { return x !== activeHost; })) : API_HOSTS.slice();
    function attempt(i) {
      if (i >= hosts.length) return Promise.reject(new Error('Can’t reach Ororo. Check your internet connection.'));
      var ctrl = new AbortController(), timer = setTimeout(function () { ctrl.abort(); }, i < hosts.length - 1 ? 12000 : 40000);
      return fetch(hosts[i] + '/api/v2' + path, { headers: headers, signal: ctrl.signal }).then(function (res) {
        clearTimeout(timer);
        if (activeHost !== hosts[i]) store('apihost', hosts[i]);
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
    return u.replace(/^http:\/\//, 'https://');
  }

  // ---------------------------------------------------------------- catalogue, progress, history

  var catalog = { movie: [], show: [] }, byId = { movie: {}, show: {} }, loaded = false;
  function slim(kind, r) {
    return {
      kind: kind, id: r.id, name: r.name || r.title || '', year: r.year || '',
      poster: abs(r.poster_thumb || r.poster), backdrop: abs(r.backdrop_url),
      rating: parseFloat(r.imdb_rating) || 0, genres: r.array_genres || [], desc: plain(r.desc),
      pop: +r.user_popularity || 0, fresh: Date.parse(r.newest_video || r.updated_at || '') || 0
    };
  }
  function applyCatalog(data) {
    catalog.movie = data.movie;
    catalog.show = data.show;
    ['movie', 'show'].forEach(function (k) {
      byId[k] = {};
      catalog[k].forEach(function (it) { byId[k][it.id] = it; });
    });
    loaded = true;
  }
  function loadCatalog() {
    return Promise.all([api('/movies'), api('/shows')]).then(function (res) {
      var data = {
        movie: (res[0].movies || []).map(function (r) { return slim('movie', r); }),
        show: (res[1].shows || []).map(function (r) { return slim('show', r); })
      };
      applyCatalog(data);
      data.savedAt = Date.now();
      cachePut(data);
    });
  }

  // The lists are saved on the phone (IndexedDB) so the app opens at once and refreshes them in the background.
  // Every call is best-effort: with no IndexedDB the app simply loads from Ororo each time, as before.
  function cacheDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no IndexedDB')); return; }
      var r = indexedDB.open('ororo', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function cacheGet() {
    return cacheDb().then(function (db) {
      return new Promise(function (resolve) {
        var q = db.transaction('kv').objectStore('kv').get('catalog');
        q.onsuccess = function () { resolve(q.result || null); };
        q.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }
  function cachePut(data) {
    cacheDb().then(function (db) { db.transaction('kv', 'readwrite').objectStore('kv').put(data, 'catalog'); }).catch(function () {});
  }
  function cacheClear() {
    cacheDb().then(function (db) { db.transaction('kv', 'readwrite').objectStore('kv').delete('catalog'); }).catch(function () {});
  }

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
  function remember(kind, id) {
    var list = load('history', []).filter(function (x) { return !(x.kind === kind && x.id === id); });
    list.unshift({ kind: kind, id: id });
    store('history', list.slice(0, 40));
  }
  function continueItems() {
    return load('history', []).map(function (x) { return byId[x.kind][x.id]; }).filter(Boolean);
  }

  function svg(body, cls) {
    return '<svg class="' + (cls || 'ico') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  }
  var ICON = {
    continue: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    movie: svg('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 4v16M16 4v16M3 9h5M3 15h5M16 9h5M16 15h5"/>'),
    show: svg('<rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M8 21h8M12 17v4"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
    person: svg('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>'),
    back: svg('<path d="M14.5 5.5L8 12l6.5 6.5"/>'),
    play: svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>', 'ico sm'),
    chevrons: svg('<path d="M8 10l4-4 4 4M8 14l4 4 4-4"/>', 'ico sm'),
    clear: svg('<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none" opacity=".35"/><path d="M9 9l6 6M15 9l-6 6" stroke="#fff"/>'),
    download: svg('<path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14"/>'),
    check: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/>'),
    watched: svg('<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/><path d="M8 12.5l2.7 2.7L16 9.8" stroke="var(--surface)" stroke-width="2"/>', 'ico sm')
  };

  // A bottom sheet for a short decision: a grabber, a title, actions, and always a way out.
  function sheet(title, message, actions) {
    var scrim = document.body.appendChild(h('div', 'scrim')), box = scrim.appendChild(h('div', 'sheet'));
    var prev = document.activeElement;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', title);
    box.appendChild(h('div', 'grab'));
    box.appendChild(h('h2', '', title));
    if (message) box.appendChild(h('p', '', message));
    function close() {
      document.removeEventListener('keydown', onKey);
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      if (prev && prev.focus) prev.focus();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    actions.concat([{ label: 'Cancel' }]).forEach(function (a) {
      var b = box.appendChild(h('button', 'btn' + (a.danger ? ' danger' : ''), a.label));
      b.onclick = function () { close(); if (a.run) a.run(); };
    });
    scrim.onclick = function (e) { if (e.target === scrim) close(); };
    box.querySelector('.btn').focus();
  }

  // Download without playing. Tap 1 asks Ororo for the MP4 link; it then turns into a real link, because Safari only
  // opens a link after a direct tap, not after waiting for the network. Tap 2 opens it and Safari offers to save it.
  function downloadAction(kind, id, cls, icon) {
    var b = h('button', cls);
    b.setAttribute('aria-label', 'Download');
    function idle() { b.disabled = false; if (icon) b.innerHTML = ICON.download; else b.innerHTML = ICON.download + '<span>Download</span>'; }
    idle();
    b.onclick = function () {
      b.disabled = true;
      b.innerHTML = icon ? '<span aria-hidden="true">…</span>' : 'Preparing…';
      api((kind === 'movie' ? '/movies/' : '/episodes/') + id).then(function (d) {
        var url = abs(d.download_url);
        if (!url) throw new Error('Ororo didn’t give a download link for this one.');
        var a = h('a', cls + ' ready');
        if (icon) a.innerHTML = ICON.download; else a.innerHTML = ICON.download + '<span>Tap to save</span>';
        a.href = url; a.target = '_blank'; a.rel = 'noopener';
        a.setAttribute('aria-label', 'Save file');
        b.parentNode.replaceChild(a, b);
        toast('Ready. Tap the highlighted download button to save. If it plays instead of saving, tap Share → Save to Files.');
      }).catch(function (e) {
        idle();
        if (e.status === 401) { forget('creds'); cacheClear(); loaded = false; route(); return; }
        toast(e.message || 'Couldn’t get the download link.');
      });
    };
    return b;
  }

  // ---------------------------------------------------------------- routing: #/  #/movie/ID  #/show/ID

  var app = document.getElementById('app');
  var player = null, homeState = { tab: null, sort: Math.min(+load('sort', 0) || 0, 4), query: '', rendered: CHUNK, scroll: 0 };

  function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

  var TABS = [['continue', 'Continue'], ['movie', 'Movies'], ['show', 'Shows'], ['search', 'Search']];
  var tabbar = document.getElementById('tabbar');

  // The tab bar belongs to the signed-in app: navigation only, and visible on every screen but sign-in and loading.
  function chrome(on, active) {
    document.body.classList.toggle('bare', !on);
    tabbar.hidden = !on;
    if (!on) return;
    tabbar.innerHTML = '';
    TABS.forEach(function (t) {
      var a = tabbar.appendChild(h('a'));
      a.href = '#/tab/' + t[0];
      a.innerHTML = ICON[t[0]];
      a.appendChild(h('span', '', t[1]));
      if (t[0] === active) a.setAttribute('aria-current', 'page');
    });
  }

  function route() {
    if (player) { player.destroy(); player = null; }
    if (!creds()) { chrome(false); return renderLogin(); }
    if (!loaded) { chrome(false); return boot(); }
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    if (parts[0] === 'tab' && TABS.some(function (t) { return t[0] === parts[1]; })) {
      homeState.tab = parts[1];
      homeState.rendered = CHUNK;
      homeState.scroll = 0;
    }
    var item = parts[0] === 'movie' || parts[0] === 'show' ? byId[parts[0]][parts[1]] : null;
    if (item) { chrome(true, homeState.tab || (item.kind === 'show' ? 'show' : 'movie')); renderDetail(item); }
    else { if (!homeState.tab) homeState.tab = continueItems().length ? 'continue' : 'movie'; chrome(true, homeState.tab); renderHome(); }
  }
  window.addEventListener('hashchange', route);

  function boot() {
    cacheGet().then(function (saved) {
      if (!saved || !saved.movie || !saved.show || !creds()) { bootFresh(); return; }
      applyCatalog(saved);
      route();
      if (saved.savedAt && Date.now() - saved.savedAt < FRESH_MS) return;
      // Fresh lists arrive quietly; they show the next time a screen is drawn. Offline or a hiccup: keep the saved ones.
      loadCatalog().catch(function (e) {
        if (e.status === 401) { forget('creds'); loaded = false; cacheClear(); renderLogin(e.message); }
      });
    });
  }
  function bootFresh() {
    app.innerHTML = '<div class="loading"><div class="spinner"></div><div>Loading Ororo…</div></div>';
    loadCatalog().then(route, function (e) {
      if (e.status === 401) { forget('creds'); cacheClear(); renderLogin(e.message); return; }
      app.innerHTML = '';
      var box = app.appendChild(h('div', 'loading'));
      box.appendChild(h('div', '', e.message || 'Couldn’t load Ororo.'));
      box.appendChild(h('button', 'btn primary', 'Try again')).onclick = bootFresh;
    });
  }

  // ---------------------------------------------------------------- login

  function renderLogin(message) {
    app.innerHTML =
      '<form class="login" novalidate><div class="brand">ororo<span>tv</span></div>' +
      '<p>Sign in with your ororo.tv email and password. They stay on this phone.</p>' +
      '<label for="em">Email</label><input id="em" type="email" inputmode="email" autocomplete="username" autocapitalize="off" spellcheck="false" required>' +
      '<label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>' +
      '<button class="btn primary" type="submit">Sign in</button><p class="err" role="alert"></p></form>';
    var form = $(app, 'form'), inputs = form.querySelectorAll('input'), err = $(form, '.err');
    err.textContent = message || '';
    form.onsubmit = function (e) {
      e.preventDefault();
      if (!inputs[0].value.trim() || !inputs[1].value) { err.textContent = 'Enter your ororo.tv email and password.'; (inputs[0].value.trim() ? inputs[1] : inputs[0]).focus(); return; }
      store('creds', { user: inputs[0].value.trim(), pass: inputs[1].value });
      loaded = false;
      boot();
    };
  }

  // ---------------------------------------------------------------- home

  // 'year' is the release year, newest first, with a heading per year. The order of the first four is kept for saved choices.
  var SORTS = [['pop', 'Popular'], ['fresh', 'Recently added'], ['rating', 'Top rated'], ['name', 'A–Z'], ['year', 'Release year']];
  var sortCache = {};

  function sorted(kind) {
    var key = SORTS[homeState.sort][0], id = kind + ':' + key;
    if (!sortCache[id]) {
      sortCache[id] = catalog[kind].slice().sort(key === 'name'
        ? function (a, b) { return a.name.localeCompare(b.name); }
        : key === 'year'
          ? function (a, b) { return yearOf(b) - yearOf(a) || b.pop - a.pop; }
          : function (a, b) { return b[key] - a[key] || b.pop - a.pop; });
    }
    return sortCache[id];
  }
  function yearOf(it) { return parseInt(it.year, 10) || 0; }

  function searchResults(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    return catalog.movie.concat(catalog.show).filter(function (it) { return it.name.toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) {
        var sa = a.name.toLowerCase().indexOf(q) === 0, sb = b.name.toLowerCase().indexOf(q) === 0;
        return (sb - sa) || (b.pop - a.pop);
      });
  }

  function renderHome() {
    var tab = homeState.tab, title = TABS.filter(function (t) { return t[0] === tab; })[0][1];
    app.innerHTML =
      '<div class="largetitle"><h1 class="t-large"></h1><span class="tools"></span>' +
      '<button class="round account" aria-label="Account">' + ICON.person + '</button></div>' +
      '<div class="grid"></div><div class="empty" hidden></div><div class="sentinel"></div>';
    $(app, 'h1').textContent = title;
    var tools = $(app, '.tools'), grid = $(app, '.grid'), empty = $(app, '.empty');
    var items = [], rendered = 0;

    $(app, '.account').onclick = function () {
      sheet('Sign out of Ororo?', 'You’ll need your ororo.tv email and password to sign in again. Your watched episodes and places stay on this phone.', [
        { label: 'Sign out', danger: true, run: function () { forget('creds'); cacheClear(); loaded = false; route(); } }
      ]);
    };

    if (tab === 'search') {
      var bar = h('div', 'searchbar');
      bar.innerHTML = '<form class="field" role="search">' + ICON.search + '<input type="search" enterkeyhint="search" autocomplete="off" ' +
        'autocapitalize="off" spellcheck="false" placeholder="Movies and shows" aria-label="Search movies and shows">' +
        '<button type="button" class="clear" aria-label="Clear search" hidden>' + ICON.clear + '</button></form>';
      app.insertBefore(bar, grid);
      var input = $(bar, 'input'), clear = $(bar, '.clear');
      input.value = homeState.query;
      clear.hidden = !input.value;
      $(bar, 'form').onsubmit = function (e) { e.preventDefault(); input.blur(); };
      clear.onclick = function () { input.value = ''; input.oninput(); input.focus(); };
      input.oninput = function () {
        homeState.query = input.value;
        clear.hidden = !input.value;
        clearTimeout(input._t);
        input._t = setTimeout(function () { fill(searchResults(input.value)); }, 200);
      };
      if (!homeState.query) setTimeout(function () { input.focus(); }, 50);
    } else if (tab !== 'continue') {
      // The select on top of the button opens iOS's own picker.
      var m = tools.appendChild(h('label', 'menu')), pill = m.appendChild(h('span', 'pill'));
      var pillText = pill.appendChild(h('span', '', SORTS[homeState.sort][1]));
      pill.insertAdjacentHTML('beforeend', ICON.chevrons);
      var sel = m.appendChild(h('select'));
      sel.setAttribute('aria-label', 'Sort by');
      SORTS.forEach(function (x, i) { sel.appendChild(h('option', '', x[1])).value = i; });
      sel.value = homeState.sort;
      sel.onchange = function () {
        homeState.sort = +sel.value;
        store('sort', homeState.sort);
        homeState.rendered = CHUNK;
        pillText.textContent = SORTS[homeState.sort][1];
        window.scrollTo(0, 0);
        fill(sorted(tab));
      };
    }

    function card(item) {
      var a = h('a', 'card');
      a.href = '#/' + item.kind + '/' + item.id;
      var poster = a.appendChild(h('div', 'poster'));
      if (item.poster) {
        var img = poster.appendChild(h('img'));
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        img.src = item.poster;
      } else poster.appendChild(h('div', 'ph', item.name));
      var p = item.kind === 'movie' ? posOf('movie', item.id) : null;
      if (p && !finished(p) && fraction(p) > 0.02) poster.appendChild(h('div', 'bar')).appendChild(h('i')).style.width = (fraction(p) * 100).toFixed(1) + '%';
      a.appendChild(h('div', 'title', item.name));
      a.appendChild(h('div', 'sub', [item.year, item.kind === 'show' ? 'Show' : ''].filter(Boolean).join(' · ')));
      a.onclick = function () { homeState.scroll = window.scrollY; homeState.rendered = rendered; };
      return a;
    }
    var byYear = false, lastYear = null;
    function more(upTo) {
      var frag = document.createDocumentFragment(), end = Math.min(items.length, upTo || rendered + CHUNK);
      for (; rendered < end; rendered++) {
        var it = items[rendered];
        if (byYear && yearOf(it) !== lastYear) {
          lastYear = yearOf(it);
          frag.appendChild(h('h2', 'yearhead', lastYear ? String(lastYear) : 'Year unknown'));
        }
        frag.appendChild(card(it));
      }
      grid.appendChild(frag);
    }
    function emptyState() {
      empty.innerHTML = '';
      if (tab === 'continue') {
        empty.appendChild(h('strong', '', 'Nothing to continue yet'));
        empty.appendChild(h('span', '', 'Movies and shows you start playing show up here.'));
        empty.appendChild(h('a', 'btn primary', 'Browse movies')).href = '#/tab/movie';
      } else if (tab === 'search') {
        empty.appendChild(h('strong', '', homeState.query.trim() ? 'No results' : 'Search Ororo'));
        empty.appendChild(h('span', '', homeState.query.trim() ? 'Nothing matches “' + homeState.query.trim() + '”. Check the spelling or try a shorter title.' : 'Find any movie or show by its title.'));
      } else {
        empty.appendChild(h('strong', '', 'Ororo sent an empty list'));
        empty.appendChild(h('span', '', 'Pull down to try again, or sign out and back in.'));
      }
    }
    function fill(list, upTo) {
      items = list;
      rendered = 0;
      lastYear = null;
      byYear = (tab === 'movie' || tab === 'show') && SORTS[homeState.sort][0] === 'year';
      grid.innerHTML = '';
      more(upTo || CHUNK);
      empty.hidden = list.length > 0;
      if (!list.length) emptyState();
    }

    if (tab === 'continue') fill(continueItems(), homeState.rendered);
    else if (tab === 'search') fill(searchResults(homeState.query));
    else fill(sorted(tab), homeState.rendered);

    new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && rendered < items.length) more();
    }, { rootMargin: '1200px 0px' }).observe($(app, '.sentinel'));
    window.scrollTo(0, homeState.scroll);
  }

  // ---------------------------------------------------------------- movie and show pages

  function renderDetail(item) {
    app.innerHTML =
      '<div class="detail"><button class="round glass back" aria-label="Back">' + ICON.back + '</button>' +
      '<div class="stage" role="img"></div><div class="body"><h1></h1><div class="meta"></div><p class="now" hidden></p>' +
      '<div class="actions"></div><div class="player-ui" hidden></div><p class="desc"></p><div class="episodes"></div></div></div>';
    window.scrollTo(0, 0);
    var detail = $(app, '.detail'), stage = $(app, '.stage'), actions = $(app, '.actions'), now = $(app, '.now');
    $(app, '.back').onclick = function () { go('#/'); };
    if (item.backdrop || item.poster) stage.style.backgroundImage = 'url("' + (item.backdrop || item.poster) + '")';
    stage.setAttribute('aria-label', item.name);
    $(app, 'h1').textContent = item.name;
    $(app, '.meta').textContent = [item.year, item.rating ? '★ ' + item.rating.toFixed(1) : '', item.genres.slice(0, 3).join(', ')]
      .filter(Boolean).join('  ·  ');
    $(app, '.desc').textContent = item.desc;

    function start(media, at) {
      remember(item.kind, item.id);
      actions.hidden = true;
      detail.classList.add('playing');
      stage.removeAttribute('role');
      stage.removeAttribute('aria-label');
      if (player && player.swap && media.kind === 'episode') { player.swap(media, at); }
      else {
        if (player) player.destroy();
        player = createPlayer(stage, $(app, '.player-ui'), media, at);
      }
      now.hidden = !media.label;
      now.textContent = media.label || '';
      window.scrollTo(0, 0);
    }
    function primary(label) {
      var b = h('button', 'btn primary');
      b.innerHTML = ICON.play;
      b.appendChild(h('span', '', label));
      return b;
    }

    if (item.kind === 'movie') {
      var at = resumeAt(posOf('movie', item.id)), media = { kind: 'movie', id: item.id, title: item.name };
      var playRow = actions.appendChild(h('div', 'playrow'));
      playRow.appendChild(primary(at ? 'Resume from ' + clock(at) : 'Play')).onclick = function () { start(media, at); };
      playRow.appendChild(downloadAction('movie', item.id, 'dlsq', true));
      if (at) actions.appendChild(h('button', 'btn', 'Start over')).onclick = function () { start(media, 0); };
      return;
    }

    // A show: seasons and episodes; an episode plays at the top of the page.
    var epsBox = $(app, '.episodes'), episodes = [], current = null, playingId = null;
    actions.appendChild(h('div', 'note', 'Loading episodes…'));
    api('/shows/' + item.id).then(function (d) {
      episodes = (d.episodes || []).map(function (ep) {
        return { id: ep.id, season: +ep.season || 1, number: +ep.number || 0, title: ep.title || ep.name || '', plot: ep.plot || ep.desc || '' };
      }).sort(function (a, b) { return a.season - b.season || a.number - b.number; });
      if (!episodes.length) { actions.innerHTML = ''; actions.appendChild(h('div', 'note', 'No episodes yet.')); return; }
      paintPlay();
      renderSeasons(nextEpisode().season);
    }).catch(function (e) {
      actions.innerHTML = '';
      actions.appendChild(h('div', 'note', 'Couldn’t load the episodes: ' + e.message));
    });

    // The big Play / Resume button for the next episode; redrawn when watched marks change.
    function paintPlay() {
      actions.innerHTML = '';
      var next = nextEpisode();
      var label = posOf('episode', next.id) && !finished(posOf('episode', next.id)) ? 'Resume' : 'Play';
      actions.appendChild(primary(label + ' S' + next.season + ' E' + next.number)).onclick = function () {
        playEpisode(episodes.indexOf(next));
      };
    }
    function nextEpisode() {
      var lastSeen = -1;
      episodes.forEach(function (ep, i) { if (posOf('episode', ep.id)) lastSeen = i; });
      if (lastSeen < 0) return episodes[0];
      return finished(posOf('episode', episodes[lastSeen].id)) && episodes[lastSeen + 1] ? episodes[lastSeen + 1] : episodes[lastSeen];
    }
    function epLabel(ep) { return 'S' + ep.season + ' · E' + ep.number + (ep.title ? ' · ' + ep.title : ''); }
    function playEpisode(i) {
      var ep = episodes[i];
      playingId = ep.id;
      start({
        kind: 'episode', id: ep.id, title: item.name, label: epLabel(ep), showId: item.id,
        next: episodes[i + 1] ? function () { playEpisode(i + 1); } : null,
        onEnded: function () {
          if (episodes[i + 1]) { toast('Next: ' + epLabel(episodes[i + 1])); playEpisode(i + 1); }
          renderSeasons(current);
        }
      }, resumeAt(posOf('episode', ep.id)));
      renderSeasons(ep.season);
    }
    function renderSeasons(season) {
      current = season;
      epsBox.innerHTML = '';
      var seasons = [];
      episodes.forEach(function (ep) { if (seasons.indexOf(ep.season) < 0) seasons.push(ep.season); });
      var head = epsBox.appendChild(h('div', 'seasonbar'));
      head.appendChild(h('h2', '', 'Season ' + season));
      if (seasons.length > 1) {
        var menu = head.appendChild(h('label', 'menu plain-menu'));
        menu.appendChild(h('span', 'pill')).innerHTML = '<span>Seasons</span>' + ICON.chevrons;
        var sel = menu.appendChild(h('select'));
        sel.setAttribute('aria-label', 'Choose a season');
        seasons.forEach(function (n) { sel.appendChild(h('option', '', 'Season ' + n)).value = n; });
        sel.value = season;
        sel.onchange = function () { renderSeasons(+sel.value); };
      }
      var list = epsBox.appendChild(h('div', 'eplist'));
      episodes.forEach(function (ep, i) {
        if (ep.season !== season) return;
        var wrap = list.appendChild(h('div', 'eprow' + (ep.id === playingId ? ' current' : '')));
        var row = wrap.appendChild(h('button', 'ep'));
        row.appendChild(h('div', 'n', ep.number));
        var txt = row.appendChild(h('div', 'txt'));
        txt.appendChild(h('div', 'et', ep.title || 'Episode ' + ep.number));
        if (ep.plot) txt.appendChild(h('div', 'plot', plain(ep.plot)));
        var state = row.appendChild(h('div', 'state'));
        function paint() {
          var p = posOf('episode', ep.id);
          state.innerHTML = '';
          if (finished(p)) { state.innerHTML = ICON.watched; state.setAttribute('role', 'img'); state.setAttribute('aria-label', 'Watched'); }
          else {
            state.removeAttribute('role'); state.removeAttribute('aria-label');
            if (fraction(p) > 0.02) state.appendChild(h('div', 'mini')).appendChild(h('i')).style.width = (fraction(p) * 100).toFixed(1) + '%';
          }
        }
        paint();
        row.onclick = function () { playEpisode(i); };
        wrap.appendChild(downloadAction('episode', ep.id, 'row-btn', true));
      });
    }
  }

  // ---------------------------------------------------------------- player

  function createPlayer(stage, ui, media, startAt) {
    stage.classList.add('playing');
    stage.style.backgroundImage = '';
    stage.innerHTML = '<video playsinline controls preload="auto"></video>' +
      '<div class="skip-flash left" aria-hidden="true"></div><div class="skip-flash right" aria-hidden="true"></div>';
    ui.hidden = false;
    ui.innerHTML = '<div class="controls">' +
      '<label class="menu"><span class="pill"><span class="subs-label"></span>' + ICON.chevrons + '</span><select class="subs" aria-label="Subtitles"></select></label>' +
      '<label class="menu"><span class="pill"><span class="quality-label"></span>' + ICON.chevrons + '</span><select class="quality" aria-label="Quality"></select></label>' +
      '</div><p class="note" role="status"></p>';
    var video = $(stage, 'video'), subsSel = $(ui, '.subs'), qualSel = $(ui, '.quality'), note = $(ui, '.note');
    var subsLabel = $(ui, '.subs-label'), qualLabel = $(ui, '.quality-label');
    function selText(sel) { var o = sel.options[sel.selectedIndex]; return o ? o.textContent : ''; }
    // The visible buttons show the choice; the invisible select on top of each opens iOS's own menu.
    function labels() {
      subsLabel.textContent = 'Subtitles: ' + selText(subsSel);
      qualLabel.textContent = 'Quality: ' + selText(qualSel);
    }
    if (media.kind === 'movie') $(ui, '.controls').appendChild(downloadAction('movie', media.id, 'dlsq', true));
    var master = '', mp4 = '', variants = [], quality = 0, resume = startAt || 0, currentUrl = '', closed = false;
    var subs = [], saveTimer, flashTimer;

    function save() { if (video.currentTime > 0) savePos(media.kind, media.id, video.currentTime, video.duration); }

    // −10 / +10: quick taps add up into one seek (www/seek.js), shown on that side of the picture.
    var seeker = SeekController(SeekController.videoAdapter(video), { step: STEP });
    seeker.onChange(function (snap) {
      var left = $(stage, '.skip-flash.left'), right = $(stage, '.skip-flash.right');
      clearTimeout(flashTimer);
      if (snap.target == null) { flashTimer = setTimeout(function () { left.classList.remove('on'); right.classList.remove('on'); }, 700); return; }
      var side = snap.direction < 0 ? left : right, other = side === left ? right : left;
      side.textContent = (snap.delta < 0 ? '« −' : '+') + Math.abs(Math.round(snap.delta)) + 's' + (snap.delta < 0 ? '' : ' »');
      other.classList.remove('on');
      side.classList.add('on');
    });

    // The lock screen and Control Center show the title, with ±10 s and next-episode buttons.
    function mediaSession() {
      if (!('mediaSession' in navigator)) return;
      var ms = navigator.mediaSession, art = (byId.movie[media.id] || byId.show[media.showId] || {}).poster;
      try {
        ms.metadata = new MediaMetadata({ title: media.label || media.title, artist: media.label ? media.title : 'Ororo', artwork: art ? [{ src: art }] : [] });
        ms.setActionHandler('seekbackward', function () { seeker.press(-1); seeker.release(-1); });
        ms.setActionHandler('seekforward', function () { seeker.press(1); seeker.release(1); });
        ms.setActionHandler('nexttrack', media.next || null);
      } catch (e) { /* older iOS: some actions aren't supported */ }
    }
    video.addEventListener('play', mediaSession);

    // Subtitles: fetched, turned into WebVTT and added as <track>s, so the iPhone's full-screen player shows them too.
    function toVtt(text) {
      text = text.replace(/^\uFEFF/, '').replace(/\r/g, '');
      if (/^WEBVTT/.test(text)) return text;
      return 'WEBVTT\n\n' + text.replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2');
    }
    function subText(url) {
      function get(opts) {
        return fetch(url, opts).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
      }
      return get({}).catch(function () { return get({ headers: { Authorization: basicAuth() } }); });
    }
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
    function showSub(i) {
      Array.prototype.forEach.call(video.textTracks, function (t) { t.mode = 'disabled'; });
      var sub = subs[i];
      if (sub && sub.track) sub.track.track.mode = 'showing';
    }
    function pickSub(i, quiet) {
      if (!quiet) store('sublang', i < 0 ? 'off' : subs[i].lang);
      subsSel.value = i;
      labels();
      if (i < 0) { showSub(-1); return; }
      var sub = subs[i];
      if (sub.track) { showSub(i); return; }
      sub.loading = sub.loading || subText(sub.url).then(function (text) {
        var tr = h('track');
        tr.kind = 'subtitles';
        tr.label = langName(sub.lang);
        tr.srclang = sub.lang;
        tr.src = URL.createObjectURL(new Blob([toVtt(text)], { type: 'text/vtt' }));
        video.appendChild(tr);
        sub.track = tr;
      });
      sub.loading.then(function () { if (+subsSel.value === i) showSub(i); }, function (e) {
        note.textContent = 'The ' + langName(sub.lang) + ' subtitles didn’t load (' + e.message + ').';
      });
    }
    subsSel.onchange = function () { pickSub(+subsSel.value); };
    labels();

    // Quality: Auto (the iPhone adapts) or one resolution of the HLS stream. The MP4 stays as a silent fallback if the stream fails.
    function qualityOptions() {
      var opts = [{ label: 'Auto', url: master || mp4 }];
      variants.forEach(function (v) { opts.push({ label: v.label, url: v.url, height: v.height }); });
      return opts;
    }
    function loadVariants() {
      if (!master) return Promise.resolve([]);
      return fetch(master).then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); }).then(function (text) {
        var lines = text.split(/\r?\n/), byLabel = {};
        lines.forEach(function (line, i) {
          if (line.indexOf('#EXT-X-STREAM-INF') !== 0) return;
          var res = /RESOLUTION=(\d+)x(\d+)/.exec(line), bw = /BANDWIDTH=(\d+)/.exec(line), uri = '';
          for (var j = i + 1; j < lines.length && !uri; j++) if (lines[j].trim() && lines[j].charAt(0) !== '#') uri = lines[j].trim();
          if (!uri) return;
          var v = { height: res ? +res[2] : 0, bw: bw ? +bw[1] : 0, url: new URL(uri, master).href };
          v.label = v.height ? v.height + 'p' : Math.round(v.bw / 1000) + ' kbps';
          if (!byLabel[v.label] || byLabel[v.label].bw < v.bw) byLabel[v.label] = v;
        });
        return Object.keys(byLabel).map(function (k) { return byLabel[k]; }).sort(function (a, b) { return b.height - a.height; });
      }).catch(function () { return []; });
    }
    function preferredQuality() {
      var pref = load('quality', 'Auto'), opts = qualityOptions(), want = parseInt(pref, 10), best = 0;
      opts.forEach(function (o, i) { if (o.label === pref) best = i; });
      if (!best && want) opts.forEach(function (o, i) { if (o.height && o.height <= want && (!best || o.height > opts[best].height)) best = i; });
      return best;
    }
    function fillQuality() {
      qualSel.innerHTML = '';
      qualityOptions().forEach(function (o, i) {
        var opt = qualSel.appendChild(h('option', '', o.label));
        opt.value = i;
      });
      qualSel.value = quality;
      labels();
    }
    qualSel.onchange = function () {
      quality = +qualSel.value;
      labels();
      store('quality', qualityOptions()[quality].label);
      playUrl(qualityOptions()[quality].url, video.currentTime, !video.paused);
    };
    function playUrl(url, at, autoplay) {
      currentUrl = url;
      resume = at || 0;
      video.src = url;
      video.load();
      if (autoplay !== false) {
        var p = video.play();
        if (p && p.catch) p.catch(function () { /* iPhone wants a tap: its play button is showing */ });
      }
    }

    video.addEventListener('loadedmetadata', function () {
      if (resume) { video.currentTime = resume; resume = 0; }
      if (+subsSel.value >= 0) showSub(+subsSel.value);
    });
    video.addEventListener('pause', save);
    video.addEventListener('error', function () {
      if (closed || !currentUrl) return;
      var at = video.currentTime || resume;
      if (quality !== 0) { toast('That quality didn’t play. Back to Auto.'); quality = 0; qualSel.value = 0; labels(); playUrl(qualityOptions()[0].url, at); }
      else if (mp4 && currentUrl !== mp4) playUrl(mp4, at);
      else note.textContent = 'This video won’t play here.';
    });
    video.addEventListener('ended', function () {
      savePos(media.kind, media.id, video.duration, video.duration);
      if (media.onEnded) media.onEnded();
    });
    window.addEventListener('pagehide', save);
    saveTimer = setInterval(save, 10000);

    // Loads the video for `media`. Playing the next episode reuses this <video>, so the iPhone keeps full screen
    // and lets it start without a tap (a brand-new element would be blocked from autoplaying).
    var loadId = 0;
    function loadMedia(startAt) {
    var id = ++loadId;
    note.textContent = 'Loading…';
    api((media.kind === 'movie' ? '/movies/' : '/episodes/') + media.id).then(function (d) {
      if (closed || id !== loadId) return;
      master = d.url ? abs(String(d.url).replace('playlist_fmp4.m3u8', 'playlist.m3u8')) : '';
      mp4 = abs(d.download_url);
      if (!master && !mp4) throw new Error('Ororo didn’t give a video for this one.');
      subs = subtitleList(d.subtitles || d.subs || d.subtitle_files);
      subsSel.innerHTML = '';
      subsSel.appendChild(h('option', '', subs.length ? 'Off' : 'None available')).value = -1;
      subs.forEach(function (sub, i) {
        var o = subsSel.appendChild(h('option', '', langName(sub.lang)));
        o.value = i;
      });
      var pref = load('sublang', 'en'), langs = subs.map(function (x) { return x.lang; });
      var first = pref === 'off' ? -1 : langs.indexOf(pref) >= 0 ? langs.indexOf(pref) : langs.indexOf('en');
      if (first >= 0) pickSub(first, true); else { subsSel.value = -1; labels(); }
      if (load('quality', 'Auto') === 'Auto' || !master) {
        // Auto plays the master playlist as it is, so don't wait to read its list of resolutions.
        quality = 0;
        fillQuality();
        note.textContent = '';
        playUrl(qualityOptions()[0].url, startAt);
        loadVariants().then(function (list) {
          if (closed || id !== loadId) return;
          variants = list;
          fillQuality();
        });
        return;
      }
      return loadVariants().then(function (list) {
        if (closed || id !== loadId) return;
        variants = list;
        quality = preferredQuality();
        fillQuality();
        note.textContent = '';
        playUrl(qualityOptions()[quality].url, startAt);
      });
    }).catch(function (e) {
      note.textContent = e.message;
      if (e.status === 401) { forget('creds'); cacheClear(); loaded = false; route(); }
    });
    }
    loadMedia(startAt);

    return {
      swap: function (next, at) {
        subs.forEach(function (sub) { if (sub.track) { URL.revokeObjectURL(sub.track.src); video.removeChild(sub.track); } });
        subs = []; variants = []; master = mp4 = currentUrl = '';
        media = next;
        loadMedia(at);
      },
      destroy: function () {
        closed = true;
        save();
        seeker.cancel();
        clearInterval(saveTimer);
        window.removeEventListener('pagehide', save);
        video.pause();
        video.removeAttribute('src');
        video.load();
        subs.forEach(function (sub) { if (sub.track) URL.revokeObjectURL(sub.track.src); });
      }
    };
  }

  // The app's own files are kept on the phone (sw.js), so it opens at once and even with no signal. Pull request
  // previews don't use it: they live under /pr-preview/ and must always show the branch they were built from.
  if ('serviceWorker' in navigator && /^https:|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(location.href) && location.pathname.indexOf('/pr-preview/') < 0) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* the app works without it */ });
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'updated') toast('A new version is ready. Close and reopen the app to get it.');
    });
  }

  route();
})();
