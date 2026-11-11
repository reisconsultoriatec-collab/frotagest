-- =====================================================================
--  FrotaGest 1.11 — comandos para o veículo: fotos das câmeras
--  (mensagem ao motorista, reiniciar e parâmetros ficam na tabela comandos, que já existe)
-- =====================================================================

-- Fotos tiradas pelas câmeras do DVR. O JPEG fica em disco (data/fotos/AAAA-MM/...); aqui só o registro.
CREATE TABLE IF NOT EXISTS fotos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  aparelho_id INT UNSIGNED NOT NULL,
  veiculo_id INT UNSIGNED NULL,
  canal TINYINT UNSIGNED NOT NULL,
  midia_id INT UNSIGNED NULL,
  evento TINYINT UNSIGNED NULL,
  data_hora DATETIME NOT NULL,
  latitude DECIMAL(9,6) NULL,
  longitude DECIMAL(9,6) NULL,
  velocidade DECIMAL(5,1) NULL,
  arquivo VARCHAR(200) NOT NULL,
  bytes INT UNSIGNED NOT NULL,
  usuario_id INT UNSIGNED NULL,
  criado_em DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY ix_fotos_aparelho (aparelho_id, data_hora),
  KEY ix_fotos_data (data_hora)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
