#!/usr/bin/env bash
# FrotaGest · Reis Tecnologia
# Publica o painel em https://<domínio> pelo Nginx, com o certificado de origem da Cloudflare.
# Uso (na pasta do FrotaGest):  sudo bash tools/nginx/instalar-dominio.sh [domínio]
# (só é preciso numa instância nova: o Nginx que já publica o laboratório serve o FrotaGest sem mudança)
set -euo pipefail

DOMINIO="${1:-frotagest.reisconsultoriatec.com}"
PASTA="$(cd "$(dirname "$0")/../.." && pwd)"
USUARIO="${SUDO_USER:-ubuntu}"
CERT_DIR="${CERT_DIR:-/etc/ssl/cloudflare}"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"
CERT="$CERT_DIR/frotagest.pem"
CHAVE="$CERT_DIR/frotagest.key"
SNIPPET="$NGINX_DIR/snippets/frotagest-cloudflare.conf"

# Faixas da Cloudflare (www.cloudflare.com/ips), usadas se a lista atual não puder ser baixada
CLOUDFLARE_PADRAO="103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 104.16.0.0/13 104.24.0.0/14 108.162.192.0/18 131.0.72.0/22
141.101.64.0/18 162.158.0.0/15 172.64.0.0/13 173.245.48.0/20 188.114.96.0/20 190.93.240.0/20 197.234.240.0/22 198.41.128.0/17
2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"

passo() { echo; echo "==> $*"; }
erro() { echo; echo "ERRO: $*"; echo "Nada mais foi alterado. Corrija e rode o script de novo."; exit 1; }

[ "$(id -u)" = 0 ] || erro "rode com sudo:  sudo bash tools/nginx/instalar-dominio.sh"
[ -f "$PASTA/server.js" ] || erro "não encontrei o FrotaGest em $PASTA"
[ -f "$PASTA/config.json" ] || erro "falta o config.json: rode antes o deploy/instalar-frotagest.sh"
case "$DOMINIO" in *[!a-z0-9.-]*|"") erro "domínio inválido: $DOMINIO" ;; esac

PORTA="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((c.web&&c.web.port)||8080))' "$PASTA/config.json")"

passo "1/7 Conferindo o certificado em $CERT_DIR"
[ -f "$CERT" ] || erro "falta $CERT (o certificado de origem da Cloudflare)"
[ -f "$CHAVE" ] || erro "falta $CHAVE (a chave privada do certificado)"
openssl x509 -in "$CERT" -noout >/dev/null 2>&1 || erro "$CERT não é um certificado válido: confira se colou do BEGIN até o END"
openssl pkey -in "$CHAVE" -noout >/dev/null 2>&1 || erro "$CHAVE não é uma chave válida: confira se colou do BEGIN até o END"
openssl x509 -in "$CERT" -noout -checkend 0 >/dev/null || erro "o certificado está vencido"
[ "$(openssl x509 -in "$CERT" -noout -pubkey | sha256sum)" = "$(openssl pkey -in "$CHAVE" -pubout | sha256sum)" ] \
  || erro "o certificado e a chave não são do mesmo par (foram copiados de certificados diferentes)"
SANS="$(openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | tr ',' '\n' | sed -n 's/.*DNS:\(.*\)/\1/p')"
echo "$SANS" | grep -qxF "$DOMINIO" || echo "$SANS" | grep -qxF "*.${DOMINIO#*.}" || erro "o certificado não cobre $DOMINIO (cobre: $(echo $SANS))"
chmod 600 "$CHAVE"
echo "Certificado válido até $(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2), cobrindo $DOMINIO"

passo "2/7 Nginx"
if ! command -v nginx >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx
fi
nginx -v

