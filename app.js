// Single-page app logic: tab switching + all page behaviour in one place,
// so nobody needs to jump between browser tabs to see the report while
// logging entries.

const AOC_LIST = ['G9', 'E5', '3L', '3O', '9P', '4P'];
const DELAY_REASON_TAGS = [
  { code: 'TECHNICAL', name: 'Technical / AOG' },
  { code: 'ATC', name: 'ATC / Slot' },
  { code: 'WEATHER', name: 'Weather' },
  { code: 'CREW', name: 'Crew' },
  { code: 'PAX_BAGGAGE', name: 'Pax & Baggage' },
  { code: 'GROUND_HANDLING', name: 'Ground Handling / Ramp' },
  { code: 'LATE_INBOUND', name: 'Late Inbound / Rotational' },
  { code: 'OPERATIONAL', name: 'Operational' },
  { code: 'OTHER', name: 'Other' },
];

let CURRENT_USER = null;

// ---------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------
function showTab(name) {
  document.querySelectorAll('.tab-section').forEach((s) => s.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  document.querySelector(`.tab-btn[data-tab="${name}"]`).classList.add('active');
  window.location.hash = name;

  if (name === 'dashboard') loadDashboard(document.getElementById('dashDate').value);
  if (name === 'report') loadRecentDelays();
  if (name === 'admin') loadUsers();
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });
  document.getElementById('logoutLink').addEventListener('click', async (e) => {
    e.preventDefault();
    await apiFetch('/api/logout', { method: 'POST' });
    window.location.href = 'login.html';
  });
  document.getElementById('dashGoEntryBtn').addEventListener('click', () => showTab('entry'));
}

// ---------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------
async function loadDashboard(date) {
  const { records } = await apiFetch(`/api/records?date=${date}`);
  const byCategory = {};
  let totalDelay = 0;
  records.forEach((r) => {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    totalDelay += r.delay_minutes || 0;
  });
  const tiles = [
    { label: 'Total Events', num: records.length, cls: 't-total' },
    { label: 'Delays', num: byCategory.DELAY || 0, cls: 't-delay' },
    { label: 'GTB', num: byCategory.GTB || 0, cls: 't-gtb' },
    { label: 'ATB', num: byCategory.ATB || 0, cls: 't-atb' },
    { label: 'Incidents', num: byCategory.INCIDENT || 0, cls: 't-incident' },
    { label: 'Diversions', num: byCategory.DIVERSION || 0, cls: 't-diversion' },
    { label: 'Total Delay (mins)', num: totalDelay, cls: 't-time' },
  ];
  document.getElementById('statTiles').innerHTML = tiles.map((t) => `
    <div class="stat-tile ${t.cls}"><div class="num">${t.num}</div><div class="lbl">${t.label}</div></div>
  `).join('');
  renderRecordsTable(records);
}

// Whether the logged-in user is allowed to edit/delete a given record.
// Mirrors the server-side checks in src/routes/records.js exactly, so the
// buttons shown here always match what the API will actually allow.
function canEditRecord(r) {
  if (!CURRENT_USER) return false;
  return CURRENT_USER.role !== 'shift_user' || r.entered_by_user_id === CURRENT_USER.id;
}
function canDeleteRecord() {
  return !!CURRENT_USER && (CURRENT_USER.role === 'duty_manager' || CURRENT_USER.role === 'admin');
}

