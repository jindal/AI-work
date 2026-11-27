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
