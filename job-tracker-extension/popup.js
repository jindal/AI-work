// Popup: shows the state of the current tab's capture (the work runs in background.js).

const $ = (id) => document.getElementById(id);
const views = ["viewStart", "viewLoading", "viewReview", "viewDone", "viewSettings"];
const FIELD_MAP = { f_company: "company", f_role: "role", f_location: "location", f_date: "date_applied",
                    f_status: "status", f_source: "source", f_jobid: "job_id", f_notes: "notes",
                    f_priority: "priority", f_referrer: "referrer" };
let tab = null;
let settings = null;
let job = null;
const touched = new Set();

const jobKey = () => `job_${tab.id}`;
function show(view) { views.forEach((v) => $(v).classList.toggle("hidden", v !== view)); }
function clearError() { $("error").classList.add("hidden"); }
function showError(msg, extraBtn) {
  const el = $("error");
  el.textContent = msg;
  if (extraBtn) { el.appendChild(document.createElement("br")); el.appendChild(extraBtn); }
  el.classList.remove("hidden");
}
function button(text, onclick) { const b = document.createElement("button"); b.textContent = text; b.onclick = onclick; return b; }
function banner(text, isDup) {
  const b = $("banner"); b.textContent = text; b.classList.toggle("dup", !!isDup); b.classList.remove("hidden");
}

async function init() {
  settings = await getSettings();
  warmUp(settings);
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  $("openSettings").onclick = (e) => { e.preventDefault(); openSettings(); };
  setupSettings();
  $("noteBtn").onclick = startCapture;
  $("retryBtn").onclick = startCapture;
  $("saveBtn").onclick = () => save(false);
  $("openSheet").onclick = async (e) => {
    e.preventDefault();
    const { sheetLink } = await chrome.storage.local.get("sheetLink");
    if (sheetLink) chrome.tabs.create({ url: sheetLink });
  };

  // Remember what you typed, so the model never overwrites it and it survives closing the popup.
  for (const [id, field] of Object.entries(FIELD_MAP)) {
    $(id).addEventListener("input", () => {
      touched.add(id);
      chrome.runtime.sendMessage({ type: "edit", tabId: tab.id, field, value: $(id).value });
    });
  }

  if (!tab || !/^https?:/.test(tab.url || "")) {
    $("noteBtn").disabled = true;
    $("viewStart").querySelector(".hint").textContent = "Open a job page (http/https) to use this.";
    return;
  }

  const { logged = {} } = await chrome.storage.local.get("logged");
  const l = logged[normalizeUrl(tab.url)];
  if (l) banner(`Already logged on ${l.loggedOn}: ${l.role} at ${l.company}.`, true);

  if (!settings.sheetUrl) showError("One-time setup: add your Google Sheet web app URL.",
    button("Open settings", () => openSettings()));

  // Render this tab's current state and follow updates from the background worker.
  render((await chrome.storage.session.get(jobKey()))[jobKey()]);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[jobKey()]) render(changes[jobKey()].newValue);
  });
}

function startCapture() {
  clearError();
  touched.clear();
  show("viewLoading");
  $("loadingText").textContent = "Reading the page…";
  chrome.runtime.sendMessage({ type: "capture", tabId: tab.id, windowId: tab.windowId });
}

function render(j) {
  job = j;
  if (!$("viewSettings").classList.contains("hidden")) return; // don't jump away while you're in Settings
  // Ignore state left over from a different page in this tab.
  if (!j || (j.normUrl && j.normUrl !== normalizeUrl(tab.url) && j.status !== "saved")) return show("viewStart");

  if (j.status === "working") {
    show("viewLoading");
    $("loadingText").textContent = `Asking ${settings.textModel} (local)… You can switch tabs; it keeps going.`;
    return;
  }
  if (j.status === "error") {
    show("viewStart");
    return showError(j.message, /Settings/.test(j.message) ? button("Open settings", () => openSettings()) : null);
  }
  if (j.status === "saved") {
    $("doneText").textContent = `Logged ${j.role} at ${j.company}.`;
    return show("viewDone");
  }
  if (j.status === "ready") {
    fillForm(j);
    show("viewReview");
  }
}

function fillForm(j) {
  const f = { ...j.fields, source: j.source, status: "Applied", priority: "Medium", ...j.edits };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date_applied || "")) f.date_applied = todayISO();
  for (const [id, field] of Object.entries(FIELD_MAP)) {
    if (touched.has(id) || document.activeElement === $(id)) continue; // never overwrite what you're typing
    if (f[field] !== undefined) $(id).value = f[field];
  }
  $("appliedWarn").classList.toggle("hidden", !!f.applied_detected);
  $("roleWarn").classList.toggle("hidden", !f.role_not_on_page);
  $("meta").textContent = j.refining
    ? `Read from page in ${j.secs}s · ${settings.textModel} filling the gaps… (you can save now)`
    : `${j.model}${j.usedScreenshot ? " + screenshot" : ""} · ${j.secs}s · confidence: ${f.confidence || "?"}` +
      (j.modelError ? ` · model skipped: ${j.modelError}` : "");
}

