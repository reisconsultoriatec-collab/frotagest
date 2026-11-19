-- =====================================================================
--  FrotaGest 1.20 — Procedimentos Auxiliares › Importação da Escala Globus
--  A escala de trabalho gerada no Globus (um arquivo por dia) fica guardada por dia,
--  para consultar e, de forma opcional, vincular o motorista ao veículo um a um.
--  Só acrescenta; nada do que já existe muda.
-- =====================================================================

-- Cada arquivo importado (por empresa e dia). Importar o mesmo dia de novo substitui.
CREATE TABLE IF NOT EXISTS escala_importacoes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  data DATE NOT NULL,
  arquivo VARCHAR(160) NULL,
  servicos INT UNSIGNED NOT NULL DEFAULT 0,
  usuario_id INT UNSIGNED NULL,
  criado_em DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY ix_escala_imp (empresa_id, data)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cada linha da escala (um serviço: veículo, linha, turno, motorista e horários), como veio do Globus.
-- O veículo e o motorista são achados na hora pelo prefixo (sem os zeros da frente) e pela chapa
-- (= matrícula do motorista): quem for cadastrado depois da importação já aparece.
CREATE TABLE IF NOT EXISTS escala_servicos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  importacao_id INT UNSIGNED NOT NULL,
  data DATE NOT NULL,
  linha_arquivo INT UNSIGNED NOT NULL,
  tipo_dia VARCHAR(5) NULL,
  prefixo VARCHAR(20) NULL,
  linha_codigo VARCHAR(20) NULL,
  linha_numero VARCHAR(20) NULL,
  linha_nome VARCHAR(120) NULL,
  turno VARCHAR(10) NULL,
  turno_descricao VARCHAR(40) NULL,
  chapa VARCHAR(30) NULL,
  motorista_nome VARCHAR(120) NULL,
  servico_inicio DATETIME NOT NULL,
  servico_fim DATETIME NOT NULL,
  motorista_inicio DATETIME NULL,
  intervalo_inicio DATETIME NULL,
  intervalo_fim DATETIME NULL,
  motorista_fim DATETIME NULL,
  local_pegada VARCHAR(80) NULL,
  vinculo_id BIGINT UNSIGNED NULL,
  vinculado_em DATETIME NULL,
  vinculado_por INT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_escala_dia (empresa_id, data),
  KEY ix_escala_imp_serv (importacao_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Vínculo feito pela escala: termina sozinho no fim do serviço (se ninguém trocar antes).
ALTER TABLE motorista_vinculos ADD COLUMN fim_previsto DATETIME NULL;
