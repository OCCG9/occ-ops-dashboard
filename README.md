# OCC Daily Operations Dashboard

Shift-based delay and incident logging, plus the daily management snapshot report for AOCs G9, E5, 3L, 3O, 9P and 4P.

This version is a static website hosted on **GitHub Pages**. Data and logins live in **Supabase**. To set it up, see **[SETUP-GUIDE.md](SETUP-GUIDE.md)**.

## Layout
| Path | Purpose |
|---|---|
| `index.html`, `login.html`, `css/`, `js/` | The website |
| `js/config.js` | The only file to edit: Supabase project URL and public key |
| `js/common.js` | Connects the app to Supabase (replaces the old Node server API) |
| `js/vendor/supabase.js` | Supabase client library v2.117.3, bundled so no third-party CDN is needed |
| `supabase/schema.sql` | Database tables and all security rules (run once in the SQL Editor) |
| `supabase/functions/admin-users/index.ts` | Admin-only function for creating and managing staff accounts |

## Security model
- All access rules are enforced **inside the database** (Row Level Security), not just in the browser:
  - anonymous visitors get nothing
  - shift users edit only their own records
  - duty managers and admins can edit and delete any record
  - only admins manage users
- "Entered by" is stamped from the logged-in account and can't be forged.
- Public sign-up is disabled. New accounts are created by an admin, and anything created any other way starts disabled.
- Logins expire after 12 hours. Supabase rate-limits repeated failed logins.
- A strict Content-Security-Policy blocks injected scripts, and all user-entered text is escaped before it's displayed.
- The repository contains no secrets. The publishable/anon key is public by design. The service-role key lives only inside Supabase.
