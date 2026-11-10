# FrotaGest

**Monitoramento de frota em tempo real para DVRs 4G (JT/T 808 + JT/T 1078) — Reis Tecnologia**

Sistema próprio que substitui o CMSV6: mapa da frota ao vivo, câmeras ao vivo, gravações do cartão do DVR, alertas com registro do tratamento (com som e notificação na área de trabalho), histórico de trajetos, relatórios em Excel e PDF, comunicações dos aparelhos e auditoria. Atende várias empresas (cada uma vê só a própria frota), com a Reis Tecnologia como master.

> **Regra do banco:** nenhum vídeo é gravado no banco de dados. O MySQL guarda só cadastros, posições, alertas, comunicações e auditoria. O vídeo ao vivo passa direto do DVR para o navegador; os downloads de gravação ficam no disco do servidor por poucos dias (com limite de espaço) e são apagados sozinhos.

---

## 1. Como funciona

```
DVR 4G ──(JT/T 808, porta 6608)──► FrotaGest ──► MySQL 9 (Docker, 127.0.0.1:3306)
DVR 4G ──(JT/T 1078, porta 6602)─► FrotaGest ──► navegador (vídeo ao vivo, H.265 convertido para H.264)
Navegador ──HTTPS (Cloudflare + Nginx)──► FrotaGest (127.0.0.1:8080) ── login: Firebase Authentication
```

