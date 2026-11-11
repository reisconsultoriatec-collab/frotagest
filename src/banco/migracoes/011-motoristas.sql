-- =====================================================================
--  FrotaGest 1.12 — motoristas, quem está em cada veículo e a jornada
-- =====================================================================

-- Motoristas da empresa. Só o nome é obrigatório; a CNH e o cartão são opcionais.
CREATE TABLE IF NOT EXISTS motoristas (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  grupo_id INT UNSIGNED NULL,
  nome VARCHAR(120) NOT NULL,
  matricula VARCHAR(30) NULL,
  telefone VARCHAR(20) NULL,
  cnh_numero VARCHAR(20) NULL,
  cnh_categoria VARCHAR(5) NULL,
  cnh_validade DATE NULL,
  cartao VARCHAR(40) NULL,
  observacao VARCHAR(500) NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_motoristas_empresa (empresa_id),
  KEY ix_motoristas_cartao (empresa_id, cartao)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Quem dirigiu cada veículo e quando (fim NULL = está no veículo agora).
-- origem: 'manual' (escolhido no painel) ou 'cartao' (o motorista passou o cartão no DVR).
CREATE TABLE IF NOT EXISTS motorista_vinculos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  veiculo_id INT UNSIGNED NOT NULL,
  motorista_id INT UNSIGNED NOT NULL,
  inicio DATETIME NOT NULL,
  fim DATETIME NULL,
  origem VARCHAR(10) NOT NULL DEFAULT 'manual',
  usuario_id INT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_vinculos_veiculo (veiculo_id, inicio),
  KEY ix_vinculos_motorista (motorista_id, inicio),
  KEY ix_vinculos_fim (fim)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cartões que o DVR leu e que não estão no cadastro (para cadastrar com um clique).
CREATE TABLE IF NOT EXISTS motorista_cartoes_lidos (
  empresa_id INT UNSIGNED NOT NULL,
  cartao VARCHAR(40) NOT NULL,
  nome_lido VARCHAR(120) NULL,
  aparelho_id INT UNSIGNED NULL,
  lido_em DATETIME NOT NULL,
  vezes INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (empresa_id, cartao)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- O alerta guarda quem estava dirigindo.
ALTER TABLE alertas ADD COLUMN motorista_id INT UNSIGNED NULL;

-- Regra nova: direção contínua sem descanso (Lei do Motorista).
ALTER TABLE regras_alerta MODIFY COLUMN tipo ENUM('velocidade','fora_horario','parada','ociosidade','sem_comunicacao','direcao_continua') NOT NULL;
ALTER TABLE regras_alerta ADD COLUMN descanso_seg INT UNSIGNED NULL;
