/*
 * tizen-bootstrap.js — TeX-on-Tizen integration shim.
 *
 * Runs as the first <script> in <head>. Responsibilities:
 *   1. Storage + first-launch setup screen (Kodi host / port / creds /
 *      optional debug host) with a JSONRPC.Ping pre-flight before save.
 *   2. Patch XMLHttpRequest / fetch / WebSocket so any same-origin or
 *      relative request from the upstream app lands on the configured
 *      Kodi host with Basic Auth.
 *   3. Image-auth via MutationObserver — rewrite any /image/ <img src>
 *      to a userinfo URL so authenticated subresources load on Tizen
 *      (where Service Workers don't work from file://).
 *   4. Virtual mouse cursor + manual spatial navigation (Tizen 5 has no
 *      built-in spatial nav for web apps).
 *   5. Register Tizen TV media keys so they reach the page.
 *   6. Optional debug WebSocket stream pairing with tools/debug-server.py.
 *   7. Once everything is wired, activate the upstream scripts that
 *      build.sh deferred (type="text/x-tizen-deferred" → re-emit). Until
 *      then the upstream app does not boot — that lets the setup screen
 *      run unopposed on first launch.
 *
 * Deliberately knows nothing about TeX internals — only about Kodi's
 * JSON-RPC contract and Tizen platform quirks. Anything TeX-specific
 * lives in TeX itself.
 */

// --- Runtime-API polyfills for Chromium 56 (Tizen 5.0) -----------------
// esbuild's --target=chrome56 lowers SYNTAX in TeX's bundles but does
// not patch missing runtime APIs. Each of these has been observed to
// throw during Angular's bootstrap on a UE55RU7020. They must run
// before any other script — which they do, because the bootstrap is
// the first <script> in <head> and TeX's bundles stay deferred until
// activateDeferredScripts() fires later in this file.
//
// All installed via Object.defineProperty with enumerable:false so
// they match the native methods exactly. Direct assignment
// (`Array.prototype.flat = ...`) defaults to enumerable:true, which
// makes the polyfills show up in `for (var k in arr)` loops and
// breaks any code that assumes only own indices/keys are enumerated.
// That bug surfaced as TeX's i18n loader sending requests to
// `/assets/i18n/<function-source>.json`.

function tzShim(obj, name, value) {
  Object.defineProperty(obj, name, {
    value: value,
    configurable: true,
    writable: true,
    enumerable: false
  });
}

// globalThis — Chrome 71+. Angular's polyfills.js/main.js reference it
// at module-load time and throw ReferenceError immediately without it.
if (typeof window.globalThis === 'undefined') {
  tzShim(window, 'globalThis', window);
}

// queueMicrotask — Chrome 71+. Angular Zone.js calls this on every
// change-detection tick; without it, every onStable emission throws
// and nothing renders.
if (typeof window.queueMicrotask !== 'function') {
  tzShim(window, 'queueMicrotask', function (cb) {
    Promise.resolve().then(cb).catch(function (e) {
      setTimeout(function () { throw e; }, 0);
    });
  });
}

// Array.prototype.flat / flatMap — Chrome 69+. Modern Angular DI
// factories use flat() on argument lists.
if (!Array.prototype.flat) {
  tzShim(Array.prototype, 'flat', function (depth) {
    var d = depth === undefined ? 1 : Math.floor(Number(depth)) || 0;
    if (d < 1) return Array.prototype.slice.call(this);
    return Array.prototype.reduce.call(this, function (acc, val) {
      return acc.concat(Array.isArray(val) ? val.flat(d - 1) : val);
    }, []);
  });
}
if (!Array.prototype.flatMap) {
  tzShim(Array.prototype, 'flatMap', function (cb, thisArg) {
    return Array.prototype.map.call(this, cb, thisArg).flat();
  });
}

// Object.fromEntries — Chrome 73+. Angular Animations' keyframe
// converter uses it; without it animations blow up mid-render.
if (typeof Object.fromEntries !== 'function') {
  tzShim(Object, 'fromEntries', function (entries) {
    var obj = {};
    if (entries == null) return obj;
    var iter = typeof entries.forEach === 'function'
      ? entries
      : Array.prototype.slice.call(entries);
    iter.forEach(function (pair) {
      if (pair) obj[pair[0]] = pair[1];
    });
    return obj;
  });
}

