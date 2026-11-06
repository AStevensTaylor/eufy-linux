#!/usr/bin/env bash
# Creates a placeholder sidecar binary so `cargo build` / `tauri build` can
# resolve `bundle.externalBin` before the real bridge has been built.
# The real binary is produced by `pnpm --filter sidecar build` (see README).
# Usage: scripts/ensure-sidecar-placeholder.sh [target-triple]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
triple="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
dest="$here/binaries/eufy-bridge-$triple"
mkdir -p "$here/binaries"
if [ -e "$dest" ]; then
  echo "sidecar already present: $dest"
  exit 0
fi
cat > "$dest" <<'PLACEHOLDER'
#!/bin/sh
echo "eufy-bridge placeholder: the real sidecar has not been built. Run 'pnpm --filter sidecar build' or set EUFY_BRIDGE_DEV=1 to use node." >&2
exit 1
PLACEHOLDER
chmod +x "$dest"
echo "created placeholder sidecar: $dest"
