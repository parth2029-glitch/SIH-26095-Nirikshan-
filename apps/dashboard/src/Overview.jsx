import { Link } from 'react-router-dom';
import { Badge, Failed, Loading, Panel, Stat, day, short, useApi } from './ui.jsx';

const pct = (value) => `${(value * 100).toFixed(1)}%`;

/**
 * Live cycle status, and the top of the action queue.
 *
 * The commitment hash is on this panel deliberately. It is the one string an
 * officer and a stranger with no account can compare, and putting it behind a
 * detail view would make the checkable number the hard one to find.
 *
 * §14's two accountability panels sit here for the same reason. An override
 * monitor nobody opens monitors nothing: the number that matters is the one an
 * officer sees without going looking for it.
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
  const queue = findings.data?.findings ?? [];

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
        {findings.data && queue.length === 0 && (
          <p className="text-sm text-dim">Nothing open in scope.</p>
        )}
        {queue.length > 0 && (
          <>
            <ul className="divide-y divide-line">
              {queue.map((finding) => (
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

      {user.role === 'DIVISION' && <OverrideMonitor />}

      <UnactionedFlags />

      <Deferrals cycles={cycles.data.cycles} />

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

/**
 * The institutes the engine could not place, and what stopped it (§4).
 *
 * A silent deferral is the failure mode: an institute drops out of the roster
 * and nobody is ever told it was due. Naming the binding constraint is what
 * lets an officer choose between overriding it and rescheduling the visit.
 *
 * Across all twelve cycles, not just the live one — a cycle that placed
 * everybody has nothing to report, and an institute deferred three cycles
 * running is the pattern worth seeing.
 */
function Deferrals({ cycles }) {
  const rows = cycles.flatMap((cycle) =>
    cycle.deferrals.map((row) => ({ ...row, period: cycle.periodStart, cycleId: cycle.id })),
  );

  return (
    <Panel
      title="Deferred by constraints"
      note={`${rows.length} institute${rows.length === 1 ? '' : 's'} the engine could not place under C1–C4`}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-dim">Every institute due was placed.</p>
      ) : (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto text-sm">
          {rows.map((row) => (
            <li key={`${row.cycleId}-${row.instituteId}`} className="py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium">{row.name}</span>
                <span className="text-xs text-dim">
                  {row.district} · {day(row.period)}
                </span>
              </div>
              <p className="text-xs text-dim">{row.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Per-officer override rate against the peer baseline (§6, PRD F4).
 *
 * The baseline is the whole point. A rate on its own has no scale — twelve
 * cancellations is diligence in a busy district and a pattern in a quiet one.
 * The server computes the mean and the 2σ line (`apps/api/overrides.js`); this
 * only has to make the outlier impossible to scroll past.
 *
 * DIVISION only, because the endpoint is: an officer is not the right person to
 * audit their own rate.
 */
function OverrideMonitor() {
  const { loading, data, error } = useApi('/api/overrides/officer-rates');

  return (
    <Panel
      title="Override monitor"
      note="Per-officer override rate against the peer baseline, last 12 months"
    >
      {loading && <Loading what="override rates" />}
      {error && <Failed error={error} />}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Peer mean" value={pct(data.peer.mean)} />
            <Stat label="Std deviation" value={pct(data.peer.stdDev)} />
            <Stat label="2σ flag line" value={pct(data.peer.flagThreshold)} tone="text-warn" />
            <Stat label="Officers in baseline" value={data.peer.officerCount} />
          </div>

          <div className="mt-4 overflow-x-auto border-t border-line pt-3">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-dim">
                <tr>
                  <th className="py-1 pr-3 font-medium">Officer</th>
                  <th className="py-1 pr-3 font-medium">District</th>
                  <th className="py-1 pr-3 text-right font-medium">Overrides</th>
                  <th className="py-1 pr-3 text-right font-medium">Decisions</th>
                  <th className="py-1 pr-3 text-right font-medium">Rate</th>
                  <th className="py-1 text-right font-medium">σ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.officers.map((officer) => (
                  <tr key={officer.actorId} className={officer.flagged ? 'bg-bad/5' : ''}>
                    <td className="py-1.5 pr-3">
                      {officer.name}
                      {officer.flagged && (
                        <span className="ml-2">
                          <Badge kind="CRITICAL">above 2σ</Badge>
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-dim">{officer.district ?? 'All districts'}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{officer.overrideCount}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{officer.decisionCount}</td>
                    <td
                      className={`py-1.5 pr-3 text-right tabular-nums ${
                        officer.flagged ? 'font-semibold text-bad' : ''
                      }`}
                    >
                      {pct(officer.rate)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-dim">
                      {officer.sigmasFromMean.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.officers.length === 0 && (
              <p className="py-6 text-sm text-dim">No officers in scope.</p>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

/**
 * Open findings already past their SLA date, by the officer who owns them.
 *
 * A flag raised and never actioned is worse than no flag: a detection the
 * system paid for and then spent nobody's attention on. Grouping by owner is
 * what turns a list of late rows into a question somebody has to answer.
 *
 * The grouping is the server's, not this component's. The queue read caps at
 * 500 rows, and counting that page would have quietly understated the one
 * number the panel exists to raise — a backlog looks smaller than it is exactly
 * when it has grown past the cap.
 */
function UnactionedFlags() {
  const { loading, data, error } = useApi('/api/dashboard/unactioned');

  return (
    <Panel
      title="Unactioned flags"
      note={
        data
          ? `${data.total} open past its SLA date, by responsible officer`
          : 'Open past their SLA date, by responsible officer'
      }
      actions={
        <Link to="/queue" className="text-sm underline text-dim hover:text-ink">
          Full queue →
        </Link>
      }
    >
      {loading && <Loading what="unactioned flags" />}
      {error && <Failed error={error} />}
      {data && data.officers.length === 0 && (
        <p className="text-sm text-dim">Nothing breached in scope.</p>
      )}
      {data && data.officers.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-dim">
            <tr>
              <th className="py-1 pr-3 font-medium">Officer</th>
              <th className="py-1 pr-3 font-medium">District</th>
              <th className="py-1 pr-3 text-right font-medium">Breached</th>
              <th className="py-1 pr-3 text-right font-medium">High / critical</th>
              <th className="py-1 text-right font-medium">Oldest</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.officers.map((row) => (
              <tr key={row.ownerId ?? 'unassigned'}>
                <td className="py-1.5 pr-3">{row.name ?? 'Unassigned'}</td>
                <td className="py-1.5 pr-3 text-dim">{row.district ?? '—'}</td>
                <td className="py-1.5 pr-3 text-right font-semibold tabular-nums text-bad">
                  {row.breached}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{row.severe}</td>
                <td className="py-1.5 text-right tabular-nums text-dim">{row.oldestDaysOpen}d</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
