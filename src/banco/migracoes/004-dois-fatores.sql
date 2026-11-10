-- =====================================================================
--  FrotaGest 1.5 — verificação em duas etapas (Google Authenticator)
--  Tudo no FrotaGest: o Firebase continua só com o e-mail e a senha.
--  A chave de cada usuário fica cifrada (a chave da cifra está em data/, fora do banco).
-- =====================================================================

ALTER TABLE usuarios ADD COLUMN totp_segredo VARCHAR(255) NULL;
ALTER TABLE usuarios ADD COLUMN totp_pendente VARCHAR(255) NULL;
ALTER TABLE usuarios ADD COLUMN totp_ativado_em DATETIME NULL;
ALTER TABLE usuarios ADD COLUMN totp_ultimo_passo BIGINT NULL;
-- o master exige a verificação deste usuário mesmo que o perfil dele não esteja na regra geral
ALTER TABLE usuarios ADD COLUMN exigir_2fa TINYINT(1) NOT NULL DEFAULT 0;

-- códigos de recuperação (para quem perder o celular): só o resumo SHA-256, cada um vale uma vez
CREATE TABLE IF NOT EXISTS codigos_recuperacao (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  usuario_id INT UNSIGNED NOT NULL,
  hash CHAR(64) NOT NULL,
  usado_em DATETIME NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_codigos_recuperacao_usuario (usuario_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- logins (aparelho/navegador) que já passaram pela segunda etapa: não pede de novo até sair
CREATE TABLE IF NOT EXISTS sessoes_2fa (
  firebase_uid VARCHAR(128) NOT NULL,
  auth_time INT UNSIGNED NOT NULL,
  usuario_id INT UNSIGNED NOT NULL,
  verificado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (firebase_uid, auth_time),
  KEY ix_sessoes_2fa_usuario (usuario_id),
  KEY ix_sessoes_2fa_data (verificado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
