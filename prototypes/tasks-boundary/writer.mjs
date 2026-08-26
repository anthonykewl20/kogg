// diagnostic-exempt: disposable crash prototype retained off production branches
import { DatabaseSync } from 'node:sqlite';

const mode = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const { databasePath, marker, digest } = JSON.parse(input);
  const database = new DatabaseSync(databasePath, { timeout: 500 });
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('BEGIN IMMEDIATE');
  database.prepare(`
    INSERT INTO crash_markers(marker, digest, mode) VALUES (?, ?, ?)
  `).run(marker, digest, mode);

  if (mode === 'hold') {
    process.stdout.write('READY\n');
    setInterval(() => undefined, 1_000);
    return;
  }
  if (mode === 'kill-before-commit') {
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  if (mode === 'kill-after-commit') {
    database.exec('COMMIT');
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  database.exec('ROLLBACK');
  database.close();
  process.exitCode = 65;
});
