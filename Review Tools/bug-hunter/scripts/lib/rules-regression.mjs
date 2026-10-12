// Regression rules: signals derived from what a diff removed or changed, not from generic patterns.
// Each rule receives one non-trivial hunk and returns findings (without file/path, added by the caller).

import { anchorLine, groupHunks, isCommentLine, isWholeDeclarationRemoval } from './hunks.mjs';

const GUARD = {
  javascript: /(?:[=!]==?\s*(?:null|undefined)\b|\?\.|\?\?|\bif\s*\(\s*!\s*[\w$.]+\s*\)|\btypeof\s+[\w$.]+\s*[=!]==?)/g,
  python: /(?:\bis\s+(?:not\s+)?None\b|\bif\s+not\s+[\w.]+\s*:|\bisinstance\s*\()/g,
  csharp: /(?:[=!]=\s*null\b|\bis\s+(?:not\s+)?null\b|\?\.|\?\?|ArgumentNullException|\bstring\.IsNullOrEmpty\b)/g,
};
GUARD.typescript = GUARD.javascript;

const AWAIT = /\bawait\b/g;
const ERROR_HANDLING = {
  javascript: /(?:\btry\s*\{|\bcatch\s*(?:\(|\{)|\.catch\s*\(|\bfinally\s*\{)/g,
  python: /(?:^\s*try\s*:|^\s*except\b|^\s*finally\s*:)/g,
  csharp: /(?:\btry\s*\{?\s*$|\bcatch\s*(?:\(|\{|$)|\bfinally\s*\{?\s*$)/g,
};
ERROR_HANDLING.typescript = ERROR_HANDLING.javascript;
const ASSERTION = /(?:\bexpect\s*\(|\bassert\w*\s*[.(]|\bAssert\.|\.should\b|\bself\.assert\w+\s*\(|\bverify\w*\s*\()/g;
const CLEANUP_COMMON = String.raw`\bremoveEventListener\b|\bclearInterval\b|\bclearTimeout\b|\bunsubscribe\b|\.off\s*\(|\.dispose\s*\(|\.disconnect\s*\(|\.abort\s*\(|\.cancel\s*\(|\.release\s*\(|\.terminate\s*\(|\.close\s*\(`;
const CLEANUP_EXTRA = {
  csharp: String.raw`\bDispose(?:Async)?\s*\(|\busing\s*\(|\busing\s+var\b|-=\s*\w+`,
  python: String.raw`^\s*with\s+.+:\s*$`,
};
const cleanupPattern = (language) => new RegExp([CLEANUP_COMMON, CLEANUP_EXTRA[language]].filter(Boolean).join('|'), 'gi');
const CLEANUP = Object.fromEntries(['javascript', 'typescript', 'csharp', 'python'].map((language) => [language, cleanupPattern(language)]));
const SETUP = /(?:\baddEventListener\b|\bsetInterval\b|\bsetTimeout\b|\bsubscribe\b|\.on\s*\(|\+=\s*\w+|\bnew\s+\w*(?:Stream|Connection|Client|Timer|Observer|Listener)\b)/i;
const EARLY_EXIT = /(?:\b(?:if|elif|unless)\b.*\b(?:return|throw|raise|continue|break)\b|^\s*(?:return|throw|raise|continue|break)\b)/g;
const TEST_DISABLED = /(?:\b(?:it|test|describe)\.(?:skip|only)\b|\bx(?:it|describe)\s*\(|\bf(?:it|describe)\s*\(|@pytest\.mark\.skip|@unittest\.skip|\[\s*Ignore\b|\[\s*(?:Fact|Theory)\s*\(\s*Skip\s*=|\bpytest\.skip\s*\()/;

const countMatches = (lines, pattern) => lines.reduce((sum, line) => {
  if (isCommentLine(line.text)) return sum;
  return sum + (line.text.match(pattern)?.length ?? 0);
}, 0);

/** Removed lines holding a match, limited to how many more matches were removed than added. */
function netRemovedMatches(hunk, pattern) {
  const surplus = countMatches(hunk.removed, pattern) - countMatches(hunk.added, pattern);
  if (surplus <= 0) return [];
  return hunk.removed.filter((line) => !isCommentLine(line.text) && line.text.match(pattern)).slice(0, surplus);
}

function removedFinding(hunk, removedLine, rule, severity, message) {
  const anchor = anchorLine(hunk);
  return {
    rule,
    severity,
    confidence: 'high',
    line: anchor.line,
    side: anchor.side,
    removedLine: removedLine.line,
    snippet: `- ${removedLine.text.trim()}`,
    message,
  };
}

function removedGuard(hunk, language) {
  const pattern = GUARD[language];
  if (!pattern) return [];
  return netRemovedMatches(hunk, pattern).map((line) => removedFinding(hunk, line, 'REMOVED_GUARD', 'MEDIUM',
    'A null/undefined/type guard was removed without an equivalent being added in the same change. Confirm the value can no longer be missing.'));
}

const normalizeCode = (text) => text.replace(/\s+/g, '');

function guardAndExit(text) {
  const match = text.match(/\bif\s*\((.*?)\)\s*\{?\s*(return|throw)\b([^;{}]*);?/);
  if (!match) return undefined;
  return { condition: match[1], effect: `${match[2]}${match[3]}` };
}

function addedFunctions(changes) {
  const lines = changes.filter((line) => line.side === 'added');
  const functions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].text.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)|^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{|^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(\w+)\s*=>\s*\{/);
    if (!header) continue;
    const name = header[1] ?? header[3] ?? header[5];
    const params = (header[2] ?? header[4] ?? header[6]).split(',').map((param) => param.trim().split(/[:=]/)[0].trim()).filter(Boolean);
    const body = [];
    let depth = 0;
    let started = false;
    for (let bodyIndex = index; bodyIndex < lines.length; bodyIndex += 1) {
      const line = lines[bodyIndex];
      body.push(line);
      const code = line.text.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '');
      const delta = (code.match(/\{/g)?.length ?? 0) - (code.match(/\}/g)?.length ?? 0);
      depth += delta;
      started ||= delta > 0;
      if (started && depth === 0) break;
    }
    if (started && depth === 0) functions.push({ name, params, body });
  }
  return functions;
}

function blockEndIndex(lines, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    const code = lines[index].text.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '');
    depth += (code.match(/\{/g)?.length ?? 0) - (code.match(/\}/g)?.length ?? 0);
    if (index > startIndex && depth <= 0) return index;
  }
  return lines.length - 1;
}

function guardMovedToAddedHelper(hunk, removedLine, fileChanges) {
  const oldGuard = guardAndExit(removedLine.text);
  if (!oldGuard) return false;
  const helpers = addedFunctions(fileChanges);
  for (const callLine of hunk.added) {
    for (const helper of helpers) {
      const returnedCall = new RegExp(`\\breturn\\s+(?:await\\s+)?${helper.name}\\s*\\(([^)]*)\\)`);
      const call = callLine.text.match(returnedCall);
      if (!call) continue;
      const args = call[1].split(',').map((arg) => arg.trim());
      const substitutions = new Map(helper.params.map((param, index) => [param, args[index] ?? '']));
      for (let guardIndex = 0; guardIndex < helper.body.length; guardIndex += 1) {
        const helperGuard = guardAndExit(helper.body[guardIndex].text);
        if (!helperGuard || normalizeCode(helperGuard.effect) !== normalizeCode(oldGuard.effect)) continue;
        const mappedCondition = helperGuard.condition.replace(/\b[A-Za-z_$][\w$]*\b/g, (token) => substitutions.get(token) ?? token);
        if (normalizeCode(mappedCondition) !== normalizeCode(oldGuard.condition)) continue;
        const guardedParams = helper.params.filter((param) => new RegExp(`\\b${param}\\b`).test(helperGuard.condition));
        const guardedWork = helper.body.slice(guardIndex + 1).some(({ text }) => {
          const returnedValue = text.match(/^\s*return\s+(.+?);?\s*$/)?.[1];
          return returnedValue && guardedParams.some((param) => new RegExp(`\\b${param}\\b`).test(returnedValue));
        });
        if (guardedWork) return true;
      }
    }
  }
  return false;
}

function missingStateReleases(changes) {
  const added = changes.filter((line) => line.side === 'added');
  const transitions = added.flatMap((line) => {
    const match = line.text.match(/\b([A-Za-z_$][\w$]*(?:Loading|loading))\s*\(\s*(true|false)\s*\)/i);
    return match ? [{ line, setter: match[1], value: match[2].toLowerCase() }] : [];
  });
  const functions = addedFunctions(changes);
  const scopeFor = (line) => functions.find((fn) => fn.body.some((entry) => entry.line === line.line))?.body
    ?? groupHunks(changes).find((hunk) => hunk.added.some((entry) => entry.line === line.line))?.added
    ?? [line];
  const findings = [];
  for (const acquire of transitions.filter((transition) => transition.value === 'true')) {
    const scope = scopeFor(acquire.line);
    const acquireIndex = scope.findIndex((line) => line.line === acquire.line.line);
    const releases = transitions.filter((transition) => transition.value === 'false'
      && transition.setter === acquire.setter
      && scope.some((line) => line.line === transition.line.line));
    const releaseIndexes = releases.map((release) => scope.findIndex((line) => line.line === release.line.line)).filter((index) => index > acquireIndex);
    const finallyIndex = scope.findIndex((line, index) => index > acquireIndex && /\bfinally\s*\{?/.test(line.text));
    const finallyRelease = finallyIndex >= 0 && releaseIndexes.some((index) => index > finallyIndex);
    const tryIndex = scope.findIndex((line, index) => index > acquireIndex && /\btry\s*\{?/.test(line.text));
    const catchIndex = scope.findIndex((line, index) => index > acquireIndex && /\bcatch\s*\(/.test(line.text));
    let pathsCovered = false;
    if (catchIndex >= 0 && tryIndex >= 0) {
      const catchEnd = blockEndIndex(scope, catchIndex);
      const tryReleases = releaseIndexes.filter((index) => index > tryIndex && index < catchIndex);
      const catchReleases = releaseIndexes.filter((index) => index > catchIndex && index < catchEnd);
      const afterCatchRelease = releaseIndexes.filter((index) => index > catchEnd);
      const tryEarlyReturn = scope.slice(tryIndex + 1, catchIndex).some((line) => /\breturn\b/.test(line.text));
      const catchEarlyExit = scope.slice(catchIndex + 1, catchEnd).some((line) => /\b(?:return|throw)\b/.test(line.text));
      const tryCovered = tryReleases.some((index) => !scope.slice(tryIndex + 1, index).some((line) => /\breturn\b/.test(line.text)))
        || (afterCatchRelease.length > 0 && !tryEarlyReturn);
      const catchCovered = catchReleases.some((index) => !scope.slice(catchIndex + 1, index).some((line) => /\b(?:return|throw)\b/.test(line.text)))
        || (afterCatchRelease.length > 0 && !catchEarlyExit);
      pathsCovered = tryCovered && catchCovered;
    } else {
      const releaseIndex = releaseIndexes[0];
      pathsCovered = releaseIndex !== undefined && !scope.slice(acquireIndex + 1, releaseIndex)
        .some((line) => /\b(?:return|throw)\b/.test(line.text));
    }
    if (finallyRelease || pathsCovered) continue;
    findings.push({
      rule: 'MISSING_RELEASE',
      severity: 'MEDIUM',
      confidence: 'high',
      line: acquire.line.line,
      side: 'added',
      snippet: `+ ${acquire.line.text.trim()}`,
      message: `Loading state is set to true without a matching ${acquire.setter}(false) on every visible completion path.`,
    });
  }
  return findings;
}

function removedAwait(hunk) {
  return netRemovedMatches(hunk, AWAIT).map((line) => removedFinding(hunk, line, 'REMOVED_AWAIT', 'MEDIUM',
    'An await was removed. The call may now run unawaited, return a promise/task instead of a value, or finish after its caller continues.'));
}

function removedErrorHandling(hunk, language) {
  const pattern = ERROR_HANDLING[language];
  if (!pattern) return [];
  return netRemovedMatches(hunk, pattern).map((line) => removedFinding(hunk, line, 'REMOVED_ERROR_HANDLING', 'MEDIUM',
    'Error handling (try/catch/except/finally) was removed. Failures that used to be handled or cleaned up may now propagate or leak resources.'));
}

function removedTestAssertion(hunk, isTest) {
  if (!isTest) return [];
  return netRemovedMatches(hunk, ASSERTION).map((line) => removedFinding(hunk, line, 'REMOVED_TEST_ASSERTION', 'MEDIUM',
    'A test assertion was removed or weakened, so the behavior it protected is no longer verified.'));
}

function testDisabled(hunk, isTest) {
  if (!isTest) return [];
  return hunk.added.filter((line) => TEST_DISABLED.test(line.text)).map((line) => ({
    rule: 'TEST_DISABLED',
    severity: 'MEDIUM',
    confidence: 'high',
    line: line.line,
    side: 'added',
    snippet: `+ ${line.text.trim()}`,
    message: 'A test was skipped, focused (.only), or ignored, which can hide regressions.',
  }));
}

function removedCleanup(hunk, language) {
  const pattern = CLEANUP[language];
  // Removing the setup together with its cleanup is a deliberate feature removal, not a leak.
  if (!pattern || hunk.removed.some((line) => SETUP.test(line.text))) return [];
  return netRemovedMatches(hunk, pattern).map((line) => removedFinding(hunk, line, 'REMOVED_CLEANUP', 'MEDIUM',
    'Cleanup was removed (unsubscribe, dispose, close, cancel, or a using/with scope). Check for leaked listeners, timers, connections, or handles.'));
}

function removedEarlyExit(hunk) {
  return netRemovedMatches(hunk, EARLY_EXIT).map((line) => ({
    ...removedFinding(hunk, line, 'REMOVED_EARLY_EXIT', 'LOW',
      'A return/throw/raise/continue/break was removed, so execution may now fall through to code that used to be skipped.'),
    confidence: 'low',
  }));
}

// --- BEHAVIOR_CHANGE_PAIR ---------------------------------------------------------------------

const TOKEN = /(===|!==|==|!=|<=|>=|&&|\|\||\?\?|=>|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\S)/g;
const COMPARISON = new Set(['<', '>', '<=', '>=', '==', '===', '!=', '!==']);
const LOGICAL = new Set(['&&', '||', 'and', 'or']);
const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
const BOOLEAN = new Set(['true', 'false', 'True', 'False']);
const NEGATION = new Set(['!', 'not']);
const NUMBER = /^\d+(?:\.\d+)?$/;

function tokenClass(token) {
  if (COMPARISON.has(token)) return 'comparison';
  if (LOGICAL.has(token)) return 'logical';
  if (ARITHMETIC.has(token)) return 'arithmetic';
  if (BOOLEAN.has(token)) return 'boolean';
  if (NUMBER.test(token)) return 'number';
  return undefined;
}

const tokenize = (text) => text.match(TOKEN) ?? [];

function describeChange(removedText, addedText) {
  const before = tokenize(removedText);
  const after = tokenize(addedText);

  if (before.length === after.length) {
    const diffs = before.map((token, index) => [token, after[index]]).filter(([a, b]) => a !== b);
    if (diffs.length !== 1) return undefined;
    const [from, to] = diffs[0];
    const kind = tokenClass(from);
    if (!kind || kind !== tokenClass(to)) return undefined;
    return `${kind} changed from \`${from}\` to \`${to}\``;
  }

  const [longer, shorter, direction] = after.length === before.length + 1 ? [after, before, 'added'] : [before, after, 'removed'];
  if (Math.abs(after.length - before.length) !== 1) return undefined;
  const extraIndex = longer.findIndex((token, index) => token !== shorter[index]);
  const extra = longer[extraIndex === -1 ? longer.length - 1 : extraIndex];
  if (!NEGATION.has(extra)) return undefined;
  const rest = longer.filter((_, index) => index !== (extraIndex === -1 ? longer.length - 1 : extraIndex));
  return rest.join(' ') === shorter.join(' ') ? `negation \`${extra}\` ${direction}` : undefined;
}

const VERSION_LINE = /\b(?:version|copyright|year)\b/i;

function behaviorChangePairs(hunk) {
  if (hunk.removed.length === 0 || hunk.removed.length !== hunk.added.length) return [];
  const findings = [];
  hunk.removed.forEach((removed, index) => {
    const added = hunk.added[index];
    if (isCommentLine(removed.text) || isCommentLine(added.text) || VERSION_LINE.test(added.text)) return;
    const change = describeChange(removed.text, added.text);
    if (!change) return;
    findings.push({
      rule: 'BEHAVIOR_CHANGE_PAIR',
      severity: 'MEDIUM',
      confidence: 'high',
      line: added.line,
      side: 'added',
      removedLine: removed.line,
      snippet: `- ${removed.text.trim()}\n+ ${added.text.trim()}`,
      message: `One-token behavior change (${change}). Check boundary cases and every caller relying on the old behavior.`,
    });
  });
  return findings;
}

// --- SIGNATURE_CHANGED ------------------------------------------------------------------------
// Contract changes callers depend on: parameters, async-ness, return type, and removed/renamed
// exported declarations (functions, classes, types, enums).

const NOT_FUNCTIONS = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'return', 'function', 'new', 'await', 'else']);

const FUNCTION_PATTERNS = {
  javascript: [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(([^)]*)\)|(\w+))\s*(?::\s*[^=]+)?=>/,
    /^\s*(?:(?:public|private|protected|static|async|readonly|override)\s+)+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\{?\s*$/,
  ],
  python: [/^\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/],
  csharp: [/^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|abstract|partial|new)\s+)+[\w<>\[\],.?\s]+?\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/],
};
FUNCTION_PATTERNS.typescript = FUNCTION_PATTERNS.javascript;

const DECLARATION_PATTERNS = {
  javascript: [/^\s*export\s+(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum|const|let|var)\s+(\w+)/],
  python: [/^class\s+(\w+)/],
  csharp: [/^\s*(?:public|internal)\s+(?:(?:static|sealed|abstract|partial|readonly)\s+)*(?:class|interface|enum|struct|record)\s+(\w+)/],
};
DECLARATION_PATTERNS.typescript = DECLARATION_PATTERNS.javascript;

const EXPORTED = /^\s*(?:export\b|public\b|internal\b|protected\b|(?:async\s+)?def\s+(?!_)|class\s+(?!_))/;

const RETURN_TYPE = {
  javascript: /\)\s*:\s*([^{=;]+?)\s*(?:\{|=>|;|$)/,
  python: /->\s*([^:]+):/,
  csharp: /^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|abstract|partial|new)\s+)+([\w<>\[\],.?\s]+?)\s+\w+\s*(?:<[^>]*>)?\s*\(/,
};
RETURN_TYPE.typescript = RETURN_TYPE.javascript;

const squash = (text) => text.replace(/\s+/g, '');

export function parseSignature(text, language) {
  for (const pattern of FUNCTION_PATTERNS[language] ?? []) {
    const match = text.match(pattern);
    if (!match || NOT_FUNCTIONS.has(match[1])) continue;
    const params = squash(match[2] ?? match[3] ?? '');
    const returnType = squash(text.match(RETURN_TYPE[language])?.[1] ?? '');
    const isAsync = /\basync\b/.test(text);
    return {
      name: match[1],
      kind: 'function',
      params,
      returnType: returnType.replace(/^async/, ''),
      isAsync,
      exported: EXPORTED.test(text),
    };
  }
  for (const pattern of DECLARATION_PATTERNS[language] ?? []) {
    const match = text.match(pattern);
    if (match) return { name: match[1], kind: 'declaration', params: '', returnType: '', isAsync: false, exported: language === 'python' ? !match[1].startsWith('_') : EXPORTED.test(text) };
  }
  return undefined;
}

function describeSignatureChange(before, after) {
  const parts = [];
  if (before.params !== after.params) parts.push('parameters');
  if (before.isAsync !== after.isAsync) parts.push(after.isAsync ? 'now async' : 'no longer async');
  if (before.returnType !== after.returnType) parts.push('return type');
  return parts;
}

function signatureChanges(hunk, language) {
  const removedSignatures = hunk.removed
    .map((line) => ({ line, signature: parseSignature(line.text, language) }))
    .filter((entry) => entry.signature);
  if (removedSignatures.length === 0) return [];
  const addedByName = new Map();
  for (const line of hunk.added) {
    const signature = parseSignature(line.text, language);
    if (signature) addedByName.set(signature.name, { line, signature });
  }

  const findings = [];
  for (const { line, signature } of removedSignatures) {
    const replacement = addedByName.get(signature.name);
    const changes = replacement ? describeSignatureChange(signature, replacement.signature) : [];
    if (replacement && changes.length === 0) continue;
    if (!replacement && !signature.exported) continue;
    const contractBreaking = changes.some((change) => change !== 'parameters');
    findings.push({
      rule: 'SIGNATURE_CHANGED',
      severity: contractBreaking ? 'MEDIUM' : 'LOW',
      confidence: 'low',
      line: replacement ? replacement.line.line : line.line,
      side: replacement ? 'added' : 'removed',
      symbol: signature.name,
      snippet: replacement ? `- ${line.text.trim()}\n+ ${replacement.line.text.trim()}` : `- ${line.text.trim()}`,
      message: replacement
        ? `Contract of \`${signature.name}\` changed (${changes.join(', ')}). Callers outside this diff may still rely on the old contract.`
        : `Exported \`${signature.name}\` was removed or renamed. Callers outside this diff may still reference it.`,
    });
  }
  return findings;
}

/** All regression rules for one non-trivial hunk. */
export function analyzeHunk(hunk, { language, isTest, fileChanges = [] }) {
  if (isWholeDeclarationRemoval(hunk)) return signatureChanges(hunk, language);
  const pairs = behaviorChangePairs(hunk);
  const pairedRemovedLines = new Set(pairs.map((finding) => finding.removedLine));
  // A pair finding is more specific than a guard/await/handler removal on the same line.
  const unpaired = (finding) => !pairedRemovedLines.has(finding.removedLine);
  const specific = [
    ...removedGuard(hunk, language).filter((finding) => {
      const removedLine = hunk.removed.find((line) => line.line === finding.removedLine);
      return !removedLine || !guardMovedToAddedHelper(hunk, removedLine, fileChanges);
    }),
    ...removedAwait(hunk),
    ...removedErrorHandling(hunk, language),
    ...removedCleanup(hunk, language),
  ].filter(unpaired);
  // The early-exit hint is the broadest rule, so it only reports lines no other rule claimed.
  const claimedLines = new Set([...pairedRemovedLines, ...specific.map((finding) => finding.removedLine)]);
  const earlyExits = removedEarlyExit(hunk).filter((finding) => !claimedLines.has(finding.removedLine));
  return [
    ...specific,
    ...removedTestAssertion(hunk, isTest),
    ...testDisabled(hunk, isTest),
    ...pairs,
    ...earlyExits,
    ...signatureChanges(hunk, language),
  ];
}

/** Change-level JS/TS checks that need completion paths spanning multiple hunks. */
export function analyzeFileChanges(changes, { language }) {
  if (!['javascript', 'typescript'].includes(language)) return [];
  return missingStateReleases(changes);
}
