// Public settings for the Reactivation page: Mission Control's own Supabase
// project and publishable key (the same as assets/mc/01-core.js). Row level
// security decides what anyone can read. sharedNumber is filled in at start
// from Twilio Settings (business_settings.twilio_from_number).
window.RX_CONFIG = {
  supabaseUrl: 'https://wmegoygrancfwxagqskh.supabase.co',
  supabaseKey: 'sb_publishable_UHQNxVCjHJnFjssYwTiwcQ_3FYovX8I',
  sharedNumber: '',
};