function renderRecordsTable(records) {
  if (!records.length) {
    document.getElementById('recordsTable').innerHTML = '<p class="small">No records logged for this date yet.</p>';
    return;
  }
  const rows = records.map((r) => {
    const breakdownHtml = (r.breakdown && r.breakdown.length)
      ? '<br><span class="small">' + r.breakdown.map((b) => `${escapeHtml(b.reason_tag)}: ${b.minutes}m`).join(', ') + '</span>'
      : '';
    const actions = [
      canEditRecord(r) ? `<button type="button" class="small-btn ghost row-edit-btn" data-id="${r.id}">Edit</button>` : '',
      canDeleteRecord(r) ? `<button type="button" class="small-btn danger row-delete-btn" data-id="${r.id}">Delete</button>` : '',
    ].join('');
    return `
    <tr>
      <td><b>${escapeHtml(r.aoc)}</b></td>
      <td><span class="badge ${r.category}">${r.category}</span></td>
      <td>${escapeHtml(r.flight_number || '')}${r.flights_free_text ? `<div class="small" style="white-space:pre-wrap;">${escapeHtml(r.flights_free_text)}</div>` : ''}</td>
      <td>${escapeHtml(r.route || '')}</td>
      <td>${escapeHtml(r.registration || '')}</td>
      <td>${escapeHtml(r.reason)}</td>
      <td>${r.delay_minutes ? r.delay_minutes + ' min' : ''}${breakdownHtml}</td>
      <td>${escapeHtml(r.entered_by || '')}</td>
      <td class="row-actions">${actions || '<span class="small">—</span>'}</td>
    </tr>
  `;
  }).join('');
  document.getElementById('recordsTable').innerHTML = `
    <table>
      <thead><tr><th>AOC</th><th>Category</th><th>Flight</th><th>Route</th><th>Reg</th><th>Reason</th><th>Delay</th><th>Entered By</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ---------------------------------------------------------------
// Quick Paste – Notification Parser
// ---------------------------------------------------------------
const KNOWN_AOCS = AOC_LIST;

/**
 * Parse a pasted notification string into structured form fields.
 * Supports formats like:
 *   FLIGHT DELAY
 *   A6-ATA / G9 555 / SHJ - KHI
 *   DELAY DUE AIRCRAFT TECHNICAL
 *
 * Or single-line slash-separated:
 *   FLIGHT DELAY / A6-ATA / G9 555 / SHJ-KHI / DELAY DUE AIRCRAFT TECHNICAL
 *
 * Or multi-reason:
 *   FLIGHT DELAY
 *   A6-ATA / G9 555 / SHJ - KHI
 *   1. DELAY DUE AIRCRAFT TECHNICAL - 45 MINS
 *   2. LATE CREW ARRIVAL - 33 MINS
 */
function parseNotification(raw) {
  const result = {
    registration: '',
    aoc: '',
    flight_number: '',
    route: '',
    category: '',
    reason: '',
    delay_minutes: null,
    reasons: [],  // for multiple reasons
  };

  if (!raw || !raw.trim()) return result;

  // Normalize: join lines, then also work line-by-line
  const text = raw.trim();
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);

  // Flatten everything for token scanning
  const allText = lines.join(' / ');
  // Split into tokens by / or line breaks
  const tokens = allText.split(/[\/\n]/).map(t => t.trim()).filter(Boolean);

  // --- Registration: matches A6-XXX pattern (2-3 chars after dash)
  const regMatch = allText.match(/\b([A-Z]\d-[A-Z]{2,4})\b/i);
  if (regMatch) result.registration = regMatch[1].toUpperCase();

  // --- AOC + Flight Number: matches "G9 555" or "3L 828" or "3O828"
  for (const aoc of KNOWN_AOCS) {
    // Pattern: AOC followed by digits, optionally with space
    const aocRegex = new RegExp(`\\b(${aoc.replace(/([.*+?^${}()|[\\]\\\\])/g, '\\$1')})\\s*(\\d{1,5})\\b`, 'i');
    const m = allText.match(aocRegex);
    if (m) {
      result.aoc = aoc;
      result.flight_number = aoc + ' ' + m[2];
      break;
    }
  }

  // If AOC not found from flight number, try standalone AOC mention
  if (!result.aoc) {
    for (const aoc of KNOWN_AOCS) {
      if (allText.toUpperCase().includes(aoc)) {
        result.aoc = aoc;
        break;
      }
    }
  }

  // --- Route: 3-letter IATA codes separated by dash/space-dash-space/to
  // Look for patterns like SHJ - KHI, SHJ-KHI, CDG - RBA etc.
  const routeMatch = allText.match(/\b([A-Z]{3})\s*[-–—]\s*([A-Z]{3})\b/i);
  if (routeMatch) {
    result.route = routeMatch[1].toUpperCase() + '-' + routeMatch[2].toUpperCase();
  }

  // --- Category detection from keywords
  const upperText = allText.toUpperCase();
  if (/\bGROUND\s*TURN\s*BACK\b|\bGTB\b/.test(upperText)) {
    result.category = 'GTB';
  } else if (/\bAIR\s*TURN\s*BACK\b|\bATB\b/.test(upperText)) {
    result.category = 'ATB';
  } else if (/\bDIVERSION\b|\bDIVERTED\b/.test(upperText)) {
    result.category = 'DIVERSION';
  } else if (/\bINCIDENT\b/.test(upperText)) {
    result.category = 'INCIDENT';
  } else if (/\bDELAY\b|\bDELAYED\b/.test(upperText)) {
    result.category = 'DELAY';
  }

  // --- Delay minutes: look for standalone minutes mentions
  // Patterns: "78 MINS", "TOTAL DELAY 45 MINUTES", "DELAYED BY 120 MIN", "DELAY: 90 MINS"
  const delayMinsPatterns = [
    /TOTAL\s*DELAY\s*:?\s*(\d+)\s*(?:MINS?|MINUTES?)/i,
    /DELAY\s*(?:OF|BY|:)?\s*(\d+)\s*(?:MINS?|MINUTES?)/i,
    /DELAYED\s*(?:BY|FOR)?\s*(\d+)\s*(?:MINS?|MINUTES?)/i,
    /(\d+)\s*(?:MINS?|MINUTES?)\s*(?:DELAY|DELAYED)/i,
    /(?:^|\n|\/)\s*(\d+)\s*(?:MINS?|MINUTES?)\s*(?:$|\n|\/)/i,
  ];
  for (const pat of delayMinsPatterns) {
    const m = allText.match(pat);
    if (m) {
      result.delay_minutes = parseInt(m[1]);
      break;
    }
  }

  // --- Reason extraction
  // Check for numbered reasons (multi-reason format)
  // e.g. "1. DELAY DUE AIRCRAFT TECHNICAL - 45 MINS"
  const numberedReasons = [];
  for (const line of lines) {
    const numberedMatch = line.match(/^\d+[\.\)]\s*(.+)/);
    if (numberedMatch) {
      const reasonText = numberedMatch[1].trim();
      // Try to extract minutes (supports: "- 45 MINS", "45 mins DELAY...", "TECHNICAL 30 MIN")
      const minsMatch = reasonText.match(/(?:[-–—]\s*)?(\d+)\s*(?:MINS?|MINUTES?)\b/i);
      numberedReasons.push({
        text: minsMatch ? reasonText.replace(minsMatch[0], '').trim() : reasonText,
        minutes: minsMatch ? parseInt(minsMatch[1]) : null,
      });
    }
  }

  if (numberedReasons.length > 0) {
    result.reasons = numberedReasons;
    result.reason = numberedReasons.map(r => r.text + (r.minutes ? ` (${r.minutes} mins)` : '')).join('\n');
  } else {
    // Look for reason lines: lines that aren't the header/flight info
    const reasonCandidates = [];
    for (const line of lines) {
      const upper = line.toUpperCase();
      // Skip lines that are just category labels like "FLIGHT DELAY"
      if (/^FLIGHT\s+(DELAY|INCIDENT|GTB|ATB|DIVERSION)\s*$/i.test(line)) continue;
      // Skip lines that only contain registration/flight/route info we already parsed
      if (result.registration && line.toUpperCase().includes(result.registration)) {
        // This line has flight info — only use as reason if it also has reason keywords
        if (!/\bDUE\b|\bCAUSE|\bREASON|\bBECAUSE/i.test(line)) continue;
      }
      // Lines with reason keywords
      if (/\bDELAY\s*DUE\b|\bDUE\s*TO\b|\bCAUSED?\s*BY\b|\bREASON\b|\bTECHNICAL\b|\bWEATHER\b|\bCREW\b|\bAOG\b|\bDAMAGE\b|\bFAULT\b|\bDEFECT\b|\bMEDICAL\b|\bSECURITY\b|\bOPERATIONAL\b|\bPAX\b|\bBAGGAGE\b|\bRAMP\b|\bATC\b|\bSLOT\b|\bLATE\b|\bBIRD\s*STRIKE\b|\bFUEL\b|\bCATERING\b|\bGROUND\b|\bHANDLING\b|\bPUSH\s*BACK\b|\bENGINE\b|\bHYDRAULIC\b|\bTIRE\b|\bWHEEL\b|\bBRAKE\b|\bAPU\b|\bNAVIGATION\b|\bCOMMUNICATION\b|\bELECTRICAL\b|\bPNEUMATIC\b|\bSTRIKE\b|\bMISSING\b|\bOPS\b|\bLUGGAGE\b|\bPASSENGER\b/i.test(line)) {
        // Try to extract minutes (supports: "15 mins DELAY...", "- 45 MINS", "TECHNICAL 30 MIN")
        const minsMatch = line.match(/(?:[-–—]\s*)?(\d+)\s*(?:MINS?|MINUTES?)\b/i);
        reasonCandidates.push({
          text: minsMatch ? line.replace(minsMatch[0], '').trim() : line,
          minutes: minsMatch ? parseInt(minsMatch[1]) : null,
        });
      }
    }

    if (reasonCandidates.length > 1) {
      // Multiple reasons found → treat as breakdown
      result.reasons = reasonCandidates;
      result.reason = reasonCandidates.map(r => r.text + (r.minutes ? ` (${r.minutes} mins)` : '')).join('\n');
    } else if (reasonCandidates.length === 1) {
      result.reason = reasonCandidates[0].text;
      // A single reason line can carry its own minutes (e.g. "DELAY DUE
      // TECHNICAL - 45 MINS") even when no separate top-level "delay of X
      // mins" phrase exists — use it so delay_minutes isn't left blank.
      if (!result.delay_minutes && reasonCandidates[0].minutes) {
        result.delay_minutes = reasonCandidates[0].minutes;
      }
    }
  }

  return result;
}

// Fields on the Log Delay / Event form that Quick Paste attempts to
// extract a value for from the pasted notification text.
const QUICK_PASTE_PARSED_FIELD_IDS = ['registration', 'aoc', 'flight_number', 'route', 'category', 'reason', 'delay_minutes'];
// Fields Quick Paste never reads from the pasted text at all — flagged
// every time so the user remembers they still need to be set by hand.
const QUICK_PASTE_ALWAYS_MANUAL_FIELD_IDS = ['record_date', 'downstream_impact'];
// Everything Quick Paste's amber-flag behavior touches, combined.
const QUICK_PASTE_FIELD_IDS = [...QUICK_PASTE_PARSED_FIELD_IDS, ...QUICK_PASTE_ALWAYS_MANUAL_FIELD_IDS];

/**
 * Flag (or clear) a field as "could not be auto-filled from the pasted
 * text" — shown in amber so the user knows to check/fill it manually.
 */
function setFieldManualFlag(el, needsManual, message) {
  if (!el) return;
  const noteId = el.id ? el.id + '_manualNote' : null;
  let note = noteId ? document.getElementById(noteId) : null;
  if (needsManual) {
    el.classList.add('field-needs-manual');
    if (!note) {
      note = document.createElement('div');
      if (noteId) note.id = noteId;
      note.className = 'field-manual-note';
      note.textContent = message || 'Not auto-filled from paste — please check/enter manually';
      el.insertAdjacentElement('afterend', note);
    }
  } else {
    el.classList.remove('field-needs-manual');
    if (note) note.remove();
  }
}

function setFieldManualFlagById(id, needsManual, message) {
  setFieldManualFlag(document.getElementById(id), needsManual, message);
}

function clearAllQuickPasteManualFlags() {
  QUICK_PASTE_FIELD_IDS.forEach((id) => setFieldManualFlagById(id, false));
  document.querySelectorAll('#breakdownRows .breakdown-row').forEach((row) => {
    row.classList.remove('bd-needs-manual');
  });
}

function initQuickPaste() {
  const toggle = document.getElementById('quickPasteToggle');
  const body = document.getElementById('quickPasteBody');
  const chevron = document.getElementById('quickPasteChevron');
  const parseBtn = document.getElementById('quickParseBtn');
  const clearBtn = document.getElementById('quickClearBtn');
  const input = document.getElementById('quickPasteInput');
  const msgEl = document.getElementById('quickPasteMsg');

  // Toggle expand/collapse
  toggle.addEventListener('click', () => {
    body.classList.toggle('open');
    chevron.classList.toggle('open');
    if (body.classList.contains('open')) {
      setTimeout(() => input.focus(), 300);
    }
  });

  // Parse and fill
  parseBtn.addEventListener('click', () => {
    const raw = input.value;
    if (!raw.trim()) {
      msgEl.innerHTML = '<div class="quick-paste-parsed warning">⚠️ Paste a notification first.</div>';
      return;
    }

    const parsed = parseNotification(raw);
    const filled = [];
    const autoFilled = new Set(); // field ids the parser actually populated this run

    // Reset any manual flags from a previous parse before re-evaluating
    clearAllQuickPasteManualFlags();

    if (parsed.registration) {
      document.getElementById('registration').value = parsed.registration;
      filled.push(`Registration: <span class="parsed-field">${escapeHtml(parsed.registration)}</span>`);
      autoFilled.add('registration');
    }
    if (parsed.aoc) {
      document.getElementById('aoc').value = parsed.aoc;
      filled.push(`AOC: <span class="parsed-field">${escapeHtml(parsed.aoc)}</span>`);
      autoFilled.add('aoc');
    }
    if (parsed.flight_number) {
      document.getElementById('flight_number').value = parsed.flight_number;
      filled.push(`Flight: <span class="parsed-field">${escapeHtml(parsed.flight_number)}</span>`);
      autoFilled.add('flight_number');
    }
    if (parsed.route) {
      document.getElementById('route').value = parsed.route;
      filled.push(`Route: <span class="parsed-field">${escapeHtml(parsed.route)}</span>`);
      autoFilled.add('route');
    }
    if (parsed.category) {
      document.getElementById('category').value = parsed.category;
      filled.push(`Category: <span class="parsed-field">${parsed.category}</span>`);
      autoFilled.add('category');
    }
    if (parsed.reason) {
      document.getElementById('reason').value = parsed.reason;
      filled.push(`Reason: <span class="parsed-field">${escapeHtml(parsed.reason.substring(0, 80))}${parsed.reason.length > 80 ? '...' : ''}</span>`);
      autoFilled.add('reason');
    }

    // Handle multiple reasons → auto-enable breakdown
    if (parsed.reasons.length > 1) {
      const breakdownToggle = document.getElementById('breakdownToggle');
      if (!breakdownToggle.checked) {
        breakdownToggle.checked = true;
        breakdownToggle.dispatchEvent(new Event('change'));
      }
      // Clear existing breakdown rows
      document.getElementById('breakdownRows').innerHTML = '';
      // Add parsed reason rows
      for (const r of parsed.reasons) {
        addBreakdownRow();
        const rows = document.querySelectorAll('#breakdownRows .breakdown-row');
        const lastRow = rows[rows.length - 1];
        // Auto-detect reason tag using shared helper
        const matchedTag = detectReasonTag(r.text) || 'OTHER';
        lastRow.querySelector('.bd-tag').value = matchedTag;
        if (r.minutes) {
          lastRow.querySelector('.bd-minutes').value = r.minutes;
        } else {
          // Minutes for this specific reason couldn't be detected — flag it
          lastRow.classList.add('bd-needs-manual');
        }
        lastRow.querySelector('.bd-note').value = r.text;
      }
      recalcBreakdownTotal();
      // If no total delay was found in text, sum up breakdown minutes
      const breakdownTotal = recalcBreakdownTotal();
      if (!parsed.delay_minutes && breakdownTotal > 0) {
        parsed.delay_minutes = breakdownTotal;
      }
      filled.push(`Breakdown: <span class="parsed-field">${parsed.reasons.length} reasons auto-filled</span>`);
    }

    // Fill delay minutes AFTER breakdown (so summed minutes are also captured)
    if (parsed.delay_minutes) {
      document.getElementById('delay_minutes').value = parsed.delay_minutes;
      filled.push(`Delay: <span class="parsed-field">${parsed.delay_minutes} minutes</span>`);
      autoFilled.add('delay_minutes');
    }

    // The flight number is the source of truth for the AOC: if it carries a
    // known AOC prefix, the AOC is set (and locked) from it.
    if (syncAocFromFlight('flight_number', 'aoc', 'aocAutoHint')) autoFilled.add('aoc');

    // Any field Quick Paste is supposed to fill that it couldn't detect
    // this time gets flagged in amber so the user knows to fill it in by hand.
    const needsManual = [];
    QUICK_PASTE_PARSED_FIELD_IDS.forEach((id) => {
      if (!autoFilled.has(id)) {
        setFieldManualFlagById(id, true);
        needsManual.push(id);
      }
    });
    // These fields are never read from the pasted text — flag them too so
    // they aren't missed after a Quick Paste fill.
    QUICK_PASTE_ALWAYS_MANUAL_FIELD_IDS.forEach((id) => {
      setFieldManualFlagById(id, true, "Quick Paste doesn't read this from the notification — please set it manually");
      needsManual.push(id);
    });

    if (filled.length > 0) {
      msgEl.innerHTML = `<div class="quick-paste-parsed success">✅ Fields auto-filled:<br>${filled.join('<br>')}</div>`;
    } else {
      msgEl.innerHTML = '<div class="quick-paste-parsed warning">⚠️ Could not detect any fields. Try pasting a different format or fill the form manually.</div>';
    }
    if (needsManual.length > 0) {
      msgEl.innerHTML += `<div class="quick-paste-parsed warning">⚠️ Highlighted in amber — could not auto-fill, please check/enter manually.</div>`;
    }
  });

  // Clear — reset paste box AND all form fields
  clearBtn.addEventListener('click', () => {
    input.value = '';
    msgEl.innerHTML = '';
    // Reset all auto-filled form fields
    document.getElementById('flight_number').value = '';
    document.getElementById('route').value = '';
    document.getElementById('registration').value = '';
    document.getElementById('aoc').value = 'G9';
    syncAocFromFlight('flight_number', 'aoc', 'aocAutoHint');
    document.getElementById('category').value = 'DELAY';
    document.getElementById('reason').value = '';
    document.getElementById('delay_minutes').value = '';
    document.getElementById('downstream_impact').value = '';
    // Reset breakdown
    const breakdownToggle = document.getElementById('breakdownToggle');
    if (breakdownToggle.checked) {
      breakdownToggle.checked = false;
      breakdownToggle.dispatchEvent(new Event('change'));
    }
    document.getElementById('breakdownRows').innerHTML = '';
    recalcBreakdownTotal();
    clearAllQuickPasteManualFlags();
    input.focus();
  });

  // Once the user manually edits/confirms a field, the amber "needs manual
  // entry" flag no longer applies — clear it as soon as they touch it.
  QUICK_PASTE_FIELD_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    ['input', 'change'].forEach((evt) => {
      el.addEventListener(evt, () => setFieldManualFlag(el, false));
    });
  });

  // Same for individual breakdown-row minutes, including rows added later.
  document.getElementById('breakdownRows').addEventListener('input', (e) => {
    if (e.target.classList.contains('bd-minutes')) {
      const row = e.target.closest('.breakdown-row');
      if (row) row.classList.remove('bd-needs-manual');
    }
  });
}

// ---------------------------------------------------------------
// Entry (with delay breakdown)
// ---------------------------------------------------------------
function breakdownRowTemplate() {
  const options = DELAY_REASON_TAGS.map((t) => `<option value="${t.code}">${t.name}</option>`).join('');
  return `
    <div class="breakdown-row">
      <select class="bd-tag">${options}</select>
      <input type="number" min="0" class="bd-minutes" placeholder="Minutes">
      <input type="text" class="bd-note" placeholder="Optional short note (e.g. flight/notes)">
      <button type="button" class="bd-remove" title="Remove">&times;</button>
    </div>
  `;
}

// rowsContainerId/totalElId let this be reused for the edit-record modal's
// own breakdown rows (see initEditRecordModal) without touching the
// Log Delay / Event form's behavior — defaults keep that form unchanged.
function recalcBreakdownTotal(rowsContainerId, totalElId) {
  rowsContainerId = rowsContainerId || 'breakdownRows';
  totalElId = totalElId || 'breakdownTotal';
  const rows = document.querySelectorAll(`#${rowsContainerId} .breakdown-row`);
  let total = 0;
  rows.forEach((row) => { total += Number(row.querySelector('.bd-minutes').value) || 0; });
  const totalEl = document.getElementById(totalElId);
  totalEl.textContent = `Total delay from breakdown: ${total} minutes`;
  return total;
}

