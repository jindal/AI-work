// Popup: shows the state of the current tab's capture (the work runs in background.js).

const $ = (id) => document.getElementById(id);
const views = ["viewStart", "viewLoading", "viewReview", "viewDone"];
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

  $("openSettings").onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
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
    button("Open settings", () => chrome.runtime.openOptionsPage()));

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
  // Ignore state left over from a different page in this tab.
  if (!j || (j.normUrl && j.normUrl !== normalizeUrl(tab.url) && j.status !== "saved")) return show("viewStart");

  if (j.status === "working") {
    show("viewLoading");
    $("loadingText").textContent = `Asking ${settings.textModel} (local)… You can switch tabs; it keeps going.`;
    return;
  }
  if (j.status === "error") {
    show("viewStart");
    return showError(j.message, /Settings/.test(j.message) ? button("Open settings", () => chrome.runtime.openOptionsPage()) : null);
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
    return showError(res.message, /Settings/.test(res.message) ? button("Open settings", () => chrome.runtime.openOptionsPage()) : null);
  }
  // Success: the background worker sets status "saved" and render() shows the done view.
}

init();
