import type mermaid from 'mermaid';

export type StableMermaidType = 'flowchart' | 'flowchart-elk' | 'sequence' | 'class' | 'state' | 'er' | 'gantt' | 'journey' | 'pie' | 'quadrant' | 'requirement' | 'xy' | 'block' | 'packet' | 'kanban' | 'eventmodeling';
export type MermaidPolicyIssue = 'unsupported' | 'complexity' | 'image';

export class MermaidPolicyError extends Error {
  constructor(readonly issue: MermaidPolicyIssue) {
    super(`Mermaid source rejected: ${issue}`);
  }
}

const limit = 500;
const types: Record<string, { readonly type: StableMermaidType; readonly ids: readonly string[] }> = {
  flowchart: { type: 'flowchart', ids: ['flowchart', 'flowchart-v2'] },
  graph: { type: 'flowchart', ids: ['flowchart', 'flowchart-v2'] },
  'flowchart-elk': { type: 'flowchart-elk', ids: ['flowchart-elk'] },
  sequenceDiagram: { type: 'sequence', ids: ['sequence'] },
  classDiagram: { type: 'class', ids: ['classDiagram'] },
  'stateDiagram-v2': { type: 'state', ids: ['stateDiagram'] },
  stateDiagram: { type: 'state', ids: ['stateDiagram'] },
  erDiagram: { type: 'er', ids: ['er'] },
  gantt: { type: 'gantt', ids: ['gantt'] },
  journey: { type: 'journey', ids: ['journey'] },
  pie: { type: 'pie', ids: ['pie'] },
  quadrantChart: { type: 'quadrant', ids: ['quadrantChart'] },
  requirementDiagram: { type: 'requirement', ids: ['requirement'] },
  xychart: { type: 'xy', ids: ['xychart'] },
  block: { type: 'block', ids: ['block'] },
  packet: { type: 'packet', ids: ['packet'] },
  kanban: { type: 'kanban', ids: ['kanban'] },
  eventmodeling: { type: 'eventmodeling', ids: ['eventmodeling'] },
};

// Only skip whole leading comments; do not strip comments from labels or other input.
const entry = (source: string): string => {
  let remainder = source.trimStart();
  while (remainder.startsWith('%%') && !remainder.startsWith('%%{')) {
    const newline = remainder.indexOf('\n');
    if (newline < 0) return '';
    remainder = remainder.slice(newline + 1).trimStart();
  }
  return /^([^\s;]+)/.exec(remainder)?.[1] ?? '';
};

export const identifyMermaidType = (source: string, engine: Pick<typeof mermaid, 'detectType'>): StableMermaidType => {
  const policy = Object.hasOwn(types, entry(source)) ? types[entry(source)] : undefined;
  if (!policy) throw new MermaidPolicyError('unsupported');
  let detected: string;
  try { detected = engine.detectType(source); } catch { throw new MermaidPolicyError('unsupported'); }
  if (!policy.ids.includes(detected)) throw new MermaidPolicyError('unsupported');
  return policy.type;
};

export const matchesMermaidType = (type: StableMermaidType, diagramType: string): boolean =>
  Object.values(types).some((policy) => policy.type === type && policy.ids.includes(diagramType));

const invalidContract = (): never => { throw new Error('Unexpected Mermaid 12.2.0 diagram data'); };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalidContract();
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : invalidContract();
const map = (value: unknown): Map<unknown, unknown> => value instanceof Map ? value : invalidContract();
const getter = (db: Record<string, unknown>, name: string): unknown => {
  const fn = db[name];
  if (typeof fn !== 'function') return invalidContract();
  return fn.call(db) as unknown;
};
const budget = (count: number): void => {
  if (!Number.isSafeInteger(count) || count < 0) invalidContract();
  if (count > limit) throw new MermaidPolicyError('complexity');
};
const graphBudget = (db: Record<string, unknown>): void => {
  const data = record(getter(db, 'getData'));
  budget(array(data.nodes).length);
  budget(array(data.edges).length);
};

