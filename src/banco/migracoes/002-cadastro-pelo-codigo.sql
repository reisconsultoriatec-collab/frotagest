-- =====================================================================
--  FrotaGest 1.1 — cadastro pela tela de entrada (modelo EduGest)
--  Cada empresa tem um código; quem cria a conta com ele fica pendente
--  até o administrador da empresa aprovar.
-- =====================================================================

ALTER TABLE usuarios ADD COLUMN pendente TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE empresas ADD COLUMN codigo_convite VARCHAR(12) NULL;

CREATE UNIQUE INDEX uq_empresas_codigo ON empresas (codigo_convite);