(function () {
  'use strict';

  var STORAGE_KEY = 'tex-tizen-config';

  function loadConfig() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveConfig(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  function clearConfig() {
    localStorage.removeItem(STORAGE_KEY);
  }

  // Setup form rendered when no config is stored. The submit handler runs
  // a JSONRPC.Ping pre-flight against the entered server before saving —
  // turns a post-submit loading-screen hang into an actionable diagnostic
  // when host/auth is wrong.
  function showSetupScreen(existing) {
    document.documentElement.style.cssText =
      'background:#0a0e13;' +
      'background:#0a0e13 radial-gradient(ellipse at top, #1a2336 0%, #0a0e13 60%);';
    document.body.innerHTML = '';
    document.body.style.cssText =
      'margin:0;padding:0;color:#f0f4fa;' +
      'font:20px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;' +
      'min-height:100vh;background:transparent;' +
      'display:block;width:100%;box-sizing:border-box;';

    var wrap = document.createElement('div');
    wrap.style.cssText =
      'max-width:680px;margin:5vh auto;padding:40px 48px 36px;' +
      'background:#141a26;border:1px solid #232c3d;border-radius:14px;' +
      'box-shadow:0 12px 48px rgba(0,0,0,.55),0 2px 0 rgba(255,255,255,.03) inset;';

    // No inline onerror attribute on the logo — Tizen WAS rejects inline
    // event handlers and that causes a silent install failure. The error
    // handler is wired with addEventListener after appendChild below.
    wrap.innerHTML =
      '<div style="display:flex;align-items:center;margin:0 0 4px">' +
        // Logo tile: orange gradient with the full "TeX" wordmark in
        // the classic TeX style (middle E sits lower and slightly
        // smaller than T and X). Rendered directly in the gradient div
        // so the colour actually shows.
        '<div style="width:48px;height:48px;border-radius:11px;' +
        'background:linear-gradient(135deg,#f97316,#c2410c);' +
        'display:flex;align-items:center;justify-content:center;' +
        'box-shadow:0 3px 10px rgba(249,115,22,.22);' +
        'color:#fff;font-weight:700;font-size:22px;line-height:1;' +
        'font-family:Georgia,\'Times New Roman\',serif">' +
          'T' +
          '<span style="font-size:.78em;vertical-align:-.18em;' +
          'margin:0 -.07em;display:inline-block">E</span>' +
          'X' +
        '</div>' +
        '<h1 style="margin:0 0 0 18px;font-size:30px;font-weight:700;' +
        'color:#ffffff;letter-spacing:-.01em;line-height:1.1">TeX <span style="font-weight:400;color:#9aa6b8">for Tizen</span></h1>' +
      '</div>' +
      '<p style="margin:6px 0 24px 66px;color:#c8d2dd;font-size:16px">' +
        'Point this app at your Kodi server to get started.' +
      '</p>' +
      '<div style="height:1px;background:#232c3d;margin:0 0 24px"></div>' +

      // TEMP: dev defaults for fast on-device iteration. STRIP these
      // before any public release — pre-filling someone else's network
      // is a footgun. Per the dev-prefs memory, the chorus2 project
      // stripped equivalents before going public; do the same here.
      '<form id="tz-setup" autocomplete="off">' +
        section('Server') +
        field('host',     'Kodi host or IP', existing && existing.host || '192.168.2.22', 'text',   'e.g. 192.168.1.50') +
        field('port',     'HTTP port',       existing && existing.port || '8080',         'number', '8080') +

        section('Authentication', '32px') +
        field('username', 'Username',        existing && existing.username || 'kodi', 'text',     'kodi') +
        field('password', 'Password',        existing && existing.password || 'kodi', 'password', 'Your Kodi password') +

        section('Debug log (optional)', '32px') +
        field('debug',    'Debug host', existing && existing.debug || '192.168.2.22:9999', 'text', 'e.g. 192.168.2.20:9999 (leave blank to disable)') +

        '<div style="display:flex;margin-top:32px">' +
          button('save',  'Connect',  true) +
          '<span style="display:inline-block;width:14px"></span>' +
          button('reset', 'Reset',    false) +
        '</div>' +

        '<div id="tz-status" style="margin:22px 0 0;padding:16px 18px;' +
            'background:#0d1218;border:1px solid #232c3d;border-radius:10px;' +
            'color:#c8d2dd;font-size:16px;min-height:1.3em;display:flex;align-items:center">' +
          '<span id="tz-status-dot" style="width:10px;height:10px;border-radius:50%;background:#4a5566;flex:none;margin-right:12px"></span>' +
          '<span id="tz-status-text">Ready. Enter your Kodi details and press Connect.</span>' +
        '</div>' +

        '<p style="color:#9aa6b8;font-size:14px;margin:18px 0 0;text-align:center">' +
          'Use <kbd style="padding:1px 6px;background:#232c3d;border-radius:4px;color:#d0d8e3;font:inherit">↑</kbd> ' +
          '<kbd style="padding:1px 6px;background:#232c3d;border-radius:4px;color:#d0d8e3;font:inherit">↓</kbd> ' +
          'or <kbd style="padding:1px 8px;background:#232c3d;border-radius:4px;color:#d0d8e3;font:inherit">OK</kbd> ' +
          'to move between fields. <kbd style="padding:1px 8px;background:#232c3d;border-radius:4px;color:#d0d8e3;font:inherit">Back</kbd> exits.' +
        '</p>' +
      '</form>';
    document.body.appendChild(wrap);

    var form = document.getElementById('tz-setup');
    form.host.focus();

    function focusables() {
      return [form.host, form.port, form.username, form.password, form.debug,
              document.getElementById('tz-save'),
              document.getElementById('tz-reset')];
    }

    function shiftFocus(delta) {
      var list = focusables();
      var idx = list.indexOf(document.activeElement);
      if (idx < 0) idx = 0;
      var next = Math.max(0, Math.min(list.length - 1, idx + delta));
      list[next].focus();
      if (list[next].select) try { list[next].select(); } catch (_) {}
    }

    form.addEventListener('keydown', function (e) {
      var list = focusables();
      var idx = list.indexOf(document.activeElement);
      var isInput = document.activeElement &&
                    document.activeElement.tagName === 'INPUT';
      switch (e.keyCode) {
        case 38: shiftFocus(-1); e.preventDefault(); break; // Up
        case 40: shiftFocus(+1); e.preventDefault(); break; // Down
        case 13: // OK / Enter — advance from any non-last input
          if (isInput && idx < list.length - 3) {
            shiftFocus(+1);
            e.preventDefault();
          }
          break;
        case 10009: // Tizen Back
          try { tizen.application.getCurrentApplication().exit(); } catch (_) {}
          e.preventDefault();
          break;
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var cfg = readForm(form);
      if (!cfg.host) {
        setStatus('error', 'Host is required.');
        form.host.focus();
        return;
      }
      runConnectionTest(cfg);
    });

    document.getElementById('tz-reset').addEventListener('click', function (e) {
      e.preventDefault();
      clearConfig();
      location.reload();
    });

    // TEMP: dev convenience — auto-fire Connect on first launch when
    // the form was pre-filled with our defaults. Saves a button press
    // on every reinstall. STRIP before any public release.
    if (!existing) {
      setTimeout(function () {
        setStatus('busy', 'Auto-connecting with dev defaults…');
        runConnectionTest(readForm(form));
      }, 250);
    }

    function runConnectionTest(cfg) {
      setBusy(true);
      setStatus('busy', 'Connecting to ' + cfg.host + ':' + cfg.port + '…');

      var url = 'http://' + cfg.host + ':' + cfg.port + '/jsonrpc';
      var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
      var timeoutId = setTimeout(function () {
        if (ctrl) ctrl.abort();
      }, 5000);

      // Use the original fetch — patches haven't been installed yet
      // (no-config branch returns before installing them), so this hits
      // Kodi exactly the way a vanilla fetch would.
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + btoa(cfg.username + ':' + cfg.password)
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'JSONRPC.Ping', id: 1 }),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) {
        clearTimeout(timeoutId);
        if (res.status === 200) {
          return res.json().then(function (body) {
            if (body && body.result === 'pong') {
              setStatus('ok', 'Connected. Loading TeX…');
              saveConfig(cfg);
              setTimeout(function () { location.reload(); }, 350);
            } else {
              setBusy(false);
              setStatus('error', 'Reached the server, but it does not look like Kodi (no pong).');
            }
          }, function () {
            setBusy(false);
            setStatus('error', 'Reached the server, but it returned a non-JSON response.');
          });
        }
        setBusy(false);
        if (res.status === 401) {
          setStatus('error', 'Authentication failed (401). Check the username and password.');
          form.username.focus();
        } else if (res.status === 403) {
          setStatus('error', 'Forbidden (403). Enable "Allow remote control via HTTP" in Kodi.');
        } else if (res.status === 404) {
          setStatus('error', 'Got 404 from /jsonrpc. Is this really a Kodi web server?');
        } else {
          setStatus('error', 'HTTP ' + res.status + ' from Kodi.');
        }
      }).catch(function (err) {
        clearTimeout(timeoutId);
        setBusy(false);
        var msg = String(err && err.message || err);
        if (msg.indexOf('aborted') >= 0 || msg.indexOf('timeout') >= 0) {
          setStatus('error', 'Timed out after 5s. Is the host reachable and Kodi running?');
        } else {
          setStatus('error', 'Network error: ' + msg);
        }
      });
    }

    function setBusy(busy) {
      var btn = document.getElementById('tz-save');
      btn.disabled = busy;
      btn.style.opacity = busy ? '.6' : '1';
      btn.textContent = busy ? 'Connecting…' : 'Connect';
    }

    function setStatus(kind, msg) {
      var colors = { busy: '#4ea1ff', ok: '#4ade80', error: '#ff8080', idle: '#4a5566' };
      var textColors = { busy: '#a8b3c2', ok: '#bbf7d0', error: '#ffd0d0', idle: '#a8b3c2' };
      document.getElementById('tz-status-dot').style.background = colors[kind] || colors.idle;
      var t = document.getElementById('tz-status-text');
      t.textContent = msg;
      t.style.color = textColors[kind] || textColors.idle;
    }
  }

  function readForm(form) {
    return {
      host: form.host.value.trim(),
      port: form.port.value.trim() || '8080',
      username: form.username.value,
      password: form.password.value,
      debug: form.debug ? form.debug.value.trim() : ''
    };
  }

  function section(title, topMargin) {
    return (
      '<div style="margin:' + (topMargin || '0') + ' 0 14px;font-size:12px;' +
      'letter-spacing:.12em;text-transform:uppercase;color:#7a8694;font-weight:600">' +
      title + '</div>'
    );
  }

  function field(name, label, value, type, placeholder) {
    var v = String(value).replace(/"/g, '&quot;');
    var p = String(placeholder).replace(/"/g, '&quot;');
    return (
      '<label style="display:block;margin:0 0 16px">' +
        '<span style="display:block;margin:0 0 7px;color:#d0d8e3;font-size:14px;font-weight:500">' + label + '</span>' +
        '<input name="' + name + '" type="' + type + '" value="' + v + '" placeholder="' + p + '" ' +
        'autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" ' +
        'style="width:100%;box-sizing:border-box;padding:14px 16px;font-size:20px;font-weight:500;' +
        'background:#0d1218;border:2px solid #2a3242;border-radius:10px;color:#ffffff;' +
        '-webkit-text-fill-color:#ffffff;caret-color:#4ea1ff;' +
        'outline:none;font-family:inherit;' +
        '-webkit-transition:border-color .15s,box-shadow .15s;transition:border-color .15s,box-shadow .15s">' +
      '</label>'
    );
  }

  function button(id, label, primary) {
    var bg, color, border, shadow;
    if (primary) {
      bg = 'linear-gradient(180deg,#4ea1ff 0%,#2e7dd7 100%)';
      color = '#fff';
      border = '#2e7dd7';
      shadow = '0 4px 12px rgba(78,161,255,.25)';
    } else {
      bg = '#1f2837';
      color = '#d0d8e3';
      border = '#2a3242';
      shadow = 'none';
    }
    return (
      '<button id="tz-' + id + '" type="' + (primary ? 'submit' : 'button') + '" ' +
      'style="padding:14px 32px;font-size:18px;font-weight:600;border:1px solid ' + border + ';' +
      'border-radius:10px;cursor:pointer;background:' + bg + ';color:' + color + ';' +
      'box-shadow:' + shadow + ';' +
      'font-family:inherit;-webkit-transition:transform .1s,box-shadow .15s;' +
      'transition:transform .1s,box-shadow .15s">' + label + '</button>'
    );
  }

  (function injectFocusCss() {
    var s = document.createElement('style');
    s.textContent = (
      '#tz-setup input:focus,#tz-setup button:focus{' +
        'outline:none !important;' +
        'border-color:#4ea1ff !important;' +
        'box-shadow:0 0 0 4px rgba(78,161,255,.35) !important' +
      '}' +
      '#tz-setup input::-webkit-input-placeholder{color:#c8d0db;opacity:1}' +
      '#tz-setup input:-ms-input-placeholder{color:#c8d0db;opacity:1}' +
      '#tz-setup input::-moz-placeholder{color:#c8d0db;opacity:1}' +
      '#tz-setup input::placeholder{color:#c8d0db;opacity:1}' +
      '#tz-setup button[disabled]{cursor:default;opacity:.65}' +
      '#tz-setup button:active{transform:translateY(1px)}'
    );
    document.head.appendChild(s);
  })();

  // Walk every <script type="text/x-tizen-deferred"> that build.sh
  // emitted and re-emit it as a real <script> in original document
  // order. This is what actually starts the upstream app — until this
  // runs, none of TeX's bundles have executed.
  function activateDeferredScripts() {
    var deferred = document.querySelectorAll('script[type="text/x-tizen-deferred"]');
    for (var i = 0; i < deferred.length; i++) {
      var old = deferred[i];
      var s = document.createElement('script');
      // Copy every attribute except `type` (which we want to clear so
      // the browser actually runs the script).
      for (var j = 0; j < old.attributes.length; j++) {
        var a = old.attributes[j];
        if (a.name === 'type') continue;
        s.setAttribute(a.name, a.value);
      }
      if (!old.src) s.textContent = old.textContent;
      old.parentNode.replaceChild(s, old);
    }
  }

  // Headless mode: secondary pages (currently just videoPlayer.html) set
  // window.TIZEN_SKIP_INDEX_BOOT = true before loading this script. In
  // that mode we wire the patches + URL helpers but skip the setup
  // screen and the deferred-script activation — those only belong on
  // index.html.
  var SKIP_INDEX_BOOT = !!window.TIZEN_SKIP_INDEX_BOOT;

  var cfg = loadConfig();
  if (!cfg || !cfg.host) {
    if (SKIP_INDEX_BOOT) {
      console.warn('[tizen-bootstrap] no config in headless mode; navigating to index');
      location.replace('index.html');
      return;
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        showSetupScreen(cfg);
      });
    } else {
      showSetupScreen(cfg);
    }
    return; // TeX scripts stay deferred until the user provides config.
  }

  // --- Config is present: wire everything up before activating TeX. ---

  // Debug WebSocket telemetry. When cfg.debug is set, open a WS to that
  // host and stream console output, errors, click events, and XHR/fetch
  // responses. Pair with tools/debug-server.py. Fire-and-forget — failed
  // connects retry on a timer; nothing breaks if the listener is down.
  var dbg = (function () {
    var noop = function () {};
    var sink = { send: noop, click: noop, net: noop };
    if (!cfg.debug) return sink;

    var url = String(cfg.debug);
    if (!/^wss?:\/\//i.test(url)) url = 'ws:' + (url.indexOf('//') === 0 ? '' : '//') + url;

    var ws = null;
    var queue = [];
    var WS = window.__TIZEN_OrigWebSocket || window.WebSocket;

    function open() {
      try {
        ws = new WS(url);
        ws.onopen = function () {
          send('hello', { ua: navigator.userAgent, url: location.href });
          while (queue.length) ws.send(queue.shift());
        };
        ws.onclose = function () { ws = null; setTimeout(open, 2000); };
        ws.onerror = function () { try { ws.close(); } catch (_) {} };
      } catch (e) {
        setTimeout(open, 2000);
      }
    }
    open();

    function send(type, data) {
      var msg;
      try {
        msg = JSON.stringify({ t: Date.now(), type: type, data: data });
      } catch (e) {
        msg = JSON.stringify({ t: Date.now(), type: type, data: '<unserialisable>' });
      }
      if (ws && ws.readyState === 1) {
        try { ws.send(msg); } catch (_) { queue.push(msg); }
      } else {
        if (queue.length < 500) queue.push(msg);
      }
    }

    function flatten(args) {
      var out = [];
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (a instanceof Error) out.push(a.stack || a.message);
        else if (a && typeof a === 'object') {
          try { out.push(JSON.parse(JSON.stringify(a))); }
          catch (_) { out.push(String(a)); }
        } else out.push(a);
      }
      return out;
    }

    ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
      var orig = console[level] ? console[level].bind(console) : function () {};
      console[level] = function () {
        try { send('console.' + level, flatten(arguments)); } catch (_) {}
        try { orig.apply(null, arguments); } catch (_) {}
      };
    });

    window.addEventListener('error', function (e) {
      send('error', {
        msg: e.message, src: e.filename, line: e.lineno, col: e.colno,
        stack: e.error && e.error.stack
      });
    });
    window.addEventListener('unhandledrejection', function (e) {
      send('unhandledrejection', {
        reason: String(e.reason && (e.reason.stack || e.reason.message || e.reason))
      });
    });

    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.tagName) return;
      send('click', {
        tag: t.tagName,
        id: t.id || '',
        cls: (t.className || '').toString().slice(0, 200),
        text: (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        x: e.clientX, y: e.clientY
      });
    }, true);

    return {
      send: send,
      net: function (kind, info) { send('net.' + kind, info); }
    };
  })();

  var KODI_HOST = 'http://' + cfg.host + ':' + cfg.port;
  var KODI_AUTH = 'Basic ' + btoa(cfg.username + ':' + cfg.password);

  window.TIZEN_KODI_HOST = KODI_HOST;
  window.TIZEN_KODI_AUTH = KODI_AUTH;
  window.TIZEN_KODI_USER = cfg.username;
  window.TIZEN_KODI_PASS = cfg.password;

  // True if the URL should be sent through resolveUrl — i.e. it's NOT
  // a genuine external http(s) URL with a real hostname.
  // Why this is permissive: TeX builds its JSON-RPC URL from
  // window.location.protocol on a file:// page, producing strings like
  // `file://:/jsonrpc?...` that are invalid for XHR. Older isLocalish
  // saw the `file://` prefix and decided "absolute, leave alone",
  // which left the broken URL to crash inside native XHR.open.
  function isLocalish(url) {
    if (!url) return false;
    // Real http(s) URL with a non-empty hostname starts with [a-z0-9]
    // (an IP, a name, or even a single letter). Anything else falls
    // through to resolveUrl.
    if (/^https?:\/\/[a-z0-9._-]/i.test(url)) return false;
    return true;
  }

  // Resolve a relative path (or a broken file://-derived URL) to an
  // absolute Kodi URL. Used by both XHR/fetch patches and exposed for
  // AVPlay.
  function resolveUrl(path) {
    if (!path) return path;

    // Kodi internal image:// scheme — wrap through /image/<encoded>.
    if (/^image:\/\//i.test(path)) {
      return KODI_HOST + '/image/' + encodeURIComponent(path);
    }

    // Has a scheme — could be a genuine http(s) URL, or a broken
    // derivation like `file://:/jsonrpc?...` (no host) or `http://:9090/`
    // (empty host). Strip scheme+authority and rebuild against KODI_HOST,
    // unless it's a normal external http(s) URL that we should leave alone.
    var m = path.match(/^([a-z]+):\/\/([^\/?#]*)([\/?#].*|$)/i);
    if (m) {
      var scheme = m[1].toLowerCase();
      var authority = m[2];
      var rest = m[3] || '/';
      if (rest === '' || (rest.charAt(0) !== '/' && rest.charAt(0) !== '?' && rest.charAt(0) !== '#')) {
        rest = '/' + rest;
      }
      // Genuine http(s) URL with a real host → leave alone.
      if ((scheme === 'http' || scheme === 'https') && /^[a-z0-9._-]/i.test(authority)) {
        return path;
      }
      // Otherwise (file://, http://:port, etc.) → treat as Kodi-relative.
      return KODI_HOST + rest;
    }

    // Relative path → prepend KODI_HOST.
    return KODI_HOST + (path.charAt(0) === '/' ? path : '/' + path);
  }
  window.TIZEN_RESOLVE_URL = resolveUrl;

  // --- Player.Open interception ---------------------------------------
  // Kodi web clients call Player.Open over JSON-RPC for every "play
  // this" action. Without intervention that routes playback to the Kodi
  // server's screen, not the TV running this app. We watch outgoing
  // JSON-RPC, swallow the Player.Open call, resolve the actual file
  // path (directly from item.file, or via Playlist.GetItems for playlist
  // plays), run Files.PrepareDownload to get a vfs/ URL, then navigate
  // the page to videoPlayer.html → AVPlay.
  //
  // This intentionally works at the wire level so it doesn't depend on
  // any upstream-app internals — it only depends on Kodi's JSON-RPC
  // contract.

  function extractCallsFromBody(body) {
    if (typeof body !== 'string' || !body) return null;
    var ch = body.charAt(0);
    if (ch !== '{' && ch !== '[') return null;
    try {
      var parsed = JSON.parse(body);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) { return null; }
  }

  function maybeInterceptPlayerOpen(body) {
    var calls = extractCallsFromBody(body);
    if (!calls) return false;
    for (var i = 0; i < calls.length; i++) {
      var c = calls[i];
      if (!c || c.method !== 'Player.Open') continue;
      var item = c.params && c.params.item;
      if (!item) continue;

      // Direct file: Player.Open({item:{file:"..."}})
      if (item.file) {
        try { dbg.send('localplay.intercept', { kind: 'file', file: item.file }); } catch (_) {}
        triggerLocalPlay(item.file);
        return true;
      }
      // Playlist play: Player.Open({item:{position, playlistid}}). This is
      // what both file *and* folder plays produce in Kodi. Look up the
      // playlist to find the actual file path.
      if (typeof item.playlistid === 'number') {
        var pos = typeof item.position === 'number' ? item.position : 0;
        try { dbg.send('localplay.intercept', { kind: 'playlist', pid: item.playlistid, pos: pos }); } catch (_) {}
        resolvePlaylistThenPlay(item.playlistid, pos);
        return true;
      }
      // Library item (movieid/episodeid/songid) — could be resolved via
      // VideoLibrary.GetMovieDetails etc. Not implemented yet. Falls
      // through to Kodi for now so playback isn't silently dropped.
      try { dbg.send('localplay.passthrough', { item: item }); } catch (_) {}
    }
    return false;
  }

  function resolvePlaylistThenPlay(playlistId, position) {
    var xhr = new OrigXHR();
    xhr.open('POST', KODI_HOST + '/jsonrpc');
    try { xhr.setRequestHeader('Authorization', KODI_AUTH); } catch (_) {}
    try { xhr.setRequestHeader('Content-Type', 'application/json'); } catch (_) {}
    xhr.onerror = function () {
      try { dbg.send('localplay.error', 'Playlist.GetItems network error'); } catch (_) {}
    };
    xhr.onload = function () {
      try {
        var resp = JSON.parse(xhr.responseText);
        var items = resp && resp.result && resp.result.items;
        if (!items || !items.length) {
          dbg.send('localplay.error', { msg: 'playlist empty', resp: resp });
          return;
        }
        var pick = items[position] || items[0];
        if (!pick || !pick.file) {
          dbg.send('localplay.error', { msg: 'no file in playlist entry', pos: position, items: items.length });
          return;
        }
        try { dbg.send('localplay.resolved', { from: 'playlist', file: pick.file }); } catch (_) {}
        triggerLocalPlay(pick.file);
      } catch (e) {
        try { dbg.send('localplay.error', { stage: 'parse', msg: e.message }); } catch (_) {}
      }
    };
    xhr.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'Playlist.GetItems',
      params: [playlistId, ['file']],
      id: 'tz-resolvepl-' + Date.now()
    }));
  }

  function triggerLocalPlay(file) {
    try { dbg.send('localplay.trigger', { file: file }); } catch (_) {}
    var xhr = new OrigXHR();
    xhr.open('POST', KODI_HOST + '/jsonrpc');
    try { xhr.setRequestHeader('Authorization', KODI_AUTH); } catch (_) {}
    try { xhr.setRequestHeader('Content-Type', 'application/json'); } catch (_) {}
    xhr.onerror = function () {
      try { dbg.send('localplay.error', 'PrepareDownload network error'); } catch (_) {}
    };
    xhr.onload = function () {
      try {
        var resp = JSON.parse(xhr.responseText);
        var path = resp && resp.result && resp.result.details && resp.result.details.path;
        if (!path) {
          dbg.send('localplay.error', { msg: 'PrepareDownload no path', resp: resp });
          return;
        }
        var qs = 'src=' + encodeURIComponent(path) + '&player=html5';
        try { dbg.send('localplay.navigate', 'videoPlayer.html?' + qs); } catch (_) {}
        window.location.href = 'videoPlayer.html?' + qs;
      } catch (e) {
        try { dbg.send('localplay.error', { msg: e.message, stack: e.stack }); } catch (_) {}
      }
    };
    xhr.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'Files.PrepareDownload',
      params: [file],
      id: 'tz-localplay-' + Date.now()
    }));
  }

  // --- XHR patch ---
  var OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    var xhr = new OrigXHR();
    var origOpen = xhr.open;
    var origSend = xhr.send;
    var _method, _url, _body;
    xhr.open = function (method, url) {
      var origUrl = url;
      if (isLocalish(url)) url = resolveUrl(url);
      _method = method; _url = url;
      var args = [method, url].concat(Array.prototype.slice.call(arguments, 2));
      var ret;
      try {
        ret = origOpen.apply(this, args);
      } catch (e) {
        // Surface the URL that the native XHR rejected — without this
        // we only see "Invalid URL" with no clue what URL was at fault.
        try {
          dbg.send('xhr.open.error', {
            method: method,
            origUrl: String(origUrl),
            resolvedUrl: String(url),
            msg: String((e && e.message) || e)
          });
        } catch (_) {}
        throw e;
      }
      try {
        this.setRequestHeader('Authorization', KODI_AUTH);
      } catch (e) { /* setRequestHeader can fail on certain states; ignore */ }
      return ret;
    };
    xhr.send = function (body) {
      _body = body;
      // Intercept Player.Open so the file plays on the TV via AVPlay
      // instead of on the Kodi server's screen. If we take over, don't
      // call origSend — videoPlayer.html navigation tears down this
      // page anyway, so the abandoned XHR doesn't matter.
      if (maybeInterceptPlayerOpen(body)) return;
      var self = this;
      this.addEventListener('loadend', function () {
        var snip = function (s) {
          if (s == null) return null;
          s = String(s);
          return s.length > 400 ? s.slice(0, 400) + '…[+' + (s.length - 400) + ']' : s;
        };
        dbg.net('xhr', {
          method: _method, url: _url, status: self.status,
          req: snip(_body),
          resp: snip(self.responseText)
        });
      });
      return origSend.apply(this, arguments);
    };
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // --- fetch patch ---
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      init = init || {};
      // Player.Open interception, fetch edition. Most JSON-RPC callers
      // pass body as a string in init; if so we can sniff and intercept
      // synchronously. Request-object bodies (ReadableStream) are not
      // sniffed — those would need a tee+async-read and so far haven't
      // shown up in practice.
      if (typeof init.body === 'string' && maybeInterceptPlayerOpen(init.body)) {
        // Return a never-resolving promise. We're about to navigate the
        // page; any awaiter is torn down before it cares.
        return new Promise(function () {});
      }
      var headers = new Headers(init.headers || {});
      if (!headers.has('Authorization')) headers.set('Authorization', KODI_AUTH);
      init.headers = headers;
      if (typeof input === 'string' && isLocalish(input)) {
        input = resolveUrl(input);
      } else if (input && typeof input.url === 'string' && isLocalish(input.url)) {
        input = new Request(resolveUrl(input.url), input);
      }
      return origFetch(input, init);
    };
  }

  // --- WebSocket patch ---
  // Kodi's port 9090 JSON-RPC channel is unauthenticated, so we only
  // rewrite host/port — no userinfo needed. Only same-origin / localhost
  // / own-host URLs are rewritten; external WS connections (e.g. our
  // debug log stream) pass through unchanged.
  if (typeof window.WebSocket === 'function') {
    var OrigWS = window.WebSocket;
    window.__TIZEN_OrigWebSocket = OrigWS;

    function isLocalWS(hostname) {
      return hostname === '' ||
             hostname === 'localhost' ||
             hostname === '127.0.0.1' ||
             hostname === location.hostname;
    }

    function PatchedWS(url, protocols) {
      // On Tizen the page is served as file:///, so when an upstream
      // app derives its WS URL from window.location parts, it ends up
      // with the page protocol AND an empty host. Observed in the
      // wild: ws://:9090/jsonrpc (location.protocol mapped http→ws but
      // location.hostname was empty) AND file://:9090/jsonrpc (raw
      // location.protocol passed through). Both are unparseable by
      // new URL() and rejected by new WebSocket(). Rewrite anything of
      // the form "<scheme>://:<port>" to "ws://<cfg.host>:<port>".
      url = String(url).replace(/^[a-z]+:\/\/:(\d)/i, 'ws://' + cfg.host + ':$1');
      try {
        var u = new URL(url, location.href);
        if (isLocalWS(u.hostname)) {
          u.protocol = 'ws:';
          u.hostname = cfg.host;
          if (!u.port || u.port === '0') u.port = '9090';
          url = u.toString();
        }
      } catch (e) { /* still malformed — pass through */ }
      return protocols ? new OrigWS(url, protocols) : new OrigWS(url);
    }
    PatchedWS.prototype = OrigWS.prototype;
    PatchedWS.CONNECTING = OrigWS.CONNECTING;
    PatchedWS.OPEN = OrigWS.OPEN;
    PatchedWS.CLOSING = OrigWS.CLOSING;
    PatchedWS.CLOSED = OrigWS.CLOSED;
    window.WebSocket = PatchedWS;
  }

  // --- Service Worker registration (best-effort) ---
  // file:// blocks SW registration on Tizen, but we register anyway in
  // case a future firmware allows it. The image-auth MutationObserver
  // below does the real work in practice.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('tizen-sw.js').then(function (reg) {
      function postCfg(worker) {
        if (worker) worker.postMessage({
          type: 'tizen-config',
          host: KODI_HOST,
          auth: KODI_AUTH
        });
      }
      postCfg(reg.active);
      postCfg(reg.waiting);
      postCfg(reg.installing);
      if (navigator.serviceWorker.controller) {
        postCfg(navigator.serviceWorker.controller);
      }
      reg.addEventListener('updatefound', function () {
        postCfg(reg.installing);
      });
    }).catch(function (err) {
      console.warn('[tizen-bootstrap] service worker registration failed:', err);
    });
  }

  // --- Image / fanart auth via DOM observation --------------------------
  // <img src> bypasses our XHR/fetch patches and SW doesn't run on
  // file://, so /image/... <img> requests would 404 against the .wgt's
  // own origin. Workaround: rewrite the src to a userinfo URL
  // (http://user:pass@host:port/image/...) — Tizen's WebKit honours
  // userinfo for subresource loads.
  //
  // CSS background-image: url(...) is NOT covered. If TeX uses that for
  // artwork we'll add a computed-style pass when the need shows up.
  (function installImageAuth() {
    if (typeof MutationObserver !== 'function') return;

    function rewrite(src) {
      if (!src) return src;
      if (/^(https?|data|blob|file):/i.test(src)) return src;
      var clean = src.charAt(0) === '/' ? src.slice(1) : src;
      if (clean.indexOf('image/') !== 0) return src;
      var u = encodeURIComponent(cfg.username || '');
      var p = encodeURIComponent(cfg.password || '');
      return 'http://' + u + ':' + p + '@' + cfg.host + ':' + cfg.port + '/' + clean;
    }

    function patchImg(img) {
      if (!img || img.tagName !== 'IMG') return;
      var src = img.getAttribute('src');
      var newSrc = rewrite(src);
      if (newSrc !== src) img.setAttribute('src', newSrc);
    }

    function patchSubtree(root) {
      if (!root || root.nodeType !== 1) return;
      if (root.tagName === 'IMG') {
        patchImg(root);
        return;
      }
      if (!root.querySelectorAll) return;
      var imgs = root.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) patchImg(imgs[i]);
    }

    function start() {
      patchSubtree(document.body);
      var obs = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === 'childList' && m.addedNodes) {
            for (var j = 0; j < m.addedNodes.length; j++) patchSubtree(m.addedNodes[j]);
          } else if (m.type === 'attributes' &&
                     m.attributeName === 'src' &&
                     m.target && m.target.tagName === 'IMG') {
            patchImg(m.target);
          }
        }
      });
      obs.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src']
      });
    }

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  })();

  // Headless mode: stop here. videoPlayer.html drives AVPlay itself,
  // including its own remote-key handling.
  if (SKIP_INDEX_BOOT) return;

  // --- TV remote keys + virtual mouse cursor ---------------------------
  // Tizen 5 doesn't ship spatial navigation for web apps, so we render
  // a real mouse pointer driven by the remote's arrow keys + OK. Most
  // upstream UIs are mouse-first; this re-uses every existing click
  // handler without any per-app DOM knowledge.

  function registerTVKeys() {
    if (typeof tizen === 'undefined' || !tizen.tvinputdevice) return;
    var keys = [
      'MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop',
      'MediaFastForward', 'MediaRewind',
      'MediaTrackPrevious', 'MediaTrackNext'
    ];
    keys.forEach(function (k) {
      try { tizen.tvinputdevice.registerKey(k); }
      catch (e) { /* unsupported on this firmware; ignore */ }
    });
  }
  registerTVKeys();

  // Cursor step is acceleration-based: first tap moves 24px, a held
  // tenth tap moves 24 + 12*10 = 144px. The streak resets if you pause
  // longer than REPEAT_WINDOW ms or change direction.
  var BASE_STEP     = 24;
  var STREAK_INC    = 12;
  var STREAK_CAP    = 10;
  var REPEAT_WINDOW = 250;
  var EDGE_PAD      = 12;

  var cursor = null;
  var cx = 0, cy = 0;
  var lastArrowKey = 0;
  var lastArrowTs = 0;
  var arrowStreak = 0;

  function getStep(key) {
    var now = Date.now();
    if (key === lastArrowKey && now - lastArrowTs < REPEAT_WINDOW) {
      arrowStreak = Math.min(arrowStreak + 1, STREAK_CAP);
    } else {
      arrowStreak = 0;
    }
    lastArrowKey = key;
    lastArrowTs = now;
    return BASE_STEP + arrowStreak * STREAK_INC;
  }

  function installCursor() {
    if (cursor) {
      attachCursor();
      return;
    }
    cursor = document.createElement('div');
    cursor.id = 'tz-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.style.cssText =
      'position:fixed;left:0;top:0;width:28px;height:28px;' +
      'pointer-events:none;z-index:2147483647;' +
      '-webkit-transform:translate3d(-100px,-100px,0);' +
      'transform:translate3d(-100px,-100px,0);' +
      'will-change:transform';
    cursor.innerHTML =
      '<svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" ' +
      'style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">' +
      '<path d="M4 3 L24 14 L15 15 L11 24 Z" fill="#ffffff" stroke="#000000" ' +
      'stroke-width="1.5" stroke-linejoin="round"/></svg>';
    attachCursor();

    cx = Math.round(window.innerWidth / 2);
    cy = Math.round(window.innerHeight / 2);
    setCursor(cx, cy);

    // SPA route changes / framework re-renders may wipe body children
    // and pull the cursor out of the DOM. Re-attach whenever that
    // happens.
    if (typeof MutationObserver === 'function') {
      var obs = new MutationObserver(function () {
        if (!cursor.parentNode) attachCursor();
      });
      obs.observe(document.body, { childList: true, subtree: false });
    }
  }

  function attachCursor() {
    if (cursor.parentNode !== document.body) {
      document.body.appendChild(cursor);
    }
  }

  function setCursor(x, y) {
    cx = Math.max(0, Math.min(window.innerWidth  - 4, x));
    cy = Math.max(0, Math.min(window.innerHeight - 4, y));
    var t = 'translate3d(' + cx + 'px,' + cy + 'px,0)';
    cursor.style.transform = t;
    cursor.style.webkitTransform = t;
    var under = document.elementFromPoint(cx, cy);
    if (under) {
      under.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, view: window,
        clientX: cx, clientY: cy, button: 0
      }));
    }
  }

  function moveCursor(dx, dy) {
    var nx = cx + dx;
    var ny = cy + dy;
    if (nx < EDGE_PAD)                           { window.scrollBy(dx, 0); nx = EDGE_PAD; }
    else if (nx > window.innerWidth  - EDGE_PAD) { window.scrollBy(dx, 0); nx = window.innerWidth  - EDGE_PAD; }
    if (ny < EDGE_PAD)                           { window.scrollBy(0, dy); ny = EDGE_PAD; }
    else if (ny > window.innerHeight - EDGE_PAD) { window.scrollBy(0, dy); ny = window.innerHeight - EDGE_PAD; }
    setCursor(nx, ny);
  }

  function clickAtCursor() {
    var target = document.elementFromPoint(cx, cy);
    if (!target) return;
    ['mousedown', 'mouseup', 'click'].forEach(function (type) {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: cx, clientY: cy, button: 0,
        detail: type === 'click' ? 1 : 0
      }));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installCursor);
  } else {
    installCursor();
  }

  // Capture-phase so the upstream app's bubble-phase keydown handlers
  // never see the arrows / OK / Back we consume.
  document.addEventListener('keydown', function (e) {
    switch (e.keyCode) {
      case 37: // ArrowLeft
        e.preventDefault(); e.stopImmediatePropagation();
        moveCursor(-getStep(37), 0);
        break;
      case 38: // ArrowUp
        e.preventDefault(); e.stopImmediatePropagation();
        moveCursor(0, -getStep(38));
        break;
      case 39: // ArrowRight
        e.preventDefault(); e.stopImmediatePropagation();
        moveCursor(getStep(39), 0);
        break;
      case 40: // ArrowDown
        e.preventDefault(); e.stopImmediatePropagation();
        moveCursor(0, getStep(40));
        break;
      case 13: // OK / Enter
        e.preventDefault(); e.stopImmediatePropagation();
        clickAtCursor();
        break;
      case 10009: // Tizen Back / Return
        e.preventDefault(); e.stopImmediatePropagation();
        if (location.hash && location.hash !== '#' && location.hash !== '#home') {
          history.back();
        } else {
          try {
            tizen.application.getCurrentApplication().exit();
          } catch (_) { /* not in Tizen WebView */ }
        }
        break;
    }
  }, true);

  // All patches are in place. Boot the upstream app.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', activateDeferredScripts);
  } else {
    activateDeferredScripts();
  }
})();
