#!/usr/bin/env bash
#
# tizen/build.sh — Build the TeX Tizen .wgt package.
#
# Pipeline:
#   1. Clone TeX upstream (or reuse an existing clone) and `npm run build`
#      it. We do NOT vendor a prebuilt dist/ — TeX is an Angular project
#      that ships only source.
#   2. Copy the built dist/ into build/.
#   3. Drop in our wrapper (config.xml, icon.png, videoPlayer.html) and
#      extras (tizen-bootstrap.js, tizen-sw.js, tizen.css).
#   4. Inject our <link>/<script> into <head> of index.html, then mark
#      every other <script src="..."> as type="text/x-tizen-deferred"
#      so the browser ignores them until tizen-bootstrap.js activates
#      them. This is how the setup screen runs unopposed on first launch.
#   5. Resize icon to 117x117 if ImageMagick is available.
#   6. Run `tizen build-web` + `tizen package -t wgt`.
#   7. Move .wgt to release/.
#
# Env vars:
#   TIZEN_BIN     Path to the tizen CLI. Defaults to ~/tizen-studio/tools/ide/bin/tizen.
#   TIZEN_PROFILE Tizen signing profile name. Defaults to "TeX".
#   TEX_REPO      Git URL for TeX upstream. Defaults to OGHaza's repo.
#   TEX_REF       Git ref (branch/tag/SHA) to check out. Defaults to "main".
#
# Flags:
#   --dry-run     Run only the prepare steps; no `tizen` CLI required.
#   --no-package  Run prepare + `tizen build-web` but skip `tizen package`.
#                 CI uses this and drives `tizen package` separately via
#                 an expect script.
#   --skip-tex-build
#                 Reuse the existing tex-src/dist/ — don't re-clone or
#                 re-npm-build. Useful when iterating on wrapper/extras.

set -euo pipefail

DRY_RUN=0
NO_PACKAGE=0
SKIP_TEX_BUILD=0
for arg in "$@"; do
    case "$arg" in
        --dry-run)         DRY_RUN=1 ;;
        --no-package)      NO_PACKAGE=1 ;;
        --skip-tex-build)  SKIP_TEX_BUILD=1 ;;
        *) echo "[build] unknown flag: $arg" >&2; exit 2 ;;
    esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/build"
WRAPPER="$ROOT/tizen/wrapper"
EXTRAS="$ROOT/tizen/extras"
RELEASE_DIR="$ROOT/release"
TEX_SRC="$ROOT/tex-src"

TIZEN_BIN="${TIZEN_BIN:-$HOME/tizen-studio/tools/ide/bin/tizen}"
PROFILE_NAME="${TIZEN_PROFILE:-TeX}"
TEX_REPO="${TEX_REPO:-https://github.com/OGHaza/TeX.git}"
TEX_REF="${TEX_REF:-main}"

log() { printf "\033[1;34m[build]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[build]\033[0m %s\n" "$*" >&2; }
fail() { printf "\033[1;31m[build]\033[0m %s\n" "$*" >&2; exit 1; }

# --- Sanity checks on inputs -------------------------------------------------

[[ -f "$WRAPPER/config.xml"       ]] || fail "wrapper/config.xml missing"
[[ -f "$WRAPPER/icon.png"         ]] || fail "wrapper/icon.png missing"
[[ -f "$WRAPPER/videoPlayer.html" ]] || fail "wrapper/videoPlayer.html missing"
[[ -f "$EXTRAS/tizen-bootstrap.js" ]] || fail "extras/tizen-bootstrap.js missing"
[[ -f "$EXTRAS/tizen-sw.js"        ]] || fail "extras/tizen-sw.js missing"
[[ -f "$EXTRAS/tizen.css"          ]] || fail "extras/tizen.css missing"

# --- Clone + build TeX upstream ---------------------------------------------

