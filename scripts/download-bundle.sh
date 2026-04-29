#!/usr/bin/env bash
# Download Snap's web bundle using curl. Sidesteps Bun/Node fetch's IPv6
# preference issues in this sandbox.
set -euo pipefail

OUT_DIR="${OUT_DIR:-./vendor/snap-bundle}"
mkdir -p "$OUT_DIR"

# Entry pages.
declare -a ENTRIES=(
  "https://accounts.snapchat.com/v2/login"
  "https://www.snapchat.com/web"
)

declare -a SEEN
contains() {
  local needle="$1"
  shift
  local hay
  for hay in "$@"; do
    [[ "$hay" == "$needle" ]] && return 0
  done
  return 1
}

ASSET_RE='https?://[A-Za-z0-9./_-]+\.(js|wasm|css|json|map)([?][A-Za-z0-9._=&%-]*)?'
ALLOW_RE='^https://(static\.snapchat\.com|accounts\.snapchat\.com|www\.snapchat\.com|web\.snapchat\.com|cf-st\.sc-cdn\.net)/'

queue=("${ENTRIES[@]}")
fetched=0
MAX="${MAX_FILES:-300}"

while [[ ${#queue[@]} -gt 0 && $fetched -lt $MAX ]]; do
  url="${queue[0]}"
  queue=("${queue[@]:1}")

  # Dedupe.
  if contains "$url" "${SEEN[@]:-}"; then
    continue
  fi
  SEEN+=("$url")

  if ! [[ "$url" =~ $ALLOW_RE ]]; then
    continue
  fi

  # Compute local path: out_dir/<host>/<path>.
  host=$(echo "$url" | sed -E 's|^https?://([^/]+).*|\1|')
  path_part=$(echo "$url" | sed -E 's|^https?://[^/]+||' | sed -E 's|\?.*$||')
  if [[ -z "$path_part" || "$path_part" == "/" ]]; then path_part="/index.html"; fi
  local_path="$OUT_DIR/$host$path_part"
  mkdir -p "$(dirname "$local_path")"

  # Fetch with a 15s timeout and IPv4-only.
  if ! curl -sSL --max-time 15 --ipv4 \
      -H "user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36" \
      -H "accept-language: en-US,en;q=0.9" \
      -o "$local_path" \
      "$url"; then
    echo "  FAIL $url"
    continue
  fi

  fetched=$((fetched + 1))
  size=$(stat -c%s "$local_path" 2>/dev/null || echo 0)
  echo "  [${fetched}/${MAX}] ${size}B  $(echo "$url" | tail -c 80)"

  # Scan textual responses for further asset URLs.
  ext="${url##*.}"
  ext="${ext%%\?*}"
  case "$ext" in
    js|css|json|html)
      while IFS= read -r match; do
        # Resolve relative-ish references (only absolute URLs match the regex
        # so this is just the absolute matches).
        contains "$match" "${SEEN[@]:-}" || queue+=("$match")
      done < <(grep -oE "$ASSET_RE" "$local_path" | sort -u)
      ;;
    *)
      # also scan if we don't know the ext (e.g., entry pages /web with no ext)
      while IFS= read -r match; do
        contains "$match" "${SEEN[@]:-}" || queue+=("$match")
      done < <(grep -oE "$ASSET_RE" "$local_path" | sort -u)
      ;;
  esac
done

echo
echo "DONE — fetched $fetched files into $OUT_DIR"
echo "  total size: $(du -sh "$OUT_DIR" | cut -f1)"
echo "  file count: $(find "$OUT_DIR" -type f | wc -l)"
