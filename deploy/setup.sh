#!/usr/bin/env bash
# fisika — one-command VPS setup (Ubuntu 22.04/24.04). Run as root:
#   curl -fsSL https://raw.githubusercontent.com/kryptnitan/fisika/main/deploy/setup.sh | sudo bash
# Safe to re-run: it updates the code and keeps your keys and data.
#
# What it does
#   - creates a locked-down `fisika` system user; code in /opt/fisika, data in /var/lib/fisika (mode 700)
#   - generates a NEW wallet for the trading bot on this machine; the key never leaves it and is never printed
#   - installs three services, all bound to 127.0.0.1 (nothing is reachable from the internet):
#       fisika-api   prices, quotes, dashboard data      fisika-web  dashboard
#       fisika-live  the LIVE trader (starts only after you fund the wallet and run `fisika-start-live`)
#   - firewall: SSH only
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }

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
# Limits for the \$250 test. All required; the trader refuses to start without them.
MAX_TRADE_USD=100
DAILY_LOSS_LIMIT_USD=10
MAX_TOKEN_EXPOSURE_USD=110
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

if [ ! -f /etc/fisika/api.env ]; then
  INTERNAL=$(rand)
  cat > /etc/fisika/api.env <<ENV
HOST=127.0.0.1
PORT=8787
ARB_PAPER=false
LIVE_STATUS_FILE=/var/lib/fisika/live-status.json
KILL_FILE=/var/lib/fisika/KILL
INTERNAL_API_KEYS=$INTERNAL
ADMIN_TOKEN=$(rand)
EXECUTION_ENABLED=false
SERVICE_FEE_BPS=0
CELO_RPC_URLS=
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
unit fisika-web  /opt/fisika/apps/web "/opt/fisika/apps/web/node_modules/.bin/next start -H 127.0.0.1 -p 3000" /etc/fisika/web.env "/opt/fisika/apps/web/.next"
systemctl daemon-reload
systemctl enable -q --now fisika-api fisika-web
systemctl enable -q fisika-live   # enabled, not started: run fisika-start-live after funding

cat > /usr/local/bin/fisika-start-live <<'CMD'
#!/usr/bin/env bash
set -e
grep -q '^TEXTILE_API_KEY=.\+' /etc/fisika/live.env || { echo "Add TEXTILE_API_KEY to /etc/fisika/live.env first (sudo nano /etc/fisika/live.env)"; exit 1; }
rm -f /var/lib/fisika/KILL
systemctl restart fisika-live
sleep 8
journalctl -u fisika-live -n 15 --no-pager
CMD
cat > /usr/local/bin/fisika-stop-live <<'CMD'
#!/usr/bin/env bash
# Stop starting new trades immediately; a trade in progress finishes. Then stop the process.
touch /var/lib/fisika/KILL && chown fisika:fisika /var/lib/fisika/KILL
echo "No new trades will start."
[ "${1:-}" = "--now" ] && systemctl stop fisika-live && echo "Trader stopped."
CMD
cat > /usr/local/bin/fisika-wallet <<'CMD'
#!/usr/bin/env bash
cd /opt/fisika/apps/api
KEY=$(grep '^ARB_PRIVATE_KEY=' /etc/fisika/live.env | cut -d= -f2) \
  node -e "import('viem/accounts').then(m=>console.log(m.privateKeyToAccount(process.env.KEY).address))"
CMD
chmod 755 /usr/local/bin/fisika-start-live /usr/local/bin/fisika-stop-live /usr/local/bin/fisika-wallet

ufw allow OpenSSH >/dev/null && ufw --force enable >/dev/null

ADDR=$(/usr/local/bin/fisika-wallet)
cat <<DONE

fisika is installed. Dashboard and API run on this server's localhost only.

Bot wallet (new, generated on this server):  $ADDR

Next:
  1. Send it 250 USDT and 20 CELO (about $2, for gas) on Celo (chain 42220).
  2. sudo nano /etc/fisika/live.env    -> paste TEXTILE_API_KEY
  3. sudo fisika-start-live
Dashboard from your computer:  ssh -L 3000:localhost:3000 <user>@<this-server>  then open http://localhost:3000/arb
Stop new trades:  sudo fisika-stop-live        Stop the process too:  sudo fisika-stop-live --now
Logs:  journalctl -u fisika-live -f
Admin token for the dashboard's Stop button:  sudo grep ADMIN_TOKEN /etc/fisika/api.env
DONE
