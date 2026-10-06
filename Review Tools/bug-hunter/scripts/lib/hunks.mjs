// Groups the collector's flat `changes` list (unified=0) back into hunks and filters trivial ones.
//
// The collector drops hunk headers, so hunks are reconstructed: a hunk is a run of removed lines
// optionally followed by a run of added lines, and a gap in line numbers (or an added->removed
// transition) starts a new hunk. A pure deletion immediately followed by a pure addition elsewhere
// in the file is indistinguishable from a replacement; that is rare and only affects pairing.

export function groupHunks(changes) {
  const hunks = [];
  let current;
  let last;

  for (const change of changes) {
    const startsNew = !current
      || (change.side === 'removed' && last.side === 'added')
      || (change.side === last.side && change.line !== last.line + 1);
    if (startsNew) {
      current = { removed: [], added: [] };
      hunks.push(current);
    }
    current[change.side].push({ line: change.line, text: change.text });
    last = change;
  }
  return hunks;
}

const COMMENT_ONLY = /^\s*(?:\/\/|\/\*|\*\/?|#(?!\[)|<!--)/;
const IMPORT_ONLY = /^\s*(?:import\s|from\s+\S+\s+import\s|using\s+[\w.]+\s*;|using\s+static\s|(?:const|let|var)\s+\S+\s*=\s*require\()/;

export function isCommentLine(text) {
  return COMMENT_ONLY.test(text);
}

function isNoise(text) {
  return text.trim() === '' || COMMENT_ONLY.test(text) || IMPORT_ONLY.test(text);
}

const stripWhitespace = (text) => text.replace(/\s+/g, '');

/**
 * Trivial hunks carry no behavior change: only blank/comment/import lines, or a pure
 * whitespace/formatting rewrite of the same code.
 */
export function isTrivialHunk(hunk) {
  const all = [...hunk.removed, ...hunk.added];
  if (all.every((line) => isNoise(line.text))) return true;
  const removed = hunk.removed.map((line) => stripWhitespace(line.text)).join('');
  const added = hunk.added.map((line) => stripWhitespace(line.text)).join('');
  return removed === added;
}

const DECLARATION = /^\s*(?:(?:export|public|private|protected|internal|static|async|abstract|sealed|override|virtual|default)\s+)*(?:function\b|class\b|interface\b|def\s|async\s+def\s|(?:[\w<>\[\],.?]+\s+)+\w+\s*\([^)]*\)\s*\{?\s*$)/;

/** A deleted function or class body: expected to contain guards and handlers, so it is not a regression signal. */
export function isWholeDeclarationRemoval(hunk) {
  return hunk.added.length === 0 && hunk.removed.length >= 4 && hunk.removed.some((line) => DECLARATION.test(line.text));
}

export function anchorLine(hunk) {
  if (hunk.added.length > 0) return { line: hunk.added[0].line, side: 'added' };
  return { line: hunk.removed[0].line, side: 'removed' };
}
