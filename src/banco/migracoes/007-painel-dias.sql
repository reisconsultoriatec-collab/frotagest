-- =====================================================================
--  FrotaGest 1.8 — resumo diário por veículo (dashboard do Início)
--  Cada dia fechado guarda os totais por veículo, calculados das posições com a mesma
--  conta dos relatórios. O dia de hoje é calculado ao vivo (não fica aqui).
-- =====================================================================

CREATE TABLE IF NOT EXISTS painel_dias (
  dia DATE NOT NULL,
  veiculo_id INT UNSIGNED NOT NULL,
  km DECIMAL(9,2) NOT NULL DEFAULT 0,
  ligado_seg INT UNSIGNED NOT NULL DEFAULT 0,
  movimento_seg INT UNSIGNED NOT NULL DEFAULT 0,
  vel_max DECIMAL(5,1) NOT NULL DEFAULT 0,
  excessos INT UNSIGNED NOT NULL DEFAULT 0,
  alertas INT UNSIGNED NOT NULL DEFAULT 0,
  km_horas VARCHAR(400) NULL, -- km de cada hora do dia (24 números separados por vírgula)
  PRIMARY KEY (dia, veiculo_id),
  KEY ix_painel_dias_veiculo (veiculo_id, dia)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- dias já fechados (inclusive os sem nenhuma posição), para não recalcular a cada reinício
CREATE TABLE IF NOT EXISTS painel_dias_ok (
  dia DATE NOT NULL,
  fechado_em DATETIME NOT NULL,
  PRIMARY KEY (dia)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