// Auto-detect reason tag from description text
function detectReasonTag(text) {
  const upper = (text || '').toUpperCase();
  if (/TECHNICAL|AOG|DEFECT|DAMAGE|FAULT|MECHANICAL|ENGINE|HYDRAULIC|TIRE|WHEEL|BRAKE|APU|ELECTRICAL|PNEUMATIC/i.test(upper)) return 'TECHNICAL';
  if (/ATC|SLOT/i.test(upper)) return 'ATC';
  if (/WEATHER|WIND|STORM|FOG|RAIN|SNOW|THUNDER|VISIBILITY/i.test(upper)) return 'WEATHER';
  if (/CREW|PILOT|CAPTAIN|FIRST\s*OFFICER|CABIN\s*CREW/i.test(upper)) return 'CREW';
  if (/PAX|PASSENGER|BAGGAGE|BAG|LUGGAGE|BOARDING/i.test(upper)) return 'PAX_BAGGAGE';
  if (/GROUND|RAMP|HANDLING|PUSH\s*BACK|CATERING|FUEL|OPS\s*STRIKE|GROUND\s*OPS/i.test(upper)) return 'GROUND_HANDLING';
  if (/LATE\s*INBOUND|ROTATIONAL|LATE\s*ARRIVAL|LATE\s*INCOMING/i.test(upper)) return 'LATE_INBOUND';
  if (/OPERATIONAL|OPS|COMMERCIAL/i.test(upper)) return 'OPERATIONAL';
  return null; // no match — don't change the dropdown
}

function addBreakdownRow(rowsContainerId, totalElId) {
  rowsContainerId = rowsContainerId || 'breakdownRows';
  totalElId = totalElId || 'breakdownTotal';
  const wrapper = document.createElement('div');
  wrapper.innerHTML = breakdownRowTemplate();
  const rowEl = wrapper.firstElementChild;
  rowEl.querySelector('.bd-remove').addEventListener('click', () => {
    rowEl.remove();
    recalcBreakdownTotal(rowsContainerId, totalElId);
  });
  rowEl.querySelector('.bd-minutes').addEventListener('input', () => recalcBreakdownTotal(rowsContainerId, totalElId));
  // Auto-detect reason tag when user types in the note field
  const noteInput = rowEl.querySelector('.bd-note');
  noteInput.addEventListener('input', () => {
    const tag = detectReasonTag(noteInput.value);
    if (tag) rowEl.querySelector('.bd-tag').value = tag;
  });
  document.getElementById(rowsContainerId).appendChild(rowEl);
  recalcBreakdownTotal(rowsContainerId, totalElId);
  return rowEl;
}

