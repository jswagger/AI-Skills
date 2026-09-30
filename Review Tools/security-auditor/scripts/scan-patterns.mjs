#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createFileFilters } from '../../review-tools-common/file-filters.mjs';

const configPath = new URL('../config.json', import.meta.url);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const { isExcluded, isTestFile } = createFileFilters(config.scan);

const input = await new Promise((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', reject);
});

const rules = [
  {
    id: 'CRIT-101',
    description: 'Dynamic string construction near a query, command, or HTML sink',
    pattern: /\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE|ORDER\s+BY|EXEC(?:UTE)?)\b.*(?:\$\{|\+\s*[\w$]|\.format\s*\()|(?:exec|spawn|innerHTML|outerHTML)\s*\(.*(?:\$\{|\+\s*[\w$])/i,
  },
  {
    id: 'CRIT-102',
    description: 'Possible blacklist-style input filtering',
    pattern: /\.(?:replace|replaceAll)\s*\(\s*(?:(['"`])(?:\\.|(?!\1)[^\\])*?(?:<|>|&|(?!\1)["']|\\["']|\\x3[cCeE]|\\x26|\\x22|\\x27)(?:\\.|(?!\1)[^\\])*?\1|\/(?:\\.|[^/\n])*?(?:<|>|&|"|'|\\x3[cCeE]|\\x26|\\x22|\\x27)(?:\\.|[^/\n])*?\/[gimsuy]*)/,
  },
  {
    id: 'CRIT-201',
    description: 'Possible hard-coded credential or secret assignment',
    pattern: /(?:^|[^A-Za-z])(?:api[_-]?key|secret|password|passwd|token|credential|private[_-]?key|jwt[_-]?secret)\b\s*[:=]\s*(['"`])[^\s]+/i,
    redact: true,
  },
  {
    id: 'CRIT-202',
    description: 'Predictable random source near a security-sensitive identifier',
    pattern: /(?=.*\b(?:token|secret|session|auth|nonce|key|password|credential|id)\b)(?=.*\b(?:Math\.random|random\.random|rand\s*\())/i,
    stackSensitive: true,
  },
  {
    id: 'CRIT-203',
    description: 'Possible unauthenticated CBC encryption usage',
    pattern: /\b(?:aes[-_]?\d+-cbc|createCipheriv\s*\(\s*['"`]aes-\d+-cbc)/i,
    stackSensitive: true,
  },
  {
    id: 'CRIT-301',
    description: 'Possible empty catch block or swallowed exception',
    pattern: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}|\bexcept\s+Exception\s*:\s*pass\b/,
  },
  {
    id: 'CRIT-302',
    description: 'Raw exception detail may be returned or rendered to users',
    pattern: /\b(?:error|err|exception)\.(?:stack|message)\b.*(?:res\.|response|return|render|send|json|toast|innerHTML)|(?:res\.|response|return|render|send|json|toast|innerHTML).*\b(?:error|err|exception)\.(?:stack|message)\b/i,
  },
  {
    id: 'CRIT-303',
    description: 'Possible logging of request or sensitive data',
    pattern: /\b(?:console\.(?:log|info|debug)|logger\.(?:info|debug|warn)|log\.(?:info|debug))\s*\(.*(?:req(?:uest)?\.body|password|passwd|token|credit.?card|user(?:Object)?|payload)/i,
  },
  {
    id: 'ARCH-403',
    description: 'Possible wildcard or administrator-level permission',
    pattern: /\b(?:role|permission|scope|policy|grant)\b.{0,80}(?:['"`]\*['"`]|\b(?:db_owner|root|administrator|admin)\b)|(?:['"`]\*['"`]|\b(?:db_owner|root|administrator|admin)\b).{0,80}\b(?:role|permission|scope|policy|grant)\b/i,
    stackSensitive: true,
  },
  {
    id: 'ARCH-404',
    description: 'Possible fail-open authorization or validation path',
    pattern: /(?:auth|authori[sz]|validat).*(?:failed|error|timeout).*(?:proceed|continue|allow|permit)|(?:proceed|continue|allow|permit).*(?:auth|authori[sz]|validat).*(?:failed|error|timeout)/i,
  },
];

let report;
try {
  report = JSON.parse(input);
  if (!report || !Array.isArray(report.files)) {
    throw new Error('Expected a JSON object with a files array.');
  }
} catch (error) {
  process.stderr.write(`Invalid diff JSON: ${error.message}\n`);
  process.exit(1);
}

const candidates = [];
for (const file of report.files) {
  if (isExcluded(file.path)) continue;
  const testFile = isTestFile(file.path);
  if (testFile && config.scan?.testFiles?.mode === 'skip') continue;
  for (const change of file.changes ?? []) {
    if (change.side !== 'added') continue;
    for (const rule of rules) {
      if (!rule.pattern.test(change.text)) continue;
      candidates.push({
        ruleId: rule.id,
        path: file.path,
        line: change.line,
        description: rule.description,
        evidence: rule.redact ? '[possible secret value omitted]' : change.text.trim().slice(0, 240),
        ...(testFile && config.scan?.testFiles?.mode === 'lower-confidence'
          ? { confidence: 'lower' }
          : {}),
        ...(config.scan?.projectStack === 'frontend' && rule.stackSensitive
          ? { reviewPriority: 'lower' }
          : {}),
      });
    }
  }
}

process.stdout.write(`${JSON.stringify({
  candidates,
  skipped: report.skipped ?? [],
  note: 'Heuristic candidates only; verify context and mitigations before reporting.',
}, null, 2)}\n`);