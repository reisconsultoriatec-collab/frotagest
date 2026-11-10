-- =====================================================================
--  FrotaGest 1.6 — logotipo de cada empresa cliente
--  PNG (com transparência) para a tela e JPEG (fundo branco) para os PDFs.
--  Imagens pequenas (no máximo 600 x 240): ficam no banco, junto do backup.
-- =====================================================================

CREATE TABLE IF NOT EXISTS empresas_logo (
  empresa_id INT UNSIGNED NOT NULL,
  png MEDIUMBLOB NOT NULL,
  jpg MEDIUMBLOB NOT NULL,
  largura SMALLINT UNSIGNED NOT NULL,
  altura SMALLINT UNSIGNED NOT NULL,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  atualizado_por INT UNSIGNED NULL,
  PRIMARY KEY (empresa_id),
  CONSTRAINT fk_empresas_logo_empresa FOREIGN KEY (empresa_id) REFERENCES empresas (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
