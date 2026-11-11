#!/usr/bin/env bash
# fisika — one-command VPS setup (Ubuntu 22.04/24.04). Run as root:
#   curl -fsSL https://raw.githubusercontent.com/kryptnitan/fisika/main/deploy/setup.sh | sudo bash
# Public website (HTTPS on your domain; point its DNS A record at this server first):
#   curl -fsSL https://raw.githubusercontent.com/kryptnitan/fisika/main/deploy/setup.sh | sudo DOMAIN=example.com PAY_TO=0xYourWallet OWNER=0xYourWallet bash
# OWNER is the only wallet that can sign in to the agent console (/agent), and the only address withdrawals go to.
# Safe to re-run: it updates the code and keeps your keys and data. Re-run with DOMAIN= to go public later.
#
# What it does
#   - creates a locked-down `fisika` system user; code in /opt/fisika, data in /var/lib/fisika (mode 700)
#   - generates a NEW wallet for the trading bot on this machine; the key never leaves it and is never printed
#   - installs the services, all bound to 127.0.0.1:
#       fisika-api   prices, quotes, dashboard data      fisika-web  dashboard
#       fisika-live      the LIVE trader on Celo      (starts only after you fund it and run `fisika-start-live`)
#       fisika-live-bsc  the LIVE trader on BNB Chain (its own wallet; `fisika-start-live bsc`)
#       fisika-meme      the Solana meme desk, PAPER money only (no wallet); starts at once, idles until switched on
#   - with DOMAIN: Caddy serves the dashboard and agent API over HTTPS (free automatic certificate);
#     admin routes are never exposed. Firewall: SSH, plus 80/443 only when DOMAIN is set.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
DOMAIN=${DOMAIN:-}
PAY_TO=${PAY_TO:-}
OWNER=${OWNER:-}
if [ -n "$DOMAIN" ] && ! printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9-]+\.)+[a-z]{2,}$'; then echo "DOMAIN must look like example.com"; exit 1; fi
if [ -n "$PAY_TO" ] && ! printf '%s' "$PAY_TO" | grep -Eq '^0x[0-9a-fA-F]{40}$'; then echo "PAY_TO must be a 0x address"; exit 1; fi
if [ -n "$OWNER" ] && ! printf '%s' "$OWNER" | grep -Eq '^0x[0-9a-fA-F]{40}$'; then echo "OWNER must be a 0x address"; exit 1; fi

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

# The checkout belongs to the fisika user, so root's git must be told it is safe. Nothing in /opt/fisika is yours
# to keep (keys live in /etc/fisika, data in /var/lib/fisika), so updates reset it to the published code.
git config --global --add safe.directory /opt/fisika
if [ -d /opt/fisika/.git ]; then
  git -C /opt/fisika fetch -q origin main && git -C /opt/fisika reset -q --hard origin/main
else
  git clone -q "$REPO" /opt/fisika
fi
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

# Solana meme desk: PAPER only in this version (real prices and quotes, simulated fills, no wallet, no key).
if [ ! -f /etc/fisika/meme.env ]; then
  cat > /etc/fisika/meme.env <<ENV
MEME_MODE=PAPER
MEME_DATA_DIR=/var/lib/fisika/meme
CONTROL_FILE=/var/lib/fisika/control.json
MEME_PAPER_EQUITY=100
# Rules (the console shows them): 10% size, \$1-\$1000 per trade, 5% daily loss limit, -10% stop, 8% trail, 4h max hold.
MEME_SIZE_PCT=10
MEME_MIN_TRADE_USD=1
MEME_MAX_TRADE_USD=1000
MEME_DAILY_LOSS_PCT=5
MEME_STOP_LOSS_PCT=10
MEME_TRAIL_PCT=8
MEME_MAX_HOLD_MIN=240
# Optional: a free Jupiter key (developers.jup.ag/portal) lifts the quote rate from 0.5 to 1 request/s.
JUPITER_API_KEY=
ENV
fi
chown root:fisika /etc/fisika/meme.env && chmod 640 /etc/fisika/meme.env
install -d -o fisika -g fisika /var/lib/fisika/meme

unit() { # name, workdir, command, envfile, extra writable paths, extra [Service] lines
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
${6:-}
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT
}
NODE=$(command -v node)
# The website and API can never read the bot keys, even though they run as the same user: only the traders can.
NOKEYS="InaccessiblePaths=-/etc/fisika/live.env -/etc/fisika/live-bsc.env"
unit fisika-api  /opt/fisika/apps/api "$NODE src/server.ts" /etc/fisika/api.env "" "$NOKEYS"
unit fisika-live /opt/fisika/apps/api "$NODE src/live-trader.ts" /etc/fisika/live.env ""
unit fisika-live-bsc /opt/fisika/apps/api "$NODE src/live-trader.ts" /etc/fisika/live-bsc.env ""
unit fisika-meme /opt/fisika/apps/api "$NODE src/meme-desk.ts" /etc/fisika/meme.env "" "$NOKEYS"
unit fisika-web  /opt/fisika/apps/web "/opt/fisika/apps/web/node_modules/.bin/next start -H 127.0.0.1 -p 3000" /etc/fisika/web.env "/opt/fisika/apps/web/.next" "$NOKEYS"
systemctl daemon-reload
systemctl enable -q --now fisika-api fisika-web fisika-meme   # the meme desk is paper money; it idles while its switch is Paused
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
# Starting the trader is the intent to trade: switch this chain (and the agent) on. Pause any time from the console.
/usr/local/bin/fisika resume "${1:-celo}"
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
cat > /usr/local/bin/fisika <<CMD
#!/usr/bin/env bash
# fisika status | pause [all|celo|bsc|solana] | resume [all|celo|bsc|solana]   (same switch as the console's Active/Paused)
cd /opt/fisika/apps/api && exec sudo -u fisika env CONTROL_FILE=/var/lib/fisika/control.json $NODE src/cli.ts "\$@"
CMD
chmod 755 /usr/local/bin/fisika-start-live /usr/local/bin/fisika-stop-live /usr/local/bin/fisika-wallet /usr/local/bin/fisika
chmod 644 /usr/local/bin/fisika-chain

