"""Private JSONL adapter between Kogg's Node backend and the Ranex kernel."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import sys
from pathlib import Path
from typing import Any

from ranex.bootstrap.composition import build_gate_evaluator
from ranex.governed_execution.adapters.persistence.sqlite.journal import Journal
from ranex.governed_execution.api import Evidence

PROTOCOL = "kogg-ranex-stdio"
PROTOCOL_VERSION = 1
COMMANDS = [
    "gate.evaluate",
    "journal.verify",
    "run",
    "suite.freeze",
    "deps.fetch",
    "deps.approve",
    "keygen",
    "task.dispatch",
    "task.judge",
    "task.merge",
    "task.delegate",
    "task.fanout",
]


def _provenance() -> dict[str, Any]:
    source = Path(os.environ["KOGG_RANEX_PROVENANCE"])
    return json.loads(source.read_text(encoding="utf-8"))


def _journal_path() -> Path:
    return Path(os.environ["KOGG_RANEX_JOURNAL"]).resolve()


def _schema_fingerprints() -> dict[str, str]:
    root = Path(os.environ["KOGG_RANEX_PROVENANCE"]).parent
    schemas = root / "governance" / "schemas"
    result: dict[str, str] = {}
    for source in sorted(schemas.rglob("*.json")):
        relative = source.relative_to(root).as_posix()
        result[relative] = "sha256:" + hashlib.sha256(source.read_bytes()).hexdigest()
    return result


def _capabilities() -> dict[str, Any]:
    provenance = _provenance()
    qualified = platform.system() == "Linux"
    return {
        "protocol": PROTOCOL,
        "protocolVersion": PROTOCOL_VERSION,
        "ranexCommit": provenance["commit"],
        "ranexTree": provenance["tree"],
        "schemaFingerprints": _schema_fingerprints(),
        "commands": COMMANDS,
        "qualifiedProviders": [],
        "confinement": "qualified" if qualified else "degraded",
        "degradationReasons": [] if qualified else [
            "strict Ranex confinement requires a qualified Linux host"
        ],
    }


def _handshake(params: dict[str, Any]) -> dict[str, Any]:
    provenance = _provenance()
    if (
        params.get("protocol") != PROTOCOL
        or params.get("protocolVersion") != PROTOCOL_VERSION
        or params.get("ranexCommit") != provenance["commit"]
    ):
        raise ValueError("unsupported Kogg/Ranex protocol or revision")
    return _capabilities()


def _verify_journal() -> dict[str, Any]:
    journal_path = _journal_path()
    if not journal_path.is_file():
        return {"valid": False, "reason": "missing"}
    try:
        return {"valid": Journal(journal_path).verify()}
    except Exception as error:  # refusal is converted to bounded protocol data
        return {"valid": False, "reason": type(error).__name__}


def _health() -> dict[str, Any]:
    verification = _verify_journal()
    capabilities = _capabilities()
    journal = "valid" if verification["valid"] else verification.get("reason", "invalid")
    degraded = capabilities["confinement"] != "qualified" or journal != "valid"
    return {
        "status": "degraded" if degraded else "ready",
        "journal": journal if journal in {"valid", "missing", "invalid"} else "invalid",
        "capabilities": capabilities,
    }


def _list_verdicts() -> list[dict[str, Any]]:
    journal_path = _journal_path()
    if not journal_path.is_file():
        return []
    journal = Journal(journal_path)
    if not journal.verify():
        raise ValueError("Ranex journal hash chain is invalid")
    return journal.entries()


def _evaluate(params: dict[str, Any]) -> dict[str, Any]:
    evidence = tuple(
        Evidence(
            claim_id=item["claim_id"],
            subject_digest=item["subject_digest"],
            producer_id=item["producer_id"],
            command=item["command"],
            command_digest=item["command_digest"],
            executable_path=item["executable_path"],
            exit_code=item["exit_code"],
            suite_results=item.get("suite_results"),
        )
        for item in params["evidence"]
    )
    suite_manifest = params.get("suiteManifest")
    evaluator = build_gate_evaluator(
        params["gateCatalog"].encode("utf-8"),
        journal_path=_journal_path(),
        suite_manifest=(
            json.dumps(suite_manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
            if suite_manifest is not None
            else None
        ),
    )
    result = evaluator.evaluate(
        params["gateId"],
        evidence,
        subject_digest=params["subjectDigest"],
        approver_id=params["approverId"],
    )
    return result.as_record()


def _dispatch(method: str, params: dict[str, Any]) -> Any:
    if method == "handshake":
        return _handshake(params)
    if method == "health":
        return _health()
    if method == "journal.verify":
        return _verify_journal()
    if method == "verdict.list":
        return _list_verdicts()
    if method == "evaluate":
        return _evaluate(params)
    if method == "shutdown":
        return {"stopping": True}
    raise ValueError("unsupported kernel method")


def main() -> int:
    for line in sys.stdin:
        request_id = "unknown"
        method = ""
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or set(request) != {"id", "method", "params"}:
                raise ValueError("request does not match the closed protocol")
            request_id = request["id"]
            method = request["method"]
            params = request["params"]
            if not isinstance(request_id, str) or not isinstance(method, str) or not isinstance(params, dict):
                raise ValueError("request fields have invalid types")
            response = {"id": request_id, "result": _dispatch(method, params)}
        except Exception as error:
            response = {
                "id": request_id,
                "error": {"code": type(error).__name__, "message": str(error)[:512]},
            }
        sys.stdout.write(json.dumps(response, sort_keys=True, separators=(",", ":")) + "\n")
        sys.stdout.flush()
        if method == "shutdown" and "result" in response:
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