function collectBreakdown(rowsContainerId) {
  rowsContainerId = rowsContainerId || 'breakdownRows';
  const rows = document.querySelectorAll(`#${rowsContainerId} .breakdown-row`);
  const items = [];
  rows.forEach((row) => {
    const minutes = Number(row.querySelector('.bd-minutes').value) || 0;
    if (minutes > 0) {
      items.push({
        reason_tag: row.querySelector('.bd-tag').value,
        minutes,
        note: row.querySelector('.bd-note').value || null,
      });
    }
  });
  return items;
}

function initEntryForm() {
  document.getElementById('record_date').value = todayStr();

  // AOC follows the flight number (first two characters = AOC).
  document.getElementById('flight_number').addEventListener('input', () => syncAocFromFlight('flight_number', 'aoc', 'aocAutoHint'));
  syncAocFromFlight('flight_number', 'aoc', 'aocAutoHint');

  // Initialize Quick Paste

  document.getElementById('addBreakdownRowBtn').addEventListener('click', () => addBreakdownRow());

  document.getElementById('breakdownToggle').addEventListener('change', (e) => {
    const on = e.target.checked;
    document.getElementById('breakdownBox').style.display = on ? '' : 'none';
    document.getElementById('manualDelayBox').style.display = on ? 'none' : '';
    if (on && !document.querySelectorAll('#breakdownRows .breakdown-row').length) addBreakdownRow();
  });

  document.getElementById('entryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('entryMsg');
    msg.innerHTML = '';
    const breakdownOn = document.getElementById('breakdownToggle').checked;
    const breakdown = breakdownOn ? collectBreakdown() : [];
    if (breakdownOn && !breakdown.length) {
      msg.innerHTML = '<div class="msg error">Add at least one reason with minutes, or turn off the breakdown option.</div>';
      return;
    }
    const body = {
      record_date: document.getElementById('record_date').value,
      aoc: document.getElementById('aoc').value,
      category: document.getElementById('category').value,
      flight_number: document.getElementById('flight_number').value,
      route: document.getElementById('route').value,
      registration: document.getElementById('registration').value,
      delay_minutes: breakdownOn ? undefined : document.getElementById('delay_minutes').value,
      reason: document.getElementById('reason').value,
      downstream_impact: document.getElementById('downstream_impact').value,
      breakdown: breakdownOn ? breakdown : [],
    };
    try {
      await apiFetch('/api/records', { method: 'POST', body: JSON.stringify(body) });
      msg.innerHTML = '<div class="msg success">Record saved.</div>';
      e.target.reset();
      document.getElementById('record_date').value = todayStr();
      document.getElementById('breakdownBox').style.display = 'none';
      document.getElementById('manualDelayBox').style.display = '';
      document.getElementById('breakdownRows').innerHTML = '';
      recalcBreakdownTotal();
      clearAllQuickPasteManualFlags();
      syncAocFromFlight('flight_number', 'aoc', 'aocAutoHint');
    } catch (err) {
      msg.innerHTML = `<div class="msg error">${escapeHtml(err.message)}</div>`;
    }
  });
}

// ---------------------------------------------------------------
// Edit / Delete a logged record (Dashboard tab)
// ---------------------------------------------------------------
let EDIT_RECORD_ID = null;

async function openEditModal(id) {
  const msg = document.getElementById('editRecordMsg');
  msg.innerHTML = '';
  try {
    const { record } = await apiFetch(`/api/records/${id}`);
    EDIT_RECORD_ID = record.id;

    document.getElementById('edit_record_date').value = record.record_date;
    document.getElementById('edit_aoc').value = record.aoc;
    document.getElementById('edit_category').value = record.category;
    document.getElementById('edit_flight_number').value = record.flight_number || '';
    document.getElementById('edit_route').value = record.route || '';
    document.getElementById('edit_registration').value = record.registration || '';
    syncAocFromFlight('edit_flight_number', 'edit_aoc', 'editAocAutoHint');
    document.getElementById('edit_reason').value = record.reason;
    document.getElementById('edit_downstream_impact').value = record.downstream_impact || '';
    document.getElementById('edit_delay_minutes').value = record.delay_minutes || '';

    // Breakdown rows
    document.getElementById('editBreakdownRows').innerHTML = '';
    const hasBreakdown = !!(record.breakdown && record.breakdown.length);
    document.getElementById('edit_breakdownToggle').checked = hasBreakdown;
    document.getElementById('editBreakdownBox').style.display = hasBreakdown ? '' : 'none';
    document.getElementById('editManualDelayBox').style.display = hasBreakdown ? 'none' : '';
    if (hasBreakdown) {
      record.breakdown.forEach((item) => {
        const rowEl = addBreakdownRow('editBreakdownRows', 'editBreakdownTotal');
        rowEl.querySelector('.bd-tag').value = item.reason_tag;
        rowEl.querySelector('.bd-minutes').value = item.minutes;
        rowEl.querySelector('.bd-note').value = item.note || '';
      });
      recalcBreakdownTotal('editBreakdownRows', 'editBreakdownTotal');
    }

    document.getElementById('editRecordModal').classList.add('open');
  } catch (err) {
    alert(`Could not load this record: ${err.message}`);
  }
}

function closeEditModal() {
  document.getElementById('editRecordModal').classList.remove('open');
  EDIT_RECORD_ID = null;
}

async function deleteRecord(id) {
  if (!confirm('Delete this record? This cannot be undone.')) return;
  try {
    await apiFetch(`/api/records/${id}`, { method: 'DELETE' });
    loadDashboard(document.getElementById('dashDate').value);
  } catch (err) {
    alert(`Could not delete this record: ${err.message}`);
  }
}

function initEditRecordModal() {
  // Event delegation: #recordsTable's own element persists across
  // renderRecordsTable() re-renders, so one listener here covers every
  // Edit/Delete button on every future refresh too.
  document.getElementById('recordsTable').addEventListener('click', (e) => {
    const editBtn = e.target.closest('.row-edit-btn');
    if (editBtn) { openEditModal(editBtn.dataset.id); return; }
    const delBtn = e.target.closest('.row-delete-btn');
    if (delBtn) { deleteRecord(delBtn.dataset.id); }
  });

  document.getElementById('edit_flight_number').addEventListener('input', () => syncAocFromFlight('edit_flight_number', 'edit_aoc', 'editAocAutoHint'));
  document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);
  document.getElementById('editModalCloseBtn').addEventListener('click', closeEditModal);
  // Click on the dimmed backdrop (not the modal box itself) also closes it.
  document.getElementById('editRecordModal').addEventListener('click', (e) => {
    if (e.target.id === 'editRecordModal') closeEditModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('editRecordModal').classList.contains('open')) closeEditModal();
  });

  document.getElementById('editAddBreakdownRowBtn').addEventListener('click', () => addBreakdownRow('editBreakdownRows', 'editBreakdownTotal'));

  document.getElementById('edit_breakdownToggle').addEventListener('change', (e) => {
    const on = e.target.checked;
    document.getElementById('editBreakdownBox').style.display = on ? '' : 'none';
    document.getElementById('editManualDelayBox').style.display = on ? 'none' : '';
    if (on && !document.querySelectorAll('#editBreakdownRows .breakdown-row').length) addBreakdownRow('editBreakdownRows', 'editBreakdownTotal');
  });

  document.getElementById('editRecordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('editRecordMsg');
    msg.innerHTML = '';
    if (!EDIT_RECORD_ID) return;

    const breakdownOn = document.getElementById('edit_breakdownToggle').checked;
    const breakdown = breakdownOn ? collectBreakdown('editBreakdownRows') : [];
    if (breakdownOn && !breakdown.length) {
      msg.innerHTML = '<div class="msg error">Add at least one reason with minutes, or turn off the breakdown option.</div>';
      return;
    }
    const body = {
      record_date: document.getElementById('edit_record_date').value,
      aoc: document.getElementById('edit_aoc').value,
      category: document.getElementById('edit_category').value,
      flight_number: document.getElementById('edit_flight_number').value,
      route: document.getElementById('edit_route').value,
      registration: document.getElementById('edit_registration').value,
      delay_minutes: breakdownOn ? undefined : document.getElementById('edit_delay_minutes').value,
      reason: document.getElementById('edit_reason').value,
      downstream_impact: document.getElementById('edit_downstream_impact').value,
      breakdown: breakdownOn ? breakdown : [],
    };
    try {
      await apiFetch(`/api/records/${EDIT_RECORD_ID}`, { method: 'PUT', body: JSON.stringify(body) });
      closeEditModal();
      loadDashboard(document.getElementById('dashDate').value);
    } catch (err) {
      msg.innerHTML = `<div class="msg error">${escapeHtml(err.message)}</div>`;
    }
  });
}

// ---------------------------------------------------------------
// Multiple Delayed Flight Event - one shared reason, many flights.
// Each flight becomes its own delay record (reusing POST /api/records),
// so they show up individually on the Dashboard and in reports, grouped
// under whichever AOC each flight number actually belongs to.
// ---------------------------------------------------------------

