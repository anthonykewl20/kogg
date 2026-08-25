const { DatabaseSync } = require('node:sqlite');

const database = new DatabaseSync(':memory:');
database.exec('CREATE TABLE runtime_probe(value TEXT NOT NULL)');
database.prepare('INSERT INTO runtime_probe(value) VALUES (?)').run('electron');
const row = database.prepare('SELECT value FROM runtime_probe').get();
database.close();

process.stdout.write(JSON.stringify({
  runtime: 'electron-node',
  node: process.versions.node,
  electron: process.versions.electron,
  sqlite: process.versions.sqlite,
  value: row.value
}) + '\n');
