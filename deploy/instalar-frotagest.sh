#!/usr/bin/env bash
# =====================================================================
#  FrotaGest — instalação no servidor (Oracle ARM, Ubuntu 24.04)
#  Reis Tecnologia
#
#  Uso (como o seu usuário, SEM sudo — o script pede a senha quando precisa):
#    git clone <endereço do repositório> ~/frotagest
#    bash ~/frotagest/deploy/instalar-frotagest.sh
#
#  1. Instala o que faltar: Docker, ffmpeg, git, curl, nano (e o PM2)
#  2. Cria o MySQL 9 no Docker (contêiner frotagest-mysql, só em 127.0.0.1)
#     com senhas aleatórias guardadas em ~/.frotagest-mysql
#  3. Instala as dependências (npm install)
#  4. Cria o config.json (pergunta o Firebase e o e-mail do proprietário;
#     aproveita domínio e IP do laboratório, se ele existir)
#  5. Para o laboratório (as portas 6608/6602/8080 passam para o FrotaGest)
#  6. Confere as portas 6608 e 6602 no firewall do servidor
#  7. Sobe o FrotaGest no PM2 e confere se respondeu
#
#  Pode rodar de novo: o que já estiver pronto é mantido (banco e config.json nunca são apagados).
# =====================================================================

