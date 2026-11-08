-- =====================================================================
--  FrotaGest — estrutura base do banco (MySQL 9, InnoDB, utf8mb4)
--  Reis Tecnologia
--
--  Regra do sistema: NENHUM vídeo é gravado no banco. Aqui ficam só
--  cadastros, posições, alertas, comunicações e auditoria.
--  Todas as datas estão no horário de Brasília (o servidor ajusta a sessão).
-- =====================================================================

-- ---------- cadastros ----------

CREATE TABLE IF NOT EXISTS empresas (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  nome VARCHAR(120) NOT NULL,
  documento VARCHAR(20) NULL,
  contato VARCHAR(120) NULL,
  telefone VARCHAR(30) NULL,
  email VARCHAR(160) NULL,
  cidade VARCHAR(80) NULL,
  uf CHAR(2) NULL,
  observacao VARCHAR(500) NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_empresas_documento (documento)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS usuarios (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NULL,
  firebase_uid VARCHAR(128) NULL,
  email VARCHAR(160) NOT NULL,
  nome VARCHAR(120) NOT NULL,
  perfil ENUM('master','admin','operador','visualizador') NOT NULL,
  todos_grupos TINYINT(1) NOT NULL DEFAULT 1,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  ultimo_acesso DATETIME NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_usuarios_email (email),
  UNIQUE KEY uq_usuarios_uid (firebase_uid),
  KEY ix_usuarios_empresa (empresa_id),
  CONSTRAINT fk_usuarios_empresa FOREIGN KEY (empresa_id) REFERENCES empresas (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS grupos (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  pai_id INT UNSIGNED NULL,
  nome VARCHAR(80) NOT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_grupos_empresa (empresa_id),
  KEY ix_grupos_pai (pai_id),
  CONSTRAINT fk_grupos_empresa FOREIGN KEY (empresa_id) REFERENCES empresas (id),
  CONSTRAINT fk_grupos_pai FOREIGN KEY (pai_id) REFERENCES grupos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS usuario_grupos (
  usuario_id INT UNSIGNED NOT NULL,
  grupo_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (usuario_id, grupo_id),
  KEY ix_usuario_grupos_grupo (grupo_id),
  CONSTRAINT fk_ug_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE,
  CONSTRAINT fk_ug_grupo FOREIGN KEY (grupo_id) REFERENCES grupos (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Perfis de protocolo: em que portas o servidor escuta e como fala com cada tipo de aparelho.
-- O padrão é o JT/T 808 (2013/2019, detectado sozinho) com vídeo JT/T 1078, portas 6608/6602.
CREATE TABLE IF NOT EXISTS perfis_protocolo (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  nome VARCHAR(80) NOT NULL,
  protocolo VARCHAR(30) NOT NULL DEFAULT 'jt808',
  protocolo_video VARCHAR(30) NOT NULL DEFAULT 'jt1078',
  porta_sinalizacao SMALLINT UNSIGNED NOT NULL,
  porta_video SMALLINT UNSIGNED NOT NULL,
  endereco_video VARCHAR(120) NULL,
  fuso_minutos SMALLINT NOT NULL DEFAULT -180,
  padrao TINYINT(1) NOT NULL DEFAULT 0,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  observacao VARCHAR(255) NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_perfis_porta (porta_sinalizacao)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO perfis_protocolo (id, nome, protocolo, protocolo_video, porta_sinalizacao, porta_video, fuso_minutos, padrao, ativo, observacao)
VALUES (1, 'JT/T 808 + JT/T 1078 (padrão)', 'jt808', 'jt1078', 6608, 6602, -180, 1, 1, 'DVRs 4G (JT/T 808-2013/2019 com vídeo JT/T 1078)');

CREATE TABLE IF NOT EXISTS aparelhos (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  perfil_id INT UNSIGNED NOT NULL,
  identificador VARCHAR(20) NOT NULL,
  fabricante VARCHAR(60) NULL,
  modelo VARCHAR(60) NULL,
  numero_serie VARCHAR(60) NULL,
  canais TINYINT UNSIGNED NOT NULL DEFAULT 4,
  nomes_canais JSON NULL,
  chip_numero VARCHAR(20) NULL,
  chip_operadora VARCHAR(30) NULL,
  observacao VARCHAR(500) NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_aparelhos_identificador (identificador),
  KEY ix_aparelhos_empresa (empresa_id),
  CONSTRAINT fk_aparelhos_empresa FOREIGN KEY (empresa_id) REFERENCES empresas (id),
  CONSTRAINT fk_aparelhos_perfil FOREIGN KEY (perfil_id) REFERENCES perfis_protocolo (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS veiculos (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  grupo_id INT UNSIGNED NULL,
  aparelho_id INT UNSIGNED NULL,
  placa VARCHAR(10) NOT NULL,
  prefixo VARCHAR(20) NULL,
  descricao VARCHAR(120) NULL,
  tipo VARCHAR(30) NULL,
  ano SMALLINT UNSIGNED NULL,
  cor VARCHAR(30) NULL,
  chassi VARCHAR(30) NULL,
  observacao VARCHAR(500) NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_veiculos_placa (empresa_id, placa),
  UNIQUE KEY uq_veiculos_aparelho (aparelho_id),
  KEY ix_veiculos_grupo (grupo_id),
  CONSTRAINT fk_veiculos_empresa FOREIGN KEY (empresa_id) REFERENCES empresas (id),
  CONSTRAINT fk_veiculos_grupo FOREIGN KEY (grupo_id) REFERENCES grupos (id),
  CONSTRAINT fk_veiculos_aparelho FOREIGN KEY (aparelho_id) REFERENCES aparelhos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Aparelhos que se conectaram sem cadastro: aparecem para o master cadastrar.
CREATE TABLE IF NOT EXISTS aparelhos_pendentes (
  identificador VARCHAR(20) NOT NULL,
  primeiro_contato DATETIME NOT NULL,
  ultimo_contato DATETIME NOT NULL,
  ip VARCHAR(45) NULL,
  porta SMALLINT UNSIGNED NULL,
  fabricante VARCHAR(40) NULL,
  modelo VARCHAR(40) NULL,
  placa_informada VARCHAR(20) NULL,
  protocolo VARCHAR(30) NULL,
  conexoes INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (identificador)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Último estado conhecido de cada aparelho (uma linha por aparelho), para o mapa abrir já com a frota.
CREATE TABLE IF NOT EXISTS aparelhos_estado (
  aparelho_id INT UNSIGNED NOT NULL,
  online TINYINT(1) NOT NULL DEFAULT 0,
  ultimo_contato DATETIME NULL,
  ultima_posicao_em DATETIME NULL,
  latitude DECIMAL(9,6) NULL,
  longitude DECIMAL(9,6) NULL,
  velocidade DECIMAL(5,1) NULL,
  direcao SMALLINT UNSIGNED NULL,
  ignicao TINYINT(1) NULL,
  gps_valido TINYINT(1) NULL,
  satelites TINYINT UNSIGNED NULL,
  sinal TINYINT UNSIGNED NULL,
  odometro DECIMAL(10,1) NULL,
  ip VARCHAR(45) NULL,
  protocolo VARCHAR(40) NULL,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (aparelho_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- histórico (tabelas de volume: sem chaves estrangeiras, só índices) ----------

CREATE TABLE IF NOT EXISTS posicoes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  aparelho_id INT UNSIGNED NOT NULL,
  veiculo_id INT UNSIGNED NULL,
  data_hora DATETIME NOT NULL,
  recebido_em DATETIME NOT NULL,
  latitude DECIMAL(9,6) NOT NULL,
  longitude DECIMAL(9,6) NOT NULL,
  velocidade DECIMAL(5,1) NOT NULL DEFAULT 0,
  direcao SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  altitude SMALLINT NOT NULL DEFAULT 0,
  alarmes INT UNSIGNED NOT NULL DEFAULT 0,
  alarmes_video INT UNSIGNED NOT NULL DEFAULT 0,
  estado INT UNSIGNED NOT NULL DEFAULT 0,
  ignicao TINYINT(1) NOT NULL DEFAULT 0,
  gps_valido TINYINT(1) NOT NULL DEFAULT 0,
  satelites TINYINT UNSIGNED NULL,
  sinal TINYINT UNSIGNED NULL,
  odometro DECIMAL(10,1) NULL,
  PRIMARY KEY (id),
  KEY ix_posicoes_aparelho (aparelho_id, data_hora),
  KEY ix_posicoes_veiculo (veiculo_id, data_hora),
  KEY ix_posicoes_data (data_hora)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS alertas (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  aparelho_id INT UNSIGNED NOT NULL,
  veiculo_id INT UNSIGNED NULL,
  codigo VARCHAR(20) NOT NULL,
  nome VARCHAR(80) NOT NULL,
  gravidade ENUM('alta','media','baixa') NOT NULL DEFAULT 'media',
  inicio DATETIME NOT NULL,
  fim DATETIME NULL,
  latitude DECIMAL(9,6) NULL,
  longitude DECIMAL(9,6) NULL,
  velocidade DECIMAL(5,1) NULL,
  situacao ENUM('novo','em_tratamento','tratado') NOT NULL DEFAULT 'novo',
  tratado_por INT UNSIGNED NULL,
  tratado_em DATETIME NULL,
  tratativa VARCHAR(500) NULL,
  PRIMARY KEY (id),
  KEY ix_alertas_empresa (empresa_id, inicio),
  KEY ix_alertas_situacao (empresa_id, situacao),
  KEY ix_alertas_veiculo (veiculo_id, inicio),
  KEY ix_alertas_abertos (aparelho_id, fim)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Comunicações: conexões, desconexões, registros e recusas dos aparelhos.
CREATE TABLE IF NOT EXISTS eventos_aparelho (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  aparelho_id INT UNSIGNED NULL,
  empresa_id INT UNSIGNED NULL,
  identificador VARCHAR(20) NOT NULL,
  tipo VARCHAR(30) NOT NULL,
  data_hora DATETIME NOT NULL,
  ip VARCHAR(45) NULL,
  porta SMALLINT UNSIGNED NULL,
  detalhe VARCHAR(500) NULL,
  PRIMARY KEY (id),
  KEY ix_eventos_aparelho (aparelho_id, data_hora),
  KEY ix_eventos_empresa (empresa_id, data_hora),
  KEY ix_eventos_data (data_hora)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Comunicações: comandos enviados aos aparelhos (vídeo, reprodução, consultas) e a resposta de cada um.
CREATE TABLE IF NOT EXISTS comandos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NULL,
  aparelho_id INT UNSIGNED NOT NULL,
  usuario_id INT UNSIGNED NULL,
  mensagem SMALLINT UNSIGNED NOT NULL,
  nome VARCHAR(80) NOT NULL,
  detalhe VARCHAR(255) NULL,
  sequencia SMALLINT UNSIGNED NULL,
  enviado_em DATETIME NOT NULL,
  respondido_em DATETIME NULL,
  resultado VARCHAR(120) NULL,
  tempo_ms INT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_comandos_aparelho (aparelho_id, enviado_em),
  KEY ix_comandos_empresa (empresa_id, enviado_em),
  KEY ix_comandos_data (enviado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auditoria (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  data_hora DATETIME NOT NULL,
  usuario_id INT UNSIGNED NULL,
  empresa_id INT UNSIGNED NULL,
  acao VARCHAR(40) NOT NULL,
  entidade VARCHAR(40) NULL,
  entidade_id VARCHAR(40) NULL,
  descricao VARCHAR(500) NULL,
  ip VARCHAR(45) NULL,
  PRIMARY KEY (id),
  KEY ix_auditoria_empresa (empresa_id, data_hora),
  KEY ix_auditoria_usuario (usuario_id, data_hora),
  KEY ix_auditoria_data (data_hora)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- configurações do sistema (editadas pelo master no painel) ----------

CREATE TABLE IF NOT EXISTS configuracoes (
  chave VARCHAR(60) NOT NULL,
  valor VARCHAR(255) NOT NULL,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  atualizado_por INT UNSIGNED NULL,
  PRIMARY KEY (chave)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO configuracoes (chave, valor) VALUES
  ('aparelhos_nao_cadastrados', 'listar'),
  ('retencao_posicoes_dias', '90'),
  ('retencao_eventos_dias', '180'),
  ('retencao_alertas_dias', '365'),
  ('retencao_auditoria_dias', '730');
