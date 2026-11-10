-- =====================================================================
--  FrotaGest 1.7 — controle de acesso por usuário (menus e ações)
--  acessos: JSON { "tela": ["ver","incluir","alterar","excluir"], ... } só com as telas
--  personalizadas; NULL (ou tela ausente) = vale o padrão do perfil.
--  O master tem sempre acesso total e é o único que libera o menu "Controle de acesso".
-- =====================================================================

ALTER TABLE usuarios ADD COLUMN acessos TEXT NULL;
ALTER TABLE usuarios ADD COLUMN acessos_em DATETIME NULL;
ALTER TABLE usuarios ADD COLUMN acessos_por INT UNSIGNED NULL;
