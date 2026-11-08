#!/usr/bin/env bash
# =====================================================================
#  FrotaGest — atualização do servidor a partir do GitHub
#  Reis Tecnologia
#
#  Uso:  ~/atualizar-frotagest.sh
#
#  1. Baixa a versão mais recente do repositório (pasta ~/frotagest)
#     — config.json, data/ e node_modules nunca são tocados
#  2. Roda o npm install só se as dependências mudaram
#  3. Reinicia no PM2 (as mudanças de banco são aplicadas sozinhas ao iniciar)
#  4. Confere o /api/saude
# =====================================================================

# Tudo dentro de uma função: o bash lê o script inteiro antes de rodar,
# então o próprio script pode ser atualizado pelo git no meio da execução.
main() {
  set -euo pipefail
  local PASTA
  PASTA="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
  cd "$PASTA"

  echo "==> Baixando a versão mais recente..."
  local antes depois
  antes=$(git rev-parse --short HEAD)
  git fetch --quiet origin main
  git reset --quiet --hard origin/main
  depois=$(git rev-parse --short HEAD)

  if [ "$antes" = "$depois" ]; then
    echo "    Já estava na versão mais recente ($depois)."
  else
    echo "    $antes → $depois"
    git --no-pager log --oneline "$antes..$depois" | sed 's/^/    • /'
    if [ -z "${FROTAGEST_REEXEC:-}" ] && ! git diff --quiet "$antes" "$depois" -- deploy/atualizar-frotagest.sh; then
      echo "    O script de atualização mudou — reiniciando com a versão nova..."
      FROTAGEST_REEXEC=1 exec bash "$PASTA/deploy/atualizar-frotagest.sh"
    fi
  fi

  # dependências: reinstala quando o package.json for diferente do último instalado
  local marca
  marca="$(sha256sum package.json | cut -c1-64)"
  if [ ! -d node_modules/mysql2 ] || [ "$(cat node_modules/.frotagest-pacote 2>/dev/null)" != "$marca" ]; then
    echo "==> Dependências mudaram — instalando..."
    npm install --omit=dev --no-audit --no-fund
    echo "$marca" > node_modules/.frotagest-pacote
  fi

  echo "==> Reiniciando o FrotaGest..."
  pm2 restart frotagest --update-env > /dev/null
  local porta saude="" i
  porta="$(node -p 'JSON.parse(require("fs").readFileSync("config.json","utf8")).web?.port || 8080')"
  for i in $(seq 1 15); do
    sleep 2
    saude=$(curl -s --noproxy '*' --max-time 5 "http://127.0.0.1:$porta/api/saude" || true)
    echo "$saude" | grep -q '"status":"ok"' && break
  done
  echo "    $saude"
  if echo "$saude" | grep -q '"status":"ok"'; then
    echo "==> Pronto! FrotaGest atualizado ($(node -p 'require("./package.json").version'))."
  else
    echo "!!  O FrotaGest não respondeu como esperado. Veja: pm2 logs frotagest --lines 40 --nostream"
    exit 1
  fi
}

main "$@"
exit $?
