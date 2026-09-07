import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Failed, Loading, Panel, day, useApi } from './ui.jsx';

const STATES = ['ALL', 'BREACHED', 'DUE_SOON', 'ON_TIME'];

/**
 * The full action queue: open findings by SLA state, owner and days open.
 *
 * The SLA filter is applied here rather than in the query because `slaState` is
 * derived from the clock, not stored — an index cannot answer "breached" without
 * a job writing that word into every row, which is a mutation §6's ledger would
 * have to authorise. At a division's volume the filter is free.
 */
export default function Queue() {
  const [state, setState] = useState('ALL');
  const { loading, data, error } = useApi('/api/dashboard/findings?limit=500');

  if (loading) return <Loading what="the queue" />;
  if (error) return <Failed error={error} />;

  const rows = data.findings.filter((f) => state === 'ALL' || f.slaState === state);

  return (
    <Panel
      title="Action queue"
      note={`${rows.length} open finding${rows.length === 1 ? '' : 's'} in scope`}
      actions={
        <div className="flex gap-1">
          {STATES.map((option) => (
            <button
              key={option}
              onClick={() => setState(option)}
              className={`rounded px-2 py-1 text-xs ${
                state === option ? 'bg-ink text-white' : 'border border-line hover:bg-page'
              }`}
            >
              {option.replace('_', ' ')}
            </button>
          ))}
        </div>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-dim">
            <tr>
              <th className="py-1 pr-3 font-medium">Severity</th>
              <th className="py-1 pr-3 font-medium">Institute</th>
              <th className="py-1 pr-3 font-medium">District</th>
              <th className="py-1 pr-3 font-medium">Finding</th>
              <th className="py-1 pr-3 font-medium">SLA</th>
              <th className="py-1 pr-3 font-medium">Due</th>
              <th className="py-1 pr-3 text-right font-medium">Days open</th>
              <th className="py-1 font-medium">Owner</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((finding) => (
              <tr key={finding.id}>
                <td className="py-1.5 pr-3">
                  <Badge kind={finding.severity}>{finding.severity}</Badge>
                </td>
                <td className="py-1.5 pr-3">
                  <Link to={`/reports/${finding.reportId}`} className="underline">
                    {finding.institute.name}
                  </Link>
                </td>
                <td className="py-1.5 pr-3 text-dim">{finding.institute.district}</td>
                <td className="py-1.5 pr-3">{finding.description}</td>
                <td className="py-1.5 pr-3">
                  <Badge kind={finding.slaState}>{finding.slaState.replace('_', ' ')}</Badge>
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{day(finding.slaDueAt)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{finding.daysOpen}</td>
                <td className="py-1.5 text-dim">{finding.owner?.name ?? 'Unassigned'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="py-6 text-sm text-dim">Nothing in this state.</p>}
      </div>
    </Panel>
  );
}
