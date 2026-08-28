/**
 * Point `@paperclipai/adapter-utils` at the host Paperclip's own copy.
 *
 * `adapter-utils` keeps `runningProcesses` in a module-scope Map. Paperclip's
 * heartbeat reads that Map to cancel and reap runs, so an adapter that loads a
 * *second* copy registers its children somewhere the server never looks: runs
 * start, then cannot be stopped and stale-run detection misses them. Nothing
 * throws, which is what makes it worth preventing here rather than debugging
 * later.
 *
 * The package declares adapter-utils as a peer dependency for exactly this
 * reason, but it is also a devDependency — the build and the tests need it —
 * and that installed copy is what Node would otherwise resolve. So after every
 * install we replace it with a symlink to whatever copy the host Paperclip CLI
 * is running.
 *
 * No-ops when no Paperclip install is found (CI, a fresh clone, a machine that
 * only builds the package), because an unmet peer is the caller's problem to
 * report, not this script's to guess at.
 */

import { existsSync, lstatSync, realpathSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@paperclipai/adapter-utils";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localCopy = join(projectRoot, "node_modules", PACKAGE);

const paperclipHome = process.env.PAPERCLIP_HOME ?? join(homedir(), ".paperclip");

/**
 * `cli/current` is a symlink Paperclip repoints on upgrade, so linking to it
 * rather than to the resolved version keeps this correct across CLI updates.
 */
const hostCopy = join(paperclipHome, "cli", "current", "node_modules", PACKAGE);

const samePath = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

if (!existsSync(hostCopy)) {
  console.log(`[link-adapter-utils] No Paperclip CLI at ${paperclipHome} — leaving ${PACKAGE} as installed.`);
  process.exit(0);
}

if (existsSync(localCopy) && samePath(localCopy, hostCopy)) {
  console.log(`[link-adapter-utils] ${PACKAGE} already resolves to the host copy.`);
  process.exit(0);
}

try {
  if (existsSync(localCopy) || lstatSync(localCopy, { throwIfNoEntry: false })) {
    rmSync(localCopy, { recursive: true, force: true });
  }
  mkdirSync(dirname(localCopy), { recursive: true });
  symlinkSync(hostCopy, localCopy, "dir");
  console.log(`[link-adapter-utils] ${PACKAGE} -> ${realpathSync(localCopy)}`);
} catch (error) {
  // A failure here costs run cancellation, not the build, so say so loudly and
  // let the install finish.
  console.warn(`[link-adapter-utils] Could not link ${PACKAGE}: ${error.message}`);
  console.warn("[link-adapter-utils] Runs may not be cancellable until this is resolved.");
}
