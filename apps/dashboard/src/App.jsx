import { NavLink, Outlet } from 'react-router-dom';

/**
 * The shell, and the only place role changes what is on screen.
 *
 * A DIVISION officer runs the portfolio, a DISTRICT officer runs one district's
 * queue, an INSTITUTE account reads its own record, an AUDITOR reads and signs
 * nothing. The API enforces all four independently — this is what each of them
 * is *offered*, which is a usability decision, not a security one.
 */
const NAV = {
  DIVISION: [
    ['/', 'Overview'],
    ['/queue', 'Action queue'],
    ['/map', 'Risk map'],
  ],
  DISTRICT: [
    ['/', 'Overview'],
    ['/queue', 'Action queue'],
    ['/map', 'Risk map'],
  ],
  AUDITOR: [
    ['/', 'Overview'],
    ['/map', 'Risk map'],
  ],
  INSTITUTE: [['/', 'My institute']],
};

const SCOPE = {
  DIVISION: 'All districts',
  DISTRICT: (user) => user.homeDistrict ?? 'District',
  AUDITOR: 'Read-only, all districts',
  INSTITUTE: 'This institute only',
};

export default function App({ user, onSignOut }) {
  const links = NAV[user.role] ?? NAV.INSTITUTE;
  const scope = SCOPE[user.role];

  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
      <aside className="border-b md:border-b-0 md:border-r border-line bg-card px-5 py-6 md:min-h-screen">
        <div className="text-lg font-semibold tracking-tight">Nirikshan</div>
        <div className="mt-0.5 text-xs text-dim">SIH26095</div>

        <nav className="mt-6 flex gap-1 md:flex-col">
          {links.map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `rounded px-3 py-2 text-sm ${isActive ? 'bg-ink text-white' : 'hover:bg-page'}`
              }
            >
              {label}
            </NavLink>
          ))}
          <a
            href="/verify.html"
            className="rounded px-3 py-2 text-sm hover:bg-page"
            title="Public — no account required"
          >
            Verify a cycle ↗
          </a>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line bg-card px-6 py-4">
          <div>
            <div className="font-medium">{user.name}</div>
            <div className="text-xs text-dim">
              {user.role} · {typeof scope === 'function' ? scope(user) : scope}
            </div>
          </div>
          <button onClick={onSignOut} className="text-sm underline text-dim hover:text-ink">
            Sign out
          </button>
        </header>

        <main className="min-w-0 flex-1 px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
