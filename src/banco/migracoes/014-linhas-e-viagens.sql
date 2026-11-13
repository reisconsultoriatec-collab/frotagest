-- =====================================================================
--  FrotaGest 1.15 — linhas, rotas e horários: a sequência de pontos com o tempo previsto até cada um,
--  as partidas (horário, dias, veículo) e as viagens do dia acompanhadas pelo GPS: adiantado/atrasado,
--  ponto pulado e fora da rota.
-- =====================================================================

CREATE TABLE IF NOT EXISTS linhas (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  grupo_id INT UNSIGNED NULL,
  codigo VARCHAR(20) NULL,
  nome VARCHAR(100) NOT NULL,
  cor CHAR(7) NULL,
  percurso MEDIUMTEXT NULL,
  corredor_m SMALLINT UNSIGNED NOT NULL DEFAULT 200,
  tolerancia_adiantado_min TINYINT UNSIGNED NOT NULL DEFAULT 2,
  tolerancia_atraso_min TINYINT UNSIGNED NOT NULL DEFAULT 5,
  alerta_fora_rota TINYINT(1) NOT NULL DEFAULT 1,
  alerta_atraso_min SMALLINT UNSIGNED NULL,
  alerta_ponto_pulado TINYINT(1) NOT NULL DEFAULT 0,
  observacao VARCHAR(500) NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em DATETIME NOT NULL,
  atualizado_em DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_linhas_empresa (empresa_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pontos na ordem: nome, lugar, raio e o tempo previsto desde a partida (minutos)
CREATE TABLE IF NOT EXISTS linha_pontos (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  linha_id INT UNSIGNED NOT NULL,
  ordem SMALLINT UNSIGNED NOT NULL,
  nome VARCHAR(80) NOT NULL,
  latitude DECIMAL(9,6) NOT NULL,
  longitude DECIMAL(9,6) NOT NULL,
  raio_m SMALLINT UNSIGNED NOT NULL DEFAULT 60,
  minutos SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_linha_pontos (linha_id, ordem)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Partidas: horário de saída do primeiro ponto, dias da semana (1 = segunda ... 7 = domingo) e o veículo da escala
CREATE TABLE IF NOT EXISTS linha_partidas (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  linha_id INT UNSIGNED NOT NULL,
  horario TIME NOT NULL,
  dias VARCHAR(7) NOT NULL DEFAULT '12345',
  veiculo_id INT UNSIGNED NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY ix_linha_partidas (linha_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Viagens do dia (uma por partida e data) e o que aconteceu em cada ponto
CREATE TABLE IF NOT EXISTS viagens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  linha_id INT UNSIGNED NOT NULL,
  partida_id INT UNSIGNED NULL,
  data DATE NOT NULL,
  previsto_inicio DATETIME NOT NULL,
  previsto_fim DATETIME NOT NULL,
  veiculo_id INT UNSIGNED NULL,
  veiculo_origem VARCHAR(10) NULL,
  situacao ENUM('prevista','em_andamento','concluida','incompleta','nao_realizada','cancelada') NOT NULL DEFAULT 'prevista',
  inicio_real DATETIME NULL,
  fim_real DATETIME NULL,
  pontos_total SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  pontos_passados SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  pontos_pulados SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  atraso_atual_seg INT NULL,
  atraso_max_seg INT NULL,
  fora_rota_seg INT UNSIGNED NOT NULL DEFAULT 0,
  observacao VARCHAR(300) NULL,
  atualizado_em DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_viagens_partida (partida_id, data),
  KEY ix_viagens_empresa (empresa_id, data),
  KEY ix_viagens_linha (linha_id, data),
  KEY ix_viagens_veiculo (veiculo_id, data)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS viagem_pontos (
  viagem_id BIGINT UNSIGNED NOT NULL,
  ordem SMALLINT UNSIGNED NOT NULL,
  nome VARCHAR(80) NOT NULL,
  previsto DATETIME NOT NULL,
  realizado DATETIME NULL,
  situacao ENUM('pendente','no_horario','adiantado','atrasado','pulado') NOT NULL DEFAULT 'pendente',
  diferenca_seg INT NULL,
  PRIMARY KEY (viagem_id, ordem)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
