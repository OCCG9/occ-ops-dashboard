// =====================================================================
// Site configuration - the ONLY file you need to edit after setup.
// =====================================================================
// Copy these two values from Supabase: Project Settings > API (or
// "Connect" > App frameworks). The anon / publishable key is DESIGNED to
// be public - it is safe in this file because every table is locked down
// by the database security rules in supabase/schema.sql.
//
// NEVER put the "service_role" / "secret" key in this file.
// =====================================================================
window.OCC_CONFIG = {
  SUPABASE_URL: 'https://gcctabwzeihmstcjycji.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable__zHdlkKBEnckfD7C_cdAVg_IOEfxrXS',

  // Staff log in with a plain username; behind the scenes Supabase needs an
  // email-shaped login, so "ali" becomes "ali@<this domain>". No email is
  // ever sent to it. Must match USERNAME_EMAIL_DOMAIN in the admin-users
  // function (if you set one there).
  USERNAME_EMAIL_DOMAIN: 'occ-dashboard.invalid',

  // Same as the old server: you are logged out after 12 hours.
  SESSION_MAX_HOURS: 12,
};
