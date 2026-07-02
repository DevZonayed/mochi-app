// Super-Tester visual overlay. Injected via chrome.scripting.executeScript
// into every session tab after the debugger attaches. Renders an animated
// cursor + target ring + click ripple + HUD narration in a Shadow-DOM root
// that's pinned at the top of the stacking context and ignores pointer events.

(() => {
  if (window.__superTesterOverlayInstalled) return;
  window.__superTesterOverlayInstalled = true;

  let config = { enabled: true, cursor: true, hud: true, slowMo: 0 };
  let cursorPos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  let cursorVisible = false;

  // Host element pinned over the page; closed shadow root keeps the page's
  // CSS out and our DOM unreachable from page scripts.
  const host = document.createElement("div");
  host.id = "super-tester-overlay-host";
  Object.assign(host.style, {
    position: "fixed", inset: "0",
    pointerEvents: "none",
    zIndex: "2147483647",
  });
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host, * { box-sizing: border-box; }
    .cursor, .ring, .ripple, .hud { position: fixed; pointer-events: none; will-change: transform, opacity; }
    .cursor { width: 36px; height: 36px; left: 0; top: 0;
              transform: translate3d(0,0,0); z-index: 2147483646;
              opacity: 0; transition: opacity 180ms ease-out; }
    .cursor.show { opacity: 1; }
    .cursor svg { width: 100%; height: 100%; overflow: visible; }
    .ring { border: 3px solid #f0abfc; border-radius: 8px;
            box-shadow: 0 0 0 6px rgba(217,70,239,0.18), 0 0 18px rgba(217,70,239,0.35);
            opacity: 0; transition: opacity 200ms ease-out, transform 200ms ease-out; }
    .ring.fail { border-color: #ef4444; box-shadow: 0 0 0 6px rgba(239,68,68,0.20), 0 0 18px rgba(239,68,68,0.35); }
    .ripple { width: 40px; height: 40px; border-radius: 50%;
              background: radial-gradient(circle, rgba(244,114,182,0.55) 0%, rgba(217,70,239,0.0) 70%);
              opacity: 0; }
    .hud { top: 16px; left: 50%; transform: translateX(-50%);
           background: rgba(15,23,42,0.86); color: white;
           font: 13px/1.3 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
           padding: 10px 16px; border-radius: 999px;
           max-width: 70vw; white-space: nowrap;
           overflow: hidden; text-overflow: ellipsis;
           opacity: 0; transition: opacity 200ms ease-out; }
    .hud.show { opacity: 1; }
    .hud.fail { color: #fca5a5; }
  `;
  root.appendChild(style);

  const cursor = document.createElement("div");
  cursor.className = "cursor";
  // Neon pink arrow: gradient-filled glassy body with outer magenta glow.
  // Hotspot is at the SVG's (4,4) tip so visual position lines up with the click target.
  cursor.innerHTML = `
    <svg viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="stCursorFill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"  stop-color="#fbcfe8"/>
          <stop offset="55%" stop-color="#f472b6"/>
          <stop offset="100%" stop-color="#d946ef"/>
        </linearGradient>
        <filter id="stCursorGlow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.4" result="b1"/>
          <feGaussianBlur stdDeviation="5"   result="b2"/>
          <feMerge>
            <feMergeNode in="b2"/>
            <feMergeNode in="b1"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      <g filter="url(#stCursorGlow)">
        <path d="M4 4 L4 26 L11 21 L15 30 L19 28 L15 19 L25 19 Z"
              fill="url(#stCursorFill)"
              stroke="#fdf4ff" stroke-width="1.2" stroke-linejoin="round"
              stroke-opacity="0.85"/>
        <path d="M6 7 L6 14 L9 12 Z" fill="#fdf4ff" fill-opacity="0.55"/>
      </g>
    </svg>`;
  cursor.style.transform = `translate3d(${cursorPos.x}px, ${cursorPos.y}px, 0)`;
  root.appendChild(cursor);

  const ring = document.createElement("div");
  ring.className = "ring";
  root.appendChild(ring);

  const hud = document.createElement("div");
  hud.className = "hud";
  root.appendChild(hud);

  let hudHideTimer = null;
  function setHud(text, opts = {}) {
    if (!config.enabled || !config.hud) return;
    hud.textContent = text;
    hud.classList.toggle("fail", !!opts.fail);
    hud.classList.add("show");
    if (hudHideTimer) clearTimeout(hudHideTimer);
    // In slowMo mode the HUD stays up between actions; in fast mode it
    // auto-hides 1500ms after the last update.
    if (!config.slowMo || config.slowMo === 0) {
      hudHideTimer = setTimeout(() => hud.classList.remove("show"), 1500);
    }
  }

  function showRingAt(rect, opts = {}) {
    if (!config.enabled || !config.cursor) return;
    ring.classList.toggle("fail", !!opts.fail);
    Object.assign(ring.style, {
      left: `${rect.left - 2}px`,
      top: `${rect.top - 2}px`,
      width: `${rect.width + 4}px`,
      height: `${rect.height + 4}px`,
      transform: "scale(0.92)",
      opacity: "0",
    });
    // Force a reflow so the next style change animates.
    void ring.offsetWidth;
    ring.style.opacity = "1";
    ring.style.transform = "scale(1.0)";
    setTimeout(() => { ring.style.opacity = "0"; }, opts.fail ? 800 : 600);
  }

  function flashRippleAt(x, y) {
    if (!config.enabled || !config.cursor) return;
    const r = document.createElement("div");
    r.className = "ripple";
    r.style.left = `${x - 20}px`;
    r.style.top = `${y - 20}px`;
    root.appendChild(r);
    r.animate(
      [
        { transform: "scale(0.5)", opacity: 0.7 },
        { transform: "scale(3.0)", opacity: 0 },
      ],
      { duration: 300, easing: "ease-out", fill: "forwards" }
    ).finished.finally(() => r.remove());
  }

  let activeAnim = null;
  let cursorHideTimer = null;

  function showCursor() {
    if (!config.enabled || !config.cursor) return;
    if (cursorHideTimer) { clearTimeout(cursorHideTimer); cursorHideTimer = null; }
    if (!cursorVisible) {
      cursor.classList.add("show");
      cursorVisible = true;
    }
  }

  function hideCursorSoon(delayMs = 700) {
    if (cursorHideTimer) clearTimeout(cursorHideTimer);
    cursorHideTimer = setTimeout(() => {
      cursor.classList.remove("show");
      cursorVisible = false;
      cursorHideTimer = null;
    }, delayMs);
  }

  // Read the cursor's currently-rendered position so we can resume from there
  // when an animation gets cancelled mid-flight (avoids snapping).
  function currentCursorPos() {
    const m = new DOMMatrixReadOnly(getComputedStyle(cursor).transform);
    if (m.m41 === 0 && m.m42 === 0) return cursorPos;
    return { x: m.m41, y: m.m42 };
  }

  function animateCursorTo(x, y, durationMs) {
    const from = activeAnim ? currentCursorPos() : cursorPos;
    if (activeAnim) try { activeAnim.cancel(); } catch {}
    const to = { x, y };
    cursorPos = to;
    if (!config.enabled || !config.cursor) {
      cursor.style.transform = `translate3d(${to.x}px, ${to.y}px, 0)`;
      return Promise.resolve();
    }
    showCursor();
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    // Scale duration with distance so short hops feel snappy and long traverses
    // feel deliberate. Clamp so very small moves aren't instantaneous.
    const scaled = Math.min(Math.max(durationMs, distance * 1.2), durationMs + 600);
    const anim = cursor.animate(
      [
        { transform: `translate3d(${from.x}px, ${from.y}px, 0)` },
        { transform: `translate3d(${to.x}px, ${to.y}px, 0)` },
      ],
      {
        duration: Math.max(50, scaled),
        // Spring-ish curve: quick liftoff, gentle settle. ease-in-out for slowMo demos.
        easing: config.slowMo > 0 ? "ease-in-out" : "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "forwards",
      }
    );
    activeAnim = anim;
    return anim.finished.then(() => { activeAnim = null; }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.kind !== "string") return;
    if (msg.kind === "overlay.init") {
      config = { ...config, ...(msg.config ?? {}) };
      cursor.style.display = config.enabled && config.cursor ? "" : "none";
      if (!config.enabled || !config.cursor) {
        cursor.classList.remove("show");
        cursorVisible = false;
      }
      if (!config.enabled || !config.hud) hud.classList.remove("show");
      sendResponse({ ok: true });
      return;
    }
    if (msg.kind === "overlay.intent") {
      // Cursor visualization is gated on actual mouse coordinates — actions
      // without (x,y) (type/press/scroll/navigate) don't move the cursor and
      // don't make it visible, so the overlay isn't a stationary distraction.
      const hasCoords = (typeof msg.x === "number" && typeof msg.y === "number");
      const dur = config.slowMo > 0 ? Math.max(config.slowMo, 400) : 220;
      const moved = hasCoords ? animateCursorTo(msg.x, msg.y, dur) : Promise.resolve();
      if (msg.rect) showRingAt(msg.rect, { fail: false });
      if (typeof msg.text === "string") setHud(msg.text);
      moved.then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.kind === "overlay.result") {
      if (msg.ok === false && msg.rect) showRingAt(msg.rect, { fail: true });
      if (msg.ok !== false && msg.ripple && typeof msg.ripple.x === "number") {
        flashRippleAt(msg.ripple.x, msg.ripple.y);
      }
      if (typeof msg.text === "string") setHud(msg.text, { fail: msg.ok === false });
      // Fade the cursor out shortly after — it served its purpose for this action
      // and will fade back in on the next click. Slower fade in slowMo demos.
      if (cursorVisible) hideCursorSoon(config.slowMo > 0 ? Math.max(config.slowMo, 1000) : 700);
      sendResponse({ ok: true });
      return;
    }
    if (msg.kind === "overlay.hud") {
      if (typeof msg.text === "string") setHud(msg.text, { fail: !!msg.fail });
      sendResponse({ ok: true });
      return;
    }
  });
})();
