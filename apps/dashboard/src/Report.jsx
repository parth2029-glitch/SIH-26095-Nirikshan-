import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { blob } from './api.js';
import { Badge, Failed, Loading, Panel, day, short, useApi } from './ui.jsx';

/**
 * The review view: what was answered, what was photographed, and why the trust
 * score is what it is.
 *
 * The score arrives from its own endpoint (§11) rather than with the report,
 * because it costs a corpus scan and a reviewer scrolling a list should not pay
 * for one per row. Every factor is rendered, fired or not — a panel that only
 * ever showed failures could not distinguish "clean" from "not checked".
 */
export default function Report() {
  const { id } = useParams();
  const report = useApi(`/api/reports/${id}`, [id]);
  const trust = useApi(`/api/reports/${id}/trust`, [id]);

  if (report.loading) return <Loading what="the report" />;
  if (report.error) return <Failed error={report.error} />;
  const data = report.data;

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
      <div className="grid min-w-0 gap-6">
        <Panel
          title={data.institute?.name ?? 'Report'}
          note={`${data.institute?.district} · ${data.institute?.schemeType} · submitted ${day(data.submittedAt)}`}
          actions={
            data.cycle && (
              <a
                href={`/verify.html?cycle=${data.cycle.id}`}
                className="text-sm underline text-dim hover:text-ink"
              >
                Verify this cycle ↗
              </a>
            )
          }
        >
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Row label="Allocation">{data.assignment?.allocationType ?? '—'}</Row>
            <Row label="Report status">{data.status}</Row>
            <Row label="Captured offline">{data.capturedOffline ? 'Yes' : 'No'}</Row>
            <Row label="Device signature">
              {data.signatureValid ? (
                <span className="text-ok">verified</span>
              ) : (
                <span className="text-bad">missing</span>
              )}
            </Row>
            <Row label="Reported occupancy">{data.institute?.reportedOccupancy ?? '—'}</Row>
            <Row label="Sanctioned capacity">{data.institute?.reportedCapacity ?? '—'}</Row>
          </dl>
        </Panel>

        {data.evidence.length > 0 && (
          <Panel
            title="Evidence"
            note={`${data.evidence.length} photograph(s), originals stored unmodified`}
          >
            <div className="flex flex-wrap gap-3">
              {data.evidence.map((item) => (
                <figure key={item.id} className="w-40">
                  <Thumbnail id={item.id} />
                  <figcaption className="mt-1 text-xs text-dim">
                    <div className="font-mono" title={item.sha256}>
                      {short(item.sha256)}
                    </div>
                    <div>{day(item.capturedAt)}</div>
                    {item.flags.map((flag) => (
                      <div key={flag} className="text-bad">
                        {flag}
                      </div>
                    ))}
                  </figcaption>
                </figure>
              ))}
            </div>
          </Panel>
        )}

        <Panel title="Findings" note={`${data.findings.length} raised from this inspection`}>
          {data.findings.length === 0 ? (
            <p className="text-sm text-dim">Nothing recorded as non-compliant.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.findings.map((finding) => (
                <li
                  key={finding.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm"
                >
                  <Badge kind={finding.severity}>{finding.severity}</Badge>
                  <span className="min-w-0 flex-1">{finding.description}</span>
                  <span className="text-dim">{finding.status}</span>
                  <span className="text-dim">due {day(finding.slaDueAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Checklist" note={`${data.answers.length} questions`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line">
                {data.answers.map((answer) => (
                  <tr key={answer.questionId}>
                    <td className="w-56 py-1.5 pr-3 text-dim">{answer.questionId}</td>
                    <td className="py-1.5 pr-3">{format(answer.value)}</td>
                    <td className="py-1.5 text-dim">{answer.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <TrustPanel state={trust} />
    </div>
  );
}

const Row = ({ label, children }) => (
  <div className="flex justify-between gap-4 border-b border-line pb-1">
    <dt className="text-dim">{label}</dt>
    <dd>{children}</dd>
  </div>
);

const format = (value) =>
  value === null || value === undefined ? (
    <span className="text-dim">—</span>
  ) : typeof value === 'boolean' ? (
    <span className={value ? 'text-ok' : 'text-bad'}>{value ? 'Yes' : 'No'}</span>
  ) : (
    String(value)
  );

function TrustPanel({ state }) {
  if (state.loading) return <Loading what="the trust score" />;
  // A DISTRICT or DIVISION token can read this; an INSTITUTE one cannot, and
  // that 403 is the API doing its job, not a screen that failed to load.
  if (state.error) {
    return (
      <Panel title="Evidence trust score">
        <p className="text-sm text-dim">{state.error.message}</p>
      </Panel>
    );
  }
  const { score, factors } = state.data;
  const tone = score >= 80 ? 'text-ok' : score >= 50 ? 'text-warn' : 'text-bad';

  return (
    <Panel title="Evidence trust score" note="Routes review — it never blocks a submission">
      <div className={`text-4xl font-semibold tabular-nums ${tone}`}>{score}</div>
      <ul className="mt-4 divide-y divide-line">
        {factors.map((factor) => (
          <li key={factor.id} className="py-2">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className={factor.fired ? 'font-medium' : 'text-dim'}>
                {factor.id} · {factor.label}
              </span>
              <span className={`tabular-nums ${factor.fired ? 'text-bad' : 'text-dim'}`}>
                {factor.fired ? `−${factor.deduction}` : '0'}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-dim">{factor.reason}</p>
            {factor.evidence?.matchedReportIds?.length > 0 && (
              <p className="mt-1 text-xs">
                {factor.evidence.matchedReportIds.map((cited) => (
                  <Link key={cited} to={`/reports/${cited}`} className="mr-2 underline">
                    open the cited report
                  </Link>
                ))}
              </p>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * Thumbnails sit behind the same bearer token as everything else, and an `<img
 * src>` cannot carry an Authorization header — so the bytes are fetched and
 * handed to the tag as an object URL. Making the route public would be the
 * shorter code and would publish every photograph in the system.
 */
function Thumbnail({ id }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let objectUrl;
    blob(`/api/evidence/${id}/thumbnail`)
      .then((bytes) => {
        objectUrl = URL.createObjectURL(bytes);
        setUrl(objectUrl);
      })
      // A thumbnail an AUDITOR-less role may not read is a blank tile, not an
      // error banner over the report they came here to read.
      .catch(() => {});
    return () => objectUrl && URL.revokeObjectURL(objectUrl);
  }, [id]);

  return url ? (
    <img src={url} alt="" className="w-40 rounded border border-line" />
  ) : (
    <div className="h-28 w-40 rounded border border-line bg-page" />
  );
}