| Parte | Onde |
| --- | --- |
| Servidor (Node.js 20+, PM2) | `server.js`, `src/` — sem Express; única dependência de servidor: `mysql2` |
| Protocolo dos DVRs | `src/protocolo/` (JT/T 808-2013/2019 detectado sozinho, JT/T 1078) |
| Vídeo | `src/video/` (conversão H.265→H.264 com ffmpeg, downloads em MP4) |
| Banco | `src/banco/` (migrações aplicadas sozinhas ao iniciar) |
| Login e permissões | `src/auth/` (token do Firebase conferido sem `firebase-admin`) |
| Painel | `public/` (layout Reis Tecnologia: azul-marinho #1A2744, âmbar #F59E0B, Inter/Space Grotesk, ícones Tabler) |
| Instalação/atualização | `deploy/instalar-frotagest.sh`, `deploy/atualizar-frotagest.sh` |
| Domínio HTTPS | `tools/nginx/` |
| Simulador de DVR | `tools/simulador-dvr.js` |

## 2. Perfis de acesso

| Perfil | Vê | Pode fazer |
| --- | --- | --- |
| **Master** (Reis Tecnologia) | Todas as empresas | Tudo: empresas, aparelhos (DVR), portas/protocolos, aparelhos pendentes, configurações, sistema |
| **Administrador** da empresa | Toda a frota da empresa | Usuários, grupos e veículos da empresa; câmeras, gravações, alertas, comunicações, auditoria |
| **Operador** | Grupos liberados (ou todos) | Mapa, câmeras ao vivo, gravações do DVR, tratar alertas, histórico |
| **Visualizador** | Grupos liberados (ou todos) | Mapa, câmeras ao vivo, histórico, ver alertas |

Grupos podem ter subgrupos (ex.: Garagem › Linha 10); liberar um grupo libera os subgrupos. Aparelho ainda sem veículo só aparece para o administrador e o master.

## 3. O que fica no banco

| Tabela | Conteúdo | Guardado por (padrão) |
| --- | --- | --- |
| `empresas`, `usuarios`, `grupos`, `usuario_grupos` | Cadastros e acessos | sempre |
| `perfis_protocolo` | Portas e protocolo de cada tipo de aparelho (padrão: JT/T 808 + 1078, 6608/6602) | sempre |
| `aparelhos`, `veiculos` | DVRs (número, canais e nomes das câmeras, chip) e veículos (placa, prefixo, grupo) | sempre |
| `aparelhos_estado` | Último estado de cada aparelho (posição, online, sinal) | sempre |
| `aparelhos_pendentes` | DVRs que se conectaram sem cadastro | 30 dias sem contato |
| `posicoes` | Todas as posições recebidas | 90 dias |
| `alertas` | Alarmes do DVR e das cercas (início, fim, gravidade) e o tratamento (quem, quando, o quê) | 365 dias |
| `cercas` | Garagens, pontos/terminais e áreas desenhados no mapa (círculo ou área livre) e os avisos de cada uma | sempre |
| `sessoes_encerradas` | Logins encerrados por um administrador em “Usuários online” (só aquele aparelho) | 90 dias |
| `codigos_recuperacao`, `sessoes_2fa` | Verificação em duas etapas: códigos de recuperação (só o resumo SHA-256) e os logins que já passaram pela segunda etapa | até zerar / 90 dias |
| `eventos_aparelho`, `comandos` | Comunicações: conexões/desconexões e comandos enviados com a resposta | 180 dias |
| `auditoria` | Acessos, cadastros, câmeras abertas, gravações vistas e baixadas, relatórios exportados, tratamento de alertas | 730 dias (mínimo 180) |

Os prazos mudam em **Sistema › Configurações**; a limpeza roda sozinha toda madrugada (3h). Datas sempre no horário de Brasília.

## 3.1 Relatórios

Em **Operação › Relatórios**, na tela, em **Excel (.xlsx)** e em **PDF** (gerados pelo próprio servidor, sem biblioteca externa):

| Relatório | O que traz | Período |
| --- | --- | --- |
| Resumo por veículo | Km rodados, motor ligado, em movimento, parado ligado, velocidade máxima e média, excessos, paradas, alertas | até 31 dias* |
| Excessos de velocidade | Cada trecho acima do limite escolhido: início, fim, duração, máxima, média e local | até 31 dias* |
| Paradas | Onde e por quanto tempo ficou parado (a partir de N minutos), com o motor ligado ou desligado | até 31 dias* |
| Alertas | Alertas do período com gravidade, situação e tratamento | até 92 dias |
| Saídas e chegadas na garagem | A que horas cada veículo saiu e voltou, de qual garagem, tempo e km fora | até 31 dias* |
| Entradas e saídas das cercas | Cada passagem por ponto, terminal ou área: entrada, saída e tempo dentro | até 31 dias* |

\* Para não pesar o servidor, veículos × dias fica em até 400 (ex.: 363 veículos por 1 dia, ou 1 veículo por 31 dias); com mais veículos, filtre por grupo. Cada exportação fica na auditoria.

Os relatórios de garagem e de cercas são calculados pelas posições guardadas: uma cerca desenhada hoje já mostra as saídas da semana passada.

## 3.2 Mapa, histórico e saúde dos aparelhos

- **Veículos próximos agrupados no mapa:** viram uma bolinha com o número (vermelha se algum tem alerta, verde se algum anda, azul parado, cinza offline). Clicar aproxima; se estão todos no mesmo lugar (garagem), abre a lista para escolher. O botão “Agrupado” no mapa liga e desliga.
- **Reproduzir o trajeto** (Histórico): play/pausa, velocidade de 1× a 300×, linha do tempo com os alarmes marcados, seguir o veículo e pular as paradas. Clicar numa posição da tabela leva a reprodução até ela; a barra de espaço reproduz e pausa.
- **Saúde dos aparelhos** (Controle, para administrador e master): aparelhos offline há mais de 1 dia (grave depois de 3), que nunca conectaram, com falha de câmera ou de vídeo, de cartão/HD, de GPS, de alimentação ou com sinal fraco do chip. Lista com filtros, atalhos para mapa, histórico e comunicações, e exportação em Excel e PDF para a manutenção. O Início avisa e o menu mostra quantos estão graves.

## 3.3 Cercas, modo TV e usuários online

- **Cercas virtuais** (Cadastros › Cercas, depois de Veículos): desenhe no mapa a **garagem**, os **pontos/terminais**, **áreas de interesse** e **áreas proibidas**, em círculo (centro + raio, com alças para mover e aumentar) ou em área livre (clique nos cantos; arraste para ajustar; clique no meio de um lado para criar canto). Cada cerca vale para todos os veículos da empresa ou só para um grupo.
  - Avisos: na entrada e/ou na saída, sempre ou só **fora do horário permitido** (ex.: garagem das 04:00 às 23:00 avisa o ônibus que sai de madrugada). A área proibida abre um alerta grave enquanto o veículo estiver dentro e fecha quando ele sai. Os avisos entram em Alertas, com som e notificação.
  - Para não avisar à toa: para sair é preciso passar 25 m da borda (GPS oscilando com o ônibus parado no portão) e saltos impossíveis do GPS são ignorados.
  - A lista mostra quantos veículos estão dentro de cada cerca agora; o Monitoramento desenha as cercas (botão “Cercas”) e o detalhe do veículo diz em que garagem ou área ele está.
- **Modo TV** (Operação › Modo TV): tela para o monitor da parede da central, sempre escura, sem menu. Mapa grande, frota agora (em movimento, parados, offline, com alerta), garagens com quantos veículos estão dentro e os alertas pendentes; alerta novo faz a tela piscar (vermelho se for grave). Troca sozinha entre toda a frota e os grupos (a cada 30 s a 5 min, ou parado), tecla F para tela cheia e ← → para trocar o grupo. No modo TV a sessão não encerra por falta de uso e a tela não apaga (nos navegadores que permitem).
- **Usuários online** (Controle, para administrador e master): quem está com o painel aberto, desde quando, de qual aparelho e navegador, em qual tela e há quanto tempo não mexe. **Encerrar** desconecta só aquele aparelho (a pessoa entra de novo com a senha; as outras sessões dela continuam) e fica na auditoria. O administrador vê só a própria empresa e não vê nem encerra o master. Para bloquear de vez, desative o usuário.

## 3.4 Verificação em duas etapas (Google Authenticator)

Feita no próprio FrotaGest: o Firebase continua só com o e-mail e a senha, **não muda nada no projeto do Firebase e não tem custo** (não usa o Identity Platform nem SMS).

- **Quem ativa é o master**: em **Sistema › Configurações › Segurança**, marca para quais perfis é obrigatória (master, administradores, operadores, visualizadores) e, em **Cadastros › Usuários**, pode exigir de uma pessoa específica. O administrador da empresa não muda essa regra.
- **No próximo acesso** a pessoa lê um QR Code com o Google Authenticator (ou Microsoft Authenticator, Authy), digita o primeiro código e recebe **10 códigos de recuperação** (cada um vale uma vez; dá para copiar ou baixar em .txt). Depois disso, a cada login pede o código de 6 dígitos.
- Cada login (aparelho/navegador) passa uma vez pela segunda etapa e não pede de novo até sair ou a sessão encerrar. Enquanto o código não é confirmado, nada do painel é liberado (nem mapa, nem vídeo, nem tempo real). Ligar a regra vale na hora, também para quem já está conectado.
- O mesmo código não vale duas vezes e 6 códigos errados seguidos bloqueiam por 10 minutos. Tudo fica na auditoria.
- **Perdeu o celular:** entra com um código de recuperação, ou o master abre o usuário e clica em **Zerar** (a pessoa lê um QR Code novo no próximo acesso).
- **Se o próprio master perder o celular e os códigos**, no servidor: `cd ~/frotagest && node tools/zerar-2fa.js email@do.master && pm2 restart frotagest`.
- A chave de cada pessoa fica cifrada no banco; a chave da cifra fica em `data/chave-2fa.key` (criada sozinha, fora do banco e do GitHub). **Guarde esse arquivo junto com o backup do banco:** sem ele, quem usa duas etapas precisa ser zerado.

## 3.5 Sessão e avisos

- **Sessão encerrada por falta de uso** depois do tempo de **Sistema › Configurações › Segurança** (padrão 60 min; 0 = nunca, só para telas de central/TV). Um minuto antes aparece “Você ainda está aí?”. Vale também se a janela foi fechada sem clicar em Sair.
- **Tema claro ou escuro:** botão da lua/sol no topo; a escolha fica no navegador (sem escolha, segue o tema do sistema). No escuro, o mapa de ruas também escurece; o satélite fica como está.
- **Barra do topo:** tempo conectado, botão de atualizar a tela, botão do som dos alertas (só gravidade alta, alta e média, todos ou sem som, e notificação na área de trabalho) e aviso quando sai uma versão nova.
- **Tela de entrada** no padrão do OdontoWorld e do CondoGest (um ônibus percorre as linhas trazendo a frase e estaciona no fim), com “Lembrar meu e-mail” (guarda só o e-mail, e só se a pessoa marcar) e os links de **Termos de uso** (`/termos`) e **Política de privacidade** (`/privacidade`, LGPD).

---

## 4. Instalação (primeira vez)

### 4.1 Firebase (login)

1. Em <https://console.firebase.google.com>, crie o projeto **FrotaGest** (sem Analytics).
2. **Authentication › Sign-in method**: ative **E-mail/senha**.
3. **Authentication › Settings › Authorized domains**: adicione `frotagest.reisconsultoriatec.com`.
4. **Authentication › Templates**: troque o idioma para **Português (Brasil)** (e-mails de criar/redefinir senha).
5. **Configurações do projeto › Geral › Seus apps › Web (</>)**: registre o app “FrotaGest” e anote `apiKey` e `projectId`.

> Mantenha ligada a opção de criar contas (Authentication › Settings › User actions): é por ela que cada pessoa cria o próprio login na tela **Criar conta**. Login sem cadastro aprovado no FrotaGest não entra.

Não é preciso criar usuários no console do Firebase: todos (inclusive o master) criam o login pela tela de entrada do FrotaGest.

### 4.2 GitHub

O código fica no repositório **reisconsultoriatec-collab/frotagest** (recomendado: **privado**). Num repositório privado, o servidor precisa de uma chave de leitura (deploy key):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/frotagest_deploy -N ""      # na instância "cameras"
cat ~/.ssh/frotagest_deploy.pub                               # copie a linha
```

No GitHub: repositório › **Settings › Deploy keys › Add deploy key** (só leitura) e cole a linha. Depois:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-frotagest
  HostName github.com
  User git
  IdentityFile ~/.ssh/frotagest_deploy
EOF
git clone git@github-frotagest:reisconsultoriatec-collab/frotagest.git ~/frotagest
```

(Repositório público: `git clone https://github.com/reisconsultoriatec-collab/frotagest.git ~/frotagest`.)

### 4.3 Servidor (instância “cameras”)

A instância usa o Ubuntu “minimizado”, que vem sem o git. Instale-o antes de clonar:

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/reisconsultoriatec-collab/frotagest.git ~/frotagest
bash ~/frotagest/deploy/instalar-frotagest.sh
```

O script (rode **sem sudo**; ele pede a senha quando precisa):

1. instala o que faltar (Docker, ffmpeg, git, curl, nano, PM2);
2. cria o **MySQL 9 no Docker** (`frotagest-mysql`, só em 127.0.0.1, sem log binário, 1 GB de cache) com senhas aleatórias em `~/.frotagest-mysql`;
3. roda o `npm install`;
4. cria o `config.json`: pergunta `apiKey`, `projectId` e o seu e-mail (master) e copia do laboratório o domínio e o endereço de vídeo;
5. **para o laboratório** (as portas 6608/6602/8080 passam para o FrotaGest — para voltar: `pm2 stop frotagest && pm2 start frotagest-lab`);
6. confere as portas 6608/6602 no iptables;
7. sobe o FrotaGest no PM2 e confere o `/api/saude`.

O Nginx e o certificado da Cloudflare que já publicam o laboratório continuam valendo (mesma porta 8080). Numa instância nova: `sudo bash tools/nginx/instalar-dominio.sh frotagest.reisconsultoriatec.com`.

### 4.4 Primeiro acesso (master)

1. Abra <https://frotagest.reisconsultoriatec.com> e clique na aba **Criar conta**.
2. Preencha nome, o **e-mail de proprietário** (o informado no instalador) e uma senha (mínimo de 8 caracteres, com maiúscula e número). **Deixe o código da empresa em branco.**
3. Abra o e-mail de confirmação (veja o spam), clique no link e volte em **Já confirmei**. Você entra como **master**.
4. Cadastre na ordem: **Empresas › Aparelhos (DVR) › Grupos › Veículos**.
   - DVRs que já se conectaram aparecem em **Sistema › Aparelhos pendentes** (e no mapa, em âmbar): clique em **Cadastrar** e o número vem preenchido.

### 4.5 Usuários das empresas (mesmo modelo do EduGest)

1. Cada empresa tem um **código de cadastro** (Usuários, no topo da tela; ou a coluna Código em Empresas). Passe o código para a equipe.
2. A pessoa abre o FrotaGest › **Criar conta** › nome, e-mail, senha e o código. O cadastro fica **aguardando aprovação**.
3. O administrador da empresa (ou o master) vê o aviso no Início e o selo no menu **Usuários**, clica em **Aprovar** e escolhe o perfil e os grupos (ou **Recusar**).
4. A pessoa clica em “Verificar novamente” e entra. Senha esquecida: “Esqueci minha senha” na tela de entrada.

“Gerar outro” troca o código (o antigo para de valer; quem já tem login não é afetado). Também dá para **convidar por e-mail** em Usuários: a pessoa recebe o link para criar a senha, sem precisar de aprovação.

## 5. Atualização

```bash
~/atualizar-frotagest.sh
```

Baixa a versão nova do GitHub, roda `npm install` só se as dependências mudaram, reinicia no PM2 e confere a saúde. As mudanças de banco são aplicadas sozinhas ao iniciar (tabela `migracoes`). `config.json`, `data/` e as senhas nunca são tocados.

## 6. Portas e protocolos

Em **Sistema › Portas e protocolos** o master cria perfis com outras portas (e, no futuro, outros protocolos). Cada aparelho usa um perfil; o padrão é **JT/T 808 + JT/T 1078 nas portas 6608/6602**. As portas abrem e fecham na hora, sem reiniciar. Porta nova precisa ser liberada também na **Lista de Segurança da Oracle** e no **iptables** (`sudo iptables -I INPUT <n> -p tcp --dport <porta> -j ACCEPT` antes da regra REJECT, depois `sudo netfilter-persistent save`).

Cada perfil também diz o **horário configurado no aparelho** (Brasília, ou UTC+8 como manda a norma); o FrotaGest converte para Brasília antes de gravar.

**Aparelhos sem cadastro** (Sistema › Configurações): *listar* (aceita a conexão e mostra em Pendentes, nada vai para o banco) ou *recusar* (derruba a conexão; use quando toda a frota estiver cadastrada).

## 7. `config.json`

| Seção | Chave | Padrão | Para quê |
| --- | --- | --- | --- |
| `banco` | `host`, `porta`, `usuario`, `senha`, `nome` | 127.0.0.1, 3306, frotagest | MySQL (preenchido pelo instalador) |
| `banco` | `fusoMinutos` | -180 | Fuso de todas as datas (Brasília) |
| `firebase` | `apiKey`, `projectId`, `authDomain` | — | Login (app da Web do Firebase) |
| `proprietarios` | lista de e-mails | — | Quem entra como master no primeiro acesso (com e-mail confirmado) |
| `gateway` | `maxConnections`, `idleTimeoutSec` | 1000, 300 | Conexões dos DVRs |
| `gateway` | `acceptUnknownAuthCode` | true | Aceita DVRs com código de autenticação de outra plataforma (vindos do CMSV6) |
| `media` | `publicHost` | — | IP/nome que o DVR usa para mandar vídeo (ex.: 144.22.152.40) |
| `media` | `autoStopSec` | 20 | Fecha o vídeo no DVR quando ninguém assiste (economiza o chip) |
| `media` | `converterH265`, `maxConversoes`, `maxKbpsConversao` | true, 6, 1000 | Conversão H.265→H.264 no servidor |
| `web` | `port`, `allowedHosts`, `publicUrl` | 8080 | Painel atrás do Nginx |
| `gravacoes` | `maxGB`, `retencaoDias` | 5, 7 | Espaço e prazo dos downloads de gravação (disco, nunca banco) |
| `logs` | `diasArquivo` | 14 | Log do servidor em `data/logs` |

## 8. Segurança

- Login pelo Firebase; o servidor confere a assinatura do token (RS256, certificados públicos do Google), o projeto, o emissor e a validade — sem chave de conta de serviço no servidor.
- Toda rota confere perfil, empresa e grupos; quem não pode ver um veículo recebe “não encontrado”. Eventos em tempo real e vídeo seguem as mesmas regras.
- Conexões em tempo real usam bilhete de uso único (60 s): o token nunca vai no endereço.
- 30 tentativas inválidas em 10 min bloqueiam o IP por 15 min (IP real vindo da Cloudflare).
- Banco só em 127.0.0.1; senhas aleatórias; entradas validadas e SQL sempre parametrizado.
- Cabeçalhos de segurança (CSP, HSTS pelo Nginx, sem iframe); só os arquivos do painel são servidos.
- Auditoria de acessos, senhas erradas, cadastros e aprovações, câmeras ao vivo abertas, gravações vistas e baixadas, relatórios exportados, sessões encerradas por falta de uso e tratamento de alertas.
- Sessão encerrada depois de um tempo sem uso (configurável), mesmo com a janela fechada.
- Criar conta exige o código da empresa e a aprovação do administrador; o código pode ser trocado a qualquer momento.
- 2FA: previsto para uma próxima etapa.

## 9. Testar sem o DVR

```bash
node tools/simulador-dvr.js --id 20250703            # DVR simulado (posições, alarmes, vídeo H.264)
node tools/simulador-dvr.js --id 20250703 --h265     # vídeo H.265
```

## 10. Problemas comuns

| Sintoma | O que fazer |
| --- | --- |
| “Login ainda não configurado” | Preencha `firebase` no `config.json` e `pm2 restart frotagest` |
| “Falta concluir o seu cadastro” | O login existe no Firebase mas não no FrotaGest: informe o código da empresa (o proprietário deixa em branco) |
| “Aguardando aprovação” | O administrador da empresa aprova em Usuários |
| “Confirme o seu e-mail” | Primeiro acesso do master (ou de quem já tinha conta no Firebase): confirme pelo link |
| “E-mail ou senha incorretos” | Confira a senha ou use “Esqueci minha senha”; quem nunca criou o login usa “Criar conta” |
| E-mail de criar senha não chega | Veja o spam; Authentication › Templates; em Usuários › abrir › “Reenviar e-mail” |
| “Banco de dados indisponível” | `sudo docker ps` / `sudo docker start frotagest-mysql`; as posições ficam na fila e são gravadas quando o banco volta |
| DVR não aparece | Sistema › Log ao vivo; Sistema › Aparelhos pendentes; portas na Oracle e no iptables |
| Câmera não abre | O aparelho está online? `media.publicHost` com o IP público; porta 6602 liberada |
| Erro 521/522 na Cloudflare | `pm2 status`; `sudo systemctl status nginx` |

Logs: `pm2 logs frotagest` · `data/logs/frotagest-AAAA-MM-DD.jsonl` · `sudo docker logs frotagest-mysql --tail 50`

---

Reis Tecnologia · uso restrito. Licenças de terceiros em `LICENCAS-TERCEIROS.md`.
