#!/usr/bin/env bash
set -euo pipefail

# Verify a Marketplace PAT and store it as the VSCE_PAT GitHub Actions secret.
#
# vsce login does NOT generate a PAT — create one in Azure DevOps first:
#   https://dev.azure.com/_usersSettings/tokens
#   Organization: All accessible organizations
#   Scopes: Marketplace → Manage
#
# Usage:
#   ./scripts/setup-vsce-pat.sh
#   ./scripts/setup-vsce-pat.sh researchanddesire researchanddesire/fumadocs-vscode-plugin

PUBLISHER="${1:-researchanddesire}"
REPO="${2:-researchanddesire/fumadocs-vscode-plugin}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"

echo "Publisher: $PUBLISHER"
echo "GitHub repo: $REPO"
echo
echo "Create a PAT: https://dev.azure.com/_usersSettings/tokens"
echo "  Organization → All accessible organizations"
echo "  Scopes → Marketplace → Manage"
echo
echo "Optional: store the same PAT locally with:"
echo "  npx @vscode/vsce login $PUBLISHER"
echo

read -r -s -p "Paste your Marketplace PAT (input hidden): " PAT
echo

if [[ -z "${PAT// }" ]]; then
  echo "No PAT entered. Aborting." >&2
  exit 1
fi

echo "Verifying PAT…"
npx --yes @vscode/vsce verify-pat "$PUBLISHER" -p "$PAT"

echo "Setting VSCE_PAT on $REPO…"
printf '%s' "$PAT" | gh secret set VSCE_PAT --repo "$REPO"

echo
echo "Done. Re-run Release (Actions → Release → Run workflow, tag v0.5.4) to publish."
