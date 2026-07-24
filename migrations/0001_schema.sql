-- Fathom Resumen · SuperLeads — D1 Schema

CREATE TABLE IF NOT EXISTS resumenes (
  recording_id   TEXT PRIMARY KEY,
  folder         TEXT NOT NULL,
  title          TEXT,
  created_at     TEXT,
  share_url      TEXT,
  resumen_texto  TEXT,
  destinatarios  TEXT,          -- JSON array de emails a los que se envió
  resend_id      TEXT,
  status         TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente | enviado | sin_destinatarios | error
  error          TEXT,
  procesado_en   TEXT
);

CREATE TABLE IF NOT EXISTS logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  level         TEXT NOT NULL,
  message       TEXT NOT NULL,
  recording_id  TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resumenes_folder ON resumenes(folder);
CREATE INDEX IF NOT EXISTS idx_resumenes_status ON resumenes(status);
