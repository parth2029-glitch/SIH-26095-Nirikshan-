import { useEffect, useState } from 'react';
import { api } from './api.js';

/** One fetch, three states. Every screen here needs exactly this and no more. */
export function useApi(path, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let live = true;
    setState({ loading: true, data: null, error: null });
    api(path)
      .then((data) => live && setState({ loading: false, data, error: null }))
      .then(undefined, (error) => live && setState({ loading: false, data: null, error }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, deps);
  return state;
}

export const Panel = ({ title, note, children, actions }) => (
  <section className="rounded border border-line bg-card">
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
      <div>
        <h2 className="font-medium">{title}</h2>
        {note && <p className="text-xs text-dim">{note}</p>}
      </div>
      {actions}
    </div>
    <div className="px-4 py-3">{children}</div>
  </section>
);

export const Stat = ({ label, value, tone }) => (
  <div>
    <div className={`text-2xl font-semibold tabular-nums ${tone ?? ''}`}>{value}</div>
    <div className="text-xs text-dim">{label}</div>
  </div>
);

const BADGE = {
  CRITICAL: 'bg-bad/10 text-bad',
  HIGH: 'bg-warn/10 text-warn',
  MEDIUM: 'bg-ink/8 text-ink',
  LOW: 'bg-ink/5 text-dim',
  BREACHED: 'bg-bad/10 text-bad',
  DUE_SOON: 'bg-warn/10 text-warn',
  ON_TIME: 'bg-ok/10 text-ok',
};

export const Badge = ({ children, kind }) => (
  <span
    className={`rounded px-1.5 py-0.5 text-xs font-medium ${BADGE[kind] ?? 'bg-ink/5 text-dim'}`}
  >
    {children}
  </span>
);

export const Loading = ({ what }) => <p className="py-6 text-sm text-dim">Loading {what}…</p>;

export const Failed = ({ error }) => (
  <p role="alert" className="py-6 text-sm text-bad">
    {error.message}
  </p>
);

export const day = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

/** Hashes are 64 hex characters and nobody reads the middle. */
export const short = (hash) => (hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : '—');
