// RLR
export interface Env {
  DB: D1Database;
  // Réplica de solo-lectura de la base de fanthom-superleads — se usa
  // únicamente para reconstruir un disparo y reintentarlo manualmente
  // (ver /reintentar en index.ts). Nunca se escribe en ella desde aquí.
  FANTHOM_DB: D1Database;
  R2: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET: string;
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
  // Identidad registrada del colaborador dueño de la cuenta Fathom que generó
  // esta transcripción — fuente de verdad preferida para el "De"/Reply-To.
  colaborador_nombre?: string;
  colaborador_email?: string | null;
}

export type ResumenStatus =
  | 'pendiente'
  | 'enviado'
  | 'en_revision'   // tono tenso — retenido para aprobación humana
  | 'sin_destinatarios'
  | 'sin_contraparte'
  | 'sin_contenido'
  | 'error';

export interface ResumenRecord {
  recording_id: string;
  folder: string;
  title: string | null;
  created_at: string | null;
  share_url: string | null;
  resumen_texto: string | null;
  destinatarios: string | null;
  resend_id: string | null;
  origen_nombre: string | null;
  origen_email: string | null;
  tono: string | null;
  idioma: string | null;
  status: ResumenStatus;
  error: string | null;
  procesado_en: string | null;
}

export type EstadoEnvio = 'enviado' | 'entregado' | 'rebotado' | 'quejado' | 'retrasado';

export interface EnvioRecord {
  resend_id: string;
  recording_id: string;
  email: string;
  estado: EstadoEnvio;
  detalle: string | null;
  actualizado: string | null;
}
