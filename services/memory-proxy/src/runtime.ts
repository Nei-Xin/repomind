/** Runtime compatibility checks shared by startup code and tests. */

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 5;

/** Return whether a Node.js version satisfies the package runtime contract. */
export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)(?:\.(\d+))?/u.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}

export function assertSupportedNodeVersion(version = process.version): void {
  if (isSupportedNodeVersion(version)) return;
  throw new Error(`Node.js >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is required; current version is ${version}`);
}
