import { createClient } from '@supabase/supabase-js';

const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
const supabaseServiceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseServiceRoleKey);

export const supabaseAdmin = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
  : null;

export function requireSupabaseAdmin() {
  if (!supabaseAdmin) {
    const error = new Error('Supabase no está configurado. Añade SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en .env.');
    error.statusCode = 503;
    throw error;
  }

  return supabaseAdmin;
}
