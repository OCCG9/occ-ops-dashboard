# Putting the OCC Dashboard online (GitHub Pages + Supabase)

When you're done, your team opens one web address, for example
`https://YOUR-GITHUB-USERNAME.github.io/occ-ops-dashboard/`. Each person
logs in with their own username, and everyone shares the same records.

| Piece | What it does | Cost |
|---|---|---|
| **GitHub Pages** | Hosts the website (the screens) over HTTPS | Free (public repository) |
| **Supabase** | Stores the data and handles logins | Free tier: 500 MB database |

Allow about **30–40 minutes** the first time. Do the steps in order.
Supabase menu names occasionally move around, so if a button isn't exactly
where described, look for the closest match.

---

## Part A — Supabase (database + logins)

### A1. Create the project
1. Go to **supabase.com** → **Start your project** → sign up (use
   **Continue with GitHub** once you have a GitHub account, or your email).
2. **New project**:
   - **Name:** `occ-ops-dashboard`
   - **Database password:** click **Generate**, then save it in a password manager.
     You won't need it day to day.
   - **Region:** the closest to your team that's offered.
3. Click **Create new project** and wait 1–2 minutes for it to finish.

### A2. Lock down sign-ups (important)
In **Authentication** → **Sign In / Providers** (sometimes under **Settings**):
1. Turn **OFF** "**Allow new users to sign up**". Only admins should be able to
   create accounts.
2. Under **Email**, turn **OFF** "**Confirm email**". Staff accounts use
   usernames, not real inboxes.
3. Set **Minimum password length** to **8** or more, if the option is shown.

### A3. Create the tables and security rules
1. Open **SQL Editor** → **New query**.
2. Open the file `supabase/schema.sql` from this folder, copy **all** of it,
   paste it in and click **Run**.
3. You should see "Success. No rows returned".

### A4. Create your admin login
1. **Authentication** → **Users** → **Add user** → **Create new user**.
2. Enter **your work email** and a **strong password**, and tick **Auto Confirm User**.
3. Click **Create user**.

The very first account created becomes the **administrator** automatically.
Accounts created any other way start disabled until an admin enables them.

### A5. Add the "admin-users" function (lets the Admin tab create staff)
1. Open **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `admin-users`.
3. Delete the sample code, then paste in **all** of
   `supabase/functions/admin-users/index.ts` from this folder.
4. Click **Deploy function**.
5. Go to **Edge Functions** → **Secrets** and add:
   - `ALLOWED_ORIGIN` = `https://YOUR-GITHUB-USERNAME.github.io`
     (use exactly that: no trailing slash, no `/occ-ops-dashboard`)

### A6. Copy two values for the website
Open **Project Settings** → **API Keys** (or the **Connect** button at the top) and copy:
- **Project URL**, which looks like `https://abcdefgh.supabase.co`
- The **publishable** key (or the **anon public** key on older screens)

⚠️ **Never** copy the `service_role` / **secret** key into the website.

### A7. Put them in `js/config.js`
Open `js/config.js` in Notepad and replace:
```js
SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
SUPABASE_ANON_KEY: 'YOUR-ANON-OR-PUBLISHABLE-KEY',
```
with your two values. Save the file.

---

## Part B — GitHub Pages (the website)

### B1. Create the repository
1. Sign up or sign in at **github.com**. **Your username becomes part of the
   web address**, so pick it with that in mind.
2. **+** (top-right) → **New repository**.
   - **Name:** `occ-ops-dashboard`. This becomes the end of the address.
   - **Public** (required for free GitHub Pages). The code contains no data and
     no secrets; all records stay protected in Supabase.
3. Click **Create repository**.

### B2. Upload the files
1. On the new repository page, click **uploading an existing file**.
2. Drag in **everything inside this folder**: `index.html`, `login.html`,
   `css`, `js`, `supabase`, `.nojekyll`, `README.md` and this guide. Drag the
   contents, not the folder that contains them. Make sure `js/config.js` has
   your values from step A7.
3. Click **Commit changes**.

> `.nojekyll` is a hidden file. If Windows Explorer doesn't show it, choose
> View → Show → Hidden items. It isn't critical, but it's better to include it.

### B3. Turn on Pages
1. Open the repository's **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**,
   choose branch **main** and folder **/(root)**, then click **Save**.
3. After 1–2 minutes the page shows **"Your site is live at …"**. That's your link.

### B4. Tell Supabase the address
In Supabase, open **Authentication** → **URL Configuration**. Set **Site URL** to
your Pages link, for example `https://YOUR-GITHUB-USERNAME.github.io/occ-ops-dashboard/`.

---

## Part C — First login

1. Open your link → log in with the **email** and password from step A4.
2. Open the **Admin** tab and create accounts for shift staff and duty managers.
   They log in with the **username** you give them (no email needed).
3. Share the link with the team.

**Roles (same as before):** shift users log entries and edit their own; duty
managers can edit or delete any record; admins can also manage users. Logins
expire after 12 hours.

---

## Updating the site later
In the GitHub repository, open the file → click the ✏️ pencil → edit → **Commit
changes**. Alternatively, use **Add file → Upload files** to replace files.
The live site updates within about a minute.

## Good to know
- **Inactivity pause:** Supabase's free tier pauses a project after **7 days with
  no use**. Normal daily use prevents this. If it does pause, open the Supabase
  dashboard and click **Restore**; your data is kept.
- **Backups:** download a copy now and then. In Supabase, open **Table Editor**,
  select a table, then use **Export → CSV**.
  `delay_records` is the important one.
- **Forgotten passwords:** an admin resets them. Ask me if you'd like a "reset
  password" button added to the Admin tab. (The function already supports it.)
- **Custom domain later** (e.g. `occ.airarabia.com`): in the repo's **Settings → Pages
  → Custom domain**, plus one DNS record from Air Arabia IT. If you do this,
  update `ALLOWED_ORIGIN` (A5) and the Site URL (B4) to the new address.

## Troubleshooting
| Problem | Fix |
|---|---|
| Login page shows but login fails with no message | Check `js/config.js` has the right Project URL and key, with no extra spaces. |
| Admin tab: "Invalid JWT" or "Failed to send a request" when creating users | Edge Functions → `admin-users` → settings → turn **off** "Verify JWT" / "Enforce JWT verification". The function already checks the login itself. Also check that `ALLOWED_ORIGIN` exactly matches `https://YOUR-GITHUB-USERNAME.github.io`. |
| Creating a user says the email is invalid | Add the secret `USERNAME_EMAIL_DOMAIN` = `occ-users.example.org` (any domain-style text) to the function, and set the same value for `USERNAME_EMAIL_DOMAIN` in `js/config.js`. Do this **before** creating staff accounts. |
| Everything shows empty after a week of no use | The Supabase project is paused. Open the dashboard and click Restore. |
