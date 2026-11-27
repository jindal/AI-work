# Applied Job Tracker (Chrome extension)

When a job page shows **"Applied"**, click the extension and then **Note**. A model running on your own laptop (through Ollama) reads the page and pulls out the company, role, location, job ID and date applied. You check the fields, and the extension saves a row to your Google Sheet tracker. It also warns you about duplicates.

The point is to keep a record of applications that never send a confirmation email.

## How it works

```
Job page ──► page text + structured JobPosting data ──► local LLM (Ollama, JSON schema output)
                 │                                         │ company/role missing or low confidence?
                 └──► screenshot (fallback only) ─────────►┘
                                                           ▼
                                      Review popup (you edit / confirm)
                                                           ▼
                                Google Apps Script web app ──► Google Sheet
                                (duplicate check: same URL or same company + role)
```

- **Text first, screenshot second.** Small open models read text better than images. Many applicant tracking systems (Greenhouse, Lever, Workday, company career sites) also embed schema.org `JobPosting` data, which is exact. The screenshot goes to the vision model only when that isn't enough.
- **Nothing leaves your machine** except the final row that goes to your own sheet.
- **Drafts survive.** If the popup closes before you save, your draft is still there when you reopen it.

## Setup (about 15 minutes, one time)

### 1. Install Ollama and download a model
1. Install Ollama from https://ollama.com/download.
2. Download a model in a terminal:
   ```bash
   ollama pull gemma3:4b      # ~3 GB, reads text and images, fine on 8 GB RAM
   ```
   If you have 16 GB of RAM or more, `gemma3:12b` is more accurate. To use it, change the model names in the extension's Settings.

### 2. Let the extension talk to Ollama
Ollama blocks browser extensions by default. Allow them like this:

- **macOS:**
  ```bash
  launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
  ```
  Then quit Ollama from the menu bar and open it again. This setting resets when you reboot; run the command again after a restart, or add it to a login script.
- **Windows:** Open Settings, search for "environment variables", and add a user variable named `OLLAMA_ORIGINS` with the value `chrome-extension://*`. Then quit Ollama from the system tray and open it again.
- **Linux:** Run `sudo systemctl edit ollama.service` and add:
  ```
  [Service]
  Environment="OLLAMA_ORIGINS=chrome-extension://*"
  ```
  Then run `sudo systemctl restart ollama`.

### 3. Connect the tracker sheet
`Code.gs` is set up for **"Job Application Tracker – Ritika Jindal"**, the **Applications** tab. It writes into the first empty row and leaves the formula columns (A #, N, O) alone. It uses the existing dropdown values for Source, Status and Priority. The Summary and Daily Log tabs pick up new rows automatically.

1. Open the tracker spreadsheet.
2. Open **Extensions → Apps Script**, delete the sample code and paste in everything from `apps-script/Code.gs`.
3. Change `TOKEN` at the top to any random string and save.
4. Click **Deploy → New deployment**, then the gear icon, then **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**. The token is what keeps other people out.
5. Click **Deploy**, approve the permissions, and copy the **Web app URL** (it ends in `/exec`).

> If you edit `Code.gs` later, go to **Deploy → Manage deployments → Edit**, choose **New version** and deploy. Otherwise the old code keeps running.

### 4. Load the extension
1. Go to `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this folder.
3. Pin the extension (puzzle icon, then the pin).
4. Open the extension's **Settings** (the ⚙︎ in the popup). Paste the web app URL and the token, then click **Test Ollama** and **Test sheet**. Both should show ✓. Click **Save settings**.

## Daily use
1. Open a job you've applied to.
2. Click the extension, then **Note this application**.
3. Check the fields, add any notes (for example, a referral), and click **Save to tracker**.

If you've already logged the job, the popup tells you as soon as it opens.

## Settings
| Setting | Default | Notes |
|---|---|---|
| Ollama URL | `http://localhost:11434` | |
| Text model | `gemma3:4b` | Any Ollama model |
| Vision model | `gemma3:4b` | Must accept images (gemma3, qwen2.5vl, llama3.2-vision …) |
| Auto-save | off | Saves without the review step when confidence is high and the job isn't a duplicate |

## Troubleshooting
| Message | Fix |
|---|---|
| "Ollama blocked the extension" | Repeat step 2, then restart Ollama |
| "Can't reach Ollama" | Open the Ollama app, or run `ollama serve` |
| "Model not found" | `ollama pull <model>` |
| The first extraction is slow | Normal: the model is loading into memory. Later calls take a few seconds |
| "Sheet replied with a web page" | Redeploy with access set to **Anyone** |
| "Wrong token" | The token in Settings must match `TOKEN` in Code.gs |

## What gets written (Applications tab)
B Company · C Role · D Location · E Job Link · F Source · G Referrer / Contact · H Date Applied · J Status · K Last Update (today) · L Next Step ("Wait for recruiter") · P Priority · Q Notes (includes the job ID and "Logged via extension")

## MVP success criteria
- Logging an application takes 2 clicks or fewer and under 10 seconds once the model is loaded
- Company and role are correct on at least 18 of 20 real pages (LinkedIn, Naukri, Workday, Greenhouse, Lever, career sites)
- Duplicates are caught 100% of the time (same URL, or same company + role)
- Nothing leaves the laptop except the row written to your sheet

## Roadmap (v2)
- Detect the "Applied" banner automatically and offer to log the job without a click
- Match entries against the email-based tracker
- Status updates and follow-up reminders
- An accuracy test set: 20 saved pages with known answers, scored against different models
