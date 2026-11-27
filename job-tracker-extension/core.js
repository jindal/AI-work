// Applied Job Tracker: all shared logic in one file.
// Loaded by popup.html as a normal script, and by Chrome as the background service worker.
// Sections: helpers · page reader · local model (Ollama) · Google Sheet · background worker.

/* ───────────── Helpers ───────────── */
// Shared helpers for popup and options pages.

const DEFAULT_SETTINGS = {
  ollamaUrl: "http://localhost:11434",
  textModel: "gemma3:4b",
  visionModel: "gemma3:4b",
  sheetUrl: "",       // Apps Script web app URL (ends in /exec)
  token: "",          // must match TOKEN in Code.gs
  autoSave: false     // save without review when the model is confident and it's not a duplicate
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const s = { ...DEFAULT_SETTINGS, ...stored };
  // Guard against a bad saved value (e.g. Google link stuck to the Ollama URL).
  const m = String(s.ollamaUrl).match(/^(?:https?:\/\/)?(localhost|127\.0\.0\.1|[\w.-]+):(\d+)/i);
  s.ollamaUrl = m ? `http://${m[1]}:${m[2]}` : DEFAULT_SETTINGS.ollamaUrl;
  return s;
}

// Strip tracking params so the same job always maps to the same URL.
// Keeps params that usually identify a job (jobId, gh_jid, req, ...).
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();

    // LinkedIn: collections/search pages carry the job in ?currentJobId=
    if (host.endsWith("linkedin.com")) {
      const id = u.searchParams.get("currentJobId") || (u.pathname.match(/\/jobs\/view\/(\d+)/) || [])[1];
      if (id) return `https://www.linkedin.com/jobs/view/${id}`;
    }

    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (/^(gh_jid|jobid|job_id|jid|reqid|req|id|job|requisitionid|pid)$/i.test(k)) keep.set(k, v);
    }
    const q = keep.toString();
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.hostname.toLowerCase()}${path}${q ? "?" + q : ""}`;
  } catch {
    return raw;
  }
}

function sourceFromUrl(raw) {
  let host = "";
  try { host = new URL(raw).hostname.toLowerCase(); } catch { return ""; }
  const known = [
    [/linkedin\.com$/, "LinkedIn"],
    [/naukri\.com$/, "Naukri"],
    [/myworkdayjobs\.com$|workday\.com$/, "Workday"],
    [/greenhouse\.io$/, "Greenhouse"],
    [/lever\.co$/, "Lever"],
    [/ashbyhq\.com$/, "Ashby"],
    [/smartrecruiters\.com$/, "SmartRecruiters"],
    [/instahyre\.com$/, "Instahyre"],
    [/iimjobs\.com$/, "iimjobs"],
    [/wellfound\.com$/, "Wellfound"],
    [/indeed\.(com|co\.in)$/, "Indeed"],
    [/amazon\.jobs$/, "Amazon Jobs"],
    [/foundit\.in$/, "foundit"],
    [/hirist\.(com|tech)$/, "Hirist"]
  ];
  for (const [re, name] of known) if (re.test(host)) return name;
  return host.replace(/^www\./, "");
}

// Map a site to the Source dropdown in the tracker sheet.
const SOURCE_OPTIONS = ["Referral", "LinkedIn", "Careers Site", "Recruiter Reached Out", "Naukri", "Instahire / Other", "Network"];
function sourceCategory(raw) {
  const s = sourceFromUrl(raw);
  if (s === "LinkedIn" || s === "Naukri") return s;
  if (["Instahyre", "iimjobs", "Wellfound", "Indeed", "foundit", "Hirist"].includes(s)) return "Instahire / Other";
  return "Careers Site"; // Workday, Greenhouse, Lever, company sites, …
}

// Best-guess company from the URL, e.g. careers.acme.com → Acme, jobs.lever.co/acme → Acme.
function companyFromUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return ""; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split("/").filter(Boolean)[0] || "";
  const nice = (s) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  if (/(^|\.)(lever\.co|greenhouse\.io|ashbyhq\.com|smartrecruiters\.com|workable\.com)$/.test(host)) return nice(seg);
  if (/linkedin\.com$|naukri\.com$|indeed\.|instahyre|iimjobs|wellfound|foundit|hirist/.test(host)) return "";
  const parts = host.split(".").filter((p) => !/^(www|careers?|jobs?|apply|hire|recruit|talent|wd\d+|in|co|com|io|ai|org|net)$/.test(p));
  // ATS on a subdomain: acme.myworkdayjobs.com, acme.darwinbox.in, acme.keka.com
  if (/(myworkdayjobs|darwinbox|keka|zohorecruit|freshteam|recruitee|bamboohr)\./.test(host)) return nice(parts[0] || "");
  return nice(parts[parts.length - 1] || "");
}

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function normKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* ───────────── Page reader (injected into the job page) ───────────── */
// Runs inside the job page (injected with chrome.scripting.executeScript).
// Must be self-contained: no references to anything outside this function.
function collectPageData() {
  const meta = (sel) => document.querySelector(sel)?.getAttribute("content") || "";

  // Structured data: many ATS pages (Greenhouse, Lever, Workday, career sites)
  // embed a schema.org JobPosting. When present it is exact, so we pass it as a hint.
  let jobPosting = null;
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const items = [].concat(data, data["@graph"] || []);
      const jp = items.find((x) => x && (x["@type"] === "JobPosting" || [].concat(x["@type"]).includes("JobPosting")));
      if (jp) {
        const loc = [].concat(jp.jobLocation || []).map((l) => {
          const a = l?.address || {};
          return [a.addressLocality, a.addressRegion, a.addressCountry?.name || a.addressCountry].filter(Boolean).join(", ");
        }).filter(Boolean).join(" | ");
        jobPosting = {
          title: jp.title || "",
          company: jp.hiringOrganization?.name || "",
          location: loc || (jp.jobLocationType === "TELECOMMUTE" ? "Remote" : ""),
          jobId: (typeof jp.identifier === "object" ? jp.identifier?.value : jp.identifier) || "",
          datePosted: jp.datePosted || ""
        };
        break;
      }
    } catch { /* ignore malformed JSON-LD */ }
  }

  // The job that is actually open. Job boards show lists and "similar jobs" next to it,
  // so read the open job's own header with known selectors per site.
  const pick = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      const t = el?.innerText?.trim();
      if (t && t.length < 200) return t.split("\n")[0].trim();
    }
    return "";
  };
  const selected = {
    title: pick([
      ".job-details-jobs-unified-top-card__job-title",          // LinkedIn
      ".jobs-unified-top-card__job-title",
      ".top-card-layout__title",                                 // LinkedIn (logged out)
      '[class*="jd-header-title"]',                              // Naukri
      '[data-automation-id="jobPostingHeader"]',                 // Workday
      ".posting-headline h2",                                    // Lever
      ".app-title", "#header h1", ".job__title h1"               // Greenhouse
    ]),
    heading: pick(['[class*="job-title" i] h1', 'h1[class*="title" i]', "h1"]), // hint only
    jobId: "",
    company: pick([
      ".job-details-jobs-unified-top-card__company-name",        // LinkedIn
      ".jobs-unified-top-card__company-name",
      ".topcard__org-name-link",
      '[class*="jd-header-comp-name"] a', '[class*="jd-header-comp-name"]', // Naukri
      ".company-name"
    ])
  };

  // "Thank you" / confirmation pages: "We have received your application for <Role>".
  const allText = document.body.innerText || "";
  if (!selected.title) {
    const m = allText.match(
      /(?:received your application for|your application for(?: the)?(?: position| role)?(?: of)?|you(?:'ve| have) (?:successfully )?applied for(?: the)?(?: position| role)?(?: of)?)\s*[:\-–]?\s*\n?\s*([^\n]{3,120})/i
    );
    if (m) selected.title = m[1].trim().replace(/^["'“]|["'”.!]+$/g, "").replace(/\s+(?:has been|was) (?:received|submitted).*$/i, "").trim();
  }
  const rid = allText.match(/(?:requisition|req|job)\s*(?:id|#|no\.?|number)\s*[:#]?\s*([A-Z0-9][A-Z0-9_-]{1,24})/i);
  if (rid) selected.jobId = rid[1];

  // Visible text, starting from the open job's details panel when we can find it.
  const main = document.querySelector(
    ".jobs-search__job-details, .jobs-details, .job-view-layout, [data-automation-id='jobPostingPage'], " +
    '[class*="jd-container"], main, [role=main], .job-details, #content'
  ) || document.body;
  let text = (main.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < 500) text = (document.body.innerText || "").replace(/\n{3,}/g, "\n\n").trim();

  // Find "applied" phrases anywhere on the page (e.g. LinkedIn "Applied 2 days ago").
  const bodyText = document.body.innerText || "";
  const appliedMatches = [...new Set(
    (bodyText.match(/[^\n]{0,60}\b(applied|application (was |has been )?(submitted|received|sent)|received your application|thank you for applying|you('ve| have) applied)\b[^\n]{0,60}/gi) || [])
      .map((s) => s.trim())
  )].slice(0, 5);

  return {
    url: location.href,
    title: document.title,
    ogTitle: meta('meta[property="og:title"]'),
    ogSite: meta('meta[property="og:site_name"]'),
    description: meta('meta[name="description"]').slice(0, 300),
    jobPosting,
    selected,
    appliedMatches,
    text: text.slice(0, jobPosting ? 3000 : 6000) // less text = faster; structured data needs little
  };
}

/* ───────────── Local model (Ollama) ───────────── */
// Talks to a local Ollama server. Text first; screenshot only as a fallback.

const JOB_SCHEMA = {
  type: "object",
  properties: {
    company: { type: "string" },
    role: { type: "string" },
    location: { type: "string" },
    job_id: { type: "string" },
    date_applied: { type: "string" },
    applied_detected: { type: "boolean" },
    confidence: { type: "string", enum: ["high", "medium", "low"] }
  },
  required: ["company", "role", "location", "job_id", "date_applied", "applied_detected", "confidence"]
};

const SYSTEM_PROMPT = `You extract job application details from a job posting page.
Return ONLY JSON matching the schema.
Rules:
- company: the HIRING company, never the job board (not "LinkedIn", "Naukri", "Workday", "Greenhouse", "Lever").
- role: the exact title of the ONE job that is open on the page. Pages often also list other jobs
  ("similar jobs", "people also viewed", search results). Ignore those. Prefer the OPEN JOB title if given.
