import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [databasePath, fifoPath, outputPath, errorPath, python, adapter, ranexSource, provenance, journal] = process.argv.slice(2);
const database = new DatabaseSync(databasePath);
const operationId = randomUUID();
const processId = randomUUID();
const instanceId = randomUUID();

transaction(() => {
  database.prepare(`INSERT INTO operations(id,state,cleanup_state,owner_instance_id) VALUES(?, 'starting', 'required', ?)`).run(operationId, instanceId);
  database.prepare(`INSERT INTO processes(id,operation_id,state,cleanup_state,owner_instance_id) VALUES(?, ?, 'registered', 'required', ?)`).run(processId, operationId, instanceId);
  database.prepare(`INSERT INTO events(operation_id,process_id,event_name) VALUES(?, ?, 'process.registered')`).run(operationId, processId);
});

const fifo = openSync(fifoPath, 'r+');
const output = openSync(outputPath, 'w');
const error = openSync(errorPath, 'w');
const child = spawn(python, ['-u', adapter], {
  detached: true,
  env: {
    PATH: process.env.PATH ?? '',
    PYTHONPATH: ranexSource,
    KOGG_RANEX_JOURNAL: journal,
    KOGG_RANEX_PROVENANCE: provenance
  },
  stdio: [fifo, output, error]
});
if (!child.pid) throw new Error('Ranex recovery child did not start');
const fingerprint = fingerprintFor(child.pid);
transaction(() => {
  database.prepare(`UPDATE processes SET state='started', pid=?, identity_fingerprint=? WHERE id=?`).run(child.pid, fingerprint, processId);
  database.prepare(`INSERT INTO events(operation_id,process_id,event_name) VALUES(?, ?, 'process.started')`).run(operationId, processId);
});
writeFileSync(fifo, `${JSON.stringify({
  id: 'prototype-handshake', method: 'handshake', params: {
    protocol: 'kogg-ranex-stdio', protocolVersion: 1,
    ranexCommit: JSON.parse(readFileSync(provenance, 'utf8')).commit
  }
})}\n`);
closeSync(fifo); closeSync(output); closeSync(error);
child.unref();
database.close();

function fingerprintFor(pid) {
  if (process.platform === 'linux') {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(' ');
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return `linux:${boot}:${fields[21]}`;
  }
  const started = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return `${process.platform}:${started}`;
}

function transaction(run) {
  database.exec('BEGIN IMMEDIATE');
  try { run(); database.exec('COMMIT'); } catch (error) { database.exec('ROLLBACK'); throw error; }
}
