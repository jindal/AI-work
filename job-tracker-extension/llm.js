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
