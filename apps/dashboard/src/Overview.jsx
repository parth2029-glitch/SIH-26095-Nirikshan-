import { Link } from 'react-router-dom';
import { Badge, Failed, Loading, Panel, Stat, day, short, useApi } from './ui.jsx';

/**
 * Live cycle status, and the top of the action queue.
 *
 * The commitment hash is on this panel deliberately. It is the one string an
 * officer and a stranger with no account can compare, and putting it behind a
 * detail view would make the checkable number the hard one to find.
 */
export default function Overview({ user }) {
  const cycles = useApi('/api/dashboard/cycles');
  const findings = useApi('/api/dashboard/findings?limit=8');

  if (cycles.loading) return <Loading what="cycles" />;
  if (cycles.error) return <Failed error={cycles.error} />;

  const [current, ...history] = cycles.data.cycles;
  if (!current) {
    return <p className="text-sm text-dim">No cycles yet — run `npm run seed -- --reset`.</p>;
  }
  const open = current.issued - current.completed - current.cancelled;

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Panel
        title={`Current cycle — ${day(current.periodStart)} to ${day(current.periodEnd)}`}
        note={`${current.status}${current.seedRevealed ? ' · seed revealed' : ' · seed sealed'}`}
        actions={
          <a
            href={`/verify.html?cycle=${current.id}`}
            className="text-sm underline text-dim hover:text-ink"
          >
            Verify ↗
          </a>
        }
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Issued" value={current.issued} />
          <Stat label="Completed" value={current.completed} tone="text-ok" />
          <Stat label="Overdue" value={current.overdue} tone={current.overdue ? 'text-bad' : ''} />
          <Stat label="Outstanding" value={open} />
        </div>

        <dl className="mt-5 grid gap-2 border-t border-line pt-4 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-dim">Commitment hash</dt>
            <dd className="font-mono text-xs" title={current.commitmentHash}>
              {short(current.commitmentHash)}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-dim">Published</dt>
            <dd>{day(current.commitmentPublishedAt)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-dim">Deferred by constraints</dt>
            <dd>{current.deferred}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Action queue" note="Open findings, soonest deadline first">
        {findings.loading && <Loading what="findings" />}
        {findings.error && <Failed error={findings.error} />}
        {findings.data && findings.data.findings.length === 0 && (
          <p className="text-sm text-dim">Nothing open in scope.</p>
        )}
        {findings.data && findings.data.findings.length > 0 && (
          <>
            <ul className="divide-y divide-line">
              {findings.data.findings.map((finding) => (
                <li
                  key={finding.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm"
                >
                  <Badge kind={finding.severity}>{finding.severity}</Badge>
                  <Link
                    to={`/reports/${finding.reportId}`}
                    className="min-w-0 flex-1 truncate underline"
                  >
                    {finding.institute.name}
                  </Link>
                  <Badge kind={finding.slaState}>{finding.slaState.replace('_', ' ')}</Badge>
                  <span className="text-dim tabular-nums">{finding.daysOpen}d open</span>
                </li>
              ))}
            </ul>
            <Link
              to="/queue"
              className="mt-3 inline-block text-sm underline text-dim hover:text-ink"
            >
              Open the full queue →
            </Link>
          </>
        )}
      </Panel>

      <Panel title="Recent cycles" note={`${user.role} scope`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-dim">
              <tr>
                <th className="py-1 pr-3 font-medium">Period</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 pr-3 text-right font-medium">Issued</th>
                <th className="py-1 pr-3 text-right font-medium">Done</th>
                <th className="py-1 pr-3 text-right font-medium">Overdue</th>
                <th className="py-1 font-medium">Commitment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {history.map((cycle) => (
                <tr key={cycle.id}>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{day(cycle.periodStart)}</td>
                  <td className="py-1.5 pr-3 text-dim">{cycle.status}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{cycle.issued}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{cycle.completed}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{cycle.overdue}</td>
                  <td className="py-1.5">
                    <a
                      href={`/verify.html?cycle=${cycle.id}`}
                      className="font-mono text-xs underline"
                    >
                      {short(cycle.commitmentHash)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
