/**
 * Applied Job Tracker → "Job Application Tracker – Ritika Jindal"
 * Writes into the existing "Applications" tab, in its own column layout.
 *
 * Paste into Extensions → Apps Script of THAT spreadsheet, then Deploy → Web app.
 *
 * Layout (row 1 = headers):
 *  A #  (formula, don't touch)   B Company   C Role   D Location   E Job Link   F Source (dropdown)
 *  G Referrer / Contact   H Date Applied   I Resume Version   J Status (dropdown)   K Last Update
 *  L Next Step   M Next Step Date   N Days Since Applied (formula)   O Days Since Update (formula)
 *  P Priority (dropdown)   Q Notes
 */

// Change this to any random string and paste the same value into the extension's Settings.
const TOKEN = 'change-me-to-a-random-string';
const SHEET_NAME = 'Applications';

const SOURCES = ['Referral', 'LinkedIn', 'Careers Site', 'Recruiter Reached Out', 'Naukri', 'Instahire / Other', 'Network'];
const STATUSES = ['Preparing', 'Referred', 'Applied', 'Assessment', 'Recruiter Screen', 'HM Interview',
                  'Interview Loop', 'Final Round', 'Offer', 'Rejected', 'Withdrawn', 'On Hold'];
const PRIORITIES = ['High', 'Medium', 'Low'];
const FORMULA_COLS = [1, 14, 15]; // A, N, O

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) return json({ status: 'error', message: 'Wrong token. Check Settings in the extension.' });

    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sh) return json({ status: 'error', message: 'No "' + SHEET_NAME + '" tab in this spreadsheet.' });

    if (body.action === 'ping') {
      return json({ status: 'ok', count: lastDataRow_(sh) - 1, sheetName: SHEET_NAME, sheetLink: sheetLink_(sh) });
    }

    if (body.action === 'add') {
      const r = body.row || {};
      if (!r.company || !r.role) return json({ status: 'error', message: 'Company and role are required.' });

      const lock = LockService.getScriptLock();
      lock.waitLock(10000);
      try {
        if (!body.force) {
          const dup = findDuplicate_(sh, r);
          if (dup) return json({ status: 'duplicate', existing: dup });
        }
        const row = lastDataRow_(sh) + 1;
        ensureRow_(sh, row);

        const today = new Date();
        const applied = r.dateApplied ? new Date(r.dateApplied + 'T00:00:00') : '';
        const notes = [r.notes, 'Logged via extension' + (r.capturedBy ? ' (' + r.capturedBy + ')' : '')].filter(String).join(' · ');

        // B..M (12 columns)
        sh.getRange(row, 2, 1, 12).setValues([[
          r.company,
          r.role,
          r.location || '',
          r.url || '',
          pick_(r.source, SOURCES, 'Careers Site'),
          r.referrer || '',
          applied,
          r.resumeVersion || '',
          pick_(r.status, STATUSES, 'Applied'),
          today,
          r.nextStep || 'Wait for recruiter',
          ''
        ]]);
        // P, Q
        sh.getRange(row, 16, 1, 2).setValues([[pick_(r.priority, PRIORITIES, 'Medium'), notes]]);
        sh.getRange(row, 8).setNumberFormat('dd-MMM-yy');
        sh.getRange(row, 11).setNumberFormat('dd-MMM-yy');

        return json({ status: 'ok', row: row, number: row - 1, sheetLink: sheetLink_(sh) + '&range=B' + row });
      } finally {
        lock.releaseLock();
      }
    }

    return json({ status: 'error', message: 'Unknown action' });
  } catch (err) {
    return json({ status: 'error', message: String(err) });
  }
}

function doGet() {
  return json({ status: 'ok', message: 'Applied Job Tracker endpoint is live. The extension uses POST.' });
}

// Last row with a Company (column B). Formula columns don't count as data.
function lastDataRow_(sh) {
  const n = sh.getMaxRows() - 1;
  if (n < 1) return 1;
  const vals = sh.getRange(2, 2, n, 1).getValues();
  for (let i = vals.length - 1; i >= 0; i--) if (String(vals[i][0]).trim() !== '') return i + 2;
  return 1;
}

// Make sure the target row exists and carries the A/N/O formulas (copied from the row above).
function ensureRow_(sh, row) {
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
  if (row <= 2) return;
  FORMULA_COLS.forEach(function (c) {
    const cell = sh.getRange(row, c);
    if (!cell.getFormula()) sh.getRange(row - 1, c).copyTo(cell); // relative refs shift automatically
  });
  // Copy dropdowns/date rules if this row has none.
  if (!sh.getRange(row, 10).getDataValidation()) {
    sh.getRange(row - 1, 1, 1, 17).copyTo(sh.getRange(row, 1, 1, 17), SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  }
}

function pick_(value, allowed, fallback) {
  const v = String(value || '').trim().toLowerCase();
  for (let i = 0; i < allowed.length; i++) if (allowed[i].toLowerCase() === v) return allowed[i];
  return fallback;
}

// Same link, or same company + role (ignoring case/punctuation).
function findDuplicate_(sh, r) {
  const last = lastDataRow_(sh);
  if (last < 2) return null;
  const data = sh.getRange(2, 1, last - 1, 17).getValues();
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const link = (s) => String(s || '').toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '');
  const url = link(r.url);
  const cr = key(r.company) + '|' + key(r.role);
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const sameUrl = url && link(row[4]) === url;
    const sameCR = key(row[1]) + '|' + key(row[2]) === cr;
    if (sameUrl || sameCR) {
      const d = row[7] instanceof Date ? Utilities.formatDate(row[7], Session.getScriptTimeZone(), 'dd-MMM-yy')
              : row[10] instanceof Date ? Utilities.formatDate(row[10], Session.getScriptTimeZone(), 'dd-MMM-yy') : 'earlier';
      return { row: i + 2, company: row[1], role: row[2], loggedOn: d, status: row[9] };
    }
  }
  return null;
}

function sheetLink_(sh) {
  return SpreadsheetApp.getActiveSpreadsheet().getUrl() + '#gid=' + sh.getSheetId();
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