// Flight number format for this tab only: XXXXX - first two characters are
// the AOC code, last three are digits (e.g. "G9555" -> AOC G9, flight 555).
function deriveAocFromFlightNumber(raw) {
  const clean = (raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (clean.length !== 5) return null;
  const prefix = clean.slice(0, 2);
  const digits = clean.slice(2);
  if (!/^\d{3}$/.test(digits)) return null;
  if (!AOC_LIST.includes(prefix)) return null;
  return { aoc: prefix, flightNumber: clean };
}

// Looser rule used by the Log Delay / Edit forms: the first two characters
// of whatever flight number was typed ARE the AOC (e.g. "G9 555", "3O828",
// "4P1234"). Returns the AOC code, or null when the prefix isn't a known AOC.
function aocFromFlightPrefix(raw) {
  const clean = (raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (clean.length < 3) return null;
  const prefix = clean.slice(0, 2);
  return AOC_LIST.includes(prefix) ? prefix : null;
}

// Keeps an AOC <select> in step with a flight-number input. While the flight
// number has a recognised AOC prefix, the select is set from it and locked;
// otherwise (blank / unrecognised) it stays editable so the AOC can still be
// chosen by hand. Returns the derived AOC or null.
function syncAocFromFlight(flightId, aocId, hintId) {
  const flightEl = document.getElementById(flightId);
  const aocEl = document.getElementById(aocId);
  const hintEl = hintId ? document.getElementById(hintId) : null;
  const derived = aocFromFlightPrefix(flightEl.value);
  if (derived) {
    aocEl.value = derived;
    aocEl.disabled = true;
    aocEl.classList.remove('field-needs-manual');
    const note = document.getElementById(aocId + '_manualNote');
    if (note) note.remove();
    if (hintEl) hintEl.textContent = '(set from flight number)';
  } else {
    aocEl.disabled = false;
    if (hintEl) hintEl.textContent = flightEl.value.trim()
      ? '(flight number has no known AOC prefix - choose manually)'
      : '(auto from flight number)';
  }
  return derived;
}

function multiFlightRowTemplate() {
  return `
    <div class="mf-row">
      <input type="text" class="mf-flight" placeholder="e.g. G9555" maxlength="6">
      <span class="mf-aoc-badge">?</span>
      <input type="text" class="mf-route" placeholder="Route e.g. CDG-RBA">
      <input type="text" class="mf-reg" placeholder="Reg e.g. A6-AUD">
      <input type="number" min="0" class="mf-minutes" placeholder="Delay (mins)">
      <button type="button" class="bd-remove" title="Remove">&times;</button>
    </div>
  `;
}

// Keeps the shared (disabled, auto-only) AOC dropdown reflecting whichever
// flight number was most recently typed validly - purely a visual
// indicator; each flight is still saved under its OWN derived AOC.
function updateMultiAocIndicator() {
  const rows = document.querySelectorAll('#multiFlightRows .mf-row');
  let lastValid = null;
  rows.forEach((row) => {
    const parsed = deriveAocFromFlightNumber(row.querySelector('.mf-flight').value);
    if (parsed) lastValid = parsed.aoc;
  });
  if (lastValid) document.getElementById('multi_aoc').value = lastValid;
}

function addMultiFlightRow() {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = multiFlightRowTemplate();
  const rowEl = wrapper.firstElementChild;
  const flightInput = rowEl.querySelector('.mf-flight');
  const badge = rowEl.querySelector('.mf-aoc-badge');

  flightInput.addEventListener('input', () => {
    const caret = flightInput.selectionStart;
    flightInput.value = flightInput.value.toUpperCase();
    if (caret !== null) flightInput.setSelectionRange(caret, caret);
    const parsed = deriveAocFromFlightNumber(flightInput.value);
    if (!flightInput.value.trim()) {
      badge.textContent = '?';
      badge.className = 'mf-aoc-badge';
    } else if (parsed) {
      badge.textContent = parsed.aoc;
      badge.className = 'mf-aoc-badge detected';
    } else {
      badge.textContent = '!';
      badge.className = 'mf-aoc-badge invalid';
      badge.title = 'Not a valid XXXXX flight number (2-character AOC + 3 digits)';
    }
    updateMultiAocIndicator();
  });

  rowEl.querySelector('.bd-remove').addEventListener('click', () => {
    rowEl.remove();
    updateMultiAocIndicator();
  });

  document.getElementById('multiFlightRows').appendChild(rowEl);
  return rowEl;
}

// Reads every filled-in flight row, validating/parsing its flight number.
// Empty rows are ignored (so a couple of blank spares can sit unused).
function collectMultiFlights() {
  const rows = document.querySelectorAll('#multiFlightRows .mf-row');
  const flights = [];
  const errors = [];
  rows.forEach((row, i) => {
    const raw = row.querySelector('.mf-flight').value.trim();
    if (!raw) return;
    const parsed = deriveAocFromFlightNumber(raw);
    if (!parsed) {
      errors.push(`Flight #${i + 1} ("${raw}"): not a valid XXXXX flight number - use a 2-character AOC (G9, E5, 3L, 3O, 9P or 4P) followed by 3 digits, e.g. G9555.`);
      return;
    }
    flights.push({
      flight_number: parsed.flightNumber,
      aoc: parsed.aoc,
      route: row.querySelector('.mf-route').value.trim(),
      registration: row.querySelector('.mf-reg').value.trim(),
      delay_minutes: row.querySelector('.mf-minutes').value,
    });
  });
  return { flights, errors };
}

function resetMultiForm() {
  document.getElementById('multiForm').reset();
  document.getElementById('multi_record_date').value = todayStr();
  document.getElementById('multi_aoc').value = 'G9';
  document.getElementById('multiFlightRows').innerHTML = '';
  addMultiFlightRow();
  addMultiFlightRow();
  document.getElementById('mfFreeTextRows').innerHTML = '';
}

// Multiple Delayed Flight Event - free-text entries: an alternative to the
// structured per-flight rows above. Each entry is its own card with an AOC,
// a total delay figure, and an unrestricted textarea - nothing typed into
// that textarea is parsed, validated against a format, or split into
// fields; it is stored and shown in the report exactly as written.
function multiFreeTextRowTemplate() {
  return `
    <div class="mf-freetext-row">
      <button type="button" class="bd-remove" title="Remove">&times;</button>
      <div class="mf-freetext-top">
        <div>
          <label class="mf-freetext-label">AOC</label>
          <select class="mf-freetext-aoc">
            <option value="G9">G9</option>
            <option value="E5">E5</option>
            <option value="3L">3L</option>
            <option value="3O">3O</option>
            <option value="9P">9P</option>
            <option value="4P">4P</option>
          </select>
        </div>
      </div>
      <label class="mf-freetext-label">Affected Flights - any format, shown exactly as typed</label>
      <textarea class="mf-freetext-text" placeholder="Type or paste the affected flights however you like - flight numbers, routes, notes, anything. It's saved and shown in the report exactly as written here."></textarea>
    </div>
  `;
}

function addMultiFreeTextRow() {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = multiFreeTextRowTemplate();
  const rowEl = wrapper.firstElementChild;
  rowEl.querySelector('.bd-remove').addEventListener('click', () => rowEl.remove());
  document.getElementById('mfFreeTextRows').appendChild(rowEl);
  return rowEl;
}

// Reads every free-text entry that has some text in it (an unused spare
// card is ignored, same as an empty structured row). No delay minutes are
// captured for free-text entries.
function collectMultiFreeText() {
  const rows = document.querySelectorAll('#mfFreeTextRows .mf-freetext-row');
  const entries = [];
  const errors = [];
  rows.forEach((row, i) => {
    const text = row.querySelector('.mf-freetext-text').value;
    if (!text.trim()) return;
    const aoc = row.querySelector('.mf-freetext-aoc').value;
    entries.push({ aoc, text: text.trim() });
  });
  return { entries, errors };
}

function initMultiFreeTextBox() {
  const toggle = document.getElementById('mfFreeTextToggle');
  const body = document.getElementById('mfFreeTextBody');
  const chevron = document.getElementById('mfFreeTextChevron');

  toggle.addEventListener('click', () => {
    body.classList.toggle('open');
    chevron.classList.toggle('open');
  });

  document.getElementById('addMfFreeTextRowBtn').addEventListener('click', () => addMultiFreeTextRow());
}

function initMultiFlightTab() {
  document.getElementById('multi_record_date').value = todayStr();
  addMultiFlightRow();
  addMultiFlightRow();
  initMultiFreeTextBox();

  document.getElementById('addMultiFlightRowBtn').addEventListener('click', () => addMultiFlightRow());

  document.getElementById('multiForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('multiMsg');
    msg.innerHTML = '';

    const { flights, errors } = collectMultiFlights();
    const { entries: freeTextEntries, errors: freeTextErrors } = collectMultiFreeText();
    const allErrors = [...errors, ...freeTextErrors];
    if (allErrors.length) {
      msg.innerHTML = `<div class="msg error">${allErrors.join('<br>')}</div>`;
      return;
    }
    const totalEntries = flights.length + freeTextEntries.length;
    if (totalEntries < 1) {
      msg.innerHTML = '<div class="msg error">Add at least one flight (row-by-row or as free text) before saving.</div>';
      return;
    }

    const shared = {
      record_date: document.getElementById('multi_record_date').value,
      category: document.getElementById('multi_category').value,
      reason: document.getElementById('multi_reason').value,
      downstream_impact: document.getElementById('multi_downstream_impact').value,
    };
    // Tags every record from this submission with the same id, so the Daily
    // Report can show the shared reason once with all flights listed under
    // it, instead of repeating it per flight - whether each one came from a
    // structured row or a free-text entry.
    const batchId = (totalEntries > 1)
      ? ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `mf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
      : null;

    const results = { ok: 0, failed: [] };
    for (const f of flights) {
      const body = {
        ...shared,
        batch_id: batchId,
        aoc: f.aoc,
        flight_number: f.flight_number,
        route: f.route,
        registration: f.registration,
        delay_minutes: f.delay_minutes,
      };
      try {
        await apiFetch('/api/records', { method: 'POST', body: JSON.stringify(body) });
        results.ok++;
      } catch (err) {
        results.failed.push(`${f.flight_number}: ${err.message}`);
      }
    }
    for (const entry of freeTextEntries) {
      const body = {
        ...shared,
        batch_id: batchId,
        aoc: entry.aoc,
        flights_free_text: entry.text,
        delay_minutes: null,
      };
      try {
        await apiFetch('/api/records', { method: 'POST', body: JSON.stringify(body) });
        results.ok++;
      } catch (err) {
        results.failed.push(`${entry.aoc} free-text entry: ${err.message}`);
      }
    }

    if (!results.failed.length) {
      msg.innerHTML = `<div class="msg success">Saved ${results.ok} record${results.ok === 1 ? '' : 's'}.</div>`;
      resetMultiForm();
    } else {
      msg.innerHTML = `<div class="msg error">Saved ${results.ok} of ${totalEntries} record(s). These failed:<br>${results.failed.join('<br>')}</div>`;
    }
  });
}

// ---------------------------------------------------------------
// Daily Report
// ---------------------------------------------------------------
// The report is built with email-safe HTML: plain tables, solid colours
// (no gradients), Arial, and every style written inline on the element
// (plus bgcolor attributes for Outlook). That way it keeps its look when
// copied into an email. All report text is converted to CAPITALS in the
// HTML itself (not just displayed that way), so it stays upper-case when
// pasted anywhere.
const RPT = {
  font: 'Arial, Helvetica, sans-serif',
  border: '#222222',
  title: '#334155',
  aoc: '#a01f2d',
  label: '#475569',
  date: '#d9ede1',
  dark: '#1c1c1c',
  red: '#7a1620',
  delay: '#b32020',
  muted: '#888888',
  group: '#0891b2',
  badge: {
    DELAY: ['#fef3c7', '#92610a'],
    GTB: ['#dbeafe', '#1d4ed8'],
    ATB: ['#ede9fe', '#6d28d9'],
    INCIDENT: ['#fde0e0', '#a01f2d'],
    DIVERSION: ['#ffedd5', '#c2410c'],
  },
  tiles: [
    { code: 'GTB', label: 'GTB', bg: '#2563eb' },
    { code: 'ATB', label: 'ATB', bg: '#7c3aed' },
    { code: 'INCIDENT', label: 'INCIDENTS', bg: '#dc2626' },
    { code: 'DIVERSION', label: 'DIVERSIONS', bg: '#ea580c' },
  ],
};
// Upper-cases and escapes a piece of report text.
const UP = (s) => escapeHtml(String(s == null ? '' : s).toUpperCase());

function rptCell(content, { bg, color = RPT.dark, align = 'left', bold = false, size = 13, width, colspan, extra = '' } = {}) {
  const style = [
    `border:1px solid ${RPT.border}`, 'padding:8px 10px', 'vertical-align:top',
    `font-family:${RPT.font}`, `font-size:${size}px`, `color:${color}`, `text-align:${align}`,
    bold ? 'font-weight:bold' : '', bg ? `background-color:${bg}` : '', width ? `width:${width}` : '', extra,
  ].filter(Boolean).join(';');
  return `<td${colspan ? ` colspan="${colspan}"` : ''}${bg ? ` bgcolor="${bg}"` : ''}${width ? ` width="${width}"` : ''} align="${align}" valign="top" style="${style}">${content}</td>`;
}
// Gives a report table the inline attributes email clients need.
function styleReportTable(id) {
  const t = document.getElementById(id);
  t.setAttribute('width', '100%');
  t.setAttribute('cellpadding', '0');
  t.setAttribute('cellspacing', '0');
  t.setAttribute('border', '1');
  t.setAttribute('style', `border-collapse:collapse;width:100%;table-layout:fixed;font-family:${RPT.font};border:1px solid ${RPT.border};`);
}

function renderReport(data) {
  const { date, aocs, totals } = data;
  const dateLabel = UP(data.rangeFrom ? `${fmtDateLabel(data.rangeFrom)} to ${fmtDateLabel(date)}` : fmtDateLabel(date));
  const ncol = aocs.length + 2;
  const labelW = '12%';

  // --- Event tiles: GTB / ATB / INCIDENTS / DIVERSIONS in this report ---
  // Each affected flight counts once (a multi-flight event counts every flight).
  const counts = { GTB: 0, ATB: 0, INCIDENT: 0, DIVERSION: 0 };
  aocs.forEach((a) => a.events.forEach((ev) => {
    if (counts[ev.category] === undefined) return;
    counts[ev.category] += ev.isGroup ? ev.flights.length : 1;
  }));
  const tileCells = RPT.tiles.map((t) => `
    <td bgcolor="${t.bg}" width="25%" align="center" valign="middle" style="background-color:${t.bg};color:#ffffff;font-family:${RPT.font};text-align:center;padding:14px 8px;border-radius:8px;width:25%;">
      <div style="font-size:30px;font-weight:bold;line-height:1.1;color:#ffffff;">${counts[t.code]}</div>
      <div style="font-size:12px;font-weight:bold;letter-spacing:0.5px;margin-top:4px;color:#ffffff;">${t.label}</div>
    </td>`).join('');
  document.getElementById('eventTilesTable').innerHTML = `<tr>${tileCells}</tr>`;

  // --- Daily flight count ---
  const titleRow = (text, span) => `<tr>${rptCell(text, { bg: RPT.title, color: '#ffffff', align: 'center', bold: true, size: 15, colspan: span })}</tr>`;
  // Fixed, equal column widths so the layout holds even without the site's stylesheet (e.g. in an email).
  const aocHeadsW = (w) => aocs.map((a) => rptCell(UP(a.code), { bg: RPT.aoc, color: '#ffffff', align: 'center', bold: true, width: w })).join('');
  const fcColW = `${(88 / (aocs.length + 1)).toFixed(2)}%`;
  const brColW = `${(88 / aocs.length).toFixed(2)}%`;
  const fcHead = titleRow('DAILY FLIGHT COUNT', ncol) + `
    <tr>
      ${rptCell(dateLabel, { bg: RPT.date, align: 'center', bold: true, width: labelW })}
      ${aocHeadsW(fcColW)}
      ${rptCell('TOTAL', { bg: RPT.aoc, color: '#ffffff', align: 'center', bold: true, width: fcColW })}
    </tr>`;
  // PAX flights / aircraft defects are typed straight into the report. Each
  // value is saved for the report date as soon as it is changed, and the
  // TOTAL column is recalculated live. "Copy for Email" swaps the boxes for
  // plain numbers.
  const countInput = (kind, a) => `<input type="number" min="0" class="rep-count-input" data-kind="${kind}" data-aoc="${a.code}" value="${(kind === 'pax' ? a.paxFlights : a.aircraftDefects) ?? ''}" placeholder="-" aria-label="${kind === 'pax' ? 'PAX flights' : 'Aircraft defects'} ${a.code}">`;
  const numStyle = { align: 'center', bold: true, size: 15, color: RPT.red };
  const countRow = (label, kind, totalId, total) => `
    <tr>
      ${rptCell(label, { bg: RPT.label, color: '#ffffff', align: 'center', bold: true })}
      ${aocs.map((a) => rptCell(countInput(kind, a), numStyle)).join('')}
      ${rptCell(String(total), numStyle).replace('<td', `<td id="${totalId}"`)}
    </tr>`;
  document.getElementById('flightCountTable').innerHTML = fcHead
    + countRow('PAX FLIGHTS', 'pax', 'repTotalPax', totals.paxFlights)
    + countRow('AIRCRAFT DEFECTS', 'defects', 'repTotalDefects', totals.aircraftDefects);

  // --- Briefing ---
  const badge = (cat) => {
    const [bg, fg] = RPT.badge[cat] || ['#eeeeee', '#333333'];
    return `<span style="background-color:${bg};color:${fg};font-weight:bold;font-size:11px;padding:2px 8px;border-radius:10px;font-family:${RPT.font};">${UP(cat)}</span>`;
  };
  const flightStyle = `font-weight:bold;text-decoration:underline;color:${RPT.red};`;
  const delayStyle = `font-weight:bold;color:${RPT.delay};`;
  // Free-text affected flights: shown exactly as typed (line breaks kept), in capitals.
  const freeText = (text) => `<div style="margin-top:6px;font-size:12px;">${UP(text).replace(/\n/g, '<br>')}</div>`;
  const impact = (text) => `<div style="margin-top:4px;font-style:italic;color:#444444;">${UP(text).replace(/\n/g, '<br>')}</div>`;
  const flightLabel = (f) => UP([f.flightNumber, f.route].filter(Boolean).join(' ')) + (f.registration ? ' - ' + UP(f.registration) : '');

  const eventHtml = (ev, isLast) => {
    const sep = isLast ? '' : 'border-bottom:1px dashed #cccccc;';
    if (ev.isGroup) {
      // Flights saved together from the Multiple Delayed Flight Event tab:
      // one shared reason, every flight listed underneath it.
      const lines = ev.flights.map((f) => `
        <div style="margin-top:3px;font-size:12px;">
          ${f.flightsFreeText ? freeText(f.flightsFreeText) : `<span style="${flightStyle}">${flightLabel(f)}</span>`}
          ${f.delayLabel ? ` <span style="${delayStyle}">(${UP(f.delayLabel)})</span>` : ''}
        </div>`).join('');
      return `
        <div style="margin-bottom:12px;padding:0 0 10px 8px;border-left:3px solid ${RPT.group};${sep}">
          <div>${badge(ev.category)} ${UP(ev.reasonClean || ev.reason)}</div>
          <div style="margin-top:6px;">${lines}</div>
          ${ev.downstreamImpact ? impact(ev.downstreamImpact) : ''}
        </div>`;
    }
    const bd = (ev.breakdown || []).map((b) => `
      <div style="margin-top:3px;padding-left:10px;font-size:12px;color:#333333;">&bull; <b style="color:${RPT.label};">${UP(b.reasonTagName)}</b>: ${UP(b.noteClean || b.note || '')} ${b.minutesLabel ? '(' + UP(b.minutesLabel) + ')' : ''}</div>`).join('');
    return `
      <div style="margin-bottom:12px;padding-bottom:10px;${sep}">
        ${ev.flightNumber || ev.route ? `<div style="${flightStyle}">${flightLabel(ev)}</div>` : ''}
        <div>${badge(ev.category)} ${UP(ev.reasonClean || ev.reason)}</div>
        ${ev.flightsFreeText ? freeText(ev.flightsFreeText) : ''}
        ${bd}
        ${ev.downstreamImpact ? impact(ev.downstreamImpact) : ''}
        ${ev.delayLabel ? `<div style="${delayStyle}">(TOTAL DELAY ${UP(ev.delayLabel)})</div>` : ''}
      </div>`;
  };

  const briefing = titleRow('OCC DAILY OPERATIONS BRIEFING', aocs.length + 1) + `
    <tr>
      ${rptCell(dateLabel, { bg: RPT.date, align: 'center', bold: true, width: labelW })}
      ${aocHeadsW(brColW)}
    </tr>
    <tr>
      ${rptCell('SIGNIFICANT<br>EVENTS<br>-24H', { bg: RPT.label, color: '#ffffff', align: 'center', bold: true })}
      ${aocs.map((a) => rptCell(
        a.events.length
          ? a.events.map((ev, i) => eventHtml(ev, i === a.events.length - 1)).join('')
          : `<div style="text-align:center;font-weight:bold;padding-top:40px;color:${RPT.muted};">NIL</div>`,
        { size: 12.5, extra: 'height:120px' },
      )).join('')}
    </tr>`;
  document.getElementById('briefingTable').innerHTML = briefing;
  styleReportTable('flightCountTable');
  styleReportTable('briefingTable');

  document.getElementById('reportCard').style.display = '';
  document.getElementById('copyEmailBtn').disabled = false;
}

// Copies the report as rich HTML ready to paste into an email: the PAX
// flight / defect boxes become plain numbers, and any manual edits made in
// Edit Report mode are included.
async function copyReportForEmail() {
  const status = document.getElementById('reportStatus');
  const card = document.getElementById('reportCard');
  if (card.style.display === 'none') { status.textContent = 'Generate the report first.'; return; }
  const clone = card.cloneNode(true);
  const liveInputs = card.querySelectorAll('input.rep-count-input');
  clone.querySelectorAll('input.rep-count-input').forEach((inp, i) => {
    const v = (liveInputs[i] ? liveInputs[i].value : inp.value).trim();
    inp.replaceWith(document.createTextNode(v === '' ? '-' : v));
  });
  clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
  clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  const tables = Array.from(clone.querySelectorAll('table.rep-email'));
  const html = `<div style="font-family:${RPT.font};">${tables.map((t) => { t.removeAttribute('class'); return t.outerHTML; }).join('<br>')}</div>`;

  // Plain-text fallback for mail apps that don't accept rich HTML.
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const text = tmp.innerText;

  try {
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) throw new Error('no clipboard API');
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
  } catch (e) {
    // Fallback: select a hidden copy and use the browser's copy command.
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;background:#ffffff;';
    holder.innerHTML = html;
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    const ok = document.execCommand('copy');
    sel.removeAllRanges();
    holder.remove();
    if (!ok) { status.textContent = 'Could not copy automatically - select the report and press Ctrl+C instead.'; return; }
  }
  status.textContent = 'Report copied - paste it into your email (Ctrl+V).';
}

// Set once the user has typed into the report while Edit Report mode is on.
// Manual edits live only in the page (there is no "edited report" table in
// the database) - they're for tightening wording before printing/exporting,
// and are discarded the next time the report is (re)generated.
let REPORT_MANUALLY_EDITED = false;

function setReportEditingMode(on) {
  const reportCard = document.getElementById('reportCard');
  reportCard.classList.toggle('editing', on);
  document.getElementById('flightCountTable').setAttribute('contenteditable', on ? 'true' : 'false');
  document.getElementById('briefingTable').setAttribute('contenteditable', on ? 'true' : 'false');
  document.getElementById('editReportBtn').textContent = on ? 'Done Editing' : 'Edit Report';
  document.getElementById('editReportHint').style.display = on ? '' : 'none';
}

// Delays offered for selection (the last 30 hours, counted from login) and
// the report date the PAX flight / defect figures are stored under.
let RECENT_DELAY_ITEMS = [];
let REPORT_DATE = null;

function fmtLocalDateTime(iso) {
  const d = new Date(iso);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${months[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function selectedDelayIds() {
  const ids = [];
  document.querySelectorAll('#recentDelaysList .rd-check:checked').forEach((cb) => {
    const item = RECENT_DELAY_ITEMS[Number(cb.dataset.idx)];
    if (item) ids.push(...item.ids);
  });
  return ids;
}

function updateDelaySelectionCount() {
  const total = RECENT_DELAY_ITEMS.length;
  const picked = document.querySelectorAll('#recentDelaysList .rd-check:checked').length;
  document.getElementById('delaySelectionCount').textContent = total ? `${picked} of ${total} selected` : '';
  document.querySelectorAll('#recentDelaysList .rd-item').forEach((el) => {
    el.classList.toggle('selected', el.querySelector('.rd-check').checked);
  });
}

function renderRecentDelays(keepSelectedFirstIds) {
  const box = document.getElementById('recentDelaysList');
  if (!RECENT_DELAY_ITEMS.length) {
    box.innerHTML = '<p class="small" style="margin:6px 0;">No delays were logged in this 30-hour window.</p>';
    updateDelaySelectionCount();
    return;
  }
  box.innerHTML = RECENT_DELAY_ITEMS.map((it, i) => {
    const flightText = it.flights.map((f) => {
      if (f.flightsFreeText) return f.flightsFreeText.replace(/\s+/g, ' ').trim();
      return [f.flightNumber, f.route].filter(Boolean).join(' ') || '';
    }).filter(Boolean).join(', ');
    const checked = keepSelectedFirstIds && keepSelectedFirstIds.has(it.ids[0]) ? 'checked' : '';
    return `
      <label class="rd-item">
        <input type="checkbox" class="rd-check" data-idx="${i}" ${checked}>
        <span class="rd-main">
          <span class="rd-top">
            <span class="badge ${it.category}">${escapeHtml(it.category)}</span>
            <b>${escapeHtml(it.aoc)}</b>
            ${it.flights.length > 1 ? `<span class="small">${it.flights.length} flights</span>` : ''}
            ${it.totalMinutes ? `<span class="small">${it.totalMinutes} min</span>` : ''}
            <span class="small rd-time">${fmtLocalDateTime(it.createdAt)}</span>
          </span>
          <span class="rd-reason">${escapeHtml(it.reason)}</span>
          ${flightText ? `<span class="small rd-flights">${escapeHtml(flightText)}</span>` : ''}
        </span>
      </label>
    `;
  }).join('');
  updateDelaySelectionCount();
}

// Which list the picker is showing: the rolling 30 hours from login, or an
// explicit From/To date range (by the date each delay was recorded for).
function currentDelayRange() {
  if (!document.getElementById('modeRange').checked) return null;
  const from = document.getElementById('rangeFrom').value;
  const to = document.getElementById('rangeTo').value;
  return { from: from || to, to: to || from };
}

async function loadRecentDelays() {
  const box = document.getElementById('recentDelaysList');
  const intro = document.getElementById('recentDelaysIntro');
  const keep = new Set();
  document.querySelectorAll('#recentDelaysList .rd-check:checked').forEach((cb) => {
    const item = RECENT_DELAY_ITEMS[Number(cb.dataset.idx)];
    if (item) keep.add(item.ids[0]);
  });
  const range = currentDelayRange();
  if (range && !range.from) {
    RECENT_DELAY_ITEMS = [];
    intro.textContent = 'Pick a From and/or To date, then click Show Delays.';
    renderRecentDelays(keep);
    box.innerHTML = '<p class="small" style="margin:6px 0;">No date range chosen yet.</p>';
    return;
  }
  try {
    const qs = range ? `?from=${range.from}&to=${range.to}` : '';
    const data = await apiFetch(`/api/report/recent-delays${qs}`);
    RECENT_DELAY_ITEMS = data.items;
    intro.innerHTML = range
      ? `Delays recorded from <b>${fmtDateLabel(range.from)}</b> to <b>${fmtDateLabel(range.to)}</b> are listed below. Tick the delays you want in the report, then click <b>Generate Report</b>.`
      : `Delays logged in the last ${data.windowHours} hours (counted from your login at ${fmtLocalDateTime(data.loginAt)}, i.e. since ${fmtLocalDateTime(data.windowStart)}) are listed below. Tick the delays you want in the report, then click <b>Generate Report</b>.`;
    renderRecentDelays(keep);
  } catch (err) {
    const stale = /404/.test(err.message)
      ? ' The dashboard server is still running an old version - close the black server window, double-click Start Dashboard.bat again, then log in again.'
      : '';
    box.innerHTML = `<p class="small" style="color:#b32020;">Could not load delays: ${escapeHtml(err.message)}.${escapeHtml(stale)}</p>`;
  }
}

async function saveReportCount(input) {
  const status = document.getElementById('reportStatus');
  const code = input.dataset.aoc;
  const value = input.value === '' ? 0 : Math.max(0, Math.floor(Number(input.value) || 0));
  try {
    if (input.dataset.kind === 'pax') {
      await apiFetch('/api/flight-counts', { method: 'POST', body: JSON.stringify({ record_date: REPORT_DATE, aoc: code, pax_flights: value }) });
    } else {
      await apiFetch('/api/defects', { method: 'POST', body: JSON.stringify({ record_date: REPORT_DATE, aoc: code, defect_count: value }) });
    }
    input.classList.remove('rep-count-error');
  } catch (err) {
    input.classList.add('rep-count-error');
    status.textContent = `Could not save ${code} figure: ${err.message}`;
  }
}

function recalcReportTotals() {
  const sum = (kind) => Array.from(document.querySelectorAll(`.rep-count-input[data-kind="${kind}"]`))
    .reduce((t, el) => t + (Number(el.value) || 0), 0);
  const pax = document.getElementById('repTotalPax');
  const def = document.getElementById('repTotalDefects');
  if (pax) pax.textContent = sum('pax');
  if (def) def.textContent = sum('defects');
}

async function generateReport(force) {
  if (REPORT_MANUALLY_EDITED) {
    const proceed = confirm('You have manual edits on this report that have not been saved anywhere. Regenerating will discard them - continue?');
    if (!proceed) return;
  }
  const status = document.getElementById('reportStatus');
  const ids = selectedDelayIds();
  const range = currentDelayRange();
  // Date-range mode dates the report (and its PAX flight / defect figures)
  // by the end of the range; 30-hour mode uses today.
  REPORT_DATE = range && range.to ? range.to : todayStr();
  const rangeFromParam = range && range.from && range.from < REPORT_DATE ? `&from=${range.from}` : '';
  status.textContent = force ? 'Regenerating report...' : 'Generating report...';
  try {
    const data = await apiFetch(`/api/report/generate?date=${REPORT_DATE}${rangeFromParam}&ids=${ids.join(',')}${force ? '&force=1' : ''}`);
    renderReport(data);
    REPORT_MANUALLY_EDITED = false;
    setReportEditingMode(false);
    status.textContent = ids.length
      ? `Report ready with ${ids.length} selected record${ids.length === 1 ? '' : 's'}. Enter PAX flights and aircraft defects directly in the report table.`
      : 'Report generated with no delays selected (all AOCs show NIL). Tick delays above and generate again to include them.';
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
}

function initReportTab() {
  document.getElementById('genBtn').addEventListener('click', () => generateReport(false));
  document.getElementById('forceBtn').addEventListener('click', () => generateReport(true));
  document.getElementById('printBtn').addEventListener('click', () => window.print());
  document.getElementById('copyEmailBtn').addEventListener('click', copyReportForEmail);
  document.getElementById('refreshDelaysBtn').addEventListener('click', loadRecentDelays);
  document.getElementById('rangeFrom').value = yesterdayStr();
  document.getElementById('rangeTo').value = todayStr();
  const applyMode = () => {
    document.getElementById('rangeInputs').style.display = document.getElementById('modeRange').checked ? 'flex' : 'none';
    RECENT_DELAY_ITEMS = [];
    loadRecentDelays();
  };
  document.getElementById('modeWindow').addEventListener('change', applyMode);
  document.getElementById('modeRange').addEventListener('change', applyMode);
  document.getElementById('showRangeBtn').addEventListener('click', loadRecentDelays);
  document.getElementById('selectAllDelaysBtn').addEventListener('click', () => {
    document.querySelectorAll('#recentDelaysList .rd-check').forEach((cb) => { cb.checked = true; });
    updateDelaySelectionCount();
  });
  document.getElementById('clearDelaysBtn').addEventListener('click', () => {
    document.querySelectorAll('#recentDelaysList .rd-check').forEach((cb) => { cb.checked = false; });
    updateDelaySelectionCount();
  });
  document.getElementById('recentDelaysList').addEventListener('change', updateDelaySelectionCount);

  document.getElementById('editReportBtn').addEventListener('click', () => {
    const nowEditing = !document.getElementById('reportCard').classList.contains('editing');
    setReportEditingMode(nowEditing);
  });
  // contenteditable tables fire 'input' events just like form fields do.
  // Typing in the PAX flight / defect cells is NOT a "manual text edit":
  // those values are saved to the database and only the totals update.
  document.getElementById('reportCard').addEventListener('input', (e) => {
    if (e.target.classList && e.target.classList.contains('rep-count-input')) {
      recalcReportTotals();
      return;
    }
    REPORT_MANUALLY_EDITED = true;
  });
  document.getElementById('reportCard').addEventListener('change', (e) => {
    if (e.target.classList && e.target.classList.contains('rep-count-input')) saveReportCount(e.target);
  });
}

// ---------------------------------------------------------------
// Admin
// ---------------------------------------------------------------
async function loadUsers() {
  const { users } = await apiFetch('/api/admin/users');
  document.getElementById('usersTable').innerHTML = `
    <table>
      <thead><tr><th>Username</th><th>Full Name</th><th>Role</th><th>AOC</th><th>Active</th><th></th></tr></thead>
      <tbody>
        ${users.map((u) => `
          <tr>
            <td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.full_name)}</td><td>${escapeHtml(u.role)}</td><td>${escapeHtml(u.aoc || '')}</td>
            <td><span class="badge ${u.active ? 'closed' : 'open'}">${u.active ? 'active' : 'disabled'}</span></td>
            <td><button class="secondary small-btn toggleBtn" data-id="${u.id}" data-active="${u.active}">${u.active ? 'Disable' : 'Enable'}</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  document.querySelectorAll('.toggleBtn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const active = btn.dataset.active === '1' ? 0 : 1;
      await apiFetch(`/api/admin/users/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ active: !!active }) });
      loadUsers();
    });
  });
}

