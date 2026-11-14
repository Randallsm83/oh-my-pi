#!/usr/bin/env bash
# One command for the secret-redaction check; every argument goes to verify.ts.
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="$(command -v bun || true)"
if [[ -z "$bun" ]] && command -v mise >/dev/null 2>&1; then
	bun="$(mise which bun 2>/dev/null || true)"
fi
if [[ -z "$bun" ]]; then
	echo "bun is not on PATH. In an agent shell, run: source ~/.config/zsh/agent-env.zsh && $0 $*" >&2
	exit 127
fi
exec "$bun" "$dir/verify.ts" "$@"
