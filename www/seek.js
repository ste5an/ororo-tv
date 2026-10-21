/*
 * Netflix-style seeking for a TV remote, with no UI and no <video> in it, so it can be tested on its own.
 *
 *   idle ──press──▶ accumulating ──(more presses add ±STEP, debounce restarts)──┐
 *     ▲                 │ key still down after HOLD_DELAY                        │ debounce ends
 *     │                 ▼                                                        ▼
 *     │             scrubbing ──(every TICK: ±10 s, then ±30 s, then ±60 s)──▶ committing ──seek done──▶ idle
 *     │                 │ key released (or its repeats stop coming)              ▲      │
 *     │                 └────────────────────────────────────────────────────────┘      │ input arrived meanwhile
 *     └──────────────────────────────────────────────────────────────────────────────────┘ → commits that next
 *
 * The player is reached only through the adapter passed in: position(), range(), seek(t) → Promise.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    step: 10,                // seconds per single press
    debounceMs: 450,         // quiet time after the last press before the one real seek
    holdDelayMs: 500,        // a key held this long starts scrubbing
    tickMs: 250,             // scrub speed: one step per tick
    accel: [                 // the longer the key is held, the bigger the step
      { afterMs: 0, step: 10 },
      { afterMs: 2000, step: 30 },
      { afterMs: 4500, step: 60 }
    ],
    releaseTimeoutMs: 700,   // no repeat this long while "held" means the key-up was lost: treat it as released
    endGuard: 2,             // never land closer than this to the end (it would just end the video)
    now: function () { return Date.now(); },
    setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
    clearTimeout: function (id) { clearTimeout(id); }
  };

  function SeekController(adapter, options) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in options || {}) o[k] = options[k];

    var state = 'idle';        // idle | accumulating | scrubbing | committing
    var target = null;         // where we'll land, seconds
    var origin = null;         // where the run of presses started, for the "+30" label
    var held = 0;              // direction of the key that's down: -1, 1 or 0
    var downAt = 0, lastRepeatAt = 0, scrubStart = 0;
    var debounceId = null, tickId = null, holdId = null;
    var again = false;         // input arrived while a seek was running: commit again when it's done
    var listeners = [];

    function emit() {
      var snap = snapshot();
      listeners.forEach(function (fn) { fn(snap); });
    }
    function snapshot() {
      return {
        state: state,
        target: target,
        delta: target == null || origin == null ? 0 : target - origin,
        direction: held,
        scrubStep: state === 'scrubbing' ? stepFor(o.now() - scrubStart) : o.step
      };
    }

    function clamp(t) {
      var r = adapter.range();
      if (!r || !isFinite(r.end)) return Math.max(0, t);
      var hi = Math.max(r.start, r.end - o.endGuard);
      return Math.min(hi, Math.max(r.start, t));
    }
    function stepFor(heldMs) {
      var step = o.accel[0].step;
      o.accel.forEach(function (a) { if (heldMs >= a.afterMs) step = a.step; });
      return step;
    }
    function base() {
      if (target != null) return target;
      origin = adapter.position();
      return origin;
    }
    function move(by) {
      target = clamp(base() + by);
    }

    function stopTimers() {
      if (debounceId != null) { o.clearTimeout(debounceId); debounceId = null; }
      if (tickId != null) { o.clearTimeout(tickId); tickId = null; }
      if (holdId != null) { o.clearTimeout(holdId); holdId = null; }
    }
    // Still down after HOLD_DELAY: scrub. Timed here rather than by the key repeats, which differ between TVs.
    function armHold() {
      if (holdId != null) o.clearTimeout(holdId);
      var wait = Math.max(0, o.holdDelayMs - (o.now() - downAt));
      holdId = o.setTimeout(function () {
        holdId = null;
        if (!held || state !== 'accumulating') return;
        state = 'scrubbing';
        scrubStart = o.now();
        tick();
      }, wait);
    }
    function armDebounce() {
      if (debounceId != null) o.clearTimeout(debounceId);
      debounceId = o.setTimeout(function () { debounceId = null; commit(); }, o.debounceMs);
    }
    function tick() {
      tickId = null;
      if (state !== 'scrubbing') return;
      if (o.now() - lastRepeatAt > o.releaseTimeoutMs) { release(held); return; }
      move(held * stepFor(o.now() - scrubStart));
      emit();
      tickId = o.setTimeout(tick, o.tickMs);
    }

    // Key down. Call it for the first press and for every auto-repeat while the key is held.
    function press(dir) {
      dir = dir < 0 ? -1 : 1;
      var t = o.now();
      if (held === dir) { lastRepeatAt = t; return; }   // an auto-repeat of the key that's down
      // A new press (or the other direction while one was held). Nothing commits while a key is down.
      stopTimers();
      held = dir;
      downAt = lastRepeatAt = t;
      move(dir * o.step);
      if (state === 'committing') again = true;
      else state = 'accumulating';
      armHold();
      emit();
    }

    // Key up. A scrub lands right away; presses wait for the debounce, so quick ones add up.
    function release(dir) {
      if (dir != null && held !== (dir < 0 ? -1 : 1)) return;
      held = 0;
      if (holdId != null) { o.clearTimeout(holdId); holdId = null; }
      if (state === 'scrubbing') {
        stopTimers();
        commit();
      } else if (state === 'accumulating') {
        armDebounce();
      }
    }

    function commit() {
      if (target == null) { state = 'idle'; emit(); return; }
      if (state === 'committing') { again = true; return; }
      state = 'committing';
      var to = target;
      emit();
      Promise.resolve(adapter.seek(to)).catch(function () {}).then(function () {
        if (state !== 'committing') return;      // cancelled meanwhile
        if (again || target !== to) {
          // More input came in during the seek: go on from there.
          again = false;
          state = 'accumulating';
          if (held) { armHold(); emit(); return; }   // the key is still down: its release (or a hold) decides
          commit();
          return;
        }
        state = 'idle';
        target = origin = null;
        emit();
      });
    }

    // Drop everything (leaving the player, a new video).
    function cancel() {
      stopTimers();
      state = 'idle';
      target = origin = null;
      held = 0;
      again = false;
      emit();
    }

    return {
      press: press,
      release: release,
      cancel: cancel,
      onChange: function (fn) { listeners.push(fn); },
      snapshot: snapshot,
      busy: function () { return state !== 'idle'; }
    };
  }

  // The adapter for an HTML5 <video>: keeps play/pause as it was and waits for the seek to finish.
  SeekController.videoAdapter = function (video, onSeekStart) {
    return {
      position: function () { return video.currentTime; },
      range: function () {
        var s = video.seekable;
        if (s && s.length) return { start: s.start(0), end: s.end(s.length - 1) };   // also a live stream's DVR window
        return { start: 0, end: video.duration };
      },
      seek: function (t) {
        return new Promise(function (resolve) {
          var wasPaused = video.paused, done = false;
          function finish() {
            if (done) return;
            done = true;
            video.removeEventListener('seeked', finish);
            if (!wasPaused && video.paused) {
              var p = video.play();
              if (p && p.catch) p.catch(function () {});
            }
            resolve();
          }
          video.addEventListener('seeked', finish);
          setTimeout(finish, 8000);                // some TVs never fire 'seeked' on a stalled stream
          if (onSeekStart) onSeekStart(t);
          video.currentTime = t;
        });
      }
    };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SeekController;
  else root.SeekController = SeekController;
})(this);
