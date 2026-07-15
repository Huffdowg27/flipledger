import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findSettlementReportCandidates,
  resolveSettlementReportIdentifier,
  type SettlementReportListItem,
  type SettlementPeriodForResolution,
} from '../src/lib/sp-api/settlement-report-resolution';

const PERIOD: SettlementPeriodForResolution = {
  settlementId: 'SETTLEMENT-2026-06-A',
  startDate: '2026-06-12 16:58:07 UTC',
  endDate: '2026-06-22 16:58:07 UTC',
};

const REPORTS: SettlementReportListItem[] = [
  {
    reportId: 'R-OLDER',
    reportDocumentId: 'D-OLDER',
    dataStartTime: '2026-05-29T16:58:07Z',
    dataEndTime: '2026-06-12T16:58:06Z',
  },
  {
    reportId: 'R-MATCH',
    reportDocumentId: 'D-MATCH',
    dataStartTime: '2026-06-12T16:58:07Z',
    dataEndTime: '2026-06-22T16:58:07Z',
  },
  {
    reportId: 'R-NEWER',
    reportDocumentId: 'D-NEWER',
    dataStartTime: '2026-06-22T16:58:08Z',
    dataEndTime: '2026-07-06T16:58:07Z',
  },
];

test('settlementId resolution chooses the report whose listed period matches the settlement period', () => {
  const result = resolveSettlementReportIdentifier({
    settlementId: PERIOD.settlementId,
    period: PERIOD,
    reports: REPORTS,
  });

  assert.equal(result.ok, true);
  assert.equal(result.report.reportId, 'R-MATCH');
  assert.equal(result.report.reportDocumentId, 'D-MATCH');
  assert.equal(result.expectedSettlementId, PERIOD.settlementId);
});

test('reportId resolution accepts a report id directly without treating it as a settlement id', () => {
  const result = resolveSettlementReportIdentifier({
    reportId: 'R-DIRECT',
    reports: REPORTS,
  });

  assert.equal(result.ok, true);
  assert.equal(result.report.reportId, 'R-DIRECT');
  assert.equal(result.expectedSettlementId, null);
});

test('unresolvable settlementId returns clear candidate reports instead of guessing', () => {
  const result = resolveSettlementReportIdentifier({
    settlementId: PERIOD.settlementId,
    period: PERIOD,
    reports: [
      {
        reportId: 'R-A',
        reportDocumentId: 'D-A',
        dataStartTime: '2026-06-12T16:58:07Z',
        dataEndTime: '2026-06-22T16:58:07Z',
      },
      {
        reportId: 'R-B',
        reportDocumentId: 'D-B',
        dataStartTime: '2026-06-12T16:58:07Z',
        dataEndTime: '2026-06-22T16:58:07Z',
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Ambiguous/);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.reportId),
    ['R-A', 'R-B'],
  );
});

test('candidate finder ignores reports without reportDocumentId and ranks closest period first', () => {
  const candidates = findSettlementReportCandidates(PERIOD, [
    {
      reportId: 'R-NODOC',
      dataStartTime: '2026-06-12T16:58:07Z',
      dataEndTime: '2026-06-22T16:58:07Z',
    },
    ...REPORTS,
  ]);

  assert.deepEqual(
    candidates.map((candidate) => candidate.reportId),
    ['R-MATCH'],
  );
});
