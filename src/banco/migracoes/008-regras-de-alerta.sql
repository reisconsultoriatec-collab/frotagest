-- =====================================================================
--  FrotaGest 1.9 — regras de alerta da empresa
-- =====================================================================

-- Regras que o servidor confere a cada posição (e a cada 20 s, para o que depende do tempo):
--   velocidade    acima de limite_kmh por tempo_seg (opcional: só dentro de uma cerca)
--   fora_horario  veículo em uso fora dos dias/horário permitidos, por tempo_seg
--   parada        parado por tempo_seg fora das garagens (e, se marcado, dos pontos)
--   ociosidade    motor ligado parado por tempo_seg (pode ignorar garagens e pontos)
-- Alcance: toda a empresa, um grupo (com os subgrupos) ou um veículo. Vale a regra mais específica.
CREATE TABLE IF NOT EXISTS regras_alerta (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  tipo ENUM('velocidade','fora_horario','parada','ociosidade') NOT NULL,
  grupo_id INT UNSIGNED NULL,
  veiculo_id INT UNSIGNED NULL,
  cerca_id INT UNSIGNED NULL,
  limite_kmh SMALLINT UNSIGNED NULL,
  tempo_seg INT UNSIGNED NOT NULL DEFAULT 0,
  dias VARCHAR(20) NULL,
  horario_inicio CHAR(5) NULL,
  horario_fim CHAR(5) NULL,
  ignorar_garagem TINYINT(1) NOT NULL DEFAULT 1,
  ignorar_ponto TINYINT(1) NOT NULL DEFAULT 0,
  gravidade ENUM('alta','media','baixa') NOT NULL DEFAULT 'media',
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_regras_empresa (empresa_id),
  CONSTRAINT fk_regras_empresa FOREIGN KEY (empresa_id) REFERENCES empresas (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
