#!/usr/bin/env bash
# fisika — one-command VPS setup (Ubuntu 22.04/24.04). Run as root:
#   curl -fsSL https://raw.githubusercontent.com/kryptnitan/fisika/main/deploy/setup.sh | sudo bash
# Public website (HTTPS on your domain; point its DNS A record at this server first):
#   curl -fsSL https://raw.githubusercontent.com/kryptnitan/fisika/main/deploy/setup.sh | sudo DOMAIN=example.com PAY_TO=0xYourWallet bash
# Safe to re-run: it updates the code and keeps your keys and data. Re-run with DOMAIN= to go public later.
#
# What it does
#   - creates a locked-down `fisika` system user; code in /opt/fisika, data in /var/lib/fisika (mode 700)
#   - generates a NEW wallet for the trading bot on this machine; the key never leaves it and is never printed
#   - installs the services, all bound to 127.0.0.1:
#       fisika-api   prices, quotes, dashboard data      fisika-web  dashboard
#       fisika-live      the LIVE trader on Celo      (starts only after you fund it and run `fisika-start-live`)
#       fisika-live-bsc  the LIVE trader on BNB Chain (its own wallet; `fisika-start-live bsc`)
#   - with DOMAIN: Caddy serves the dashboard and agent API over HTTPS (free automatic certificate);
#     admin routes are never exposed. Firewall: SSH, plus 80/443 only when DOMAIN is set.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
DOMAIN=${DOMAIN:-}
PAY_TO=${PAY_TO:-}
if [ -n "$DOMAIN" ] && ! printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9-]+\.)+[a-z]{2,}$'; then echo "DOMAIN must look like example.com"; exit 1; fi
if [ -n "$PAY_TO" ] && ! printf '%s' "$PAY_TO" | grep -Eq '^0x[0-9a-fA-F]{40}$'; then echo "PAY_TO must be a 0x address"; exit 1; fi

