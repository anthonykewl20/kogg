"""Closed framed protocol between Kogg and its pinned Ranex runtime."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import struct
import sys
import unicodedata
from pathlib import Path
from typing import Any

from ranex.governed_execution.adapters.persistence.sqlite.journal import Journal

# diagnostic-coverage: kernel.protocol, kernel.bridge

PROTOCOL = "kogg.ranex/v2"
PROTOCOL_VERSION = 2
SCHEMA_SET_DIGEST = "sha256:b44b4f9fc8c16386e1c5b4f22dcdf6f910b951dce48799689e623f14ef5497f3"
MAX_FRAME_BYTES = 1024 * 1024
MAX_DEPTH = 32
MAX_MEMBERS = 4096
MAX_PENDING_REQUESTS = 64
MAX_PENDING_RESPONSE_BYTES = 4 * 1024 * 1024
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
IMPLEMENTED_OPERATIONS = {"kernel.handshake": 2, "kernel.health": 1}


class ProtocolRefusal(Exception):
    def __init__(self, safe_code: str) -> None:
        super().__init__(safe_code)
        self.safe_code = safe_code


def _canonical(value: Any) -> bytes:
    members = 0

    def validate(candidate: Any, depth: int) -> None:
        nonlocal members
        if depth > MAX_DEPTH:
            raise ProtocolRefusal("KERNEL_PROTOCOL_OVERFLOW")
        if candidate is None or isinstance(candidate, bool):
            return
        if isinstance(candidate, int):
            if candidate < -(2**63) or candidate > 2**63 - 1:
                raise ProtocolRefusal("KERNEL_PROTOCOL_INVALID")
            return
        if isinstance(candidate, float):
            raise ProtocolRefusal("KERNEL_PROTOCOL_INVALID")
        if isinstance(candidate, str):
            if unicodedata.normalize("NFC", candidate) != candidate or any(0xD800 <= ord(character) <= 0xDFFF for character in candidate):
                raise ProtocolRefusal("KERNEL_PROTOCOL_INVALID")
            return
        if isinstance(candidate, list):
            members += len(candidate)
            if members > MAX_MEMBERS:
                raise ProtocolRefusal("KERNEL_PROTOCOL_OVERFLOW")
            for item in candidate:
                validate(item, depth + 1)
            return
        if isinstance(candidate, dict):
            members += len(candidate)
            if members > MAX_MEMBERS or any(not isinstance(key, str) for key in candidate):
                raise ProtocolRefusal("KERNEL_PROTOCOL_OVERFLOW")
            for key, item in candidate.items():
                validate(key, depth + 1)
                validate(item, depth + 1)
            return
        raise ProtocolRefusal("KERNEL_PROTOCOL_INVALID")

    validate(value, 0)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value)).hexdigest()


def _domain_digest(domain: str, value: Any) -> str:
    return "sha256:" + hashlib.sha256(f"kogg:{domain}:v1\n".encode("utf-8") + _canonical(value)).hexdigest()


def _schema_digest(operation: str, direction: str) -> str:
    return _digest({"direction": direction, "operation": operation, "protocol": PROTOCOL})


def _provenance() -> dict[str, Any]:
    return json.loads(Path(os.environ["KOGG_RANEX_PROVENANCE"]).read_text(encoding="utf-8"))


def _journal_path() -> Path:
    return Path(os.environ["KOGG_RANEX_JOURNAL"]).resolve()


def _adapter_digest() -> str:
    return "sha256:" + hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def _journal_state() -> str:
    path = _journal_path()
    if not path.is_file():
        return "missing"
    try:
        return "valid" if Journal(path).verify() else "invalid"
    except Exception:  # observability-exempt: the closed health projection intentionally discards raw journal errors.
        return "invalid"


def _capabilities() -> dict[str, Any]:
    provenance = _provenance()
    qualified = platform.system() == "Linux"
    journal = _journal_state()
    degradation_codes: list[str] = []
    if not qualified:
        degradation_codes.append("KERNEL_HOST_UNQUALIFIED")
    if journal == "missing":
        degradation_codes.append("KERNEL_JOURNAL_MISSING")
    return {
        "protocol": PROTOCOL,
        "protocolVersion": PROTOCOL_VERSION,
        "ranexCommit": provenance["commit"],
        "ranexTree": provenance["tree"],
        "adapterArtifactDigest": _adapter_digest(),
        "schemaSetDigest": SCHEMA_SET_DIGEST,
        "operations": [
            {
                "operation": operation,
                "version": version,
                "requestSchemaDigest": _schema_digest(operation, "request"),
                "resultSchemaDigest": _schema_digest(operation, "result"),
            }
            for operation, version in IMPLEMENTED_OPERATIONS.items()
        ],
        "maxFrameBytes": MAX_FRAME_BYTES,
        "maxPendingRequests": MAX_PENDING_REQUESTS,
        "maxPendingResponseBytes": MAX_PENDING_RESPONSE_BYTES,
        "confinement": "qualified" if qualified else "degraded",
        "degradationCodes": degradation_codes,
    }


def _validate_envelope(request: Any) -> dict[str, Any]:
    fields = {
        "protocol", "requestId", "operationId", "idempotencyKey", "operation",
        "operationVersion", "ranexCommit", "schemaSetDigest", "bodyDigest", "body",
    }
    if not isinstance(request, dict) or set(request) != fields:
        raise ProtocolRefusal("KERNEL_PROTOCOL_INVALID")
    provenance = _provenance()
    if request["protocol"] != PROTOCOL:
        raise ProtocolRefusal("KERNEL_PROTOCOL_MISMATCH")
    if request["ranexCommit"] != provenance["commit"] or request["schemaSetDigest"] != SCHEMA_SET_DIGEST:
        raise ProtocolRefusal("KERNEL_PROVENANCE_MISMATCH")
    request_id = request["requestId"] if isinstance(request["requestId"], str) else ""
    operation_id = request["operationId"] if isinstance(request["operationId"], str) else ""
    if not UUID.fullmatch(request_id) or not UUID.fullmatch(operation_id):
        raise ProtocolRefusal("KERNEL_PROTOCOL_INVALID")
    operation = request["operation"]
    if not isinstance(operation, str):
        raise ProtocolRefusal("KERNEL_PROTOCOL_INVALID")
    if operation not in IMPLEMENTED_OPERATIONS:
        raise ProtocolRefusal("KERNEL_CAPABILITY_UNAVAILABLE")
    if request["operationVersion"] != IMPLEMENTED_OPERATIONS[operation]:
        raise ProtocolRefusal("KERNEL_PROTOCOL_MISMATCH")
    idempotency_key = request["idempotencyKey"] if isinstance(request["idempotencyKey"], str) else ""
    body_digest = _digest(request["body"])
    expected_idempotency = _domain_digest("idempotency", {"bodyDigest": body_digest, "operation": operation, "version": request["operationVersion"]})
    if not DIGEST.fullmatch(idempotency_key) or request["bodyDigest"] != body_digest or idempotency_key != expected_idempotency:
        raise ProtocolRefusal("KERNEL_PROTOCOL_INVALID")
    return request


def _dispatch(request: dict[str, Any]) -> dict[str, Any]:
    operation = request["operation"]
    body = request["body"]
    if not isinstance(body, dict):
        raise ProtocolRefusal("KERNEL_PROTOCOL_INVALID")
    if operation == "kernel.handshake":
        required = {"adapterArtifactDigest", "processRegistrationId", "schemaSetDigest"}
        process_id = body.get("processRegistrationId", "")
        if set(body) != required or body["adapterArtifactDigest"] != _adapter_digest() or body["schemaSetDigest"] != SCHEMA_SET_DIGEST or not isinstance(process_id, str) or not UUID.fullmatch(process_id):
            raise ProtocolRefusal("KERNEL_PROVENANCE_MISMATCH")
        return _capabilities()
    if operation == "kernel.health":
        if body:
            raise ProtocolRefusal("KERNEL_PROTOCOL_INVALID")
        capabilities = _capabilities()
        journal = _journal_state()
        status = "ready" if capabilities["confinement"] == "qualified" and journal == "valid" else "degraded"
        return {"status": status, "journal": journal, "capabilities": capabilities}
    raise ProtocolRefusal("KERNEL_CAPABILITY_UNAVAILABLE")


def _result(request: dict[str, Any], status: str, safe_code: str, projection: Any = None) -> dict[str, Any]:
    result_digest = _digest(projection) if projection is not None else None
    return {
        "protocol": PROTOCOL,
        "requestId": request.get("requestId", "00000000-0000-4000-8000-000000000000"),
        "operationId": request.get("operationId", "00000000-0000-4000-8000-000000000000"),
        "status": status,
        "safeCode": safe_code,
        "resultDigest": result_digest,
        "journal": None,
        "projection": projection,
    }


def _read_exact(stream: Any, size: int) -> bytes | None:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = stream.read(size - len(chunks))
        if not chunk:
            return None if not chunks else bytes(chunks)
        chunks.extend(chunk)
    return bytes(chunks)


def _closed_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolRefusal("KERNEL_PROTOCOL_INVALID")
        result[key] = value
    return result


def main() -> int:
    while True:
        prefix = _read_exact(sys.stdin.buffer, 4)
        if prefix is None:
            return 0
        if len(prefix) != 4:
            return 2
        length = struct.unpack(">I", prefix)[0]
        if length == 0 or length > MAX_FRAME_BYTES:
            return 2
        payload = _read_exact(sys.stdin.buffer, length)
        if payload is None or len(payload) != length:
            return 2
        request: dict[str, Any] = {}
        try:
            decoded = json.loads(payload.decode("utf-8"), object_pairs_hook=_closed_object)
            if isinstance(decoded, dict):
                request = decoded
            request = _validate_envelope(decoded)
            response = _result(request, "succeeded", "KERNEL_OK", _dispatch(request))
        except ProtocolRefusal as error:
            response = _result(request, "refused", error.safe_code)
        except Exception:  # observability-exempt: unknown Python failures are intentionally collapsed to a content-free safe code.
            response = _result(request, "refused", "KERNEL_INTERNAL")
        encoded = _canonical(response)
        if len(encoded) > MAX_FRAME_BYTES:
            encoded = _canonical(_result(request, "refused", "KERNEL_PROTOCOL_OVERFLOW"))
        sys.stdout.buffer.write(struct.pack(">I", len(encoded)) + encoded)
        sys.stdout.buffer.flush()


if __name__ == "__main__":
    raise SystemExit(main())