- location: city/region and work mode if stated (e.g. "Bengaluru, Hybrid"). Empty string if unknown.
- job_id: requisition or job ID if visible, else "".
- date_applied: YYYY-MM-DD. Convert relative phrases like "Applied 3 days ago" using today's date. If the page shows no applied date, use "".
- applied_detected: true only if the page says the user has applied / application submitted.
- confidence: "high" if company and role are clearly stated, "medium" if inferred, "low" if guessing.
Never invent values. Use "" when unsure.`;

function buildUserPrompt(page) {
  const parts = [
    `Today's date: ${todayISO()}`,
    `URL: ${page.url}`,
    `Page title: ${page.title}`
  ];
  if (page.ogTitle) parts.push(`og:title: ${page.ogTitle}`);
  if (page.ogSite) parts.push(`og:site_name: ${page.ogSite}`);
  if (page.selected?.title) parts.push(`OPEN JOB title (from the page header, reliable): ${page.selected.title}`);
  if (page.selected?.company) parts.push(`OPEN JOB company (from the page header, reliable): ${page.selected.company}`);
  if (!page.selected?.title && page.selected?.heading) parts.push(`Main page heading (h1): ${page.selected.heading}`);
  if (page.jobPosting) parts.push(`Structured JobPosting data (reliable): ${JSON.stringify(page.jobPosting)}`);
  if (page.appliedMatches?.length) parts.push(`"Applied" phrases found on page: ${page.appliedMatches.join(" || ")}`);
  if (page.text) parts.push(`--- Page text (truncated) ---\n${page.text}`);
  return parts.join("\n");
}

