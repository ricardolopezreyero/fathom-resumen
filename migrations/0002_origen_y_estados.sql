-- Fathom Resumen · SuperLeads — registra quién es el origen (De/Reply-To)
-- de cada resumen enviado, y agrega los nuevos estados de las guardas de
-- calidad (sin_contraparte, sin_contenido).

ALTER TABLE resumenes ADD COLUMN origen_nombre TEXT;
ALTER TABLE resumenes ADD COLUMN origen_email TEXT;
