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
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from ranex.governed_execution.adapters.persistence.sqlite.journal import Journal

# diagnostic-coverage: kernel.protocol, kernel.bridge

PROTOCOL = "kogg.ranex/v2"
PROTOCOL_VERSION = 2
SCHEMA_SET_DIGEST = "sha256:90d8f437f914807b5eee9bcd4b1f701ebb34da9648bed1db83c6f2a0749192da"
MAX_FRAME_BYTES = 1024 * 1024
MAX_DEPTH = 32
MAX_MEMBERS = 4096
MAX_PENDING_REQUESTS = 64
MAX_PENDING_RESPONSE_BYTES = 4 * 1024 * 1024
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
IMPLEMENTED_OPERATIONS = {"kernel.handshake": 2, "kernel.health": 1, "execution.qualify": 1, "task.bind": 1, "producer.dispatch": 1, "suite.freeze": 1, "suite.execute": 1, "evidence.admit": 1, "gate.evaluate": 1, "verdict.read": 1, "operation.reconcile": 1, "operation.cancel": 1}
SYMBOLIC = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,127}$")
CHECK_KINDS = {"build", "unit", "integration", "visible-e2e", "observability", "diagnostics", "source-maps", "process-cleanup", "ranex-evidence"}


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


def _process_authority(value: Any) -> dict[str, Any]:
    authority = _closed(value, {
        "operationId", "processRegistrationId", "processKind", "processOwner", "operationState", "exitClass",
        "startedAt", "finishedAt", "cleanupAt", "suiteDigest", "checkDefinitionDigest", "subjectStateDigest",
        "verifierId", "verifierArtifactDigest", "executionProfileDigest", "resultArtifactDigest", "cleanupProofDigest",
    })
    _uuid(authority["operationId"]); _uuid(authority["processRegistrationId"])
    if authority["processKind"] not in {"check", "build", "test"} or authority["processOwner"] not in {"kogg-supervisor", "theia-task", "theia-terminal", "theia-debug", "theia-plugin-host", "ranex"}:
        raise ProtocolRefusal("KERNEL_AUTHORITY_INVALID")
    if authority["operationState"] not in {"completed", "failed", "timed-out", "cancelled"} or authority["exitClass"] not in {"zero", "nonzero", "signal"}:
        raise ProtocolRefusal("KERNEL_AUTHORITY_INVALID")
    for field in ("startedAt", "finishedAt", "cleanupAt"):
        _timestamp(authority[field])
    _uuid(authority["verifierId"])
    for field in ("suiteDigest", "checkDefinitionDigest", "subjectStateDigest", "verifierArtifactDigest", "executionProfileDigest", "resultArtifactDigest"):
        _sha256(authority[field])
    proof = {field: authority[field] for field in (
        "operationId", "processRegistrationId", "processKind", "processOwner", "operationState", "exitClass",
        "startedAt", "finishedAt", "cleanupAt", "suiteDigest", "checkDefinitionDigest", "subjectStateDigest",
        "verifierId", "verifierArtifactDigest", "executionProfileDigest", "resultArtifactDigest",
    )}
    if authority["cleanupProofDigest"] != _domain_digest("process-execution-cleanup", proof):
        raise ProtocolRefusal("KERNEL_AUTHORITY_INVALID")
    return authority


def _check_execution(value: Any) -> dict[str, Any]:
    execution = _closed(value, {
        "executionId", "suiteDigest", "checkDefinitionDigest", "subjectState", "verifierId", "verifierRole",
        "verifierArtifactDigest", "processRegistrationId", "executionProfileDigest", "startedAt", "finishedAt",
        "outcome", "exitClass", "resultArtifactDigest", "cleanupProofDigest",
    })
    _uuid(execution["executionId"]); _uuid(execution["verifierId"]); _uuid(execution["processRegistrationId"])
    for field in ("suiteDigest", "checkDefinitionDigest", "verifierArtifactDigest", "executionProfileDigest", "resultArtifactDigest", "cleanupProofDigest"):
        _sha256(execution[field])
    _repository_state(execution["subjectState"])
    if execution["verifierRole"] != "verification" or execution["outcome"] not in {"pass", "fail", "cancelled", "timeout", "infrastructure"} or execution["exitClass"] not in {"zero", "nonzero", "signal", "none"}:
        raise ProtocolRefusal("KERNEL_CHECK_INFRASTRUCTURE")
    started = _timestamp(execution["startedAt"]); finished = _timestamp(execution["finishedAt"])
    if finished < started:
        raise ProtocolRefusal("KERNEL_CHECK_INFRASTRUCTURE")
    return execution


