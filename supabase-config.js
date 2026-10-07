/* ============================================================
   SUPABASE CONFIG
   ------------------------------------------------------------
   Fill these in with the values from your Supabase project:

     Supabase dashboard → Project Settings → API
       • Project URL          → SUPABASE_URL
       • anon / publishable key → SUPABASE_ANON_KEY

   Both of these are SAFE to expose in client-side code — they are
   public by design (access is limited by Row Level Security). The
   service_role key is NOT safe here; never put it in this file.

   Leave both blank to disable cloud sync: the app then runs in
   purely-local mode (localStorage) with no sign-in button.
   ============================================================ */

window.SUPABASE_CONFIG = {
  url: "",       // e.g. "https://abcdefghijklm.supabase.co"
  anonKey: "",   // e.g. "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...."
};

// Convenience: is cloud sync configured?
window.SUPABASE_CONFIG.enabled =
  Boolean(window.SUPABASE_CONFIG.url && window.SUPABASE_CONFIG.anonKey);