# Settings passed on the command line win over what is in the env files.
setenvf() { grep -q "^$2=" "$1" && sed -i "s|^$2=.*|$2=$3|" "$1" || echo "$2=$3" >> "$1"; }
setenv() { setenvf /etc/fisika/api.env "$1" "$2"; }
[ -n "$PAY_TO" ] && setenv X402_PAY_TO "$PAY_TO"
# Agent console: owner sign-in, and the one address withdrawals can go to (the traders enforce their own copy).
if [ -n "$OWNER" ]; then
  setenv OWNER_ADDRESS "$OWNER"
  setenv WITHDRAW_ADDRESS "$OWNER"
  for f in /etc/fisika/live.env /etc/fisika/live-bsc.env; do [ -f "$f" ] && setenvf "$f" WITHDRAW_ADDRESS "$OWNER"; done
fi
grep -q '^CONTROL_FILE=' /etc/fisika/api.env || setenv CONTROL_FILE /var/lib/fisika/control.json
grep -q '^MEME_DATA_DIR=' /etc/fisika/api.env || setenv MEME_DATA_DIR /var/lib/fisika/meme
for f in /etc/fisika/live.env /etc/fisika/live-bsc.env; do [ -f "$f" ] && { grep -q '^CONTROL_FILE=' "$f" || setenvf "$f" CONTROL_FILE /var/lib/fisika/control.json; }; done
# The console shows the bot wallets' balances even before a trader has run.
setenv AGENT_WALLET_CELO "$(/usr/local/bin/fisika-wallet celo)"
setenv AGENT_WALLET_BSC "$(/usr/local/bin/fisika-wallet bsc)"
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
systemctl restart fisika-api fisika-web fisika-meme
# Running traders pick up new code and settings; stopped ones stay stopped.
systemctl try-restart fisika-live fisika-live-bsc
# Traders run all the time once they can (key + Textile key or ALLOW_TEXTILE=false). They idle while the console
# switch is Paused, which is the default, so the console's Active switch is all it takes to trade, and withdrawals
# are processed whenever you ask.
for pair in "fisika-live /etc/fisika/live.env" "fisika-live-bsc /etc/fisika/live-bsc.env"; do
  set -- $pair
  if grep -q '^ARB_PRIVATE_KEY=0x' "$2" && { grep -q '^TEXTILE_API_KEY=.\+' "$2" || grep -q '^ALLOW_TEXTILE=false' "$2"; }; then
    systemctl is-active -q "$1" || systemctl start "$1"
  fi
done
ufw allow OpenSSH >/dev/null && ufw --force enable >/dev/null

ADDR=$(/usr/local/bin/fisika-wallet celo)
ADDR_BSC=$(/usr/local/bin/fisika-wallet bsc)
cat <<DONE

fisika is installed.
$( [ -n "$DOMAIN" ] && echo "Public site: https://$DOMAIN   (agent API: https://$DOMAIN/v1/board, https://$DOMAIN/openapi.json)" || echo "Dashboard and API run on this server's localhost only. Re-run with DOMAIN=yourdomain.com to go public." )
$( grep -q '^OWNER_ADDRESS=0x' /etc/fisika/api.env && echo "Agent console: ${DOMAIN:+https://$DOMAIN}/agent  (owner $(grep '^OWNER_ADDRESS=' /etc/fisika/api.env | cut -d= -f2))" || echo "Agent console: OFF until you re-run with OWNER=0xYourWallet" )
$( grep -q '^X402_API_KEY=.\+' /etc/fisika/api.env && grep -q '^X402_PAY_TO=0x' /etc/fisika/api.env && echo "Agent payments: on" || echo "Agent payments: OFF until X402_PAY_TO and X402_API_KEY are set (sudo nano /etc/fisika/api.env, then sudo systemctl restart fisika-api)" )

Bot wallets (new, generated on this server, one per chain):
  Celo       $ADDR
  BNB Chain  $ADDR_BSC

Celo:
  1. Send the Celo wallet 100 USDT and 20 CELO (about \$2, for gas) on Celo (chain 42220).
  2. sudo nano /etc/fisika/live.env       -> paste TEXTILE_API_KEY
  3. sudo fisika-start-live          (starts the trader and switches Celo on; pause/resume any time in the console)
BNB Chain (optional, separate capital):
  1. Send the BNB Chain wallet USDT (BEP-20) and 0.02 BNB for gas on BNB Chain (chain 56).
  2. sudo nano /etc/fisika/live-bsc.env   -> paste TEXTILE_API_KEY
  3. sudo fisika-start-live bsc
Meme desk (Solana, PAPER): runs as fisika-meme with \$100 of paper money; switch it in the console (Meme switch) or sudo fisika resume solana.
Pause / resume from the server:  sudo fisika pause [all|celo|bsc|solana]   sudo fisika resume [all|celo|bsc|solana]   sudo fisika status
Stop the trader process:  sudo fisika-stop-live [celo|bsc|all] --now
Logs:  journalctl -u fisika-live -f      (BNB Chain: -u fisika-live-bsc, meme desk: -u fisika-meme)
DONE
