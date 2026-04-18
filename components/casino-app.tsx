"use client";

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { supabase } from '@/lib/supabase';

type LogEntry = {
  game: string;
  detail: string;
  delta: number;
  balance_after: number;
  created_at?: string;
};

type Profile = {
  id: string;
  username: string | null;
  balance: number;
};

type GameKey = 'dice' | 'crash' | 'mines' | 'lobby';

type MinesState = {
  mines: number[];
  revealed: number[];
  lost: boolean;
  active: boolean;
};

const GRID_SIZE = 16;
const START_BALANCE = 1000;
const NAV_ITEMS = [
  { href: '/casino', label: 'Lobby', key: 'lobby', meta: 'Overview' },
  { href: '/casino/dice', label: 'Dice', key: 'dice', meta: 'Under / Over' },
  { href: '/casino/crash', label: 'Crash', key: 'crash', meta: 'Timing' },
  { href: '/casino/mines', label: 'Mines', key: 'mines', meta: 'Grid risk' },
] as const;

function randomBetween(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function formatCoin(n: number) {
  return Number(n).toFixed(2);
}

function makeMines(count: number) {
  const set = new Set<number>();
  while (set.size < count) set.add(Math.floor(Math.random() * GRID_SIZE));
  return Array.from(set);
}

export function CasinoApp({ game }: { game: GameKey }) {
  const pathname = usePathname();
  const [email, setEmail] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [balance, setBalance] = useState(START_BALANCE);
  const [bet, setBet] = useState(25);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [leaderboard, setLeaderboard] = useState<Profile[]>([]);

  const [diceTarget, setDiceTarget] = useState(52);
  const [diceLast, setDiceLast] = useState<number | null>(null);

  const [crashRunning, setCrashRunning] = useState(false);
  const [crashMultiplier, setCrashMultiplier] = useState(1);
  const [crashPoint, setCrashPoint] = useState<number | null>(null);
  const [crashAutoCashout, setCrashAutoCashout] = useState(1.8);
  const [crashBetPlaced, setCrashBetPlaced] = useState(false);
  const [crashResolved, setCrashResolved] = useState(false);

  const [mines, setMines] = useState<MinesState>({
    mines: makeMines(3),
    revealed: [],
    lost: false,
    active: false,
  });

  const safeReveals = mines.revealed.length;
  const minesCashoutMultiplier = useMemo(() => 1 + safeReveals * 0.28, [safeReveals]);
  const activeNav = NAV_ITEMS.find((item) => item.key === game) || NAV_ITEMS[0];

  async function loadLeaderboard() {
    const { data } = await supabase
      .from('profiles')
      .select('id, username, balance')
      .order('balance', { ascending: false })
      .limit(5);
    setLeaderboard((data as Profile[]) || []);
  }

  async function loadProfile() {
    const { data: auth } = await supabase.auth.getUser();
    const user = auth.user;
    if (!user) {
      setProfile(null);
      setBalance(START_BALANCE);
      setLogs([]);
      setSessionReady(true);
      await loadLeaderboard();
      return;
    }

    const { data: profileData } = await supabase
      .from('profiles')
      .select('id, username, balance')
      .eq('id', user.id)
      .single();

    if (profileData) {
      setProfile(profileData as Profile);
      setBalance(Number(profileData.balance));
    }

    const { data: rounds } = await supabase
      .from('game_rounds')
      .select('game, detail, delta, balance_after, created_at')
      .order('created_at', { ascending: false })
      .limit(8);

    setLogs((rounds as LogEntry[]) || []);
    setSessionReady(true);
    await loadLeaderboard();
  }

  useEffect(() => {
    loadProfile();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      loadProfile();
    });
    return () => subscription.unsubscribe();
  }, []);

  async function saveRound(gameName: string, detail: string, delta: number, nextBalance: number) {
    setLogs((prev) => [{ game: gameName, detail, delta, balance_after: nextBalance }, ...prev].slice(0, 8));
    if (!profile) return;
    await supabase.from('profiles').update({ balance: nextBalance }).eq('id', profile.id);
    await supabase.from('game_rounds').insert({
      user_id: profile.id,
      game: gameName,
      detail,
      delta,
      balance_after: nextBalance,
    });
    setProfile((prev) => (prev ? { ...prev, balance: nextBalance } : prev));
    await loadLeaderboard();
  }

  function updateBalance(delta: number, gameName: string, detail: string) {
    setBalance((prev) => {
      const next = Math.max(0, prev + delta);
      void saveRound(gameName, detail, delta, next);
      return next;
    });
  }

  function canBet() {
    return bet > 0 && bet <= balance;
  }

  async function signIn() {
    if (!email) return;
    setAuthLoading(true);
    await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
    setAuthLoading(false);
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  function rollDice() {
    if (!canBet()) return;
    const roll = Number(randomBetween(0, 100).toFixed(2));
    setDiceLast(roll);
    const won = roll < diceTarget;
    const payout = Number((bet * (99 / diceTarget)).toFixed(2));
    updateBalance(
      won ? payout - bet : -bet,
      'Dice',
      won ? `Rolled ${roll}, under ${diceTarget}` : `Rolled ${roll}, missed under ${diceTarget}`
    );
  }

  useEffect(() => {
    if (!crashRunning) return;
    const id = setInterval(() => {
      setCrashMultiplier((prev) => {
        const next = Number((prev + 0.06 + prev * 0.015).toFixed(2));
        if (crashPoint && next >= crashPoint) {
          clearInterval(id);
          setCrashRunning(false);
          setCrashResolved(true);
          if (crashBetPlaced) {
            updateBalance(-bet, 'Crash', `Crashed at ${crashPoint.toFixed(2)}x`);
            setCrashBetPlaced(false);
          }
          return crashPoint;
        }
        return next;
      });
    }, 120);
    return () => clearInterval(id);
  }, [crashRunning, crashPoint, crashBetPlaced, bet]);

  useEffect(() => {
    if (!crashRunning || !crashBetPlaced || crashResolved) return;
    if (crashMultiplier >= crashAutoCashout) cashOutCrash();
  }, [crashMultiplier, crashRunning, crashBetPlaced, crashResolved, crashAutoCashout]);

  function startCrash() {
    if (!canBet() || crashRunning) return;
    setCrashMultiplier(1);
    setCrashPoint(Number(randomBetween(1.1, 8).toFixed(2)));
    setCrashRunning(true);
    setCrashBetPlaced(true);
    setCrashResolved(false);
  }

  function cashOutCrash() {
    if (!crashRunning || !crashBetPlaced) return;
    setCrashRunning(false);
    setCrashBetPlaced(false);
    setCrashResolved(true);
    const profit = Number((bet * crashMultiplier - bet).toFixed(2));
    updateBalance(profit, 'Crash', `Cashed out at ${crashMultiplier.toFixed(2)}x`);
  }

  function startMines() {
    if (!canBet()) return;
    setMines({ mines: makeMines(3), revealed: [], lost: false, active: true });
  }

  function revealTile(index: number) {
    if (!mines.active || mines.revealed.includes(index) || mines.lost) return;
    if (mines.mines.includes(index)) {
      setMines((prev) => ({ ...prev, revealed: [...prev.revealed, index], lost: true, active: false }));
      updateBalance(-bet, 'Mines', 'Hit a mine');
      return;
    }
    setMines((prev) => ({ ...prev, revealed: [...prev.revealed, index] }));
  }

  function cashOutMines() {
    if (!mines.active || mines.lost || mines.revealed.length === 0) return;
    const payout = Number((bet * minesCashoutMultiplier).toFixed(2));
    updateBalance(payout - bet, 'Mines', `Cashed out after ${mines.revealed.length} safe picks`);
    setMines((prev) => ({ ...prev, active: false }));
  }

  function renderMain() {
    if (game === 'dice') {
      return (
        <article className="card page-card game-panel dice-theme">
          <div className="panel-banner">
            <div>
              <p className="eyebrow">Dice</p>
              <h2>Roll under</h2>
            </div>
            <span className="pill pill-bright">Fast</span>
          </div>
          <div className="feature-strip">
            <div><span>Chance</span><strong>{diceTarget}%</strong></div>
            <div><span>Potential feel</span><strong>Steady</strong></div>
            <div><span>Bet</span><strong>{formatCoin(bet)}</strong></div>
          </div>
          <label>
            Win if roll is under
            <input type="range" min="5" max="95" value={diceTarget} onChange={(e) => setDiceTarget(Number(e.target.value))} />
            <strong>{diceTarget}</strong>
          </label>
          <p className="muted">Classic fast dice loop. Tune probability, roll, and learn the payout curve.</p>
          <div className="result-box">{diceLast === null ? 'No roll yet' : `Last roll: ${diceLast}`}</div>
          <button className="primary action-big" onClick={rollDice}>Roll Dice</button>
        </article>
      );
    }

    if (game === 'crash') {
      return (
        <article className="card page-card game-panel crash-theme">
          <div className="panel-banner">
            <div>
              <p className="eyebrow">Crash</p>
              <h2>Ride the multiplier</h2>
            </div>
            <span className="pill pill-bright">Timing</span>
          </div>
          <div className="feature-strip">
            <div><span>Auto</span><strong>{crashAutoCashout.toFixed(2)}x</strong></div>
            <div><span>Status</span><strong>{crashRunning ? 'Live' : 'Idle'}</strong></div>
            <div><span>Bet</span><strong>{formatCoin(bet)}</strong></div>
          </div>
          <label>
            Auto cashout
            <input type="number" step="0.1" min="1.1" value={crashAutoCashout} onChange={(e) => setCrashAutoCashout(Number(e.target.value) || 1.1)} />
          </label>
          <div className="crash-display">{crashMultiplier.toFixed(2)}x</div>
          <p className="muted">The multiplier climbs until it suddenly crashes. Cash out in time.</p>
          <div className="button-row">
            <button className="primary action-big" onClick={startCrash} disabled={crashRunning}>Start Round</button>
            <button className="action-big" onClick={cashOutCrash} disabled={!crashRunning || !crashBetPlaced}>Cash Out</button>
          </div>
        </article>
      );
    }

    if (game === 'mines') {
      return (
        <article className="card page-card game-panel mines-theme">
          <div className="panel-banner">
            <div>
              <p className="eyebrow">Mines</p>
              <h2>Pick safe tiles</h2>
            </div>
            <span className="pill pill-bright">Risk</span>
          </div>
          <div className="feature-strip">
            <div><span>Safe picks</span><strong>{mines.revealed.length}</strong></div>
            <div><span>Multiplier</span><strong>{minesCashoutMultiplier.toFixed(2)}x</strong></div>
            <div><span>Bet</span><strong>{formatCoin(bet)}</strong></div>
          </div>
          <p className="muted">Three hidden mines on a 4x4 grid. Every safe click boosts your multiplier.</p>
          <div className="mines-grid">{Array.from({ length: GRID_SIZE }).map((_, index) => { const revealed = mines.revealed.includes(index); const isMine = mines.mines.includes(index); return <button key={index} className={`tile ${revealed ? (isMine ? 'mine' : 'safe') : ''}`} onClick={() => revealTile(index)} disabled={!mines.active || revealed || (!mines.active && !mines.lost)}>{revealed ? (isMine ? '✕' : '◆') : '?'}</button>; })}</div>
          <div className="button-row">
            <button className="primary action-big" onClick={startMines}>New Round</button>
            <button className="action-big" onClick={cashOutMines} disabled={!mines.active || mines.revealed.length === 0}>Cash Out</button>
          </div>
        </article>
      );
    }

    return (
      <>
        <section className="hero hero-lobby card">
          <div>
            <p className="eyebrow">Casino Lobby</p>
            <h2>Fake-money game floor</h2>
            <p className="muted">A multi-page training sandbox with separate routes, account persistence, and working game loops.</p>
          </div>
          <div className="hero-stats">
            <div><span>Games</span><strong>3</strong></div>
            <div><span>Profile</span><strong>{profile ? 'Saved' : 'Guest'}</strong></div>
            <div><span>Stack</span><strong>Next + Supabase</strong></div>
          </div>
        </section>
        <section className="promo-grid">
          <div className="card promo-card green-glow">
            <p className="eyebrow">Balance</p>
            <h3>{formatCoin(balance)} coins</h3>
            <p className="muted">Your fake wallet updates live and persists when signed in.</p>
          </div>
          <div className="card promo-card blue-glow">
            <p className="eyebrow">Accounts</p>
            <h3>{profile ? 'Magic link active' : 'Guest mode'}</h3>
            <p className="muted">Use email sign-in to save history and keep your balance across devices.</p>
          </div>
        </section>
        <section className="lobby-grid">
          {NAV_ITEMS.filter((item) => item.key !== 'lobby').map((item) => (
            <Link key={item.href} href={item.href} className="card lobby-card game-preview">
              <div>
                <p className="eyebrow">Game</p>
                <h3>{item.label}</h3>
                <p className="muted">Open the dedicated {item.label.toLowerCase()} page and play with your fake balance.</p>
              </div>
              <div className="preview-footer">
                <span className="subtle-tag">{item.meta}</span>
                <span className="pill pill-bright">Open</span>
              </div>
            </Link>
          ))}
        </section>
      </>
    );
  }

  return (
    <main className="casino-shell">
      <aside className="shell-sidebar">
        <div className="brand-block">
          <div className="brand-mark">O</div>
          <div>
            <p className="eyebrow">Orbit.bet</p>
            <h1>Casino</h1>
            <p className="muted">Separate game routes, fake balance, saved progress.</p>
          </div>
        </div>
        <nav className="nav-list">
          {NAV_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} className={`nav-link ${pathname === item.href ? 'active' : ''}`}>
              <span>{item.label}</span>
              <small>{item.meta}</small>
            </Link>
          ))}
        </nav>
        <div className="card compact-card wallet-card">
          <div className="wallet-row">
            <div>
              <p className="eyebrow">Wallet</p>
              <strong className="wallet-amount">{formatCoin(balance)}</strong>
            </div>
            <span className="wallet-badge">Fake</span>
          </div>
          <label>
            Bet size
            <input type="number" min="1" value={bet} onChange={(e) => setBet(Number(e.target.value) || 0)} />
          </label>
          <div className="quick-bets">
            {[10, 25, 50, 100].map((value) => <button key={value} onClick={() => setBet(value)}>{value}</button>)}
          </div>
        </div>
      </aside>

      <section className="shell-main">
        <header className="topbar card compact-card">
          <div>
            <p className="eyebrow">Now viewing</p>
            <h3 className="topbar-title">{activeNav.label}</h3>
            {sessionReady ? <p className="muted">{profile ? `Signed in as ${profile.username || 'player'}` : 'Guest mode'}</p> : <p className="muted">Loading...</p>}
          </div>
          <div className="topbar-actions">
            {profile ? (
              <button onClick={signOut}>Sign out</button>
            ) : (
              <>
                <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <button className="primary" onClick={signIn} disabled={authLoading}>{authLoading ? 'Sending...' : 'Magic link'}</button>
              </>
            )}
          </div>
        </header>

        <div className="content-grid">
          <section>{renderMain()}</section>
          <aside className="rail">
            <div className="card compact-card stream-card">
              <div className="stream-header">
                <p className="eyebrow">Live feed</p>
                <span className="live-dot">●</span>
              </div>
              <div className="stream-items">
                <div><strong>Dice</strong><span>Fast rounds are live</span></div>
                <div><strong>Crash</strong><span>Watch the multiplier curve</span></div>
                <div><strong>Mines</strong><span>Grid risk, manual cashout</span></div>
              </div>
            </div>
            <div className="card compact-card">
              <p className="eyebrow">Recent plays</p>
              <div className="logs">
                {logs.length === 0 ? <p className="muted">No rounds yet.</p> : logs.map((log, index) => <div key={index} className="log-row"><div><strong>{log.game}</strong><p>{log.detail}</p></div><span className={log.delta >= 0 ? 'win' : 'lose'}>{log.delta >= 0 ? '+' : ''}{formatCoin(log.delta)}</span></div>)}
              </div>
            </div>
            <div className="card compact-card">
              <p className="eyebrow">Leaderboard</p>
              <div className="leaderboard">
                {leaderboard.map((entry, index) => (
                  <div key={entry.id} className="leader-row">
                    <span>#{index + 1}</span>
                    <strong>{entry.username || 'player'}</strong>
                    <span>{formatCoin(entry.balance)}</span>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
