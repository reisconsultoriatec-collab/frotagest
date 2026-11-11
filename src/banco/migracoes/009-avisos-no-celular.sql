-- =====================================================================
--  FrotaGest 1.10 — avisos no celular (Web Push) com o painel fechado
-- =====================================================================

-- Cada navegador/celular que ativou os avisos. O endereço (endpoint) é do serviço de push do
-- navegador (Google, Apple, Mozilla, Microsoft); as chaves servem para criptografar o aviso,
-- que só o próprio aparelho consegue abrir.
CREATE TABLE IF NOT EXISTS push_inscricoes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  usuario_id INT UNSIGNED NOT NULL,
  endpoint_hash CHAR(64) NOT NULL,
  endpoint VARCHAR(1000) NOT NULL,
  p256dh VARCHAR(120) NOT NULL,
  auth VARCHAR(40) NOT NULL,
  aparelho VARCHAR(80) NULL,
  criado_em DATETIME NOT NULL,
  usado_em DATETIME NULL,
  falhas SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY ux_push_endpoint (endpoint_hash),
  KEY ix_push_usuario (usuario_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Quais alertas a pessoa quer receber no celular: 'alta', 'media' (alta e média) ou 'todas'.
ALTER TABLE usuarios ADD COLUMN push_nivel VARCHAR(10) NOT NULL DEFAULT 'alta';

-- Regra nova: aparelho sem comunicação (caiu com o veículo ligado, antena cortada, DVR desligado).
ALTER TABLE regras_alerta MODIFY COLUMN tipo ENUM('velocidade','fora_horario','parada','ociosidade','sem_comunicacao') NOT NULL;
ALTER TABLE regras_alerta ADD COLUMN so_ligado TINYINT(1) NOT NULL DEFAULT 1;
