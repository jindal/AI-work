const fields = ["ollamaUrl", "textModel", "visionModel", "sheetUrl", "token"];
const $ = (id) => document.getElementById(id);

// Auto-repair common paste mistakes, e.g. the Google link pasted into the Ollama box.
function repair() {
  const o = $("ollamaUrl"), sh = $("sheetUrl");
  const raw = o.value.trim();
  const g = raw.match(/https:\/\/script\.google\.com\/macros\/s\/[^/\s]+\/exec/);
  if (g && !sh.value.trim()) sh.value = g[0];
  const host = raw.match(/^(?:https?:\/\/)?(localhost|127\.0\.0\.1|[\w.-]+):(\d+)/i);
  o.value = host ? `http://${host[1]}:${host[2]}` : DEFAULT_SETTINGS.ollamaUrl;
  const sm = sh.value.trim().match(/https:\/\/script\.google\.com\/macros\/s\/[^/\s]+\/exec/);
  if (sm) sh.value = sm[0];
}

function read() {
  repair();
  const s = {};
  fields.forEach((f) => (s[f] = $(f).value.trim()));
  s.autoSave = $("autoSave").checked;
  return s;
}

function status(id, text, ok) {
  $(id).textContent = text;
  $(id).className = "status " + (ok === true ? "ok" : ok === false ? "bad" : "");
}

(async () => {
  const s = await getSettings();
  fields.forEach((f) => ($(f).value = s[f] || ""));
  $("autoSave").checked = !!s.autoSave;
})();

function validate(s) {
  if (!/^https?:\/\/[^/\s]+\/?$/.test(s.ollamaUrl) || /script\.google/.test(s.ollamaUrl))
    return "Ollama URL should be just http://localhost:11434 (the Google link goes in the Tracker section).";
  if (s.sheetUrl && !/^https:\/\/script\.google\.com\/macros\/s\/[^/\s]+\/exec$/.test(s.sheetUrl))
    return "Web app URL should look like https://script.google.com/macros/s/…/exec";
  return "";
}

$("save").onclick = async () => {
  const err = validate(read());
  if (err) return status("saved", err, false);
  await chrome.storage.sync.set(read());
  status("saved", "Saved ✓", true);
  setTimeout(() => status("saved", ""), 2000);
};

$("testOllama").onclick = async () => {
  const s = read();
  const err = validate({ ...s, sheetUrl: "" });
  if (err) return status("ollamaStatus", err, false);
  status("ollamaStatus", "Checking…");
  try {
    const res = await fetch(`${s.ollamaUrl.replace(/\/+$/, "")}/api/tags`);
    if (res.status === 403) throw new Error("Blocked: set OLLAMA_ORIGINS=chrome-extension://* and restart Ollama");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { models = [] } = await res.json();
    const names = models.map((m) => m.name);
    const has = (m) => names.includes(m) || names.includes(m + ":latest");
    const missing = [...new Set([s.textModel, s.visionModel])].filter((m) => !has(m));
    if (missing.length) status("ollamaStatus", `Connected, but missing: ${missing.join(", ")}. Run: ollama pull ${missing[0]}`, false);
    else status("ollamaStatus", `Connected ✓ Models ready: ${[...new Set([s.textModel, s.visionModel])].join(", ")}`, true);
  } catch (e) {
    status("ollamaStatus", e.message.startsWith("Blocked") ? e.message : "Can't reach Ollama. Is it running? " + e.message, false);
  }
};

$("testSheet").onclick = async () => {
  status("sheetStatus", "Checking…");
  try {
    const res = await postToSheet(read(), { action: "ping" });
    if (res.sheetLink) await chrome.storage.local.set({ sheetLink: res.sheetLink });
    status("sheetStatus", `Connected ✓ ${res.count} application(s) in "${res.sheetName}"`, true);
  } catch (e) {
    status("sheetStatus", e.message, false);
  }
};
