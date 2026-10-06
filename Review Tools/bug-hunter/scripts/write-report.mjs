#!/usr/bin/env node
// Turns the reviewing agent's verified findings into a markdown report (for people) and a JSON
// report (for agents/subagents, which only need to pass the file path around).
// Usage: write-report.mjs [--input <agent-findings.json>] [--scan <scan.json>] [--packets <packets.json>]
//        [--config <path>] [--out <dir>]   (agent findings default to stdin)
//
// Agent input: { probable_bugs: [...], suspicious: [...], clean: [{area, note}|string],
//                dismissed_script_findings: [{rule, file, line, reason}] }
// Finding: { title, file?, line?, rule?, summary?, snippet?, scenario?, check?, recommendation?,
//            autoFixed?, fixNote? }

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain, loadConfig, parseArgs, readJsonInput, runCli } from './lib/common.mjs';

export const SCHEMA_VERSION = 1;
export const MAX_SUSPICIOUS_IN_MARKDOWN = 15;

const toList = (value) => (Array.isArray(value) ? value : []);
const hasText = (value) => typeof value === 'string' && value.trim() !== '';

/** Enforces the report contract: 🔴 needs a concrete failure scenario, 🟡 needs one specific check. */
export function validateAgentReport(input) {
  const problems = [];
  const check = (list, section, requiredField, why) => {
    toList(list).forEach((finding, index) => {
      const label = `${section}[${index}]${hasText(finding?.title) ? ` "${finding.title}"` : ''}`;
      if (!hasText(finding?.title)) problems.push(`${label}: "title" is required.`);
      if (!hasText(finding?.[requiredField])) problems.push(`${label}: "${requiredField}" is required (${why}).`);
    });
  };
  check(input.probable_bugs, 'probable_bugs', 'scenario', 'a concrete input or state that fails, and how');
  check(input.suspicious, 'suspicious', 'check', 'the one specific thing the developer should verify');
  toList(input.clean).forEach((entry, index) => {
    if (typeof entry !== 'string' && !hasText(entry?.area)) problems.push(`clean[${index}]: "area" is required.`);
  });
  if (problems.length > 0) throw new Error(`Invalid agent findings:\n- ${problems.join('\n- ')}`);
}

const locationOf = (finding) => (finding.file ? { file: finding.file, line: finding.line ?? null } : undefined);

/** Repeated hits of the same rule and title become one entry with a location list. */
export function groupFindings(findings) {
  const groups = new Map();
  for (const finding of toList(findings)) {
    const key = `${finding.rule ?? ''}|${finding.title}`;
    const location = locationOf(finding);
    const existing = groups.get(key);
    if (existing) {
      if (location) existing.locations.push(location);
    } else {
      groups.set(key, { ...finding, locations: location ? [location] : [] });
    }
  }
  return [...groups.values()].map(({ file, line, ...rest }) => rest);
}

const normalizeClean = (entry) => (typeof entry === 'string' ? { area: entry, note: '' } : { area: entry.area, note: entry.note ?? '' });

function fenceFor(text) {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longestRun + 1));
}

const singleLine = (text) => String(text).replace(/\s+/g, ' ').trim();

function formatLocations(locations) {
  if (locations.length === 0) return '';
  const format = (location) => `\`${location.file}${location.line ? `:${location.line}` : ''}\``;
  return locations.length === 1 ? format(locations[0]) : `${locations.length} locations: ${locations.map(format).join(', ')}`;
}

function renderFinding(finding, index, kind) {
  const lines = [`### ${index + 1}. ${singleLine(finding.title)}`];
  const where = formatLocations(finding.locations);
  const rule = finding.rule ? ` · Rule: \`${finding.rule}\`` : '';
  if (where || rule) lines.push(`${where}${rule}`.replace(/^ · /, ''));
  if (finding.autoFixed) lines.push(`✅ **Auto-fixed.** ${finding.fixNote ?? ''}`.trim());
  if (hasText(finding.summary)) lines.push('', finding.summary.trim());
  if (hasText(finding.snippet)) {
    const fence = fenceFor(finding.snippet);
    lines.push('', `${fence}\n${finding.snippet.trimEnd()}\n${fence}`);
  }
  if (kind === 'probable') lines.push('', `**Failure scenario:** ${finding.scenario.trim()}`);
  if (kind === 'suspicious') lines.push('', `**Verify:** ${finding.check.trim()}`);
  if (hasText(finding.recommendation)) lines.push('', `**Recommendation:** ${finding.recommendation.trim()}`);
  return lines.join('\n');
}

