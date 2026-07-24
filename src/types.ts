export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  RESEND_API_KEY: string;
}

export interface ResumenPersona {
  nombre?: string;
  email?: string;
}

export interface ResumenTriggerMessage {
  folder: string;
  recording_id: string;
  r2_key: string;
  title: string;
  created_at: string;
  share_url: string;
  recorded_by: ResumenPersona | null;
  invitees: ResumenPersona[];
}

export interface ResumenRecord {
  recording_id: string;
  folder: string;
  title: string | null;
  created_at: string | null;
  share_url: string | null;
  resumen_texto: string | null;
  destinatarios: string | null;
  resend_id: string | null;
  status: 'pendiente' | 'enviado' | 'sin_destinatarios' | 'error';
  error: string | null;
  procesado_en: string | null;
}
