"use client";

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

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

type MinesState = {
  size: number;
  mines: number[];
  revealed: number[];
  lost: boolean;
  active: boolean;
};

const GRID_SIZE = 16;
const START_BALANCE = 1000;
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function randomBetween(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function formatCoin(n: number) {
  return n.toFixed(2);
}

function makeMines(count: number) {
  const set = new Set<number>();
  while (set.size < count) set.add(Math.floor(Math.random() * GRID_SIZE));
  return Array.from(set);
}

export default function Home() {
  const [email, setEmail] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [balance, setBalance] = useState(START_BALANCE);
  const [bet, setBet] = useState(25);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const [diceTarget, setDiceTarget] = useState(52);
  const [diceLast, setDiceLast] = useState<number | null>(null);

  const [crashRunning, setCrashRunning] = useState(false);
  const [crashMultiplier, setCrashMultiplier] = useState(1);
  const [crashPoint, setCrashPoint] = useState<number | null>(null);
  const [crashAutoCashout, setCrashAutoCashout] = useState(1.8);
  const [crashBetPlaced, setCrashBetPlaced] = useState(false);
  const [crashResolved, setCrashResolved] = useState(false);

  const [mines, setMines] = useState<MinesState>({
    size: GRID_SIZE,
    mines: makeMines(3),
    revealed: [],
    lost: false,
    active: false,
  });

  const safeReveals = mines.revealed.length;
  const minesCashoutMultiplier = useMemo(() => 1 + safeReveals * 0.28, [safeReveals]);

  async function loadProfile() {
    const { data: auth } = await supabase.auth.getUser();
    const user = auth.user;
    if (!user) {
      setProfile(null);
      setBalance(START_BALANCE);
      setLogs([]);
      setSessionReady(true);
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

  async function saveRound(game: string, detail: string, delta: number, nextBalance: number) {
    setLogs((prev) => [{ game, detail, delta, balance_after: nextBalance }, ...prev].slice(0, 8));
    if (!profile) return;

    await supabase.from('profiles').update({ balance: nextBalance }).eq('id', profile.id);
    await supabase.from('game_rounds').insert({
      user_id: profile.id,
      game,
      detail,
      delta,
      balance_after: nextBalance,
    });
    setProfile((prev) => (prev ? { ...prev, balance: nextBalance } : prev));
  }

  function updateBalance(delta: number, game: string, detail: string) {
    setBalance((prev) => {
      const next = Math.max(0, prev + delta);
      void saveRound(game, detail, delta, next);
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
    updateBalance(won ? payout - bet : -bet, 'Dice', won ? `Rolled ${roll}, under ${diceTarget}` : `Rolled ${roll}, missed under ${diceTarget}`);
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
    if (crashMultiplier >= crashAutoCashout) {
      cashOutCrash();
    }
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

  function resetMinesGame() {
    setMines({ size: GRID_SIZE, mines: makeMines(3), revealed: [], lost: false, active: false });
  }

  function startMines() {
    if (!canBet()) return;
    resetMinesGame();
    setMines((prev) => ({ ...prev, active: true }));
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

  return (
    <main className="page">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Prototype</p>
          <h1>Orbit.bet</h1>
          <p className="muted">Fake balance only. Built to learn the game loops by actually playing them.</p>
        </div>
        <div className="wallet card">
          <span>Balance</span>
          <strong>{formatCoin(balance)} coins</strong>
          <label>
            Bet size
            <input type="number" min="1" value={bet} onChange={(e) => setBet(Number(e.target.value) || 0)} />
          </label>
          <div className="quick-bets">
            {[10, 25, 50, 100].map((value) => (
              <button key={value} onClick={() => setBet(value)}>{value}</button>
            ))}
          </div>
        </div>
        <div className="card auth-card">
          <p className="eyebrow">Account</p>
          {!sessionReady ? (
            <p className="muted">Loading session...</p>
          ) : profile ? (
            <>
              <p className="muted">Signed in as <strong>{profile.username || 'player'}</strong></p>
              <button className="primary" onClick={signOut}>Sign out</button>
            </>
          ) : (
            <>
              <p className="muted">Use magic link login to save balance and history.</p>
              <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <button className="primary" onClick={signIn} disabled={authLoading}>{authLoading ? 'Sending...' : 'Send magic link'}</button>
            </>
          )}
        </div>
        <div className="card">
          <p className="eyebrow">Recent plays</p>
          <div className="logs">
            {logs.length === 0 ? <p className="muted">No rounds yet.</p> : logs.map((log, index) => (
              <div key={index} className="log-row">
                <div>
                  <strong>{log.game}</strong>
                  <p>{log.detail}</p>
                </div>
                <span className={log.delta >= 0 ? 'win' : 'lose'}>{log.delta >= 0 ? '+' : ''}{formatCoin(Number(log.delta))}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <section className="content">
        <div className="hero card">
          <div>
            <p className="eyebrow">Live prototype</p>
            <h2>Simple casino-style training sandbox</h2>
            <p className="muted">Working fake-money versions of Dice, Crash, and Mines. Now with Supabase-backed account persistence.</p>
          </div>
          <div className="hero-stats">
            <div><span>Games</span><strong>3</strong></div>
            <div><span>Mode</span><strong>Fake</strong></div>
            <div><span>Storage</span><strong>Supabase</strong></div>
          </div>
        </div>

        <div className="games-grid">
          <article className="card game-card">
            <div className="card-top">
              <div>
                <p className="eyebrow">Dice</p>
                <h3>Roll under</h3>
              </div>
              <span className="pill">Fast</span>
            </div>
            <label>
              Win if roll is under
              <input type="range" min="5" max="95" value={diceTarget} onChange={(e) => setDiceTarget(Number(e.target.value))} />
              <strong>{diceTarget}</strong>
            </label>
            <p className="muted">Higher chance means lower payout. Same core loop as classic dice games.</p>
            <div className="result-box">{diceLast === null ? 'No roll yet' : `Last roll: ${diceLast}`}</div>
            <button className="primary" onClick={rollDice}>Roll Dice</button>
          </article>

          <article className="card game-card">
            <div className="card-top">
              <div>
                <p className="eyebrow">Crash</p>
                <h3>Ride the multiplier</h3>
              </div>
              <span className="pill">Timing</span>
            </div>
            <label>
              Auto cashout
              <input type="number" step="0.1" min="1.1" value={crashAutoCashout} onChange={(e) => setCrashAutoCashout(Number(e.target.value) || 1.1)} />
            </label>
            <div className="crash-display">{crashMultiplier.toFixed(2)}x</div>
            <p className="muted">Start a run, then cash out before the hidden crash point hits.</p>
            <div className="button-row">
              <button className="primary" onClick={startCrash} disabled={crashRunning}>Start</button>
              <button onClick={cashOutCrash} disabled={!crashRunning || !crashBetPlaced}>Cash Out</button>
            </div>
          </article>

          <article className="card game-card mines-card">
            <div className="card-top">
              <div>
                <p className="eyebrow">Mines</p>
                <h3>Pick safe tiles</h3>
              </div>
              <span className="pill">Risk</span>
            </div>
            <p className="muted">Three hidden mines on a 4x4 board. Each safe reveal increases your cashout multiplier.</p>
            <div className="mines-meta">
              <span>Safe picks: {mines.revealed.length}</span>
              <strong>{minesCashoutMultiplier.toFixed(2)}x</strong>
            </div>
            <div className="mines-grid">
              {Array.from({ length: GRID_SIZE }).map((_, index) => {
                const revealed = mines.revealed.includes(index);
                const isMine = mines.mines.includes(index);
                return (
                  <button
                    key={index}
                    className={`tile ${revealed ? (isMine ? 'mine' : 'safe') : ''}`}
                    onClick={() => revealTile(index)}
                    disabled={!mines.active || revealed || (!mines.active && !mines.lost)}
                  >
                    {revealed ? (isMine ? '✕' : '◆') : '?'}
                  </button>
                );
              })}
            </div>
            <div className="button-row">
              <button className="primary" onClick={startMines}>New Round</button>
              <button onClick={cashOutMines} disabled={!mines.active || mines.revealed.length === 0}>Cash Out</button>
            </div>
          </article>
        </div>
      </section>
    </main>
  );
}
