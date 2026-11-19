'use strict';
/* FrotaGest — conteúdo do Guia do FrotaGest (manual das telas e tour guiado). Reis Tecnologia
 *
 *  Artigos: { id, titulo, resumo, tela?, perfis?, palavras?, corpo, relacionados? }
 *    tela   → botões "Abrir a tela" e "Mostrar na tela"; o artigo some para quem não abre a tela
 *    perfis → master · admin · operador · visualizador (sem perfis: vale para todos)
 *    corpo  → ['p'|'h'|'dica'|'atencao'|'onde', texto] · ['passos'|'lista', [..]] · ['tabela', [[cabeçalho], [..]]]
 *    texto  → **negrito** · {{Botão}} · `código`
 *  Tours: por tela, { g (entra no tour geral), alvo, celular?, menu?, titulo, texto, perfis? }.
 *  Implantação: o que GET /api/guia/implantacao confere para a empresa.
 *  DICAS_DASHBOARD: o texto do ícone (i) de cada cartão do Dashboard (usado também no artigo do Dashboard). */

/** O que cada cartão do Dashboard mostra (ícone de informação ao passar o mouse). */
const DICAS_DASHBOARD = {
  km: ['Km rodados hoje', 'Soma dos km rodados hoje por todos os veículos do filtro, pelo GPS (a mesma conta dos relatórios). A seta compara com ontem até esta mesma hora; o minigráfico mostra cada hora do dia. Embaixo: quantos rodaram, as horas em movimento e os excessos de velocidade. Clique para abrir o Resumo por veículo.'],
  on: ['Online agora', 'Aparelhos (DVR) conectados ao FrotaGest neste momento, do total de veículos com aparelho. A barra mostra a porcentagem. Clique para ver só os online no Monitoramento.'],
  mov: ['Em movimento', 'Veículos online andando agora (acima de 3 km/h). Embaixo: quantos estão parados e quantos parados com o motor ligado. Clique para ver no Monitoramento.'],
  alertas: ['Alertas hoje', 'Alertas que começaram hoje nos veículos do filtro. Embaixo: quantos ainda estão pendentes na empresa (novos ou em tratamento) e quantos são de gravidade alta. Clique para abrir a tela de Alertas.'],
  alarme: ['Com alarme agora', 'Veículos com algum alarme aberto neste momento. Clique para ver esses veículos no Monitoramento.'],
  garagem: ['Na garagem', 'Veículos dentro de uma cerca com a finalidade Garagem agora, e quantos estão fora. Clique para abrir as Cercas.'],
  offline: ['Offline', 'Aparelhos sem comunicação agora. Desenhe as garagens em Cadastros › Cercas para este cartão passar a mostrar quantos veículos estão recolhidos.'],
  situacao: ['Situação da frota agora', 'Quantos veículos estão em movimento, parados e offline neste momento, e como foi o dia: quantos comunicaram e quantos rodaram hoje. Clique numa faixa para ver esses veículos no Monitoramento.'],
  mapa: ['Frota no mapa', 'Todos os veículos do filtro na posição atual, com as garagens desenhadas. Clique num veículo para abri-lo no Monitoramento.'],
  hora: ['Hoje, hora a hora', 'Km rodados (ou veículos rodando) em cada hora de hoje, com a linha de ontem para comparar. Passe o mouse nas barras para ver os números, ou use "Ver como tabela".'],
  dias: ['Km rodados · últimos 14 dias', 'O total de km de cada dia das duas últimas semanas e a média por dia. Clique num dia para abrir o relatório daquele dia.'],
  alHora: ['Alertas de hoje por hora', 'Quantos alertas começaram em cada hora de hoje, separados por gravidade (alta, média e baixa).'],
  tipos: ['Tipos de alerta hoje', 'Os tipos de alerta que mais aconteceram hoje (excesso de velocidade, parada longa, cercas, alarmes do aparelho…), do mais frequente para o menos frequente.'],
  pendentes: ['Pendentes', 'Os alertas que ainda não foram tratados (novos ou em tratamento), do mais recente para o mais antigo. "Ver todos" abre a tela de Alertas para tratar.'],
  garagens: ['Garagens agora', 'Cada garagem desenhada em Cercas, com quantos veículos estão dentro dela agora.'],
  rank: ['Quem mais rodou hoje', 'Os veículos com mais km rodados hoje. Clique num veículo para vê-lo no mapa.'],
  semCom: ['Sem comunicação há mais tempo', 'Os aparelhos que estão offline há mais tempo. Comece por eles a conferir chip, antena, alimentação e o próprio DVR (a tela Saúde dos aparelhos mostra os detalhes).'],
  grupos: ['Por grupo', 'Os números de cada grupo lado a lado: veículos, online, em movimento, km e alertas de hoje. Clique num grupo para o Dashboard mostrar só ele.'],
  avisoCadastros: ['Cadastros aguardando aprovação', 'Pessoas que criaram a conta com o código da empresa e esperam a sua aprovação em Cadastros › Usuários.'],
  avisoSaude: ['Aparelhos que precisam de atenção', 'Aparelhos offline há mais de 1 dia, que nunca conectaram, ou com falha de câmera, cartão, GPS, alimentação ou sinal fraco. Os detalhes ficam em Controle › Saúde dos aparelhos.'],
  avisoManut: ['Manutenção e documentos', 'Planos de manutenção e documentos vencidos ou perto de vencer. Só aparece quando há algo cadastrado em Operação › Manutenção e documentos.'],
  avisoPendentes: ['Aparelhos conectados sem cadastro', 'DVRs que se conectaram ao servidor mas ainda não estão cadastrados. Cadastre em Cadastros › Aparelhos (o número do aparelho já vem preenchido).'],
};

