# Ororo TV for Samsung

**Watch [ororo.tv](https://ororo.tv) on a Samsung Smart TV, with the remote and with subtitles.**

Ororo has no Samsung app, and its website doesn't work well with a TV remote. This is a small TV app: posters for
every movie and show, seasons and episodes, a player that remembers where you stopped, and a subtitles menu with
every language Ororo has for the video.

> Unofficial. Not made by or affiliated with Ororo. You need your own ororo.tv account.

## What you get

- **Movies, Shows, Search and Continue** tabs, sorted by Popular, New, Top rated or A–Z.
- **Show pages** with seasons and episodes. Watched episodes get a ✓, and the next one to watch is already selected.
- **A player made for the remote:**
  - OK pauses; ◀ ▶ skip, faster while held.
  - ▼ shows the **Subtitles** button: OK opens the list (Off plus every language), ▲ ▼ pick one, OK turns it on.
  - Back leaves and saves your place. The remote's play, pause, rewind and fast-forward buttons work too.
- **Plays the next episode** by itself when one ends.
- **Big, readable subtitles** drawn by the app, with the TV's own subtitles as a fallback.

## Install

You need a Samsung TV from 2017 or newer (Tizen 3+) and a Mac or Linux computer on the same Wi-Fi.

1. **On the TV**, open **Apps** and type `1 2 3 4 5` on the remote. Turn **Developer mode** on, enter your
   computer's IP address in **Host PC IP**, and restart the TV (hold the power button until the logo shows).
2. **On your computer**, install Samsung's Tizen tools: the
   [Tizen Studio CLI](https://developer.tizen.org/development/tizen-studio/download) (`tizen` and `sdb`). On Apple
   Silicon Macs, `sdb` needs Rosetta (`softwareupdate --install-rosetta`).
3. **Make a signing certificate**, once (pick your own password):
   ```bash
   ~/tizen-studio/tools/ide/bin/tizen certificate -a mytv -p 'YOUR-PASSWORD' -c US -n "My TV"
   ~/tizen-studio/tools/ide/bin/tizen security-profiles add -n mytv -a ~/tizen-studio-data/keystore/author/mytv.p12 -p 'YOUR-PASSWORD'
   ```
   TVs from 2023 and newer need a Samsung certificate instead, made with your Samsung account in Tizen Studio's
   Certificate Manager.
4. **Build and install:**
   ```bash
   git clone https://github.com/ste5an/ororo-tv && cd ororo-tv
   python3 build.py --sign mytv --install 192.168.1.70   # your TV's IP
   ```
5. **On the TV**, sign in with your ororo.tv email and password. If you sign in to Ororo with Google or Facebook,
   set a password on ororo.tv first.

The app is under **Apps** on the TV. To put it on the home bar, highlight it, hold OK, and choose *Add to Home*.

### Skip typing on the TV (optional)

Typing an email with a remote is slow. Put your login in `credentials.properties` next to `build.py` and build
again, and the app signs in by itself:

```properties
email=you@example.com
password=your-ororo-password
```

The file is in `.gitignore`, so it never gets committed. The password does end up inside the app on your TV, so
don't share that build.

## Build options

```bash
python3 build.py                                # OroroTV.wgt, not signed
python3 build.py --sign PROFILE                 # signed with a Tizen security profile
python3 build.py --sign PROFILE --install TV_IP # signed, installed and opened on the TV
python3 tools/make_icon.py                      # redraws www/icon.png
```

Updates must be signed with the same certificate as the installed copy. Otherwise, uninstall it first:
`tizen uninstall -p OroroTVapp.OroroTV -t <TV name from sdb devices>`.

## How it works

- **A plain web app**: `www/index.html`, `style.css` and `app.js`, no frameworks and no build step beyond zipping.
  Written for the Chromium 76 inside Tizen 6 (no optional chaining, no flexbox `gap`).
- **Ororo's API**, the one its Kodi add-ons use: `GET /api/v2/movies`, `/shows`, `/shows/:id` (episodes),
  `/movies/:id` and `/episodes/:id` (video URL and subtitles), with HTTP Basic auth. It tries `front.ororo.tv`, then
  `front.ororo-mirror.tv`, then `ororo.tv`.
- **Playback** uses the TV's own `<video>` element with Ororo's HLS stream, falling back to the MP4 download link.
- **Your place, history and subtitle language** are saved in the app's local storage on the TV. Nothing is sent
  anywhere except to Ororo.
- `build.py` copies `www/` and `config.xml` into `out/`, adds `creds.js` (your login, or `null`), zips it into
  `OroroTV.wgt`, signs it with `tizen package`, and installs it with `tizen install` and `tizen run`.

| File | What it is |
|---|---|
| [`www/app.js`](www/app.js) | The whole app: API, screens, remote navigation, player, subtitles |
| [`www/style.css`](www/style.css) | The look, laid out for 1920×1080 |
| [`config.xml`](config.xml) | The Tizen app manifest |
| [`build.py`](build.py) | Build, sign and install |
| [`tools/make_icon.py`](tools/make_icon.py) | Draws the icon without any libraries |

## License

MIT. See [LICENSE](LICENSE).
