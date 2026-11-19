-- =====================================================================
--  FrotaGest 1.19 — Guia do FrotaGest: o que cada pessoa já leu no manual,
--  os tours que fez e as boas-vindas (vale em qualquer computador ou celular).
--  Só acrescenta; nada do que já existe muda.
-- =====================================================================

CREATE TABLE IF NOT EXISTS usuario_ajuda (
  usuario_id INT UNSIGNED NOT NULL,
  chave VARCHAR(80) NOT NULL,
  feito_em DATETIME NOT NULL,
  PRIMARY KEY (usuario_id, chave)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
