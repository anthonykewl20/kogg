import { DatabaseSync } from 'node:sqlite';

const [databasePath, stage, marker] = process.argv.slice(2);
if (!databasePath || !stage || !marker) {
  process.exitCode = 64;
} else {
  const database = new DatabaseSync(databasePath, { timeout: 500 });
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('BEGIN IMMEDIATE');
  database.prepare('INSERT INTO probe_events(marker, stage) VALUES (?, ?)').run(marker, stage);

  if (stage === 'hold') {
    process.stdout.write('READY\n');
    setInterval(() => undefined, 1_000);
  } else if (stage === 'kill-before-commit') {
    process.kill(process.pid, 'SIGKILL');
  } else if (stage === 'kill-after-commit') {
    database.exec('COMMIT');
    process.kill(process.pid, 'SIGKILL');
  } else {
    database.exec('ROLLBACK');
    database.close();
    process.exitCode = 65;
  }
}
