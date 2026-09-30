#!/usr/bin/env bash
# fruity-pi installer — idempotent; safe to re-run.
#
#   ./install.sh                 install / update in place, localhost only (recommended)
#   ./install.sh --remote        also listen on 0.0.0.0 with a self-signed TLS cert
#   ./install.sh --port 8080     choose the port (default 7777)
#   ./install.sh --no-service    don't install the systemd user service
#   ./install.sh --uninstall     stop + remove the app (keeps ~/.fruity-pi state; add --purge to delete it)
#
# Never run as root: fruity-pi and every pi instance run as your normal user.
set -euo pipefail

STATE_DIR="${FRUITY_PI_HOME:-$HOME/.fruity-pi}"
APP_DIR="$STATE_DIR/app"
NODE_DIR="$STATE_DIR/node"
BIN_DIR="$HOME/.local/bin"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=""
REMOTE=0
SERVICE=1
UNINSTALL=0
PURGE=0
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=13

c_pink=$'\033[38;5;204m'; c_dim=$'\033[2m'; c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_off=$'\033[0m'
say()  { printf '%s🍓 %s%s\n' "$c_pink" "$*" "$c_off"; }
ok()   { printf '   %s✓%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '   %s!%s %s\n' "$c_warn" "$c_off" "$*"; }
die()  { printf '%s✗ %s%s\n' "$c_err" "$*" "$c_off" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --remote) REMOTE=1 ;;
    --port) PORT="${2:?--port needs a value}"; shift ;;
    --no-service) SERVICE=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] && die "Don't run this as root. Run it as the user that should own the pi instances."

# ------------------------------------------------------------------ uninstall
if [ "$UNINSTALL" -eq 1 ]; then
  say "Uninstalling fruity-pi"
  if command -v systemctl >/dev/null && systemctl --user list-unit-files fruity-pi.service >/dev/null 2>&1; then
    systemctl --user disable --now fruity-pi.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/fruity-pi.service"
    systemctl --user daemon-reload 2>/dev/null || true
    ok "service removed"
  fi
  rm -rf "$APP_DIR" "$NODE_DIR" "$BIN_DIR/fruity-pi"
  ok "app removed"
  if [ "$PURGE" -eq 1 ]; then
    rm -rf "$STATE_DIR"
    ok "state purged ($STATE_DIR)"
  else
    warn "kept state, instances and sessions in $STATE_DIR (use --purge to delete)"
  fi
  exit 0
fi

say "Installing fruity-pi → $APP_DIR"

