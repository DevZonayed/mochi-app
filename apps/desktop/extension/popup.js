// ---------- Bridge status ----------
async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "popup_status" });
  if (!res) return;
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  const takeOverBtn = document.getElementById("take-over-btn");
  if (res.status === "connected" && res.role === "active") {
    dot.className = "dot ok";
    text.textContent = "Active";
    takeOverBtn.style.display = "none";
  } else if (res.status === "connected" && res.role === "standby") {
    dot.className = "dot standby";
    text.textContent = "Standby";
    takeOverBtn.style.display = "block";
  } else {
    dot.className = "dot bad";
    text.textContent = "Disconnected";
    takeOverBtn.style.display = "none";
  }

  const count = res.sessionCount ?? 0;
  const sessionText = document.getElementById("session-text");
  if (count === 0) {
    sessionText.textContent = "none";
  } else {
    const tabs = (res.sessions ?? []).reduce((n, s) => n + s.tabCount, 0);
    sessionText.textContent = `${count} session${count > 1 ? "s" : ""}, ${tabs} tab${tabs !== 1 ? "s" : ""}`;
  }

  // Sync the auto-connect switch with state (only if user isn't actively toggling)
  const sw = document.getElementById("auto-connect-switch");
  if (sw && document.activeElement !== sw) sw.checked = !!res.connectionEnabled;

  const prof = document.getElementById("profile-name");
  if (prof) prof.textContent = res.profile || "Chrome";
  const portEl = document.getElementById("port-text");
  if (portEl && res.port) portEl.textContent = String(res.port);
  const portIn = document.getElementById("port-input");
  if (portIn && res.port && document.activeElement !== portIn) portIn.placeholder = String(res.port);
  const pairStatus = document.getElementById("pair-status");
  if (pairStatus && document.activeElement?.id !== "token-input") {
    pairStatus.textContent = res.paired
      ? (res.status === "connected" ? "Paired ✓ connected" : "Paired ✓ (waiting for the app…)")
      : "Not paired yet";
    pairStatus.className = "status" + (res.paired && res.status === "connected" ? " ok" : "");
  }
}

document.getElementById("take-over-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup_take_over" });
  refresh();
});

document.getElementById("toggle-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup_toggle" });
  refresh();
});
document.getElementById("auto-connect-switch").addEventListener("change", async () => {
  await chrome.runtime.sendMessage({ type: "popup_toggle" });
  refresh();
});

document.getElementById("end-session-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup_end_all_sessions" });
  refresh();
});

refresh();
setInterval(refresh, 1500);

// ---------- Projects + chats: send a message / comment ----------
const chatSelect = document.getElementById("chat-select");

async function refreshSnapshot() {
  let res;
  try { res = await chrome.runtime.sendMessage({ type: "popup_get_snapshot" }); }
  catch { return; }
  const projects = (res && Array.isArray(res.projects)) ? res.projects : [];

  // Don't yank the dropdown out from under the user mid-selection.
  if (document.activeElement === chatSelect) return;
  const prev = chatSelect.value;

  if (!res || !res.paired) {
    chatSelect.innerHTML = `<option value="" disabled selected>Pair this profile first</option>`;
    return;
  }
  if (projects.length === 0) {
    chatSelect.innerHTML = `<option value="" disabled selected>No projects yet</option>`;
    return;
  }
  chatSelect.innerHTML = "";
  for (const pr of projects) {
    const group = document.createElement("optgroup");
    group.label = pr.name || "Project";
    const fresh = document.createElement("option");
    fresh.value = `${pr.id}::`;
    fresh.textContent = "+ New chat";
    group.appendChild(fresh);
    for (const s of (pr.sessions || [])) {
      const opt = document.createElement("option");
      opt.value = `${pr.id}::${s.id}`;
      opt.textContent = (s.running ? "● " : "") + (s.title || "Chat");
      group.appendChild(opt);
    }
    chatSelect.appendChild(group);
  }
  if (prev && [...chatSelect.options].some((o) => o.value === prev)) chatSelect.value = prev;
}

refreshSnapshot();
setInterval(refreshSnapshot, 2000);

