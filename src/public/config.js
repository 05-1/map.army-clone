// Tacmap settings. Edit the two values below, commit, and reload the site.
//
// Where to find them: supabase.com > your project > Project Settings > API.
//   supabaseUrl      the "Project URL", e.g. https://abcdefghijklmnop.supabase.co
//                    (just that: no /rest/v1/ on the end. Opening it in a browser tab shows an error; that is normal.)
//   supabaseAnonKey  the "anon" / "publishable" key
//
// Both values are meant to be public: every visitor's browser needs them, and row level security
// in the database decides what a visitor may do. NEVER put the service_role / secret key here.
window.TACMAP_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-KEY',
};
