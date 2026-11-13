-- =====================================================================
--  FrotaGest 1.14 — ocorrências: tudo de um caso (acidente, assalto, avaria, reclamação...) num lugar,
--  com as provas (gravações, fotos, arquivos), o andamento e o dossiê em PDF.
--  Os arquivos ficam em disco (data/ocorrencias/<id>/), nunca no banco.
-- =====================================================================

CREATE TABLE IF NOT EXISTS ocorrencias (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  ano SMALLINT UNSIGNED NOT NULL,
  numero INT UNSIGNED NOT NULL,
  veiculo_id INT UNSIGNED NULL,
  aparelho_id INT UNSIGNED NULL,
  motorista_id INT UNSIGNED NULL,
  alerta_id BIGINT UNSIGNED NULL,
  tipo VARCHAR(20) NOT NULL,
  titulo VARCHAR(120) NOT NULL,
  descricao TEXT NULL,
  quando DATETIME NOT NULL,
  latitude DECIMAL(9,6) NULL,
  longitude DECIMAL(9,6) NULL,
  local_texto VARCHAR(200) NULL,
  gravidade ENUM('alta','media','baixa') NOT NULL DEFAULT 'media',
  situacao ENUM('aberta','em_analise','encerrada') NOT NULL DEFAULT 'aberta',
  responsavel_id INT UNSIGNED NULL,
  protocolo VARCHAR(60) NULL,
  conclusao TEXT NULL,
  trajeto_antes_min SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  trajeto_depois_min SMALLINT UNSIGNED NOT NULL DEFAULT 15,
  criado_por INT UNSIGNED NULL,
  criado_em DATETIME NOT NULL,
  atualizado_em DATETIME NULL,
  encerrado_por INT UNSIGNED NULL,
  encerrado_em DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_ocorrencias_numero (empresa_id, ano, numero),
  KEY ix_ocorrencias_situacao (empresa_id, situacao, quando),
  KEY ix_ocorrencias_veiculo (veiculo_id, quando),
  KEY ix_ocorrencias_alerta (alerta_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Andamento: aberta, anotações, mudanças de situação, anexos, dossiê gerado...
CREATE TABLE IF NOT EXISTS ocorrencia_eventos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ocorrencia_id INT UNSIGNED NOT NULL,
  usuario_id INT UNSIGNED NULL,
  tipo VARCHAR(20) NOT NULL,
  texto VARCHAR(1000) NOT NULL,
  criado_em DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY ix_oc_eventos (ocorrencia_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Provas: gravação baixada do DVR, foto da câmera ou arquivo enviado (BO, fotos do celular...).
-- O SHA-256 de cada arquivo vai no dossiê: quem receber confere que nada foi alterado.
CREATE TABLE IF NOT EXISTS ocorrencia_anexos (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ocorrencia_id INT UNSIGNED NOT NULL,
  tipo ENUM('gravacao','foto','arquivo') NOT NULL,
  origem VARCHAR(40) NULL,
  arquivo VARCHAR(200) NOT NULL,
  nome VARCHAR(160) NOT NULL,
  descricao VARCHAR(300) NULL,
  mime VARCHAR(80) NOT NULL,
  bytes BIGINT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  canal TINYINT UNSIGNED NULL,
  inicio DATETIME NULL,
  fim DATETIME NULL,
  usuario_id INT UNSIGNED NULL,
  criado_em DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY ix_oc_anexos (ocorrencia_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