// ---------- Pairing ----------
document.getElementById("pair-btn").addEventListener("click", async () => {
  const input = document.getElementById("token-input");
  const portInput = document.getElementById("port-input");
  const status = document.getElementById("pair-status");
  const token = (input.value || "").trim();
  if (!token) { status.textContent = "Paste the token from the app first."; status.className = "status err"; return; }
  // Port is optional — blank keeps the current/default (9234). Set it only to
  // match a custom app port (Settings → Browser extension shows the live port).
  const portRaw = (portInput?.value || "").trim();
  const port = portRaw ? Number(portRaw) : undefined;
  if (portRaw && (!Number.isFinite(port) || port < 1 || port > 65535)) {
    status.textContent = "Port must be 1–65535 (blank = 9234)."; status.className = "status err"; return;
  }
  status.textContent = "Pairing…"; status.className = "status";
  try {
    const msg = { type: "popup_set_token", token };
    if (port) msg.port = port;
    const res = await chrome.runtime.sendMessage(msg);
    if (res?.ok) { input.value = ""; status.textContent = "Paired ✓"; status.className = "status ok"; }
    else { status.textContent = "Pairing failed."; status.className = "status err"; }
  } catch (e) { status.textContent = `Pairing failed: ${e?.message ?? e}`; status.className = "status err"; }
  refresh(); refreshSnapshot();
});

// ---------- Send a message / comment ----------
document.getElementById("send-btn").addEventListener("click", async () => {
  const status = document.getElementById("send-status");
  const msgEl = document.getElementById("msg-input");
  const val = chatSelect.value;
  const text = (msgEl.value || "").trim();
  if (!val) { status.textContent = "Pick a project or chat first."; status.className = "status err"; return; }
  if (!text) { status.textContent = "Type a message first."; status.className = "status err"; msgEl.focus(); return; }
  const sep = val.indexOf("::");
  const projectId = sep >= 0 ? val.slice(0, sep) : val;
  const sessionId = sep >= 0 ? val.slice(sep + 2) : "";
  status.textContent = "Sending…"; status.className = "status";
  const btn = document.getElementById("send-btn");
  btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "popup_send_message", projectId, sessionId: sessionId || null, text });
    if (res?.ok) { msgEl.value = ""; status.textContent = "Delivered to the chat."; status.className = "status ok"; }
    else { status.textContent = res?.error || "Send failed."; status.className = "status err"; }
  } catch (e) { status.textContent = `Send failed: ${e?.message ?? e}`; status.className = "status err"; }
  btn.disabled = false;
  refreshSnapshot();
});

// ---------- Comment on an element ----------
document.getElementById("comment-btn")?.addEventListener("click", async () => {
  const status = document.getElementById("send-status");
  if (status) { status.textContent = "Opening the element picker on the page…"; status.className = "status"; }
  try {
    const res = await chrome.runtime.sendMessage({ type: "popup_open_comment" });
    if (res?.ok) { window.close(); }
    else if (status) { status.textContent = res?.error || "Couldn't open commenting here."; status.className = "status err"; }
  } catch (e) { if (status) { status.textContent = `Couldn't open commenting here: ${e?.message ?? e}`; status.className = "status err"; } }
});

// ---------- Visuals settings ----------
async function loadVisuals() {
  const v = (await chrome.storage.local.get(["visualsDefault"])).visualsDefault
    ?? { enabled: true, cursor: true, hud: true, slowMo: 0 };
  document.getElementById("visuals-cursor").checked = !!v.cursor;
  document.getElementById("visuals-hud").checked = !!v.hud;
  document.getElementById("visuals-slowmo").value = String(v.slowMo ?? 0);
}

async function saveVisuals() {
  const v = {
    enabled: true,
    cursor: document.getElementById("visuals-cursor").checked,
    hud:    document.getElementById("visuals-hud").checked,
    slowMo: Math.max(0, Math.min(5000, Number(document.getElementById("visuals-slowmo").value) || 0)),
  };
  await chrome.storage.local.set({ visualsDefault: v });
}

["visuals-cursor","visuals-hud","visuals-slowmo"].forEach((id) => {
  document.getElementById(id).addEventListener("change", saveVisuals);
});

loadVisuals();
