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