async function callOllama(settings, model, userContent, imageBase64) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000); // first call can be slow while the model loads
  const message = { role: "user", content: userContent };
  if (imageBase64) message.images = [imageBase64];

  let res;
  try {
    res = await fetch(`${settings.ollamaUrl.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: "30m", // keep the model in memory between captures
        format: JOB_SCHEMA,
        options: { temperature: 0, num_predict: 200 }, // short JSON answer, cap output for speed
        messages: [{ role: "system", content: SYSTEM_PROMPT }, message]
      })
    });
  } catch (e) {
    throw new Error(e.name === "AbortError"
      ? "Ollama took too long. Is the model downloaded? Try again (the first run loads it into memory)."
      : "Can't reach Ollama. Make sure it's running and OLLAMA_ORIGINS allows the extension (see README).");
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 403) throw new Error("Ollama blocked the extension. Set OLLAMA_ORIGINS=chrome-extension://* and restart Ollama (see README).");
  if (res.status === 404) throw new Error(`Model "${model}" not found. Run: ollama pull ${model}`);
  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  try {
    return JSON.parse(data.message.content);
  } catch {
    throw new Error("Model returned something that isn't valid JSON. Try again or switch model in Settings.");
  }
}

// Load the model into memory as soon as the popup opens, so "Note" doesn't wait for it.
function warmUp(settings) {
  fetch(`${settings.ollamaUrl.replace(/\/+$/, "")}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: settings.textModel, keep_alive: "30m" })
  }).catch(() => {});
}

