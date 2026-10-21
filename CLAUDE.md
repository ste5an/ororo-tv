# Ororo TV for Samsung

An unofficial ororo.tv client for Samsung TVs (Tizen), as a plain web app: `www/` (index.html, style.css, app.js),
packed by `build.py` into `OroroTV.wgt`. App id `OroroTVapp.OroroTV`. The README is the user-facing guide.

The person you're helping may not be technical. Keep it short, say what you're about to do on their TV before you
do it, and let them do the taps on the TV.

## Secrets

- The Ororo email and password live only in `credentials.properties` (gitignored) or in the TV's local storage.
  Never ask for them in the chat, never print them, never commit them. `out/creds.js` and `*.wgt` can contain them
  and are gitignored too.
- Certificate passwords are the user's: they type them in their own terminal, never in the chat.
- Before any commit, check `git status` and `git diff --cached` for passwords, keys, and the email address.

## Commits

- Author: `spapazian <46726975+ste5an@users.noreply.github.com>` (set in this repo's git config).
- Never add Claude as an author or co-author: no `Co-Authored-By` trailer, no "Generated with Claude Code" line in
  commits, pull requests or docs.

## Building and installing

```bash
python3 build.py --sign <profile> --install <TV IP>
```

- Needs Samsung's Tizen CLI (`~/tizen-studio/tools/ide/bin/tizen`, `~/tizen-studio/tools/sdb`; or set
  `TIZEN_STUDIO`). On Apple Silicon `sdb` needs Rosetta.
- `tizen security-profiles list` shows the profiles. Updates must use the same certificate as the installed copy.
- The TV needs Developer mode on with this computer's IP as Host PC IP, and a restart after turning it on. If
  `sdb connect` says offline, run `sdb kill-server` and connect again.
- `sdb shell 0 debug` (remote inspector) doesn't work on retail TVs. To debug, show the information on screen
  (`toast()`), as the subtitles menu does with `sentKeys` and `subError`.

## The code (`www/app.js`)

- **Target:** the Chromium inside Tizen. Tizen 6 is Chromium 76: no `?.`, no `??`, no flexbox `gap`, no `inset`,
  no `aspect-ratio`. Keep it plain ES2017 with no libraries or frameworks.
- **API:** `api(path)` → JSON from `/api/v2` with HTTP Basic auth, trying `front.ororo.tv`, `front.ororo-mirror.tv`
  and `ororo.tv` in turn. Endpoints: `/movies`, `/shows` (whole catalogue), `/shows/:id` (with `episodes`),
  `/movies/:id` and `/episodes/:id` (`url`, `download_url`, `subtitles: [{lang, url}]`). 401 means a bad login and
  sends the user to the login screen; 402 means the plan doesn't cover it.
- **Screens:** a stack (`push`, `pop`, `reset`). Each screen is `{el, start, key(k), back(), focused(el), shown(),
  close()}`.
- **Remote navigation:** focusable elements have class `f`; the focused one gets `focus`. Posters (`.g`) move by
  index with `COLS = 7` (must match `.grid` in style.css) and are rendered `CHUNK` at a time. Everything else moves
  to the nearest element on screen in that direction. `.scroll` / `.hscroll` boxes scroll to keep focus in view.
- **Keys:** `KEYS` maps Tizen key codes. Media keys are registered with `tizen.tvinputdevice.registerKeyBatch`. The
  TV keyboard's Done and Cancel are 65376 and 65385.
- **Player:** HLS (`playlist_fmp4.m3u8` swapped for `playlist.m3u8`), with `download_url` as the fallback.
  Seeking lives in `www/seek.js` (`SeekController`, no UI): the player feeds it key-downs (`press`, auto-repeats
  included) and key-ups (`release`, from the global `keyup` → `s.keyUp`). States: idle → accumulating (±10 s per
  press, one seek after the debounce, which starts on key-up) → scrubbing (held past 500 ms: 10/30/60 s steps per
  250 ms tick) → committing (one `video.currentTime` set, waits for `seeked`, keeps play/pause; input meanwhile is
  queued). Its `onChange` drives the center indicator and the marker on the progress bar. ▼ focuses the `buttons` row; the side `menu`
  (`openMenu({title, items, current, pick, note})`) serves Subtitles and Quality. Quality reads the master
  playlist's `#EXT-X-STREAM-INF` variants (`loadVariants`) and plays the chosen variant's URL; a failing choice
  falls back to Auto, then to the MP4. The player sets `keysWhileBusy` so the remote works while it buffers.
  Subtitles are fetched and drawn by the app (`parseSubs`, SRT or VTT), with a `<track>` if fetching fails.
- **Storage (localStorage):** `creds`, `positions` (`m<id>` / `e<id>` → `{t, d, at}`), `history`, `sort`,
  `sublang`, `quality`.

## Checking a change

`node --test test/seek.test.js` (seek logic, fake clock), `node --check www/app.js`, then build and install on the TV and have the user try it. To see a screen without a
TV, `python3 build.py`, then open `out/index.html` in Chrome at 1920×1080 (the API calls need a login).
