import { Activity, GitPullRequest, Users, Zap } from 'lucide-react';

const stats = [
  { label: 'Repositories Synced', value: '—', icon: Activity },
  { label: 'Pull Requests', value: '—', icon: GitPullRequest },
  { label: 'Contributors', value: '—', icon: Users },
  { label: 'Events Processed', value: '—', icon: Zap },
];

export default function DashboardPage() {
  return (
    <main className="min-h-screen" style={{ background: '#0b0f19' }}>
      {/* Navbar */}
      <nav className="glass sticky top-0 z-50 border-b border-white/5 px-6 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
              <Zap className="h-4 w-4 text-white" />
            </div>
            <span className="text-lg font-semibold tracking-tight text-white">DevPulse</span>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            Connected to GitHub
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden px-6 py-24 text-center">
        {/* Background glow */}
        <div className="pointer-events-none absolute inset-0 flex items-start justify-center">
          <div className="h-[400px] w-[800px] rounded-full bg-indigo-600/10 blur-[120px]" />
        </div>

        <div className="relative mx-auto max-w-3xl">
          <span className="mb-4 inline-block rounded-full border border-indigo-500/30 bg-indigo-500/10 px-4 py-1 text-xs font-medium text-indigo-400 tracking-widest uppercase">
            Engineering Intelligence
          </span>
          <h1 className="mt-4 text-5xl font-extrabold leading-tight tracking-tight text-white sm:text-6xl">
            The pulse of your{' '}
            <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
              engineering team
            </span>
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-gray-400">
            DevPulse connects to GitHub, synchronizes repository activity, processes events through
            background workers, and surfaces engineering analytics in real time.
          </p>
          <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <button className="glow rounded-xl bg-indigo-600 px-7 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 active:scale-95">
              Connect GitHub
            </button>
            <button className="rounded-xl border border-white/10 bg-white/5 px-7 py-3 text-sm font-semibold text-gray-300 transition hover:bg-white/10">
              View Docs
            </button>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="mx-auto max-w-7xl px-6 pb-16">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map(({ label, value, icon: Icon }) => (
            <div
              key={label}
              className="glass glow rounded-2xl p-6 transition hover:-translate-y-0.5"
            >
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/15">
                <Icon className="h-5 w-5 text-indigo-400" />
              </div>
              <p className="text-3xl font-bold text-white">{value}</p>
              <p className="mt-1 text-sm text-gray-500">{label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Coming Soon Banner */}
      <section className="mx-auto max-w-7xl px-6 pb-24">
        <div className="glass rounded-2xl border border-dashed border-indigo-500/30 p-12 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-indigo-400">
            Dashboard — Coming Soon
          </p>
          <p className="mt-3 text-2xl font-bold text-white">
            Analytics & insights are on the way
          </p>
          <p className="mt-2 text-sm text-gray-500">
            Connect your GitHub organization to start syncing repositories, pull requests, and
            engineering activity.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 px-6 py-6 text-center text-xs text-gray-600">
        © {new Date().getFullYear()} DevPulse. Built for engineering teams.
      </footer>
    </main>
  );
}