function renderSection(heading, entries, render, emptyText) {
  return [`## ${heading}`, '', entries.length === 0 ? emptyText : entries.map(render).join('\n\n')].join('\n');
}

export function renderMarkdown(report) {
  const { run, summary, signals } = report;
  const out = ['# 🐞 Bug Hunter Report', ''];
  const meta = [`Generated ${report.generatedAt}`];
  if (run.baseRef) meta.push(`base \`${run.baseRef}\``);
  if (run.commit) meta.push(`commit \`${run.commit}\``);
  out.push(meta.join(' · '), '');
  out.push(`**${summary.probableBugs}** probable · **${summary.suspicious}** suspicious · **${summary.clean}** clean areas`, '');

  if (run.mode === 'high-risk-only') {
    out.push('> ⚠️ **Partial review.** A size budget limited this run to the highest-risk changes. Not reviewed:');
    for (const omitted of run.omitted) out.push(`> - \`${omitted.file}\` (lines ${omitted.range.start}-${omitted.range.end}, risk ${omitted.riskScore})`);
    out.push('');
  }
  if (signals?.logicChangedWithoutTests) {
    out.push('> ⚠️ Source logic changed but no test files changed in this diff.', '');
  }

  out.push(renderSection('🔴 Probable Bugs', report.probable_bugs, (f, i) => renderFinding(f, i, 'probable'), 'None found.'), '');

  const shown = report.suspicious.slice(0, MAX_SUSPICIOUS_IN_MARKDOWN);
  out.push(renderSection('🟡 Suspicious', shown, (f, i) => renderFinding(f, i, 'suspicious'), 'None found.'));
  if (report.suspicious.length > shown.length) {
    out.push('', `_${report.suspicious.length - shown.length} more suspicious item(s) are in the JSON report._`);
  }
  out.push('');

  out.push(renderSection('🟢 Clean', report.clean, (c) => `- **${singleLine(c.area)}**${c.note ? ` — ${singleLine(c.note)}` : ''}`, 'No specific areas to report.'));
  out.push('');
  return out.join('\n');
}

export function buildReportJson(agentReport, { scan, packets, now = new Date() } = {}) {
  const probable = groupFindings(agentReport.probable_bugs);
  const suspicious = groupFindings(agentReport.suspicious);
  const clean = toList(agentReport.clean).map(normalizeClean);
  const dismissed = toList(agentReport.dismissed_script_findings);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    run: {
      baseRef: scan?.comparison_base ?? packets?.comparison_base,
      commit: scan?.commit_hash,
      mode: packets?.mode ?? 'full',
      omitted: packets?.omitted ?? [],
      languages: scan?.repository_type ?? [],
    },
    summary: { probableBugs: probable.length, suspicious: suspicious.length, clean: clean.length, dismissed: dismissed.length },
    signals: scan?.signals,
    probable_bugs: probable,
    suspicious,
    clean,
    dismissed_script_findings: dismissed,
  };
}

const pad = (value) => String(value).padStart(2, '0');

export function reportBaseName(now, suffix) {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `bug-hunter-${date}T${time}-${suffix}`;
}

export function writeReport(agentReport, { outputDir, scan, packets, now = new Date(), suffix = randomBytes(2).toString('hex') }) {
  validateAgentReport(agentReport);
  const report = buildReportJson(agentReport, { scan, packets, now });
  mkdirSync(outputDir, { recursive: true });
  const base = join(outputDir, reportBaseName(now, suffix));
  const jsonPath = `${base}.json`;
  const markdownPath = `${base}.md`;
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(markdownPath, renderMarkdown(report), { flag: 'wx' });
  return { markdownPath, jsonPath, summary: report.summary };
}

if (isMain(import.meta.url)) {
  await runCli(async () => {
    const { flags } = parseArgs(process.argv.slice(2));
    const config = loadConfig(flags.config);
    const optionalJson = (path) => (path ? JSON.parse(readFileSync(resolve(path), 'utf8')) : undefined);
    const agentReport = await readJsonInput({ diff: flags.input });
    const result = writeReport(agentReport, {
      outputDir: resolve(flags.out ?? config.report.outputDir),
      scan: optionalJson(flags.scan),
      packets: optionalJson(flags.packets),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
}
