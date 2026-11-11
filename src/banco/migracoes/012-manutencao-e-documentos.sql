-- =====================================================================
--  FrotaGest 1.13 — manutenção (por km e/ou tempo) e vencimento de documentos
--  Tudo opcional: sem plano nem documento cadastrado, nada muda na operação.
-- =====================================================================

-- Planos de manutenção: "troca de óleo a cada 10.000 km ou 6 meses". Vale para a empresa toda
-- (grupo_id e veiculo_id nulos), para um grupo (e os subgrupos) ou para um veículo.
CREATE TABLE IF NOT EXISTS manutencao_planos (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  grupo_id INT UNSIGNED NULL,
  veiculo_id INT UNSIGNED NULL,
  nome VARCHAR(80) NOT NULL,
  intervalo_km INT UNSIGNED NULL,
  intervalo_dias INT UNSIGNED NULL,   -- de quanto em quanto tempo: em dias ou em meses (um dos dois)
  intervalo_meses INT UNSIGNED NULL,
  avisar_km INT UNSIGNED NULL,
  avisar_dias INT UNSIGNED NULL,
  observacao VARCHAR(500) NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em DATETIME NOT NULL,
  atualizado_em DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_manut_planos_empresa (empresa_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Manutenções feitas (de um plano ou avulsas): a próxima do plano conta a partir da última.
CREATE TABLE IF NOT EXISTS manutencoes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  veiculo_id INT UNSIGNED NOT NULL,
  plano_id INT UNSIGNED NULL,
  descricao VARCHAR(120) NOT NULL,
  data DATE NOT NULL,
  hodometro INT UNSIGNED NULL,
  custo DECIMAL(12,2) NULL,
  oficina VARCHAR(80) NULL,
  observacao VARCHAR(500) NULL,
  usuario_id INT UNSIGNED NULL,
  criado_em DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY ix_manutencoes_veiculo (veiculo_id, plano_id, data),
  KEY ix_manutencoes_empresa (empresa_id, data)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Documentos com vencimento: do veículo (licenciamento, seguro, tacógrafo...) ou do motorista
-- (exame toxicológico, cursos...). A CNH vem do cadastro do motorista.
CREATE TABLE IF NOT EXISTS documentos (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  veiculo_id INT UNSIGNED NULL,
  motorista_id INT UNSIGNED NULL,
  tipo VARCHAR(20) NOT NULL,
  descricao VARCHAR(80) NULL,
  numero VARCHAR(40) NULL,
  vencimento DATE NOT NULL,
  avisar_dias SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  observacao VARCHAR(500) NULL,
  usuario_id INT UNSIGNED NULL,
  criado_em DATETIME NOT NULL,
  atualizado_em DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_documentos_empresa (empresa_id),
  KEY ix_documentos_veiculo (veiculo_id),
  KEY ix_documentos_motorista (motorista_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Resumo diário no celular (só para quem tem a tela Manutenção e ativou os avisos)
ALTER TABLE usuarios ADD COLUMN push_manutencao TINYINT(1) NOT NULL DEFAULT 1;
