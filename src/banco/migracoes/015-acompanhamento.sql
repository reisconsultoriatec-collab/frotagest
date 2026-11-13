-- =====================================================================
--  FrotaGest 1.16 — links de acompanhamento: página pública com prazo que mostra só a posição do
--  veículo (link de veículo) ou as viagens da linha que estão rodando (link de linha), e o aviso
--  "está chegando" no celular de quem acompanha (Web Push, sem cadastro).
-- =====================================================================

CREATE TABLE IF NOT EXISTS links_acompanhamento (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  token VARCHAR(40) NOT NULL,
  tipo ENUM('veiculo','linha') NOT NULL,
  veiculo_id INT UNSIGNED NULL,
  linha_id INT UNSIGNED NULL,
  nome VARCHAR(80) NULL,
  mostrar_veiculo TINYINT(1) NOT NULL DEFAULT 1,
  criado_por INT UNSIGNED NULL,
  criado_em DATETIME NOT NULL,
  expira_em DATETIME NULL,
  revogado_em DATETIME NULL,
  revogado_por INT UNSIGNED NULL,
  acessos INT UNSIGNED NOT NULL DEFAULT 0,
  ultimo_acesso DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_links_token (token),
  KEY ix_links_empresa (empresa_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Quem pediu o aviso "está chegando" (página do link de linha): o ponto escolhido e com quantos minutos avisar
CREATE TABLE IF NOT EXISTS links_avisos (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  link_id INT UNSIGNED NOT NULL,
  endpoint VARCHAR(1000) NOT NULL,
  p256dh VARCHAR(200) NOT NULL,
  auth VARCHAR(100) NOT NULL,
  ponto_ordem SMALLINT UNSIGNED NOT NULL,
  minutos TINYINT UNSIGNED NOT NULL DEFAULT 5,
  criado_em DATETIME NOT NULL,
  ultimo_aviso_viagem BIGINT UNSIGNED NULL,
  ultimo_aviso_em DATETIME NULL,
  falhas TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_links_avisos (link_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