passo "3/7 Liberando o painel só para a Cloudflare"
LISTA="$( { curl -fsS --max-time 15 https://www.cloudflare.com/ips-v4/; echo; curl -fsS --max-time 15 https://www.cloudflare.com/ips-v6/; } 2>/dev/null || true)"
ORIGEM="lista atual da Cloudflare"
VALIDAS=0
for ip in $LISTA; do [[ "$ip" =~ ^[0-9a-fA-F:.]+/[0-9]+$ ]] && VALIDAS=$((VALIDAS + 1)); done
if [ "$VALIDAS" -lt 10 ]; then LISTA="$CLOUDFLARE_PADRAO"; ORIGEM="lista guardada no script (não consegui baixar a atual)"; fi
mkdir -p "$(dirname "$SNIPPET")"
{
  echo "# FrotaGest: só a Cloudflare (e o próprio servidor) chegam ao painel. Gerado em $(date '+%d/%m/%Y %H:%M') com a $ORIGEM."
  echo "allow 127.0.0.1;"
  echo "allow ::1;"
  for ip in $LISTA; do [[ "$ip" =~ ^[0-9a-fA-F:.]+/[0-9]+$ ]] && echo "allow $ip;"; done
  echo "deny all;"
} > "$SNIPPET"
echo "$(grep -c '^allow' "$SNIPPET") faixas liberadas ($ORIGEM)"

passo "4/7 Site $DOMINIO no Nginx"
TINHA_PADRAO=0
[ -e "$NGINX_DIR/sites-enabled/default" ] && TINHA_PADRAO=1
sed -e "s/__DOMINIO__/$DOMINIO/g" -e "s/__PORTA__/$PORTA/g" "$PASTA/tools/nginx/frotagest.conf" > "$NGINX_DIR/sites-available/frotagest"
ln -sf "$NGINX_DIR/sites-available/frotagest" "$NGINX_DIR/sites-enabled/frotagest"
rm -f "$NGINX_DIR/sites-enabled/default"
if ! nginx -t; then
  # volta como estava, para o Nginx continuar subindo
  rm -f "$NGINX_DIR/sites-enabled/frotagest"
  [ "$TINHA_PADRAO" = 1 ] && ln -sf "$NGINX_DIR/sites-available/default" "$NGINX_DIR/sites-enabled/default"
  erro "a configuração do Nginx não passou no teste (mensagem acima); desfiz a alteração do site"
fi
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx

passo "5/7 Portas 80 e 443 no firewall do servidor"
for p in 80 443; do
  if iptables -C INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT 2>/dev/null; then
    echo "porta $p já liberada"
  else
    N="$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')"
    if [ -n "$N" ]; then iptables -I INPUT "$N" -p tcp -m state --state NEW --dport "$p" -j ACCEPT
    else iptables -A INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT; fi
    echo "porta $p liberada"
  fi
done
if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1 && echo "regras salvas (valem depois de reiniciar)"; fi

passo "6/7 config.json do FrotaGest"
cp "$PASTA/config.json" "$PASTA/config.json.antes-do-dominio"
node -e '
const fs = require("fs");
const [file, dominio] = process.argv.slice(1);
const c = JSON.parse(fs.readFileSync(file, "utf8"));
c.web = c.web || {};
c.web.host = "127.0.0.1";
c.web.allowedHosts = [...new Set([...(c.web.allowedHosts || []), dominio])];
c.web.publicUrl = "https://" + dominio;
fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
' "$PASTA/config.json" "$DOMINIO"
chown "$USUARIO":"$USUARIO" "$PASTA/config.json" "$PASTA/config.json.antes-do-dominio" 2>/dev/null || true
echo "domínio $DOMINIO liberado no painel (cópia anterior em config.json.antes-do-dominio)"

passo "7/7 Reiniciando o FrotaGest e testando"
sudo -H -u "$USUARIO" bash -lc 'pm2 restart frotagest --update-env >/dev/null && pm2 save >/dev/null' || erro "não consegui reiniciar pelo PM2: rode 'pm2 restart frotagest' e veja 'pm2 logs frotagest'"
sleep 3
CODIGO="$(curl -sk --noproxy '*' -o /dev/null -w '%{http_code}' --resolve "$DOMINIO:443:127.0.0.1" "https://$DOMINIO/" || true)"
[ "$CODIGO" = "200" ] || erro "o painel não respondeu pelo Nginx (código $CODIGO). Veja 'pm2 logs frotagest' e 'sudo tail /var/log/nginx/error.log'"
echo "Nginx e painel respondendo"

echo
echo "Pronto. Depois de criar o registro DNS na Cloudflare, abra:"
echo "  https://$DOMINIO/"
echo "Lembre de autorizar $DOMINIO no Firebase (Authentication > Settings > Authorized domains)."