function initAdminTab() {
  document.getElementById('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('adminMsg');
    msg.innerHTML = '';
    try {
      await apiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('newUsername').value,
          full_name: document.getElementById('newFullName').value,
          password: document.getElementById('newPassword').value,
          role: document.getElementById('newRole').value,
          aoc: document.getElementById('newAoc').value,
        }),
      });
      msg.innerHTML = '<div class="msg success">User created.</div>';
      e.target.reset();
      loadUsers();
    } catch (err) {
      msg.innerHTML = `<div class="msg error">${escapeHtml(err.message)}</div>`;
    }
  });
}

// ---------------------------------------------------------------
// Account
// ---------------------------------------------------------------
function initAccountTab() {
  document.getElementById('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('accountMsg');
    msg.innerHTML = '';
    try {
      await apiFetch('/api/account/password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: document.getElementById('currentPassword').value,
          newPassword: document.getElementById('newAccountPassword').value,
        }),
      });
      msg.innerHTML = '<div class="msg success">Password updated.</div>';
      e.target.reset();
    } catch (err) {
      msg.innerHTML = `<div class="msg error">${escapeHtml(err.message)}</div>`;
    }
  });
}

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------
(async () => {
  CURRENT_USER = (await apiFetch('/api/me')).user;
  document.getElementById('userbox').textContent =
    `${CURRENT_USER.full_name} (${CURRENT_USER.role}${CURRENT_USER.aoc ? ' - ' + CURRENT_USER.aoc : ''})`;
  if (CURRENT_USER.role === 'admin') document.getElementById('adminTabBtn').style.display = '';

  document.getElementById('dashDate').value = todayStr();

  initTabs();
  initEntryForm();
  initEditRecordModal();
  initMultiFlightTab();
  initReportTab();
  initAdminTab();
  initAccountTab();

  document.getElementById('dashRefreshBtn').addEventListener('click', () => loadDashboard(document.getElementById('dashDate').value));
  document.getElementById('dashDate').addEventListener('change', () => loadDashboard(document.getElementById('dashDate').value));

  const initialTab = (window.location.hash || '#dashboard').slice(1);
  showTab(document.getElementById(`tab-${initialTab}`) ? initialTab : 'dashboard');
})();
