// Finds long JavaScript/TypeScript functions that this diff changed.
// Heuristic: it reads source text, not a syntax tree, so unusual formatting can be missed.

const MAX_SIGNATURE_LINES = 8;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const NOT_METHOD_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function']);

const DECLARATION = new RegExp(
  String.raw`\bfunction\s*\*?\s*([$\w]+)?\s*\(`
  + String.raw`|\b(?:const|let|var)\s+([$\w]+)\s*(?::[^=]+)?=\s*(?<signature>(?:async\s*)?`
  + String.raw`(?:function\b|(?:\([^)]*\)|[$\w]+)\s*(?::[^=]+)?=>))`,
  'd',
);
// A named arrow that is not a declaration: a class field (`save = () => {`) or object property (`save: () => {`).
const NAMED_ARROW = new RegExp(
  String.raw`^\s*(?:(?:public|private|protected|static|readonly)\s+)*([$\w]+)\s*(?:(?::[^=]+)?=|:)\s*`
  + String.raw`(?<arrow>(?:async\s*)?(?:\([^)]*\)|[$\w]+)\s*(?::[^=]+)?=>)`,
  'd',
);
const METHOD = /^\s*(?:(?:public|private|protected|static|async|get|set)\s+)*([$\w]+)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/;

/**
 * Visits each code character, skipping strings and comments.
 * Stops and returns the first truthy value the visitor returns.
 */
function walkCode(lines, start, visit) {
  let quote = null;
  let inBlockComment = false;
  for (let line = start.line; line < lines.length; line += 1) {
    const text = lines[line];
    if (quote && quote !== '`') quote = null;
    for (let col = line === start.line ? start.col : 0; col < text.length; col += 1) {
      const char = text[col];
      const next = text[col + 1];
      if (inBlockComment) {
        if (char === '*' && next === '/') { inBlockComment = false; col += 1; }
        continue;
      }
      if (quote) {
        if (char === '\\') col += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '/' && next === '/') break;
      if (char === '/' && next === '*') { inBlockComment = true; col += 1; continue; }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
      const result = visit(char, next, line, col);
      if (result) return result;
    }
  }
  return null;
}

/** Finds the `{` that opens a function body, or null for expression-bodied arrows. */
function findBodyStart(lines, start) {
  let parens = 0;
  let afterArrow = false;
  let skippedArrowHead = false;
  const result = walkCode(lines, start, (char, next, line, col) => {
    if (line > start.line + MAX_SIGNATURE_LINES) return { open: null };
    if (afterArrow) {
      if (char === '>' && !skippedArrowHead) { skippedArrowHead = true; return null; }
      if (/\s/.test(char)) return null;
      return { open: char === '{' ? { line, col } : null };
    }
    if (char === '(') parens += 1;
    else if (char === ')') parens -= 1;
    else if (parens === 0 && char === '=' && next === '>') afterArrow = true;
    else if (parens === 0 && char === '{') return { open: { line, col } };
    else if (parens === 0 && char === ';') return { open: null };
    return null;
  });
  return result?.open ?? null;
}

/** Returns the zero-based line of the `}` that closes the block opened at `open`. */
function findBlockEnd(lines, open) {
  let depth = 0;
  const result = walkCode(lines, open, (char, _next, line) => {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    return char === '}' && depth === 0 ? { line } : null;
  });
  return result?.line ?? null;
}

function countBodyLines(lines, open, endLine) {
  return lines
    .slice(open.line + 1, endLine)
    .filter((text) => text.trim() && !COMMENT_LINE.test(text))
    .length;
}

/** Locates a function starting on this line, or returns null. */
function matchFunctionStart(text, lineIndex) {
  const declaration = DECLARATION.exec(text);
  if (declaration) {
    const signatureStart = declaration.indices.groups.signature?.[0] ?? declaration.index;
    return { name: declaration[1] ?? declaration[2] ?? '<anonymous>', start: { line: lineIndex, col: signatureStart } };
  }
  const namedArrow = NAMED_ARROW.exec(text);
  if (namedArrow) {
    return { name: namedArrow[1], start: { line: lineIndex, col: namedArrow.indices.groups.arrow[0] } };
  }
  const method = METHOD.exec(text);
  if (!method || NOT_METHOD_NAMES.has(method[1])) return null;
  return { name: method[1], start: { line: lineIndex, col: text.lastIndexOf('{') } };
}

function changedWithin(addedLines, firstLine, lastLine) {
  return [...addedLines].some((line) => line >= firstLine && line <= lastLine);
}

/**
 * @param {string[]} lines      Source lines of the changed file.
 * @param {Set<number>} addedLines  One-based line numbers added in this diff.
 * @param {number} maxLines     Longest allowed body, in nonblank non-comment lines.
 * @returns {{ name: string, line: number, bodyLines: number, signature: string }[]}
 */
export function findLongJsFunctions(lines, addedLines, maxLines) {
  const found = [];
  lines.forEach((text, lineIndex) => {
    const match = matchFunctionStart(text, lineIndex);
    if (!match) return;
    const open = findBodyStart(lines, match.start);
    const endLine = open && findBlockEnd(lines, open);
    if (endLine === null || endLine === undefined) return;
    const bodyLines = countBodyLines(lines, open, endLine);
    if (bodyLines <= maxLines || !changedWithin(addedLines, lineIndex + 1, endLine + 1)) return;
    found.push({ name: match.name, line: lineIndex + 1, bodyLines, signature: text.trim() });
  });
  return found;
}
