#!/usr/bin/env bash
# Recursively crawl downloaded Snap JS for chunk-id/hash references and
# download every reachable file. Loops until no new URLs.
set -uo pipefail

OUT_DIR="${OUT_DIR:-./vendor/snap-bundle}"
MAX_ROUNDS="${MAX_ROUNDS:-8}"
mkdir -p "$OUT_DIR"

UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"

# Patterns we expect:
#   static.snapchat.com/accounts/_next/static/chunks/<id>-<hash>.js
#   static.snapchat.com/accounts/_next/static/chunks/<hash>.js
#   cf-st.sc-cdn.net/dw/<hash>.js          (chunked main)
#   cf-st.sc-cdn.net/dw/<hash>.chunk.js    (lazy chunk)
#   cf-st.sc-cdn.net/dw/<hash>.wasm
#   cf-st.sc-cdn.net/<other>/<hash>.<ext>
#
# Webpack's chunk URL builder p.u(id) typically emits:
#   "static/chunks/" + chunkId + "." + hash + ".js"
# We extract those by looking for hash maps in the source.

extract_urls() {
  local file="$1"
  # Direct URL references.
  grep -hoE '"https?://(static\.snapchat\.com|cf-st\.sc-cdn\.net|accounts\.snapchat\.com|www\.snapchat\.com|web\.snapchat\.com)/[A-Za-z0-9_./?=%&-]+"' "$file" 2>/dev/null \
    | tr -d '"'
  # Chunk paths (relative to /accounts/_next or /dw/).
  grep -hoE '"static/chunks/[A-Za-z0-9_/.-]+\.js"' "$file" 2>/dev/null \
    | tr -d '"' \
    | sed 's|^|https://static.snapchat.com/accounts/_next/|'
  grep -hoE '"_next/static/[A-Za-z0-9_/.-]+\.js"' "$file" 2>/dev/null \
    | tr -d '"' \
    | sed 's|^|https://static.snapchat.com/accounts/|'
  # Webpack hash maps: ({59:"hash1",61:"hash2"...}) — extract id+hash.
  # Pattern p.u: "static/chunks/"+(({...})[e]||e)+"."+({...})[e]+".js"
  # We'd need to evaluate the JS to fully resolve; for now fall back to
  # crawling embedded references. (Full evaluation is what load-bundle does.)
}

round=0
while [[ $round -lt $MAX_ROUNDS ]]; do
  round=$((round + 1))
  echo "=== round $round ==="
  before=$(find "$OUT_DIR" -type f | wc -l)

  # Pull URL set from all current files.
  urls_now=$(find "$OUT_DIR" -type f \( -name "*.js" -o -name "*.html" \) -print0 \
             | xargs -0 -n 50 cat 2>/dev/null \
             | grep -hoE 'https?://(static\.snapchat\.com|cf-st\.sc-cdn\.net|accounts\.snapchat\.com|www\.snapchat\.com|web\.snapchat\.com)/[A-Za-z0-9_./?=%&-]+\.(js|wasm|css|json|map)([?][A-Za-z0-9_./?=%&-]*)?' \
             | sort -u)
  echo "$urls_now" | wc -l | xargs -I{} echo "  reachable url candidates: {}"

  new_urls=0
  while IFS= read -r u; do
    [[ -z "$u" ]] && continue
    host=$(echo "$u" | sed -E 's|^https?://([^/]+).*|\1|')
    path=$(echo "$u" | sed -E 's|^https?://[^/]+||' | sed -E 's|\?.*$||')
    [[ -z "$path" || "$path" == "/" ]] && path="/index.html"
    local_path="$OUT_DIR/$host$path"
    if [[ -f "$local_path" ]]; then continue; fi
    # Try to download.
    mkdir -p "$(dirname "$local_path")" 2>/dev/null
    if curl -sSL --max-time 20 --ipv4 -H "user-agent: $UA" -o "$local_path" "$u" 2>/dev/null; then
      size=$(stat -c%s "$local_path" 2>/dev/null || echo 0)
      if [[ $size -gt 0 ]]; then
        new_urls=$((new_urls + 1))
        if [[ $((new_urls % 10)) -eq 1 ]]; then
          echo "    fetched $new_urls new (last: $u → ${size}B)"
        fi
      else
        rm -f "$local_path"
      fi
    fi
  done <<< "$urls_now"

  after=$(find "$OUT_DIR" -type f | wc -l)
  delta=$((after - before))
  echo "  round $round: +$delta files (total $after)"
  [[ $delta -eq 0 ]] && { echo "no new files; stopping."; break; }
done

echo
echo "DONE — total $(find "$OUT_DIR" -type f | wc -l) files in $OUT_DIR"
