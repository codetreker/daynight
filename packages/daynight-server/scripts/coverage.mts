import { createReadStream } from 'node:fs';

type Coverage = {
  covered: bigint;
  total: bigint;
};

type Block = {
  statements: bigint;
  covered: boolean;
};

class ProfileParser {
  private readonly blocks = new Map<string, Block>();
  private lineNumber = 0;

  addLine(line: string): void {
    this.lineNumber++;
    if (this.lineNumber === 1) {
      if (!/^mode: (set|count|atomic)$/.test(line)) {
        throw new Error('Coverage profile must begin with a valid Go coverage mode.');
      }
      return;
    }
    const row = /^(.+):([1-9]\d*)\.([1-9]\d*),([1-9]\d*)\.([1-9]\d*) (0|[1-9]\d*) (0|[1-9]\d*)$/.exec(line);
    if (row === null) {
      throw new Error(`Invalid coverage profile row ${this.lineNumber}.`);
    }
    const [, filename, startLine, startColumn, endLine, endColumn, statements, count] = row;
    if (BigInt(endLine) < BigInt(startLine) ||
      (startLine === endLine && BigInt(endColumn) < BigInt(startColumn))) {
      throw new Error(`Invalid coverage block position at row ${this.lineNumber}.`);
    }
    const key = `${filename}:${startLine}.${startColumn},${endLine}.${endColumn}`;
    const statementCount = BigInt(statements);
    const covered = BigInt(count) > 0n;
    const previous = this.blocks.get(key);
    if (previous !== undefined && previous.statements !== statementCount) {
      throw new Error(`Inconsistent statement count for coverage block at row ${this.lineNumber}.`);
    }
    this.blocks.set(key, { statements: statementCount, covered: covered || previous?.covered === true });
  }

  finish(): Coverage {
    if (this.lineNumber === 0) {
      throw new Error('Coverage profile must begin with a valid Go coverage mode.');
    }
    let covered = 0n;
    let total = 0n;
    for (const block of this.blocks.values()) {
      total += block.statements;
      if (block.covered) covered += block.statements;
    }
    if (total === 0n) {
      throw new Error('Coverage profile contains no statements.');
    }
    return { covered, total };
  }
}

export const parseCoverageProfile = (profile: string): Coverage => {
  const lines = profile.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const parser = new ProfileParser();
  for (const line of lines) parser.addLine(line);
  return parser.finish();
};

// Chunk boundaries can split both a row and CRLF; only an actual CRLF is
// normalized, so a stray CR remains invalid just as in the string parser.
export const parseCoverageStream = async (chunks: AsyncIterable<string>): Promise<Coverage> => {
  const parser = new ProfileParser();
  let pending = '';
  for await (const chunk of chunks) {
    pending += chunk;
    let start = 0;
    let end: number;
    while ((end = pending.indexOf('\n', start)) !== -1) {
      const line = pending.slice(start, end);
      parser.addLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      start = end + 1;
    }
    pending = pending.slice(start);
  }
  if (pending !== '') parser.addLine(pending);
  return parser.finish();
};

export const requireCoverageAbove90 = ({ covered, total }: Coverage): void => {
  // go-cov accepts exactly 90%; the module requires a strict, unrounded comparison.
  if (covered * 10n <= total * 9n) {
    throw new Error(`Overall coverage must be >90%; covered ${covered} of ${total} statements.`);
  }
};

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) {
      throw new Error('Usage: node scripts/coverage.mts <coverage-profile>');
    }
    const coverage = await parseCoverageStream(createReadStream(process.argv[2], { encoding: 'utf8' }));
    requireCoverageAbove90(coverage);
    console.log(`Overall coverage >90%: ${coverage.covered}/${coverage.total} statements.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