if [[ $SKIP_TEX_BUILD -eq 1 ]]; then
    log "--skip-tex-build: reusing existing tex-src/dist/"
    [[ -d "$TEX_SRC" ]] || fail "tex-src/ does not exist — run once without --skip-tex-build first"
else
    if [[ -d "$TEX_SRC/.git" ]]; then
        log "updating existing tex-src/ clone (fetch + checkout $TEX_REF)"
        git -C "$TEX_SRC" fetch --depth 1 origin "$TEX_REF"
        git -C "$TEX_SRC" checkout --detach FETCH_HEAD
    else
        log "cloning $TEX_REPO @ $TEX_REF into tex-src/"
        rm -rf "$TEX_SRC"
        git clone --depth 1 --branch "$TEX_REF" "$TEX_REPO" "$TEX_SRC"
    fi

    # --legacy-peer-deps: TeX's package.json mixes peer-dep ranges that npm 10
    # refuses to reconcile (e.g. Angular 16 alongside an Angular-15-only
    # @fortawesome/angular-fontawesome). The flag tells npm to use the old
    # npm 6 resolver, which is exactly what TeX is developed against.
    log "npm ci in tex-src/ (legacy-peer-deps)"
    if [[ -f "$TEX_SRC/package-lock.json" ]]; then
        (cd "$TEX_SRC" && npm ci --legacy-peer-deps)
    else
        (cd "$TEX_SRC" && npm install --legacy-peer-deps)
    fi

    log "npm run build in tex-src/"
    (cd "$TEX_SRC" && npm run build)
fi

# Angular usually emits dist/<project>/ — find the first dir under dist/
# that contains an index.html.
TEX_DIST="$(find "$TEX_SRC/dist" -mindepth 1 -maxdepth 3 -name index.html -print -quit 2>/dev/null)"
[[ -n "$TEX_DIST" ]] || fail "no index.html found under $TEX_SRC/dist — check TeX's angular.json outputPath"
TEX_DIST_DIR="$(dirname "$TEX_DIST")"
log "TeX built dist: $TEX_DIST_DIR"

# --- Prepare build directory -------------------------------------------------

log "preparing $BUILD_DIR"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

cp -r "$TEX_DIST_DIR/." "$BUILD_DIR/"

# Wrapper + extras override anything with the same name.
cp "$WRAPPER/config.xml"       "$BUILD_DIR/config.xml"
cp "$WRAPPER/icon.png"         "$BUILD_DIR/icon.png"
cp "$WRAPPER/videoPlayer.html" "$BUILD_DIR/videoPlayer.html"
cp "$EXTRAS/tizen-bootstrap.js" "$BUILD_DIR/tizen-bootstrap.js"
cp "$EXTRAS/tizen-sw.js"        "$BUILD_DIR/tizen-sw.js"
cp "$EXTRAS/tizen.css"          "$BUILD_DIR/tizen.css"

# --- Patch index.html --------------------------------------------------------

INDEX="$BUILD_DIR/index.html"
[[ -f "$INDEX" ]] || fail "$INDEX missing after copy"

# 1) Inject our CSS + bootstrap as the FIRST children of <head>. Order
#    matters: the bootstrap must execute before any other script.
INJECT='<link rel="stylesheet" href="tizen.css">\n<script src="tizen-bootstrap.js"></script>'
sed -i "0,/<head[^>]*>/{s|<head\\([^>]*\\)>|<head\\1>\n${INJECT}|}" "$INDEX"

# 2) Defer every other <script src="..."> — change its type to
#    text/x-tizen-deferred so the browser ignores it. The bootstrap
#    walks these and re-emits them in order once config is present.
#    The regex deliberately excludes our own bootstrap (by exact src
#    match) and any script that doesn't have an src attribute (inline
#    Angular config blocks etc.).
python3 - "$INDEX" <<'PY'
import re, sys

path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    html = f.read()

