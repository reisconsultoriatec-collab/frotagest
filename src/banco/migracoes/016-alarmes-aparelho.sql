-- =====================================================================
--  FrotaGest 1.17 — alarmes do próprio aparelho (DVR) que a empresa não quer registrar como alerta.
--  A posição continua guardando os bits de alarme; só não abre alerta nem manda aviso.
-- =====================================================================

CREATE TABLE IF NOT EXISTS alarmes_aparelho_ignorados (
  empresa_id INT UNSIGNED NOT NULL,
  codigo VARCHAR(8) NOT NULL,
  criado_por INT UNSIGNED NULL,
  criado_em DATETIME NOT NULL,
  PRIMARY KEY (empresa_id, codigo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
