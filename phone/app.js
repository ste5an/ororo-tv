/*
 * Ororo TV for iPhone: a web app (Safari → Share → Add to Home Screen) for ororo.tv's movies and shows.
 * Same Ororo API and storage keys as the TV app (www/app.js), laid out for touch. Playback uses the iPhone's own
 * video controls (full screen, AirPlay, picture-in-picture); subtitles become <track>s so they show there too.
 */
(function () {
  'use strict';

  var API_HOSTS = ['https://front.ororo.tv', 'https://front.ororo-mirror.tv', 'https://ororo.tv'];
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

  var activeHost = null;
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
      var ctrl = new AbortController(), timer = setTimeout(function () { ctrl.abort(); }, 40000);
      return fetch(hosts[i] + '/api/v2' + path, { headers: headers, signal: ctrl.signal }).then(function (res) {
        clearTimeout(timer);
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
  function loadCatalog() {
    return Promise.all([api('/movies'), api('/shows')]).then(function (res) {
      catalog.movie = (res[0].movies || []).map(function (r) { return slim('movie', r); });
      catalog.show = (res[1].shows || []).map(function (r) { return slim('show', r); });
      ['movie', 'show'].forEach(function (k) {
        byId[k] = {};
        catalog[k].forEach(function (it) { byId[k][it.id] = it; });
      });
      loaded = true;
    });
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

  // ---------------------------------------------------------------- routing: #/  #/movie/ID  #/show/ID

  var app = document.getElementById('app');
  var player = null, homeState = { tab: null, sort: load('sort', 0), query: '', rendered: CHUNK, scroll: 0 };

  function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

  function route() {
    if (player) { player.destroy(); player = null; }
    if (!creds()) return renderLogin();
    if (!loaded) return boot();
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    var item = parts[0] === 'movie' || parts[0] === 'show' ? byId[parts[0]][parts[1]] : null;
    if (item) renderDetail(item);
    else renderHome();
  }
  window.addEventListener('hashchange', route);

  function boot() {
    app.innerHTML = '<div class="loading"><div class="spinner"></div><div>Loading Ororo…</div></div>';
    loadCatalog().then(route, function (e) {
      if (e.status === 401) { forget('creds'); renderLogin(e.message); return; }
      app.innerHTML = '';
      var box = app.appendChild(h('div', 'loading'));
      box.appendChild(h('div', '', e.message || 'Couldn’t load Ororo.'));
      box.appendChild(h('button', 'btn primary', 'Try again')).onclick = boot;
    });
  }

  // ---------------------------------------------------------------- login

  function renderLogin(message) {
    app.innerHTML =
      '<form class="login"><div class="brand">ororo<span>tv</span></div>' +
      '<p>Sign in with your ororo.tv email and password. They stay on this phone.</p>' +
      '<label>Email</label><input type="email" autocomplete="username" autocapitalize="off" spellcheck="false" required>' +
      '<label>Password</label><input type="password" autocomplete="current-password" required>' +
      '<button class="btn" type="submit">Sign in</button><p class="err"></p></form>';
    var form = $(app, 'form'), inputs = form.querySelectorAll('input');
    $(form, '.err').textContent = message || '';
    form.onsubmit = function (e) {
      e.preventDefault();
      store('creds', { user: inputs[0].value.trim(), pass: inputs[1].value });
      loaded = false;
      boot();
    };
  }

  // ---------------------------------------------------------------- home

  var SORTS = [['pop', 'Popular'], ['fresh', 'New'], ['rating', 'Top rated'], ['name', 'A–Z']];
  var sortCache = {};

  function sorted(kind) {
    var key = SORTS[homeState.sort][0], id = kind + ':' + key;
    if (!sortCache[id]) {
      sortCache[id] = catalog[kind].slice().sort(key === 'name'
        ? function (a, b) { return a.name.localeCompare(b.name); }
        : function (a, b) { return b[key] - a[key] || b.pop - a.pop; });
    }
    return sortCache[id];
  }
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
    if (!homeState.tab) homeState.tab = continueItems().length ? 'continue' : 'movie';
    app.innerHTML =
      '<div class="top"><div class="top-row"><div class="brand">ororo<span>tv</span></div><button class="link">Sign out</button></div>' +
      '<div class="tabs"></div><div class="tools"></div></div><div class="grid"></div><p class="empty" hidden></p><div class="sentinel"></div>';
    var tabsEl = $(app, '.tabs'), tools = $(app, '.tools'), grid = $(app, '.grid'), empty = $(app, '.empty');
    var items = [], rendered = 0;

    $(app, '.link').onclick = function () { forget('creds'); loaded = false; route(); };
    [['continue', 'Continue'], ['movie', 'Movies'], ['show', 'Shows'], ['search', 'Search']].forEach(function (t) {
      if (t[0] === 'continue' && !continueItems().length) return;
      var b = tabsEl.appendChild(h('button', 'tab' + (homeState.tab === t[0] ? ' on' : ''), t[1]));
      b.onclick = function () {
        homeState.tab = t[0];
        homeState.rendered = CHUNK;
        homeState.scroll = 0;
        renderHome();
      };
    });

    if (homeState.tab === 'search') {
      var input = tools.appendChild(h('input'));
      input.type = 'search';
      input.placeholder = 'Search movies and shows';
      input.value = homeState.query;
      input.oninput = function () {
        homeState.query = input.value;
        clearTimeout(input._t);
        input._t = setTimeout(function () { fill(searchResults(input.value), 'Nothing found.'); }, 250);
      };
      if (!homeState.query) setTimeout(function () { input.focus(); }, 50);
    } else if (homeState.tab !== 'continue') {
      var sel = tools.appendChild(h('select'));
      SORTS.forEach(function (s, i) {
        var o = sel.appendChild(h('option', '', 'Sort: ' + s[1]));
        o.value = i;
      });
      sel.value = homeState.sort;
      sel.onchange = function () {
        homeState.sort = +sel.value;
        store('sort', homeState.sort);
        homeState.rendered = CHUNK;
        renderHome();
      };
    } else {
      tools.hidden = true;
    }

    function card(item) {
      var a = h('a', 'card');
      a.href = '#/' + item.kind + '/' + item.id;
      var poster = a.appendChild(h('div', 'poster'));
      if (item.poster) {
        var img = poster.appendChild(h('img'));
        img.loading = 'lazy';
        img.alt = '';
        img.src = item.poster;
      } else poster.appendChild(h('div', 'ph', item.name));
      var p = item.kind === 'movie' ? posOf('movie', item.id) : null;
      if (p && !finished(p) && fraction(p) > 0.02) poster.appendChild(h('div', 'bar')).appendChild(h('i')).style.width = (fraction(p) * 100).toFixed(1) + '%';
      a.appendChild(h('div', 'title', item.name + (item.year ? ' (' + item.year + ')' : '')));
      a.onclick = function () { homeState.scroll = window.scrollY; homeState.rendered = rendered; };
      return a;
    }
    function more(upTo) {
      var frag = document.createDocumentFragment(), end = Math.min(items.length, upTo || rendered + CHUNK);
      for (; rendered < end; rendered++) frag.appendChild(card(items[rendered]));
      grid.appendChild(frag);
    }
    function fill(list, emptyText, upTo) {
      items = list;
      rendered = 0;
      grid.innerHTML = '';
      more(upTo || CHUNK);
      empty.hidden = list.length > 0;
      empty.textContent = emptyText;
    }

    if (homeState.tab === 'continue') fill(continueItems(), 'Nothing here yet.', homeState.rendered);
    else if (homeState.tab === 'search') fill(searchResults(homeState.query), homeState.query ? 'Nothing found.' : 'Type a title.');
    else fill(sorted(homeState.tab), 'Ororo returned an empty list.', homeState.rendered);

    new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && rendered < items.length) more();
    }, { rootMargin: '1200px 0px' }).observe($(app, '.sentinel'));
    window.scrollTo(0, homeState.scroll);
  }

  // ---------------------------------------------------------------- movie and show pages

  function renderDetail(item) {
    app.innerHTML =
      '<div class="detail"><div class="navbar"><button class="back">‹ Back</button></div>' +
      '<div class="stage"></div><div class="body"><h1></h1><div class="meta"></div><p class="now" hidden></p>' +
      '<div class="actions"></div><div class="player-ui" hidden></div><p class="desc"></p><div class="episodes"></div></div></div>';
    window.scrollTo(0, 0);
    var stage = $(app, '.stage'), actions = $(app, '.actions'), now = $(app, '.now');
    $(app, '.back').onclick = function () { go('#/'); };
    if (item.backdrop || item.poster) stage.style.backgroundImage = 'url("' + (item.backdrop || item.poster) + '")';
    $(app, 'h1').textContent = item.name;
    $(app, '.meta').textContent = [item.year, item.rating ? '★ ' + item.rating.toFixed(1) : '', item.genres.slice(0, 3).join(', ')]
      .filter(Boolean).join('  ·  ');
    $(app, '.desc').textContent = item.desc;

    function start(media, at) {
      remember(item.kind, item.id);
      actions.hidden = true;
      if (player) player.destroy();
      player = createPlayer(stage, $(app, '.player-ui'), media, at);
      now.hidden = !media.label;
      now.textContent = media.label || '';
      window.scrollTo(0, 0);
    }

    if (item.kind === 'movie') {
      var at = resumeAt(posOf('movie', item.id)), media = { kind: 'movie', id: item.id, title: item.name };
      var play = actions.appendChild(h('button', 'btn primary', at ? '▶  Resume from ' + clock(at) : '▶  Play'));
      play.onclick = function () { start(media, at); };
      if (at) actions.appendChild(h('button', 'btn', 'From the start')).onclick = function () { start(media, 0); };
      return;
    }

    // A show: seasons and episodes; an episode plays at the top of the page.
    var epsBox = $(app, '.episodes'), episodes = [], current = null, playingId = null;
    actions.appendChild(h('div', 'note', 'Loading episodes…'));
    api('/shows/' + item.id).then(function (d) {
      episodes = (d.episodes || []).map(function (ep) {
        return { id: ep.id, season: +ep.season || 1, number: +ep.number || 0, title: ep.title || ep.name || '', plot: ep.plot || ep.desc || '' };
      }).sort(function (a, b) { return a.season - b.season || a.number - b.number; });
      actions.innerHTML = '';
      if (!episodes.length) { actions.appendChild(h('div', 'note', 'No episodes yet.')); return; }
      var next = nextEpisode();
      var label = posOf('episode', next.id) && !finished(posOf('episode', next.id)) ? 'Resume' : 'Play';
      actions.appendChild(h('button', 'btn primary', '▶  ' + label + ' S' + next.season + ' E' + next.number)).onclick = function () {
        playEpisode(episodes.indexOf(next));
      };
      renderSeasons(next.season);
    }).catch(function (e) {
      actions.innerHTML = '';
      actions.appendChild(h('div', 'note', 'Couldn’t load the episodes: ' + e.message));
    });

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
      var chips = epsBox.appendChild(h('div', 'seasons'));
      seasons.forEach(function (n) {
        chips.appendChild(h('button', 'tab' + (n === season ? ' on' : ''), 'Season ' + n)).onclick = function () { renderSeasons(n); };
      });
      episodes.forEach(function (ep, i) {
        if (ep.season !== season) return;
        var row = epsBox.appendChild(h('button', 'ep' + (ep.id === playingId ? ' current' : '')));
        row.appendChild(h('div', 'n', ep.number));
        var txt = row.appendChild(h('div', 'txt'));
        txt.appendChild(h('div', 'et', ep.title || 'Episode ' + ep.number));
        if (ep.plot) txt.appendChild(h('div', 'plot', plain(ep.plot)));
        var state = row.appendChild(h('div', 'state')), p = posOf('episode', ep.id);
        if (finished(p)) state.textContent = '✓';
        else if (fraction(p) > 0.02) state.appendChild(h('div', 'mini')).appendChild(h('i')).style.width = (fraction(p) * 100).toFixed(1) + '%';
        row.onclick = function () { playEpisode(i); };
      });
    }
  }

  // ---------------------------------------------------------------- player

  function createPlayer(stage, ui, media, startAt) {
    stage.classList.add('playing');
    stage.style.backgroundImage = '';
    stage.innerHTML = '<video playsinline controls preload="auto"></video>' +
      '<div class="skip-flash left"></div><div class="skip-flash right"></div>';
    ui.hidden = false;
    ui.innerHTML = '<div class="controls"><button data-skip="-1">« 10s</button><button data-skip="1">10s »</button>' +
      '<select class="subs"></select><select class="quality"></select></div><p class="note"></p>';
    var video = $(stage, 'video'), subsSel = $(ui, '.subs'), qualSel = $(ui, '.quality'), note = $(ui, '.note');
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
    Array.prototype.forEach.call(ui.querySelectorAll('[data-skip]'), function (b) {
      b.onclick = function () { var d = +b.dataset.skip; seeker.press(d); seeker.release(d); };
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

    // Quality: Auto (the iPhone adapts), each resolution in the HLS stream, or the MP4 file.
    function qualityOptions() {
      var opts = [{ label: 'Auto', url: master || mp4 }];
      variants.forEach(function (v) { opts.push({ label: v.label, url: v.url, height: v.height }); });
      if (master && mp4) opts.push({ label: 'MP4', url: mp4 });
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
        var opt = qualSel.appendChild(h('option', '', 'Quality: ' + o.label));
        opt.value = i;
      });
      qualSel.value = quality;
    }
    qualSel.onchange = function () {
      quality = +qualSel.value;
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
      if (quality !== 0) { toast('That quality didn’t play. Back to Auto.'); quality = 0; qualSel.value = 0; playUrl(qualityOptions()[0].url, at); }
      else if (mp4 && currentUrl !== mp4) playUrl(mp4, at);
      else note.textContent = 'This video won’t play here.';
    });
    video.addEventListener('ended', function () {
      savePos(media.kind, media.id, video.duration, video.duration);
      if (media.onEnded) media.onEnded();
    });
    window.addEventListener('pagehide', save);
    saveTimer = setInterval(save, 10000);

    note.textContent = 'Loading…';
    api((media.kind === 'movie' ? '/movies/' : '/episodes/') + media.id).then(function (d) {
      if (closed) return;
      master = d.url ? abs(String(d.url).replace('playlist_fmp4.m3u8', 'playlist.m3u8')) : '';
      mp4 = abs(d.download_url);
      if (!master && !mp4) throw new Error('Ororo didn’t give a video for this one.');
      subs = subtitleList(d.subtitles || d.subs || d.subtitle_files);
      subsSel.innerHTML = '';
      subsSel.appendChild(h('option', '', subs.length ? 'Subtitles: Off' : 'No subtitles')).value = -1;
      subs.forEach(function (sub, i) {
        var o = subsSel.appendChild(h('option', '', 'CC: ' + langName(sub.lang)));
        o.value = i;
      });
      var pref = load('sublang', 'en'), langs = subs.map(function (x) { return x.lang; });
      var first = pref === 'off' ? -1 : langs.indexOf(pref) >= 0 ? langs.indexOf(pref) : langs.indexOf('en');
      if (first >= 0) pickSub(first, true); else subsSel.value = -1;
      return loadVariants().then(function (list) {
        if (closed) return;
        variants = list;
        quality = preferredQuality();
        fillQuality();
        note.textContent = '';
        playUrl(qualityOptions()[quality].url, startAt);
      });
    }).catch(function (e) {
      note.textContent = e.message;
      if (e.status === 401) { forget('creds'); loaded = false; route(); }
    });

    return {
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

  route();
})();
