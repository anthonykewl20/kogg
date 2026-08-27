"""Closed framed protocol between Kogg and its pinned Ranex runtime."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import struct
import sys
import uuid
from pathlib import Path
from typing import Any

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
    "execution.qualify",
]


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


class _KernelFact:
    def __init__(self, record: dict[str, Any]) -> None:
        self._record = record

    def as_record(self) -> dict[str, Any]:
        return self._record


def _journal_position(records: list[dict[str, Any]], sequence: int | None = None) -> dict[str, str]:
    limit = len(records) if sequence is None else sequence
    link = "sha256:" + "0" * 64
    for record in records[:limit]:
        link = "sha256:" + hashlib.sha256(_canonical({"prev_link": link, "record": record})).hexdigest()
    return {"sequence": str(limit), "rootDigest": link}


def _closed(record: Any, fields: set[str]) -> dict[str, Any]:
    if not isinstance(record, dict) or set(record) != fields:
        raise ProtocolRefusal("KERNEL_TASK_BINDING_MISMATCH")
    return record


def _uuid(value: Any) -> str:
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ProtocolRefusal("KERNEL_TASK_BINDING_MISMATCH")
    return value


def _sha256(value: Any) -> str:
    if not isinstance(value, str) or not DIGEST.fullmatch(value):
        raise ProtocolRefusal("KERNEL_TASK_BINDING_MISMATCH")
    return value


def _timestamp(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value):
        raise ProtocolRefusal("KERNEL_TASK_BINDING_MISMATCH")
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as error:
        raise ProtocolRefusal("KERNEL_TASK_BINDING_MISMATCH") from error
    return value


def _repository_state(value: Any) -> dict[str, Any]:
    state = _closed(value, {
        "objectFormat", "commitObjectId", "treeObjectId", "gitCommonDirectoryIdentity", "worktreeIdentity",
        "indexDigest", "trackedContentDigest", "untrackedPolicyDigest", "isClean",
    })
    object_format = state["objectFormat"]
    object_length = 40 if object_format == "sha1" else 64 if object_format == "sha256" else 0
    if object_length == 0 or not isinstance(state["commitObjectId"], str) or not re.fullmatch(rf"[0-9a-f]{{{object_length}}}", state["commitObjectId"]):
        raise ProtocolRefusal("KERNEL_REPOSITORY_MISMATCH")
    if not isinstance(state["treeObjectId"], str) or not re.fullmatch(rf"[0-9a-f]{{{object_length}}}", state["treeObjectId"]):
        raise ProtocolRefusal("KERNEL_REPOSITORY_MISMATCH")
    for field in ("gitCommonDirectoryIdentity", "worktreeIdentity", "indexDigest", "trackedContentDigest", "untrackedPolicyDigest"):
        _sha256(state[field])
    if not isinstance(state["isClean"], bool):
        raise ProtocolRefusal("KERNEL_REPOSITORY_MISMATCH")
    return state


def _task_binding(value: Any) -> dict[str, Any]:
    binding = _closed(value, {
        "taskId", "taskRevision", "specificationDigest", "approvalId", "approvalDigest", "authorityDigest",
        "projectId", "repositoryId", "repositoryIdentityDigest", "protectedSource", "worktreeId",
        "worktreeIdentityDigest", "baseState", "executionProfileDigest", "expiresAt",
    })
    for field in ("taskId", "approvalId", "projectId", "repositoryId", "worktreeId"):
        _uuid(binding[field])
    if not isinstance(binding["taskRevision"], int) or isinstance(binding["taskRevision"], bool) or binding["taskRevision"] < 1:
        raise ProtocolRefusal("KERNEL_TASK_BINDING_MISMATCH")
    for field in ("specificationDigest", "approvalDigest", "authorityDigest", "repositoryIdentityDigest", "worktreeIdentityDigest", "executionProfileDigest"):
        _sha256(binding[field])
    _repository_state(binding["protectedSource"])
    _repository_state(binding["baseState"])
    expires_at = _timestamp(binding["expiresAt"])
    if datetime.strptime(expires_at, "%Y-%m-%dT%H:%M:%S.%fZ") <= datetime.utcnow():
        raise ProtocolRefusal("KERNEL_AUTHORITY_INVALID")
    return binding


def _bind_task(request: dict[str, Any], body: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    closed = _closed(body, {"binding", "bindingDigest"})
    binding = _task_binding(closed["binding"])
    binding_digest = _domain_digest("task-binding", binding)
    if closed["bindingDigest"] != binding_digest:
        raise ProtocolRefusal("KERNEL_TASK_BINDING_MISMATCH")
    journal = Journal(_journal_path())
    try:
        if _journal_path().is_file() and not journal.verify():
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
        records = journal.entries() if _journal_path().is_file() else []
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    if any(not isinstance(record, dict) for record in records):
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
    prior = [record for record in records if record.get("kind") == "kogg.task-binding.v1" and record.get("idempotencyKey") == request["idempotencyKey"]]
    if len(prior) > 1:
        raise ProtocolRefusal("KERNEL_JOURNAL_AMBIGUOUS")
    projection = {"taskBindingDigest": binding_digest, "taskId": binding["taskId"], "taskRevision": binding["taskRevision"]}
    if prior:
        if prior[0].get("bodyDigest") != request["bodyDigest"] or prior[0].get("bindingDigest") != binding_digest:
            raise ProtocolRefusal("KERNEL_IDEMPOTENCY_CONFLICT")
        return projection, _journal_position(records, records.index(prior[0]) + 1)
    fact = {
        "kind": "kogg.task-binding.v1", "idempotencyKey": request["idempotencyKey"],
        "bodyDigest": request["bodyDigest"], "bindingDigest": binding_digest, "binding": binding,
    }
    try:
        root = journal.append(_KernelFact(fact))
        committed = journal.entries()
        if not journal.verify() or not committed or committed[-1] != fact:
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    return projection, {"sequence": str(len(committed)), "rootDigest": root}


def _producer_binding(value: Any) -> dict[str, Any]:
    try:
        binding = _closed(value, {
            "producerId", "producerRole", "adapterId", "adapterArtifactDigest", "provider", "model",
            "attemptId", "taskBindingDigest", "authorityDigest", "executionProfileDigest",
        })
        _uuid(binding["producerId"])
        _uuid(binding["attemptId"])
        if binding["producerRole"] != "implementation":
            raise ProtocolRefusal("KERNEL_PRODUCER_INVALID")
        for field in ("adapterId", "provider", "model"):
            if not isinstance(binding[field], str) or not SYMBOLIC.fullmatch(binding[field]):
                raise ProtocolRefusal("KERNEL_PRODUCER_INVALID")
        for field in ("adapterArtifactDigest", "taskBindingDigest", "authorityDigest", "executionProfileDigest"):
            _sha256(binding[field])
        return binding
    except ProtocolRefusal as error:
        if error.safe_code == "KERNEL_PRODUCER_INVALID":
            raise
        raise ProtocolRefusal("KERNEL_PRODUCER_INVALID") from error


def _dispatch_producer(request: dict[str, Any], body: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    try:
        closed = _closed(body, {"binding", "bindingDigest"})
    except ProtocolRefusal as error:
        raise ProtocolRefusal("KERNEL_PRODUCER_INVALID") from error
    binding = _producer_binding(closed["binding"])
    binding_digest = _domain_digest("producer", binding)
    if closed["bindingDigest"] != binding_digest:
        raise ProtocolRefusal("KERNEL_PRODUCER_INVALID")
    journal = Journal(_journal_path())
    try:
        if not _journal_path().is_file() or not journal.verify():
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
        records = journal.entries()
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    if any(not isinstance(record, dict) for record in records):
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
    tasks = [record for record in records if record.get("kind") == "kogg.task-binding.v1" and record.get("bindingDigest") == binding["taskBindingDigest"]]
    if len(tasks) != 1:
        raise ProtocolRefusal("KERNEL_TASK_BINDING_MISMATCH" if not tasks else "KERNEL_JOURNAL_AMBIGUOUS")
    task = tasks[0].get("binding")
    if not isinstance(task, dict) or task.get("authorityDigest") != binding["authorityDigest"] or task.get("executionProfileDigest") != binding["executionProfileDigest"]:
        raise ProtocolRefusal("KERNEL_AUTHORITY_INVALID")
    prior = [record for record in records if record.get("kind") == "kogg.producer-binding.v1" and record.get("idempotencyKey") == request["idempotencyKey"]]
    if len(prior) > 1:
        raise ProtocolRefusal("KERNEL_JOURNAL_AMBIGUOUS")
    projection = {"producerBindingDigest": binding_digest, "producerId": binding["producerId"], "attemptId": binding["attemptId"]}
    if prior:
        if prior[0].get("bodyDigest") != request["bodyDigest"] or prior[0].get("bindingDigest") != binding_digest:
            raise ProtocolRefusal("KERNEL_IDEMPOTENCY_CONFLICT")
        return projection, _journal_position(records, records.index(prior[0]) + 1)
    fact = {
        "kind": "kogg.producer-binding.v1", "idempotencyKey": request["idempotencyKey"],
        "bodyDigest": request["bodyDigest"], "bindingDigest": binding_digest, "binding": binding,
    }
    try:
        root = journal.append(_KernelFact(fact))
        committed = journal.entries()
        if not journal.verify() or not committed or committed[-1] != fact:
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    return projection, {"sequence": str(len(committed)), "rootDigest": root}


def _check_definition(value: Any) -> dict[str, Any]:
    check = _closed(value, {
        "checkId", "kind", "executableArtifactDigest", "argvTemplateDigest", "environmentProfileDigest",
        "timeoutMs", "outputPolicyDigest", "requiredProducerSeparation",
    })
    if not isinstance(check["checkId"], str) or not SYMBOLIC.fullmatch(check["checkId"]) or check["kind"] not in CHECK_KINDS:
        raise ProtocolRefusal("KERNEL_SUITE_MISMATCH")
    for field in ("executableArtifactDigest", "argvTemplateDigest", "environmentProfileDigest", "outputPolicyDigest"):
        _sha256(check[field])
    if not isinstance(check["timeoutMs"], int) or isinstance(check["timeoutMs"], bool) or not 1 <= check["timeoutMs"] <= 900_000:
        raise ProtocolRefusal("KERNEL_SUITE_MISMATCH")
    if not isinstance(check["requiredProducerSeparation"], bool):
        raise ProtocolRefusal("KERNEL_SUITE_MISMATCH")
    return check


def _frozen_suite(value: Any) -> dict[str, Any]:
    try:
        suite = _closed(value, {
            "suiteId", "suiteRevision", "manifestDigest", "taskBindingDigest", "subjectPolicy", "checks",
            "gateCatalogDigest", "verifierAuthorityDigest",
        })
        _uuid(suite["suiteId"])
        if not isinstance(suite["suiteRevision"], int) or isinstance(suite["suiteRevision"], bool) or suite["suiteRevision"] < 1:
            raise ProtocolRefusal("KERNEL_SUITE_MISMATCH")
        for field in ("manifestDigest", "taskBindingDigest", "gateCatalogDigest", "verifierAuthorityDigest"):
            _sha256(suite[field])
        if suite["subjectPolicy"] != "exact-commit" or not isinstance(suite["checks"], list) or not 1 <= len(suite["checks"]) <= 64:
            raise ProtocolRefusal("KERNEL_SUITE_MISMATCH")
        checks = [_check_definition(check) for check in suite["checks"]]
        check_ids = [check["checkId"] for check in checks]
        if check_ids != sorted(check_ids) or len(check_ids) != len(set(check_ids)):
            raise ProtocolRefusal("KERNEL_SUITE_MISMATCH")
        expected_manifest = _domain_digest("suite", {
            "checks": checks, "gateCatalogDigest": suite["gateCatalogDigest"], "subjectPolicy": suite["subjectPolicy"],
            "taskBindingDigest": suite["taskBindingDigest"], "verifierAuthorityDigest": suite["verifierAuthorityDigest"],
        })
        if suite["manifestDigest"] != expected_manifest:
            raise ProtocolRefusal("KERNEL_SUITE_MISMATCH")
        return suite
    except ProtocolRefusal as error:
        if error.safe_code == "KERNEL_SUITE_MISMATCH":
            raise
        raise ProtocolRefusal("KERNEL_SUITE_MISMATCH") from error


def _freeze_suite(request: dict[str, Any], body: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    try:
        closed = _closed(body, {"suite", "suiteDigest"})
    except ProtocolRefusal as error:
        raise ProtocolRefusal("KERNEL_SUITE_MISMATCH") from error
    suite = _frozen_suite(closed["suite"])
    suite_digest = _domain_digest("suite", suite)
    if closed["suiteDigest"] != suite_digest:
        raise ProtocolRefusal("KERNEL_SUITE_MISMATCH")
    journal = Journal(_journal_path())
    try:
        if not _journal_path().is_file() or not journal.verify():
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
        records = journal.entries()
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    if any(not isinstance(record, dict) for record in records):
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
    tasks = [record for record in records if record.get("kind") == "kogg.task-binding.v1" and record.get("bindingDigest") == suite["taskBindingDigest"]]
    if len(tasks) != 1:
        raise ProtocolRefusal("KERNEL_TASK_BINDING_MISMATCH" if not tasks else "KERNEL_JOURNAL_AMBIGUOUS")
    task = tasks[0].get("binding")
    if not isinstance(task, dict) or task.get("authorityDigest") == suite["verifierAuthorityDigest"]:
        raise ProtocolRefusal("KERNEL_ROLE_SEPARATION_FAILED")
    prior = [record for record in records if record.get("kind") == "kogg.frozen-suite.v1" and record.get("idempotencyKey") == request["idempotencyKey"]]
    if len(prior) > 1:
        raise ProtocolRefusal("KERNEL_JOURNAL_AMBIGUOUS")
    projection = {"suiteDigest": suite_digest, "suiteId": suite["suiteId"], "suiteRevision": suite["suiteRevision"]}
    if prior:
        if prior[0].get("bodyDigest") != request["bodyDigest"] or prior[0].get("suiteDigest") != suite_digest:
            raise ProtocolRefusal("KERNEL_IDEMPOTENCY_CONFLICT")
        return projection, _journal_position(records, records.index(prior[0]) + 1)
    fact = {
        "kind": "kogg.frozen-suite.v1", "idempotencyKey": request["idempotencyKey"],
        "bodyDigest": request["bodyDigest"], "suiteDigest": suite_digest, "suite": suite,
    }
    try:
        root = journal.append(_KernelFact(fact))
        committed = journal.entries()
        if not journal.verify() or not committed or committed[-1] != fact:
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    return projection, {"sequence": str(len(committed)), "rootDigest": root}


def _capabilities() -> dict[str, Any]:
    provenance = _provenance()
    return {
        "protocol": PROTOCOL,
        "protocolVersion": PROTOCOL_VERSION,
        "ranexCommit": provenance["commit"],
        "ranexTree": provenance["tree"],
        "schemaFingerprints": _schema_fingerprints(),
        "commands": COMMANDS,
        "qualifiedProviders": [],
        "confinement": "unavailable",
        "degradationReasons": [
            "the pinned Ranex revision has no qualified writable-agent profile"
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


def _dispatch(request: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str] | None]:
    operation = request["operation"]
    body = request["body"]
    if not isinstance(body, dict):
        raise ProtocolRefusal("KERNEL_PROTOCOL_INVALID")
    if operation == "kernel.handshake":
        required = {"adapterArtifactDigest", "processRegistrationId", "schemaSetDigest"}
        process_id = body.get("processRegistrationId", "")
        if set(body) != required or body["adapterArtifactDigest"] != _adapter_digest() or body["schemaSetDigest"] != SCHEMA_SET_DIGEST or not isinstance(process_id, str) or not UUID.fullmatch(process_id):
            raise ProtocolRefusal("KERNEL_PROVENANCE_MISMATCH")
        return _capabilities(), None
    if operation == "kernel.health":
        if body:
            raise ProtocolRefusal("KERNEL_PROTOCOL_INVALID")
        capabilities = _capabilities()
        journal = _journal_state()
        status = "ready" if capabilities["confinement"] == "qualified" and journal == "valid" else "degraded"
        return {"status": status, "journal": journal, "capabilities": capabilities}, None
    if operation == "task.bind":
        return _bind_task(request, body)
    if operation == "producer.dispatch":
        return _dispatch_producer(request, body)
    if operation == "suite.freeze":
        return _freeze_suite(request, body)
    raise ProtocolRefusal("KERNEL_CAPABILITY_UNAVAILABLE")


def _result(request: dict[str, Any], status: str, safe_code: str, projection: Any = None, journal: dict[str, str] | None = None) -> dict[str, Any]:
    result_digest = _digest(projection) if projection is not None else None
    return {
        "protocol": PROTOCOL,
        "requestId": request.get("requestId", "00000000-0000-4000-8000-000000000000"),
        "operationId": request.get("operationId", "00000000-0000-4000-8000-000000000000"),
        "status": status,
        "safeCode": safe_code,
        "resultDigest": result_digest,
        "journal": journal,
        "projection": projection,
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


def _execution_qualification(params: dict[str, Any]) -> dict[str, Any]:
    target_id = params.get("targetId")
    if not isinstance(target_id, str) or not target_id or len(target_id.encode("utf-8")) > 128:
        raise ValueError("target identity is invalid")
    # The pinned Ranex revision has no writable-agent profile implementation. Returning a
    # closed refusal prevents Linux alone from being misrepresented as qualification.
    return {
        "schemaVersion": 1,
        "qualificationId": str(uuid.uuid4()),
        "targetId": target_id,
        "architecture": "amd64",
        "profileId": "kogg-writable-agent-v1",
        "profileDigest": "sha256:" + "0" * 64,
        "bootIdDigest": "sha256:" + "0" * 64,
        "kernelRelease": platform.release()[:128],
        "landlockAbi": "0",
        "cgroupProfileDigest": "sha256:" + "0" * 64,
        "mountQuotaDigest": "sha256:" + "0" * 64,
        "launcherDigest": "sha256:" + "0" * 64,
        "bubblewrapDigest": "sha256:" + "0" * 64,
        "seccompDigest": "sha256:" + "0" * 64,
        "brokerDigest": "sha256:" + "0" * 64,
        "ranexCommit": _provenance()["commit"],
        "checkedAt": "1970-01-01T00:00:00.000Z",
        "expiresAt": "1970-01-01T00:00:00.000Z",
        "status": "refused",
        "refusalCodes": ["QUALIFICATION_PROFILE_UNAVAILABLE"],
    }


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
    if method == "execution.qualify":
        return _execution_qualification(params)
    if method == "shutdown":
        return {"stopping": True}
    raise ValueError("unsupported kernel method")


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
            projection, journal = _dispatch(request)
            response = _result(request, "succeeded", "KERNEL_OK", projection, journal)
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
