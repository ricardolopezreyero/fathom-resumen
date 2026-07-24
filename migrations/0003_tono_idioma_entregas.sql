-- Fathom Resumen · SuperLeads
-- Tono/idioma detectados por el motor (visibilidad en el dashboard), y
-- rastreo de entregas/rebotes/quejas de Resend para proteger la reputación
-- del dominio y evitar seguir escribiéndole a direcciones muertas.

ALTER TABLE resumenes ADD COLUMN tono TEXT;
ALTER TABLE resumenes ADD COLUMN idioma TEXT;

CREATE TABLE IF NOT EXISTS envios (
  resend_id     TEXT PRIMARY KEY,
  recording_id  TEXT NOT NULL,
  email         TEXT NOT NULL,
  estado        TEXT NOT NULL DEFAULT 'enviado',  -- enviado | entregado | rebotado | quejado | retrasado
  detalle       TEXT,
  actualizado   TEXT
);
CREATE INDEX IF NOT EXISTS idx_envios_recording ON envios(recording_id);
CREATE INDEX IF NOT EXISTS idx_envios_email ON envios(email);

CREATE TABLE IF NOT EXISTS bloqueados (
  email          TEXT PRIMARY KEY,
  motivo         TEXT NOT NULL,   -- rebote | queja
  detalle        TEXT,
  bloqueado_en   TEXT NOT NULL
);
