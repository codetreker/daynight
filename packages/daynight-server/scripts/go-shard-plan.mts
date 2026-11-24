import { readFileSync } from 'node:fs';

export const shardNames = ['root', 'store-a', 'store-b', 'other'] as const;
export type ShardName = (typeof shardNames)[number];

const heavyStoreDomains = new Set(['github', 'identity', 'session', 'task']);

export const planPackages = (packages: string[], modulePath: string): Record<ShardName, string[]> => {
  if (modulePath === '' || /\s/.test(modulePath) || modulePath.endsWith('/')) {
    throw new Error('Expected the Go server module import path.');
  }

  const command = `${modulePath}/cmd/daynight-server`;
  const store = `${modulePath}/internal/core/store/postgres`;
  const plan: Record<ShardName, string[]> = { root: [], 'store-a': [], 'store-b': [], other: [] };
  const seen = new Set<string>();

  for (const name of [...packages].sort()) {
    if ((name !== modulePath && !name.startsWith(modulePath + '/')) || /\s/.test(name)) {
      throw new Error(`Unexpected package in the Go server module: ${JSON.stringify(name)}.`);
    }
    if (seen.has(name)) throw new Error(`Duplicate Go server package: ${name}.`);
    seen.add(name);
    if (name === command) continue;

    if (name === store) {
      plan.root.push(name);
    } else if (name.startsWith(store + '/')) {
      const domain = name.slice(store.length + 1).split('/', 1)[0]!;
      // These four DAO domains account for about half of the Store child
      // package runtime on a hosted PR runner.
      plan[heavyStoreDomains.has(domain) ? 'store-a' : 'store-b'].push(name);
    } else {
      plan.other.push(name);
    }
  }

  if (!seen.has(command)) throw new Error(`Expected the separately verified command package: ${command}.`);
  for (const shard of shardNames) {
    if (plan[shard].length === 0) throw new Error(`No Go server packages assigned to shard ${shard}.`);
  }
  return plan;
};

if (import.meta.main) {
  try {
    const [operation, modulePath, ...extra] = process.argv.slice(2);
    if (operation !== 'plan' || modulePath === undefined || extra.length > 0) {
      throw new Error('Usage: go-shard-plan.mts plan MODULE_PATH, with go list output on stdin.');
    }
    const packages = readFileSync(0, 'utf8').split(/\r?\n/);
    if (packages.at(-1) === '') packages.pop();
    console.log(JSON.stringify(planPackages(packages, modulePath)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
