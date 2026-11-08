# FrotaGest

**Monitoramento de frota em tempo real para DVRs 4G (JT/T 808 + JT/T 1078) — Reis Tecnologia**

Sistema próprio que substitui o CMSV6: mapa da frota ao vivo, câmeras ao vivo, gravações do cartão do DVR, alertas com registro do tratamento, histórico de trajetos, comunicações dos aparelhos e auditoria. Atende várias empresas (cada uma vê só a própria frota), com a Reis Tecnologia como master.

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
| `alertas` | Alarmes (início, fim, gravidade) e o tratamento (quem, quando, o quê) | 365 dias |
| `eventos_aparelho`, `comandos` | Comunicações: conexões/desconexões e comandos enviados com a resposta | 180 dias |
| `auditoria` | Acessos, cadastros, vídeos assistidos, downloads, tratamento de alertas | 730 dias |

Os prazos mudam em **Sistema › Configurações**; a limpeza roda sozinha toda madrugada (3h). Datas sempre no horário de Brasília.

---

## 4. Instalação (primeira vez)

### 4.1 Firebase (login)

1. Em <https://console.firebase.google.com>, crie o projeto **FrotaGest** (sem Analytics).
2. **Authentication › Sign-in method**: ative **E-mail/senha**.
3. **Authentication › Settings › Authorized domains**: adicione `frotagest.reisconsultoriatec.com`.
4. **Authentication › Templates**: troque o idioma para **Português (Brasil)** (e-mails de criar/redefinir senha).
5. **Configurações do projeto › Geral › Seus apps › Web (</>)**: registre o app “FrotaGest” e anote `apiKey` e `projectId`.
6. **Authentication › Users › Add user**: crie o seu login (o e-mail que será o master).

> Mantenha ligada a opção de criar contas (Authentication › Settings › User actions): é por ela que o FrotaGest cria o login de quem você cadastrar e envia o e-mail para a pessoa criar a senha. Conta criada fora do FrotaGest não entra: sem cadastro no sistema, o acesso é recusado.

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

### 4.4 Primeiro acesso

1. Abra <https://frotagest.reisconsultoriatec.com> e entre com o login criado no Firebase.
2. O FrotaGest pede para **confirmar o e-mail** (clique em “Enviar o link de novo”, abra o e-mail e depois “Já confirmei”). Você entra como **master**.
3. Cadastre na ordem: **Empresas › Aparelhos (DVR) › Grupos › Veículos › Usuários**.
   - DVRs que já se conectaram aparecem em **Sistema › Aparelhos pendentes** (e no mapa, em âmbar): clique em **Cadastrar** e o número vem preenchido.
   - Ao cadastrar um usuário, ele recebe um e-mail para criar a senha.

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
- Auditoria de acessos, cadastros, vídeos de gravação, downloads e tratamento de alertas.
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
| “Seu login não tem cadastro no FrotaGest” | Cadastre a pessoa em Usuários (ou confira o e-mail em `proprietarios`) |
| “Confirme o seu e-mail” | Primeiro acesso do master (ou de quem já tinha conta no Firebase): confirme pelo link |
| E-mail de criar senha não chega | Veja o spam; Authentication › Templates; em Usuários › abrir › “Reenviar e-mail” |
| “Banco de dados indisponível” | `sudo docker ps` / `sudo docker start frotagest-mysql`; as posições ficam na fila e são gravadas quando o banco volta |
| DVR não aparece | Sistema › Log ao vivo; Sistema › Aparelhos pendentes; portas na Oracle e no iptables |
| Câmera não abre | O aparelho está online? `media.publicHost` com o IP público; porta 6602 liberada |
| Erro 521/522 na Cloudflare | `pm2 status`; `sudo systemctl status nginx` |

Logs: `pm2 logs frotagest` · `data/logs/frotagest-AAAA-MM-DD.jsonl` · `sudo docker logs frotagest-mysql --tail 50`

---

Reis Tecnologia · uso restrito. Licenças de terceiros em `LICENCAS-TERCEIROS.md`.
