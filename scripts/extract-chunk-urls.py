#!/usr/bin/env python3
"""Extract every webpack chunk URL discoverable from downloaded bundles.

Two URL templates we know about:
  - accounts:  https://static.snapchat.com/accounts/_next/static/chunks/{id}.{hash}.js
               (sometimes id is replaced by an alias from a small map)
  - chat:      https://cf-st.sc-cdn.net/dw/{hash}.chunk.js
               OR specific paths for translations/polyfills hardcoded.

We parse webpack's `o.u`/`p.u` URL builder to enumerate every (id, path) pair,
then write them as a list to chunk-urls-static.txt and a download script.
"""

import os
import re
import sys

OUT_DIR = os.environ.get("OUT_DIR", "./vendor/snap-bundle")
ACCOUNTS_RUNTIME = os.path.join(
    OUT_DIR,
    "static.snapchat.com",
    "accounts",
    "_next",
    "static",
    "chunks",
    "webpack-5c0e3c9fd3281330.js",
)
CHAT_RUNTIME = os.path.join(
    OUT_DIR, "cf-st.sc-cdn.net", "dw", "9989a7c6c88a16ebf19d.js"
)


def parse_chat_runtime(src):
    """Extract chunk URLs from the chat client's o.u definition.

    The pattern is a giant ternary: `e=>X===e?"path":Y===e?"path":...:"dw/"+
    {id:"hash",...}[e]+".chunk.js"`.
    """
    urls = set()

    # 1. Hardcoded ternary cases — `<id>===e?"<path>":`
    ternary = re.findall(r'(\d+)===e\?"([^"]+)"\s*:', src)
    for chunk_id, path in ternary:
        urls.add(f"https://cf-st.sc-cdn.net/{path}")

    # 2. Tail map: `"dw/"+{id:"hash",...}[e]+".chunk.js"`
    tail = re.search(r'"dw/"\+\{((?:\d+:"[a-f0-9]+",?)+)\}\[e\]\+"\.chunk\.js"', src)
    if tail:
        for chunk_id, hash_ in re.findall(r'(\d+):"([a-f0-9]+)"', tail.group(1)):
            urls.add(f"https://cf-st.sc-cdn.net/dw/{hash_}.chunk.js")

    return urls


def parse_accounts_runtime(src):
    """Extract chunk URLs from the accounts (Next.js) p.u function."""
    urls = set()

    # p.u = function(e){return"static/chunks/"+(({alias-map})[e]||e)+"."+({hash-map})[e]+".js"}
    fn = re.search(
        r'p\.u\s*=\s*function\([a-z]\)\s*\{\s*return\s*"([^"]+)"\s*\+\s*'
        r'\(\(\{((?:\d+:"[a-zA-Z0-9_-]+",?)*)\}\)\[[a-z]\]\s*\|\|\s*[a-z]\)\s*\+\s*"\."\s*\+\s*'
        r'\{((?:\d+:"[a-zA-Z0-9_-]+",?)+)\}\[[a-z]\]\s*\+\s*"\.([a-z]+)"',
        src,
    )
    if not fn:
        return urls

    prefix = fn.group(1)  # "static/chunks/"
    alias_map = dict(re.findall(r'(\d+):"([a-zA-Z0-9_-]+)"', fn.group(2)))
    hash_map = dict(re.findall(r'(\d+):"([a-zA-Z0-9_-]+)"', fn.group(3)))
    ext = fn.group(4)  # "js"

    base = f"https://static.snapchat.com/accounts/_next/{prefix}"
    for chunk_id, hash_ in hash_map.items():
        name = alias_map.get(chunk_id, chunk_id)
        urls.add(f"{base}{name}.{hash_}.{ext}")
    return urls


def parse_miniCss(src):
    """The mini-css-extract plugin defines its own URL function. Extract it too."""
    urls = set()
    fn = re.search(
        r'p\.miniCssF\s*=\s*function\([a-z]\)\s*\{\s*return\s*"([^"]+)"\s*\+\s*'
        r'\{((?:\d+:"[a-zA-Z0-9_-]+",?)+)\}\[[a-z]\]\s*\+\s*"\.([a-z]+)"',
        src,
    )
    if not fn:
        return urls
    prefix = fn.group(1)
    hash_map = dict(re.findall(r'(\d+):"([a-zA-Z0-9_-]+)"', fn.group(2)))
    ext = fn.group(3)
    base = f"https://static.snapchat.com/accounts/_next/{prefix}"
    for chunk_id, hash_ in hash_map.items():
        urls.add(f"{base}{chunk_id}.{hash_}.{ext}")
    return urls


def parse_wasm_refs(src):
    """Find any direct .wasm or .map URL constants embedded in source."""
    urls = set()
    for m in re.finditer(
        r'"(https?://[^"]+\.(?:wasm|map))"', src
    ):
        urls.add(m.group(1))
    return urls


def main():
    all_urls = set()
    for path, parser in [
        (ACCOUNTS_RUNTIME, parse_accounts_runtime),
        (CHAT_RUNTIME, parse_chat_runtime),
    ]:
        if not os.path.exists(path):
            print(f"  missing: {path}", file=sys.stderr)
            continue
        src = open(path).read()
        urls = parser(src)
        print(f"{os.path.basename(path)}: {len(urls)} URLs")
        all_urls.update(urls)
        # Also pull miniCSS + wasm refs.
        all_urls.update(parse_miniCss(src))
        all_urls.update(parse_wasm_refs(src))

    out_path = os.path.join(OUT_DIR, "chunk-urls-static.txt")
    with open(out_path, "w") as f:
        for u in sorted(all_urls):
            f.write(u + "\n")
    print(f"\ntotal unique URLs: {len(all_urls)}")
    print(f"wrote: {out_path}")


if __name__ == "__main__":
    main()
