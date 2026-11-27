// Background worker: runs captures and saves per tab, so they keep going
// when the popup closes or you switch tabs. State lives in chrome.storage.session
// under "job_<tabId>"; the popup just renders it.

importScripts("common.js", "extract.js", "llm.js", "sheet.js");

const key = (tabId) => `job_${tabId}`;

async function getJob(tabId) {
  return (await chrome.storage.session.get(key(tabId)))[key(tabId)] || null;
}
async function setJob(tabId, job) {
  await chrome.storage.session.set({ [key(tabId)]: job });
  badge(tabId, job);
}
async function clearJob(tabId) {
  await chrome.storage.session.remove(key(tabId));
  badge(tabId, null);
}

function badge(tabId, job) {
  const text = !job ? "" : job.status === "working" ? "…" : job.status === "ready" ? (job.refining ? "…" : "✓") : job.status === "error" ? "!" : "";
  const color = job?.status === "error" ? "#cf222e" : job?.status === "ready" && !job.refining ? "#1a7f37" : "#1f6feb";
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(key(tabId)));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "capture") { capture(msg.tabId, msg.windowId); sendResponse({ ok: true }); }
  if (msg.type === "save") { save(msg.tabId, msg.row, msg.force).then(sendResponse); return true; }
  if (msg.type === "edit") { applyEdit(msg.tabId, msg.field, msg.value); }
  if (msg.type === "dismiss") { clearJob(msg.tabId); }
});

async function applyEdit(tabId, field, value) {
  const job = await getJob(tabId);
  if (!job) return;
  job.edits = { ...(job.edits || {}), [field]: value };
  await chrome.storage.session.set({ [key(tabId)]: job });
}

async function screenshot(windowId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 70 });
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1280 / bmp.width);
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
    const buf = new Uint8Array(await out.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  } catch {
    return null;
  }
}

// Fields we can read straight off the page with no model call.
function quickFields(page) {
  const jp = page.jobPosting || {};
  return {
    company: page.selected?.company || jp.company || companyFromUrl(page.url),
    role: page.selected?.title || jp.title || "",
    location: jp.location || "",
    job_id: page.selected?.jobId || jp.jobId || "",
    date_applied: todayISO(),
    applied_detected: (page.appliedMatches || []).length > 0,
    confidence: "medium"
  };
}

async function capture(tabId, windowId) {
  const settings = await getSettings();
  const t0 = Date.now();
  // Grab the screenshot right away, while this tab is still the visible one.
  const shot = screenshot(windowId);

  let page;
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: collectPageData });
    page = result;
  } catch (e) {
    return setJob(tabId, { status: "error", message: "Couldn't read this page: " + (e.message || e) });
  }

  const base = {
    url: page.url,
    normUrl: normalizeUrl(page.url),
    source: sourceCategory(page.url),
    edits: {}
  };

  // Instant result when the page itself tells us the role.
  const quick = quickFields(page);
  if (quick.role) {
    await setJob(tabId, { ...base, status: "ready", refining: true, fields: quick, model: "page", secs: ((Date.now() - t0) / 1000).toFixed(1) });
  } else {
    await setJob(tabId, { ...base, status: "working" });
  }

  try {
    const { fields, usedScreenshot, model } = await extractJob(settings, page, () => shot);
    const prev = (await getJob(tabId)) || {};
    // Model fills gaps; values read from the page stay.
    const merged = { ...fields };
    if (quick.role) for (const k of ["role", "job_id"]) if (quick[k]) merged[k] = quick[k];
    if (page.selected?.company || page.jobPosting?.company) merged.company = quick.company;
    if (!merged.company) merged.company = quick.company;
    await setJob(tabId, {
      ...base, edits: prev.edits || {}, status: "ready", refining: false,
      fields: merged, model, usedScreenshot, secs: ((Date.now() - t0) / 1000).toFixed(1)
    });

    if (settings.autoSave && merged.confidence === "high" && merged.company && merged.role) {
      const { logged = {} } = await chrome.storage.local.get("logged");
      if (!logged[base.normUrl]) await save(tabId, rowFrom(await getJob(tabId)), false);
    }
  } catch (e) {
    const prev = await getJob(tabId);
    if (prev?.status === "ready") {
      // Keep the instant result; just note the model couldn't refine it.
      await setJob(tabId, { ...prev, refining: false, modelError: e.message || String(e) });
    } else {
      await setJob(tabId, { ...base, status: "error", message: e.message || String(e) });
    }
  }
}

function rowFrom(job) {
  const f = { ...job.fields, ...job.edits };
  return {
    company: f.company || "", role: f.role || "", location: f.location || "",
    status: f.status || "Applied", dateApplied: f.date_applied || todayISO(),
    source: f.source ?? job.source ?? "Careers Site", priority: f.priority || "Medium", referrer: f.referrer || "",
    jobId: f.job_id || "", url: job.normUrl,
    notes: [f.job_id && `Job ID: ${f.job_id}`, f.notes].filter(Boolean).join(" · "), capturedBy: job.model + (job.usedScreenshot ? " +screenshot" : "")
  };
}

async function save(tabId, row, force) {
  const settings = await getSettings();
  try {
    const res = await postToSheet(settings, { action: "add", row, force });
    if (res.status === "duplicate") return res;

    const { logged = {} } = await chrome.storage.local.get("logged");
    logged[row.url] = { company: row.company, role: row.role, loggedOn: todayISO() };
    await chrome.storage.local.set({ logged, ...(res.sheetLink ? { sheetLink: res.sheetLink } : {}) });
    await setJob(tabId, { status: "saved", url: row.url, normUrl: row.url, company: row.company, role: row.role });
    setTimeout(() => clearJob(tabId), 4000);
    return res;
  } catch (e) {
    return { status: "error", message: e.message || String(e) };
  }
}
