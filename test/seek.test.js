// Tests for www/seek.js: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const SeekController = require('../www/seek.js');

// A fake clock and a fake player, so every timing is exact.
function setup(opts = {}) {
  let now = 0, nextId = 1;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
      await flush();
    }
    now = end;
    await flush();
  }
  const player = {
    pos: opts.pos ?? 600, duration: opts.duration ?? 3600, seeks: [], hold: false, pending: [],
    position() { return this.pos; },
    range() { return { start: 0, end: this.duration }; },
    seek(t) {
      this.seeks.push(t);
      if (this.hold) return new Promise((resolve) => this.pending.push(() => { this.pos = t; resolve(); }));
      this.pos = t;
      return Promise.resolve();
    },
  };
  const seek = SeekController(player, { ...clock, ...opts.options });
  return { seek, player, advance };
}
const flush = () => new Promise((r) => setImmediate(r));

test('one press seeks 10 s once, after the debounce', async () => {
  const { seek, player, advance } = setup();
  seek.press(1); seek.release(1);
  assert.equal(seek.snapshot().target, 610);
  assert.equal(seek.snapshot().delta, 10);
  await advance(400);
  assert.deepEqual(player.seeks, []);
  await advance(100);
  assert.deepEqual(player.seeks, [610]);
  assert.equal(seek.snapshot().state, 'idle');
});

test('quick presses add up into a single seek', async () => {
  const { seek, player, advance } = setup();
  for (let i = 0; i < 3; i++) { seek.press(-1); seek.release(-1); await advance(200); }
  assert.equal(seek.snapshot().delta, -30);
  await advance(500);
  assert.deepEqual(player.seeks, [570]);
});

test('switching direction starts a new count from where it was heading', async () => {
  const { seek, player, advance } = setup();
  seek.press(1); seek.release(1);
  seek.press(1); seek.release(1);
  assert.equal(seek.snapshot().delta, 20);
  seek.press(-1); seek.release(-1);
  assert.equal(seek.snapshot().delta, -10, 'the indicator restarts at −10');
  assert.equal(seek.snapshot().direction, -1);
  await advance(500);
  assert.deepEqual(player.seeks, [610], 'still one seek, to +20 −10');
});

test('the count resets once the seek is done', async () => {
  const { seek, advance } = setup();
  seek.press(1); seek.release(1);
  await advance(500);
  seek.press(1); seek.release(1);
  assert.equal(seek.snapshot().delta, 10);
  assert.equal(seek.snapshot().target, 620);
});

test('end of media: presses past the end stop just before it', async () => {
  const { seek, player, advance } = setup({ pos: 3570 });
  for (let i = 0; i < 5; i++) { seek.press(1); seek.release(1); }
  assert.equal(seek.snapshot().target, 3598);
  await advance(500);
  assert.deepEqual(player.seeks, [3598]);
});

test('clamps at the start and before the end', async () => {
  const a = setup({ pos: 4 });
  a.seek.press(-1); a.seek.release(-1);
  await a.advance(500);
  assert.deepEqual(a.player.seeks, [0]);

  const b = setup({ pos: 3595 });
  b.seek.press(1); b.seek.release(1);
  await b.advance(500);
  assert.deepEqual(b.player.seeks, [3598]);   // duration − endGuard (2 s), never the very end
});

test('holding the key scrubs faster and faster, and lands on release', async () => {
  const { seek, player, advance } = setup({ pos: 0, duration: 7200 });
  seek.press(1);                                       // first press: +10
  const repeat = async (ms) => { for (let t = 0; t < ms; t += 50) { seek.press(1); await advance(50); } };
  await repeat(500);                                   // held past holdDelay → scrubbing starts
  assert.equal(seek.snapshot().state, 'scrubbing');
  assert.equal(seek.snapshot().scrubStep, 10);
  await repeat(2000);
  assert.equal(seek.snapshot().scrubStep, 30);
  await repeat(2500);
  assert.equal(seek.snapshot().scrubStep, 60);
  const before = seek.snapshot().target;
  assert.ok(before > 300, 'moved a long way: ' + before);
  assert.deepEqual(player.seeks, [], 'no seeks while scrubbing');
  seek.release(1);
  await advance(0);
  assert.deepEqual(player.seeks, [before]);
  assert.equal(seek.snapshot().state, 'idle');
});

test('a lost key-up still ends the scrub', async () => {
  const { seek, player, advance } = setup({ pos: 0 });
  seek.press(1);
  for (let t = 0; t < 600; t += 50) { seek.press(1); await advance(50); }
  assert.equal(seek.snapshot().state, 'scrubbing');
  await advance(1000);                                 // repeats stopped, no key-up came
  assert.equal(player.seeks.length, 1);
  assert.equal(seek.snapshot().state, 'idle');
});

test('presses during a running seek are queued, then seeked to', async () => {
  const { seek, player, advance } = setup();
  player.hold = true;
  seek.press(1); seek.release(1);
  await advance(500);
  assert.deepEqual(player.seeks, [610]);
  assert.equal(seek.snapshot().state, 'committing');
  seek.press(1); seek.release(1);                      // arrives while the TV is still seeking
  seek.press(1); seek.release(1);
  assert.deepEqual(player.seeks, [610], 'no second seek while one is running');
  assert.equal(seek.snapshot().target, 630);
  player.pending.shift()();
  await advance(0);
  assert.deepEqual(player.seeks, [610, 630]);
  player.pending.shift()();
  await advance(0);
  assert.equal(seek.snapshot().state, 'idle');
});

test('cancel drops a pending seek', async () => {
  const { seek, player, advance } = setup();
  seek.press(1); seek.release(1);
  seek.cancel();
  await advance(1000);
  assert.deepEqual(player.seeks, []);
  assert.equal(seek.snapshot().target, null);
});

test('the step is configurable', async () => {
  const { seek, player, advance } = setup({ options: { step: 5 } });
  seek.press(1); seek.release(1);
  await advance(500);
  assert.deepEqual(player.seeks, [605]);
});