REPO=${REPO:-https://github.com/kryptnitan/fisika}
apt-get update -qq
apt-get install -y -qq git curl ufw ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
corepack enable >/dev/null 2>&1 || npm i -g pnpm >/dev/null

id fisika >/dev/null 2>&1 || useradd --system --home /var/lib/fisika --shell /usr/sbin/nologin fisika
install -d -o fisika -g fisika -m 700 /var/lib/fisika
install -d -o fisika -g fisika -m 700 /var/lib/fisika/bsc
install -d -o root -g fisika -m 750 /etc/fisika

if [ -d /opt/fisika/.git ]; then git -C /opt/fisika pull -q --ff-only; else git clone -q "$REPO" /opt/fisika; fi
chown -R fisika:fisika /opt/fisika
cd /opt/fisika
sudo -u fisika -H bash -c 'pnpm install --no-frozen-lockfile --silent && pnpm --filter @fisika/web build >/dev/null'

rand() { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40; }

# --- bot wallet: generated here, stored only in /etc/fisika/live.env (root:fisika 640) ---
if [ ! -f /etc/fisika/live.env ]; then
  KEY=$(cd /opt/fisika/apps/api && node -e "import('viem/accounts').then(m=>console.log(m.generatePrivateKey()))")
  cat > /etc/fisika/live.env <<ENV
MODE=LIVE
LIVE_ACK=i-accept-risk
ARB_PRIVATE_KEY=$KEY
# Paste your Textile live key (app.textilecredit.com -> profile -> API keys):
TEXTILE_API_KEY=
# Limits for the \$100 test. All required; the trader refuses to start without them.
# A trade can use the whole wallet (it never spends more than 98% of the USDT it actually holds).
MAX_TRADE_USD=100
DAILY_LOSS_LIMIT_USD=4
MAX_TOKEN_EXPOSURE_USD=105
MIN_EDGE_BPS=5
MIN_EDGE_USD=0.05
SLIPPAGE_BPS=30
MIN_CELO_FOR_GAS=0.5
DATA_DIR=/var/lib/fisika
KILL_FILE=/var/lib/fisika/KILL
# Free RPCs by default (Forno, PublicNode). Put a paid one first later if you want.
CELO_RPC_URLS=
ENV
  unset KEY
fi
chown root:fisika /etc/fisika/live.env && chmod 640 /etc/fisika/live.env

# --- BNB Chain bot: a SEPARATE wallet (never share inventory or nonces across chains) ---
if [ ! -f /etc/fisika/live-bsc.env ]; then
  KEY=$(cd /opt/fisika/apps/api && node -e "import('viem/accounts').then(m=>console.log(m.generatePrivateKey()))")
  cat > /etc/fisika/live-bsc.env <<ENV
MODE=LIVE
LIVE_ACK=i-accept-risk
CHAIN=bsc
ARB_PRIVATE_KEY=$KEY
# Same Textile live key works on BNB Chain (cNGN <-> USDT):
TEXTILE_API_KEY=
MAX_TRADE_USD=100
DAILY_LOSS_LIMIT_USD=10
MAX_TOKEN_EXPOSURE_USD=110
MIN_EDGE_BPS=5
MIN_EDGE_USD=0.05
SLIPPAGE_BPS=30
MIN_NATIVE_FOR_GAS=0.005
DATA_DIR=/var/lib/fisika/bsc
KILL_FILE=/var/lib/fisika/bsc/KILL
# Free RPCs by default (BNB Chain's own, PublicNode).
RPC_URLS=
ENV
  unset KEY
fi
chown root:fisika /etc/fisika/live-bsc.env && chmod 640 /etc/fisika/live-bsc.env

if [ ! -f /etc/fisika/api.env ]; then
  INTERNAL=$(rand)
  cat > /etc/fisika/api.env <<ENV
HOST=127.0.0.1
PORT=8787
ARB_PAPER=false
LIVE_STATUS_FILE=/var/lib/fisika/live-status.json
KILL_FILE=/var/lib/fisika/KILL
LIVE_STATUS_FILE_BSC=/var/lib/fisika/bsc/live-status.json
KILL_FILE_BSC=/var/lib/fisika/bsc/KILL
CHAINS=celo,bsc
INTERNAL_API_KEYS=$INTERNAL
ADMIN_TOKEN=$(rand)
# Lets the dashboard build swaps for your own wallet (direct DEX and Textile routes; non-custodial).
EXECUTION_ENABLED=true
SERVICE_FEE_BPS=0
CELO_RPC_URLS=
PUBLIC_URL=http://localhost:8787
# Agent API payments: x402, USDC on Celo, paid to X402_PAY_TO. Get X402_API_KEY at https://x402.celo.org
# (connect a wallet -> Create API key; it is shown once). Without both, paid routes answer 503.
X402_PAY_TO=
X402_API_KEY=
# Optional: lets the dashboard quote Textile firm prices for visitors' swaps (same key as the bot is fine).
TEXTILE_API_KEY=
ENV
  cat > /etc/fisika/web.env <<ENV
API_URL=http://127.0.0.1:8787
INTERNAL_API_KEY=$INTERNAL
ENV
fi
chown root:fisika /etc/fisika/api.env /etc/fisika/web.env && chmod 640 /etc/fisika/api.env /etc/fisika/web.env

unit() { # name, workdir, command, envfile, extra
  cat > /etc/systemd/system/$1.service <<UNIT
[Unit]
Description=$1
After=network-online.target
Wants=network-online.target

[Service]
User=fisika
Group=fisika
WorkingDirectory=$2
EnvironmentFile=$4
ExecStart=$3
Restart=always
RestartSec=10
TimeoutStopSec=330
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/fisika $5
CapabilityBoundingSet=
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT
}
NODE=$(command -v node)
unit fisika-api  /opt/fisika/apps/api "$NODE src/server.ts" /etc/fisika/api.env ""
unit fisika-live /opt/fisika/apps/api "$NODE src/live-trader.ts" /etc/fisika/live.env ""
unit fisika-live-bsc /opt/fisika/apps/api "$NODE src/live-trader.ts" /etc/fisika/live-bsc.env ""
unit fisika-web  /opt/fisika/apps/web "/opt/fisika/apps/web/node_modules/.bin/next start -H 127.0.0.1 -p 3000" /etc/fisika/web.env "/opt/fisika/apps/web/.next"
systemctl daemon-reload
systemctl enable -q --now fisika-api fisika-web
systemctl enable -q fisika-live fisika-live-bsc   # enabled, not started: run fisika-start-live [bsc] after funding
# Existing installs: make sure the API knows about BNB Chain.
grep -q '^CHAINS=' /etc/fisika/api.env || printf 'LIVE_STATUS_FILE_BSC=/var/lib/fisika/bsc/live-status.json\nKILL_FILE_BSC=/var/lib/fisika/bsc/KILL\nCHAINS=celo,bsc\n' >> /etc/fisika/api.env
systemctl restart fisika-api

# Helpers take an optional chain: celo (default) or bsc.
cat > /usr/local/bin/fisika-chain <<'CMD'
case "${1:-celo}" in
  celo) SVC=fisika-live;     ENVF=/etc/fisika/live.env;     DIR=/var/lib/fisika ;;
  bsc)  SVC=fisika-live-bsc; ENVF=/etc/fisika/live-bsc.env; DIR=/var/lib/fisika/bsc ;;
  *) echo "chain must be celo or bsc"; exit 1 ;;
