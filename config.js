// Connects the website to your Supabase database.
// Supabase > your project > Project Settings > API (or "Data API" / "API Keys"):
//   url: the Project URL, like https://abcdefgh.supabase.co
//   key: the "anon public" key or the "publishable" key (starts with eyJ... or sb_publishable_...)
// This key is meant to be public. The database rules decide what each signed-in person can do.
// Never paste the "service_role" or "secret" key here.
window.DG_CONFIG = {
  url: "PASTE_YOUR_PROJECT_URL_HERE",
  key: "PASTE_YOUR_ANON_OR_PUBLISHABLE_KEY_HERE"
};