const GUIA = (() => {
  const categorias = [
    { id: 'comecar', titulo: 'Primeiros passos', icone: 'rocket', desc: 'Entrar no sistema, conhecer a tela, os perfis, a segurança da conta e os avisos de alerta.' },
    { id: 'implantacao', titulo: 'Implantação da empresa', icone: 'checklist', desc: 'O que cadastrar, e em que ordem, para a empresa começar a monitorar a frota.' },
    { id: 'cadastros', titulo: 'Cadastros', icone: 'clipboard-list', desc: 'Empresas, aparelhos (DVR), grupos, veículos, motoristas, cercas, regras de alerta e usuários.' },
    { id: 'operacao', titulo: 'Operação do dia a dia', icone: 'radar-2', desc: 'Monitoramento, câmeras ao vivo, comandos, alertas, ocorrências, histórico, gravações e modo TV.' },
    { id: 'linhas', titulo: 'Linhas, viagens e links', icone: 'route-2', desc: 'Horários das linhas acompanhados pelo GPS e os links de acompanhamento para clientes e passageiros.' },
    { id: 'analise', titulo: 'Dashboard e relatórios', icone: 'chart-bar', desc: 'Os números da frota ao vivo e os relatórios em Excel e PDF.' },
    { id: 'manutencao', titulo: 'Manutenção e documentos', icone: 'tool', desc: 'Planos por km e tempo, manutenções feitas e documentos com vencimento.' },
    { id: 'controle', titulo: 'Controle e segurança', icone: 'shield-check', desc: 'Saúde dos aparelhos, comunicações, usuários online, auditoria, controle de acesso e sistema.' },
    { id: 'auxiliares', titulo: 'Procedimentos auxiliares', icone: 'tools', desc: 'Integração com outros sistemas da empresa: a importação da escala do Globus e o vínculo do motorista ao veículo.' },
    { id: 'duvidas', titulo: 'Perguntas frequentes', icone: 'help-circle', desc: 'Respostas rápidas para as situações mais comuns do dia a dia.' },
  ];
  const artigos = [];
  const add = (cat, lista) => lista.forEach((a) => artigos.push({ cat, ...a }));

  /* =================== PRIMEIROS PASSOS =================== */
  add('comecar', [
    {
      id: 'comecar-entrar', titulo: 'Entrar no FrotaGest e criar a sua conta',
      resumo: 'Como entrar, criar a conta com o código da empresa e o que acontece até o administrador liberar o acesso.',
      palavras: ['login', 'cadastro', 'acesso', 'senha', 'codigo da empresa', 'criar conta', 'lembrar email'],
      corpo: [
        ['p', 'Cada pessoa tem o próprio login (e-mail e senha). Não compartilhe a sua senha: tudo o que é feito no FrotaGest fica registrado na auditoria com o nome de quem fez.'],
        ['h', 'Primeira vez: criar a conta'],
        ['passos', [
          'Peça ao administrador da sua empresa o **código da empresa** (ele aparece em Cadastros › Usuários).',
          'Na tela de entrada, clique em {{Criar conta}}.',
          'Informe o seu nome completo, o e-mail, uma senha e o código da empresa.',
          'A tela passa a mostrar **Aguardando aprovação**. O administrador aprova o seu cadastro e escolhe o seu perfil (operador, visualizador ou administrador) e os grupos de veículos que você vê.',
          'Depois de aprovado, entre com o e-mail e a senha.',
        ]],
        ['h', 'Já tenho conta'],
        ['p', 'Digite o e-mail e a senha e clique em {{Entrar}}. Marque **Lembrar meu e-mail** se o computador for só seu (guarda só o e-mail, nunca a senha). Esqueceu a senha? Use {{Esqueci minha senha}}: chega um e-mail com o link para criar outra.'],
        ['dica', 'O administrador também pode **convidar por e-mail** em Cadastros › Usuários. Nesse caso basta criar a conta com o mesmo e-mail do convite.'],
      ],
      relacionados: ['comecar-tela', 'comecar-perfis', 'faq-aguardando', 'faq-senha'],
    },
    {
      id: 'comecar-tela', titulo: 'Conhecendo a tela do FrotaGest',
      resumo: 'Menu lateral, Guia do FrotaGest, topo com empresa, tempo conectado, som dos alertas, tema e o menu ⋮ no celular.',
      palavras: ['menu', 'navegar', 'topo', 'tema escuro', 'modo escuro', 'atualizar', 'celular'],
      corpo: [
        ['p', 'A tela tem três partes: o **menu** à esquerda, o **topo** com o nome da tela e os botões gerais, e o **conteúdo** da tela aberta.'],
        ['h', 'Menu lateral'],
        ['lista', [
          '**Dashboard**, no alto e à parte: os números da frota ao vivo.',
          '**Cadastros**, **Operação**, **Controle** e **Procedimentos Auxiliares**: clique no nome do grupo para abrir e ver as telas. Um grupo abre por vez; com ele fechado, os números (alertas, cadastros pendentes) somam no título.',
          '**Guia do FrotaGest**, em destaque no fim do menu: este manual e o tour guiado.',
          'Embaixo: se o **tempo real** está conectado e quantos veículos estão **online**.',
        ]],
        ['p', 'Você só vê no menu as telas liberadas para você. Se faltar alguma, peça ao administrador da empresa (Controle › Controle de acesso).'],
        ['h', 'Topo'],
        ['tabela', [
          ['Botão', 'Para que serve'],
          ['Empresa', 'Só o master: escolhe a empresa que as telas mostram (ou todas).'],
          ['Tempo conectado', 'Há quanto tempo você está no sistema.'],
          ['?', 'Abre este guia já na ajuda da tela em que você está.'],
          ['Lua/sol', 'Tema claro ou escuro. A escolha fica neste navegador.'],
          ['Atualizar', 'Busca de novo os dados da tela.'],
          ['Alto-falante', 'Som e notificação dos alertas e os avisos no celular.'],
          ['Sino', 'Alertas pendentes; leva à tela de Alertas.'],
          ['Sair', 'Encerra a sessão neste aparelho.'],
        ]],
        ['dica', 'No celular, o menu abre pelo botão de três linhas no canto esquerdo, e os botões menos usados do topo ficam no **⋮**.'],
      ],
      relacionados: ['comecar-guia', 'comecar-som', 'comecar-perfis'],
    },
    {
      id: 'comecar-perfis', titulo: 'Perfis de acesso: o que cada um vê e faz',
      resumo: 'Master, administrador, operador e visualizador; os grupos de veículos e o controle de acesso por pessoa.',
      palavras: ['perfil', 'permissao', 'administrador', 'operador', 'visualizador', 'master', 'grupos'],
      corpo: [
        ['tabela', [
          ['Perfil', 'Vê', 'Pode fazer (padrão)'],
          ['Master (Reis Tecnologia)', 'Todas as empresas', 'Tudo: empresas, aparelhos, portas e protocolos, configurações e sistema.'],
          ['Administrador', 'Toda a frota da empresa', 'Usuários, grupos, veículos, motoristas, cercas, regras; câmeras, gravações, alertas, comunicações e auditoria.'],
          ['Operador', 'Os grupos liberados (ou todos)', 'Mapa, câmeras ao vivo, gravações, tratar alertas, ocorrências e histórico.'],
          ['Visualizador', 'Os grupos liberados (ou todos)', 'Mapa, câmeras ao vivo, histórico e ver os alertas.'],
        ]],
        ['p', 'Os **grupos** decidem quais veículos a pessoa enxerga: liberar um grupo libera também os subgrupos dele. O **Controle de acesso** decide, pessoa por pessoa, em quais menus ela entra e se pode incluir, alterar ou excluir.'],
        ['dica', 'Mudou o acesso de alguém? Vale na hora, também para quem está com o painel aberto: o menu muda sozinho.'],
      ],
      relacionados: ['tela-usuarios', 'tela-acesso', 'tela-grupos'],
    },
    {
      id: 'comecar-guia', titulo: 'Como usar este guia e o tour guiado',
      resumo: 'Busca, "Comece por aqui", ajuda da tela atual, "Mostrar na tela", o que você já leu e o manual em PDF.',
      palavras: ['ajuda', 'manual', 'tour', 'tutorial', 'pdf', 'imprimir', 'mostrar na tela'],
      corpo: [
        ['lista', [
          '**Tour guiado**: passa pelas telas que você usa, escurecendo o resto e explicando os botões principais. Nada é alterado durante o tour. Use {{Próximo}} e {{Voltar}} (ou as setas do teclado); **Esc** sai.',
          '**Ajuda desta tela**: o botão **?** do topo abre o guia já nos artigos da tela em que você está.',
          '**Mostrar na tela**: em cada artigo de tela, destaca os elementos reais daquela tela.',
          '**Menus e telas**: a lista de todos os menus que você vê, com para que serve cada tela.',
          '**Busca**: escreva o que quer fazer (ex.: "baixar vídeo", "tratar alerta", "desenhar garagem").',
          '**Lidos**: cada artigo aberto fica marcado como lido (vale em qualquer computador ou celular).',
          '**Manual em PDF**: gera o manual com os artigos do seu perfil para imprimir ou guardar.',
        ]],
      ],
      relacionados: ['comecar-tela'],
    },
    {
      id: 'comecar-som', titulo: 'Som e notificação dos alertas no computador',
      resumo: 'Escolha quais alertas tocam o som e aparecem como notificação na área de trabalho enquanto o painel está aberto.',
      palavras: ['som', 'barulho', 'notificacao', 'aviso sonoro', 'desktop', 'silenciar'],
      corpo: [
        ['passos', [
          'Clique no **alto-falante** do topo (ou em {{Som e avisos}} na tela de Alertas).',
          'Escolha: só gravidade **alta**, **alta e média**, **todos** ou **sem som**.',
          'Ligue a **notificação na área de trabalho** para ver o alerta mesmo com outra janela na frente (o navegador pede permissão).',
        ]],
        ['p', 'A escolha fica neste navegador. Com o painel fechado, quem avisa são os **avisos no celular**.'],
      ],
      relacionados: ['comecar-celular', 'tela-alertas'],
    },
    {
      id: 'comecar-celular', titulo: 'Avisos no celular com o painel fechado',
      resumo: 'Receba os alertas como notificação do celular (ou do computador), mesmo com o FrotaGest fechado.',
      palavras: ['push', 'notificacao', 'celular', 'iphone', 'android', 'aviso', 'teste'],
      corpo: [
        ['passos', [
          'No aparelho que vai receber, abra o FrotaGest e clique no **alto-falante** do topo › **Avisos no celular**.',
          'Clique em {{Ativar neste aparelho}} e permita as notificações. Chega um aviso de teste.',
          'Escolha quais alertas chegam: só gravidade alta (padrão), alta e média, ou todos.',
        ]],
        ['lista', [
          'Funciona no Android (Chrome, Samsung Internet), no computador (Chrome, Edge, Firefox, Safari) e no **iPhone/iPad pelo aplicativo instalado** (Safari › Compartilhar › Adicionar à Tela de Início).',
          'Chegam só os alertas dos veículos que você vê. Vários de uma vez viram um aviso só, com o resumo.',
          'Tocar no aviso abre o FrotaGest nos Alertas. Clicar em **Sair** desliga os avisos daquele aparelho.',
          'Na mesma janela: {{Enviar teste}} e a lixeira para tirar um aparelho (ex.: celular perdido).',
        ]],
      ],
      relacionados: ['comecar-app', 'faq-celular-aviso'],
    },
    {
      id: 'comecar-app', titulo: 'Instalar o FrotaGest como aplicativo',
      resumo: 'Ícone na tela inicial do celular ou na área de trabalho, abrindo em tela cheia.',
      palavras: ['aplicativo', 'app', 'instalar', 'atalho', 'android', 'iphone', 'tela inicial'],
      corpo: [
        ['p', 'O FrotaGest pode ser instalado sem loja: ganha um ícone e abre em tela cheia, sem a barra do navegador. É o mesmo sistema, sempre atualizado.'],
        ['lista', [
          '**Android e computador (Chrome/Edge):** botão {{Instalar}} no topo (no celular, dentro do **⋮**).',
          '**iPhone/iPad:** pelo Safari, Compartilhar › **Adicionar à Tela de Início**.',
        ]],
        ['p', 'O aplicativo guarda só os arquivos do painel para abrir mais rápido no 4G; os dados vêm sempre do servidor.'],
      ],
      relacionados: ['comecar-celular'],
    },
    {
      id: 'comecar-sessao', titulo: 'Sessão, verificação em duas etapas e segurança da conta',
      resumo: 'Quando a sessão encerra por falta de uso e como funciona o código do Google Authenticator.',
      palavras: ['sessao', 'expirou', 'inatividade', '2fa', 'duas etapas', 'authenticator', 'codigo', 'seguranca'],
      corpo: [
        ['p', 'Sem mexer no painel pelo tempo definido pelo master (padrão 60 minutos), a sessão encerra e é preciso entrar de novo. Um minuto antes aparece **"Você ainda está aí?"** para continuar. No **Modo TV** a sessão não encerra.'],
        ['h', 'Verificação em duas etapas'],
        ['p', 'Quando o master exige para o seu perfil (ou para você), no próximo acesso o FrotaGest mostra um **QR Code**: leia com o Google Authenticator (ou Microsoft Authenticator, Authy), digite o código de 6 dígitos e guarde os **10 códigos de recuperação**. Depois disso, cada login novo pede o código do aplicativo.'],
        ['atencao', 'Perdeu o celular? Entre com um dos códigos de recuperação, ou peça ao master para **zerar** a verificação do seu usuário (você lê um QR Code novo).'],
      ],
      relacionados: ['faq-senha', 'tela-usuarios'],
    },
    {
      id: 'comecar-ordem', titulo: 'Ordem das listas: mais recentes ou mais antigos primeiro',
      resumo: 'Relatórios, histórico e ocorrências mostram primeiro o que acabou de acontecer; dá para trocar.',
      palavras: ['ordem', 'ordenar', 'recentes', 'antigos', 'inverter', 'classificar'],
      corpo: [
        ['p', 'Nos **relatórios** de eventos (tela, Excel e PDF), nas **posições do Histórico** e nas **ocorrências** (lista, andamento e alertas do período), o mais recente aparece em cima.'],
        ['p', 'Para ver do começo ao fim, clique no botão {{Mais recentes primeiro}} da tela: ele passa a {{Mais antigos primeiro}}. A escolha vale para todas essas telas e fica guardada no navegador. O mapa e a reprodução do trajeto seguem sempre do começo ao fim.'],
        ['dica', 'A ordem padrão de todos é definida pelo master em Controle › Sistema › Configurações › Listas e relatórios.'],
      ],
      relacionados: ['tela-relatorios', 'tela-historico', 'tela-ocorrencias'],
    },
  ]);

  /* =================== IMPLANTAÇÃO =================== */
  add('implantacao', [
    {
      id: 'implantacao-ordem', titulo: 'A ordem para montar a empresa no FrotaGest', perfis: ['master', 'admin'],
      resumo: 'Do aparelho no veículo até a equipe recebendo os alertas: o passo a passo na ordem certa.',
      palavras: ['implantacao', 'comecar', 'configurar', 'primeiros cadastros', 'ordem', 'onboarding'],
      corpo: [
        ['p', 'O grupo **Cadastros** do menu já está na ordem em que se monta uma empresa. A lista de implantação (neste guia e no Dashboard) confere sozinha o que já foi feito.'],
        ['passos', [
          '**Aparelhos (DVR):** a Reis Tecnologia cadastra cada DVR pelo número do aparelho e configura o aparelho para conectar ao servidor.',
          '**Grupos:** organize a frota (garagens, linhas, contratos, clientes). Eles decidem quem vê quais veículos.',
          '**Veículos:** prefixo, placa e grupo, ligados ao aparelho instalado.',
          '**Cercas:** desenhe pelo menos a **garagem**. Ela é usada no Dashboard, nas regras (parada longa, motor ligado) e no relatório de saídas e chegadas.',
          '**Regras de alerta:** velocidade, uso fora do horário, parada longa, motor ligado parado, sem comunicação e direção contínua.',
          '**Motoristas** (opcional): para saber quem dirigia em cada alerta e nos relatórios de jornada.',
          '**Usuários:** passe o código da empresa para a equipe, aprove os cadastros e escolha o perfil e os grupos de cada um.',
          '**Avisos no celular:** cada pessoa que acompanha os alertas ativa no próprio celular.',
        ]],
        ['dica', 'Comece com um veículo e uma regra, confira os alertas por alguns dias e só depois estenda para a frota toda.'],
      ],
      relacionados: ['implantacao-aparelhos', 'tela-grupos', 'tela-veiculos', 'tela-cercas', 'tela-regras', 'implantacao-equipe'],
    },
    {
      id: 'implantacao-aparelhos', titulo: 'Ligar os DVRs ao FrotaGest', perfis: ['master', 'admin'],
      resumo: 'Como o aparelho chega ao servidor, o que é "aparelho pendente" e como conferir que ele está comunicando.',
      palavras: ['dvr', 'aparelho', 'configurar', 'porta', 'servidor', 'pendente', 'jt808', 'conectar'],
      corpo: [
        ['p', 'Cada DVR se conecta ao servidor do FrotaGest pela internet do chip 4G, usando o protocolo **JT/T 808** (posições, alarmes, comandos) e o **JT/T 1078** (vídeo). No aparelho são configurados o **endereço do servidor** e as **portas** informados pela Reis Tecnologia, e o **número do aparelho** (ID do terminal).'],
        ['passos', [
          'O master cadastra o aparelho em **Cadastros › Aparelhos** com o número do aparelho, a quantidade de câmeras e o chip.',
          'Em **Cadastros › Veículos**, o veículo é ligado ao aparelho.',
          'Ligado o veículo, o aparelho aparece **online** no Monitoramento em alguns segundos.',
        ]],
        ['p', 'Aparelho que conecta sem estar cadastrado aparece em **Sistema › Aparelhos pendentes** (e no Dashboard do master), com o número já preenchido para cadastrar.'],
        ['atencao', 'Não aparece? Confira se o DVR está ligado, se o chip tem dados e se o número do aparelho no cadastro é o mesmo configurado no DVR. A tela Controle › Comunicações mostra cada conexão.'],
      ],
      relacionados: ['tela-aparelhos', 'tela-comunicacoes', 'faq-offline'],
    },
    {
      id: 'implantacao-equipe', titulo: 'Colocar a equipe no sistema', perfis: ['master', 'admin'],
      resumo: 'Código da empresa, aprovação dos cadastros, perfil e grupos de cada pessoa.',
      palavras: ['equipe', 'funcionario', 'operador', 'convidar', 'aprovar', 'codigo da empresa'],
      corpo: [
        ['passos', [
          'Em **Cadastros › Usuários**, copie o **código da empresa** e mande para a equipe.',
          'Cada pessoa cria a conta na tela de entrada ({{Criar conta}}) com esse código.',
          'Os cadastros aparecem no alto da tela de Usuários (e no Dashboard). Clique em {{Aprovar}}, escolha o **perfil** e os **grupos** que a pessoa vê.',
          'Se precisar, ajuste os menus e as ações dela em **Controle › Controle de acesso**.',
        ]],
        ['dica', 'Quem sai da empresa: **desative** o usuário. Ele perde o acesso na hora, e o que fez continua na auditoria.'],
      ],
      relacionados: ['tela-usuarios', 'tela-acesso', 'comecar-perfis'],
    },
  ]);

  /* =================== CADASTROS =================== */
  add('cadastros', [
    {
      id: 'tela-empresas', titulo: 'Empresas', tela: 'empresas', perfis: ['master'],
      resumo: 'As empresas clientes do FrotaGest: dados, código para a equipe criar a conta e logotipo.',
      palavras: ['empresa', 'cliente', 'cnpj', 'logotipo', 'logo', 'codigo de convite'],
      corpo: [
        ['p', 'Só o master (Reis Tecnologia) vê esta tela. Cada empresa enxerga apenas a própria frota.'],
        ['lista', [
          '{{Nova empresa}}: nome, CNPJ e contato. A empresa ganha um **código** para a equipe dela criar a conta.',
          '**Logotipo**: PNG, JPG ou WebP. Aparece no topo do painel de quem é da empresa, no Modo TV e no cabeçalho dos PDFs.',
          'Empresa **desativada**: ninguém dela entra e os aparelhos dela são recusados.',
        ]],
      ],
      relacionados: ['implantacao-ordem', 'tela-aparelhos'],
    },
    {
      id: 'tela-aparelhos', titulo: 'Aparelhos (DVR)', tela: 'aparelhos',
      resumo: 'Os DVRs instalados nos veículos: número do aparelho, câmeras e nomes dos canais, chip e protocolo.',
      palavras: ['dvr', 'aparelho', 'camera', 'canal', 'chip', 'terminal', 'numero do aparelho', 'mdvr'],
      corpo: [
        ['p', 'Cada linha é um DVR. O **número do aparelho** (ID do terminal) é o que o DVR envia ao conectar e precisa ser igual ao configurado nele.'],
        ['lista', [
          '**Câmeras**: quantos canais o aparelho tem e o nome de cada um (Frontal, Cabine, Porta…). Os nomes aparecem no mapa, nas câmeras ao vivo e nas gravações.',
          '**Chip 4G**: número e operadora, para quem cuida da manutenção.',
          '**Perfil de protocolo**: define as portas e o protocolo do tipo de aparelho (padrão JT/T 808 + 1078).',
          'Aparelho **desativado**: o servidor recusa a conexão dele.',
        ]],
        ['p', 'Depois de cadastrado, ligue o aparelho a um veículo em **Cadastros › Veículos**. Aparelho sem veículo aparece só para o administrador e o master.'],
      ],
      relacionados: ['implantacao-aparelhos', 'tela-veiculos', 'tela-saude'],
    },
    {
      id: 'tela-grupos', titulo: 'Grupos e subgrupos', tela: 'grupos',
      resumo: 'Organize a frota em grupos (garagem, linha, contrato) para filtrar as telas e decidir quem vê o quê.',
      palavras: ['grupo', 'subgrupo', 'garagem', 'contrato', 'organizar', 'filtrar'],
      corpo: [
        ['p', 'Grupos podem ter **subgrupos** (ex.: Garagem Centro › Linha 10). Liberar um grupo para uma pessoa libera também os subgrupos.'],
        ['lista', [
          'Os grupos aparecem como filtro no Monitoramento, no Dashboard, nos relatórios e no Modo TV.',
          'Regras de alerta, cercas e planos de manutenção podem valer só para um grupo.',
          'Em Usuários, cada operador ou visualizador vê **todos os grupos** ou só os escolhidos.',
        ]],
      ],
      relacionados: ['tela-veiculos', 'tela-usuarios', 'tela-regras'],
    },
    {
      id: 'tela-veiculos', titulo: 'Veículos', tela: 'veiculos',
      resumo: 'Prefixo, placa e grupo de cada veículo, ligado ao aparelho (DVR) instalado nele.',
      palavras: ['veiculo', 'onibus', 'van', 'placa', 'prefixo', 'carro', 'frota'],
      corpo: [
        ['passos', [
          'Clique em {{Novo veículo}}.',
          'Informe o **prefixo** (número do carro) e a **placa** (antiga ou Mercosul).',
          'Escolha o **grupo** e o **aparelho** instalado.',
          'Salve. O veículo aparece no Monitoramento assim que o aparelho comunicar.',
        ]],
        ['dica', 'Trocou o DVR de veículo? Edite os dois veículos: o histórico de posições continua com cada um.'],
      ],
      relacionados: ['tela-aparelhos', 'tela-grupos', 'tela-mapa'],
    },
    {
      id: 'tela-motoristas', titulo: 'Motoristas', tela: 'motoristas',
      resumo: 'Cadastro dos motoristas (CNH, cartão do DVR), quem está dirigindo cada veículo e o histórico de cada um.',
      palavras: ['motorista', 'condutor', 'cnh', 'cartao', 'jornada', 'matricula'],
      corpo: [
        ['p', 'Só o nome é obrigatório; todo o resto é opcional e o sistema funciona sem motorista informado.'],
        ['lista', [
          '**CNH**: número, categoria e validade (fica amarela a 30 dias de vencer e vermelha vencida).',
          '**Cartão**: o código do cartão que o motorista passa no DVR (aparelhos com leitor). Com ele, a troca de motorista é automática.',
          '**Agora**: em qual veículo o motorista está, desde quando e se foi pelo cartão ou pelo painel.',
          '**Cartões lidos pelo DVR sem cadastro**: aparecem no alto da tela com {{Cadastrar}} (o código já vai preenchido).',
        ]],
        ['p', 'Cada alerta guarda o motorista do momento, e os relatórios de **Jornada** e **Resumo por motorista** contam só o tempo em que ele estava no veículo.'],
        ['atencao', 'Motorista que já dirigiu não pode ser excluído: desative.'],
      ],
      relacionados: ['motoristas-trocar', 'tela-relatorios', 'tela-regras'],
    },
    {
      id: 'motoristas-trocar', titulo: 'Trocar o motorista de um veículo', tela: 'mapa',
      resumo: 'Informe quem está dirigindo agora, pelo painel do veículo no Monitoramento.',
      palavras: ['trocar motorista', 'quem esta dirigindo', 'escala', 'motorista do veiculo'],
      corpo: [
        ['passos', [
          'No **Monitoramento**, clique no veículo.',
          'No painel do veículo, em **Motorista**, clique em {{Trocar}} (ou {{Escolher}}).',
          'Escolha o motorista. Ele passa a valer a partir de agora; se estava em outro veículo, sai de lá.',
        ]],
        ['p', '"Sem motorista" encerra. Aparelhos com leitor de cartão trocam sozinhos quando o motorista passa o cartão.'],
      ],
      relacionados: ['tela-motoristas', 'tela-mapa'],
    },
    {
      id: 'tela-cercas', titulo: 'Cercas: garagens, pontos e áreas', tela: 'cercas',
      resumo: 'Lugares desenhados no mapa, com avisos de entrada e saída e horários permitidos.',
      palavras: ['cerca', 'geofence', 'garagem', 'ponto', 'terminal', 'area proibida', 'perimetro'],
      corpo: [
        ['tabela', [
          ['Finalidade', 'Para que serve'],
          ['Garagem', 'Onde os veículos ficam recolhidos. Usada no Dashboard, nas regras de parada e no relatório de saídas e chegadas.'],
          ['Ponto ou terminal', 'Pontos de parada, terminais, escolas, clientes.'],
          ['Área de interesse', 'Qualquer região que vale acompanhar (um bairro, uma obra).'],
          ['Área proibida', 'Abre um alerta grave enquanto o veículo estiver dentro e fecha quando ele sai.'],
        ]],
        ['p', 'Cada cerca vale para toda a empresa ou só para um grupo. Os avisos podem ser na entrada e/ou na saída, sempre ou só **fora do horário permitido** (ex.: garagem das 04:00 às 23:00 avisa quem sai de madrugada).'],
        ['p', 'A lista mostra quantos veículos estão dentro de cada cerca agora. Uma cerca desenhada hoje já aparece nos relatórios da semana passada (são calculados pelas posições guardadas).'],
      ],
      relacionados: ['cercas-desenhar', 'tela-regras', 'tela-relatorios'],
    },
    {
      id: 'cercas-desenhar', titulo: 'Desenhar uma cerca no mapa', tela: 'cercas',
      resumo: 'Passo a passo para criar um círculo ou uma área livre e ligar os avisos.',
      palavras: ['desenhar', 'criar cerca', 'circulo', 'poligono', 'raio', 'nova cerca'],
      corpo: [
        ['passos', [
          'Clique em {{Nova cerca}} e dê um nome.',
          'Escolha a **finalidade** (garagem, ponto, área de interesse ou proibida).',
          '**Círculo**: clique no centro e ajuste o raio pelas alças. **Área livre**: clique em cada canto; arraste para ajustar e clique no meio de um lado para criar outro canto.',
          'Escolha se vale para a empresa toda ou um grupo, e os **avisos** de entrada e saída (sempre ou fora do horário).',
          'Salve.',
        ]],
        ['dica', 'Para não avisar à toa, o veículo precisa passar 25 m da borda para contar como saída (o GPS oscila com o ônibus parado no portão).'],
      ],
      relacionados: ['tela-cercas'],
    },
    {
      id: 'tela-regras', titulo: 'Regras de alerta', tela: 'regras',
      resumo: 'Velocidade, uso fora do horário, parada longa, motor ligado parado, sem comunicação e direção contínua.',
      palavras: ['regra', 'alerta', 'velocidade', 'limite', 'horario', 'parada', 'motor ligado', 'ociosidade', 'sem comunicacao', 'direcao continua'],
      corpo: [
        ['p', 'O **servidor confere as regras o tempo todo**, mesmo com o painel fechado, e abre o alerta na hora. Ele fica aberto enquanto a situação durar e fecha sozinho.'],
        ['tabela', [
          ['Regra', 'Avisa quando'],
          ['Excesso de velocidade', 'Passa do limite por mais tempo que a tolerância (em qualquer lugar ou só dentro de uma cerca).'],
          ['Uso fora do horário', 'O veículo é ligado ou anda fora dos dias e do horário permitidos.'],
          ['Parada longa', 'Fica parado mais que o tempo, fora das garagens.'],
          ['Motor ligado parado', 'O motor fica ligado com o veículo parado mais que o tempo.'],
          ['Sem comunicação', 'O aparelho para de se comunicar (antena ou cabo cortado, DVR desligado, sem sinal).'],
          ['Direção contínua', 'Dirige mais que o tempo (padrão 5h30) sem um descanso (padrão 30 min).'],
        ]],
        ['p', 'Cada regra vale para a empresa toda, um grupo ou um veículo, com a gravidade escolhida. **Vale a mais específica**: a do veículo, senão a do grupo, senão a da empresa.'],
        ['p', 'O **início** do alerta é quando a situação começou (ex.: parou com o motor ligado às 10:21, a regra de 15 min avisa às 10:36 com início 10:21).'],
        ['dica', 'O botão de cada regra liga e desliga sem apagar. A lista mostra quantos alertas cada regra gerou nos últimos 7 dias.'],
      ],
      relacionados: ['regras-aparelho', 'tela-alertas', 'tela-cercas'],
    },
    {
      id: 'regras-aparelho', titulo: 'Alarmes do próprio aparelho (DVR)', tela: 'regras',
      resumo: 'Os alarmes que o DVR decide sozinho, como desligar os que não interessam e onde mudar os tempos no aparelho.',
      palavras: ['alarme do aparelho', 'dvr', 'fadiga', 'camera do motorista', 'parada prolongada', 'desligar alarme'],
      corpo: [
        ['p', 'Além das regras da empresa, o DVR manda alarmes próprios: excesso de velocidade, fadiga, tempo de direção, parada prolongada, comportamento do motorista (câmera), falta de energia, falha de câmera ou cartão e outros. Os que se parecem com uma regra levam **(aparelho)** no nome.'],
        ['lista', [
          'Em **Regras de alerta › Alarmes do próprio aparelho**, desligue os que não interessam: eles param de virar alerta e aviso (a posição continua guardando o alarme).',
          'Os **tempos** desses alarmes ficam no próprio DVR: em Monitoramento › veículo › **Comandos › Aparelho › Parâmetros**.',
          'Na lista de alertas, embaixo do nome aparece se veio de **regra da empresa** ou de **alarme do aparelho**.',
        ]],
      ],
      relacionados: ['tela-regras', 'mapa-comandos'],
    },
    {
      id: 'tela-usuarios', titulo: 'Usuários', tela: 'usuarios',
      resumo: 'Aprovar cadastros, convidar por e-mail, perfil, grupos, verificação em duas etapas e desativar.',
      palavras: ['usuario', 'aprovar', 'convidar', 'perfil', 'desativar', 'bloquear', 'codigo da empresa'],
      corpo: [
        ['lista', [
          '**Código da empresa**: no alto da tela. Quem cria a conta com ele aparece em **Aguardando aprovação** com {{Aprovar}}.',
          '{{Convidar por e-mail}}: cadastra a pessoa antes; ela cria a conta com o mesmo e-mail.',
          '**Perfil**: administrador, operador ou visualizador. **Grupos**: todos ou só os escolhidos.',
          '**Último acesso**: quando a pessoa entrou pela última vez.',
          '**Desativar**: a pessoa perde o acesso na hora.',
        ]],
        ['p', 'O master também exige a **verificação em duas etapas** de uma pessoa e zera o autenticador de quem perdeu o celular.'],
      ],
      relacionados: ['implantacao-equipe', 'tela-acesso', 'comecar-perfis'],
    },
  ]);

  /* =================== OPERAÇÃO =================== */
  add('operacao', [
    {
      id: 'tela-mapa', titulo: 'Monitoramento: a frota ao vivo no mapa', tela: 'mapa',
      resumo: 'Lista da frota com filtros, mapa com os veículos agrupados e o painel de cada veículo.',
      palavras: ['mapa', 'monitoramento', 'tempo real', 'localizacao', 'onde esta', 'rastreamento', 'gps'],
      corpo: [
        ['h', 'Lista da frota'],
        ['p', 'Busque pela placa, prefixo ou número do aparelho e filtre por **Todos**, **Online**, **Offline**, **Alerta** e pelo grupo. Clicar num veículo leva o mapa até ele.'],
        ['h', 'Mapa'],
        ['lista', [
          'Cores: **verde** em movimento, **azul** parado, **cinza** offline, **vermelho** com alerta.',
          'Veículos próximos viram uma bolinha com o número. Clique para aproximar; todos no mesmo lugar (garagem) abrem a lista. O botão **Agrupado** liga e desliga.',
          'O botão **Cercas** desenha as garagens, pontos e áreas.',
        ]],
        ['h', 'Painel do veículo'],
        ['p', 'Velocidade, ignição, GPS, sinal 4G, odômetro, motorista, cerca onde está e alarmes. E os botões: **câmeras ao vivo**, {{Histórico}}, {{Gravações}}, {{Comandos}}, {{Ocorrência}} e {{Compartilhar localização}} (cada um aparece se você tem acesso).'],
      ],
      relacionados: ['mapa-cameras', 'mapa-comandos', 'motoristas-trocar', 'tela-historico'],
    },
    {
      id: 'mapa-cameras', titulo: 'Câmeras ao vivo', tela: 'mapa',
      resumo: 'Abrir uma ou todas as câmeras do veículo, escolher a qualidade e montar o mosaico.',
      palavras: ['camera', 'video', 'ao vivo', 'imagem', 'mosaico', 'h265', 'assistir'],
      corpo: [
        ['passos', [
          'No Monitoramento, clique no veículo (ele precisa estar **online**).',
          'Em **Câmeras**, clique no canal (ou em {{Abrir todas}}). O vídeo aparece no mosaico abaixo do mapa.',
          'No alto do mosaico: **Secundário (leve)** gasta menos dados do chip; **Principal (HD)** tem mais qualidade.',
          'Se a imagem não aparecer, troque entre **Converter H.265** e **Direto**.',
        ]],
        ['p', 'Dá para abrir câmeras de vários veículos ao mesmo tempo. {{Fechar todas}} encerra o vídeo e para de gastar o chip.'],
        ['atencao', 'O vídeo passa pelo 4G do veículo: em área de sinal fraco pode travar ou demorar. Nenhum vídeo é gravado no banco de dados.'],
      ],
      relacionados: ['tela-mapa', 'tela-gravacoes', 'faq-video'],
    },
    {
      id: 'mapa-comandos', titulo: 'Comandos: foto, mensagem ao motorista e aparelho', tela: 'mapa',
      resumo: 'Pedir uma foto agora, mandar mensagem para a tela do DVR, reiniciar e ler/gravar parâmetros.',
      palavras: ['comando', 'foto', 'mensagem', 'motorista', 'reiniciar', 'parametros', 'dvr'],
      corpo: [
        ['p', 'No Monitoramento, clique no veículo e em {{Comandos}}:'],
        ['lista', [
          '**Foto agora**: marque as câmeras e a qualidade. A foto chega em alguns segundos (depende do sinal) e fica guardada por 30 dias.',
          '**Mensagem ao motorista**: aparece na tela do DVR e/ou é falada no alto-falante, com frases prontas e a opção urgente. Vai sem acentos (a tela mostra como fica).',
          '**Aparelho**: reiniciar o DVR e ler/gravar parâmetros (intervalo de posição, velocidade máxima e os tempos dos alarmes do aparelho).',
          '**Histórico**: os últimos comandos, com a resposta do aparelho e quem mandou.',
        ]],
        ['atencao', 'Com o aparelho offline os botões ficam desligados: o comando não fica guardado para depois.'],
      ],
      relacionados: ['tela-mapa', 'regras-aparelho', 'tela-comunicacoes'],
    },
    {
      id: 'tela-alertas', titulo: 'Alertas', tela: 'alertas',
      resumo: 'Todos os alertas (regras, alarmes do aparelho, cercas e linhas) com filtros, duração e tratamento.',
      palavras: ['alerta', 'alarme', 'pendente', 'tratado', 'gravidade', 'excesso', 'csv'],
      corpo: [
        ['p', 'Filtre por **situação** (pendentes, novos, em tratamento, tratados), **gravidade**, veículo e período. Cada linha mostra de onde veio o alerta (regra da empresa, alarme do aparelho, cerca ou linha), o motorista do momento e quanto durou (**durou X**) ou há quanto tempo está ativo (**há X**).'],
        ['lista', [
          '{{Tratar}}: registra o que foi feito.',
          '{{Abrir ocorrência}}: transforma o alerta num caso, com provas e dossiê.',
          '{{Som e avisos}}: o som e a notificação deste computador.',
          '{{CSV}}: baixa a lista filtrada.',
        ]],
        ['p', 'O sino do topo mostra quantos estão pendentes e o menu mostra o número ao lado de Alertas.'],
      ],
      relacionados: ['alertas-tratar', 'tela-ocorrencias', 'tela-regras', 'comecar-som'],
    },
    {
      id: 'alertas-tratar', titulo: 'Tratar um alerta', tela: 'alertas',
      resumo: 'Do alerta novo ao tratado, com o registro do que foi feito.',
      palavras: ['tratar', 'tratativa', 'encerrar alerta', 'resolver', 'em tratamento'],
      corpo: [
        ['passos', [
          'Na tela de Alertas, clique em {{Tratar}} na linha do alerta.',
          'Escolha **Em tratamento** (você está cuidando) ou **Tratado (encerrar)**.',
          'Escreva **o que foi feito** (obrigatório para encerrar). Ex.: "contato com o motorista por rádio".',
          'Salve. Quem tratou e quando ficam registrados no alerta e na auditoria.',
        ]],
        ['dica', 'Caso grave (acidente, assalto, avaria)? Use {{Abrir ocorrência}}: o alerta fica ligado ao caso e passa a "em tratamento".'],
      ],
      relacionados: ['tela-alertas', 'tela-ocorrencias'],
    },
    {
      id: 'tela-ocorrencias', titulo: 'Ocorrências', tela: 'ocorrencias',
      resumo: 'Cada caso (acidente, assalto, avaria, reclamação) num lugar só, com provas, trajeto, andamento e dossiê em PDF.',
      palavras: ['ocorrencia', 'acidente', 'assalto', 'avaria', 'sinistro', 'reclamacao', 'caso', 'dossie'],
      corpo: [
        ['h', 'Abrir'],
        ['lista', [
          'Pelo alerta: **Alertas › Abrir ocorrência** (título, hora, gravidade e local vêm do alerta).',
          'Pelo veículo: **Monitoramento › painel do veículo › Ocorrência**.',
          'Do zero: {{Nova ocorrência}}, com ou sem veículo.',
        ]],
        ['p', 'O sistema preenche o **local** (GPS mais perto da hora do fato), o **motorista** daquela hora, a cerca onde estava, o **trajeto** de 30 min antes a 15 min depois e os **alertas** do veículo nesse período.'],
        ['h', 'Acompanhar'],
        ['p', '**Situação**: aberta → em análise → encerrada (pede a conclusão). O **andamento** registra cada passo, com quem e quando; anote ligações, retornos do seguro e conversas.'],
      ],
      relacionados: ['ocorrencias-provas', 'ocorrencias-dossie', 'alertas-tratar'],
    },
    {
      id: 'ocorrencias-provas', titulo: 'Juntar as provas de uma ocorrência', tela: 'ocorrencias',
      resumo: 'Baixar as câmeras do momento, anexar downloads, fotos e arquivos, cada um com o SHA-256.',
      palavras: ['prova', 'video', 'anexar', 'boletim', 'bo', 'foto', 'sha256', 'baixar camera'],
      corpo: [
        ['lista', [
          '{{Baixar as câmeras do momento}}: escolha as câmeras e o trecho (até 30 min). O servidor pede ao DVR e cada gravação **entra sozinha** na ocorrência quando fica pronta (o aparelho precisa estar online).',
          '{{Anexar download}}: um vídeo já baixado em Gravações.',
          '{{Anexar foto}}: fotos das câmeras de até 6 h antes e depois do fato.',
          '{{Enviar arquivo}}: BO, fotos do celular, laudos, áudios (até 20 MB cada).',
        ]],
        ['p', 'Cada prova guarda o **SHA-256**: quem recebe o arquivo confere que é exatamente o que estava na ocorrência. A prova continua guardada mesmo depois que o download ou a foto original vencem.'],
      ],
      relacionados: ['tela-ocorrencias', 'ocorrencias-dossie', 'tela-gravacoes'],
    },
    {
      id: 'ocorrencias-dossie', titulo: 'Dossiê da ocorrência em PDF', tela: 'ocorrencias',
      resumo: 'O documento com os dados, o trajeto, os alertas, as fotos, a lista das provas e o andamento.',
      palavras: ['dossie', 'pdf', 'relatorio da ocorrencia', 'seguradora', 'policia'],
      corpo: [
        ['p', 'Na ocorrência, clique em {{Dossiê em PDF}}. Ele traz os dados do caso, a descrição, o **trajeto desenhado** com o local e os alertas, os alertas do período, as **fotos**, a lista das provas com o SHA-256 de cada uma, o **andamento** e a conclusão, com o logotipo da empresa.'],
        ['dica', 'Mande o PDF junto com os arquivos das provas: o SHA-256 no dossiê comprova que os arquivos não foram alterados.'],
      ],
      relacionados: ['tela-ocorrencias', 'ocorrencias-provas'],
    },
    {
      id: 'tela-historico', titulo: 'Histórico e reprodução do trajeto', tela: 'historico',
      resumo: 'O trajeto de um veículo num período, com resumo, reprodução animada, tabela de posições e CSV.',
      palavras: ['historico', 'trajeto', 'percurso', 'reproduzir', 'replay', 'posicoes', 'por onde andou'],
      corpo: [
        ['passos', [
          'Escolha o **veículo** e o período (até 7 dias), ou use os atalhos **1 h**, **6 h**, **Hoje** e **Ontem**.',
          'Clique em {{Buscar}}: aparecem a distância, a velocidade máxima, o tempo em movimento e as posições.',
          'Use o **play** para reproduzir: velocidade de 1× a 300×, linha do tempo com os alarmes marcados, **seguir o veículo** e **pular paradas**. A barra de espaço reproduz e pausa.',
          'Clique numa posição da tabela para levar o mapa e a reprodução até ela.',
        ]],
        ['p', 'A tabela mostra as posições da mais recente para a mais antiga (dá para trocar). {{CSV}} baixa todas, na mesma ordem.'],
      ],
      relacionados: ['tela-relatorios', 'comecar-ordem', 'tela-gravacoes'],
    },
    {
      id: 'tela-gravacoes', titulo: 'Gravações do cartão do DVR', tela: 'gravacoes',
      resumo: 'Buscar no cartão de memória do DVR, assistir e baixar em MP4.',
      palavras: ['gravacao', 'video gravado', 'cartao', 'sd', 'baixar video', 'mp4', 'download'],
      corpo: [
        ['passos', [
          'Escolha o **veículo**, o **canal**, a **data** e o horário (ou marque **Só trechos com alarme**).',
          'Clique em {{Buscar no DVR}}: o aparelho responde com os trechos gravados.',
          'Em cada trecho: {{Assistir}} ou {{Baixar MP4}}. {{Baixar período}} junta o horário escolhido num arquivo.',
          'Os arquivos aparecem em **Downloads**, em MP4, quando o servidor termina de receber.',
        ]],
        ['atencao', 'O DVR precisa estar **online**: a busca e o vídeo passam pelo 4G do veículo. Os downloads ficam no servidor por poucos dias e são apagados sozinhos (para guardar de vez, anexe numa ocorrência).'],
      ],
      relacionados: ['ocorrencias-provas', 'mapa-cameras'],
    },
    {
      id: 'tela-tv', titulo: 'Modo TV (tela da central)', tela: 'tv',
      resumo: 'Tela escura para o monitor da parede: mapa grande, frota agora, garagens e alertas pendentes.',
      palavras: ['tv', 'central', 'telao', 'parede', 'monitor', 'tela cheia'],
      corpo: [
        ['p', 'Mostra o mapa grande, a frota agora (em movimento, parados, offline, com alerta), as garagens e os alertas pendentes. Alerta novo faz a tela piscar (vermelho se for grave).'],
        ['lista', [
          'Troca sozinha entre toda a frota e os grupos (a cada 30 s a 5 min, ou parado), pelo botão de ajustes.',
          '**F** coloca em tela cheia; **← →** trocam o grupo.',
          'No Modo TV a sessão não encerra por falta de uso e a tela não apaga (nos navegadores que permitem).',
        ]],
      ],
      relacionados: ['tela-dashboard', 'tela-mapa'],
    },
  ]);

  /* =================== LINHAS E LINKS =================== */
  add('linhas', [
    {
      id: 'tela-linhas', titulo: 'Linhas e horários: as viagens do dia', tela: 'linhas',
      resumo: 'Cada partida vira uma viagem acompanhada pelo GPS: no horário, atrasada, ponto pulado e fora da rota.',
      palavras: ['linha', 'horario', 'viagem', 'partida', 'atraso', 'ponto', 'itinerario', 'escolar', 'fretamento'],
      corpo: [
        ['p', 'Opcional: sem linha cadastrada nada muda no sistema. Na aba **Viagens do dia**, cada viagem mostra o andamento, o próximo ponto com o horário estimado, o atraso agora e os pontos (clique na viagem).'],
        ['tabela', [
          ['Situação', 'Quando'],
          ['No horário / adiantado / atrasado', 'Hora real em cada ponto × prevista (tolerâncias da linha).'],
          ['Não passou', 'Chegou ao ponto seguinte sem passar por um.'],
          ['Fora da rota', 'Com o percurso gravado, saiu do corredor por 30 s.'],
          ['Não realizada', 'Não saiu até 1 h depois do horário.'],
          ['Incompleta', 'Não chegou ao fim.'],
        ]],
        ['p', 'Na viagem: {{Trocar o veículo}} (só aquela) e {{Cancelar a viagem}} com o motivo. O relatório **Cumprimento das viagens** traz tudo em Excel e PDF.'],
      ],
      relacionados: ['linhas-cadastrar', 'tela-acompanhamento', 'tela-relatorios'],
    },
    {
      id: 'linhas-cadastrar', titulo: 'Cadastrar uma linha com pontos e horários', tela: 'linhas',
      resumo: 'Pontos na ordem com o tempo previsto, percurso tirado de uma viagem e os horários de partida.',
      palavras: ['cadastrar linha', 'nova linha', 'pontos', 'percurso', 'partidas', 'horarios'],
      corpo: [
        ['passos', [
          'Na aba **Linhas**, clique em {{Nova linha}}: código, nome e grupo.',
          'Marque os **pontos na ordem** clicando no mapa (garagem, pontos, escolas, terminal). Cada um tem o **tempo previsto desde a partida** (o sistema sugere pela distância) e o raio.',
          'Opcional: {{Percurso de uma viagem}} grava o caminho a partir do GPS de uma viagem feita (veículo e período). Com ele, o sistema avisa quem sai da rota.',
          'Em **Horários de partida**, inclua a hora, os dias da semana e o veículo da escala. {{Vários de uma vez}} cria, por exemplo, das 05:00 às 23:00 a cada 20 min.',
          'Escolha os **avisos** da linha: fora da rota, atraso acima de X minutos e ponto em que não passou.',
        ]],
        ['dica', 'Mudar a linha vale para as viagens de hoje que ainda não começaram. Linha que já rodou não se exclui: desligue.'],
      ],
      relacionados: ['tela-linhas', 'tela-acompanhamento'],
    },
    {
      id: 'tela-acompanhamento', titulo: 'Links de acompanhamento e aviso "está chegando"', tela: 'acompanhamento',
      resumo: 'Uma página sem login com a posição do veículo ou as viagens da linha, para clientes e passageiros.',
      palavras: ['link', 'compartilhar', 'localizacao', 'cliente', 'pais', 'passageiro', 'esta chegando', 'whatsapp'],
      corpo: [
        ['lista', [
          '**Link de veículo**: a posição ao vivo daquele veículo, por 1 hora a 7 dias. Crie também pelo Monitoramento › {{Compartilhar localização}}.',
          '**Link de linha**: as viagens da linha enquanto estão rodando, com os pontos e a hora estimada em cada um. Vale até cancelar ou até a data escolhida. Crie também na linha › {{Link para passageiros}}.',
          '**"Está chegando"**: na página da linha, a pessoa escolhe o ponto dela e toca em **Avisar quando estiver chegando** (2 a 30 min antes). O aviso chega no celular mesmo com a página fechada.',
        ]],
        ['p', 'A página mostra **só** isso: nada de motorista, câmeras, alertas ou outros veículos. Na lista: para quem é, até quando vale, os acessos, {{Copiar}}, enviar pelo **WhatsApp** e {{Cancelar}} (para de funcionar na hora).'],
      ],
      relacionados: ['tela-linhas', 'tela-mapa'],
    },
  ]);

  /* =================== DASHBOARD E RELATÓRIOS =================== */
  add('analise', [
    {
      id: 'tela-dashboard', titulo: 'Dashboard: o que cada cartão mostra', tela: 'dashboard',
      resumo: 'Os números da frota ao vivo: km de hoje, online, alertas, garagens, gráficos e quem está sem comunicação.',
      palavras: ['dashboard', 'painel', 'inicio', 'numeros', 'indicadores', 'kpi', 'graficos', 'cartao'],
      corpo: [
        ['p', 'O Dashboard se atualiza sozinho e é a primeira tela de quem tem acesso a ele. O **filtro por grupo** no alto vale para todos os cartões. Cada cartão tem o ícone **(i)**: passe o mouse (ou toque) para ver o que ele mostra. Clicar num cartão leva à tela do assunto.'],
        ['tabela', [['Cartão', 'O que mostra'], ...['km', 'on', 'mov', 'alertas', 'garagem', 'situacao', 'mapa', 'hora', 'dias', 'alHora', 'tipos', 'pendentes', 'garagens', 'rank', 'semCom', 'grupos'].map((k) => DICAS_DASHBOARD[k])]],
        ['dica', 'Nos gráficos, passe o mouse (ou use as setas do teclado) para ver os números; "Ver como tabela" mostra os mesmos números em tabela.'],
      ],
      relacionados: ['tela-relatorios', 'tela-mapa'],
    },
    {
      id: 'tela-relatorios', titulo: 'Relatórios em Excel e PDF', tela: 'relatorios',
      resumo: 'Resumo por veículo, velocidade, paradas, alertas, garagem, cercas, jornada, motoristas e viagens.',
      palavras: ['relatorio', 'excel', 'pdf', 'xlsx', 'exportar', 'velocidade', 'paradas', 'jornada', 'garagem'],
      corpo: [
        ['passos', [
          'Escolha o **tipo de relatório** nos cartões do alto.',
          'Escolha o período (atalhos **Hoje**, **Ontem**, **7 dias**, **Este mês**), o grupo, o veículo e os ajustes do relatório.',
          'Clique em {{Gerar relatório}} para ver na tela, ou baixe em {{Excel}} ou {{PDF}} (com o logotipo da empresa).',
        ]],
        ['tabela', [
          ['Relatório', 'O que traz'],
          ['Resumo por veículo', 'Km, motor ligado, em movimento, parado ligado, velocidades, excessos, paradas e alertas.'],
          ['Excessos de velocidade', 'Cada trecho acima do limite: início, fim, duração, máxima, média e local.'],
          ['Paradas', 'Onde e por quanto tempo ficou parado, com o motor ligado ou desligado.'],
          ['Alertas', 'Os alertas do período com gravidade, situação e tratamento (até 92 dias).'],
          ['Saídas e chegadas na garagem', 'A que horas cada veículo saiu e voltou, tempo e km fora.'],
          ['Entradas e saídas das cercas', 'Cada passagem por ponto, terminal ou área.'],
          ['Jornada dos motoristas', 'Cada jornada: tempo dirigindo, maior direção sem descanso, pausas e descanso antes.'],
          ['Resumo por motorista', 'Km, jornadas, direção contínua, excessos e alertas de cada motorista.'],
          ['Cumprimento das viagens', 'Cada viagem das linhas: saída, chegada, pontos, atrasos e fora da rota.'],
        ]],
        ['atencao', 'Para não pesar o servidor, veículos × dias fica em até 400 (ex.: 363 veículos por 1 dia, ou 1 veículo por 31 dias). Com mais veículos, filtre por grupo.'],
      ],
      relacionados: ['comecar-ordem', 'tela-dashboard', 'faq-relatorio'],
    },
  ]);

  /* =================== MANUTENÇÃO =================== */
  add('manutencao', [
    {
      id: 'tela-manutencao', titulo: 'Manutenção e documentos', tela: 'manutencao',
      resumo: 'Planos por km e tempo, km pelo GPS, manutenções feitas e documentos com vencimento (opcional).',
      palavras: ['manutencao', 'troca de oleo', 'revisao', 'documento', 'licenciamento', 'seguro', 'vencimento', 'tacografo'],
      corpo: [
        ['p', 'Nada aqui é obrigatório: sem plano nem documento cadastrado, nenhum aviso aparece e nada muda na operação.'],
        ['tabela', [
          ['Aba', 'Para que serve'],
          ['Situação', 'O que está vencido, perto de vencer e em dia, veículo por veículo.'],
          ['Planos de manutenção', 'Ex.: troca de óleo a cada 10.000 km ou 6 meses (vence no que chegar primeiro), para a empresa, um grupo ou um veículo.'],
          ['Documentos', 'Do veículo (licenciamento, seguro, tacógrafo, vistoria…) ou do motorista (toxicológico, cursos), com "avisar X dias antes".'],
          ['Manutenções feitas', 'O histórico com data, hodômetro, custo e oficina, e o total gasto.'],
        ]],
        ['p', 'Os **km pelo GPS** contam desde a última manutenção registrada. Informando o hodômetro, a tela mostra o **hodômetro estimado** de hoje. **Renovar** um documento = mudar a data de vencimento.'],
        ['dica', 'Avisos: selo vermelho no menu, aviso no Dashboard, linha no painel do veículo e um resumo por dia às 7h no celular de quem ativou os avisos.'],
      ],
      relacionados: ['tela-motoristas', 'comecar-celular'],
    },
  ]);

  /* =================== CONTROLE =================== */
  add('controle', [
    {
      id: 'tela-saude', titulo: 'Saúde dos aparelhos', tela: 'saude',
      resumo: 'DVRs que precisam de atenção: conexão, câmeras, cartão, GPS, alimentação e sinal do chip.',
      palavras: ['saude', 'manutencao do dvr', 'offline', 'camera falha', 'cartao sd', 'hd', 'gps', 'alimentacao', 'sinal'],
      corpo: [
        ['p', 'Lista os aparelhos **offline há mais de 1 dia** (grave depois de 3), que **nunca conectaram**, com **falha de câmera** ou de vídeo, de **cartão/HD**, de **GPS**, de **alimentação** ou com **sinal fraco** do chip.'],
        ['lista', [
          'Filtre por problema, grupo e busca; os indicadores no alto filtram com um clique.',
          'Atalhos de cada aparelho para o mapa, o histórico e as comunicações.',
          'Baixe em {{Excel}} ou {{PDF}} para a equipe de manutenção.',
        ]],
        ['p', 'O Dashboard avisa e o menu mostra quantos estão graves.'],
      ],
      relacionados: ['tela-comunicacoes', 'faq-offline'],
    },
    {
      id: 'tela-comunicacoes', titulo: 'Comunicações', tela: 'comunicacoes',
      resumo: 'Conexões e desconexões dos aparelhos e os comandos enviados, com a resposta de cada um.',
      palavras: ['comunicacao', 'conexao', 'desconexao', 'comando', 'log do aparelho', 'caiu'],
      corpo: [
        ['p', 'Escolha o veículo, o tipo (conexões, comandos ou os dois) e o período. Serve para descobrir **quando e com que frequência** um aparelho caiu e se um comando chegou ao DVR.'],
        ['dica', 'Aparelho que cai e volta o tempo todo costuma ser chip, antena ou alimentação: confira também em Saúde dos aparelhos.'],
      ],
      relacionados: ['tela-saude', 'mapa-comandos'],
    },
    {
      id: 'tela-online', titulo: 'Usuários online', tela: 'online',
      resumo: 'Quem está com o FrotaGest aberto agora, em qual aparelho e tela, e como encerrar uma sessão.',
      palavras: ['online', 'conectado', 'quem esta usando', 'encerrar sessao', 'derrubar'],
      corpo: [
        ['p', 'Mostra quem está com o painel aberto, desde quando, de qual aparelho e navegador, em qual tela e há quanto tempo não mexe.'],
        ['p', '{{Encerrar}} desconecta só aquele aparelho (a pessoa entra de novo com a senha) e fica na auditoria. Para tirar o acesso de vez, desative o usuário.'],
      ],
      relacionados: ['tela-usuarios', 'tela-auditoria'],
    },
    {
      id: 'tela-auditoria', titulo: 'Auditoria', tela: 'auditoria',
      resumo: 'Quem fez o quê no FrotaGest: acessos, cadastros, câmeras abertas, gravações, relatórios e alertas tratados.',
      palavras: ['auditoria', 'log', 'historico de acoes', 'quem fez', 'rastreabilidade'],
      corpo: [
        ['p', 'Filtre por **ação** e período. Cada linha tem a data e hora, a pessoa, o que fez e de onde (IP). Inclui entradas e saídas, senhas erradas, cadastros, câmeras ao vivo abertas, gravações vistas e baixadas, relatórios exportados, alertas tratados e mudanças de acesso.'],
        ['p', 'A auditoria não pode ser apagada; fica guardada por 730 dias (padrão).'],
      ],
      relacionados: ['tela-online', 'tela-acesso'],
    },
    {
      id: 'tela-acesso', titulo: 'Controle de acesso', tela: 'acesso',
      resumo: 'Menu por menu, o que cada pessoa pode ver, incluir, alterar e excluir.',
      palavras: ['controle de acesso', 'permissao', 'liberar menu', 'bloquear menu', 'acoes'],
      corpo: [
        ['passos', [
          'Escolha a pessoa na lista.',
          'Marque, menu por menu: **Ver**, **Incluir**, **Alterar**, **Excluir** ("—" quando a ação não existe naquele menu).',
          'Salve. Vale na hora, também para quem está com o painel aberto.',
        ]],
        ['lista', [
          'O **perfil** continua decidindo a empresa e os grupos; a matriz decide os menus e as ações.',
          'O pontinho âmbar mostra o que está diferente do padrão do perfil; {{Voltar ao padrão do perfil}} desfaz.',
          'Ninguém libera o que ele mesmo não tem (essas caixas aparecem travadas).',
          'Cada alteração fica na auditoria com o que entrou e o que saiu.',
        ]],
      ],
      relacionados: ['comecar-perfis', 'tela-usuarios'],
    },
    {
      id: 'tela-sistema', titulo: 'Sistema', tela: 'sistema', perfis: ['master'],
      resumo: 'Status do servidor, portas e protocolos, aparelhos pendentes, configurações e log ao vivo.',
      palavras: ['sistema', 'servidor', 'configuracoes', 'portas', 'protocolo', 'pendentes', 'retencao', 'log'],
      corpo: [
        ['tabela', [
          ['Aba', 'Para que serve'],
          ['Status', 'Versão, tempo ligado, aparelhos online, memória e tamanho do banco.'],
          ['Portas e protocolos', 'As portas e o protocolo de cada tipo de aparelho.'],
          ['Aparelhos pendentes', 'DVRs que conectaram sem cadastro, para cadastrar.'],
          ['Configurações', 'Aparelhos sem cadastro, por quanto tempo guardar o histórico, sessão, verificação em duas etapas e a ordem das listas.'],
          ['Log ao vivo', 'O que o servidor está fazendo agora, para suporte.'],
        ]],
      ],
      relacionados: ['implantacao-aparelhos', 'comecar-sessao', 'comecar-ordem'],
    },
  ]);

  /* =================== PROCEDIMENTOS AUXILIARES =================== */
  add('auxiliares', [
    {
      id: 'tela-escala', titulo: 'Importação da Escala Globus', tela: 'escala',
      resumo: 'A escala de trabalho gerada no Globus dentro do FrotaGest: linha, veículo, motorista e horários de cada serviço.',
      palavras: ['escala', 'globus', 'importar', 'importacao', 'turno', 'chapa', 'pegada', 'servico', 'plantao'],
      corpo: [
        ['p', 'Cada linha do arquivo do Globus é um **serviço**: o veículo, a linha, o turno, o motorista (chapa e nome), a hora do serviço, a hora do motorista com o intervalo e o local de pegada. A tela mostra a escala do dia escolhido, com o veículo e o motorista achados no FrotaGest.'],
        ['tabela', [
          ['No Globus', 'No FrotaGest'],
          ['Prefixo do veículo (ex.: 0005755)', 'Prefixo do veículo, sem os zeros da frente (5755)'],
          ['Chapa do motorista', 'Matrícula no cadastro do motorista'],
          ['Hora inicial e final do serviço', 'Quando o veículo está com aquele motorista (é o que vale para o vínculo)'],
          ['Hora do motorista e intervalo', 'A jornada dele (pode terminar depois do serviço, voltando à garagem)'],
        ]],
        ['lista', [
          '**Situação**: aguardando, em serviço ou encerrado, pelo horário do serviço. Horário menor que o início é do dia seguinte (marcado com **+1**).',
          '**O que falta para vincular**: motoristas sem cadastro (com o botão {{Cadastrar}}, que já leva o nome e a chapa como matrícula) e veículos com prefixo diferente do cadastro.',
          '**Filtros**: busca por linha, prefixo, motorista ou chapa; situação (incluindo "podem ser vinculados agora") e linha.',
          '**Dias importados**: volte a qualquer escala já importada pelo dia.',
        ]],
        ['dica', 'O vínculo do motorista ao veículo é opcional: a escala serve também só para consulta.'],
      ],
      relacionados: ['escala-importar', 'escala-vincular', 'tela-motoristas'],
    },
    {
      id: 'escala-importar', titulo: 'Importar o arquivo da escala do Globus', tela: 'escala',
      resumo: 'O layout de 17 campos, a prévia antes de gravar e o que acontece ao importar o mesmo dia de novo.',
      palavras: ['importar', 'arquivo', 'txt', 'layout', 'globus', 'substituir', 'reimportar'],
      corpo: [
        ['passos', [
          'Gere a escala no Globus com o layout de **17 campos separados por ponto e vírgula**: data; tipo de dia; prefixo; código da linha; número oficial da linha; nome da linha; código do turno; chapa; nome do motorista; hora inicial e final do serviço; hora inicial do motorista; hora inicial e final do intervalo; hora final do motorista; local de pegada; descrição do turno.',
          'Em **Procedimentos Auxiliares › Importação da Escala Globus**, clique em {{Importar escala do Globus}} (o master escolhe antes a empresa no topo).',
          'Escolha ou arraste o arquivo .txt. A **prévia** mostra os serviços, os veículos e motoristas encontrados, o que não bateu e as linhas com erro (que ficam de fora).',
          'Confirme em {{Importar}}. A tela abre na escala do dia importado.',
        ]],
        ['p', 'Importar **o mesmo dia de novo substitui** a escala daquele dia (a prévia avisa). Os motoristas que já foram vinculados continuam nos veículos.'],
        ['atencao', 'Se aparecer um caractere estranho no nome de uma linha (ex.: "VIA M� HELENA"), o acento já saiu estragado do Globus: confira a codificação da exportação lá. O FrotaGest lê tanto UTF-8 quanto Windows-1252.'],
      ],
      relacionados: ['tela-escala', 'escala-vincular'],
    },
    {
      id: 'escala-vincular', titulo: 'Vincular o motorista da escala ao veículo', tela: 'escala',
      resumo: 'Um serviço por vez, pelo botão Vincular: o motorista entra no veículo agora e sai no fim do serviço.',
      palavras: ['vincular', 'vinculo', 'motorista no veiculo', 'escala', 'jornada', 'quem esta dirigindo'],
      corpo: [
        ['passos', [
          'Na escala do dia, filtre por **Podem ser vinculados agora** (ou procure a linha ou o motorista).',
          'Clique em {{Vincular}} no serviço. O motorista passa a estar no veículo **a partir de agora**, até o **fim do serviço**.',
          'No fim do serviço ele sai do veículo sozinho. Se alguém trocar antes (pelo painel do veículo ou pelo cartão no DVR), vale a troca.',
        ]],
        ['lista', [
          'Dá para vincular desde **1 hora antes** do início do serviço até o fim dele.',
          'Precisa do veículo encontrado (prefixo) e do motorista cadastrado (chapa = matrícula).',
          'Se o motorista estava em outro veículo, ele sai de lá.',
          'Com o vínculo, os **alertas**, a **Jornada dos motoristas** e o **Resumo por motorista** passam a trazer quem estava dirigindo. No painel do veículo aparece "pela escala do Globus".',
          'Cada vínculo fica na auditoria, com quem fez e quando.',
        ]],
      ],
      relacionados: ['tela-escala', 'motoristas-trocar', 'tela-relatorios'],
    },
  ]);

  /* =================== PERGUNTAS FREQUENTES =================== */
  add('duvidas', [
    {
      id: 'faq-offline', titulo: 'O veículo aparece offline. E agora?',
      resumo: 'O que conferir quando o aparelho para de comunicar.',
      palavras: ['offline', 'sem sinal', 'nao aparece', 'caiu', 'parou de comunicar', 'sem comunicacao'],
      corpo: [
        ['passos', [
          'Veja no painel do veículo o **último contato**: foi agora há pouco (área sem sinal, garagem subterrânea) ou há dias?',
          'Muitos aparelhos desligam junto com a chave: veículo desligado na garagem pode ficar offline até ser ligado.',
          'Em **Controle › Comunicações**, veja quando ele caiu e se cai com frequência.',
          'Em **Controle › Saúde dos aparelhos**, veja se há falha de alimentação, GPS ou sinal fraco do chip.',
          'Persistindo: confira no veículo o chip (crédito/dados), a antena, os cabos e se o DVR está ligado.',
        ]],
      ],
      relacionados: ['tela-saude', 'tela-comunicacoes', 'implantacao-aparelhos'],
    },
    {
      id: 'faq-nao-vejo', titulo: 'Não vejo um veículo, um menu ou um botão',
      resumo: 'Grupos, controle de acesso e empresa escolhida no topo.',
      palavras: ['nao vejo', 'sumiu', 'nao aparece', 'menu', 'botao', 'sem acesso', 'permissao'],
      corpo: [
        ['lista', [
          '**Veículo**: você vê só os grupos liberados no seu usuário. Peça ao administrador para liberar o grupo.',
          '**Menu ou botão**: depende do Controle de acesso (ver, incluir, alterar, excluir). Peça ao administrador.',
          '**Master**: confira a empresa escolhida no topo.',
          'Veículo sem aparelho ligado não aparece no mapa; aparelho sem veículo só aparece para o administrador e o master.',
        ]],
      ],
      relacionados: ['comecar-perfis', 'tela-acesso'],
    },
    {
      id: 'faq-alertas-demais', titulo: 'Estou recebendo alertas demais',
      resumo: 'Como ajustar as regras, os alarmes do aparelho e os avisos para receber só o que importa.',
      palavras: ['muitos alertas', 'alerta demais', 'parar alerta', 'desligar', 'silenciar', 'repetido'],
      corpo: [
        ['lista', [
          'Veja embaixo do nome do alerta se ele veio de **regra da empresa** ou de **alarme do aparelho**.',
          '**Regra**: ajuste o limite, a tolerância, o tempo, ou deixe a regra só para um grupo (Cadastros › Regras de alerta).',
          '**Alarme do aparelho**: desligue em Regras de alerta › Alarmes do próprio aparelho, ou ajuste o tempo no DVR (Comandos › Aparelho).',
          '**Parada longa e motor ligado**: desenhe as garagens e marque "não avisar nas garagens".',
          '**Som e celular**: escolha receber só gravidade alta.',
        ]],
      ],
      relacionados: ['tela-regras', 'regras-aparelho', 'comecar-som'],
    },
    {
      id: 'faq-video', titulo: 'A câmera ao vivo não abre ou trava',
      resumo: 'Aparelho online, qualidade, conversão do vídeo e sinal do chip.',
      palavras: ['camera nao abre', 'video travando', 'tela preta', 'sem imagem', 'carregando'],
      corpo: [
        ['passos', [
          'O veículo precisa estar **online** (os botões das câmeras ficam desligados offline).',
          'Use **Secundário (leve)**: gasta menos do chip e abre mais rápido em sinal fraco.',
          'Troque entre **Converter H.265** e **Direto**.',
          'Feche as câmeras que não está vendo ({{Fechar todas}}) e abra de novo.',
          'Câmera sempre preta? Veja em Saúde dos aparelhos se há falha de câmera naquele canal.',
        ]],
      ],
      relacionados: ['mapa-cameras', 'tela-saude'],
    },
    {
      id: 'faq-senha', titulo: 'Esqueci a senha ou perdi o celular do autenticador',
      resumo: 'Como criar uma senha nova e entrar sem o código do aplicativo.',
      palavras: ['esqueci a senha', 'trocar senha', 'redefinir', 'perdi o celular', 'codigo de recuperacao', 'autenticador'],
      corpo: [
        ['lista', [
          '**Senha**: na tela de entrada, {{Esqueci minha senha}}. Chega um e-mail com o link para criar outra.',
          '**Autenticador**: entre com um dos **códigos de recuperação** (cada um vale uma vez) ou peça ao master para **zerar** a verificação do seu usuário.',
        ]],
      ],
      relacionados: ['comecar-sessao', 'comecar-entrar'],
    },
    {
      id: 'faq-aguardando', titulo: 'Meu cadastro está "aguardando aprovação"',
      resumo: 'Quem aprova e o que fazer enquanto isso.',
      palavras: ['aguardando aprovacao', 'pendente', 'nao consigo entrar', 'aprovar cadastro'],
      corpo: [
        ['p', 'Quem cria a conta com o código da empresa espera o **administrador da empresa** aprovar em Cadastros › Usuários. Avise o administrador; depois de aprovado, entre de novo com o e-mail e a senha.'],
      ],
      relacionados: ['comecar-entrar', 'implantacao-equipe'],
    },
    {
      id: 'faq-relatorio', titulo: '"Período longo demais" ao gerar um relatório',
      resumo: 'O limite de veículos × dias e como contornar.',
      palavras: ['periodo longo', 'relatorio grande', 'erro relatorio', 'limite', 'demora'],
      corpo: [
        ['p', 'Os relatórios calculados pelas posições aceitam até 400 veículos × dias por vez (ex.: 363 veículos por 1 dia, ou 13 veículos por 31 dias). Filtre por **grupo** ou **veículo**, ou divida o período. O relatório de Alertas aceita até 92 dias.'],
      ],
      relacionados: ['tela-relatorios'],
    },
    {
      id: 'faq-celular-aviso', titulo: 'Não recebo os avisos no celular',
      resumo: 'Permissão de notificação, iPhone pelo aplicativo instalado, economia de bateria e o envio de teste.',
      palavras: ['nao recebo aviso', 'notificacao nao chega', 'push', 'iphone', 'teste'],
      corpo: [
        ['passos', [
          'No alto-falante do topo › **Avisos no celular**, confira se o aparelho está na lista e use {{Enviar teste}}.',
          'Confira se as notificações do navegador (ou do app) estão permitidas no celular.',
          '**iPhone**: só funciona pelo FrotaGest instalado na Tela de Início (iOS 16.4 ou mais novo).',
          'Desligue a economia de bateria para o navegador, se o aviso atrasa.',
          'Lembre: chegam só os alertas da gravidade escolhida e dos veículos que você vê.',
        ]],
      ],
      relacionados: ['comecar-celular', 'comecar-app'],
    },
  ]);

  /* =================== TOURS (os elementos reais de cada tela) =================== */
  const lista = (id) => [`#${id}-novo`, `#${id}-tabela`];
  const tours = {
    dashboard: [
      { g: 1, alvo: ['#db-kpis', '.db'], titulo: 'Dashboard', texto: ['Os números da frota agora: km rodados hoje (comparados com ontem até a mesma hora), online, em movimento, alertas de hoje e na garagem.', 'Cada cartão tem o ícone **(i)**: passe o mouse para ver o que ele mostra. Clicar no cartão leva à tela do assunto.'] },
      { g: 1, alvo: '#db-grupo', titulo: 'Filtro por grupo', texto: 'Mostra o Dashboard de um grupo só (com os subgrupos). Vale para todos os cartões.' },
      { alvo: '#db-situacao', titulo: 'Situação da frota agora', texto: 'Em movimento, parados e offline, e como foi o dia. Clique numa faixa para ver esses veículos no mapa.' },
      { alvo: '#db-hora', titulo: 'Hoje, hora a hora', texto: 'Km (ou veículos rodando) em cada hora, com a linha de ontem. Passe o mouse nas barras.' },
      { alvo: '#db-dias', titulo: 'Últimos 14 dias', texto: 'Clique num dia para abrir o relatório daquele dia.' },
      { alvo: '#db-al', titulo: 'Alertas de hoje', texto: 'Por hora e por gravidade; ao lado, os tipos mais frequentes e os pendentes.' },
      { alvo: '#ini-offline', titulo: 'Sem comunicação', texto: 'Os aparelhos offline há mais tempo: comece por eles.' },
    ],
    empresas: [
      { g: 1, alvo: lista('empresas'), titulo: 'Empresas', texto: 'As empresas clientes: dados, o código para a equipe criar a conta e o logotipo que sai no painel e nos PDFs.' },
    ],
    aparelhos: [
      { g: 1, alvo: lista('aparelhos'), titulo: 'Aparelhos (DVR)', texto: 'Cada DVR pelo número do aparelho, com as câmeras (e o nome de cada uma), o chip e o protocolo.' },
      { alvo: '#aparelhos-tabela', titulo: 'Lista', texto: 'Clique num aparelho para editar. Aparelho desativado tem a conexão recusada pelo servidor.' },
    ],
    grupos: [
      { g: 1, alvo: lista('grupos'), titulo: 'Grupos', texto: 'Organize a frota em grupos e subgrupos. Eles filtram as telas e decidem quais veículos cada pessoa vê.' },
    ],
    veiculos: [
      { g: 1, alvo: lista('veiculos'), titulo: 'Veículos', texto: 'Prefixo, placa e grupo de cada veículo, ligado ao aparelho instalado nele.' },
      { alvo: '#veiculos-q', titulo: 'Busca', texto: 'Procure pela placa, prefixo ou grupo. "Mostrar inativos" traz os desativados.' },
    ],
    motoristas: [
      { g: 1, alvo: lista('motoristas'), titulo: 'Motoristas', texto: 'Nome, CNH com a validade e o cartão do DVR. A coluna **Agora** mostra em qual veículo cada um está.' },
    ],
    cercas: [
      { g: 1, alvo: ['#ce-nova', '#ce-lista'], titulo: 'Cercas', texto: 'Desenhe garagens, pontos, áreas de interesse e áreas proibidas, com avisos de entrada e saída.' },
      { alvo: '#ce-lista', titulo: 'Lista de cercas', texto: 'Quantos veículos estão dentro de cada cerca agora. Clique para ver no mapa e editar.' },
      { alvo: '#ce-map', titulo: 'Mapa', texto: 'Círculo: centro e raio pelas alças. Área livre: clique nos cantos.' },
    ],
    regras: [
      { g: 1, alvo: ['#rg-grade', '.rg-intro'], titulo: 'Regras de alerta', texto: 'Velocidade, uso fora do horário, parada longa, motor ligado parado, sem comunicação e direção contínua. Vale a regra mais específica (veículo, grupo, empresa).' },
      { alvo: '#rg-ap', titulo: 'Alarmes do próprio aparelho', texto: 'Os alarmes que o DVR decide sozinho. Desligue os que não interessam.' },
    ],
    usuarios: [
      { g: 1, alvo: ['#cod-empresa', '#usuarios-novo', '#usuarios-tabela'], titulo: 'Usuários', texto: 'Passe o código da empresa para a equipe criar a conta, aprove os cadastros e escolha o perfil e os grupos de cada pessoa.' },
      { alvo: '#usuarios-tabela', titulo: 'Equipe', texto: 'Perfil, grupos, verificação em duas etapas e o último acesso de cada um. Desative quem saiu.' },
    ],
    mapa: [
      { g: 1, alvo: ['.fleet', '#f-lista'], titulo: 'Monitoramento', texto: 'A lista da frota ao vivo. Busque pela placa, prefixo ou número do aparelho.' },
      { alvo: '#f-status', titulo: 'Filtros', texto: 'Todos, Online, Offline e Alerta, com a contagem de cada um. Ao lado, o grupo.' },
      { g: 1, alvo: ['#map-card', '#map'], titulo: 'Mapa', texto: ['Verde em movimento, azul parado, cinza offline, vermelho com alerta. Veículos próximos ficam agrupados.', 'Clique num veículo para abrir o painel: **câmeras ao vivo**, histórico, gravações, comandos, ocorrência e compartilhar localização.'] },
    ],
    alertas: [
      { g: 1, alvo: ['#al-sit', '.toolbar'], titulo: 'Alertas', texto: 'Filtre por situação, gravidade, veículo e período. Pendentes = novos e em tratamento.' },
      { g: 1, alvo: '#al-tabela', titulo: 'Tratar', texto: 'Cada alerta diz de onde veio, o motorista e quanto durou. **Tratar** registra o que foi feito; **Abrir ocorrência** cria o caso com provas.' },
      { alvo: '#al-som', titulo: 'Som e avisos', texto: 'O som e a notificação deste computador quando chega alerta novo.' },
    ],
    ocorrencias: [
      { g: 1, alvo: ['#oc-nova', '#oc-tabela'], titulo: 'Ocorrências', texto: 'Acidentes, assaltos, avarias e reclamações num lugar só, com as provas (câmeras do momento, fotos, arquivos), o trajeto, o andamento e o dossiê em PDF.' },
      { alvo: '#oc-tabela', titulo: 'Lista', texto: 'Clique numa ocorrência para abrir. A mais recente fica em cima.' },
    ],
    linhas: [
      { g: 1, alvo: ['#ln-abas', '#ln-corpo'], titulo: 'Linhas e horários', texto: 'Viagens do dia acompanhadas pelo GPS (no horário, atrasada, ponto pulado, fora da rota) e o cadastro das linhas.' },
      { alvo: '#ln-kpis', titulo: 'Resumo do dia', texto: 'Viagens do dia, em andamento (e quantas atrasadas agora), concluídas, não realizadas e as que saíram da rota. Clique num indicador para filtrar.' },
    ],
    acompanhamento: [
      { g: 1, alvo: ['#lk-novo', '#lk-tabela'], titulo: 'Links de acompanhamento', texto: 'Uma página sem login com a posição de um veículo ou as viagens de uma linha, para clientes e passageiros. Copie, mande pelo WhatsApp ou cancele.' },
    ],
    historico: [
      { g: 1, alvo: ['#hi-veic', '.toolbar'], titulo: 'Histórico', texto: 'Escolha o veículo e o período (até 7 dias) e clique em Buscar.' },
      { alvo: '#hi-rapido', titulo: 'Atalhos', texto: 'Última hora, últimas 6 horas, hoje e ontem.' },
      { g: 1, alvo: ['.hist-map', '#hmap'], titulo: 'Trajeto e reprodução', texto: 'O trajeto no mapa e o **play** para reproduzir, com a velocidade, seguir o veículo e pular paradas.' },
      { alvo: '#hi-tabela', titulo: 'Posições', texto: 'Da mais recente para a mais antiga (o botão de ordem troca). Clique numa posição para ir até ela.' },
    ],
    relatorios: [
      { g: 1, alvo: '#rl-tipos', titulo: 'Relatórios', texto: 'Escolha o relatório: resumo, velocidade, paradas, alertas, garagem, cercas, jornada, motoristas e viagens.' },
      { alvo: '.rel-filtros', titulo: 'Filtros', texto: 'Período, grupo, veículo e os ajustes de cada relatório.' },
      { g: 1, alvo: ['.rel-acoes', '#rl-gerar'], titulo: 'Gerar e baixar', texto: 'Veja na tela ou baixe em Excel e PDF (com o logotipo da empresa).' },
    ],
    gravacoes: [
      { g: 1, alvo: ['#gr-form', '.rec-form'], titulo: 'Gravações', texto: 'Busque no cartão do DVR pelo veículo, canal, data e horário. O aparelho precisa estar online.' },
      { alvo: '#gr-downloads', titulo: 'Downloads', texto: 'Os vídeos baixados em MP4. Ficam no servidor por poucos dias.' },
    ],
    manutencao: [
      { g: 1, alvo: ['#mn-abas', '#mn-corpo'], titulo: 'Manutenção e documentos', texto: 'Situação de cada veículo, planos por km e tempo, documentos com vencimento e as manutenções feitas. Tudo opcional.' },
    ],
    saude: [
      { g: 1, alvo: ['#sa-kpis', '#sa-tabela'], titulo: 'Saúde dos aparelhos', texto: 'Os DVRs que precisam de atenção: offline há dias, sem câmera, cartão, GPS ou alimentação. Clique num indicador para filtrar.' },
      { alvo: '#sa-xlsx', titulo: 'Para a manutenção', texto: 'Baixe a lista em Excel ou PDF.' },
    ],
    comunicacoes: [
      { g: 1, alvo: ['#co-tipo', '#co-tabela'], titulo: 'Comunicações', texto: 'Conexões, desconexões e comandos de cada aparelho, com a resposta. Serve para ver quando e quanto um aparelho cai.' },
    ],
    online: [
      { g: 1, alvo: ['#on-kpis', '#on-tabela'], titulo: 'Usuários online', texto: 'Quem está com o FrotaGest aberto, em qual aparelho e tela. **Encerrar** desconecta aquele aparelho.' },
    ],
    auditoria: [
      { g: 1, alvo: ['#au-acao', '#au-tabela'], titulo: 'Auditoria', texto: 'Quem fez o quê: acessos, cadastros, câmeras abertas, gravações, relatórios e alertas tratados.' },
    ],
    acesso: [
      { g: 1, alvo: ['.ac-usuarios', '#ac-lista'], titulo: 'Controle de acesso', texto: 'Escolha a pessoa e marque, menu por menu, o que ela pode ver, incluir, alterar e excluir.' },
      { alvo: ['#ac-matriz', '#ac-corpo'], titulo: 'Menus e ações', texto: 'O pontinho âmbar mostra o que difere do padrão do perfil. Vale na hora.' },
    ],
    sistema: [
      { g: 1, alvo: '#si-abas', titulo: 'Sistema', texto: 'Status do servidor, portas e protocolos, aparelhos pendentes, configurações (retenção, sessão, duas etapas, ordem das listas) e o log ao vivo.' },
    ],
    escala: [
      { g: 1, alvo: ['#es-importar', '.es-topo'], titulo: 'Importação da Escala Globus', texto: 'Importe o arquivo da escala gerado no Globus. A prévia mostra o que bateu (prefixo e chapa) antes de gravar.' },
      { alvo: ['#es-dia', '.es-topo'], titulo: 'Dia da escala', texto: 'Escolha o dia, ou um dos dias já importados.' },
      { alvo: '#es-pend', titulo: 'O que falta para vincular', texto: 'Motoristas sem cadastro, com o botão Cadastrar (nome e chapa já preenchidos), e veículos com prefixo diferente.' },
      { g: 1, alvo: ['#es-tabela', '#es-vazio'], titulo: 'Serviços do dia', texto: 'Linha, veículo, motorista e horários. O botão **Vincular** coloca o motorista no veículo, um serviço por vez, até o fim do serviço.' },
    ],
    guia: [
      { alvo: '.gu-cab', titulo: 'Guia do FrotaGest', texto: 'Busque o que quer fazer, refaça o tour e gere o manual em PDF.' },
      { alvo: '.gu-telas', titulo: 'Menus e telas', texto: 'Cada menu que você vê, com para que serve. Clique para ler o artigo da tela.' },
    ],
  };

  const tourInicio = [
    { titulo: 'Bem-vindo(a) ao tour do FrotaGest', texto: ['Vamos passar pelas telas que você usa e mostrar para que serve cada uma e onde ficam os botões principais.', 'Use **Próximo** e **Voltar** (ou as setas do teclado). **Esc** sai a qualquer momento. Nada é alterado no sistema durante o tour.'] },
    { alvo: '#nav', menu: true, celular: '#nav', titulo: 'Menu', texto: 'O Dashboard fica no alto; as telas ficam nos grupos **Cadastros**, **Operação**, **Controle** e **Procedimentos Auxiliares**. Clique no nome do grupo para abrir. Você só vê o que foi liberado para você.' },
    { alvo: '#sb-guia', menu: true, titulo: 'Guia do FrotaGest', texto: 'Este manual: para que serve cada tela, passo a passo, perguntas frequentes e este tour para rever quando quiser.' },
    { alvo: '#tb-empresa', perfis: ['master'], titulo: 'Empresa', texto: 'Escolha a empresa que as telas mostram, ou todas.' },
    { alvo: ['.tb-right'], celular: '.tb-right', titulo: 'Topo', texto: 'Tempo conectado, tema claro/escuro, atualizar a tela, **som e avisos no celular**, alertas pendentes (o sino) e sair. No celular, os menos usados ficam no **⋮**.' },
  ];
  const tourFim = [
    { alvo: '#tb-ajuda', celular: '#tb-mais', titulo: 'Ajuda desta tela', texto: ['Pronto! Quando tiver dúvida, use o botão **?**: ele abre o guia já na tela em que você está.', 'No Guia do FrotaGest há o passo a passo de cada tela, as perguntas frequentes, o manual em PDF e este tour.'] },
  ];
  /* ordem do tour geral: a mesma do menu (o Modo TV fica de fora: é a tela da parede) */
  const ordem = ['dashboard', 'empresas', 'aparelhos', 'grupos', 'veiculos', 'motoristas', 'cercas', 'regras', 'usuarios',
    'mapa', 'alertas', 'ocorrencias', 'linhas', 'acompanhamento', 'historico', 'relatorios', 'gravacoes', 'manutencao',
    'saude', 'comunicacoes', 'online', 'auditoria', 'acesso', 'sistema', 'escala'];

  /* "Comece por aqui": o essencial de cada perfil, na ordem de uso */
  const trilhas = {
    master: ['comecar-tela', 'implantacao-ordem', 'implantacao-aparelhos', 'tela-empresas', 'tela-aparelhos', 'tela-acesso', 'tela-sistema', 'tela-saude'],
    admin: ['comecar-tela', 'implantacao-ordem', 'tela-grupos', 'tela-veiculos', 'tela-cercas', 'tela-regras', 'implantacao-equipe', 'tela-acesso', 'comecar-celular'],
    operador: ['comecar-tela', 'tela-mapa', 'mapa-cameras', 'alertas-tratar', 'tela-historico', 'tela-gravacoes', 'ocorrencias-provas', 'comecar-som', 'comecar-celular'],
    visualizador: ['comecar-tela', 'tela-mapa', 'mapa-cameras', 'tela-alertas', 'tela-historico', 'tela-relatorios', 'comecar-celular'],
  };

  /* Implantação da empresa: o que GET /api/guia/implantacao confere */
  const implantacao = [
    { id: 'aparelhos', fase: '1. Aparelhos e frota', titulo: 'Aparelhos (DVR) cadastrados', texto: 'Cada DVR pelo número do aparelho (feito pela Reis Tecnologia).', pagina: 'aparelhos', artigo: 'implantacao-aparelhos', conta: 'aparelho(s)' },
    { id: 'comunicando', fase: '1. Aparelhos e frota', titulo: 'Aparelhos comunicando', texto: 'Pelo menos um DVR já se conectou ao servidor.', pagina: 'mapa', artigo: 'implantacao-aparelhos', conta: 'já conectaram' },
    { id: 'grupos', fase: '1. Aparelhos e frota', titulo: 'Grupos da frota', texto: 'Garagens, linhas ou contratos, para filtrar e decidir quem vê o quê.', pagina: 'grupos', artigo: 'tela-grupos', conta: 'grupo(s)' },
    { id: 'veiculos', fase: '1. Aparelhos e frota', titulo: 'Veículos com aparelho', texto: 'Prefixo, placa e grupo, ligados ao DVR instalado.', pagina: 'veiculos', artigo: 'tela-veiculos', conta: 'veículo(s)' },
    { id: 'garagem', fase: '2. Lugares e regras', titulo: 'Garagem desenhada', texto: 'Uma cerca com a finalidade Garagem: usada no Dashboard, nas regras e nos relatórios.', pagina: 'cercas', artigo: 'cercas-desenhar', conta: 'garagem(ns)' },
    { id: 'regras', fase: '2. Lugares e regras', titulo: 'Regras de alerta', texto: 'Velocidade, horário, paradas, motor ligado, sem comunicação, direção contínua.', pagina: 'regras', artigo: 'tela-regras', conta: 'regra(s) ligada(s)' },
    { id: 'equipe', fase: '3. Pessoas', titulo: 'Equipe no sistema', texto: 'Operadores e visualizadores aprovados em Usuários.', pagina: 'usuarios', artigo: 'implantacao-equipe', conta: 'pessoa(s)' },
    { id: 'motoristas', fase: '3. Pessoas', titulo: 'Motoristas (opcional)', texto: 'Para saber quem dirigia em cada alerta e na jornada.', pagina: 'motoristas', artigo: 'tela-motoristas', conta: 'motorista(s)' },
    { id: 'avisos', fase: '3. Pessoas', titulo: 'Avisos no celular', texto: 'Quem acompanha os alertas ativa no próprio celular.', pagina: null, artigo: 'comecar-celular', conta: 'aparelho(s)' },
    { id: 'logotipo', fase: '4. Identidade', titulo: 'Logotipo da empresa', texto: 'No topo do painel, no Modo TV e nos PDFs (enviado pelo master em Empresas).', pagina: 'empresas', artigo: 'tela-empresas', conta: '' },
  ];

  return { categorias, artigos, tours, tourInicio, tourFim, ordem, trilhas, implantacao };
})();