def _execute_suite(request: dict[str, Any], body: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    try:
        closed = _closed(body, {"execution", "executionDigest", "processAuthority"})
    except ProtocolRefusal as error:
        raise ProtocolRefusal("KERNEL_CHECK_INFRASTRUCTURE") from error
    execution = _check_execution(closed["execution"]); authority = _process_authority(closed["processAuthority"])
    execution_digest = _domain_digest("check-execution", execution)
    if closed["executionDigest"] != execution_digest:
        raise ProtocolRefusal("KERNEL_CHECK_INFRASTRUCTURE")
    expected_outcome = "timeout" if authority["operationState"] == "timed-out" else "cancelled" if authority["operationState"] == "cancelled" else "pass" if authority["exitClass"] == "zero" and authority["operationState"] == "completed" else "fail" if authority["exitClass"] == "nonzero" else "infrastructure"
    if any((
        execution["processRegistrationId"] != authority["processRegistrationId"],
        execution["startedAt"] != authority["startedAt"], execution["finishedAt"] != authority["finishedAt"],
        execution["exitClass"] != authority["exitClass"], execution["outcome"] != expected_outcome,
        execution["cleanupProofDigest"] != authority["cleanupProofDigest"], execution["suiteDigest"] != authority["suiteDigest"],
        execution["checkDefinitionDigest"] != authority["checkDefinitionDigest"],
        _domain_digest("repository-state", execution["subjectState"]) != authority["subjectStateDigest"],
        execution["verifierId"] != authority["verifierId"], execution["verifierArtifactDigest"] != authority["verifierArtifactDigest"],
        execution["executionProfileDigest"] != authority["executionProfileDigest"],
        execution["resultArtifactDigest"] != authority["resultArtifactDigest"],
    )):
        raise ProtocolRefusal("KERNEL_AUTHORITY_INVALID")
    journal = Journal(_journal_path())
    try:
        if not _journal_path().is_file() or not journal.verify():
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
        records = journal.entries()
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    suites = [record for record in records if record.get("kind") == "kogg.frozen-suite.v1" and record.get("suiteDigest") == execution["suiteDigest"]]
    if len(suites) != 1:
        raise ProtocolRefusal("KERNEL_SUITE_MISMATCH" if not suites else "KERNEL_JOURNAL_AMBIGUOUS")
    suite = suites[0].get("suite")
    if not isinstance(suite, dict):
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
    checks = [check for check in suite.get("checks", []) if _domain_digest("check-definition", check) == execution["checkDefinitionDigest"]]
    if len(checks) != 1:
        raise ProtocolRefusal("KERNEL_SUITE_MISMATCH" if not checks else "KERNEL_JOURNAL_AMBIGUOUS")
    tasks = [record for record in records if record.get("kind") == "kogg.task-binding.v1" and record.get("bindingDigest") == suite.get("taskBindingDigest")]
    if len(tasks) != 1 or not isinstance(tasks[0].get("binding"), dict):
        raise ProtocolRefusal("KERNEL_TASK_BINDING_MISMATCH" if not tasks else "KERNEL_JOURNAL_AMBIGUOUS")
    task = tasks[0]["binding"]
    producers = [record.get("binding") for record in records if record.get("kind") == "kogg.producer-binding.v1" and isinstance(record.get("binding"), dict) and record["binding"].get("taskBindingDigest") == suite.get("taskBindingDigest")]
    if execution["executionProfileDigest"] != task.get("executionProfileDigest"):
        raise ProtocolRefusal("KERNEL_AUTHORITY_INVALID")
    if any(producer.get("producerId") == execution["verifierId"] or producer.get("adapterArtifactDigest") == execution["verifierArtifactDigest"] for producer in producers):
        raise ProtocolRefusal("KERNEL_ROLE_SEPARATION_FAILED")
    prior = [record for record in records if record.get("kind") == "kogg.check-execution.v1" and record.get("idempotencyKey") == request["idempotencyKey"]]
    if len(prior) > 1:
        raise ProtocolRefusal("KERNEL_JOURNAL_AMBIGUOUS")
    projection = {"checkExecutionDigest": execution_digest, "executionId": execution["executionId"], "outcome": execution["outcome"]}
    if prior:
        if prior[0].get("bodyDigest") != request["bodyDigest"] or prior[0].get("executionDigest") != execution_digest:
            raise ProtocolRefusal("KERNEL_IDEMPOTENCY_CONFLICT")
        return projection, _journal_position(records, records.index(prior[0]) + 1)
    fact = {"kind": "kogg.check-execution.v1", "idempotencyKey": request["idempotencyKey"], "bodyDigest": request["bodyDigest"], "executionDigest": execution_digest, "execution": execution, "processAuthority": authority}
    try:
        root = journal.append(_KernelFact(fact)); committed = journal.entries()
        if not journal.verify() or not committed or committed[-1] != fact:
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    return projection, {"sequence": str(len(committed)), "rootDigest": root}


def _evidence_manifest(value: Any) -> dict[str, Any]:
    evidence = _closed(value, {
        "evidenceId", "claimType", "subjectStateDigest", "taskBindingDigest", "producerBindingDigest",
        "suiteDigest", "checkDefinitionDigest", "checkExecutionDigest", "resultArtifactDigest",
        "authorityDigest", "ranexProvenanceDigest", "createdAt",
    })
    _uuid(evidence["evidenceId"])
    if not isinstance(evidence["claimType"], str) or not SYMBOLIC.fullmatch(evidence["claimType"]):
        raise ProtocolRefusal("KERNEL_EVIDENCE_INVALID")
    for field in (
        "subjectStateDigest", "taskBindingDigest", "producerBindingDigest", "suiteDigest", "checkDefinitionDigest",
        "checkExecutionDigest", "resultArtifactDigest", "authorityDigest", "ranexProvenanceDigest",
    ):
        _sha256(evidence[field])
    _timestamp(evidence["createdAt"])
    return evidence


def _admit_evidence(request: dict[str, Any], body: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    try:
        closed = _closed(body, {"currentSubject", "evidence", "evidenceDigest"})
    except ProtocolRefusal as error:
        raise ProtocolRefusal("KERNEL_EVIDENCE_INVALID") from error
    evidence = _evidence_manifest(closed["evidence"])
    current_subject = _repository_state(closed["currentSubject"])
    evidence_digest = _domain_digest("evidence", evidence)
    if closed["evidenceDigest"] != evidence_digest or evidence["subjectStateDigest"] != _domain_digest("repository-state", current_subject):
        raise ProtocolRefusal("KERNEL_SUBJECT_STALE")
    provenance = _provenance()
    expected_provenance = _domain_digest("ranex-provenance", {
        "commit": provenance["commit"], "schemaSetDigest": SCHEMA_SET_DIGEST, "tree": provenance["tree"],
    })
    if evidence["ranexProvenanceDigest"] != expected_provenance:
        raise ProtocolRefusal("KERNEL_PROVENANCE_MISMATCH")
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
    tasks = [record for record in records if record.get("kind") == "kogg.task-binding.v1" and record.get("bindingDigest") == evidence["taskBindingDigest"]]
    producers = [record for record in records if record.get("kind") == "kogg.producer-binding.v1" and record.get("bindingDigest") == evidence["producerBindingDigest"]]
    suites = [record for record in records if record.get("kind") == "kogg.frozen-suite.v1" and record.get("suiteDigest") == evidence["suiteDigest"]]
    executions = [record for record in records if record.get("kind") == "kogg.check-execution.v1" and record.get("executionDigest") == evidence["checkExecutionDigest"]]
    if any(len(matches) > 1 for matches in (tasks, producers, suites, executions)):
        raise ProtocolRefusal("KERNEL_JOURNAL_AMBIGUOUS")
    if any(len(matches) != 1 for matches in (tasks, producers, suites, executions)):
        raise ProtocolRefusal("KERNEL_EVIDENCE_MISSING")
    task = tasks[0].get("binding"); producer = producers[0].get("binding")
    suite = suites[0].get("suite"); execution = executions[0].get("execution")
    if not all(isinstance(value, dict) for value in (task, producer, suite, execution)):
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
    if producer["taskBindingDigest"] != evidence["taskBindingDigest"] or suite["taskBindingDigest"] != evidence["taskBindingDigest"]:
        raise ProtocolRefusal("KERNEL_EVIDENCE_CONFLICT")
    if execution["suiteDigest"] != evidence["suiteDigest"] or execution["checkDefinitionDigest"] != evidence["checkDefinitionDigest"]:
        raise ProtocolRefusal("KERNEL_EVIDENCE_CONFLICT")
    if execution["resultArtifactDigest"] != evidence["resultArtifactDigest"] or _domain_digest("repository-state", execution["subjectState"]) != evidence["subjectStateDigest"]:
        raise ProtocolRefusal("KERNEL_EVIDENCE_STALE")
    if suite["verifierAuthorityDigest"] != evidence["authorityDigest"] or execution["outcome"] not in {"pass", "fail"}:
        raise ProtocolRefusal("KERNEL_EVIDENCE_INVALID")
    created_at = datetime.strptime(evidence["createdAt"], "%Y-%m-%dT%H:%M:%S.%fZ")
    if created_at < datetime.strptime(execution["finishedAt"], "%Y-%m-%dT%H:%M:%S.%fZ") or created_at > datetime.utcnow() + timedelta(seconds=5):
        raise ProtocolRefusal("KERNEL_EVIDENCE_STALE")
    same_id = [record for record in records if record.get("kind") == "kogg.evidence.v1" and isinstance(record.get("evidence"), dict) and record["evidence"].get("evidenceId") == evidence["evidenceId"]]
    if same_id and any(record.get("evidenceDigest") != evidence_digest for record in same_id):
        raise ProtocolRefusal("KERNEL_EVIDENCE_CONFLICT")
    prior = [record for record in records if record.get("kind") == "kogg.evidence.v1" and record.get("idempotencyKey") == request["idempotencyKey"]]
    if len(prior) > 1 or len(same_id) > 1:
        raise ProtocolRefusal("KERNEL_JOURNAL_AMBIGUOUS")
    projection = {"claimType": evidence["claimType"], "evidenceDigest": evidence_digest, "evidenceId": evidence["evidenceId"]}
    if prior:
        if prior[0].get("bodyDigest") != request["bodyDigest"] or prior[0].get("evidenceDigest") != evidence_digest:
            raise ProtocolRefusal("KERNEL_IDEMPOTENCY_CONFLICT")
        return projection, _journal_position(records, records.index(prior[0]) + 1)
    if same_id:
        raise ProtocolRefusal("KERNEL_EVIDENCE_DUPLICATE")
    fact = {
        "kind": "kogg.evidence.v1", "idempotencyKey": request["idempotencyKey"], "bodyDigest": request["bodyDigest"],
        "evidenceDigest": evidence_digest, "evidence": evidence,
    }
    try:
        root = journal.append(_KernelFact(fact)); committed = journal.entries()
        if not journal.verify() or not committed or committed[-1] != fact:
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    return projection, {"sequence": str(len(committed)), "rootDigest": root}


def _gate_expectation(value: Any) -> dict[str, Any]:
    expectation = _closed(value, {
        "verdictId", "taskBindingDigest", "suiteDigest", "subjectStateDigest", "gateCatalogDigest",
        "requirements", "authorityDigest", "ranexProvenanceDigest", "evaluatedAt",
    })
    _uuid(expectation["verdictId"])
    for field in ("taskBindingDigest", "suiteDigest", "subjectStateDigest", "gateCatalogDigest", "authorityDigest", "ranexProvenanceDigest"):
        _sha256(expectation[field])
    _timestamp(expectation["evaluatedAt"])
    requirements = expectation["requirements"]
    if not isinstance(requirements, list) or not 1 <= len(requirements) <= 64:
        raise ProtocolRefusal("KERNEL_GATE_INCOMPLETE")
    for requirement in requirements:
        _closed(requirement, {"claimType", "checkDefinitionDigest", "requiredOutcome"})
        if not isinstance(requirement["claimType"], str) or not SYMBOLIC.fullmatch(requirement["claimType"]) or requirement["requiredOutcome"] != "pass":
            raise ProtocolRefusal("KERNEL_GATE_INCOMPLETE")
        _sha256(requirement["checkDefinitionDigest"])
    keys = [(item["claimType"], item["checkDefinitionDigest"]) for item in requirements]
    if keys != sorted(keys) or len(keys) != len(set(keys)) or expectation["gateCatalogDigest"] != _domain_digest("gate-catalog", requirements):
        raise ProtocolRefusal("KERNEL_GATE_INCOMPLETE")
    return expectation


def _evaluate_gate(request: dict[str, Any], body: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    try:
        closed = _closed(body, {"currentSubject", "expectation", "expectationDigest"})
    except ProtocolRefusal as error:
        raise ProtocolRefusal("KERNEL_GATE_INCOMPLETE") from error
    expectation = _gate_expectation(closed["expectation"]); current_subject = _repository_state(closed["currentSubject"])
    expectation_digest = _domain_digest("gate-evaluation", expectation)
    if closed["expectationDigest"] != expectation_digest or expectation["subjectStateDigest"] != _domain_digest("repository-state", current_subject):
        raise ProtocolRefusal("KERNEL_SUBJECT_STALE")
    provenance = _provenance()
    expected_provenance = _domain_digest("ranex-provenance", {"commit": provenance["commit"], "schemaSetDigest": SCHEMA_SET_DIGEST, "tree": provenance["tree"]})
    if expectation["ranexProvenanceDigest"] != expected_provenance:
        raise ProtocolRefusal("KERNEL_PROVENANCE_MISMATCH")
    evaluated_at = datetime.strptime(expectation["evaluatedAt"], "%Y-%m-%dT%H:%M:%S.%fZ")
    if evaluated_at > datetime.utcnow() + timedelta(seconds=5):
        raise ProtocolRefusal("KERNEL_VERDICT_STALE")
    journal = Journal(_journal_path())
    try:
        if not _journal_path().is_file() or not journal.verify():
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
        records = journal.entries()
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    prior = [record for record in records if record.get("kind") == "kogg.verdict.v1" and record.get("idempotencyKey") == request["idempotencyKey"]]
    if len(prior) > 1:
        raise ProtocolRefusal("KERNEL_JOURNAL_AMBIGUOUS")
    if prior:
        stored = prior[0].get("verdict")
        if prior[0].get("bodyDigest") != request["bodyDigest"] or prior[0].get("expectationDigest") != expectation_digest or not isinstance(stored, dict):
            raise ProtocolRefusal("KERNEL_IDEMPOTENCY_CONFLICT")
        projection = {"decision": stored.get("decision"), "evidenceCount": len(prior[0].get("evidenceDigests", [])), "verdictDigest": prior[0].get("verdictDigest"), "verdictId": stored.get("verdictId")}
        return projection, _journal_position(records, records.index(prior[0]) + 1)
    tasks = [record for record in records if record.get("kind") == "kogg.task-binding.v1" and record.get("bindingDigest") == expectation["taskBindingDigest"]]
    suites = [record for record in records if record.get("kind") == "kogg.frozen-suite.v1" and record.get("suiteDigest") == expectation["suiteDigest"]]
    if len(tasks) > 1 or len(suites) > 1:
        raise ProtocolRefusal("KERNEL_JOURNAL_AMBIGUOUS")
    if len(tasks) != 1 or len(suites) != 1 or not isinstance(tasks[0].get("binding"), dict) or not isinstance(suites[0].get("suite"), dict):
        raise ProtocolRefusal("KERNEL_GATE_INCOMPLETE")
    task = tasks[0]["binding"]; suite = suites[0]["suite"]
    if suite.get("taskBindingDigest") != expectation["taskBindingDigest"] or suite.get("gateCatalogDigest") != expectation["gateCatalogDigest"] or suite.get("verifierAuthorityDigest") != expectation["authorityDigest"]:
        raise ProtocolRefusal("KERNEL_GATE_INCOMPLETE")
    suite_checks = {_domain_digest("check-definition", check) for check in suite.get("checks", []) if isinstance(check, dict)}
    if any(requirement["checkDefinitionDigest"] not in suite_checks for requirement in expectation["requirements"]):
        raise ProtocolRefusal("KERNEL_GATE_INCOMPLETE")
    selected: list[dict[str, Any]] = []; gate_rows: list[dict[str, Any]] = []; blocked = False; failed = False
    for requirement in expectation["requirements"]:
        matches = [record for record in records if record.get("kind") == "kogg.evidence.v1" and isinstance(record.get("evidence"), dict)
                   and record["evidence"].get("claimType") == requirement["claimType"]
                   and record["evidence"].get("checkDefinitionDigest") == requirement["checkDefinitionDigest"]
                   and record["evidence"].get("taskBindingDigest") == expectation["taskBindingDigest"]
                   and record["evidence"].get("suiteDigest") == expectation["suiteDigest"]
                   and record["evidence"].get("subjectStateDigest") == expectation["subjectStateDigest"]
                   and record["evidence"].get("authorityDigest") == expectation["authorityDigest"]
                   and record["evidence"].get("ranexProvenanceDigest") == expectation["ranexProvenanceDigest"]]
        if len(matches) != 1:
            blocked = True
            gate_rows.append({**requirement, "result": "blocked", "evidenceDigest": None, "producerBindingDigest": None})
            continue
        evidence_record = matches[0]; evidence = evidence_record["evidence"]
        executions = [record for record in records if record.get("kind") == "kogg.check-execution.v1" and record.get("executionDigest") == evidence.get("checkExecutionDigest")]
        if len(executions) != 1 or not isinstance(executions[0].get("execution"), dict):
            blocked = True
            gate_rows.append({**requirement, "result": "blocked", "evidenceDigest": None, "producerBindingDigest": None})
            continue
        execution = executions[0]["execution"]
        if execution.get("resultArtifactDigest") != evidence.get("resultArtifactDigest") or execution.get("outcome") not in {"pass", "fail"}:
            blocked = True
            gate_rows.append({**requirement, "result": "blocked", "evidenceDigest": None, "producerBindingDigest": None})
            continue
        failed = failed or execution["outcome"] != requirement["requiredOutcome"]
        gate_rows.append({**requirement, "result": execution["outcome"], "evidenceDigest": evidence_record["evidenceDigest"], "producerBindingDigest": evidence["producerBindingDigest"]})
        selected.append(evidence_record)
    decision = "blocked" if blocked else "fail" if failed else "pass"
    evidence_digests = sorted(str(record["evidenceDigest"]) for record in selected)
    evidence_set_digest = _domain_digest("evidence-set", evidence_digests)
    prior_position = _journal_position(records)
    verdict = {
        "verdictId": expectation["verdictId"], "taskBindingDigest": expectation["taskBindingDigest"],
        "subjectStateDigest": expectation["subjectStateDigest"], "gateCatalogDigest": expectation["gateCatalogDigest"],
        "evidenceSetDigest": evidence_set_digest, "authorityDigest": expectation["authorityDigest"],
        "ranexProvenanceDigest": expectation["ranexProvenanceDigest"], "journalRootDigest": prior_position["rootDigest"],
        "journalSequence": len(records), "decision": decision, "evaluatedAt": expectation["evaluatedAt"],
    }
    verdict_digest = _domain_digest("verdict", verdict)
    same_id = [record for record in records if record.get("kind") == "kogg.verdict.v1" and isinstance(record.get("verdict"), dict) and record["verdict"].get("verdictId") == verdict["verdictId"]]
    if same_id and any(record.get("verdictDigest") != verdict_digest for record in same_id):
        raise ProtocolRefusal("KERNEL_IDEMPOTENCY_CONFLICT")
    if same_id:
        raise ProtocolRefusal("KERNEL_IDEMPOTENCY_CONFLICT")
    projection = {"decision": decision, "evidenceCount": len(selected), "verdictDigest": verdict_digest, "verdictId": verdict["verdictId"]}
    fact = {"kind": "kogg.verdict.v1", "idempotencyKey": request["idempotencyKey"], "bodyDigest": request["bodyDigest"], "expectationDigest": expectation_digest, "verdictDigest": verdict_digest, "verdict": verdict, "evidenceDigests": evidence_digests, "gateRows": gate_rows, "subjectState": current_subject}
    try:
        root = journal.append(_KernelFact(fact)); committed = journal.entries()
        if not journal.verify() or not committed or committed[-1] != fact:
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    return projection, {"sequence": str(len(committed)), "rootDigest": root}


def _verdict_read_expectation(value: Any) -> dict[str, Any]:
    expectation = _closed(value, {
        "verdictId", "verdictDigest", "taskBindingDigest", "subjectStateDigest", "gateCatalogDigest",
        "authorityDigest", "ranexProvenanceDigest",
    })
    _uuid(expectation["verdictId"])
    for field in ("verdictDigest", "taskBindingDigest", "subjectStateDigest", "gateCatalogDigest", "authorityDigest", "ranexProvenanceDigest"):
        _sha256(expectation[field])
    return expectation


def _verdict_gate_rows(value: Any) -> list[dict[str, Any]]:
    try:
        if not isinstance(value, list) or not value:
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
        for row in value:
            _closed(row, {"claimType", "checkDefinitionDigest", "requiredOutcome", "result", "evidenceDigest", "producerBindingDigest"})
            if not isinstance(row["claimType"], str) or not SYMBOLIC.fullmatch(row["claimType"]) or row["requiredOutcome"] != "pass" or row["result"] not in {"pass", "fail", "blocked"}:
                raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
            _sha256(row["checkDefinitionDigest"])
            if row["evidenceDigest"] is not None:
                _sha256(row["evidenceDigest"])
            if row["producerBindingDigest"] is not None:
                _sha256(row["producerBindingDigest"])
            if (row["result"] == "blocked") != (row["evidenceDigest"] is None or row["producerBindingDigest"] is None):
                raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
        return value
    except ProtocolRefusal as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error


def _read_verdict(body: dict[str, Any]) -> tuple[dict[str, Any], None]:
    try:
        closed = _closed(body, {"currentSubject", "expectation", "expectationDigest"})
        expectation = _verdict_read_expectation(closed["expectation"])
        current_subject = _repository_state(closed["currentSubject"])
    except ProtocolRefusal as error:
        raise ProtocolRefusal("KERNEL_VERDICT_STALE") from error
    if closed["expectationDigest"] != _domain_digest("verdict-read", expectation):
        raise ProtocolRefusal("KERNEL_VERDICT_STALE")
    journal = Journal(_journal_path())
    try:
        if not _journal_path().is_file() or not journal.verify():
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
        records = journal.entries()
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    matches = [record for record in records if record.get("kind") == "kogg.verdict.v1"
               and isinstance(record.get("verdict"), dict) and record["verdict"].get("verdictId") == expectation["verdictId"]]
    if len(matches) > 1:
        raise ProtocolRefusal("KERNEL_JOURNAL_AMBIGUOUS")
    if len(matches) != 1:
        raise ProtocolRefusal("KERNEL_VERDICT_STALE")
    record = matches[0]
    verdict = _closed(record["verdict"], {
        "verdictId", "taskBindingDigest", "subjectStateDigest", "gateCatalogDigest", "evidenceSetDigest",
        "authorityDigest", "ranexProvenanceDigest", "journalRootDigest", "journalSequence", "decision", "evaluatedAt",
    })
    for field in ("taskBindingDigest", "subjectStateDigest", "gateCatalogDigest", "evidenceSetDigest", "authorityDigest", "ranexProvenanceDigest", "journalRootDigest"):
        _sha256(verdict[field])
    _uuid(verdict["verdictId"]); _timestamp(verdict["evaluatedAt"])
    if verdict["decision"] not in {"pass", "fail", "blocked"} or not isinstance(verdict["journalSequence"], int) or verdict["journalSequence"] < 0:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
    verdict_digest = _domain_digest("verdict", verdict)
    if record.get("verdictDigest") != verdict_digest or expectation["verdictDigest"] != verdict_digest:
        raise ProtocolRefusal("KERNEL_VERDICT_STALE")
    tasks = [item for item in records if item.get("kind") == "kogg.task-binding.v1" and item.get("bindingDigest") == verdict["taskBindingDigest"]]
    if len(tasks) > 1:
        raise ProtocolRefusal("KERNEL_JOURNAL_AMBIGUOUS")
    task = tasks[0].get("binding") if len(tasks) == 1 else None
    provenance = _provenance()
    current_provenance = _domain_digest("ranex-provenance", {"commit": provenance["commit"], "schemaSetDigest": SCHEMA_SET_DIGEST, "tree": provenance["tree"]})
    record_index = records.index(record)
    binding_fields = ("taskBindingDigest", "subjectStateDigest", "gateCatalogDigest", "authorityDigest", "ranexProvenanceDigest")
    current = (
        all(expectation[field] == verdict[field] for field in binding_fields)
        and verdict["subjectStateDigest"] == _domain_digest("repository-state", current_subject)
        and current_subject["isClean"]
        and verdict["ranexProvenanceDigest"] == current_provenance
        and record_index == len(records) - 1
        and verdict["journalSequence"] == record_index
        and verdict["journalRootDigest"] == _journal_position(records, record_index)["rootDigest"]
        and isinstance(task, dict) and isinstance(task.get("expiresAt"), str)
        and datetime.strptime(_timestamp(task["expiresAt"]), "%Y-%m-%dT%H:%M:%S.%fZ") > datetime.utcnow()
    )
    gate_rows = _verdict_gate_rows(record.get("gateRows"))
    try:
        subject_state = _repository_state(record.get("subjectState"))
    except ProtocolRefusal as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    if _domain_digest("repository-state", subject_state) != verdict["subjectStateDigest"]:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
    projection = {
        "verdictId": verdict["verdictId"], "verdictDigest": verdict_digest,
        "historicalDecision": verdict["decision"], "currentness": "current" if current else "stale",
        "currentDecision": verdict["decision"] if current else None,
        "evidenceSetDigest": verdict["evidenceSetDigest"], "gateCatalogDigest": verdict["gateCatalogDigest"],
        "authorityDigest": verdict["authorityDigest"], "ranexProvenanceDigest": verdict["ranexProvenanceDigest"],
        "journalRootDigest": verdict["journalRootDigest"], "journalSequence": verdict["journalSequence"],
        "evaluatedAt": verdict["evaluatedAt"], "gateRows": gate_rows,
        "subjectState": subject_state,
    }
    return projection, None


def _append_recovery_fact(request: dict[str, Any], fact: dict[str, Any], projection: dict[str, Any], journal: Journal, records: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, str]]:
    prior = [record for record in records if record.get("kind") == fact["kind"] and record.get("idempotencyKey") == request["idempotencyKey"]]
    if len(prior) > 1:
        raise ProtocolRefusal("KERNEL_JOURNAL_AMBIGUOUS")
    if prior:
        if prior[0] != fact:
            raise ProtocolRefusal("KERNEL_IDEMPOTENCY_CONFLICT")
        return projection, _journal_position(records, records.index(prior[0]) + 1)
    try:
        root = journal.append(_KernelFact(fact)); committed = journal.entries()
        if not journal.verify() or not committed or committed[-1] != fact:
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    return projection, {"sequence": str(len(committed)), "rootDigest": root}


def _reconcile_operation(request: dict[str, Any], body: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    try:
        closed = _closed(body, {"expectation", "expectationDigest"})
        expectation = _closed(closed["expectation"], {"targetOperation", "targetIdempotencyKey", "targetBodyDigest", "ranexProvenanceDigest"})
    except ProtocolRefusal as error:
        raise ProtocolRefusal("KERNEL_OUTCOME_UNKNOWN") from error
    allowed = {"task.bind", "producer.dispatch", "suite.freeze", "suite.execute", "evidence.admit", "gate.evaluate"}
    if expectation["targetOperation"] not in allowed:
        raise ProtocolRefusal("KERNEL_OUTCOME_UNKNOWN")
    for field in ("targetIdempotencyKey", "targetBodyDigest", "ranexProvenanceDigest"):
        _sha256(expectation[field])
    expected_target_idempotency = _domain_digest("idempotency", {
        "bodyDigest": expectation["targetBodyDigest"], "operation": expectation["targetOperation"],
        "version": IMPLEMENTED_OPERATIONS[expectation["targetOperation"]],
    })
    if expectation["targetIdempotencyKey"] != expected_target_idempotency:
        raise ProtocolRefusal("KERNEL_OUTCOME_UNKNOWN")
    if closed["expectationDigest"] != _domain_digest("operation-reconcile", expectation):
        raise ProtocolRefusal("KERNEL_OUTCOME_UNKNOWN")
    provenance = _provenance()
    current_provenance = _domain_digest("ranex-provenance", {"commit": provenance["commit"], "schemaSetDigest": SCHEMA_SET_DIGEST, "tree": provenance["tree"]})
    if expectation["ranexProvenanceDigest"] != current_provenance:
        raise ProtocolRefusal("KERNEL_PROVENANCE_MISMATCH")
    journal = Journal(_journal_path())
    try:
        if not _journal_path().is_file() or not journal.verify():
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
        records = journal.entries()
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    same_key = [record for record in records if record.get("idempotencyKey") == expectation["targetIdempotencyKey"]]
    matches = [record for record in same_key if record.get("bodyDigest") == expectation["targetBodyDigest"]]
    if len(same_key) > 1 or len(matches) > 1:
        raise ProtocolRefusal("KERNEL_JOURNAL_AMBIGUOUS")
    target_digest = _domain_digest("journal-fact", matches[0]) if len(matches) == 1 else None
    projection = {"outcome": "acknowledged" if target_digest else "absent", "targetFactDigest": target_digest}
    fact = {
        "kind": "kogg.operation-reconciliation.v1", "idempotencyKey": request["idempotencyKey"], "bodyDigest": request["bodyDigest"],
        "expectationDigest": closed["expectationDigest"], "outcome": projection["outcome"], "targetFactDigest": target_digest,
    }
    return _append_recovery_fact(request, fact, projection, journal, records)


def _cancel_operation(request: dict[str, Any], body: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    closed = _closed(body, {"cancellationRequestId", "cleanupStatus", "targetOperationId"})
    _uuid(closed["cancellationRequestId"]); _uuid(closed["targetOperationId"])
    if closed["cleanupStatus"] != "cleaned":
        raise ProtocolRefusal("KERNEL_CLEANUP_FAILED")
    journal = Journal(_journal_path())
    try:
        if not _journal_path().is_file() or not journal.verify():
            raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY")
        records = journal.entries()
    except ProtocolRefusal:
        raise
    except Exception as error:
        raise ProtocolRefusal("KERNEL_JOURNAL_INTEGRITY") from error
    projection = {"cancellationRequestId": closed["cancellationRequestId"], "outcome": "cancelled-clean", "targetOperationId": closed["targetOperationId"]}
    fact = {"kind": "kogg.operation-cancellation.v1", "idempotencyKey": request["idempotencyKey"], "bodyDigest": request["bodyDigest"], **projection}
    return _append_recovery_fact(request, fact, projection, journal, records)


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
    if operation == "execution.qualify":
        target_id = body.get("targetId")
        if set(body) != {"targetId"} or not isinstance(target_id, str) or not SYMBOLIC.fullmatch(target_id):
            raise ProtocolRefusal("KERNEL_PROTOCOL_INVALID")
        # The pinned Ranex revision has no qualified writable-agent profile. This exact
        # closed refusal prevents host platform alone from becoming execution authority.
        return {
            "schemaVersion": 1, "qualificationId": request["operationId"], "targetId": target_id,
            "architecture": "amd64", "profileId": "kogg-writable-agent-v1",
            "profileDigest": "sha256:" + "0" * 64, "bootIdDigest": "sha256:" + "0" * 64,
            "kernelRelease": platform.release()[:128], "landlockAbi": "0",
            "cgroupProfileDigest": "sha256:" + "0" * 64, "mountQuotaDigest": "sha256:" + "0" * 64,
            "launcherDigest": "sha256:" + "0" * 64, "bubblewrapDigest": "sha256:" + "0" * 64,
            "seccompDigest": "sha256:" + "0" * 64, "brokerDigest": "sha256:" + "0" * 64,
            "ranexCommit": _provenance()["commit"], "checkedAt": "1970-01-01T00:00:00.000Z",
            "expiresAt": "1970-01-01T00:00:00.000Z", "status": "refused",
            "refusalCodes": ["QUALIFICATION_PROFILE_UNAVAILABLE"],
        }, None
    if operation == "task.bind":
        return _bind_task(request, body)
    if operation == "producer.dispatch":
        return _dispatch_producer(request, body)
    if operation == "suite.freeze":
        return _freeze_suite(request, body)
    if operation == "suite.execute":
        return _execute_suite(request, body)
    if operation == "evidence.admit":
        return _admit_evidence(request, body)
    if operation == "gate.evaluate":
        return _evaluate_gate(request, body)
    if operation == "verdict.read":
        return _read_verdict(body)
    if operation == "operation.reconcile":
        return _reconcile_operation(request, body)
    if operation == "operation.cancel":
        return _cancel_operation(request, body)
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
