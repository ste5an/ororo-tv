// Tests for www/core.js (the code the TV and iPhone apps share): node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../www/core.js');

test('clock: m:ss under an hour, h:mm:ss over', () => {
  assert.equal(C.clock(0), '0:00');
  assert.equal(C.clock(65), '1:05');
  assert.equal(C.clock(3725), '1:02:05');
  assert.equal(C.clock(-5), '0:00');
});

test('finished, resumeAt and fraction', () => {
  assert.equal(C.finished(null), false);
  assert.equal(C.finished({ t: 100, d: 3000 }), false);
  assert.equal(C.finished({ t: 2910, d: 3000 }), true);  // within the last 90 s
  assert.equal(C.finished({ t: 96, d: 100 }), true);     // past 95 % of a short video
  assert.equal(C.resumeAt({ t: 20, d: 3000 }), 0);       // too early to bother resuming
  assert.equal(C.resumeAt({ t: 600, d: 3000 }), 600);
  assert.equal(C.resumeAt({ t: 2950, d: 3000 }), 0);     // finished: start over
  assert.equal(C.fraction({ t: 750, d: 3000 }), 0.25);
  assert.equal(C.fraction({ t: 10, d: 0 }), 0);
});

test('langName knows the usual languages and upper-cases the rest', () => {
  assert.equal(C.langName('ru'), 'Русский');
  assert.equal(C.langName('xx'), 'XX');
  assert.equal(C.langName(''), '?');
});

test('plain strips tags and squeezes spaces', () => {
  assert.equal(C.plain('<p>Hello&nbsp;<b>world</b></p>\n '), 'Hello world');
});

test('only Ororo hosts get the login', () => {
  assert.equal(C.isOroroHost('https://front.ororo.tv/uploads/x.srt'), true);
  assert.equal(C.isOroroHost('https://FRONT.ororo-mirror.tv/x'), true);
  assert.equal(C.isOroroHost('http://front.ororo.tv/x'), false);
  assert.equal(C.isOroroHost('https://front.ororo.tv.evil.com/x'), false);
  assert.equal(C.isOroroHost('https://cdn.example.com/x'), false);
});

test('cssUrl escapes what would break out of url("…")', () => {
  assert.equal(C.cssUrl('https://a/b.jpg'), 'url("https://a/b.jpg")');
  assert.equal(C.cssUrl('https://a/"),x'), 'url("https://a/%22),x")');
});

test('abs and slim; httpsOnly upgrades http:// URLs', () => {
  assert.equal(C.abs('//img.ororo.tv/p.jpg'), 'https://img.ororo.tv/p.jpg');
  assert.equal(C.abs('/p.jpg'), 'https://front.ororo.tv/p.jpg');
  assert.equal(C.abs('http://img/p.jpg'), 'http://img/p.jpg');
  const it = C.slim('movie', { id: 7, title: 'T', poster: '/p.jpg', imdb_rating: '7.5', desc: '<i>x</i>', user_popularity: '3' });
  assert.deepEqual([it.kind, it.id, it.name, it.poster, it.rating, it.desc, it.pop], ['movie', 7, 'T', 'https://front.ororo.tv/p.jpg', 7.5, 'x', 3]);
  C.configure({ httpsOnly: true });
  assert.equal(C.abs('http://img/p.jpg'), 'https://img/p.jpg');
  C.configure({ httpsOnly: false });
});

test('setCatalog fills the shared objects in place', () => {
  const catalog = C.catalog, byId = C.byId;
  C.setCatalog({ movie: [{ kind: 'movie', id: 1 }], show: [{ kind: 'show', id: 2 }] });
  assert.equal(C.catalog, catalog);
  assert.equal(byId.movie[1].id, 1);
  assert.equal(byId.show[2].id, 2);
});
