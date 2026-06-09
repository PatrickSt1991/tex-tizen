# TeX for Samsung Tizen TV

Wraps the [TeX](https://github.com/OGHaza/TeX) Kodi web interface in a
Samsung Tizen `.wgt` and routes video playback through **Tizen AVPlay**,
so files stream and decode on the TV itself (hardware HEVC / AC3 / etc.)
instead of being limited by the WebView or routed back to the Kodi
server's screen.

The wrapper deliberately knows nothing about TeX internals. It only
adds:

- A first-launch setup screen that pings Kodi before saving creds
- Auth injection on XHR / fetch / WebSocket so TeX's requests reach
  Kodi with HTTP Basic
- `<img src>` rewriting so authenticated `/image/...` loads resolve on
  Tizen's `file://` origin (no Service Worker support)
- A virtual mouse cursor + manual spatial navigation (Tizen 5 ships no
  built-in spatial nav for web apps)
- An AVPlay-driven `videoPlayer.html` for hardware-decoded playback
- An optional live debug stream paired with
  [`tools/debug-server.py`](tools/debug-server.py)

> **This is not a port of Kodi or TeX.** It packages an existing web
> client as a TV app and adds the platform glue.

---

## Install

1. **Download the latest `.wgt`** from the
   [Releases page](../../releases).

2. **Enable Developer Mode** on your Samsung TV
   ([Samsung's instructions](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html))
   and put your dev-machine's IP into the TV's "Host PC IP" field.

3. **Sideload the `.wgt`**. Either:

   - via [Apps2Samsung](https://apps2samsung.madebypatrick.nl/)
     (the friendly path — handles any signed Tizen `.wgt`),
   - via Tizen Studio's Device Manager → Permit to install → Drag-drop, or
   - from the command line:
     ```bash
     sdb connect <tv-ip>
     sdb install TeX-Tizen.wgt
     ```

4. **Launch** the app on your TV. The setup screen appears on first
   run.

5. **Enter your Kodi server details** — host/IP, port (default 8080),
   username, password — and press **Connect**. The app pings Kodi with
   the entered credentials and only proceeds on a valid `pong`, so bad
   config is caught up-front.

---

## Requirements

- Samsung TV with **Tizen 5.0 or later** (roughly 2019 and newer)
- A **Kodi v17+** server reachable on the same network as the TV
- Kodi's web interface enabled, with:
  - *Allow control of Kodi via HTTP* → on
  - *Allow remote control from applications on other systems* → on
  - HTTP Basic credentials configured (username + password)

---

## Build from source

The wrapper is just glue. The actual UI is built from
[OGHaza/TeX](https://github.com/OGHaza/TeX) by the build script:

```bash
git clone https://github.com/PatrickSt1991/tex-tizen.git
cd tex-tizen

# Smoke-test the prepare pipeline. Clones TeX, runs `npm ci && npm run
# build`, lays out the Tizen package — but skips the Tizen CLI. Useful
# for verifying the layout without installing Tizen Studio.
bash tizen/build.sh --dry-run

# Full build (needs Tizen Studio CLI on PATH or in $TIZEN_BIN, plus
# Node.js 20+ for the TeX build):
TIZEN_BIN=~/tizen-studio/tools/ide/bin/tizen \
TIZEN_PROFILE=TeX \
  bash tizen/build.sh
# → release/TeX-Tizen.wgt
```

`build.sh` flags:

| Flag                 | What it does                                                                       |
| -------------------- | ---------------------------------------------------------------------------------- |
| *(no flag)*          | Full pipeline: clone+build TeX, prepare, `tizen build-web`, `tizen package`        |
| `--dry-run`          | Everything except the Tizen CLI invocations. No Tizen Studio needed.               |
| `--no-package`       | Prepare + `tizen build-web` only — skips the interactive `tizen package`. CI use.  |
| `--skip-tex-build`   | Reuse the existing `tex-src/dist/` (don't re-clone, don't re-npm-build).           |

Env vars: `TEX_REPO` (default `https://github.com/OGHaza/TeX.git`),
`TEX_REF` (default `main`), `TIZEN_BIN`, `TIZEN_PROFILE`.

### CI

`.github/workflows/build-tizen.yml` installs Node 20, clones+builds
TeX, installs Tizen Studio 5.5, creates a self-signed `TeX` cert +
security profile, runs `build.sh --no-package`, drives `tizen package`
through an expect-script (the CLI prompts for cert passwords
interactively), then uploads the signed `.wgt` as both a workflow
artifact and a GitHub release. Every push to `main` produces a fresh
build.

---

## Debug

If something misbehaves on the TV, the app can stream every
`console.log`, error, click and XHR response to a dev-machine terminal
over WebSocket. There's no DevTools window on the TV, so this is how
we look behind the curtain.

**1. Run the listener on a machine the TV can reach.**
The script is at [`tools/debug-server.py`](tools/debug-server.py) in
this repo (and attached to every Release). Stdlib-only — no
`pip install`. From any shell:

```bash
python3 tools/debug-server.py            # default port 9999
python3 tools/debug-server.py 9099       # custom port
python3 tools/debug-server.py 9999 -q    # no colour, plain text
```

On Windows + WSL, prefer running it from PowerShell rather than WSL —
PowerShell binds to the host IP the TV can see directly; WSL2 has its
own internal network and needs port-forwarding. If Windows Firewall
prompts you, allow the connection on Private networks.

**2. Point the TV at it.**
On the app's first-launch setup screen (or after a Reset), fill in the
**Debug host** field as `<your-pc-ip>:9999`. Press Connect.

Leave the field blank to disable. The app retries silently if the
listener isn't running — nothing breaks.

---

## How it works

```
tex-tizen/
├── tex-src/                  # cloned at build time — DO NOT COMMIT (.gitignored)
├── tizen/
│   ├── wrapper/
│   │   ├── config.xml        # Tizen app manifest
│   │   ├── icon.png          # app icon (resized to 117×117 at build time)
│   │   └── videoPlayer.html  # AVPlay-driven player page
│   ├── extras/
│   │   ├── tizen-bootstrap.js  # auth/URL patches, setup screen, cursor, debug stream
│   │   ├── tizen-sw.js         # image-auth Service Worker (no-op on file://)
│   │   └── tizen.css           # AVPlay surface + TV focus styles
│   └── build.sh              # clone TeX, npm build, wrap, tizen package
├── tools/
│   └── debug-server.py       # WebSocket log sink (stdlib-only)
└── .github/workflows/
    └── build-tizen.yml       # CI: produces a signed .wgt per push
```

At build time `build.sh` clones TeX, runs `npm ci && npm run build`,
copies the resulting `dist/` into `build/`, layers our wrapper + extras
on top, injects our bootstrap into `<head>`, and **defers every other
`<script src=...>` to `type="text/x-tizen-deferred"`**. The browser
ignores deferred-typed scripts entirely — so on first launch, with no
config saved, TeX never boots and our setup screen owns the page. Once
the user submits the form we save creds, reload, install the patches,
and re-emit the deferred scripts in their original order.

`tizen-bootstrap.js` is the integration point. It runs first in
`<head>` and:

- Shows the setup screen + pings Kodi before saving anything
- Patches `XMLHttpRequest`, `fetch`, and `WebSocket` so relative URLs
  land on the configured Kodi host with HTTP Basic auth
- Rewrites `<img src="/image/...">` to a userinfo URL so authenticated
  images load on Tizen's `file://` origin (no SW available)
- Installs a virtual mouse pointer driven by the remote's arrow keys
  + OK, with acceleration on held arrows (24px base, +12px per repeat)
- Registers Tizen media keys (`MediaPlay`, `MediaPause`, etc.) so they
  reach the page — does NOT bind selectors to them; TeX handles its
  own player UI

The bootstrap also intercepts JSON-RPC `Player.Open` calls at the wire
level (XHR + fetch). When TeX clicks "play", instead of letting the
call reach Kodi (which would play on the server's own screen), the
bootstrap resolves the actual file path (directly from `item.file`, or
via `Playlist.GetItems` for playlist plays), runs `Files.PrepareDownload`
to get a `vfs/...` URL, and navigates the page to `videoPlayer.html`.

`videoPlayer.html` then drives `webapis.avplay` directly:
`open` → `setListener` → `SET_MODE_4K` → `prepareAsync` →
`setDisplayMethod(LETTER_BOX)` → `play`. Basic Auth is embedded into
the AVPlay URL as `http://user:pass@host:port/...`.

---

## Acknowledgments

- **[TeX](https://github.com/OGHaza/TeX)** by OGHaza — the web
  interface this app wraps.
- **[chorus2-tizen](https://github.com/PatrickSt1991/chorus2-tizen)** —
  the original wrapper this is derived from.
- **[jellyfin-tizen-avplay](https://github.com/PatrickSt1991/tizen-jellyfin-avplay)**
  — where the AVPlay shim pattern was first worked out.
- The Tizen Web Application docs and AVPlay API reference at
  [docs.tizen.org](https://docs.tizen.org/).
