#!/usr/bin/env bash
#
# Swap setup for memory-tight hosts (e.g. Azure Free B1s/B2pts: 1 GiB RAM).
# Must run as root or with sudo. Idempotent — safe to re-run.
#
#   sudo ./scripts/swap-setup.sh [size_gib]
#
set -euo pipefail

SIZE_GIB="${1:-4}"

if [[ $EUID -ne 0 ]]; then
  echo "[swap-setup] re-run as root (sudo)." >&2
  exit 1
fi

SWAPFILE="/swapfile"

if [[ -f "$SWAPFILE" ]]; then
  CURRENT="$(swapon --show --noheadings --bytes | awk -v f="$SWAPFILE" '$1==f {print $2}')"
  echo "[swap-setup] swapfile already active (${CURRENT:0:-6}MiB). Leaving as-is."
  exit 0
fi

echo "[swap-setup] creating ${SIZE_GIB}G swapfile (this can take a minute)..."
fallocate -l "${SIZE_GIB}G" "$SWAPFILE"
chmod 600 "$SWAPFILE"
mkswap "$SWAPFILE" >/dev/null
swapon "$SWAPFILE"

# Prefer discarding freed pages now (VM disks are metered/I/O-throttled).
grep -q '^/swapfile' /etc/fstab || echo "$SWAPFILE none swap sw,discard 0 0" >> /etc/fstab

# Conservative swapping keeps services resident; we want RAM used before swap.
if [[ -f /etc/sysctl.d/99-swap.conf ]]; then
  echo "[swap-setup] sysctl.d/99-swap.conf exists, leaving untouched."
else
  cat > /etc/sysctl.d/99-swap.conf <<'EOF'
vm.swappiness=10
vm.vfs_cache_pressure=50
EOF
  sysctl --system >/dev/null
fi

echo "[swap-setup] done:"
swapon --show
free -h