-- =====================================================================
--  FrotaGest 1.4 — cercas virtuais e sessões encerradas pelo administrador
-- =====================================================================

-- Cercas desenhadas no mapa: garagem, ponto/terminal, área de interesse e área proibida.
-- Círculo (centro + raio) ou polígono (pontos em JSON: [[lat, lng], ...]).
-- Sem grupo: vale para todos os veículos da empresa; com grupo: só para os do grupo (e subgrupos).
CREATE TABLE IF NOT EXISTS cercas (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id INT UNSIGNED NOT NULL,
  grupo_id INT UNSIGNED NULL,
  nome VARCHAR(80) NOT NULL,
  finalidade ENUM('garagem','ponto','area','proibida') NOT NULL DEFAULT 'area',
  forma ENUM('circulo','poligono') NOT NULL,
  latitude DECIMAL(9,6) NULL,
  longitude DECIMAL(9,6) NULL,
  raio_m INT UNSIGNED NULL,
  pontos TEXT NULL,
  alerta_entrada TINYINT(1) NOT NULL DEFAULT 0,
  alerta_saida TINYINT(1) NOT NULL DEFAULT 0,
  horario_inicio CHAR(5) NULL,
  horario_fim CHAR(5) NULL,
  observacao VARCHAR(255) NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_cercas_empresa (empresa_id),
  KEY ix_cercas_grupo (grupo_id),
  CONSTRAINT fk_cercas_empresa FOREIGN KEY (empresa_id) REFERENCES empresas (id),
  CONSTRAINT fk_cercas_grupo FOREIGN KEY (grupo_id) REFERENCES grupos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Logins encerrados pelo master/administrador na tela "Usuários online". Cada login no Firebase tem
-- a hora em que foi feito (auth_time): a sessão encerrada não volta, e as outras do mesmo usuário seguem.
CREATE TABLE IF NOT EXISTS sessoes_encerradas (
  firebase_uid VARCHAR(128) NOT NULL,
  auth_time INT UNSIGNED NOT NULL,
  usuario_id INT UNSIGNED NULL,
  encerrado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  encerrado_por INT UNSIGNED NULL,
  PRIMARY KEY (firebase_uid, auth_time),
  KEY ix_sessoes_encerradas_data (encerrado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
