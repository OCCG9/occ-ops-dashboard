// Shared helpers used by the single-page app (app.js) and the login page.
//
// The dashboard used to talk to a Node server at /api/... . On GitHub Pages
// there is no server, so apiFetch() below now answers those same /api/...
// requests by talking to Supabase directly. The rest of the app is
// unchanged. Every permission check is enforced by the database itself
// (see supabase/schema.sql); the checks here are only for nicer messages.

// Everything inside this block is private, so its helper names can't clash
// with the ones in app.js. Only what the pages need is exported at the end.
(function () {
const OCC = window.OCC_CONFIG;
const sb = window.supabase.createClient(OCC.SUPABASE_URL, OCC.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const LOGIN_AT_KEY = 'occ_login_at';
const HOURS_WINDOW = 30;

function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
function storageDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

function usernameToEmail(username) {
  const u = String(username || '').trim().toLowerCase();
  // An admin bootstrapped from the Supabase dashboard may log in with a real email.
  return u.includes('@') ? u : `${u}@${OCC.USERNAME_EMAIL_DOMAIN}`;
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

let REDIRECTING = false;
function goToLogin(reason) {
  // Several requests can fail at once; the first redirect (which knows the
  // real reason, e.g. "expired") wins.
  if (REDIRECTING) return;
  REDIRECTING = true;
  const q = reason ? `?reason=${encodeURIComponent(reason)}` : '';
  window.location.href = `login.html${q}`;
}

// Turns Supabase/Postgres errors into the short messages the old server gave.
function dbError(error, fallback) {
  const m = (error && error.message) || fallback || 'Request failed';
  if (/row-level security|permission denied/i.test(m)) return new ApiError('Insufficient permissions', 403);
  if (/JWT|not authenticated/i.test(m)) return new ApiError('Not authenticated', 401);
  return new ApiError(m, 400);
}

async function requireSession() {
  const { data } = await sb.auth.getSession();
  const session = data && data.session;
  if (!session) throw new ApiError('Not authenticated', 401);
  const loginAt = Number(storageGet(LOGIN_AT_KEY)) || null;
  if (loginAt && Date.now() - loginAt > OCC.SESSION_MAX_HOURS * 3600 * 1000) {
    await sb.auth.signOut();
    storageDel(LOGIN_AT_KEY);
    throw new ApiError('Session expired', 401);
  }
  return session;
}

let PROFILE_CACHE = null;
async function currentProfile() {
  const session = await requireSession();
  if (PROFILE_CACHE && PROFILE_CACHE.id === session.user.id) return PROFILE_CACHE;
  const { data, error } = await sb.from('profiles')
    .select('id, username, full_name, role, aoc, active').eq('id', session.user.id).maybeSingle();
  if (error) throw dbError(error);
  if (!data || !data.active) {
    await sb.auth.signOut();
    storageDel(LOGIN_AT_KEY);
    throw new ApiError('Account disabled', 401);
  }
  PROFILE_CACHE = data;
  return data;
}

// --- Reference lists (AOCs, categories, delay reason tags) -------------
let META_CACHE = null;
async function loadMeta() {
  if (META_CACHE) return META_CACHE;
  const [a, c, t] = await Promise.all([
    sb.from('aocs').select('code, name').eq('active', true).order('sort_order'),
    sb.from('categories').select('code, name').order('sort_order'),
    sb.from('delay_reason_tags').select('code, name').order('sort_order'),
  ]);
  for (const r of [a, c, t]) if (r.error) throw dbError(r.error);
  META_CACHE = { aocs: a.data, categories: c.data, delayReasonTags: t.data };
  return META_CACHE;
}

// --- Records -----------------------------------------------------------
const RECORD_SELECT = '*, delay_breakdown_items(*)';
function shapeRecord(r) {
  const items = (r.delay_breakdown_items || []).slice()
    .sort((x, y) => (x.sort_order - y.sort_order) || (x.id - y.id));
  const out = { ...r, breakdown: items };
  delete out.delay_breakdown_items;
  return out;
}

async function getRecord(id) {
  const { data, error } = await sb.from('delay_records').select(RECORD_SELECT).eq('id', id).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new ApiError('Not found', 404);
  return shapeRecord(data);
}

// --- Report helpers (ported from the old src/routes/reports.js) ---------
function fmtDuration(mins) {
  if (mins === null || mins === undefined) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h} HR${h > 1 ? 'S' : ''} ${m} MIN${m > 1 ? 'S' : ''}`;
  if (h) return `${h} HR${h > 1 ? 'S' : ''}`;
  return `${m} MIN${m > 1 ? 'S' : ''}`;
}

// Rule-based tidy-up of delay text (the same fallback the old server used
// when no AI key was configured).
function ruleBasedClean(text) {
  if (!text) return '';
  // Tidy spacing within each line but KEEP the line breaks / paragraphs the
  // user typed (more than one blank line in a row is reduced to one).
  let t = String(text).replace(/\r\n?/g, '\n')
    .split('\n').map((line) => line.trim().replace(/[ \t]+/g, ' ')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  t = t.replace(/(^|[.!?]\s+|\n)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
  t = t.replace(/[ \t]+([,.;:])/g, '$1');
  return t;
}

const isDateStr = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

async function recentDelays(q) {
  const loginAt = Number(storageGet(LOGIN_AT_KEY)) || Date.now();
  const windowEndMs = Math.max(Date.now(), loginAt);
  const windowStartMs = loginAt - HOURS_WINDOW * 3600 * 1000;
  const from = q.get('from');
  const to = q.get('to');
  const rangeMode = isDateStr(from) || isDateStr(to);

  let query = sb.from('delay_records').select('*');
  if (rangeMode) {
    const lo = isDateStr(from) ? from : to;
    const hi = isDateStr(to) ? to : from;
    query = query.gte('record_date', lo <= hi ? lo : hi).lte('record_date', lo <= hi ? hi : lo);
  } else {
    query = query.gte('created_at', new Date(windowStartMs).toISOString())
      .lte('created_at', new Date(windowEndMs + 1000).toISOString());
  }
  const { data: rows, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false });
  if (error) throw dbError(error);

  const meta = await loadMeta();
  const catName = Object.fromEntries(meta.categories.map((c) => [c.code, c.name]));
  const items = [];
  const indexByKey = new Map();
  for (const r of rows) {
    const key = r.batch_id ? `${r.aoc}||${r.category}||${r.batch_id}||${r.reason}` : null;
    const flight = {
      id: r.id,
      flightNumber: r.flight_number,
      route: r.route,
      registration: r.registration,
      flightsFreeText: r.flights_free_text || null,
      delayMinutes: r.delay_minutes,
    };
    if (key && indexByKey.has(key)) {
      const it = items[indexByKey.get(key)];
      it.ids.push(r.id);
      it.flights.push(flight);
      it.totalMinutes += r.delay_minutes || 0;
      continue;
    }
    if (key) indexByKey.set(key, items.length);
    items.push({
      ids: [r.id],
      aoc: r.aoc,
      category: r.category,
      categoryName: catName[r.category] || r.category,
      reason: r.reason,
      totalMinutes: r.delay_minutes || 0,
      createdAt: new Date(r.created_at).toISOString(),
      enteredBy: r.entered_by,
      flights: [flight],
    });
  }
  return {
    mode: rangeMode ? 'range' : 'window',
    loginAt: new Date(loginAt).toISOString(),
    windowStart: new Date(windowStartMs).toISOString(),
    windowHours: HOURS_WINDOW,
    items,
  };
}

async function buildReport(q) {
  const date = q.get('date');
  if (!date) throw new ApiError('date is required (YYYY-MM-DD)', 400);
  const ids = String(q.get('ids') || '').split(',').map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0);

  const meta = await loadMeta();
  let records = [];
  if (ids.length) {
    const { data, error } = await sb.from('delay_records').select(RECORD_SELECT).in('id', ids);
    if (error) throw dbError(error);
    records = data.map(shapeRecord).sort((a, b) =>
      a.aoc.localeCompare(b.aoc) || a.category.localeCompare(b.category)
      || String(a.created_at).localeCompare(String(b.created_at)) || (a.id - b.id));
  }
  const [fc, df] = await Promise.all([
    sb.from('flight_counts').select('*').eq('record_date', date),
    sb.from('aircraft_defects').select('*').eq('record_date', date),
  ]);
  if (fc.error) throw dbError(fc.error);
  if (df.error) throw dbError(df.error);
  const fcByAoc = Object.fromEntries(fc.data.map((f) => [f.aoc, f.pax_flights]));
  const defByAoc = Object.fromEntries(df.data.map((d) => [d.aoc, d]));

  // Wording tidy-up happens at report time, as before.
  for (const r of records) {
    r.reason_clean = ruleBasedClean(r.reason);
    for (const item of r.breakdown) if (item.note) item.note_clean = ruleBasedClean(item.note);
  }

  const catName = Object.fromEntries(meta.categories.map((c) => [c.code, c.name]));
  const tagName = Object.fromEntries(meta.delayReasonTags.map((t) => [t.code, t.name]));

  function groupRecordsForReport(recordsForAoc) {
    const groups = [];
    const indexByKey = new Map();
    for (const r of recordsForAoc) {
      const key = r.batch_id ? `${r.category}||${r.batch_id}||${r.reason}` : null;
      if (key && indexByKey.has(key)) groups[indexByKey.get(key)].push(r);
      else { if (key) indexByKey.set(key, groups.length); groups.push([r]); }
    }
    return groups;
  }

  const aocs = meta.aocs.map((a) => {
    const aocRecords = records.filter((r) => r.aoc === a.code);
    const totalDelayMinutes = aocRecords.reduce((sum, r) => sum + (r.delay_minutes || 0), 0);
    return {
      code: a.code,
      name: a.name,
      paxFlights: fcByAoc[a.code] ?? null,
      aircraftDefects: defByAoc[a.code]?.defect_count ?? null,
      defectNotes: defByAoc[a.code]?.notes ?? null,
      totalDelayMinutes,
      totalDelayLabel: totalDelayMinutes ? fmtDuration(totalDelayMinutes) : null,
      events: groupRecordsForReport(aocRecords).map((group) => {
        if (group.length === 1) {
          const r = group[0];
          return {
            id: r.id,
            category: r.category,
            categoryName: catName[r.category] || r.category,
            flightNumber: r.flight_number,
            route: r.route,
            registration: r.registration,
            flightsFreeText: r.flights_free_text || null,
            reason: r.reason,
            reasonClean: r.reason_clean,
            delayMinutes: r.delay_minutes,
            delayLabel: fmtDuration(r.delay_minutes),
            downstreamImpact: r.downstream_impact,
            breakdown: r.breakdown.map((b) => ({
              reasonTag: b.reason_tag,
              reasonTagName: tagName[b.reason_tag] || b.reason_tag,
              minutes: b.minutes,
              minutesLabel: fmtDuration(b.minutes),
              note: b.note,
              noteClean: b.note_clean,
            })),
          };
        }
        const first = group[0];
        return {
          id: first.id,
          isGroup: true,
          category: first.category,
          categoryName: catName[first.category] || first.category,
          reason: first.reason,
          reasonClean: first.reason_clean,
          downstreamImpact: first.downstream_impact,
          flights: group.map((r) => ({
            flightNumber: r.flight_number,
            route: r.route,
            registration: r.registration,
            flightsFreeText: r.flights_free_text || null,
            delayMinutes: r.delay_minutes,
            delayLabel: fmtDuration(r.delay_minutes),
          })),
        };
      }),
    };
  });

  const totals = {
    paxFlights: aocs.reduce((sum, a) => sum + (a.paxFlights || 0), 0),
    aircraftDefects: aocs.reduce((sum, a) => sum + (a.aircraftDefects || 0), 0),
  };
  const rf = String(q.get('from') || '');
  const rangeFrom = isDateStr(rf) && rf < date ? rf : null;
  return { date, rangeFrom, aocs, totals };
}

// --- Admin (via the admin-users Edge Function) -------------------------
async function invokeAdmin(body) {
  const { data, error } = await sb.functions.invoke('admin-users', { body });
  if (error) {
    let msg = error.message || 'Request failed';
    try {
      const ctx = error.context;
      if (ctx && typeof ctx.json === 'function') {
        const j = await ctx.json();
        if (j && j.error) msg = j.error;
      }
    } catch (e) { /* keep generic message */ }
    throw new ApiError(msg, 400);
  }
  return data;
}

async function upsertDailyFigure(table, row) {
  const { data, error } = await sb.from(table).upsert(row, { onConflict: 'record_date,aoc' }).select().single();
  if (error) throw dbError(error);
  return data;
}

// --- Router: answers the old /api/... calls ----------------------------
async function routeApi(method, path, q, body) {
  let m;
  if (path === '/api/logout' && method === 'POST') {
    await sb.auth.signOut();
    storageDel(LOGIN_AT_KEY);
    PROFILE_CACHE = null;
    return { ok: true };
  }

  const me = await currentProfile();

  if (path === '/api/me') {
    return {
      user: { id: me.id, username: me.username, full_name: me.full_name, role: me.role, aoc: me.aoc },
      loginAt: Number(storageGet(LOGIN_AT_KEY)) || null,
    };
  }
  if (path === '/api/meta') return loadMeta();

  if (path === '/api/records' && method === 'GET') {
    let query = sb.from('delay_records').select(RECORD_SELECT);
    if (q.get('date')) query = query.eq('record_date', q.get('date'));
    if (q.get('from')) query = query.gte('record_date', q.get('from'));
    if (q.get('to')) query = query.lte('record_date', q.get('to'));
    if (q.get('aoc')) query = query.eq('aoc', q.get('aoc'));
    if (q.get('category')) query = query.eq('category', q.get('category'));
    const { data, error } = await query.order('record_date', { ascending: false }).order('created_at', { ascending: false });
    if (error) throw dbError(error);
    return { records: data.map(shapeRecord) };
  }
  if (path === '/api/records' && method === 'POST') {
    const { data: id, error } = await sb.rpc('save_delay_record', { p_id: null, p: body || {} });
    if (error) throw dbError(error);
    return { record: await getRecord(id) };
  }
  if ((m = path.match(/^\/api\/records\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'GET') return { record: await getRecord(id) };
    if (method === 'PUT') {
      const { error } = await sb.rpc('save_delay_record', { p_id: id, p: body || {} });
      if (error) throw dbError(error);
      return { record: await getRecord(id) };
    }
    if (method === 'DELETE') {
      if (!['duty_manager', 'admin'].includes(me.role)) throw new ApiError('Insufficient permissions', 403);
      const { data, error } = await sb.from('delay_records').delete().eq('id', id).select('id');
      if (error) throw dbError(error);
      if (!data.length) throw new ApiError('Insufficient permissions', 403);
      return { ok: true };
    }
  }

  if (path === '/api/defects' || path === '/api/flight-counts') {
    const table = path === '/api/defects' ? 'aircraft_defects' : 'flight_counts';
    if (method === 'GET') {
      let query = sb.from(table).select('*');
      query = q.get('date') ? query.eq('record_date', q.get('date')) : query.order('record_date', { ascending: false });
      const { data, error } = await query;
      if (error) throw dbError(error);
      return table === 'aircraft_defects' ? { defects: data } : { flightCounts: data };
    }
    if (method === 'POST') {
      const b = body || {};
      if (!b.record_date || !b.aoc) throw new ApiError('record_date and aoc are required', 400);
      const meta = await loadMeta();
      if (!meta.aocs.some((a) => a.code === b.aoc)) throw new ApiError('Unknown AOC code', 400);
      if (table === 'aircraft_defects') {
        const row = await upsertDailyFigure(table, {
          record_date: b.record_date, aoc: b.aoc, defect_count: Number(b.defect_count) || 0, notes: b.notes || null,
        });
        return { defect: row };
      }
      const row = await upsertDailyFigure(table, { record_date: b.record_date, aoc: b.aoc, pax_flights: Number(b.pax_flights) || 0 });
      return { flightCount: row };
    }
  }

  if (path === '/api/report/recent-delays') return recentDelays(q);
  if (path === '/api/report/generate') return buildReport(q);

  if (path === '/api/admin/users') {
    if (me.role !== 'admin') throw new ApiError('Insufficient permissions', 403);
    if (method === 'GET') {
      const { data, error } = await sb.from('profiles')
        .select('id, username, full_name, role, aoc, active, created_at').order('created_at');
      if (error) throw dbError(error);
      // The old server returned active as 1/0; the Admin tab relies on that.
      return { users: data.map((u) => ({ ...u, active: u.active ? 1 : 0 })) };
    }
    if (method === 'POST') return invokeAdmin({ action: 'create', ...(body || {}) });
  }
  if ((m = path.match(/^\/api\/admin\/users\/([0-9a-f-]{36})$/)) && method === 'PATCH') {
    if (me.role !== 'admin') throw new ApiError('Insufficient permissions', 403);
    return invokeAdmin({ action: 'update', id: m[1], ...(body || {}) });
  }

  if (path === '/api/account/password' && method === 'POST') {
    const { currentPassword, newPassword } = body || {};
    if (!currentPassword || !newPassword || newPassword.length < 8) {
      throw new ApiError('New password must be at least 8 characters', 400);
    }
    const session = await requireSession();
    const { error: reauthErr } = await sb.auth.signInWithPassword({ email: session.user.email, password: currentPassword });
    if (reauthErr) throw new ApiError('Current password is incorrect', 401);
    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) throw new ApiError(error.message, 400);
    return { ok: true };
  }

  throw new ApiError('Not found', 404);
}

async function apiFetch(url, opts = {}) {
  const u = new URL(url, window.location.origin);
  const method = (opts.method || 'GET').toUpperCase();
  let body = opts.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  try {
    return await routeApi(method, u.pathname, u.searchParams, body);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && u.pathname !== '/api/account/password') {
      goToLogin(err.message === 'Account disabled' ? 'disabled' : (err.message === 'Session expired' ? 'expired' : ''));
      throw new Error('Not authenticated');
    }
    throw err;
  }
}

  // Public API used by app.js and login.js
  window.sb = sb;
  window.apiFetch = apiFetch;
  window.usernameToEmail = usernameToEmail;
  window.storageSet = storageSet;
  window.LOGIN_AT_KEY = LOGIN_AT_KEY;
})();

function todayStr() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

function fmtDateLabel(iso) {
  const [y, m, d] = iso.split('-');
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${d}-${months[Number(m) - 1]}-${y}`;
}

// Escapes text that will be inserted into innerHTML as literal characters
// rather than markup.
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