SCRIPT_RE = re.compile(
    r'<script\b([^>]*?\bsrc\s*=\s*["\']([^"\']+)["\'][^>]*)>',
    re.IGNORECASE
)

def patch(match):
    attrs = match.group(1)
    src = match.group(2)
    # Don't defer our own bootstrap.
    if src.endswith('tizen-bootstrap.js'):
        return match.group(0)
    # Already deferred? leave it.
    if re.search(r'type\s*=\s*["\']text/x-tizen-deferred["\']', attrs, re.I):
        return match.group(0)
    # Strip any existing type= (Angular sometimes emits type="module").
    attrs_no_type = re.sub(r'\s+type\s*=\s*["\'][^"\']*["\']', '', attrs)
    return f'<script type="text/x-tizen-deferred"{attrs_no_type}>'

new = SCRIPT_RE.sub(patch, html)
with open(path, 'w', encoding='utf-8') as f:
    f.write(new)
PY

# Sanity: confirm both edits landed.
grep -q "tizen-bootstrap.js" "$INDEX" || fail "bootstrap injection failed (no tizen-bootstrap.js in built index.html)"
grep -q "text/x-tizen-deferred" "$INDEX" || warn "no scripts were deferred — index.html might not reference any src= scripts (check $INDEX)"

# --- Resize icon to 117x117 if a tool is available --------------------------

if command -v convert >/dev/null 2>&1; then
    log "resizing icon to 117x117 with ImageMagick"
    convert "$BUILD_DIR/icon.png" -resize 117x117 "$BUILD_DIR/icon.png"
elif command -v ffmpeg >/dev/null 2>&1; then
    log "resizing icon to 117x117 with ffmpeg"
    tmp="$BUILD_DIR/icon.tmp.png"
    ffmpeg -y -i "$BUILD_DIR/icon.png" -vf scale=117:117 "$tmp" >/dev/null 2>&1
    mv "$tmp" "$BUILD_DIR/icon.png"
else
    warn "no ImageMagick/ffmpeg found — shipping icon at its committed size; Tizen Studio will warn but accept"
fi

log "prepare complete: $(find "$BUILD_DIR" -type f | wc -l) files in $BUILD_DIR"

# --- Dry run exits here ------------------------------------------------------

if [[ $DRY_RUN -eq 1 ]]; then
    log "--dry-run: skipping tizen CLI invocations"
    exit 0
fi

# --- Build + package via Tizen Studio CLI -----------------------------------

if [[ ! -x "$TIZEN_BIN" ]]; then
    fail "Tizen CLI not found at $TIZEN_BIN.
  Install Tizen Studio (https://docs.tizen.org/application/tizen-studio/) and either
  put 'tizen' on PATH or set TIZEN_BIN to its absolute path.
  (To validate the build layout without Tizen Studio, run: bash tizen/build.sh --dry-run)"
fi

cd "$BUILD_DIR"
log "tizen build-web"
"$TIZEN_BIN" build-web -e ".*" -e "node_modules/*"

if [[ $NO_PACKAGE -eq 1 ]]; then
    log "--no-package: skipping tizen package (caller will run it via expect)"
    log "web build ready at $BUILD_DIR (.buildResult/ will be populated by the packaging step)"
    exit 0
fi

log "tizen package (profile: $PROFILE_NAME)"
"$TIZEN_BIN" package -t wgt -s "$PROFILE_NAME" -- "$BUILD_DIR/.buildResult"

# --- Move artifact -----------------------------------------------------------

mkdir -p "$RELEASE_DIR"
WGT="$(find "$BUILD_DIR/.buildResult" -maxdepth 1 -name '*.wgt' -print -quit)"
[[ -n "$WGT" ]] || fail "tizen package did not produce a .wgt under $BUILD_DIR/.buildResult"
mv "$WGT" "$RELEASE_DIR/TeX-Tizen.wgt"

log "built: $RELEASE_DIR/TeX-Tizen.wgt"