// Main entry: returns { fields, usedScreenshot, model }
async function extractJob(settings, page, getScreenshot) {
  const prompt = buildUserPrompt(page);
  const hasText = (page.text || "").length > 40 || page.jobPosting || page.selected?.title;

  let fields = null;
  let usedScreenshot = false;
  let model = settings.textModel;

  if (hasText) fields = await callOllama(settings, settings.textModel, prompt);
  const applySelected = (f) => {
    if (!f) return f;
    if (page.selected?.title) f.role = page.selected.title;
    if (page.selected?.company) f.company = page.selected.company;
    if (page.selected?.jobId && !f.job_id) f.job_id = page.selected.jobId;
    if (page.selected?.title && page.selected?.company) f.confidence = "high";
    // Hallucination guard: a role that isn't on the page can't be trusted.
    f.role_not_on_page = false;
    const onPage = (s) => !s || normKey(page.text + " " + page.title + " " + (page.ogTitle || "")).includes(normKey(s));
    if (!page.selected?.title && f.role && !onPage(f.role)) {
      f.confidence = "low";
      f.role_not_on_page = true;
    }
    return f;
  };
  fields = applySelected(fields);

  const weak = !fields || !fields.company || !fields.role || fields.confidence === "low";
  if (weak) {
    const img = await getScreenshot();
    if (img) {
      model = settings.visionModel;
      const visionFields = await callOllama(
        settings, settings.visionModel,
        prompt + "\n\nA screenshot of the visible page is attached. Read the company and title of the job shown in the large detail panel / page header, NOT jobs in side lists or search results.",
        img
      );
      usedScreenshot = true;
      // Keep any good text-derived values the screenshot pass missed.
      fields = fields ? mergeFields(fields, visionFields) : visionFields;
    }
  }

  // What the page header says beats the model (also after the screenshot pass).
  fields = applySelected(fields);

  // Structured data fills any gaps.
  if (page.jobPosting) {
    fields.company = fields.company || page.jobPosting.company;
    fields.role = fields.role || page.jobPosting.title;
    fields.location = fields.location || page.jobPosting.location;
    fields.job_id = fields.job_id || page.jobPosting.jobId;
  }
  return { fields, usedScreenshot, model };
}

function mergeFields(a, b) {
  const out = { ...b };
  for (const k of ["company", "role", "location", "job_id", "date_applied"]) out[k] = b[k] || a[k] || "";
  out.applied_detected = a.applied_detected || b.applied_detected;
  return out;
}

/* ───────────── Google Sheet ───────────── */
// Sends rows to the Google Apps Script web app attached to your tracker sheet.

async function postToSheet(settings, payload) {
  if (!settings.sheetUrl) throw new Error("Add your Google Sheet web app URL in Settings first.");
  let res;
  try {
    res = await fetch(settings.sheetUrl, {
      method: "POST",
      // text/plain keeps Apps Script happy (no CORS preflight); body is still JSON.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...payload, token: settings.token }),
      redirect: "follow"
    });
  } catch {
    throw new Error("Couldn't reach the Google Sheet. Check the web app URL in Settings.");
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error("The sheet replied with a web page instead of data. Redeploy the Apps Script with access set to \"Anyone\" (see README).");
  }
  if (data.status === "error") throw new Error(data.message || "Sheet error");
  return data; // { status: "ok" | "duplicate", ... }
}

/* ───────────── Background worker (service worker only) ───────────── */
if (typeof window === "undefined") {
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
}
