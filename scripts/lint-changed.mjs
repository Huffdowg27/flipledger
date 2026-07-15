import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const LINTABLE = /\.(?:[cm]?js|jsx|tsx?)$/;
const BASELINE_PATH = '.eslint-baseline.json';
const eslint = path.join('node_modules', '.bin', 'eslint');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function changedFiles() {
  const requestedBase = process.argv[2] || process.env.LINT_BASE_SHA;
  if (requestedBase && !/^0+$/.test(requestedBase)) {
    try {
      return git(['diff', '--name-only', '--diff-filter=ACMR', `${requestedBase}...HEAD`]);
    } catch {
      console.warn(`Could not diff from ${requestedBase}; falling back to HEAD^.`);
      return git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD^...HEAD']);
    }
  }

  return [
    ...git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ];
}

function runEslintJson(targets) {
  const result = spawnSync(eslint, [...targets, '--format', 'json'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    process.stderr.write(result.stderr || '');
    process.exit(result.status ?? 2);
  }
  return JSON.parse(result.stdout);
}

function issueCounts(results) {
  return Object.fromEntries(
    results
      .filter(({ errorCount, warningCount }) => errorCount > 0 || warningCount > 0)
      .map(({ filePath, errorCount, warningCount }) => [
        path.relative(process.cwd(), filePath),
        { errorCount, warningCount },
      ])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

if (process.argv.includes('--update')) {
  const baseline = issueCounts(runEslintJson(['.']));
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(baseline).length} lint-debt entries to ${BASELINE_PATH}.`);
  process.exit(0);
}

const files = [...new Set(changedFiles())]
  .filter((file) => LINTABLE.test(file) && existsSync(file));

if (files.length === 0) {
  console.log('No changed JavaScript/TypeScript files to lint.');
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const current = issueCounts(runEslintJson(files));
const mismatches = files.flatMap((file) => {
  const allowed = baseline[file] || { errorCount: 0, warningCount: 0 };
  const actual = current[file] || { errorCount: 0, warningCount: 0 };
  return actual.errorCount === allowed.errorCount
    && actual.warningCount === allowed.warningCount
    ? []
    : [{ file, allowed, actual }];
});

if (mismatches.length > 0) {
  console.error('Lint debt changed. Fix new issues or run npm run lint:baseline:update after an improvement:');
  for (const mismatch of mismatches) {
    console.error(
      `- ${mismatch.file}: `
      + `${mismatch.allowed.errorCount}E/${mismatch.allowed.warningCount}W baseline → `
      + `${mismatch.actual.errorCount}E/${mismatch.actual.warningCount}W current`,
    );
  }
  spawnSync(eslint, files, { stdio: 'inherit' });
  process.exit(1);
}

const debt = Object.values(current).reduce(
  (sum, value) => sum + value.errorCount + value.warningCount,
  0,
);
console.log(`Lint baseline holds for ${files.length} changed file(s) (${debt} known issue(s), 0 new).`);
