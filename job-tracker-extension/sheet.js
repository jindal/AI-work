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