async function save(force) {
  clearError();
  const row = {
    company: $("f_company").value.trim(),
    role: $("f_role").value.trim(),
    location: $("f_location").value.trim(),
    status: $("f_status").value,
    dateApplied: $("f_date").value,
    source: $("f_source").value,
    priority: $("f_priority").value,
    referrer: $("f_referrer").value.trim(),
    jobId: $("f_jobid").value.trim(),
    url: job?.normUrl || normalizeUrl(tab.url),
    notes: [$("f_jobid").value.trim() && `Job ID: ${$("f_jobid").value.trim()}`, $("f_notes").value.trim()].filter(Boolean).join(" · "),
    capturedBy: (job?.model || "manual") + (job?.usedScreenshot ? " +screenshot" : "")
  };
  if (!row.company || !row.role) return showError("Company and role are required.");

  $("saveBtn").disabled = true;
  $("saveBtn").textContent = "Saving…";
  const res = await chrome.runtime.sendMessage({ type: "save", tabId: tab.id, row, force });
  $("saveBtn").disabled = false;
  $("saveBtn").textContent = "Save to tracker";

  if (res?.status === "duplicate") {
    const e = res.existing;
    return showError(`Looks like a duplicate: "${e.role}" at ${e.company}, logged ${e.loggedOn} (row ${e.row}).`,
      button("Save anyway", () => save(true)));
  }
  if (res?.status === "error") {
    return showError(res.message, /Settings/.test(res.message) ? button("Open settings", () => openSettings()) : null);
  }
  // Success: the background worker sets status "saved" and render() shows the done view.
}


/* ───────────── Settings panel ───────────── */

const SETTING_FIELDS = ["ollamaUrl", "textModel", "visionModel", "sheetUrl", "token"];
let viewBeforeSettings = "viewStart";
const GOOGLE_EXEC = /https:\/\/script\.google\.com\/macros\/s\/[^/\s]+\/exec/;
const HOST_PORT = /^(?:https?:\/\/)?(localhost|127\.0\.0\.1|[\w.-]+):(\d+)/i;

async function openSettings() {
  viewBeforeSettings = views.find((v) => !$(v).classList.contains("hidden")) || "viewStart";
  const s = await getSettings();
  SETTING_FIELDS.forEach((f) => ($(f).value = s[f] || ""));
  $("autoSave").checked = !!s.autoSave;
  clearError();
  show("viewSettings");
}

function setStatus(id, text, ok) {
  $(id).textContent = text;
  $(id).className = "status " + (ok === true ? "ok" : ok === false ? "bad" : "");
}

// Read the form, repairing common paste mistakes (e.g. the Google link pasted into the Ollama box).
function readSettings() {
  const raw = $("ollamaUrl").value.trim();
  const g = raw.match(GOOGLE_EXEC);
  if (g && !$("sheetUrl").value.trim()) $("sheetUrl").value = g[0];
  const hp = raw.match(HOST_PORT);
  $("ollamaUrl").value = hp ? `http://${hp[1]}:${hp[2]}` : DEFAULT_SETTINGS.ollamaUrl;
  const sm = $("sheetUrl").value.trim().match(GOOGLE_EXEC);
  if (sm) $("sheetUrl").value = sm[0];

  const s = {};
  SETTING_FIELDS.forEach((f) => (s[f] = $(f).value.trim()));
  s.autoSave = $("autoSave").checked;
  return s;
}

function setupSettings() {
  $("closeSettings").onclick = async () => {
    show(viewBeforeSettings);
    render((await chrome.storage.session.get(jobKey()))[jobKey()]);
  };

  $("saveSettings").onclick = async () => {
    const s = readSettings();
    if (s.sheetUrl && !GOOGLE_EXEC.test(s.sheetUrl)) return setStatus("savedStatus", "Web app URL should look like https://script.google.com/macros/s/…/exec", false);
    await chrome.storage.sync.set(s);
    settings = { ...settings, ...s };
    setStatus("savedStatus", "Saved ✓", true);
    setTimeout(() => setStatus("savedStatus", ""), 2000);
  };

  $("testOllama").onclick = async () => {
    const s = readSettings();
    setStatus("ollamaStatus", "Checking…");
    try {
      const res = await fetch(`${s.ollamaUrl}/api/tags`);
      if (res.status === 403) throw new Error("Blocked: set OLLAMA_ORIGINS=chrome-extension://* and restart Ollama");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { models = [] } = await res.json();
      const names = models.map((m) => m.name);
      const wanted = [...new Set([s.textModel, s.visionModel])];
      const missing = wanted.filter((m) => !names.includes(m) && !names.includes(m + ":latest"));
      if (missing.length) setStatus("ollamaStatus", `Connected, but missing: ${missing.join(", ")}. Run: ollama pull ${missing[0]}`, false);
      else setStatus("ollamaStatus", `Connected ✓ Models ready: ${wanted.join(", ")}`, true);
    } catch (e) {
      setStatus("ollamaStatus", e.message.startsWith("Blocked") ? e.message : "Can't reach Ollama. Is it running? " + e.message, false);
    }
  };

  $("testSheet").onclick = async () => {
    setStatus("sheetStatus", "Checking…");
    try {
      const res = await postToSheet(readSettings(), { action: "ping" });
      if (res.sheetLink) await chrome.storage.local.set({ sheetLink: res.sheetLink });
      setStatus("sheetStatus", `Connected ✓ ${res.count} application(s) in "${res.sheetName}"`, true);
    } catch (e) {
      setStatus("sheetStatus", e.message, false);
    }
  };
}

init();
