"""Independent canonical specification helper for disposable issue #80 probe."""

# diagnostic-exempt: disposable cross-runtime prototype retained off production branches

import base64
import hashlib
import json
import sys


def main() -> None:
    payload = json.loads(sys.stdin.buffer.read())
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    result = {
        "canonicalBase64": base64.b64encode(canonical).decode("ascii"),
        "digest": "sha256:" + hashlib.sha256(canonical).hexdigest(),
        "runtime": "python",
    }
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
