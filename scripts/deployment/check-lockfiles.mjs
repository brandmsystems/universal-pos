import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A second lockfile means the dependency set that was verified and the one that
// gets installed can diverge without anyone noticing. Runs on preinstall and in CI.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FOREIGN = ['package-lock.json', 'yarn.lock', 'bun.lockb'];

const found = FOREIGN.filter((name) => existsSync(path.join(root, name)));

if (found.length > 0) {
  console.error(
    `This project uses pnpm. Remove ${found.join(' and ')} and run "pnpm install".\n` +
      `A second lockfile lets the verified dependency set and the installed one diverge.`,
  );
  process.exit(1);
}