esac
CMD
cat > /usr/local/bin/fisika-start-live <<'CMD'
#!/usr/bin/env bash
set -e
. /usr/local/bin/fisika-chain "${1:-celo}"
grep -q '^TEXTILE_API_KEY=.\+' $ENVF || grep -q '^ALLOW_TEXTILE=false' $ENVF || { echo "Add TEXTILE_API_KEY to $ENVF first (sudo nano $ENVF)"; exit 1; }
rm -f $DIR/KILL
systemctl restart $SVC
sleep 8
journalctl -u $SVC -n 15 --no-pager
CMD
cat > /usr/local/bin/fisika-stop-live <<'CMD'
#!/usr/bin/env bash
# Stop starting new trades immediately; a trade in progress finishes. --now also stops the process.
# Usage: fisika-stop-live [celo|bsc|all] [--now]
CHAINS="${1:-celo}"; [ "$CHAINS" = "--now" ] && { CHAINS=celo; set -- celo --now; }
[ "$CHAINS" = all ] && CHAINS="celo bsc"
for c in $CHAINS; do
  . /usr/local/bin/fisika-chain "$c"
  touch $DIR/KILL && chown fisika:fisika $DIR/KILL
  echo "$c: no new trades will start."
  [ "${2:-}" = "--now" ] && systemctl stop $SVC && echo "$c: trader stopped."
done
CMD
cat > /usr/local/bin/fisika-wallet <<'CMD'
#!/usr/bin/env bash
. /usr/local/bin/fisika-chain "${1:-celo}"
cd /opt/fisika/apps/api
KEY=$(grep '^ARB_PRIVATE_KEY=' $ENVF | cut -d= -f2) \
  node -e "import('viem/accounts').then(m=>console.log(m.privateKeyToAccount(process.env.KEY).address))"
CMD
chmod 755 /usr/local/bin/fisika-start-live /usr/local/bin/fisika-stop-live /usr/local/bin/fisika-wallet
chmod 644 /usr/local/bin/fisika-chain

# Settings passed on the command line win over what is in api.env.
setenv() { grep -q "^$1=" /etc/fisika/api.env && sed -i "s|^$1=.*|$1=$2|" /etc/fisika/api.env || echo "$1=$2" >> /etc/fisika/api.env; }
[ -n "$PAY_TO" ] && setenv X402_PAY_TO "$PAY_TO"
if [ -n "$DOMAIN" ]; then
  setenv PUBLIC_URL "https://$DOMAIN"
  if ! apt-get install -y -qq caddy >/dev/null 2>&1; then
    # Not in this Ubuntu's own repos (22.04): Caddy's official apt repository (caddyserver.com/docs/install).
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  sed "s/__DOMAIN__/$DOMAIN/" /opt/fisika/deploy/Caddyfile > /etc/caddy/Caddyfile
  install -d -o caddy -g caddy /var/log/caddy
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl enable -q caddy && systemctl reload-or-restart caddy
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
fi
systemctl restart fisika-api fisika-web
ufw allow OpenSSH >/dev/null && ufw --force enable >/dev/null

ADDR=$(/usr/local/bin/fisika-wallet celo)
ADDR_BSC=$(/usr/local/bin/fisika-wallet bsc)
cat <<DONE

fisika is installed.
$( [ -n "$DOMAIN" ] && echo "Public site: https://$DOMAIN   (agent API: https://$DOMAIN/v1/board, https://$DOMAIN/openapi.json)" || echo "Dashboard and API run on this server's localhost only. Re-run with DOMAIN=yourdomain.com to go public." )
$( grep -q '^X402_API_KEY=.\+' /etc/fisika/api.env && grep -q '^X402_PAY_TO=0x' /etc/fisika/api.env && echo "Agent payments: on" || echo "Agent payments: OFF until X402_PAY_TO and X402_API_KEY are set (sudo nano /etc/fisika/api.env, then sudo systemctl restart fisika-api)" )

Bot wallets (new, generated on this server, one per chain):
  Celo       $ADDR
  BNB Chain  $ADDR_BSC

Celo:
  1. Send the Celo wallet 100 USDT and 20 CELO (about \$2, for gas) on Celo (chain 42220).
  2. sudo nano /etc/fisika/live.env       -> paste TEXTILE_API_KEY
  3. sudo fisika-start-live
BNB Chain (optional, separate capital):
  1. Send the BNB Chain wallet USDT (BEP-20) and 0.02 BNB for gas on BNB Chain (chain 56).
  2. sudo nano /etc/fisika/live-bsc.env   -> paste TEXTILE_API_KEY
  3. sudo fisika-start-live bsc
Dashboard from your computer:  ssh -L 3000:localhost:3000 <user>@<this-server>  then open http://localhost:3000/arb
Stop new trades:  sudo fisika-stop-live [celo|bsc|all]    Stop the process too:  add --now
Logs:  journalctl -u fisika-live -f      (BNB Chain: -u fisika-live-bsc)
Admin token for the dashboard's Stop button:  sudo grep ADMIN_TOKEN /etc/fisika/api.env
DONE
