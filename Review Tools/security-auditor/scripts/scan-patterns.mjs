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
    pattern: /\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE|ORDER\s+BY|EXEC(?:UTE)?)\b.*(?:\$\{|\+\s*[\w$]|\.format\s*\(|\{[^}]+\})|(?:exec|spawn|innerHTML|outerHTML)\s*\(.*(?:\$\{|\+\s*[\w$])/i,
  },
  {
    id: 'CRIT-102',
    description: 'Possible blacklist-style input filtering',
    pattern: /\.(?:replace|replaceAll)\s*\(\s*(?:(['"`])(?:\\.|(?!\1)[^\\])*?(?:<|>|&|(?!\1)["']|\\["']|\\x3[cCeE]|\\x26|\\x22|\\x27)(?:\\.|(?!\1)[^\\])*?\1|\/(?:\\.|[^/\n])*?(?:<|>|&|"|'|\\x3[cCeE]|\\x26|\\x22|\\x27)(?:\\.|[^/\n])*?\/[gimsuy]*)/,
  },
  {
    id: 'CRIT-201',
    description: 'Possible hard-coded credential or secret assignment',
    pattern: /(?:^|[^A-Za-z])(?:["']?(?:api[_-]?key|secret|password|passwd|token|credential|private[_-]?key|jwt[_-]?secret)["']?)\s*[:=]\s*(?:[^;\n]*?\bor\s*)?(["'`])[^\n"'`]+\1|\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?|ftp|sftp|https?):\/\/[^/\s:@]+:[^/\s@]+@/i,
    redact: true,
  },
  {
    id: 'CRIT-202',
    description: 'Predictable random source near a security-sensitive identifier',
    pattern: /(?=.*\b(?:token|secret|session|auth|nonce|key|password|credential|id)\b)(?=.*\b(?:Math\.random|random\.(?:random|choice)|uuid\.uuid1|rand\s*\())/i,
    stackSensitive: true,
  },
  {
    id: 'CRIT-203',
    description: 'Possible unauthenticated CBC encryption usage',
    pattern: /\b(?:aes[-_]?\d+-cbc|createCipheriv\s*\(\s*['"`]aes-\d+-cbc|modes\.CBC\s*\(|AES\.MODE_CBC\b|MODE_CBC\b)/i,
    stackSensitive: true,
  },
  {
    id: 'CRIT-301',
    description: 'Possible empty catch block or swallowed exception',
    pattern: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}|\bexcept(?:\s+[^:]+)?\s*:\s*pass\b/i,
  },
  {
    id: 'CRIT-302',
    description: 'Raw exception detail may be returned or rendered to users',
    pattern: /\b(?:error|err|exception)\.(?:stack|message)\b.*(?:res\.|response|return|render|send|json|toast|innerHTML)|(?:res\.|response|return|render|send|json|toast|innerHTML).*\b(?:error|err|exception)\.(?:stack|message)\b|(?:return|jsonify|HTTPException|detail\s*=)[^#\n]*(?:str|repr)\s*\(\s*(?:e|exc|err|exception)\b|(?:str|repr)\s*\(\s*(?:e|exc|err|exception)\b[^#\n]*(?:response|return|jsonify|HTTPException|detail\s*=)/i,
  },
  {
    id: 'CRIT-303',
    description: 'Possible logging of request or sensitive data',
    pattern: /\b(?:console\.(?:log|info|debug)|logging\.(?:debug|info|warning|warn|error|exception|critical)|(?:logger|log)\.(?:info|debug|warn|warning|error|exception|critical))\s*\(.*(?:req(?:uest)?\.(?:body|json|data)|password|passwd|token|credit.?card|user(?:Object)?|payload)/i,
  },
  {
    id: 'CRIT-104',
    description: 'Possible shell command execution with shell enabled or os.system',
    pattern: /\b(?:subprocess\.(?:run|Popen|call|check_call|check_output)|Popen)\s*\([^\n)]*\bshell\s*=\s*True\b|\bos\.system\s*\(/i,
  },
  {
    id: 'CRIT-105',
    description: 'Dynamic code evaluation with eval or exec',
    pattern: /\b(?:eval|exec)\s*\(/,
  },
  {
    id: 'CRIT-106',
    description: 'Potentially unsafe pickle or YAML deserialization',
    pattern: /\bpickle\.(?:load|loads)\s*\(|\byaml\.load\s*\(/i,
  },
  {
    id: 'CRIT-107',
    description: 'TLS certificate verification is disabled',
    pattern: /\bverify\s*=\s*False\b/i,
  },
  {
    id: 'ARCH-403',
    description: 'Possible wildcard or administrator-level permission',
    pattern: /\b(?:role|permission|scope|policy|grant|action|resource)\b.{0,80}(?:['"`]\*['"`]|\b(?:db_owner|root|administrator|admin)\b)|(?:['"`]\*['"`]|\b(?:db_owner|root|administrator|admin)\b).{0,80}\b(?:role|permission|scope|policy|grant|action|resource)\b/i,
    stackSensitive: true,
  },
  {
    id: 'ARCH-404',
    description: 'Possible fail-open authorization or validation path',
    pattern: /(?:auth|authori[sz]|validat).*(?:failed|error|timeout).*(?:proceed|continue|allow|permit)|(?:proceed|continue|allow|permit).*(?:auth|authori[sz]|validat).*(?:failed|error|timeout)/i,
  },
  {
    id: 'ARCH-405',
    description: 'Infrastructure rule may expose a service to all IPv4 or IPv6 addresses',
    pattern: /\b0\.0\.0\.0\/0\b|::\/0\b/,
  },
  {
    id: 'ARCH-406',
    description: 'Cloud resource or storage configuration may allow public access',
    pattern: /\bpublicly_accessible\s*[:=]\s*true\b|\bpublic[-_]read\b|\b(?:block_public_acls|block_public_policy|restrict_public_buckets)\s*[:=]\s*false\b/i,
  },
  {
    id: 'ARCH-407',
    description: 'Container or workload configuration may grant privileged execution',
    pattern: /\bprivileged\s*:\s*true\b|\ballowPrivilegeEscalation\s*:\s*true\b|\b(?:runAsUser|user)\s*:\s*0\b|^\s*USER\s+root\b/i,
  },
  {
    id: 'ARCH-408',
    description: 'Infrastructure configuration may disable encryption at rest',
    pattern: /\b(?:encrypt(?:ion)?_enabled|storage_encrypted|encrypted)\s*[:=]\s*(?:false|0)\b/i,
  },
];

const removedControlPattern = /\b(?:auth(?:entication|orization)?|authori[sz](?:e|ation)|validat(?:e|ion)|permission|sanitize|sanitise|escape|csrf|access[_\s-]?control|require[_\s-]?role)(?:\b|(?=[_-]))/i;
const infrastructurePathPattern = /(?:^|\/)(?:infra(?:structure)?|terraform|k8s|kubernetes|helm|deploy|\.github\/workflows)(?:\/|$)|(?:^|\/)(?:dockerfile|docker-compose(?:\.[^/]*)?)$|\.(?:tf|tfvars|hcl|ya?ml|dockerfile|jsonnet)$/i;

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
const candidateKeys = new Set();
const scannedFiles = [];

function addCandidate(candidate) {
  const key = `${candidate.ruleId}:${candidate.path}:${candidate.line}:${candidate.side ?? 'added'}`;
  if (candidateKeys.has(key)) return;
  candidateKeys.add(key);
  candidates.push(candidate);
}

function readSourceLines(file) {
  try {
    return readFileSync(file.path, 'utf8').split(/\r?\n/);
  } catch {
    return undefined;
  }
}

function findPythonSqlFstringLines(file, sourceLines) {
  if (!sourceLines || !file.path.endsWith('.py')) return new Set();

  const source = sourceLines.join('\n');
  const stringPattern = /(?:^|[^\w])(?:fr|rf|f)("""|'''|"|')([\s\S]*?)\1/gim;
  const changedLines = new Set();
  for (const match of source.matchAll(stringPattern)) {
    const body = match[2];
    if (!/\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE|ORDER\s+BY)\b/i.test(body) || !/\{[^{}]+\}/.test(body)) {
      continue;
    }

    const bodyStart = match.index + match[0].indexOf(body);
    const firstLine = source.slice(0, bodyStart).split('\n').length;
    const lastLine = firstLine + body.split('\n').length - 1;
    for (const change of file.changes ?? []) {
      if (change.side === 'added' && change.line >= firstLine && change.line <= lastLine) {
        changedLines.add(change.line);
      }
    }
  }
  return changedLines;
}

function isSwallowedPythonException(file, change, sourceLines) {
  if (!file.path.endsWith('.py')) return false;
  const line = sourceLines?.[change.line - 1] ?? change.text;
  const header = line.match(/^(\s*)except(?:\s+[^:]+)?\s*:\s*(.*)$/);
  if (!header) return false;
  if (/^pass\b/.test(header[2].trim())) return true;

  const addedChanges = (file.changes ?? []).filter((item) => item.side === 'added');
  const lines = sourceLines ?? addedChanges
    .map((item) => item.text);
  const startIndex = sourceLines ? change.line - 1 : addedChanges.findIndex((item) => item.line === change.line);
  if (startIndex < 0) return false;
  const indentation = header[1].length;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const nextLine = lines[index];
    if (!nextLine.trim() || nextLine.trimStart().startsWith('#')) continue;
    const nextIndentation = nextLine.length - nextLine.trimStart().length;
    if (nextIndentation <= indentation) return false;
    return /^\s*pass\s*(?:#.*)?$/.test(nextLine);
  }
  return false;
}

function isSafeYamlLoad(file, change, sourceLines) {
  if (!/\byaml\.load\s*\(/i.test(change.text)) return false;
  const context = sourceLines
    ? sourceLines.slice(change.line - 1, change.line + 3).join('\n')
    : change.text;
  return /\b(?:C)?SafeLoader\b/.test(context);
}

for (const file of report.files) {
  if (isExcluded(file.path)) continue;
  const testFile = isTestFile(file.path);
  if (testFile && config.scan?.testFiles?.mode === 'skip') continue;
  scannedFiles.push(file);
  const sourceLines = file.path.endsWith('.py') ? readSourceLines(file) : undefined;
  const pythonSqlFstringLines = findPythonSqlFstringLines(file, sourceLines);

  for (const change of file.changes ?? []) {
    if (change.side === 'removed') {
      const match = change.text.match(removedControlPattern);
      if (!match) continue;
      addCandidate({
        ruleId: 'REG-401',
        path: file.path,
        line: change.line,
        side: 'removed',
        description: `Removed line contains security-control term "${match[0]}"; verify it was replaced or intentionally removed`,
        evidence: '[removed control line omitted from evidence]',
        ...(testFile && config.scan?.testFiles?.mode === 'lower-confidence'
          ? { confidence: 'lower' }
          : {}),
      });
      continue;
    }
    if (change.side !== 'added') continue;

    for (const rule of rules) {
      if (rule.id === 'CRIT-106' && isSafeYamlLoad(file, change, sourceLines)) continue;
      if (!rule.pattern.test(change.text)) continue;
      addCandidate({
        ruleId: rule.id,
        path: file.path,
        line: change.line,
        description: rule.description,
        evidence: rule.redact ? '[possible secret value omitted]' : change.text.trim().slice(0, 240),
        ...(rule.id.startsWith('ARCH-4') && infrastructurePathPattern.test(file.path)
          ? { context: 'infrastructure' }
          : {}),
        ...(testFile && config.scan?.testFiles?.mode === 'lower-confidence'
          ? { confidence: 'lower' }
          : {}),
        ...(config.scan?.projectStack === 'frontend' && rule.stackSensitive
          ? { reviewPriority: 'lower' }
          : {}),
      });
    }

    if (pythonSqlFstringLines.has(change.line)) {
      addCandidate({
        ruleId: 'CRIT-101',
        path: file.path,
        line: change.line,
        description: 'Dynamic value interpolated into a Python SQL f-string; use query parameters',
        evidence: change.text.trim().slice(0, 240),
        ...(testFile && config.scan?.testFiles?.mode === 'lower-confidence'
          ? { confidence: 'lower' }
          : {}),
      });
    }

    if (isSwallowedPythonException(file, change, sourceLines)) {
      addCandidate({
        ruleId: 'CRIT-301',
        path: file.path,
        line: change.line,
        description: 'Python exception handler silently discards the exception with pass',
        evidence: change.text.trim().slice(0, 240),
        ...(testFile && config.scan?.testFiles?.mode === 'lower-confidence'
          ? { confidence: 'lower' }
          : {}),
      });
    }
  }
}

const pythonFiles = scannedFiles.filter((file) => file.path.endsWith('.py'));
const infrastructureFiles = scannedFiles.filter((file) => infrastructurePathPattern.test(file.path));

process.stdout.write(`${JSON.stringify({
  candidates,
  skipped: report.skipped ?? [],
  coverage: {
    python: {
      changedFiles: pythonFiles.length,
      note: pythonFiles.length
        ? 'Targeted Python heuristics ran; this is not exhaustive security analysis.'
        : 'No changed Python files were collected.',
    },
    infrastructure: {
      changedFiles: infrastructureFiles.length,
      note: infrastructureFiles.length
        ? 'Infrastructure heuristics ran on changed IaC/workload files; verify cloud and deployment context.'
        : 'No recognized infrastructure files were collected.',
    },
  },
  note: 'Heuristic candidates only; verify context and mitigations before reporting.',
}, null, 2)}\n`);