# ------------------------------------------------------------------ system packages
need_pkgs=()
command -v git >/dev/null || need_pkgs+=(git)
command -v curl >/dev/null || need_pkgs+=(curl)
command -v tar >/dev/null || need_pkgs+=(tar)
command -v xz >/dev/null || need_pkgs+=(xz-utils)
[ "$REMOTE" -eq 1 ] && ! command -v openssl >/dev/null && need_pkgs+=(openssl)
if [ ${#need_pkgs[@]} -gt 0 ]; then
  warn "missing: ${need_pkgs[*]}"
  if command -v apt-get >/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq "${need_pkgs[@]}"
  elif command -v dnf >/dev/null; then sudo dnf install -y "${need_pkgs[@]/xz-utils/xz}"
  elif command -v pacman >/dev/null; then sudo pacman -S --needed --noconfirm "${need_pkgs[@]/xz-utils/xz}"
  else die "please install: ${need_pkgs[*]}"; fi
fi
ok "git $(git --version | awk '{print $3}')"

# ------------------------------------------------------------------ node
node_ok() {
  command -v node >/dev/null || return 1
  local v; v="$(node -p 'process.versions.node')"
  local maj="${v%%.*}" rest="${v#*.}"; local min="${rest%%.*}"
  [ "$maj" -gt "$NODE_MIN_MAJOR" ] || { [ "$maj" -eq "$NODE_MIN_MAJOR" ] && [ "$min" -ge "$NODE_MIN_MINOR" ]; }
}
if [ -x "$NODE_DIR/bin/node" ]; then export PATH="$NODE_DIR/bin:$PATH"; fi
if ! node_ok; then
  say "Installing Node.js 22 LTS into $NODE_DIR (no root needed)"
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  base="https://nodejs.org/dist/latest-v22.x"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(grep -o "node-v[0-9.]*-linux-$arch.tar.xz" "$tmp/SHASUMS256.txt" | head -1)"
  [ -n "$file" ] || die "could not find a Node 22 build for linux-$arch"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || die "Node download checksum mismatch"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  export PATH="$NODE_DIR/bin:$PATH"
  node_ok || die "node install failed"
fi
NODE_BIN="$(command -v node)"
ok "node $(node -v) ($NODE_BIN)"

# ------------------------------------------------------------------ app
mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
[ -f "$SRC_DIR/package.json" ] && grep -q '"name": "fruity-pi"' "$SRC_DIR/package.json" || die "run install.sh from the fruity-pi source directory"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  mkdir -p "$APP_DIR"
  # Copy sources; keep an already-installed pi version (node_modules) to make re-runs fast.
  tar -C "$SRC_DIR" --exclude=node_modules --exclude=dist --exclude=web/dist --exclude=.git -cf - . | tar -C "$APP_DIR" -xf -
fi
cd "$APP_DIR"
say "Installing dependencies (incl. pi) and building"
npm install --no-audit --no-fund --loglevel=error
npm run build --silent
ok "built $(node -p "require('./package.json').version")"
PI_VER="$(node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version" 2>/dev/null || echo '?')"
ok "pi $PI_VER"

# ------------------------------------------------------------------ config
export FRUITY_PI_HOME="$STATE_DIR"
FIRST_RUN=0
[ -f "$STATE_DIR/config.json" ] || FIRST_RUN=1
INIT_OUT="$(node dist/cli.js init)"
PASSWORD_LINE="$(printf '%s\n' "$INIT_OUT" | grep 'Admin password' || true)"

cfg_set() { node -e "const f=process.argv[1];const c=JSON.parse(require('fs').readFileSync(f,'utf8'));Object.assign(c,JSON.parse(process.argv[2]));require('fs').writeFileSync(f,JSON.stringify(c,null,2)+'\n',{mode:0o600})" "$STATE_DIR/config.json" "$1"; }
[ -n "$PORT" ] && cfg_set "{\"port\":$PORT}"
if [ "$REMOTE" -eq 1 ]; then
  mkdir -p "$STATE_DIR/tls" && chmod 700 "$STATE_DIR/tls"
  if [ ! -f "$STATE_DIR/tls/cert.pem" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$(hostname)" \
      -addext "subjectAltName=DNS:$(hostname),DNS:localhost,IP:127.0.0.1" \
      -keyout "$STATE_DIR/tls/key.pem" -out "$STATE_DIR/tls/cert.pem" 2>/dev/null
    chmod 600 "$STATE_DIR/tls/"*.pem
    ok "generated self-signed TLS cert (replace with a real one for production)"
  fi
  cfg_set "{\"host\":\"0.0.0.0\",\"allowRemote\":true,\"tls\":{\"cert\":\"$STATE_DIR/tls/cert.pem\",\"key\":\"$STATE_DIR/tls/key.pem\"}}"
  warn "listening on all interfaces over HTTPS — firewall the port to trusted IPs"
fi

if [ "$FIRST_RUN" -eq 1 ] && [ -t 0 ]; then
  printf '\n   Paste an ANTHROPIC_API_KEY now? (Enter to skip; add keys later in System → Secrets): '
  read -rs KEY || true; echo
  if [ -n "${KEY:-}" ]; then
    printf 'ANTHROPIC_API_KEY=%s\n' "$(node -p 'JSON.stringify(process.argv[1])' "$KEY")" >> "$STATE_DIR/secrets.env"
    chmod 600 "$STATE_DIR/secrets.env"; ok "key saved"
  fi
fi

# ------------------------------------------------------------------ launcher
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/fruity-pi" <<EOF
#!/usr/bin/env bash
export FRUITY_PI_HOME="$STATE_DIR"
exec "$NODE_BIN" "$APP_DIR/dist/cli.js" "\$@"
EOF
chmod 755 "$BIN_DIR/fruity-pi"
ok "launcher: $BIN_DIR/fruity-pi"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "add $BIN_DIR to your PATH" ;; esac

# ------------------------------------------------------------------ service
if [ "$SERVICE" -eq 1 ] && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  sed -e "s|@NODE@|$NODE_BIN|g" -e "s|@APP@|$APP_DIR|g" -e "s|@STATE@|$STATE_DIR|g" "$APP_DIR/packaging/fruity-pi.service" > "$HOME/.config/systemd/user/fruity-pi.service"
  systemctl --user daemon-reload
  systemctl --user enable fruity-pi.service >/dev/null 2>&1
  systemctl --user restart fruity-pi.service
  ok "systemd user service running (journalctl --user -u fruity-pi -f)"
  if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q yes; then
    if sudo -n true 2>/dev/null || [ -t 0 ]; then
      sudo loginctl enable-linger "$USER" && ok "linger enabled — survives logout & reboot" || warn "could not enable linger; service stops when you log out"
    else
      warn "run 'sudo loginctl enable-linger $USER' so the service survives logout"
    fi
  fi
elif [ "$SERVICE" -eq 1 ]; then
  warn "no systemd user session — start manually with: fruity-pi serve"
else
  ok "skipped service (start with: fruity-pi serve)"
fi

# ------------------------------------------------------------------ done
HOST="$(node -p "require('$STATE_DIR/config.json').host")"
P="$(node -p "require('$STATE_DIR/config.json').port")"
echo
say "Done!"
if [ "$REMOTE" -eq 1 ]; then
  echo "   Open:  https://$(hostname -I 2>/dev/null | awk '{print $1}'):$P   (self-signed cert warning is expected)"
else
  echo "   Open:  http://127.0.0.1:$P"
  echo "   From your laptop:  ssh -L $P:127.0.0.1:$P $USER@$(hostname)   then http://localhost:$P"
fi
if [ -n "$PASSWORD_LINE" ]; then
  echo "   ${c_warn}$PASSWORD_LINE${c_off}   ${c_dim}(save it now — change it in System → Security)${c_off}"
else
  echo "   Sign in with your existing admin password (reset: fruity-pi set-password)."
fi