export const inspectMermaidDiagram = (type: StableMermaidType, parsed: { readonly type: string; readonly db: unknown }): void => {
  if (!matchesMermaidType(type, parsed.type)) throw new MermaidPolicyError('unsupported');
  const db = record(parsed.db);
  switch (type) {
    case 'flowchart': case 'flowchart-elk': {
      const vertices = map(getter(db, 'getVertices'));
      for (const vertex of vertices.values()) {
        const node = record(vertex);
        if (node.img || node.type === 'imageSquare') throw new MermaidPolicyError('image');
      }
      graphBudget(db);
      break;
    }
    case 'class': case 'state': case 'er': case 'requirement': graphBudget(db); break;
    case 'sequence': budget(map(getter(db, 'getActors')).size); budget(array(getter(db, 'getMessages')).length); break;
    case 'gantt': case 'journey': {
      // Journey's getter appends derived tasks; it must only be invoked once.
      const tasks = array(getter(db, 'getTasks'));
      budget(tasks.length);
      budget(array(getter(db, 'getSections')).length);
      if (type === 'journey') budget(array(getter(db, 'getActors')).length);
      break;
    }
    case 'pie': budget(map(getter(db, 'getSections')).size); break;
    case 'quadrant': budget(array(record(getter(db, 'getQuadrantData')).points).length); break;
    case 'xy': {
      const data = record(getter(db, 'getXYChartData'));
      const plots = array(data.plots);
      budget(plots.length);
      budget(plots.reduce<number>((total, plot) => total + array(record(plot).data).length, 0));
      let categories = 0;
      for (const axis of [record(data.xAxis), record(data.yAxis)]) {
        if (axis.type === 'band') categories += array(axis.categories).length;
        else if (axis.type !== 'linear') invalidContract();
      }
      budget(categories);
      break;
    }
    case 'block': {
      const blocks = array(getter(db, 'getBlocksFlat')).map(record);
      if (!blocks.some((block) => block.id === 'root')) invalidContract();
      // The flat DB includes a synthetic root, space templates and unrendered
      // style placeholders. The renderer traverses getBlocks() instead.
      for (const node of blocks) {
        if (node.img || node.type === 'imageSquare') throw new MermaidPolicyError('image');
      }
      const visited = new Set<Record<string, unknown>>();
      const pending = [...array(getter(db, 'getBlocks'))];
      while (pending.length > 0) {
        const node = record(pending.pop());
        if (visited.has(node)) continue;
        visited.add(node);
        budget(visited.size);
        if (node.children !== undefined) pending.push(...array(node.children));
      }
      budget(array(getter(db, 'getEdges')).length);
      break;
    }
    case 'packet': {
      const rows = array(getter(db, 'getPacket'));
      budget(rows.length);
      budget(rows.reduce<number>((total, row) => total + array(row).length, 0));
      break;
    }
    case 'kanban': budget(array(record(getter(db, 'getData')).nodes).length); break;
    case 'eventmodeling': {
      const state = record(getter(db, 'getState'));
      budget(array(state.boxes).length);
      budget(Object.keys(record(state.swimlanes)).length);
      budget(array(state.relations).length);
      break;
    }
  }
};

interface BlockLexer {
  setInput(input: string, yy: unknown): void;
  lex(): string | number;
  yytext: string | number;
}
interface BlockParser { lexer: BlockLexer; symbols_: Record<string, number> }

// These transformations mirror the pinned SDK's preprocessDiagram after the
// caller has rejected directives and frontmatter. Its lexer distinguishes
// structural tokens from the same words inside strings and comments.
const blockInput = (source: string): string => source.replace(/\r\n?/g, '\n')
  .replace(/<(\w+)([^>]*)>/g, (_match, tag: string, attributes: string) => `<${tag}${attributes.replace(/="([^"]*)"/g, "='$1'")}>`)
  .replace(/^\s*%%(?!{)[^\n]+\n?/gm, '').trimStart()
  .replace(/style.*:\S*#.*;/g, (text) => text.slice(0, -1))
  .replace(/classDef.*:\S*#.*;/g, (text) => text.slice(0, -1))
  .replace(/#\w+;/g, (text) => {
    const value = text.slice(1, -1);
    return /^\+?\d+$/.test(value) ? `ﬂ°°${value}¶ß` : `ﬂ°${value}¶ß`;
  }) + '\n';

export const preflightBlock = async (source: string, engine: Pick<typeof mermaid, 'mermaidAPI'>): Promise<void> => {
  const seed = await engine.mermaidAPI.getDiagramFromText('block\nA');
  if (seed.type !== 'block') invalidContract();
  const parser = seed.getParser() as unknown as BlockParser;
  if (!parser || !parser.lexer || !parser.symbols_ || typeof parser.lexer.setInput !== 'function' || typeof parser.lexer.lex !== 'function') invalidContract();
  const symbols = parser.symbols_;
  if (['SPACE_BLOCK', 'SIZE', 'COLUMNS', 'EOF'].some((key) => !Number.isSafeInteger(symbols[key]))) invalidContract();
  const lexer = Object.create(parser.lexer) as BlockLexer;
  lexer.setInput(blockInput(source), seed.db);
  let spaces = 0;
  for (;;) {
    const token = lexer.lex();
    if (token === symbols.EOF || token === 1) break;
    if (token !== symbols.SPACE_BLOCK && token !== symbols.SIZE && token !== symbols.COLUMNS) continue;
    if (token === symbols.COLUMNS && lexer.yytext === -1) continue;
    const text = String(lexer.yytext);
    if (!/^\d+$/.test(text)) invalidContract();
    const number = Number(text);
    if (!Number.isSafeInteger(number) || number > limit || (token === symbols.COLUMNS && number < 1)) throw new MermaidPolicyError('complexity');
    if (token === symbols.SPACE_BLOCK) { spaces += number; if (spaces > limit) throw new MermaidPolicyError('complexity'); }
  }
};