main() {
  set -euo pipefail
  local PASTA CRED LAB CONTAINER="frotagest-mysql" IMAGEM="mysql:9" DADOS_MYSQL="/var/lib/frotagest-mysql"
  PASTA="$(cd "$(dirname "$0")/.." && pwd)"
  CRED="$HOME/.frotagest-mysql"
  LAB="$HOME/frotagest-lab"

  passo() { echo; echo "==> $*"; }
  erro() { echo; echo "ERRO: $*"; exit 1; }
  perguntar() { local r=""; read -rp "    $1" r || true; printf '%s' "$r"; }

  [ "$(id -u)" != 0 ] || erro "rode como o seu usuário, sem sudo:  bash ~/frotagest/deploy/instalar-frotagest.sh"
  [ -f "$PASTA/server.js" ] || erro "não encontrei o FrotaGest em $PASTA"
  command -v node >/dev/null || erro "o Node.js não está instalado (precisa da versão 20 ou mais nova)"
  local NODE_MAIOR
  NODE_MAIOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAIOR" -ge 20 ] || erro "o Node.js é $(node -v); precisa da versão 20 ou mais nova"

  passo "1/7 Programas necessários"
  local FALTA=()
  command -v docker >/dev/null || FALTA+=(docker.io)
  command -v ffmpeg >/dev/null || FALTA+=(ffmpeg)
  command -v git >/dev/null || FALTA+=(git)
  command -v curl >/dev/null || FALTA+=(curl)
  command -v nano >/dev/null || FALTA+=(nano)
  command -v openssl >/dev/null || FALTA+=(openssl)
  if [ "${#FALTA[@]}" -gt 0 ]; then
    echo "    instalando: ${FALTA[*]}"
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${FALTA[@]}" >/dev/null
  else
    echo "    tudo instalado"
  fi
  sudo systemctl enable --now docker >/dev/null 2>&1 || true
  if ! command -v pm2 >/dev/null; then
    echo "    instalando o PM2"
    sudo npm install -g pm2 --no-audit --no-fund >/dev/null
  fi

  passo "2/7 Banco de dados (MySQL 9 no Docker)"
  local SENHA_ROOT SENHA_APP
  if sudo docker inspect "$CONTAINER" >/dev/null 2>&1; then
    echo "    o contêiner $CONTAINER já existe: mantido como está"
    [ -f "$CRED" ] || erro "o contêiner existe mas não achei $CRED com as senhas. Preencha a seção \"banco\" do config.json à mão."
    # shellcheck disable=SC1090
    . "$CRED"
    sudo docker start "$CONTAINER" >/dev/null 2>&1 || true
  else
    SENHA_ROOT="$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 28)"
    SENHA_APP="$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 28)"
    umask 077
    printf 'SENHA_ROOT=%s\nSENHA_APP=%s\n' "$SENHA_ROOT" "$SENHA_APP" > "$CRED"
    umask 022
    echo "    senhas geradas e guardadas em $CRED (só o seu usuário lê)"
    sudo mkdir -p "$DADOS_MYSQL"
    echo "    baixando a imagem $IMAGEM e criando o contêiner (pode levar alguns minutos)..."
    # 127.0.0.1: o banco não fica exposto na internet. Sem log binário (não há réplica) para o disco não encher.
    sudo docker run -d --name "$CONTAINER" --restart unless-stopped \
      -p 127.0.0.1:3306:3306 \
      -v "$DADOS_MYSQL":/var/lib/mysql \
      -e MYSQL_ROOT_PASSWORD="$SENHA_ROOT" \
      -e MYSQL_DATABASE=frotagest \
      -e MYSQL_USER=frotagest \
      -e MYSQL_PASSWORD="$SENHA_APP" \
      "$IMAGEM" \
      --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci \
      --default-time-zone=-03:00 --skip-name-resolve --disable-log-bin \
      --innodb-buffer-pool-size=1G --max-connections=80 --performance-schema=OFF >/dev/null
  fi
  echo -n "    aguardando o MySQL ficar pronto"
  local i
  for i in $(seq 1 90); do
    if sudo docker exec -e MYSQL_PWD="$SENHA_APP" "$CONTAINER" mysql -ufrotagest -e 'SELECT 1' frotagest >/dev/null 2>&1; then echo " pronto"; break; fi
    echo -n "."
    sleep 2
    [ "$i" = 90 ] && { echo; erro "o MySQL não respondeu em 3 minutos. Veja: sudo docker logs $CONTAINER --tail 30"; }
  done

  passo "3/7 Dependências do FrotaGest"
  (cd "$PASTA" && npm install --omit=dev --no-audit --no-fund >/dev/null && sha256sum package.json | cut -c1-64 > node_modules/.frotagest-pacote)
  echo "    instaladas"

  passo "4/7 Configuração (config.json)"
  if [ -f "$PASTA/config.json" ]; then
    echo "    config.json já existe: mantido (só confiro a senha do banco)"
    node -e '
      const fs = require("fs"); const [f, senha] = process.argv.slice(1);
      const c = JSON.parse(fs.readFileSync(f, "utf8")); c.banco = c.banco || {};
      if (!c.banco.senha) { c.banco.senha = senha; c.banco.usuario = c.banco.usuario || "frotagest"; fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n"); console.log("    senha do banco preenchida"); }
    ' "$PASTA/config.json" "$SENHA_APP"
  else
    echo "    Dados do Firebase (console.firebase.google.com › Configurações do projeto › Seus apps › app da Web):"
    local API_KEY PROJETO DONO
    API_KEY="$(perguntar 'apiKey: ')"
    PROJETO="$(perguntar 'projectId: ')"
    DONO="$(perguntar 'Seu e-mail de login (será o master do sistema): ' | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    node -e '
      const fs = require("fs");
      const [exemplo, destino, senha, apiKey, projeto, dono, lab] = process.argv.slice(1);
      const c = JSON.parse(fs.readFileSync(exemplo, "utf8"));
      c.banco.senha = senha;
      c.firebase.apiKey = apiKey.trim();
      c.firebase.projectId = projeto.trim();
      c.firebase.authDomain = projeto.trim() ? projeto.trim() + ".firebaseapp.com" : "";
      c.proprietarios = /@/.test(dono) ? [dono] : [];
      // aproveita o que já funciona no laboratório: domínio, endereço de vídeo e conversão
      try {
        const l = JSON.parse(fs.readFileSync(lab, "utf8"));
        if (l.web) { c.web.allowedHosts = l.web.allowedHosts || []; c.web.publicUrl = l.web.publicUrl || ""; c.web.port = l.web.port || 8080; }
        if (l.media) { for (const k of ["publicHost", "converterH265", "maxConversoes", "maxKbpsConversao", "autoStopSec"]) if (l.media[k] !== undefined) c.media[k] = l.media[k]; }
        if (l.gravacoes) { for (const k of ["tipoMidia", "tipoFluxo", "armazenamento", "maxGB", "retencaoDias"]) if (l.gravacoes[k] !== undefined) c.gravacoes[k] = l.gravacoes[k]; }
        console.log("    domínio e endereço de vídeo copiados do laboratório");
      } catch { /* sem laboratório */ }
      fs.writeFileSync(destino, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    ' "$PASTA/config.exemplo.json" "$PASTA/config.json" "$SENHA_APP" "$API_KEY" "$PROJETO" "$DONO" "$LAB/config.json"
    chmod 600 "$PASTA/config.json"
    echo "    config.json criado (pode ajustar depois com: nano $PASTA/config.json)"
  fi

  passo "5/7 Laboratório"
  local LAB_ONLINE
  LAB_ONLINE="$(pm2 jlist 2>/dev/null | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{try{const l=JSON.parse(d).find((p)=>p.name==="frotagest-lab");process.stdout.write(l&&l.pm2_env&&l.pm2_env.status==="online"?"1":"0")}catch{process.stdout.write("0")}})')"
  if [ "$LAB_ONLINE" = 1 ]; then
    echo "    O laboratório (frotagest-lab) usa as mesmas portas (6608, 6602 e 8080)."
    local R
    R="$(perguntar 'Parar o laboratório agora e colocar o FrotaGest no lugar? [s/N] ')"
    case "$R" in
      s|S|sim|SIM) pm2 stop frotagest-lab >/dev/null && echo "    laboratório parado (para voltar: pm2 stop frotagest && pm2 start frotagest-lab)" ;;
      *) erro "instalação interrompida antes de subir o FrotaGest. Rode de novo quando puder parar o laboratório." ;;
    esac
  else
    echo "    laboratório parado ou não instalado: nada a fazer"
  fi

  passo "6/7 Portas dos DVRs no firewall do servidor"
  local p N
  for p in 6608 6602; do
    if sudo iptables -C INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT 2>/dev/null; then
      echo "    porta $p já liberada"
    else
      N="$(sudo iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')"
      if [ -n "$N" ]; then sudo iptables -I INPUT "$N" -p tcp -m state --state NEW --dport "$p" -j ACCEPT
      else sudo iptables -A INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT; fi
      echo "    porta $p liberada"
    fi
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then sudo netfilter-persistent save >/dev/null 2>&1 || true; fi
  echo "    (na Oracle, as portas 6608 e 6602 também precisam estar na Lista de Segurança — como no laboratório)"

  passo "7/7 Subindo o FrotaGest"
  if pm2 describe frotagest >/dev/null 2>&1; then
    pm2 restart frotagest --update-env >/dev/null
  else
    (cd "$PASTA" && pm2 start server.js --name frotagest --time >/dev/null)
  fi
  pm2 save >/dev/null
  if [ ! -f "$HOME/.frotagest-logrotate" ] && ! pm2 describe pm2-logrotate >/dev/null 2>&1; then
    if pm2 install pm2-logrotate >/dev/null 2>&1 && pm2 set pm2-logrotate:max_size 10M >/dev/null && pm2 set pm2-logrotate:retain 14 >/dev/null && pm2 set pm2-logrotate:compress true >/dev/null; then
      touch "$HOME/.frotagest-logrotate"
    fi
  fi
  ln -sf "$PASTA/deploy/atualizar-frotagest.sh" "$HOME/atualizar-frotagest.sh"
  local PORTA SAUDE=""
  PORTA="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).web?.port || 8080' "$PASTA/config.json")"
  for i in $(seq 1 20); do
    SAUDE="$(curl -s --noproxy '*' --max-time 5 "http://127.0.0.1:$PORTA/api/saude" || true)"
    echo "$SAUDE" | grep -q '"status":"ok"' && break
    sleep 2
  done
  echo "$SAUDE" | grep -q '"status":"ok"' || erro "o FrotaGest não respondeu. Veja: pm2 logs frotagest --lines 40 --nostream"
  echo "    FrotaGest no ar: $SAUDE"

  local URL
  URL="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).web?.publicUrl || ""' "$PASTA/config.json")"
  echo
  echo "Pronto!"
  echo "  Painel:       ${URL:-http://127.0.0.1:$PORTA (configure o domínio: sudo bash tools/nginx/instalar-dominio.sh)}"
  echo "  Atualizar:    ~/atualizar-frotagest.sh"
  echo "  Logs:         pm2 logs frotagest"
  echo "  Senhas do banco: $CRED"
  echo
  echo "Primeiro acesso: no Firebase, crie o seu login (Authentication › Users › Add user) com o e-mail"
  echo "informado como proprietário. Ao entrar, o FrotaGest pede para confirmar o e-mail e você vira o master."
}

main "$@"
exit $?
