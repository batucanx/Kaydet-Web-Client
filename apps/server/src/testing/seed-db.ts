import { openSqlite } from '../infrastructure/sqlite/index.ts';
import { seedSqlite } from './sqlite.ts';
import { FakeClock } from './harness.ts';
import { resolve } from 'node:path';

async function main() {
  const clock = new FakeClock();
  const dbPath = resolve(process.cwd(), 'data', 'kaydet.db');
  console.log('Seeding SQLite at', dbPath);
  const persistence = await openSqlite({
    path: dbPath,
    clock,
    busyTimeoutMs: 10000,
    createDirectory: true,
  });
  await seedSqlite(persistence, clock);
  await persistence.close?.();
  console.log('Seed finished successfully!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
