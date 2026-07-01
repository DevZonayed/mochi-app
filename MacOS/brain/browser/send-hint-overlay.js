// Mochi "Send hint" overlay — injected into every page of a project's Playwright
// browser. A discoverable FAB (and ⇧⌘M / ⇧⌃M) opens a modal where you pick a
// SESSION of the current project, compose a hint with inline element chips,
// toggle Include URL / console errors / screenshot, and SEND it straight into the
// CHOSEN existing chat (or a new one). Talks to the app via two Playwright
// bindings the BrowserManager exposes:
//   window.__mochiSnapshot()  -> { paired, projects:[{ id, name, sessions:[{id,title,running}] }] }
//   window.__mochiSend(payload) -> { ok, sessionId } | { ok:false, error }
// Ported from apps/desktop/extension/mochi-modal.js; transport + toggles rewired.
(() => {
  if (window.__mochiSendHintInstalled) return;
  window.__mochiSendHintInstalled = true;

  const FAB_ID = "mochi-fab-host-9d2f";
  const HOST_ID = "mochi-modal-host-9d2f7a1c";

  // ---------- FAB launcher ----------
  function mountFab() {
    if (document.getElementById(FAB_ID)) return;
    const fabHost = document.createElement("div");
    fabHost.id = FAB_ID;
    fabHost.style.cssText = "all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483646;";
    const fr = fabHost.attachShadow({ mode: "closed" });
    fr.innerHTML =
      "<style>.fab{all:initial;width:44px;height:44px;border-radius:50%;background:#1c1c1f;border:1px solid rgba(255,255,255,0.14);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35);transition:transform 100ms}.fab:hover{transform:scale(1.06)}</style>" +
      '<button class="fab" title="Send hint to Mochi (Shift+Cmd+M)" aria-label="Send hint to Mochi"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>';
    fr.querySelector(".fab").addEventListener("click", openModal);
    (document.body || document.documentElement).appendChild(fabHost);
  }

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "M" || e.key === "m")) { e.preventDefault(); openModal(); }
  }, true);

  // ---------- the Send hint modal ----------
  function openModal() {
    const existing = document.getElementById(HOST_ID);
    if (existing) { try { existing.shadowRoot && existing.shadowRoot.querySelector(".hint-editor").focus(); } catch (_) {} return; }

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: "closed" });

    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
        :host {
          --bg: #1c1c1f; --bg-subtle: rgba(255,255,255,0.05);
          --border: rgba(255,255,255,0.10); --border-strong: rgba(255,255,255,0.18);
          --text: #f5f5f7; --text-muted: #a1a1a6; --text-soft: #6e6e76;
          --primary: #3b82f6; --primary-fg: #fff; --primary-hover: #4d8ffb;
          --success: #22c55e; --danger: #f87171;
          --picked-bg: rgba(59,130,246,0.14); --picked-border: rgba(59,130,246,0.32); --picked-text: #93c5fd;
          --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 16px 32px -8px rgba(0,0,0,0.5), 0 6px 16px -2px rgba(0,0,0,0.3);
        }
        .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.50); opacity: 0; transition: opacity 180ms ease-out; pointer-events: auto; }
        .backdrop.shown { opacity: 1; }
        .backdrop.picker { background: transparent; pointer-events: none; }
        .modal { position: fixed; top: 80px; left: 50%; transform: translateX(-50%) translateY(-12px); width: min(520px, calc(100vw - 32px)); background: var(--bg); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow); overflow: hidden; opacity: 0; transition: opacity 180ms ease-out, transform 240ms cubic-bezier(0.16,1,0.3,1); pointer-events: auto; color: var(--text); }
        .modal.shown { opacity: 1; transform: translateX(-50%) translateY(0); }
        .modal.hidden-for-pick { opacity: 0; transform: translateX(-50%) translateY(-16px); pointer-events: none; transition: opacity 120ms ease-out, transform 160ms ease-out; }
        .titlebar { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
        .brand { display: flex; align-items: baseline; gap: 8px; }
        .brand .name { font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em; color: var(--text); }
        .brand .sub { font-size: 11.5px; font-weight: 500; color: var(--text-muted); }
        .icon-btn { appearance: none; border: none; background: transparent; width: 28px; height: 28px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; color: var(--text-muted); transition: background 100ms, color 100ms; }
        .icon-btn:hover { background: var(--bg-subtle); color: var(--text); }
        .body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 14px; }
        .field-label { font-size: 11px; font-weight: 500; color: var(--text-muted); letter-spacing: 0.02em; text-transform: uppercase; margin-bottom: 6px; }
        select { font-family: inherit; font-size: 13.5px; color: var(--text); background: var(--bg); width: 100%; border: 1px solid var(--border-strong); border-radius: 8px; padding: 8px 30px 8px 11px; appearance: none; cursor: pointer; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%238e8e94' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>"); background-repeat: no-repeat; background-position: right 11px center; background-size: 10px; }
        select:focus, .hint-editor:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(59,130,246,0.25); }
        .hint-editor { font-family: inherit; font-size: 13.5px; color: var(--text); background: var(--bg); border: 1px solid var(--border-strong); border-radius: 8px; padding: 9px 11px; min-height: 92px; line-height: 1.5; cursor: text; overflow-y: auto; max-height: 220px; outline: none; }
        .hint-editor:empty::before { content: attr(data-placeholder); color: var(--text-soft); pointer-events: none; }
        .ref-chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 5px 1px 7px; margin: 0 1px; background: var(--picked-bg); border: 1px solid var(--picked-border); border-radius: 5px; color: var(--picked-text); font-size: 11.5px; font-family: ui-monospace, "SF Mono", Menlo, monospace; vertical-align: baseline; user-select: none; white-space: nowrap; max-width: 200px; overflow: hidden; }
        .ref-chip .num { font-weight: 600; opacity: 0.85; }
        .ref-chip .tag { opacity: 0.95; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
        .ref-chip .rm { appearance: none; border: none; background: transparent; padding: 0 2px; cursor: pointer; color: inherit; opacity: 0.55; font-size: 12px; line-height: 1; display: inline-flex; align-items: center; }
        .ref-chip .rm:hover { opacity: 1; }
        .toggles { display: flex; flex-direction: column; gap: 2px; padding: 4px 0; }
        .toggle-row { display: flex; align-items: center; gap: 11px; padding: 7px 0; font-size: 13px; color: var(--text); }
        .toggle-row .label { flex: 1; display: flex; align-items: center; gap: 8px; }
        .toggle-row .label svg { color: var(--text-muted); flex-shrink: 0; }
        .switch { position: relative; display: inline-block; width: 32px; height: 20px; flex-shrink: 0; }
        .switch input { opacity: 0; width: 0; height: 0; }
        .switch .track { position: absolute; cursor: pointer; inset: 0; background: rgba(255,255,255,0.18); border-radius: 20px; transition: background 200ms cubic-bezier(0.16,1,0.3,1); }
        .switch .thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 1px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.15); transition: transform 200ms cubic-bezier(0.16,1,0.3,1); }
        .switch input:checked + .track { background: var(--success); }
        .switch input:checked + .track .thumb { transform: translateX(12px); }
        .actions { display: flex; gap: 8px; justify-content: space-between; align-items: center; border-top: 1px solid var(--border); margin-top: 2px; padding-top: 14px; }
        button.btn { appearance: none; border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); padding: 7px 13px; border-radius: 7px; cursor: pointer; font-family: inherit; font-size: 12.5px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; transition: background 100ms, transform 80ms; }
        button.btn:hover { background: var(--bg-subtle); }
        button.btn:active { transform: scale(0.98); }
        button.btn.primary { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }
        button.btn.primary:hover { background: var(--primary-hover); }
        button.btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }
        .status { font-size: 11.5px; color: var(--text-soft); min-height: 14px; margin-top: 8px; }
        .status.ok { color: var(--success); }
        .status.err { color: var(--danger); }
        .picker-info code { font-family: ui-monospace, "SF Mono", monospace; font-size: 11px; background: rgba(255,255,255,0.10); padding: 2px 6px; border-radius: 4px; }
      </style>
      <div class="backdrop"></div>
      <div class="modal" role="dialog" aria-label="Mochi send hint">
        <div class="titlebar">
          <div class="brand"><span class="name">Mochi</span><span class="sub">Send hint</span></div>
          <button class="icon-btn" id="m-close" title="Close (Esc)" aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="body">
          <div><div class="field-label">Session</div><select id="m-session"></select></div>
          <div><div class="field-label">Hint</div>
            <div id="m-text" class="hint-editor" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="What should the agent know? Press Pick element to inline-reference any element on the page."></div>
          </div>
          <div class="toggles">
            <div class="toggle-row"><div class="label"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span>Include current URL</span></div><label class="switch"><input type="checkbox" id="t-url" checked /><span class="track"><span class="thumb"></span></span></label></div>
            <div class="toggle-row"><div class="label"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span>Include recent console errors</span></div><label class="switch"><input type="checkbox" id="t-errors" checked /><span class="track"><span class="thumb"></span></span></label></div>
            <div class="toggle-row"><div class="label"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg><span>Include screenshot</span></div><label class="switch"><input type="checkbox" id="t-shot" /><span class="track"><span class="thumb"></span></span></label></div>
          </div>
          <div class="actions">
            <button class="btn" id="m-pick" title="Pick a DOM element to attach"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/></svg><span>Pick element</span></button>
            <button class="btn primary" id="m-send"><span>Send</span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
          </div>
          <div class="status" id="m-status"></div>
        </div>
      </div>`;

    const backdrop = root.querySelector(".backdrop");
    const modal = root.querySelector(".modal");
    const select = root.querySelector("#m-session");
    const editor = root.querySelector("#m-text");
    const tUrl = root.querySelector("#t-url");
    const tErrors = root.querySelector("#t-errors");
    const tShot = root.querySelector("#t-shot");
    const pickBtn = root.querySelector("#m-pick");
    const sendBtn = root.querySelector("#m-send");
    const closeBtn = root.querySelector("#m-close");
    const status = root.querySelector("#m-status");

    const pickedById = new Map();
    let chipCounter = 0;

    function setStatus(text, cls) { status.textContent = text; status.className = "status" + (cls ? " " + cls : ""); }
    function close() { backdrop.classList.remove("shown"); modal.classList.remove("shown"); setTimeout(() => { try { host.remove(); } catch (_) {} }, 220); }
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
    function renumberChips() { const chips = editor.querySelectorAll(".ref-chip"); for (let i = 0; i < chips.length; i++) { const n = chips[i].querySelector(".num"); if (n) n.textContent = "#" + (i + 1); } }
    function createChip(chipId, data) {
      const chip = document.createElement("span");
      chip.className = "ref-chip"; chip.contentEditable = "false"; chip.dataset.chipId = chipId; chip.title = data.selector;
      chip.innerHTML = '<span class="num">#1</span><span class="tag">' + escapeHtml(data.tagName || "el") + '</span><button class="rm" type="button" title="Remove">×</button>';
      chip.querySelector(".rm").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); pickedById.delete(chipId); chip.remove(); renumberChips(); editor.focus(); });
      return chip;
    }
    let savedRange = null;
    function saveCursor() { try { const sel = window.getSelection(); if (sel && sel.rangeCount > 0) { const r = sel.getRangeAt(0); if (editor.contains(r.startContainer) || editor === r.startContainer) { savedRange = r.cloneRange(); return; } } } catch (_) {} savedRange = null; }
    function insertChipAtSavedCursor(chip) {
      if (savedRange) { try { savedRange.deleteContents(); savedRange.insertNode(chip); const sp = document.createTextNode(" "); chip.after(sp); const sel = window.getSelection(); const nr = document.createRange(); nr.setStartAfter(sp); nr.collapse(true); sel.removeAllRanges(); sel.addRange(nr); savedRange = null; return; } catch (_) {} }
      editor.appendChild(chip); editor.appendChild(document.createTextNode(" "));
    }

    async function loadSessions() {
      let res; try { res = await window.__mochiSnapshot(); } catch (_) { res = null; }
      const projects = (res && Array.isArray(res.projects)) ? res.projects : [];
      if (projects.length === 0) { select.innerHTML = '<option value="" disabled selected>No sessions</option>'; setStatus("This project has no chats yet — pick “+ New chat” to start one.", ""); }
      select.innerHTML = "";
      for (const pr of projects) {
        const group = document.createElement("optgroup");
        group.label = pr.name || "Project";
        const fresh = document.createElement("option");
        fresh.value = pr.id + "::"; fresh.textContent = "+ New chat";
        group.appendChild(fresh);
        for (const s of (pr.sessions || [])) {
          const opt = document.createElement("option");
          opt.value = pr.id + "::" + s.id;
          opt.textContent = (s.running ? "● " : "") + (s.title || "Chat");
          group.appendChild(opt);
        }
        select.appendChild(group);
      }
      // Default to the most recent existing session (not "+ New chat") if there is one.
      const firstReal = select.querySelector('option[value*="::"]:not([value$="::"])');
      if (firstReal) select.value = firstReal.value;
      sendBtn.disabled = false;
    }

    function buildMessageAndPicks() {
      const elements = []; let text = "";
      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) { text += node.nodeValue; return; }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.classList && node.classList.contains("ref-chip")) { const d = pickedById.get(node.dataset.chipId); if (d) { elements.push(d); text += "[#" + elements.length + "]"; } return; }
        if (node.tagName === "BR") { text += "\n"; return; }
        for (const c of node.childNodes) walk(c);
        if (/^(DIV|P)$/.test(node.tagName)) text += "\n";
      };
      for (const c of editor.childNodes) walk(c);
      return { message: text.trim(), pickedElements: elements };
    }
    function nextPaint() { return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }

    async function send() {
      const val = select.value;
      const sep = val.indexOf("::");
      const sessionId = sep >= 0 ? val.slice(sep + 2) : "";
      const built = buildMessageAndPicks();
      if (!built.message) { setStatus("Type something first.", "err"); editor.focus(); return; }
      setStatus("Sending…"); sendBtn.disabled = true;
      const wantShot = tShot.checked;
      const fab = document.getElementById(FAB_ID);
      if (wantShot) { modal.style.visibility = "hidden"; backdrop.style.opacity = "0"; if (fab) fab.style.display = "none"; await nextPaint(); }
      let res;
      try {
        res = await window.__mochiSend({
          sessionId: sessionId || null,
          text: built.message,
          elements: built.pickedElements.map((e) => ({ selector: e.selector, tagName: e.tagName, text: e.text })),
          includeUrl: tUrl.checked, includeConsole: tErrors.checked, includeScreenshot: wantShot,
        });
      } catch (e) {
        if (wantShot) { modal.style.visibility = ""; backdrop.style.opacity = ""; if (fab) fab.style.display = ""; }
        setStatus("Send failed: " + (e && e.message ? e.message : e), "err"); sendBtn.disabled = false; return;
      }
      sendBtn.disabled = false;
      if (fab) fab.style.display = "";
      if (res && res.ok) { setStatus("Sent to the chat.", "ok"); setTimeout(close, 800); }
      else { modal.style.visibility = ""; backdrop.style.opacity = ""; setStatus((res && res.error) || "Send failed.", "err"); }
    }

    // ---- element picker ----
    let pickerOutline = null, pickerInfo = null, pickerActive = false;
    function startPicker() {
      if (pickerActive) return; pickerActive = true;
      modal.classList.add("hidden-for-pick"); backdrop.classList.add("picker");
      pickerOutline = document.createElement("div");
      pickerOutline.style.cssText = "position:fixed;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,0.10);border-radius:3px;z-index:2147483646;box-shadow:0 0 0 1px rgba(255,255,255,0.6),0 4px 12px rgba(0,0,0,0.18);transition:all 60ms ease-out;";
      document.documentElement.appendChild(pickerOutline);
      pickerInfo = document.createElement("div");
      pickerInfo.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:rgba(20,20,22,0.95);color:#fff;padding:8px 14px;border-radius:8px;font:12px -apple-system,system-ui;z-index:2147483647;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,0.25);";
      pickerInfo.innerHTML = "<span>Hover an element · click to pick · Esc to cancel</span>";
      document.documentElement.appendChild(pickerInfo);
      document.addEventListener("mousemove", onPickerMove, true);
      document.addEventListener("click", onPickerClick, true);
      document.addEventListener("keydown", onPickerKey, true);
    }
    function stopPicker() {
      pickerActive = false;
      document.removeEventListener("mousemove", onPickerMove, true);
      document.removeEventListener("click", onPickerClick, true);
      document.removeEventListener("keydown", onPickerKey, true);
      try { pickerOutline && pickerOutline.remove(); } catch (_) {}
      try { pickerInfo && pickerInfo.remove(); } catch (_) {}
      pickerOutline = null; pickerInfo = null;
      modal.classList.remove("hidden-for-pick"); backdrop.classList.remove("picker");
    }
    function onPickerMove(ev) {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!el || el === host || host.contains(el) || !pickerOutline) return;
      const r = el.getBoundingClientRect();
      pickerOutline.style.left = r.left + "px"; pickerOutline.style.top = r.top + "px";
      pickerOutline.style.width = r.width + "px"; pickerOutline.style.height = r.height + "px";
      if (pickerInfo) { const sel = uniqueSelector(el); pickerInfo.innerHTML = "<code>" + escapeHtml(sel.slice(0, 70)) + (sel.length > 70 ? "…" : "") + "</code>"; }
    }
    function onPickerClick(ev) {
      ev.preventDefault(); ev.stopPropagation();
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!el || el === host || host.contains(el)) { stopPicker(); return; }
      const data = serializeElement(el);
      const chipId = "c" + (++chipCounter);
      pickedById.set(chipId, data); stopPicker();
      const chip = createChip(chipId, data); insertChipAtSavedCursor(chip); renumberChips(); editor.focus();
    }
    function onPickerKey(ev) { if (ev.key === "Escape") { ev.preventDefault(); stopPicker(); } }
    function uniqueSelector(el) {
      if (!el || el.nodeType !== 1) return "";
      if (el.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id)) return "#" + el.id;
      const parts = []; let cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
        let part = cur.tagName.toLowerCase();
        if (cur.classList && cur.classList.length) { const cls = [].slice.call(cur.classList).slice(0, 2).map((c) => c.replace(/[^A-Za-z0-9_-]/g, "")).filter(Boolean).join("."); if (cls) part += "." + cls; }
        const parent = cur.parentElement;
        if (parent) { const sibs = [].slice.call(parent.children).filter((c) => c.tagName === cur.tagName); if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")"; }
        parts.unshift(part); cur = parent; if (parts.length >= 6) break;
      }
      return parts.join(" > ") || el.tagName.toLowerCase();
    }
    function serializeElement(el) {
      const text = (el.innerText || el.textContent || "").trim().slice(0, 300);
      return { selector: uniqueSelector(el), tagName: el.tagName.toLowerCase(), text };
    }

    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop && !pickerActive) close(); });
    pickBtn.addEventListener("click", () => { saveCursor(); startPicker(); });
    sendBtn.addEventListener("click", send);
    editor.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); } else if (e.key === "Escape" && !pickerActive) { e.preventDefault(); close(); } });
    editor.addEventListener("keyup", saveCursor); editor.addEventListener("mouseup", saveCursor); editor.addEventListener("blur", saveCursor);
    requestAnimationFrame(() => { backdrop.classList.add("shown"); modal.classList.add("shown"); editor.focus(); });
    loadSessions();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountFab); else mountFab();
})();
