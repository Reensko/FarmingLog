import { useState, useEffect, useRef, useCallback } from "react";

const formatTime = (ms) => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m % 60)}:${pad(s % 60)}`;
};

const formatMs = (ms) => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

const formatNum = (n) => {
  if (n === null || n === undefined || isNaN(n)) return "0";
  return Math.round(n).toLocaleString("de-DE");
};

// === WALL DATA (verified Nov 2025 / April 2026 patch) ===
// Cost to upgrade FROM level L TO level L+1
const WALL_COST_TABLE = {
  1: 1_000, 2: 5_000, 3: 10_000, 4: 20_000, 5: 30_000,
  6: 50_000, 7: 75_000, 8: 100_000, 9: 200_000, 10: 500_000,
  11: 1_000_000, 12: 1_500_000, 13: 2_000_000, 14: 3_000_000,
  15: 4_000_000, 16: 5_000_000, 17: 7_000_000, 18: 10_000_000,
};
// Number of wall pieces available at each Town Hall level
const TH_WALL_COUNTS = {
  1: 0, 2: 25, 3: 50, 4: 75, 5: 100, 6: 125, 7: 175,
  8: 225, 9: 250, 10: 275, 11: 300, 12: 300, 13: 300, 14: 300,
  15: 325, 16: 325, 17: 325, 18: 325,
};
// Highest wall level upgradable at each TH
const TH_MAX_WALL_LEVEL = {
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 10,
  10: 11, 11: 12, 12: 13, 13: 14, 14: 15, 15: 16,
  16: 17, 17: 18, 18: 19,
};
// Caps on how many walls may exist at a given level (April 2026: max 200 walls on L19 at TH18)
const WALL_LEVEL_CAPS = { 18: { 19: 200 } };
const MAX_WALL_LEVEL = 19;
const ELIXIR_ALLOWED_FROM = 5; // Walls of L5+ can be upgraded with elixir OR gold

const TOTAL_WALLS_DEFAULT = 325; // For migration of old saves
const WALL_COST = 10_000_000;    // Legacy reference (L18→L19), kept for backwards compat

// Returns {gold, goldOrElixir} cost to upgrade ONE wall from `fromLevel` to `toLevel`
const costPerWall = (fromLevel, toLevel) => {
  let gold = 0, goldOrElixir = 0;
  for (let L = fromLevel; L < toLevel; L++) {
    const c = WALL_COST_TABLE[L] || 0;
    if (L >= ELIXIR_ALLOWED_FROM) goldOrElixir += c;
    else gold += c;
  }
  return { gold, goldOrElixir };
};

// Cost to upgrade the entire wall distribution to fully-maxed at given TH level
// Respects level caps (e.g., TH18: only 200 walls may reach L19)
const computeWallCostRemaining = (wallsByLevel, thLevel) => {
  const maxLevel = TH_MAX_WALL_LEVEL[thLevel] || MAX_WALL_LEVEL;
  const caps = WALL_LEVEL_CAPS[thLevel] || {};
  const capAtMax = caps[maxLevel];
  const subTarget = capAtMax === undefined ? maxLevel : maxLevel - 1;

  let gold = 0, goldOrElixir = 0;
  // Bring everything below subTarget up to subTarget
  for (let L = 1; L < subTarget; L++) {
    const count = wallsByLevel[L] || 0;
    if (count === 0) continue;
    for (let step = L; step < subTarget; step++) {
      const c = (WALL_COST_TABLE[step] || 0) * count;
      if (step >= ELIXIR_ALLOWED_FROM) goldOrElixir += c;
      else gold += c;
    }
  }
  // If cap exists: take walls now at subTarget and upgrade as many as cap allows to maxLevel
  if (capAtMax !== undefined) {
    let availableAtSubTarget = wallsByLevel[subTarget] || 0;
    for (let L = 1; L < subTarget; L++) availableAtSubTarget += wallsByLevel[L] || 0;
    const currentAtMax = wallsByLevel[maxLevel] || 0;
    const slotsLeft = Math.max(0, capAtMax - currentAtMax);
    const willUpgrade = Math.min(slotsLeft, availableAtSubTarget);
    const c = (WALL_COST_TABLE[subTarget] || 0) * willUpgrade;
    if (subTarget >= ELIXIR_ALLOWED_FROM) goldOrElixir += c;
    else gold += c;
  }
  return { gold, goldOrElixir, total: gold + goldOrElixir };
};

// Total wall-upgrade steps possible for a TH (with caps)
const totalUpgradeStepsForTH = (thLevel) => {
  const maxLevel = TH_MAX_WALL_LEVEL[thLevel] || MAX_WALL_LEVEL;
  const total = TH_WALL_COUNTS[thLevel] || 0;
  const caps = WALL_LEVEL_CAPS[thLevel] || {};
  const capAtMax = caps[maxLevel];
  if (capAtMax === undefined) return total * (maxLevel - 1);
  return capAtMax * (maxLevel - 1) + (total - capAtMax) * (maxLevel - 2);
};

// Upgrade-steps already completed across all walls
const completedUpgradeSteps = (wallsByLevel) => {
  let done = 0;
  for (const L in wallsByLevel) done += (wallsByLevel[L] || 0) * (parseInt(L) - 1);
  return done;
};

const sumWalls = (wallsByLevel) => Object.values(wallsByLevel).reduce((a, b) => a + (b || 0), 0);

const PHASES = { SETUP: "setup", COUNTDOWN: "countdown", RUNNING: "running", PAUSED: "paused", PAUSED_SPEND_BEFORE: "paused_spend_before", PAUSED_SPEND_AFTER: "paused_spend_after", RESULTS: "results", HISTORY: "history", WALLS: "walls", STATS: "stats", BACKUP: "backup", HELP: "help", GOALS: "goals", SETTINGS: "settings" };

const STORAGE_KEY = "coc-tracker-sessions";
const WALLS_KEY = "coc-tracker-walls";
const GOALS_KEY = "coc-tracker-goals";
const SETTINGS_KEY = "coc-tracker-settings";

// === STORAGE ADAPTER ===
// Drop-in replacement for storage (Claude's chat environment API).
// Uses browser localStorage when running standalone (e.g. as a PWA, GitHub Pages),
// but falls back to storage if it exists (so the app keeps working in Claude).
// All methods are async-compatible so existing `await` calls don't need to change.
const storage = (() => {
  // Prefer window.storage when available (chat environment)
  const hasWindowStorage = typeof window !== "undefined" && window.storage && typeof window.storage.get === "function";
  if (hasWindowStorage) {
    return window.storage;
  }
  // Fallback: localStorage adapter
  const ls = typeof window !== "undefined" ? window.localStorage : null;
  return {
    async get(key) {
      if (!ls) return null;
      try {
        const value = ls.getItem(key);
        return value === null ? null : { value };
      } catch (e) { return null; }
    },
    async set(key, value) {
      if (!ls) return;
      try { ls.setItem(key, value); } catch (e) {}
    },
    async delete(key) {
      if (!ls) return;
      try { ls.removeItem(key); } catch (e) {}
    },
  };
})();

// === THEMES ===
// Each theme defines the three accent colors used throughout the app:
// primary (gold-ish), secondary (purple-ish, used for elixir/contrast), wall (bronze-ish)
const THEMES = {
  classic: {
    name: "Royal Gold",
    primary: "#FFD700", primaryDark: "#FFA500", primaryGradient: "linear-gradient(135deg, #FFD700, #FFA500, #FFD700)",
    secondary: "#E84CFF", secondaryGradient: "linear-gradient(135deg, #E84CFF, #B936FF)",
    accent: "#3DD6F5",
    wall: "#b08d57", wallDark: "#8B6914", wallLight: "#d4a843",
    bg: "radial-gradient(ellipse at top, #1a0a2e 0%, #0a0514 100%)",
  },
  emerald: {
    name: "Emerald Knight",
    primary: "#00E676", primaryDark: "#00A86B", primaryGradient: "linear-gradient(135deg, #00E676, #00A86B, #00E676)",
    secondary: "#FF6B9D", secondaryGradient: "linear-gradient(135deg, #FF6B9D, #C44569)",
    accent: "#FFD93D",
    wall: "#8FBC8F", wallDark: "#556B2F", wallLight: "#9ACD32",
    bg: "radial-gradient(ellipse at top, #0a2818 0%, #050f0a 100%)",
  },
  crimson: {
    name: "Crimson Lord",
    primary: "#FF4757", primaryDark: "#C81E2C", primaryGradient: "linear-gradient(135deg, #FF6B7A, #FF4757, #FF6B7A)",
    secondary: "#FFA502", secondaryGradient: "linear-gradient(135deg, #FFA502, #FF6348)",
    accent: "#70A1FF",
    wall: "#A0522D", wallDark: "#8B4513", wallLight: "#CD853F",
    bg: "radial-gradient(ellipse at top, #2a0a14 0%, #14050a 100%)",
  },
  ocean: {
    name: "Ocean Mage",
    primary: "#3DD6F5", primaryDark: "#0288D1", primaryGradient: "linear-gradient(135deg, #3DD6F5, #0288D1, #3DD6F5)",
    secondary: "#9D4EDD", secondaryGradient: "linear-gradient(135deg, #9D4EDD, #6A1B9A)",
    accent: "#FFD700",
    wall: "#5D87A1", wallDark: "#34495E", wallLight: "#85B4D1",
    bg: "radial-gradient(ellipse at top, #0a1830 0%, #050a18 100%)",
  },
  midnight: {
    name: "Midnight Stealth",
    primary: "#C9B458", primaryDark: "#8B7E2B", primaryGradient: "linear-gradient(135deg, #C9B458, #8B7E2B, #C9B458)",
    secondary: "#7B8FA1", secondaryGradient: "linear-gradient(135deg, #7B8FA1, #4E5D6C)",
    accent: "#A8B5C8",
    wall: "#6D6D6D", wallDark: "#3D3D3D", wallLight: "#9D9D9D",
    bg: "radial-gradient(ellipse at top, #15151a 0%, #050505 100%)",
  },
};

const LootInput = ({ value, onChange, label, disabled }) => {
  const c = label === "Gold" ? "#FFD700" : label === "Elixir" ? "#E84CFF" : "#3DD6F5";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: c, fontFamily: "'Cinzel', serif", fontWeight: 700 }}>{label}</label>
      <input type="number" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder="0"
        style={{ background: "rgba(0,0,0,0.5)", border: `1px solid ${c}33`, borderRadius: 8, padding: "10px 14px", color: "#fff", fontSize: 18, fontFamily: "'Oswald', sans-serif", outline: "none", width: "100%", boxSizing: "border-box", transition: "border-color 0.2s" }}
        onFocus={(e) => e.target.style.borderColor = c} onBlur={(e) => e.target.style.borderColor = `${c}33`} />
    </div>
  );
};

const StatCard = ({ label, gold, elixir, dark }) => (
  <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: "14px 18px", border: "1px solid rgba(255,215,0,0.1)" }}>
    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "rgba(255,255,255,0.5)", marginBottom: 10, fontFamily: "'Cinzel', serif" }}>{label}</div>
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#FFD700", fontSize: 13 }}>Gold</span><span style={{ color: "#FFD700", fontFamily: "'Oswald', sans-serif", fontSize: 17 }}>{formatNum(gold)}</span></div>
      <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#E84CFF", fontSize: 13 }}>Elixir</span><span style={{ color: "#E84CFF", fontFamily: "'Oswald', sans-serif", fontSize: 17 }}>{formatNum(elixir)}</span></div>
      <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#3DD6F5", fontSize: 13 }}>Dunkles</span><span style={{ color: "#3DD6F5", fontFamily: "'Oswald', sans-serif", fontSize: 17 }}>{formatNum(dark)}</span></div>
    </div>
  </div>
);

const Btn = ({ children, onClick, color = "#FFD700", secondary, small, disabled, style: xs }) => (
  <button onClick={onClick} disabled={disabled} style={{
    background: secondary ? "transparent" : disabled ? "rgba(255,255,255,0.1)" : color,
    color: secondary ? color : disabled ? "rgba(255,255,255,0.3)" : "#1a0f00",
    border: secondary ? `1px solid ${color}` : "none", borderRadius: 8,
    padding: small ? "6px 14px" : "12px 24px", fontSize: small ? 13 : 15,
    fontFamily: "'Cinzel', serif", fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
    transition: "all 0.2s", letterSpacing: 1, ...xs,
  }}>{children}</button>
);

// SVG sparkline – tiny inline trend chart
const SparkLine = ({ data, color = "#FFD700", width = 80, height = 24, fill = true }) => {
  if (!data || data.length === 0) return null;
  if (data.length === 1) {
    return (
      <svg width={width} height={height} style={{ display: "block" }}>
        <circle cx={width / 2} cy={height / 2} r={2} fill={color} />
      </svg>
    );
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = height - 2 - ((v - min) / range) * (height - 4);
    return [x, y];
  });
  const pathD = points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const areaD = `${pathD} L ${width} ${height} L 0 ${height} Z`;
  const lastValue = data[data.length - 1];
  const trendUp = lastValue >= data[0];
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {fill && <path d={areaD} fill={color} opacity={0.15} />}
      <path d={pathD} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={points[points.length - 1][0]} cy={points[points.length - 1][1]} r={2} fill={trendUp ? "#00ff64" : "#ff6b6b"} />
    </svg>
  );
};

// Bar chart for comparing values (e.g., "this session vs average")
const ComparisonBar = ({ label, current, average, color = "#FFD700", suffix = "" }) => {
  const pct = average > 0 ? (current / average) * 100 : 0;
  const diffPct = average > 0 ? ((current - average) / average) * 100 : 0;
  const isUp = diffPct >= 0;
  const cappedWidth = Math.min(150, pct); // visual cap at 150%
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>{label}</span>
        <span style={{ fontSize: 12, fontFamily: "'Oswald', sans-serif", color: isUp ? "#00ff64" : "#ff6b6b", fontWeight: 700 }}>
          {isUp ? "▲" : "▼"} {Math.abs(diffPct).toFixed(0)}%
        </span>
      </div>
      <div style={{ position: "relative", height: 6, background: "rgba(255,255,255,0.05)", borderRadius: 3, overflow: "visible" }}>
        {/* Average reference line at 100% */}
        <div style={{ position: "absolute", left: `${(100 / 150) * 100}%`, top: -2, bottom: -2, width: 1, background: "rgba(255,255,255,0.3)" }} />
        <div style={{ height: "100%", width: `${(cappedWidth / 150) * 100}%`, background: color, borderRadius: 3, transition: "width 0.4s ease" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "'Oswald', sans-serif" }}>
        <span>Diese: {formatNum(current)}{suffix}</span>
        <span>Ø: {formatNum(average)}{suffix}</span>
      </div>
    </div>
  );
};

// Bar chart for per-lap durations – shows distribution of attack times
const LapBarChart = ({ laps, color = "#FFD700" }) => {
  if (!laps || laps.length === 0) return null;
  const durations = laps.map((l) => l.duration);
  const maxDur = Math.max(...durations);
  const minDur = Math.min(...durations);
  const avgDur = durations.reduce((a, b) => a + b, 0) / durations.length;
  // Format ms compactly for axis labels
  const fmt = (ms) => {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  return (
    <div style={{ width: "100%", padding: "8px 0" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 80, position: "relative", paddingBottom: 18 }}>
        {/* Average reference line */}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: `${18 + (avgDur / maxDur) * 62}px`, height: 1, background: "rgba(255,255,255,0.2)", zIndex: 1 }}>
          <span style={{ position: "absolute", right: 0, top: -14, fontSize: 9, color: "rgba(255,255,255,0.5)", fontFamily: "'Oswald', sans-serif", background: "rgba(0,0,0,0.5)", padding: "1px 4px", borderRadius: 2 }}>Ø {fmt(avgDur)}</span>
        </div>
        {laps.map((lap, i) => {
          const h = (lap.duration / maxDur) * 62;
          const isFast = lap.duration === minDur && laps.length > 1;
          const isSlow = lap.duration === maxDur && laps.length > 1;
          return (
            <div key={lap.id || i} style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", alignItems: "center", minWidth: 0 }}>
              <div title={`Lap ${i + 1}: ${fmt(lap.duration)}`}
                style={{
                  width: "100%",
                  height: `${h}px`,
                  borderRadius: "3px 3px 0 0",
                  background: isFast ? "linear-gradient(180deg, #00ff64, #00a040)"
                    : isSlow ? "linear-gradient(180deg, #ff6b6b, #c92a2a)"
                    : `linear-gradient(180deg, ${color}, ${color}77)`,
                  transition: "height 0.4s ease",
                  cursor: "default",
                }} />
              <span style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", fontFamily: "'Oswald', sans-serif", position: "absolute", bottom: 0, whiteSpace: "nowrap" }}>{i + 1}</span>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "'Oswald', sans-serif", marginTop: 4 }}>
        <span>Schnellster: <span style={{ color: "#00ff64" }}>{fmt(minDur)}</span></span>
        <span>Ø {fmt(avgDur)}</span>
        <span>Langsamster: <span style={{ color: "#ff6b6b" }}>{fmt(maxDur)}</span></span>
      </div>
    </div>
  );
};

// Compact wall-distribution row (used in wall editor / display)
const wallLevelColor = (L) => {
  // Gradient from bronze→gold→amber as level increases
  if (L >= 17) return "#d4a843"; // amber gold
  if (L >= 13) return "#b08d57"; // bronze
  if (L >= 9) return "#8B6914";  // dark gold
  if (L >= 5) return "#6b5028";  // olive bronze
  return "#4a3a1f";              // muted brown
};

export default function CoCTracker() {
  const [phase, setPhase] = useState(PHASES.SETUP);
  const [startLoot, setStartLoot] = useState({ gold: "", elixir: "", dark: "" });
  const [endLoot, setEndLoot] = useState({ gold: "", elixir: "", dark: "" });
  const [spendLoot, setSpendLoot] = useState({ gold: "", elixir: "", dark: "" });
  const [preSpendLoot, setPreSpendLoot] = useState({ gold: "", elixir: "", dark: "" });
  const [laps, setLaps] = useState([]);
  const [elapsed, setElapsed] = useState(0);
  const [currentLapTime, setCurrentLapTime] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [viewingSession, setViewingSession] = useState(null);
  const [spendEvents, setSpendEvents] = useState([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [toast, setToast] = useState(null);
  const [countdownValue, setCountdownValue] = useState(3);
  // Theme & settings
  const [themeName, setThemeName] = useState("classic");
  const theme = THEMES[themeName] || THEMES.classic;
  // Goals: { daily: { gold, elixir, dark }, weekly: { gold, elixir, dark } }
  const [goals, setGoals] = useState({ daily: { gold: 0, elixir: 0, dark: 0 }, weekly: { gold: 0, elixir: 0, dark: 0 } });
  const [editingGoals, setEditingGoals] = useState(false);
  const [goalsDraft, setGoalsDraft] = useState(null);
  // Long-session warning settings (in minutes)
  const [longSessionWarnMin, setLongSessionWarnMin] = useState(120);
  const [longSessionWarnDismissed, setLongSessionWarnDismissed] = useState(false);
  // OCR state: which input group is currently scanning ("start" | "preSpend" | "spend" | "end" | null)
  const [ocrScanning, setOcrScanning] = useState(null);
  const [ocrProgress, setOcrProgress] = useState(0);
  const tesseractLoadingRef = useRef(null); // Caches loader promise to avoid double-loads
  const [wallsDone, setWallsDone] = useState(28); // Legacy: kept for backwards-compat with wallLog UI display
  const [wallLog, setWallLog] = useState([]);
  const [thLevel, setThLevel] = useState(18);
  // Default: a TH18 player with 28 walls on L19 and the rest on L18
  const [wallsByLevel, setWallsByLevel] = useState({ 18: 297, 19: 28 });
  const [editingWalls, setEditingWalls] = useState(false);
  const [draftWalls, setDraftWalls] = useState(null); // For edit mode

  const startTimeRef = useRef(null);
  const pauseAccumRef = useRef(0);
  const lastLapTimeRef = useRef(0);
  const timerRef = useRef(null);
  const pauseStartRef = useRef(null);

  // Load from storage (with migration of old shape)
  useEffect(() => {
    (async () => {
      try {
        const result = await storage.get(STORAGE_KEY);
        if (result && result.value) setSessions(JSON.parse(result.value));
      } catch (e) {}
      try {
        const wResult = await storage.get(WALLS_KEY);
        if (wResult && wResult.value) {
          const parsed = JSON.parse(wResult.value);
          // Migration: old format had {done: N, log: [...]}, new format has {thLevel, wallsByLevel, log}
          if (parsed.wallsByLevel) {
            setThLevel(parsed.thLevel || 18);
            setWallsByLevel(parsed.wallsByLevel);
            setWallsDone(parsed.wallsByLevel[19] || 0);
            setWallLog(parsed.log ?? []);
          } else if (typeof parsed.done === "number") {
            // Legacy migration: assume TH18, treat `done` as L19 count, rest are L18
            const done = parsed.done;
            const migrated = { 18: TOTAL_WALLS_DEFAULT - done, 19: done };
            setThLevel(18);
            setWallsByLevel(migrated);
            setWallsDone(done);
            setWallLog(parsed.log ?? []);
          }
        }
      } catch (e) {}
      // Load goals
      try {
        const gResult = await storage.get(GOALS_KEY);
        if (gResult && gResult.value) {
          const parsed = JSON.parse(gResult.value);
          if (parsed.daily && parsed.weekly) setGoals(parsed);
        }
      } catch (e) {}
      // Load settings (theme, warn minutes)
      try {
        const sResult = await storage.get(SETTINGS_KEY);
        if (sResult && sResult.value) {
          const parsed = JSON.parse(sResult.value);
          if (parsed.themeName && THEMES[parsed.themeName]) setThemeName(parsed.themeName);
          if (typeof parsed.longSessionWarnMin === "number") setLongSessionWarnMin(parsed.longSessionWarnMin);
        }
      } catch (e) {}
    })();
  }, []);

  // Persist goals when they change (after initial load)
  const saveGoals = async (newGoals) => {
    setGoals(newGoals);
    try { await storage.set(GOALS_KEY, JSON.stringify(newGoals)); } catch (e) {}
  };

  // Persist settings (theme, warn-minute pref)
  const saveSettings = async (patch) => {
    const next = { themeName, longSessionWarnMin, ...patch };
    if (patch.themeName !== undefined) setThemeName(patch.themeName);
    if (patch.longSessionWarnMin !== undefined) setLongSessionWarnMin(patch.longSessionWarnMin);
    try { await storage.set(SETTINGS_KEY, JSON.stringify(next)); } catch (e) {}
  };

  const saveSessions = async (newSessions) => {
    setSessions(newSessions);
    try { await storage.set(STORAGE_KEY, JSON.stringify(newSessions)); } catch (e) {}
  };

  const saveWalls = async (newWallsByLevel, log, newThLevel = thLevel) => {
    setWallsByLevel(newWallsByLevel);
    setWallLog(log);
    setThLevel(newThLevel);
    setWallsDone(newWallsByLevel[TH_MAX_WALL_LEVEL[newThLevel] || MAX_WALL_LEVEL] || 0);
    try {
      await storage.set(WALLS_KEY, JSON.stringify({
        thLevel: newThLevel,
        wallsByLevel: newWallsByLevel,
        log
      }));
    } catch (e) {}
  };

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  };

  // Lazy-load Tesseract.js from CDN. Cached via ref so multiple scans reuse it.
  const loadTesseract = () => {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractLoadingRef.current) return tesseractLoadingRef.current;
    tesseractLoadingRef.current = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/tesseract.js@5/dist/tesseract.min.js";
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => { tesseractLoadingRef.current = null; reject(new Error("Tesseract konnte nicht geladen werden")); };
      document.head.appendChild(script);
    });
    return tesseractLoadingRef.current;
  };

  // Extract candidate numbers from OCR text (handles 1.234.567, 1,234,567, 1234567)
  const extractNumbersFromOcr = (text) => {
    // Match groups of digits possibly separated by . or , as thousands separators
    const matches = text.match(/\d{1,3}(?:[.,]\d{3})+|\d{2,}/g) || [];
    const nums = matches
      .map((m) => parseInt(m.replace(/[.,]/g, ""), 10))
      .filter((n) => !isNaN(n) && n >= 100); // ignore tiny noise like trophy counts, lvl numbers
    return nums;
  };

  // Run OCR on an uploaded image file and fill the target loot inputs.
  // target: "start" | "preSpend" | "spend" | "end"
  const scanLootImage = async (file, target) => {
    if (!file) return;
    setOcrScanning(target);
    setOcrProgress(0);
    try {
      const Tess = await loadTesseract();
      const { data } = await Tess.recognize(file, "eng", {
        logger: (m) => {
          if (m.status === "recognizing text") setOcrProgress(Math.round(m.progress * 100));
        },
      });
      const nums = extractNumbersFromOcr(data.text || "");
      if (nums.length === 0) {
        showToast("Keine Zahlen erkannt – versuch's mit klarerem Screenshot");
        return;
      }
      // CoC standard order in loot displays: Gold, Elixir, Dark Elixir.
      // Dark Elixir is usually much smaller (often < 5000) – use that to disambiguate if 3+ numbers.
      let gold = "", elixir = "", dark = "";
      if (nums.length === 1) {
        gold = String(nums[0]);
      } else if (nums.length === 2) {
        gold = String(nums[0]); elixir = String(nums[1]);
      } else {
        // Take first 3 in order; if 3rd is much larger than typical DE, still take it (user can correct)
        gold = String(nums[0]); elixir = String(nums[1]); dark = String(nums[2]);
      }
      const setterMap = {
        start: setStartLoot,
        preSpend: setPreSpendLoot,
        spend: setSpendLoot,
        end: setEndLoot,
      };
      const setter = setterMap[target];
      if (setter) setter({ gold, elixir, dark });
      showToast(`Erkannt: G ${formatNum(parseInt(gold) || 0)} | E ${formatNum(parseInt(elixir) || 0)} | DE ${formatNum(parseInt(dark) || 0)}`);
    } catch (e) {
      showToast("OCR-Fehler: " + (e.message || "unbekannt"));
    } finally {
      setOcrScanning(null);
      setOcrProgress(0);
    }
  };

  // Small inline scan button that opens a file picker for the given loot target
  const ScanButton = ({ target, label = "📷 Screenshot scannen" }) => {
    const inputId = `ocr-input-${target}`;
    const isThis = ocrScanning === target;
    const isOther = ocrScanning && !isThis;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <input id={inputId} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) scanLootImage(f, target); e.target.value = ""; }} />
        <label htmlFor={inputId} style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px",
          background: isThis ? "rgba(232,76,255,0.15)" : "rgba(255,215,0,0.08)",
          border: `1px solid ${isThis ? "rgba(232,76,255,0.4)" : "rgba(255,215,0,0.25)"}`,
          borderRadius: 8, cursor: isOther ? "not-allowed" : "pointer", opacity: isOther ? 0.4 : 1,
          fontSize: 12, fontFamily: "'Cinzel', serif", letterSpacing: 1, color: isThis ? "#E84CFF" : "#FFD700",
          fontWeight: 700, transition: "all 0.2s", pointerEvents: isOther ? "none" : "auto",
        }}>
          {isThis ? `🔍 Scanne… ${ocrProgress}%` : label}
        </label>
        {!ocrScanning && (
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>Auto-Erkennung</span>
        )}
      </div>
    );
  };

  // Timer loop
  useEffect(() => {
    if (phase === PHASES.RUNNING && !isPaused) {
      timerRef.current = setInterval(() => {
        const now = Date.now();
        const total = now - startTimeRef.current - pauseAccumRef.current;
        setElapsed(total);
        setCurrentLapTime(now - startTimeRef.current - pauseAccumRef.current - lastLapTimeRef.current);
      }, 50);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [phase, isPaused]);

  const startSession = () => {
    const g = parseInt(startLoot.gold) || 0;
    const e = parseInt(startLoot.elixir) || 0;
    const d = parseInt(startLoot.dark) || 0;
    if (g === 0 && e === 0 && d === 0) {
      showToast("Trage mindestens einen Loot-Wert ein!");
      return;
    }
    // Enter pre-session countdown so the user can switch to the game
    setCountdownValue(3);
    setPhase(PHASES.COUNTDOWN);
  };

  // Called when countdown finishes (or is skipped) – actually starts the timer
  const beginRunning = () => {
    startTimeRef.current = Date.now();
    pauseAccumRef.current = 0;
    lastLapTimeRef.current = 0;
    setLaps([]);
    setSpendEvents([]);
    setElapsed(0);
    setCurrentLapTime(0);
    setIsPaused(false);
    setLongSessionWarnDismissed(false); // Fresh session = warning eligible again
    setPhase(PHASES.RUNNING);
  };

  // Countdown tick: 3 → 2 → 1 → GO! → RUNNING
  useEffect(() => {
    if (phase !== PHASES.COUNTDOWN) return;
    if (countdownValue <= 0) {
      // "GO!" shown for ~500ms, then transition
      const t = setTimeout(beginRunning, 500);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setCountdownValue((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdownValue]);

  const addLap = useCallback(() => {
    if (phase !== PHASES.RUNNING || isPaused) return;
    const now = Date.now();
    const totalElapsed = now - startTimeRef.current - pauseAccumRef.current;
    const lapDuration = totalElapsed - lastLapTimeRef.current;
    if (lapDuration < 1000) return;
    setLaps((prev) => [...prev, { id: Date.now(), duration: lapDuration, timestamp: totalElapsed }]);
    lastLapTimeRef.current = totalElapsed;
    setCurrentLapTime(0);
  }, [phase, isPaused]);

  const removeLap = (idx) => {
    setLaps((prev) => {
      const next = [...prev];
      next.splice(idx, 1);
      for (let i = idx; i < next.length; i++) {
        if (i === 0) next[i].duration = next[i].timestamp;
        else next[i].duration = next[i].timestamp - next[i - 1].timestamp;
      }
      lastLapTimeRef.current = next.length > 0 ? next[next.length - 1].timestamp : 0;
      return next;
    });
    showToast("Lap entfernt!");
  };

  const togglePause = () => {
    if (phase === PHASES.PAUSED) {
      // Resume from general pause
      pauseAccumRef.current += Date.now() - pauseStartRef.current;
      setIsPaused(false);
      setPhase(PHASES.RUNNING);
    } else if (phase === PHASES.RUNNING) {
      pauseStartRef.current = Date.now();
      setIsPaused(true);
      setPhase(PHASES.PAUSED);
    }
  };

  const startSpendFlow = () => {
    // Can be triggered from RUNNING or PAUSED
    if (phase === PHASES.RUNNING) {
      pauseStartRef.current = Date.now();
      setIsPaused(true);
    }
    setPreSpendLoot({ gold: "", elixir: "", dark: "" });
    setSpendLoot({ gold: "", elixir: "", dark: "" });
    setPhase(PHASES.PAUSED_SPEND_BEFORE);
  };

  const spendStepNext = () => {
    // Move from "before" to "after" step
    setPhase(PHASES.PAUSED_SPEND_AFTER);
  };

  const spendStepFinish = () => {
    // Save the spend event with before and after values
    const before = { gold: parseInt(preSpendLoot.gold) || 0, elixir: parseInt(preSpendLoot.elixir) || 0, dark: parseInt(preSpendLoot.dark) || 0 };
    const after = { gold: parseInt(spendLoot.gold) || 0, elixir: parseInt(spendLoot.elixir) || 0, dark: parseInt(spendLoot.dark) || 0 };
    const spent = { gold: before.gold - after.gold, elixir: before.elixir - after.elixir, dark: before.dark - after.dark };
    if (spent.gold > 0 || spent.elixir > 0 || spent.dark > 0) {
      setSpendEvents((prev) => [...prev, { before, after, spent, atLap: laps.length }]);
    }
    pauseAccumRef.current += Date.now() - pauseStartRef.current;
    setIsPaused(false);
    setPreSpendLoot({ gold: "", elixir: "", dark: "" });
    setSpendLoot({ gold: "", elixir: "", dark: "" });
    setPhase(PHASES.RUNNING);
  };

  const cancelSpend = () => {
    // Cancel spend flow, go back to general pause
    setPreSpendLoot({ gold: "", elixir: "", dark: "" });
    setSpendLoot({ gold: "", elixir: "", dark: "" });
    setPhase(PHASES.PAUSED);
  };

  const endSession = () => {
    if ((phase === PHASES.PAUSED || phase === PHASES.PAUSED_SPEND_BEFORE || phase === PHASES.PAUSED_SPEND_AFTER) && pauseStartRef.current) {
      pauseAccumRef.current += Date.now() - pauseStartRef.current;
    }
    setIsPaused(false);
    clearInterval(timerRef.current);
    setPhase(PHASES.RESULTS);
  };

  const calcResults = (sData) => {
    const src = sData || {
      startLoot: { gold: parseInt(startLoot.gold) || 0, elixir: parseInt(startLoot.elixir) || 0, dark: parseInt(startLoot.dark) || 0 },
      endLoot: { gold: parseInt(endLoot.gold) || 0, elixir: parseInt(endLoot.elixir) || 0, dark: parseInt(endLoot.dark) || 0 },
      spendEvents, laps, elapsed,
    };
    const spent = { gold: 0, elixir: 0, dark: 0 };
    (src.spendEvents || []).forEach((ev) => {
      if (ev.spent) { spent.gold += ev.spent.gold; spent.elixir += ev.spent.elixir; spent.dark += ev.spent.dark; }
      else { spent.gold += ev.gold || 0; spent.elixir += ev.elixir || 0; spent.dark += ev.dark || 0; }
    });
    const totalLoot = {
      gold: src.endLoot.gold - src.startLoot.gold + spent.gold,
      elixir: src.endLoot.elixir - src.startLoot.elixir + spent.elixir,
      dark: src.endLoot.dark - src.startLoot.dark + spent.dark,
    };
    const attacks = src.laps.length || 1;
    const avgPerAttack = { gold: totalLoot.gold / attacks, elixir: totalLoot.elixir / attacks, dark: totalLoot.dark / attacks };
    const totalMs = src.elapsed || 1;
    const hours = totalMs / 3600000;
    const perHour = { gold: totalLoot.gold / hours, elixir: totalLoot.elixir / hours, dark: totalLoot.dark / hours };
    const avgLapMs = src.laps.length > 0 ? src.laps.reduce((a, l) => a + l.duration, 0) / src.laps.length : 0;
    const bestLap = src.laps.length > 0 ? Math.min(...src.laps.map((l) => l.duration)) : 0;
    const worstLap = src.laps.length > 0 ? Math.max(...src.laps.map((l) => l.duration)) : 0;
    return { totalLoot, avgPerAttack, perHour, avgLapMs, bestLap, worstLap, attacks, totalMs, spent };
  };

  const getAggregateStats = () => {
    if (sessions.length === 0) return null;
    let totalGoldElixir = 0;
    let totalMs = 0;
    sessions.forEach((s) => {
      const r = calcResults(s);
      totalGoldElixir += r.totalLoot.gold + r.totalLoot.elixir;
      totalMs += r.totalMs;
    });
    const hours = totalMs / 3600000;
    if (hours === 0) return null;
    return { goldElixirPerHour: totalGoldElixir / hours, totalHours: hours, sessionCount: sessions.length };
  };

  // Compute lifetime stats across all sessions (totals, averages, streak, best day)
  const getLifetimeStats = () => {
    if (sessions.length === 0) return null;
    let totalGold = 0, totalElixir = 0, totalDark = 0, totalAttacks = 0, totalMs = 0;
    const dailyTotals = {}; // yyyy-mm-dd → gold+elixir+dark
    const daysWithSession = new Set();
    let firstDate = null, lastDate = null;
    sessions.forEach((s) => {
      const r = calcResults(s);
      totalGold += r.totalLoot.gold;
      totalElixir += r.totalLoot.elixir;
      totalDark += r.totalLoot.dark;
      totalAttacks += r.attacks;
      totalMs += r.totalMs;
      // Parse date (s.date is "dd.mm.yyyy, hh:mm:ss" in German format)
      const sessionDate = new Date(s.id);
      const dayKey = sessionDate.toISOString().slice(0, 10);
      daysWithSession.add(dayKey);
      dailyTotals[dayKey] = (dailyTotals[dayKey] || 0) + r.totalLoot.gold + r.totalLoot.elixir + r.totalLoot.dark;
      if (!firstDate || sessionDate < firstDate) firstDate = sessionDate;
      if (!lastDate || sessionDate > lastDate) lastDate = sessionDate;
    });
    // Streak: consecutive days ending today/yesterday with a session
    let streak = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const check = new Date(today);
    // Allow gap if today wasn't farmed yet (count from yesterday)
    if (!daysWithSession.has(today.toISOString().slice(0, 10))) {
      check.setDate(check.getDate() - 1);
    }
    while (daysWithSession.has(check.toISOString().slice(0, 10))) {
      streak++;
      check.setDate(check.getDate() - 1);
    }
    // Best day
    let bestDay = null, bestDayLoot = 0;
    for (const [day, loot] of Object.entries(dailyTotals)) {
      if (loot > bestDayLoot) { bestDayLoot = loot; bestDay = day; }
    }
    return {
      totalGold, totalElixir, totalDark, totalAttacks, totalMs,
      totalSessions: sessions.length,
      avgGoldPerSession: totalGold / sessions.length,
      avgElixirPerSession: totalElixir / sessions.length,
      avgDarkPerSession: totalDark / sessions.length,
      avgAttacksPerSession: totalAttacks / sessions.length,
      avgSessionMs: totalMs / sessions.length,
      firstDate, lastDate, streak, bestDay, bestDayLoot,
      daysWithSessionCount: daysWithSession.size,
    };
  };

  // Compute personal records: best value + which session holds it for each metric
  // Export all data as a JSON file the user can download for backup
  const exportBackup = () => {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      sessions,
      walls: { thLevel, wallsByLevel, log: wallLog },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `coc-farming-backup-${dateStr}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Backup heruntergeladen!");
  };

  // Import backup from a JSON file; validates structure before applying
  const importBackup = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || !Array.isArray(data.sessions)) {
        showToast("Ungültige Backup-Datei");
        return;
      }
      if (!window.confirm(`Backup vom ${data.exportedAt ? new Date(data.exportedAt).toLocaleString("de-DE") : "?"} importieren? Aktuelle Daten werden ersetzt.`)) {
        return;
      }
      await saveSessions(data.sessions);
      if (data.walls && data.walls.wallsByLevel) {
        await saveWalls(data.walls.wallsByLevel, data.walls.log || [], data.walls.thLevel || 18);
      }
      showToast(`${data.sessions.length} Sessions wiederhergestellt!`);
    } catch (e) {
      showToast("Fehler beim Lesen: " + (e.message || "unbekannt"));
    }
  };

  const saveAndReset = async () => {
    const sessionData = {
      id: Date.now(),
      date: new Date().toLocaleString("de-DE"),
      startLoot: { gold: parseInt(startLoot.gold) || 0, elixir: parseInt(startLoot.elixir) || 0, dark: parseInt(startLoot.dark) || 0 },
      endLoot: { gold: parseInt(endLoot.gold) || 0, elixir: parseInt(endLoot.elixir) || 0, dark: parseInt(endLoot.dark) || 0 },
      spendEvents: [...spendEvents], laps: [...laps], elapsed,
    };
    // Detect new records BEFORE saving so we can celebrate after
    const r = calcResults();
    const newRecs = r ? newRecordsForCurrent(r) : [];
    const newSessions = [sessionData, ...sessions];
    await saveSessions(newSessions);
    if (newRecs.length > 0) {
      showToast(`🏆 ${newRecs.length} neue Bestleistung${newRecs.length > 1 ? "en" : ""}!`);
    } else {
      showToast("Session gespeichert!");
    }
    resetAll();
  };

  const resetAll = () => {
    setPhase(PHASES.SETUP);
    setStartLoot({ gold: "", elixir: "", dark: "" });
    setEndLoot({ gold: "", elixir: "", dark: "" });
    setSpendLoot({ gold: "", elixir: "", dark: "" });
    setPreSpendLoot({ gold: "", elixir: "", dark: "" });
    setLaps([]); setSpendEvents([]); setElapsed(0); setCurrentLapTime(0);
    setIsPaused(false); setViewingSession(null);
    startTimeRef.current = null; pauseAccumRef.current = 0; lastLapTimeRef.current = 0;
  };

  const deleteSession = async (id) => {
    const newSessions = sessions.filter((s) => s.id !== id);
    await saveSessions(newSessions);
    showToast("Session gelöscht!");
    if (viewingSession?.id === id) setViewingSession(null);
  };

  const exportSession = (sData) => {
    const r = calcResults(sData);
    const lines = [
      "══════════════════════════════════════", "   CLASH OF CLANS – FARMING SESSION", "══════════════════════════════════════",
      `Datum: ${sData?.date || new Date().toLocaleString("de-DE")}`, `Dauer: ${formatMs(r.totalMs)} | Angriffe: ${r.attacks}`,
      "", "── GESAMT-LOOT ──────────────────────", `  Gold:    ${formatNum(r.totalLoot.gold)}`, `  Elixir:  ${formatNum(r.totalLoot.elixir)}`, `  Dunkles: ${formatNum(r.totalLoot.dark)}`,
      "", "── DURCHSCHNITT PRO ANGRIFF ─────────", `  Gold:    ${formatNum(r.avgPerAttack.gold)}`, `  Elixir:  ${formatNum(r.avgPerAttack.elixir)}`, `  Dunkles: ${formatNum(r.avgPerAttack.dark)}`,
      "", "── LOOT PRO STUNDE ─────────────────", `  Gold:    ${formatNum(r.perHour.gold)}`, `  Elixir:  ${formatNum(r.perHour.elixir)}`, `  Dunkles: ${formatNum(r.perHour.dark)}`,
      "", `Ø Angriffsdauer: ${formatMs(r.avgLapMs)}`, `Schnellster:     ${formatMs(r.bestLap)}`, `Langsamster:     ${formatMs(r.worstLap)}`,
      "", "── LAPS ────────────────────────────", ...(sData?.laps || laps).map((l, i) => `  #${i + 1}: ${formatMs(l.duration)}`),
      "══════════════════════════════════════",
    ];
    navigator.clipboard.writeText(lines.join("\n")).then(() => showToast("In Zwischenablage kopiert!")).catch(() => {});
  };

  // Upgrade `count` walls FROM level `fromLevel` to fromLevel+1
  const upgradeWallsAtLevel = async (fromLevel, count) => {
    const toLevel = fromLevel + 1;
    const currentAtFrom = wallsByLevel[fromLevel] || 0;
    const currentAtTo = wallsByLevel[toLevel] || 0;
    // Respect caps at the target level
    const caps = WALL_LEVEL_CAPS[thLevel] || {};
    const capAtTo = caps[toLevel];
    let actualCount = Math.min(count, currentAtFrom);
    if (capAtTo !== undefined) {
      actualCount = Math.min(actualCount, capAtTo - currentAtTo);
    }
    actualCount = Math.max(0, actualCount);
    if (actualCount === 0) {
      showToast("Keine Mauer auf diesem Level oder Cap erreicht");
      return;
    }
    const next = { ...wallsByLevel };
    next[fromLevel] = currentAtFrom - actualCount;
    next[toLevel] = currentAtTo + actualCount;
    const newLog = [...wallLog, {
      date: new Date().toLocaleString("de-DE"),
      change: actualCount,
      fromLevel, toLevel,
      total: sumWalls(next),
    }];
    await saveWalls(next, newLog);
    showToast(`+${actualCount} Mauer${actualCount > 1 ? "n" : ""} L${fromLevel}→L${toLevel}`);
  };

  // Reverse: move walls from toLevel back down to fromLevel (correction)
  const downgradeWallsAtLevel = async (fromLevel, count) => {
    const lowerLevel = fromLevel - 1;
    if (lowerLevel < 1) return;
    const currentAtFrom = wallsByLevel[fromLevel] || 0;
    const actualCount = Math.min(count, currentAtFrom);
    if (actualCount === 0) return;
    const next = { ...wallsByLevel };
    next[fromLevel] = currentAtFrom - actualCount;
    next[lowerLevel] = (next[lowerLevel] || 0) + actualCount;
    const newLog = [...wallLog, {
      date: new Date().toLocaleString("de-DE"),
      change: -actualCount,
      fromLevel: lowerLevel, toLevel: fromLevel,
      total: sumWalls(next),
    }];
    await saveWalls(next, newLog);
    showToast(`Korrektur: ${actualCount} zurück auf L${lowerLevel}`);
  };

  // Apply edited distribution (replaces wallsByLevel entirely)
  const applyDraftWalls = async () => {
    if (!draftWalls) return;
    const expected = TH_WALL_COUNTS[thLevel] || 0;
    const sum = sumWalls(draftWalls);
    if (sum !== expected) {
      showToast(`Summe muss ${expected} sein (aktuell ${sum})`);
      return;
    }
    const newLog = [...wallLog, {
      date: new Date().toLocaleString("de-DE"),
      change: 0,
      manualSet: true,
      total: sum,
    }];
    await saveWalls(draftWalls, newLog);
    setDraftWalls(null);
    setEditingWalls(false);
    showToast("Verteilung gespeichert");
  };

  // Change TH level (resets distribution to all walls at Level 1 if increased)
  const changeThLevel = async (newTh) => {
    const newTotal = TH_WALL_COUNTS[newTh] || 0;
    const currentTotal = sumWalls(wallsByLevel);
    let next = { ...wallsByLevel };
    if (newTotal > currentTotal) {
      // New walls available at L1
      next[1] = (next[1] || 0) + (newTotal - currentTotal);
    } else if (newTotal < currentTotal) {
      // Remove from lowest levels first
      let toRemove = currentTotal - newTotal;
      const sortedLevels = Object.keys(next).map(Number).sort((a, b) => a - b);
      for (const L of sortedLevels) {
        const removeHere = Math.min(toRemove, next[L]);
        next[L] -= removeHere;
        toRemove -= removeHere;
        if (toRemove <= 0) break;
      }
    }
    // Also cap any levels above newMaxLevel down to newMaxLevel
    const newMax = TH_MAX_WALL_LEVEL[newTh] || MAX_WALL_LEVEL;
    for (let L = newMax + 1; L <= MAX_WALL_LEVEL; L++) {
      if (next[L]) {
        next[newMax] = (next[newMax] || 0) + next[L];
        delete next[L];
      }
    }
    await saveWalls(next, wallLog, newTh);
    showToast(`Rathaus auf TH${newTh} gesetzt`);
  };

  // Keyboard shortcuts
  const isAnyActivePhase = phase === PHASES.RUNNING || phase === PHASES.PAUSED || phase === PHASES.PAUSED_SPEND_BEFORE || phase === PHASES.PAUSED_SPEND_AFTER;
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === "INPUT") return;
      if (e.code === "Space" && phase === PHASES.RUNNING && !isPaused) { e.preventDefault(); addLap(); }
      if (e.code === "KeyP" && (phase === PHASES.RUNNING || phase === PHASES.PAUSED)) { e.preventDefault(); togglePause(); }
      if (e.code === "KeyL" && (phase === PHASES.RUNNING || phase === PHASES.PAUSED)) { e.preventDefault(); startSpendFlow(); }
      if (e.code === "KeyE" && isAnyActivePhase) { e.preventDefault(); endSession(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [phase, isPaused, addLap]);

  const liveStats = isAnyActivePhase ? (() => {
    if (laps.length === 0) return null;
    const avgMs = laps.reduce((a, l) => a + l.duration, 0) / laps.length;
    return { avgMs, count: laps.length };
  })() : null;

  const results = phase === PHASES.RESULTS ? calcResults() : null;
  const viewResults = viewingSession ? calcResults(viewingSession) : null;

  // === Personal Records – tracks the best session per metric ===
  const records = (() => {
    const init = (better = "higher") => ({ value: better === "higher" ? 0 : Infinity, sessionId: null });
    const rec = {
      bestGoldPerHour: init(),
      bestElixirPerHour: init(),
      bestDarkPerHour: init(),
      bestGoldElixirPerHour: init(),
      mostAttacks: init(),
      longestSession: init(),
      fastestAvgLap: init("lower"),
      biggestLoot: init(),
    };
    sessions.forEach((s) => {
      const r = calcResults(s);
      const gPh = r.perHour.gold, ePh = r.perHour.elixir, dPh = r.perHour.dark;
      const gePh = gPh + ePh;
      const totalLoot = r.totalLoot.gold + r.totalLoot.elixir + r.totalLoot.dark;
      if (gPh > rec.bestGoldPerHour.value) rec.bestGoldPerHour = { value: gPh, sessionId: s.id };
      if (ePh > rec.bestElixirPerHour.value) rec.bestElixirPerHour = { value: ePh, sessionId: s.id };
      if (dPh > rec.bestDarkPerHour.value) rec.bestDarkPerHour = { value: dPh, sessionId: s.id };
      if (gePh > rec.bestGoldElixirPerHour.value) rec.bestGoldElixirPerHour = { value: gePh, sessionId: s.id };
      if (r.attacks > rec.mostAttacks.value) rec.mostAttacks = { value: r.attacks, sessionId: s.id };
      if (r.totalMs > rec.longestSession.value) rec.longestSession = { value: r.totalMs, sessionId: s.id };
      if (r.attacks >= 3 && r.avgLapMs < rec.fastestAvgLap.value) rec.fastestAvgLap = { value: r.avgLapMs, sessionId: s.id };
      if (totalLoot > rec.biggestLoot.value) rec.biggestLoot = { value: totalLoot, sessionId: s.id };
    });
    return rec;
  })();

  // Which record labels does a given session hold?
  const recordsForSession = (sessionId) => {
    if (!sessionId) return [];
    const held = [];
    if (records.bestGoldPerHour.sessionId === sessionId && records.bestGoldPerHour.value > 0) held.push({ key: "gold/h", label: "Bestes Gold/h", color: "#FFD700" });
    if (records.bestElixirPerHour.sessionId === sessionId && records.bestElixirPerHour.value > 0) held.push({ key: "elixir/h", label: "Bestes Elixir/h", color: "#E84CFF" });
    if (records.bestDarkPerHour.sessionId === sessionId && records.bestDarkPerHour.value > 0) held.push({ key: "dark/h", label: "Bestes DE/h", color: "#3DD6F5" });
    if (records.bestGoldElixirPerHour.sessionId === sessionId && records.bestGoldElixirPerHour.value > 0) held.push({ key: "ge/h", label: "Bestes G+E/h", color: "#FFD700" });
    if (records.mostAttacks.sessionId === sessionId && records.mostAttacks.value > 0) held.push({ key: "attacks", label: "Meiste Angriffe", color: "#FFA500" });
    if (records.longestSession.sessionId === sessionId && records.longestSession.value > 0) held.push({ key: "duration", label: "Längste Session", color: "#FFA500" });
    if (records.fastestAvgLap.sessionId === sessionId && records.fastestAvgLap.value < Infinity) held.push({ key: "fastest", label: "Schnellste Ø-Lap", color: "#00ff64" });
    if (records.biggestLoot.sessionId === sessionId && records.biggestLoot.value > 0) held.push({ key: "loot", label: "Größter Loot", color: "#FFD700" });
    return held;
  };

  // Detect new records when saving (compares current results to all PREVIOUS sessions)
  const newRecordsForCurrent = (r) => {
    if (!r) return [];
    const prev = sessions.map(calcResults);
    const max = (fn) => prev.length ? Math.max(...prev.map(fn)) : 0;
    const min = (fn) => prev.length ? Math.min(...prev.map(fn)) : Infinity;
    const newOnes = [];
    const gePh = r.perHour.gold + r.perHour.elixir;
    if (r.perHour.gold > max(p => p.perHour.gold) && r.perHour.gold > 0) newOnes.push({ label: "Bestes Gold/h", color: "#FFD700" });
    if (r.perHour.elixir > max(p => p.perHour.elixir) && r.perHour.elixir > 0) newOnes.push({ label: "Bestes Elixir/h", color: "#E84CFF" });
    if (r.perHour.dark > max(p => p.perHour.dark) && r.perHour.dark > 0) newOnes.push({ label: "Bestes DE/h", color: "#3DD6F5" });
    if (gePh > max(p => p.perHour.gold + p.perHour.elixir) && gePh > 0) newOnes.push({ label: "Bestes G+E/h", color: "#FFD700" });
    if (r.attacks > max(p => p.attacks) && r.attacks > 0) newOnes.push({ label: "Meiste Angriffe", color: "#FFA500" });
    if (r.totalMs > max(p => p.totalMs) && r.totalMs > 0) newOnes.push({ label: "Längste Session", color: "#FFA500" });
    if (r.attacks >= 3 && r.avgLapMs < min(p => p.attacks >= 3 ? p.avgLapMs : Infinity)) newOnes.push({ label: "Schnellste Ø-Lap", color: "#00ff64" });
    const totalLoot = r.totalLoot.gold + r.totalLoot.elixir + r.totalLoot.dark;
    if (totalLoot > max(p => p.totalLoot.gold + p.totalLoot.elixir + p.totalLoot.dark) && totalLoot > 0) newOnes.push({ label: "Größter Loot", color: "#FFD700" });
    return newOnes;
  };

  // === Goal progress (today + this week) ===
  const goalProgress = (() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    // ISO week start (Monday) – locale-friendly for DE users
    const weekStart = new Date(startOfToday);
    const dayOfWeek = weekStart.getDay(); // 0=Sun, 1=Mon, ...
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    weekStart.setDate(weekStart.getDate() - daysSinceMonday);
    const startOfWeek = weekStart.getTime();

    let todayGold = 0, todayElixir = 0, todayDark = 0;
    let weekGold = 0, weekElixir = 0, weekDark = 0;
    sessions.forEach((s) => {
      const r = calcResults(s);
      const sessionTs = s.id; // id is Date.now() at save time
      if (sessionTs >= startOfToday) {
        todayGold += r.totalLoot.gold;
        todayElixir += r.totalLoot.elixir;
        todayDark += r.totalLoot.dark;
      }
      if (sessionTs >= startOfWeek) {
        weekGold += r.totalLoot.gold;
        weekElixir += r.totalLoot.elixir;
        weekDark += r.totalLoot.dark;
      }
    });
    const pct = (cur, target) => target > 0 ? Math.min(100, (cur / target) * 100) : 0;
    return {
      today: {
        gold: { current: todayGold, target: goals.daily.gold, pct: pct(todayGold, goals.daily.gold) },
        elixir: { current: todayElixir, target: goals.daily.elixir, pct: pct(todayElixir, goals.daily.elixir) },
        dark: { current: todayDark, target: goals.daily.dark, pct: pct(todayDark, goals.daily.dark) },
      },
      week: {
        gold: { current: weekGold, target: goals.weekly.gold, pct: pct(weekGold, goals.weekly.gold) },
        elixir: { current: weekElixir, target: goals.weekly.elixir, pct: pct(weekElixir, goals.weekly.elixir) },
        dark: { current: weekDark, target: goals.weekly.dark, pct: pct(weekDark, goals.weekly.dark) },
      },
      anyDailyGoal: goals.daily.gold > 0 || goals.daily.elixir > 0 || goals.daily.dark > 0,
      anyWeeklyGoal: goals.weekly.gold > 0 || goals.weekly.elixir > 0 || goals.weekly.dark > 0,
    };
  })();

  // === Lifetime Stats ===
  const lifetimeStats = (() => {
    if (sessions.length === 0) return null;
    let totalMs = 0, totalGold = 0, totalElixir = 0, totalDark = 0, totalAttacks = 0;
    sessions.forEach((s) => {
      const r = calcResults(s);
      totalMs += r.totalMs;
      totalGold += r.totalLoot.gold;
      totalElixir += r.totalLoot.elixir;
      totalDark += r.totalLoot.dark;
      totalAttacks += r.attacks;
    });
    // Total walls upgraded (from wallLog – sum positive `change` events)
    const wallsUpgraded = wallLog.reduce((sum, e) => sum + (e.change > 0 ? e.change : 0), 0);
    // Day-based streak
    const dayKey = (ts) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const days = [...new Set(sessions.map((s) => dayKey(s.id)))].sort();
    let longestStreak = 0, currentStreak = 0;
    if (days.length > 0) {
      let run = 1;
      longestStreak = 1;
      for (let i = 1; i < days.length; i++) {
        const prev = new Date(days[i - 1]);
        const cur = new Date(days[i]);
        const diffDays = Math.round((cur - prev) / 86400000);
        if (diffDays === 1) run++;
        else run = 1;
        if (run > longestStreak) longestStreak = run;
      }
      // Current streak: only counts if the latest day is today or yesterday
      const todayKey = dayKey(Date.now());
      const yesterdayKey = dayKey(Date.now() - 86400000);
      const lastDay = days[days.length - 1];
      if (lastDay === todayKey || lastDay === yesterdayKey) {
        currentStreak = 1;
        for (let i = days.length - 2; i >= 0; i--) {
          const prev = new Date(days[i]);
          const next = new Date(days[i + 1]);
          if (Math.round((next - prev) / 86400000) === 1) currentStreak++;
          else break;
        }
      }
    }
    const hours = totalMs / 3600000;
    return {
      totalSessions: sessions.length,
      totalMs, totalGold, totalElixir, totalDark, totalAttacks,
      avgGoldPerHour: hours > 0 ? totalGold / hours : 0,
      avgElixirPerHour: hours > 0 ? totalElixir / hours : 0,
      avgDarkPerHour: hours > 0 ? totalDark / hours : 0,
      avgPerSession: { gold: totalGold / sessions.length, elixir: totalElixir / sessions.length, dark: totalDark / sessions.length },
      wallsUpgraded,
      currentStreak,
      longestStreak,
      activeDays: days.length,
    };
  })();

  const wallTotal = TH_WALL_COUNTS[thLevel] || 0;
  const wallMaxLevel = TH_MAX_WALL_LEVEL[thLevel] || MAX_WALL_LEVEL;
  const wallCap = (WALL_LEVEL_CAPS[thLevel] || {})[wallMaxLevel];
  const wallsAtMax = wallsByLevel[wallMaxLevel] || 0;
  const wallsAtSubMax = wallsByLevel[wallMaxLevel - 1] || 0;
  const wallCostObj = computeWallCostRemaining(wallsByLevel, thLevel);
  const wallCostRemaining = wallCostObj.total;
  const wallStepsTotal = totalUpgradeStepsForTH(thLevel);
  const wallStepsDone = completedUpgradeSteps(wallsByLevel);
  // Progress = walls already at the highest level for this TH, divided by total walls.
  // E.g. 81/325 walls on L19 at TH18 → ~25%, 0/325 → 0%, 325/325 → 100% (theoretical max if no cap).
  const wallPercent = wallTotal === 0 ? "0.0" : ((wallsAtMax / wallTotal) * 100).toFixed(1);
  const aggStats = getAggregateStats();
  // Per-session stats list for sparkline charts (oldest → newest)
  const sessionStatsList = [...sessions].reverse().map((s) => {
    const r = calcResults(s);
    return {
      id: s.id,
      date: s.date,
      goldElixirPerHour: r.perHour.gold + r.perHour.elixir,
      darkPerHour: r.perHour.dark,
      goldPerHour: r.perHour.gold,
      elixirPerHour: r.perHour.elixir,
      avgLapMs: r.avgLapMs,
      totalLoot: r.totalLoot,
      totalMs: r.totalMs,
    };
  });
  // Comparison helper: stats for the currently viewed/finished session vs. average of OTHER sessions
  const compareToAverage = (sourceId, currentR) => {
    if (sessions.length < 2 && sourceId) return null;
    if (sessions.length < 1 && !sourceId) return null;
    let totalGold = 0, totalElixir = 0, totalDark = 0, totalMs = 0, count = 0;
    sessions.forEach((s) => {
      if (sourceId && s.id === sourceId) return; // exclude this session from avg
      const r = calcResults(s);
      totalGold += r.totalLoot.gold;
      totalElixir += r.totalLoot.elixir;
      totalDark += r.totalLoot.dark;
      totalMs += r.totalMs;
      count++;
    });
    if (count === 0 || totalMs === 0) return null;
    const hours = totalMs / 3600000;
    return {
      avgGoldPerHour: totalGold / hours,
      avgElixirPerHour: totalElixir / hours,
      avgDarkPerHour: totalDark / hours,
      avgGoldElixirPerHour: (totalGold + totalElixir) / hours,
      sessionCount: count,
    };
  };

  return (
    <div style={{ minHeight: "100vh", background: theme.bg, color: "#fff", fontFamily: "'Nunito', sans-serif", position: "relative", overflow: "hidden", transition: "background 0.4s ease" }}>
      <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700;900&family=Oswald:wght@400;600;700&family=Nunito:wght@400;600;700&display=swap" rel="stylesheet" />
      {/* Layered atmospheric backgrounds */}
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: `radial-gradient(ellipse at 20% 20%, ${theme.primary}10 0%, transparent 50%), radial-gradient(ellipse at 80% 80%, ${theme.secondary}0a 0%, transparent 50%)`, pointerEvents: "none", transition: "background 0.4s ease" }} />
      {/* Subtle noise pattern for texture */}
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, opacity: 0.025, pointerEvents: "none", backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")` }} />
      {/* Corner glow accents */}
      <div style={{ position: "fixed", top: -100, left: -100, width: 300, height: 300, borderRadius: "50%", background: `radial-gradient(circle, ${theme.primary}15, transparent 70%)`, pointerEvents: "none", filter: "blur(40px)", transition: "background 0.4s ease" }} />
      <div style={{ position: "fixed", bottom: -100, right: -100, width: 300, height: 300, borderRadius: "50%", background: `radial-gradient(circle, ${theme.secondary}12, transparent 70%)`, pointerEvents: "none", filter: "blur(40px)", transition: "background 0.4s ease" }} />

      {toast && (
        <div style={{ position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)", zIndex: 1000, background: theme.primary, color: "#1a0f00", padding: "10px 24px", borderRadius: 8, fontWeight: 700, fontSize: 14, fontFamily: "'Cinzel', serif", boxShadow: `0 4px 20px ${theme.primary}55`, animation: "fadeIn 0.3s ease" }}>
          {toast}
        </div>
      )}

      <div style={{ maxWidth: 520, margin: "0 auto", padding: "20px 16px", position: "relative", zIndex: 1 }}>
        {/* Header */}
        <div style={{ position: "relative", marginBottom: 20 }}>
          {/* Settings cog – top right */}
          <button onClick={() => setPhase(PHASES.SETTINGS)}
            style={{
              position: "absolute", top: 0, right: 0,
              width: 40, height: 40, borderRadius: 12,
              background: phase === PHASES.SETTINGS ? `${theme.primary}20` : "rgba(255,255,255,0.04)",
              border: `1px solid ${phase === PHASES.SETTINGS ? theme.primary : "rgba(255,255,255,0.1)"}`,
              color: phase === PHASES.SETTINGS ? theme.primary : "rgba(255,255,255,0.55)",
              fontSize: 18, cursor: "pointer", transition: "all 0.3s",
              display: "flex", alignItems: "center", justifyContent: "center",
              backdropFilter: "blur(8px)",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = "rotate(45deg)"; e.currentTarget.style.borderColor = theme.primary; e.currentTarget.style.color = theme.primary; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = "rotate(0deg)"; if (phase !== PHASES.SETTINGS) { e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"; e.currentTarget.style.color = "rgba(255,255,255,0.55)"; } }}
            title="Einstellungen">⚙</button>

          {/* Decorative top border */}
          <div style={{ height: 1, background: `linear-gradient(90deg, transparent, ${theme.primary}66, transparent)`, marginBottom: 14, opacity: 0.5 }} />

          <div style={{ textAlign: "center" }}>
            <h1 style={{
              fontFamily: "'Cinzel', serif", fontWeight: 900, fontSize: 26,
              background: theme.primaryGradient, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
              margin: 0, letterSpacing: 4, transition: "background 0.4s ease",
              textShadow: `0 0 30px ${theme.primary}33`,
              filter: `drop-shadow(0 2px 8px ${theme.primary}22)`,
            }}>
              ⚔ FARMING TRACKER ⚔
            </h1>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 6 }}>
              <span style={{ height: 1, flex: "0 1 40px", background: `linear-gradient(90deg, transparent, ${theme.primary}55)` }} />
              <p style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", margin: 0, letterSpacing: 4, fontFamily: "'Cinzel', serif", fontWeight: 700 }}>CLASH OF CLANS</p>
              <span style={{ height: 1, flex: "0 1 40px", background: `linear-gradient(90deg, ${theme.primary}55, transparent)` }} />
            </div>
          </div>

          {/* Decorative bottom border */}
          <div style={{ height: 1, background: `linear-gradient(90deg, transparent, ${theme.primary}66, transparent)`, marginTop: 14, opacity: 0.5 }} />
        </div>

        {/* Navigation grid – only on SETUP screen */}
        {phase === PHASES.SETUP && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, marginBottom: 18 }}>
            {[
              { icon: "📊", label: "Stats", target: PHASES.STATS, color: theme.primary, show: sessions.length > 0 },
              { icon: "📜", label: "Verlauf", target: PHASES.HISTORY, color: theme.primary, badge: sessions.length || null, show: true },
              { icon: "🎯", label: "Ziele", target: PHASES.GOALS, color: theme.primary, show: true },
              { icon: "🧱", label: "Mauern", target: PHASES.WALLS, color: theme.wall, show: true },
              { icon: "❓", label: "Hilfe", target: PHASES.HELP, color: theme.secondary, show: true },
            ].filter(item => item.show).map((item) => (
              <button key={item.label} onClick={() => setPhase(item.target)}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
                  padding: "12px 4px",
                  background: `linear-gradient(135deg, ${item.color}08, rgba(0,0,0,0.4))`,
                  border: `1px solid ${item.color}33`, borderRadius: 12,
                  color: item.color, fontFamily: "'Cinzel', serif", fontSize: 10,
                  fontWeight: 700, letterSpacing: 1, cursor: "pointer",
                  transition: "all 0.25s",
                  position: "relative",
                  backdropFilter: "blur(4px)",
                  boxShadow: `inset 0 1px 0 ${item.color}15`,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.borderColor = item.color; e.currentTarget.style.boxShadow = `0 4px 12px ${item.color}33, inset 0 1px 0 ${item.color}33`; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.borderColor = `${item.color}33`; e.currentTarget.style.boxShadow = `inset 0 1px 0 ${item.color}15`; }}>
                <span style={{ fontSize: 22, lineHeight: 1, filter: `drop-shadow(0 0 6px ${item.color}66)` }}>{item.icon}</span>
                <span style={{ marginTop: 2 }}>{item.label}</span>
                {item.badge && (
                  <span style={{ position: "absolute", top: 4, right: 4, background: item.color, color: "#000", fontSize: 9, padding: "1px 5px", borderRadius: 8, fontFamily: "'Oswald', sans-serif", fontWeight: 700, minWidth: 16, textAlign: "center" }}>
                    {item.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* ═══ SETUP ═══ */}
        {phase === PHASES.SETUP && (
          <div style={{ animation: "fadeIn 0.4s ease" }}>
            {/* First-time welcome banner */}
            {sessions.length === 0 && (
              <div style={{ background: `linear-gradient(135deg, ${theme.primary}11, ${theme.secondary}08)`, borderRadius: 14, padding: 16, marginBottom: 14, border: `1px solid ${theme.primary}33`, position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: -30, right: -30, width: 100, height: 100, borderRadius: "50%", background: `radial-gradient(circle, ${theme.primary}22, transparent)`, filter: "blur(20px)" }} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, position: "relative" }}>
                  <span style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: theme.primary, letterSpacing: 1.5, fontWeight: 700 }}>👋 Willkommen, Häuptling!</span>
                  <button onClick={() => setPhase(PHASES.HELP)}
                    style={{ background: `${theme.secondary}20`, border: `1px solid ${theme.secondary}55`, borderRadius: 6, color: theme.secondary, padding: "4px 10px", fontSize: 11, fontFamily: "'Cinzel', serif", letterSpacing: 1, fontWeight: 700, cursor: "pointer" }}>
                    ❓ Anleitung
                  </button>
                </div>
                <p style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", margin: 0, lineHeight: 1.5, position: "relative" }}>
                  Trage unten dein aktuelles Loot ein, drücke <strong style={{ color: theme.primary }}>SESSION STARTEN</strong>, und beginne in CoC anzugreifen. Nach jedem Angriff <strong style={{ color: theme.primary }}>Leertaste</strong> drücken für eine Lap-Zeit.
                </p>
              </div>
            )}

            {/* Hero stats banner – only when sessions exist */}
            {lifetimeStats && (
              <div style={{ background: `linear-gradient(135deg, rgba(0,0,0,0.5), ${theme.primary}08)`, borderRadius: 16, padding: 16, marginBottom: 14, border: `1px solid ${theme.primary}22`, position: "relative", overflow: "hidden", boxShadow: `0 4px 24px rgba(0,0,0,0.3), inset 0 1px 0 ${theme.primary}11` }}>
                {/* Decorative glow */}
                <div style={{ position: "absolute", top: -50, right: -50, width: 150, height: 150, borderRadius: "50%", background: `radial-gradient(circle, ${theme.primary}15, transparent 70%)`, pointerEvents: "none" }} />
                <div style={{ position: "absolute", bottom: -40, left: -40, width: 120, height: 120, borderRadius: "50%", background: `radial-gradient(circle, ${theme.secondary}10, transparent 70%)`, pointerEvents: "none" }} />

                <div style={{ position: "relative", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                  <div onClick={() => setPhase(PHASES.STATS)} style={{ cursor: "pointer", textAlign: "center", padding: "8px 4px", borderRight: "1px solid rgba(255,255,255,0.05)" }}>
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: 1.5, fontFamily: "'Cinzel', serif", marginBottom: 4 }}>Sessions</div>
                    <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 26, color: theme.primary, lineHeight: 1, fontWeight: 700 }}>{lifetimeStats.totalSessions}</div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 4 }}>{formatMs(lifetimeStats.totalMs)}</div>
                  </div>
                  <div onClick={() => setPhase(PHASES.STATS)} style={{ cursor: "pointer", textAlign: "center", padding: "8px 4px", borderRight: "1px solid rgba(255,255,255,0.05)" }}>
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: 1.5, fontFamily: "'Cinzel', serif", marginBottom: 4 }}>Streak</div>
                    <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 26, color: lifetimeStats.currentStreak > 0 ? "#FFA500" : "rgba(255,255,255,0.3)", lineHeight: 1, fontWeight: 700 }}>
                      🔥 {lifetimeStats.currentStreak}
                    </div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 4 }}>Beste: {lifetimeStats.longestStreak}</div>
                  </div>
                  <div onClick={() => setPhase(PHASES.WALLS)} style={{ cursor: "pointer", textAlign: "center", padding: "8px 4px" }}>
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: 1.5, fontFamily: "'Cinzel', serif", marginBottom: 4 }}>Mauern</div>
                    <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 26, color: theme.wall, lineHeight: 1, fontWeight: 700 }}>{wallsAtMax}<span style={{ fontSize: 14, color: "rgba(255,255,255,0.3)" }}>/{wallCap || wallTotal}</span></div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 4 }}>L{wallMaxLevel} · {wallPercent}%</div>
                  </div>
                </div>
              </div>
            )}

            {/* Loot input card – richer design */}
            <div style={{ background: `linear-gradient(135deg, rgba(0,0,0,0.5), rgba(0,0,0,0.3))`, borderRadius: 18, padding: 22, border: `1px solid ${theme.primary}22`, boxShadow: `0 6px 24px rgba(0,0,0,0.35), inset 0 1px 0 ${theme.primary}15`, position: "relative", overflow: "hidden" }}>
              {/* Corner ornaments */}
              <div style={{ position: "absolute", top: 0, left: 0, width: 30, height: 30, borderTop: `2px solid ${theme.primary}55`, borderLeft: `2px solid ${theme.primary}55`, borderTopLeftRadius: 18 }} />
              <div style={{ position: "absolute", top: 0, right: 0, width: 30, height: 30, borderTop: `2px solid ${theme.primary}55`, borderRight: `2px solid ${theme.primary}55`, borderTopRightRadius: 18 }} />
              <div style={{ position: "absolute", bottom: 0, left: 0, width: 30, height: 30, borderBottom: `2px solid ${theme.primary}55`, borderLeft: `2px solid ${theme.primary}55`, borderBottomLeftRadius: 18 }} />
              <div style={{ position: "absolute", bottom: 0, right: 0, width: 30, height: 30, borderBottom: `2px solid ${theme.primary}55`, borderRight: `2px solid ${theme.primary}55`, borderBottomRightRadius: 18 }} />

              <div style={{ textAlign: "center", marginBottom: 18 }}>
                <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 13, letterSpacing: 3, color: theme.primary, margin: 0, fontWeight: 700, textShadow: `0 0 12px ${theme.primary}44` }}>⚜ START-LOOT EINTRAGEN ⚜</h2>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 4, letterSpacing: 2 }}>Wo stehst du gerade?</div>
              </div>
              <ScanButton target="start" />
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <LootInput label="Gold" value={startLoot.gold} onChange={(v) => setStartLoot((p) => ({ ...p, gold: v }))} />
                <LootInput label="Elixir" value={startLoot.elixir} onChange={(v) => setStartLoot((p) => ({ ...p, elixir: v }))} />
                <LootInput label="Dunkles Elixir" value={startLoot.dark} onChange={(v) => setStartLoot((p) => ({ ...p, dark: v }))} />
              </div>
              <div style={{ marginTop: 22, textAlign: "center" }}>
                <Btn onClick={startSession} style={{ width: "100%", padding: "14px 24px", fontSize: 16, boxShadow: `0 4px 16px ${theme.primary}55`, background: theme.primaryGradient }}>▶ SESSION STARTEN</Btn>
              </div>
            </div>
            {/* Goals Widget (only if any goal set, otherwise compact CTA) */}
            {goalProgress.anyDailyGoal || goalProgress.anyWeeklyGoal ? (
              <div style={{ marginTop: 14, background: `linear-gradient(135deg, ${theme.primary}08, rgba(0,0,0,0.4))`, borderRadius: 14, padding: 16, border: `1px solid ${theme.primary}22`, cursor: "pointer", transition: "all 0.25s", boxShadow: `inset 0 1px 0 ${theme.primary}11` }}
                onClick={() => setPhase(PHASES.GOALS)}
                onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.borderColor = `${theme.primary}55`; e.currentTarget.style.boxShadow = `0 4px 16px ${theme.primary}22, inset 0 1px 0 ${theme.primary}22`; }}
                onMouseLeave={e => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.borderColor = `${theme.primary}22`; e.currentTarget.style.boxShadow = `inset 0 1px 0 ${theme.primary}11`; }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: theme.primary, fontFamily: "'Cinzel', serif", fontWeight: 700 }}>🎯 Tages-Ziele</span>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "'Cinzel', serif", letterSpacing: 1 }}>Tippe für Details →</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {[
                    { label: "Gold", data: goalProgress.today.gold, color: "#FFD700", icon: "💰" },
                    { label: "Elixir", data: goalProgress.today.elixir, color: "#E84CFF", icon: "🧪" },
                    { label: "Dunkles", data: goalProgress.today.dark, color: "#3DD6F5", icon: "🌑" },
                  ].filter(item => item.data.target > 0).map((item) => (
                    <div key={item.label}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                        <span style={{ color: "rgba(255,255,255,0.6)" }}>{item.icon} {item.label}</span>
                        <span style={{ fontFamily: "'Oswald', sans-serif", color: item.data.pct >= 100 ? "#00ff64" : item.color, fontWeight: 700 }}>
                          {formatNum(item.data.current)} / {formatNum(item.data.target)} {item.data.pct >= 100 && "✓"}
                        </span>
                      </div>
                      <div style={{ background: "rgba(0,0,0,0.5)", borderRadius: 4, height: 6, overflow: "hidden", border: "1px solid rgba(255,255,255,0.04)" }}>
                        <div style={{ height: "100%", borderRadius: 4, background: item.data.pct >= 100 ? "linear-gradient(90deg, #00ff64, #00d050)" : `linear-gradient(90deg, ${item.color}, ${item.color}cc)`, width: `${item.data.pct}%`, transition: "width 0.6s ease", boxShadow: item.data.pct >= 100 ? "0 0 8px rgba(0,255,100,0.5)" : `0 0 6px ${item.color}55` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 14, background: "rgba(255,255,255,0.02)", borderRadius: 14, padding: 14, border: `1px dashed ${theme.primary}25`, textAlign: "center", cursor: "pointer", transition: "all 0.2s" }}
                onClick={() => setPhase(PHASES.GOALS)}
                onMouseEnter={e => { e.currentTarget.style.background = `${theme.primary}06`; e.currentTarget.style.borderColor = `${theme.primary}45`; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.02)"; e.currentTarget.style.borderColor = `${theme.primary}25`; }}>
                <div style={{ fontSize: 22, marginBottom: 4 }}>🎯</div>
                <span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", letterSpacing: 1 }}>Tippe um Tages-/Wochenziele zu setzen</span>
              </div>
            )}

            {/* Mini Wall Progress – richer */}
            <div style={{ marginTop: 14, background: `linear-gradient(135deg, ${theme.wall}10, rgba(0,0,0,0.4))`, borderRadius: 14, padding: 16, border: `1px solid ${theme.wall}33`, cursor: "pointer", transition: "all 0.25s", boxShadow: `inset 0 1px 0 ${theme.wall}15`, position: "relative", overflow: "hidden" }}
              onClick={() => setPhase(PHASES.WALLS)}
              onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.borderColor = `${theme.wall}66`; e.currentTarget.style.boxShadow = `0 4px 16px ${theme.wall}33, inset 0 1px 0 ${theme.wall}33`; }}
              onMouseLeave={e => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.borderColor = `${theme.wall}33`; e.currentTarget.style.boxShadow = `inset 0 1px 0 ${theme.wall}15`; }}>
              <div style={{ position: "absolute", top: -20, right: -20, fontSize: 80, opacity: 0.04, transform: "rotate(15deg)" }}>🧱</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, position: "relative" }}>
                <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: theme.wall, fontFamily: "'Cinzel', serif", fontWeight: 700 }}>🧱 Mauer-Fortschritt · TH{thLevel}</span>
                <span style={{ fontFamily: "'Oswald', sans-serif", color: theme.wall, fontSize: 15, fontWeight: 700 }}>
                  {wallsAtMax} / {wallCap || wallTotal}
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginLeft: 4 }}>auf L{wallMaxLevel}</span>
                </span>
              </div>
              <div style={{ background: "rgba(0,0,0,0.5)", borderRadius: 6, height: 10, overflow: "hidden", border: "1px solid rgba(255,255,255,0.04)", position: "relative" }}>
                <div style={{ height: "100%", borderRadius: 6, background: `linear-gradient(90deg, ${theme.wallDark}, ${theme.wall}, ${theme.wallLight})`, width: `${wallPercent}%`, transition: "width 0.6s ease", boxShadow: `0 0 12px ${theme.wall}77` }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 8, position: "relative" }}>
                <span>{wallPercent}% gesamt</span>
                <span>Noch <strong style={{ color: theme.wall }}>{formatNum(wallCostRemaining)}</strong> nötig →</span>
              </div>
            </div>
          </div>
        )}

        {/* ═══ COUNTDOWN ═══ */}
        {phase === PHASES.COUNTDOWN && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", animation: "fadeIn 0.3s ease" }}>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", fontFamily: "'Cinzel', serif", letterSpacing: 3, marginBottom: 24 }}>
              WECHSLE INS SPIEL
            </div>
            <div key={countdownValue} style={{
              fontFamily: "'Cinzel', serif", fontSize: countdownValue === 0 ? 96 : 140, fontWeight: 900,
              background: countdownValue === 0
                ? "linear-gradient(135deg, #00ff64, #d4a843, #FFD700)"
                : "linear-gradient(135deg, #FFD700, #FFA500, #FFD700)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
              letterSpacing: countdownValue === 0 ? 8 : 0,
              animation: "countdownPop 1s ease-out",
              lineHeight: 1,
              filter: "drop-shadow(0 0 30px rgba(255,215,0,0.4))",
            }}>
              {countdownValue === 0 ? "LOS!" : countdownValue}
            </div>
            <div style={{ marginTop: 40, display: "flex", gap: 10 }}>
              <Btn small secondary color="rgba(255,255,255,0.4)" onClick={() => setPhase(PHASES.SETUP)}>← Abbrechen</Btn>
              <Btn small color="#FFD700" onClick={beginRunning}>⏭ Überspringen</Btn>
            </div>
            <div style={{ marginTop: 16, fontSize: 11, color: "rgba(255,255,255,0.3)", textAlign: "center" }}>
              Wechsle jetzt zu Clash of Clans – der Timer startet gleich
            </div>
          </div>
        )}

        {/* ═══ RUNNING / PAUSED / SPEND FLOW ═══ */}
        {isAnyActivePhase && (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            {/* Long-session warning */}
            {(() => {
              const warnMs = longSessionWarnMin * 60_000;
              if (longSessionWarnDismissed || warnMs <= 0 || elapsed < warnMs) return null;
              const hours = Math.floor(elapsed / 3600_000);
              const mins = Math.floor((elapsed % 3600_000) / 60_000);
              return (
                <div style={{ background: "linear-gradient(135deg, rgba(255,165,0,0.12), rgba(255,80,80,0.08))", borderRadius: 12, padding: 14, marginBottom: 16, border: "1px solid rgba(255,165,0,0.35)", boxShadow: "0 0 20px rgba(255,165,0,0.1)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 18 }}>⏰</span>
                        <span style={{ fontFamily: "'Cinzel', serif", fontSize: 13, color: "#FFA500", letterSpacing: 1.5, fontWeight: 700 }}>LANGE SESSION</span>
                      </div>
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", lineHeight: 1.4 }}>
                        Diese Session läuft seit <strong style={{ color: "#FFA500" }}>{hours}h {mins}min</strong>. Hast du vergessen sie zu beenden? Falsche Zeit verfälscht deine Stats.
                      </div>
                    </div>
                    <button onClick={() => setLongSessionWarnDismissed(true)}
                      style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, color: "rgba(255,255,255,0.5)", padding: "4px 10px", fontSize: 11, fontFamily: "'Cinzel', serif", letterSpacing: 1, cursor: "pointer", flexShrink: 0 }}>
                      ✓ OK
                    </button>
                  </div>
                </div>
              );
            })()}
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 56, fontWeight: 700, letterSpacing: 4, color: phase !== PHASES.RUNNING ? "#FFA500" : "#FFD700", textShadow: phase !== PHASES.RUNNING ? "0 0 30px rgba(255,165,0,0.3)" : "0 0 30px rgba(255,215,0,0.2)", transition: "color 0.3s" }}>
                {formatTime(elapsed)}
              </div>
              {phase === PHASES.PAUSED && <div style={{ fontSize: 13, color: "#FFA500", fontFamily: "'Cinzel', serif", letterSpacing: 2, animation: "pulse 1.5s infinite" }}>⏸ PAUSIERT</div>}
              {phase === PHASES.PAUSED_SPEND_BEFORE && <div style={{ fontSize: 13, color: "#FFA500", fontFamily: "'Cinzel', serif", letterSpacing: 2, animation: "pulse 1.5s infinite" }}>⏸ LOOT VOR AUSGABEN EINTRAGEN</div>}
              {phase === PHASES.PAUSED_SPEND_AFTER && <div style={{ fontSize: 13, color: "#FFA500", fontFamily: "'Cinzel', serif", letterSpacing: 2, animation: "pulse 1.5s infinite" }}>⏸ LOOT NACH AUSGABEN EINTRAGEN</div>}
              {phase === PHASES.RUNNING && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>Aktueller Lap: {formatMs(currentLapTime)}</div>}
            </div>

            {/* Action Buttons */}
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", justifyContent: "center" }}>
              {phase === PHASES.RUNNING && <Btn onClick={addLap} style={{ flex: "1 1 auto" }}>⚔ LAP (Leertaste)</Btn>}
              {(phase === PHASES.RUNNING || phase === PHASES.PAUSED) && (
                <Btn onClick={togglePause} secondary color="#FFA500" style={{ flex: "1 1 auto" }}>
                  {phase === PHASES.PAUSED ? "▶ WEITER (P)" : "⏸ PAUSE (P)"}
                </Btn>
              )}
              {(phase === PHASES.RUNNING || phase === PHASES.PAUSED) && (
                <Btn onClick={startSpendFlow} secondary color="#E84CFF" small style={{ flex: "0 0 auto" }}>💰 LOOT AUSGEBEN (L)</Btn>
              )}
              {isAnyActivePhase && (
                <Btn onClick={endSession} secondary color="#ff4444" small style={{ flex: "0 0 auto" }}>■ ENDE (E)</Btn>
              )}
            </div>

            {/* Spend Flow – Step 1: Loot VOR Ausgaben */}
            {phase === PHASES.PAUSED_SPEND_BEFORE && (
              <div style={{ background: "rgba(232,76,255,0.06)", borderRadius: 12, padding: 16, marginBottom: 16, border: "1px solid rgba(232,76,255,0.2)", animation: "fadeIn 0.3s ease" }}>
                <h3 style={{ fontFamily: "'Cinzel', serif", fontSize: 12, letterSpacing: 2, color: "#E84CFF", marginTop: 0, marginBottom: 4 }}>SCHRITT 1: AKTUELLER LAGERSTAND</h3>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 0, marginBottom: 12 }}>Trage deinen Loot ein, BEVOR du ihn ausgibst.</p>
                <ScanButton target="preSpend" />
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <LootInput label="Gold" value={preSpendLoot.gold} onChange={(v) => setPreSpendLoot((p) => ({ ...p, gold: v }))} />
                  <LootInput label="Elixir" value={preSpendLoot.elixir} onChange={(v) => setPreSpendLoot((p) => ({ ...p, elixir: v }))} />
                  <LootInput label="Dunkles Elixir" value={preSpendLoot.dark} onChange={(v) => setPreSpendLoot((p) => ({ ...p, dark: v }))} />
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <Btn onClick={spendStepNext} color="#E84CFF" style={{ flex: 1 }}>WEITER → AUSGEBEN</Btn>
                  <Btn onClick={cancelSpend} secondary color="rgba(255,255,255,0.4)" small>Abbrechen</Btn>
                </div>
              </div>
            )}

            {/* Spend Flow – Step 2: Loot NACH Ausgaben */}
            {phase === PHASES.PAUSED_SPEND_AFTER && (
              <div style={{ background: "rgba(255,165,0,0.08)", borderRadius: 12, padding: 16, marginBottom: 16, border: "1px solid rgba(255,165,0,0.2)", animation: "fadeIn 0.3s ease" }}>
                <h3 style={{ fontFamily: "'Cinzel', serif", fontSize: 12, letterSpacing: 2, color: "#FFA500", marginTop: 0, marginBottom: 4 }}>SCHRITT 2: NEUER LAGERSTAND</h3>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 0, marginBottom: 12 }}>Gib jetzt deinen Loot aus & trage den neuen Stand ein.</p>
                <ScanButton target="spend" />
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <LootInput label="Gold" value={spendLoot.gold} onChange={(v) => setSpendLoot((p) => ({ ...p, gold: v }))} />
                  <LootInput label="Elixir" value={spendLoot.elixir} onChange={(v) => setSpendLoot((p) => ({ ...p, elixir: v }))} />
                  <LootInput label="Dunkles Elixir" value={spendLoot.dark} onChange={(v) => setSpendLoot((p) => ({ ...p, dark: v }))} />
                </div>
                {/* Preview of what's being spent */}
                {(() => {
                  const bG = parseInt(preSpendLoot.gold) || 0;
                  const aG = parseInt(spendLoot.gold) || 0;
                  const bE = parseInt(preSpendLoot.elixir) || 0;
                  const aE = parseInt(spendLoot.elixir) || 0;
                  const bD = parseInt(preSpendLoot.dark) || 0;
                  const aD = parseInt(spendLoot.dark) || 0;
                  const sG = bG - aG; const sE = bE - aE; const sD = bD - aD;
                  if (sG > 0 || sE > 0 || sD > 0) return (
                    <div style={{ marginTop: 10, padding: 10, background: "rgba(0,0,0,0.3)", borderRadius: 8, fontSize: 12 }}>
                      <div style={{ color: "rgba(255,255,255,0.4)", marginBottom: 6, fontFamily: "'Cinzel', serif", fontSize: 10, letterSpacing: 1 }}>AUSGEGEBEN:</div>
                      {sG > 0 && <div style={{ color: "#FFD700" }}>Gold: {formatNum(sG)}</div>}
                      {sE > 0 && <div style={{ color: "#E84CFF" }}>Elixir: {formatNum(sE)}</div>}
                      {sD > 0 && <div style={{ color: "#3DD6F5" }}>Dunkles: {formatNum(sD)}</div>}
                    </div>
                  );
                  return null;
                })()}
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <Btn onClick={spendStepFinish} color="#FFA500" style={{ flex: 1 }}>✓ FERTIG – WEITER FARMEN</Btn>
                  <Btn onClick={() => setPhase(PHASES.PAUSED_SPEND_BEFORE)} secondary color="rgba(255,255,255,0.4)" small>← Zurück</Btn>
                </div>
              </div>
            )}
            {liveStats && (
              <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 12, padding: 14, marginBottom: 16, border: "1px solid rgba(255,215,0,0.08)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div><div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: 1 }}>Angriffe</div><div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 28, color: "#FFD700" }}>{liveStats.count}</div></div>
                  <div style={{ textAlign: "right" }}><div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: 1 }}>Ø Dauer</div><div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 28, color: "#FFD700" }}>{formatMs(liveStats.avgMs)}</div></div>
                  <div style={{ textAlign: "right" }}><div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: 1 }}>Ø /Stunde</div><div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 28, color: "#FFD700" }}>{elapsed > 0 ? Math.round(liveStats.count / (elapsed / 3600000)) : 0}</div></div>
                </div>
              </div>
            )}
            {laps.length > 0 && (
              <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 12, padding: 14, border: "1px solid rgba(255,215,0,0.08)" }}>
                <h3 style={{ fontFamily: "'Cinzel', serif", fontSize: 12, letterSpacing: 2, color: "rgba(255,255,255,0.5)", marginTop: 0, marginBottom: 10 }}>LAPS</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflowY: "auto" }}>
                  {laps.map((lap, i) => {
                    const best = laps.length > 1 && lap.duration === Math.min(...laps.map((l) => l.duration));
                    const worst = laps.length > 1 && lap.duration === Math.max(...laps.map((l) => l.duration));
                    return (
                      <div key={lap.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", borderRadius: 6, background: best ? "rgba(0,255,100,0.06)" : worst ? "rgba(255,50,50,0.06)" : "rgba(255,255,255,0.02)", border: best ? "1px solid rgba(0,255,100,0.15)" : worst ? "1px solid rgba(255,50,50,0.15)" : "1px solid transparent" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontFamily: "'Oswald', sans-serif", color: "rgba(255,255,255,0.3)", fontSize: 13 }}>#{i + 1}</span>
                          <span style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, color: best ? "#00ff64" : worst ? "#ff4444" : "#fff" }}>{formatMs(lap.duration)}</span>
                          {best && <span style={{ fontSize: 10, color: "#00ff64", fontWeight: 700 }}>⚡ SCHNELLSTE</span>}
                          {worst && <span style={{ fontSize: 10, color: "#ff4444", fontWeight: 700 }}>🐢 LANGSAMSTE</span>}
                        </div>
                        <button onClick={() => removeLap(i)} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.2)", cursor: "pointer", fontSize: 16, padding: "2px 6px" }} title="Lap entfernen">✕</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ RESULTS ═══ */}
        {phase === PHASES.RESULTS && (
          <div style={{ animation: "fadeIn 0.4s ease" }}>
            <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 16, padding: 20, marginBottom: 16, border: "1px solid rgba(255,215,0,0.1)" }}>
              <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 14, letterSpacing: 2, color: "rgba(255,255,255,0.6)", marginTop: 0, marginBottom: 16 }}>AKTUELLEN LOOT EINTRAGEN</h2>
              <ScanButton target="end" />
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <LootInput label="Gold" value={endLoot.gold} onChange={(v) => setEndLoot((p) => ({ ...p, gold: v }))} />
                <LootInput label="Elixir" value={endLoot.elixir} onChange={(v) => setEndLoot((p) => ({ ...p, elixir: v }))} />
                <LootInput label="Dunkles Elixir" value={endLoot.dark} onChange={(v) => setEndLoot((p) => ({ ...p, dark: v }))} />
              </div>
            </div>
            {results && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
                <div style={{ textAlign: "center", padding: 14, background: "rgba(0,0,0,0.3)", borderRadius: 12, border: "1px solid rgba(255,215,0,0.1)" }}>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: 2 }}>Session</div>
                  <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, color: "#FFD700", marginTop: 4 }}>{formatMs(results.totalMs)} • {results.attacks} Angriffe • Ø {formatMs(results.avgLapMs)}</div>
                  {results.attacks > 1 && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginTop: 4 }}>Schnellste: {formatMs(results.bestLap)} | Langsamste: {formatMs(results.worstLap)}</div>}
                </div>
                <StatCard label="Gesamt-Loot" gold={results.totalLoot.gold} elixir={results.totalLoot.elixir} dark={results.totalLoot.dark} />
                <StatCard label="Ø pro Angriff" gold={results.avgPerAttack.gold} elixir={results.avgPerAttack.elixir} dark={results.avgPerAttack.dark} />
                <StatCard label="Loot pro Stunde" gold={results.perHour.gold} elixir={results.perHour.elixir} dark={results.perHour.dark} />
                {results.spent.gold + results.spent.elixir + results.spent.dark > 0 && (
                  <StatCard label="Zwischendurch ausgegeben" gold={results.spent.gold} elixir={results.spent.elixir} dark={results.spent.dark} />
                )}
                {/* Comparison vs. Average of previous sessions */}
                {(() => {
                  const cmp = compareToAverage(null);
                  if (!cmp) return null;
                  return (
                    <div style={{ background: "linear-gradient(135deg, rgba(255,215,0,0.04), rgba(232,76,255,0.04))", borderRadius: 12, padding: "16px 18px", border: "1px solid rgba(255,215,0,0.15)" }}>
                      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "rgba(255,255,255,0.5)", fontFamily: "'Cinzel', serif", marginBottom: 12 }}>
                        ⚡ Diese Session vs. dein Schnitt ({cmp.sessionCount})
                      </div>
                      <ComparisonBar label="Gold / Stunde" current={results.perHour.gold} average={cmp.avgGoldPerHour} color="#FFD700" />
                      <ComparisonBar label="Elixir / Stunde" current={results.perHour.elixir} average={cmp.avgElixirPerHour} color="#E84CFF" />
                      {(cmp.avgDarkPerHour > 0 || results.perHour.dark > 0) && (
                        <ComparisonBar label="Dunkles / Stunde" current={results.perHour.dark} average={cmp.avgDarkPerHour} color="#3DD6F5" />
                      )}
                    </div>
                  );
                })()}
                {/* New records this session sets */}
                {(() => {
                  const breaks = newRecordsForCurrent(results);
                  if (breaks.length === 0) return null;
                  return (
                    <div style={{ background: "linear-gradient(135deg, rgba(255,215,0,0.12), rgba(0,255,100,0.06))", borderRadius: 12, padding: "14px 18px", border: "1px solid rgba(255,215,0,0.4)", boxShadow: "0 0 20px rgba(255,215,0,0.15)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                        <span style={{ fontSize: 22 }}>🏆</span>
                        <span style={{ fontFamily: "'Cinzel', serif", fontSize: 13, color: "#FFD700", letterSpacing: 2, fontWeight: 700 }}>NEUE BESTLEISTUNG{breaks.length > 1 ? "EN" : ""}!</span>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {breaks.map((b) => (
                          <span key={b.label} style={{ fontSize: 11, fontFamily: "'Cinzel', serif", letterSpacing: 1, padding: "4px 10px", borderRadius: 6, background: `${b.color}22`, border: `1px solid ${b.color}55`, color: b.color, fontWeight: 700 }}>
                            🏆 {b.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn onClick={saveAndReset} style={{ flex: 1 }}>💾 SPEICHERN</Btn>
              <Btn onClick={() => exportSession(null)} secondary color="#FFD700" style={{ flex: 1 }}>📋 EXPORTIEREN</Btn>
              <Btn onClick={resetAll} secondary color="rgba(255,255,255,0.4)" small>VERWERFEN</Btn>
            </div>
          </div>
        )}

        {/* ═══ HISTORY ═══ */}
        {phase === PHASES.HISTORY && (
          <div style={{ animation: "fadeIn 0.4s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 16, color: "#FFD700", margin: 0 }}>GESPEICHERTE SESSIONS</h2>
              {viewingSession && (
                <Btn small secondary color="rgba(255,255,255,0.4)" onClick={() => setViewingSession(null)}>← Alle</Btn>
              )}
            </div>
            {viewingSession && viewResults ? (
              <div style={{ animation: "fadeIn 0.3s ease" }}>
                <div style={{ marginBottom: 12 }}>
                  <span style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>{viewingSession.date}</span>
                </div>
                {/* Show records held by this session, if any */}
                {(() => {
                  const held = recordsForSession(viewingSession.id);
                  if (held.length === 0) return null;
                  return (
                    <div style={{ background: "linear-gradient(135deg, rgba(255,215,0,0.1), rgba(255,165,0,0.04))", borderRadius: 12, padding: "12px 16px", marginBottom: 12, border: "1px solid rgba(255,215,0,0.3)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                        <span style={{ fontSize: 18 }}>🏆</span>
                        <span style={{ fontFamily: "'Cinzel', serif", fontSize: 12, color: "#FFD700", letterSpacing: 2, fontWeight: 700 }}>HÄLT AKTUELLE REKORDE</span>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {held.map((r) => (
                          <span key={r.key} style={{ fontSize: 11, padding: "3px 8px", background: `${r.color}22`, border: `1px solid ${r.color}55`, borderRadius: 4, color: r.color, fontFamily: "'Cinzel', serif", letterSpacing: 1, fontWeight: 700 }}>
                            {r.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                <div style={{ textAlign: "center", padding: 14, background: "rgba(0,0,0,0.3)", borderRadius: 12, marginBottom: 12, border: "1px solid rgba(255,215,0,0.1)" }}>
                  <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, color: "#FFD700" }}>{formatMs(viewResults.totalMs)} • {viewResults.attacks} Angriffe • Ø {formatMs(viewResults.avgLapMs)}</div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 12 }}>
                  <StatCard label="Gesamt-Loot" gold={viewResults.totalLoot.gold} elixir={viewResults.totalLoot.elixir} dark={viewResults.totalLoot.dark} />
                  <StatCard label="Ø pro Angriff" gold={viewResults.avgPerAttack.gold} elixir={viewResults.avgPerAttack.elixir} dark={viewResults.avgPerAttack.dark} />
                  <StatCard label="Loot pro Stunde" gold={viewResults.perHour.gold} elixir={viewResults.perHour.elixir} dark={viewResults.perHour.dark} />
                  {/* Per-Lap Bar Chart */}
                  {viewingSession.laps && viewingSession.laps.length > 0 && (
                    <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: "14px 16px", border: "1px solid rgba(255,215,0,0.1)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "rgba(255,255,255,0.5)", fontFamily: "'Cinzel', serif" }}>📊 Angriffsdauer pro Lap</span>
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>{viewingSession.laps.length} Laps</span>
                      </div>
                      <LapBarChart laps={viewingSession.laps} color="#FFD700" />
                    </div>
                  )}
                  {/* Comparison vs. average of OTHER sessions */}
                  {(() => {
                    const cmp = compareToAverage(viewingSession.id);
                    if (!cmp) return null;
                    return (
                      <div style={{ background: "linear-gradient(135deg, rgba(255,215,0,0.04), rgba(232,76,255,0.04))", borderRadius: 12, padding: "16px 18px", border: "1px solid rgba(255,215,0,0.15)" }}>
                        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "rgba(255,255,255,0.5)", fontFamily: "'Cinzel', serif", marginBottom: 12 }}>
                          ⚡ Diese Session vs. Schnitt ({cmp.sessionCount} andere)
                        </div>
                        <ComparisonBar label="Gold / Stunde" current={viewResults.perHour.gold} average={cmp.avgGoldPerHour} color="#FFD700" />
                        <ComparisonBar label="Elixir / Stunde" current={viewResults.perHour.elixir} average={cmp.avgElixirPerHour} color="#E84CFF" />
                        {(cmp.avgDarkPerHour > 0 || viewResults.perHour.dark > 0) && (
                          <ComparisonBar label="Dunkles / Stunde" current={viewResults.perHour.dark} average={cmp.avgDarkPerHour} color="#3DD6F5" />
                        )}
                      </div>
                    );
                  })()}
                </div>
                <Btn onClick={() => exportSession(viewingSession)} secondary color="#FFD700" small style={{ width: "100%" }}>📋 EXPORTIEREN</Btn>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {sessions.length === 0 && <p style={{ color: "rgba(255,255,255,0.4)", textAlign: "center" }}>Noch keine Sessions gespeichert.</p>}
                {/* Trend Chart Header */}
                {sessions.length >= 2 && (
                  <div style={{ background: "linear-gradient(135deg, rgba(255,215,0,0.05), rgba(232,76,255,0.03))", borderRadius: 12, padding: 14, border: "1px solid rgba(255,215,0,0.12)", marginBottom: 6 }}>
                    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "rgba(255,255,255,0.5)", fontFamily: "'Cinzel', serif", marginBottom: 12 }}>📈 Trend (älteste → neueste)</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", fontFamily: "'Cinzel', serif", letterSpacing: 1 }}>Gold + Elixir / h</div>
                          <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, color: "#FFD700" }}>
                            {formatNum(sessionStatsList[sessionStatsList.length - 1]?.goldElixirPerHour || 0)}
                          </div>
                        </div>
                        <SparkLine data={sessionStatsList.map(s => s.goldElixirPerHour)} color="#FFD700" width={140} height={32} />
                      </div>
                      {sessionStatsList.some(s => s.darkPerHour > 0) && (
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", fontFamily: "'Cinzel', serif", letterSpacing: 1 }}>Dunkles / h</div>
                            <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, color: "#3DD6F5" }}>
                              {formatNum(sessionStatsList[sessionStatsList.length - 1]?.darkPerHour || 0)}
                            </div>
                          </div>
                          <SparkLine data={sessionStatsList.map(s => s.darkPerHour)} color="#3DD6F5" width={140} height={32} />
                        </div>
                      )}
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", fontFamily: "'Cinzel', serif", letterSpacing: 1 }}>Ø Angriffsdauer</div>
                          <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, color: "#FFA500" }}>
                            {formatMs(sessionStatsList[sessionStatsList.length - 1]?.avgLapMs || 0)}
                          </div>
                        </div>
                        {/* Invert avgLapMs trend so "down is good" by flipping data sign visually */}
                        <SparkLine data={sessionStatsList.map(s => -s.avgLapMs)} color="#FFA500" width={140} height={32} />
                      </div>
                    </div>
                  </div>
                )}
                {sessions.map((s, idx) => {
                  const r = calcResults(s);
                  // Find this session in sessionStatsList (which is reversed)
                  const idxInStats = sessionStatsList.findIndex(x => x.id === s.id);
                  const goldElixirPerHour = r.perHour.gold + r.perHour.elixir;
                  const heldRecords = recordsForSession(s.id);
                  return (
                    <div key={s.id} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 14, border: heldRecords.length > 0 ? "1px solid rgba(255,215,0,0.35)" : "1px solid rgba(255,215,0,0.08)", cursor: "pointer", transition: "border-color 0.2s", position: "relative" }}
                      onClick={() => setViewingSession(s)}
                      onMouseEnter={(e) => e.currentTarget.style.borderColor = "rgba(255,215,0,0.5)"}
                      onMouseLeave={(e) => e.currentTarget.style.borderColor = heldRecords.length > 0 ? "rgba(255,215,0,0.35)" : "rgba(255,215,0,0.08)"}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>{s.date}</span>
                            {heldRecords.length > 0 && (
                              <span style={{ fontSize: 11, color: "#FFD700", fontFamily: "'Cinzel', serif", letterSpacing: 1, background: "rgba(255,215,0,0.12)", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }} title={heldRecords.map(r => r.label).join(", ")}>
                                🏆 {heldRecords.length}× Rekord
                              </span>
                            )}
                          </div>
                          <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, color: "#FFD700", marginTop: 4 }}>{r.attacks} Angriffe • {formatMs(r.totalMs)}</div>
                          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>Gold: {formatNum(r.totalLoot.gold)} | Elixir: {formatNum(r.totalLoot.elixir)} | DE: {formatNum(r.totalLoot.dark)}</div>
                          <div style={{ fontSize: 11, color: "rgba(255,215,0,0.5)", marginTop: 4, fontFamily: "'Oswald', sans-serif" }}>{formatNum(goldElixirPerHour)} G+E/h</div>
                        </div>
                        <button onClick={(ev) => { ev.stopPropagation(); deleteSession(s.id); }} style={{ background: "none", border: "none", color: "rgba(255,80,80,0.5)", cursor: "pointer", fontSize: 18, padding: "4px 8px" }} title="Session löschen">🗑</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ═══ WALLS ═══ */}
        {phase === PHASES.WALLS && (
          <div style={{ animation: "fadeIn 0.4s ease" }}>
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 16, color: "#b08d57", margin: 0 }}>🧱 MAUER-TRACKER</h2>
            </div>

            {/* TH Selector */}
            <div style={{ background: "rgba(176,141,87,0.06)", borderRadius: 12, padding: 14, border: "1px solid rgba(176,141,87,0.15)", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "#b08d57", fontFamily: "'Cinzel', serif", fontWeight: 700 }}>Rathaus</span>
                <select value={thLevel} onChange={(e) => changeThLevel(parseInt(e.target.value))}
                  style={{ background: "rgba(0,0,0,0.5)", color: "#d4a843", border: "1px solid rgba(176,141,87,0.3)", borderRadius: 8, padding: "6px 10px", fontFamily: "'Oswald', sans-serif", fontSize: 14, outline: "none", cursor: "pointer" }}>
                  {Object.keys(TH_WALL_COUNTS).filter(t => parseInt(t) >= 2).map(t => (
                    <option key={t} value={t}>TH{t}</option>
                  ))}
                </select>
              </div>
              <div style={{ textAlign: "right", fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
                <div style={{ fontFamily: "'Oswald', sans-serif", color: "#d4a843", fontSize: 16 }}>{wallTotal} Mauern</div>
                <div>Max Level: L{wallMaxLevel}{wallCap ? ` (Cap: ${wallCap})` : ""}</div>
              </div>
            </div>

            {/* Progress Ring */}
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <div style={{ position: "relative", width: 180, height: 180, margin: "0 auto" }}>
                <svg viewBox="0 0 180 180" style={{ transform: "rotate(-90deg)" }}>
                  <circle cx="90" cy="90" r="78" fill="none" stroke="rgba(176,141,87,0.12)" strokeWidth="10" />
                  <circle cx="90" cy="90" r="78" fill="none" stroke="url(#wallGrad)" strokeWidth="10"
                    strokeDasharray={`${2 * Math.PI * 78}`}
                    strokeDashoffset={`${2 * Math.PI * 78 * (1 - parseFloat(wallPercent) / 100)}`}
                    strokeLinecap="round" style={{ transition: "stroke-dashoffset 0.6s ease" }} />
                  <defs><linearGradient id="wallGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#8B6914" /><stop offset="50%" stopColor="#d4a843" /><stop offset="100%" stopColor="#b08d57" /></linearGradient></defs>
                </svg>
                <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", textAlign: "center" }}>
                  <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 36, fontWeight: 700, color: "#d4a843", lineHeight: 1 }}>{wallPercent}%</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 4 }}>{wallsAtMax}{wallCap ? `/${wallCap}` : ""} auf L{wallMaxLevel}</div>
                </div>
              </div>
              {wallCap && (
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 8 }}>
                  Hinweis: Nur {wallCap} von {wallTotal} Mauern können auf L{wallMaxLevel}. Der Rest bleibt auf L{wallMaxLevel - 1}.
                </div>
              )}
            </div>

            {/* Distribution view */}
            <div style={{ background: "rgba(176,141,87,0.06)", borderRadius: 14, padding: 16, border: "1px solid rgba(176,141,87,0.15)", marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "#b08d57", fontFamily: "'Cinzel', serif", fontWeight: 700 }}>Verteilung</span>
                {!editingWalls ? (
                  <button onClick={() => { setEditingWalls(true); setDraftWalls({ ...wallsByLevel }); }}
                    style={{ background: "rgba(176,141,87,0.2)", border: "1px solid rgba(176,141,87,0.4)", borderRadius: 6, color: "#d4a843", padding: "4px 10px", fontSize: 11, fontFamily: "'Cinzel', serif", letterSpacing: 1, cursor: "pointer" }}>
                    ✎ Anpassen
                  </button>
                ) : (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={applyDraftWalls}
                      style={{ background: "#d4a843", border: "none", borderRadius: 6, color: "#1a0f00", padding: "4px 10px", fontSize: 11, fontFamily: "'Cinzel', serif", letterSpacing: 1, fontWeight: 700, cursor: "pointer" }}>
                      ✓ Speichern
                    </button>
                    <button onClick={() => { setEditingWalls(false); setDraftWalls(null); }}
                      style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, color: "rgba(255,255,255,0.5)", padding: "4px 10px", fontSize: 11, fontFamily: "'Cinzel', serif", letterSpacing: 1, cursor: "pointer" }}>
                      Abbrechen
                    </button>
                  </div>
                )}
              </div>
              {(() => {
                const source = editingWalls ? draftWalls : wallsByLevel;
                if (!source) return null;
                // Show levels from 1 up to maxLevel, but only those with count > 0 unless editing
                const levels = [];
                for (let L = 1; L <= wallMaxLevel; L++) {
                  if (editingWalls || (source[L] || 0) > 0) levels.push(L);
                }
                if (!editingWalls && levels.length === 0) levels.push(wallMaxLevel - 1);
                const maxCount = Math.max(...Object.values(source).map(v => v || 0), 1);
                const sum = sumWalls(source);
                const isSumValid = sum === wallTotal;
                return (
                  <>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {levels.reverse().map((L) => {
                        const count = source[L] || 0;
                        const color = wallLevelColor(L);
                        const isCapped = wallCap && L === wallMaxLevel && count >= wallCap;
                        return (
                          <div key={L} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span style={{ fontFamily: "'Oswald', sans-serif", color, fontSize: 14, width: 38, textAlign: "right" }}>L{L}</span>
                            <div style={{ flex: 1, height: 8, background: "rgba(0,0,0,0.4)", borderRadius: 4, overflow: "hidden", position: "relative" }}>
                              <div style={{ height: "100%", width: `${(count / Math.max(wallTotal, 1)) * 100}%`, background: color, borderRadius: 4, transition: "width 0.3s ease", boxShadow: `0 0 6px ${color}66` }} />
                            </div>
                            {editingWalls ? (
                              <input type="number" min="0" max={wallTotal}
                                value={count === 0 ? "" : count}
                                placeholder="0"
                                onChange={(e) => {
                                  const raw = e.target.value;
                                  if (raw === "") {
                                    setDraftWalls(d => ({ ...d, [L]: 0 }));
                                  } else {
                                    const v = parseInt(raw, 10);
                                    if (!isNaN(v)) setDraftWalls(d => ({ ...d, [L]: Math.max(0, v) }));
                                  }
                                }}
                                onFocus={(e) => e.target.select()}
                                style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(176,141,87,0.3)", borderRadius: 6, padding: "4px 8px", color: "#d4a843", fontSize: 13, fontFamily: "'Oswald', sans-serif", width: 56, textAlign: "center", outline: "none" }} />
                            ) : (
                              <span style={{ fontFamily: "'Oswald', sans-serif", color: "#d4a843", fontSize: 14, width: 44, textAlign: "right" }}>{count}</span>
                            )}
                            {isCapped && <span style={{ fontSize: 9, color: "#FFA500", fontFamily: "'Cinzel', serif", letterSpacing: 1 }}>CAP</span>}
                          </div>
                        );
                      })}
                    </div>
                    {editingWalls && (
                      <div style={{ marginTop: 12, padding: 10, background: isSumValid ? "rgba(0,255,100,0.08)" : "rgba(255,165,0,0.1)", borderRadius: 8, fontSize: 12, textAlign: "center", color: isSumValid ? "#00ff64" : "#FFA500" }}>
                        Summe: {sum} / {wallTotal} {isSumValid ? "✓" : `(${sum > wallTotal ? "−" : "+"}${Math.abs(wallTotal - sum)})`}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            {/* Upgrade controls - one row per source level with walls */}
            {!editingWalls && (
              <div style={{ background: "rgba(176,141,87,0.06)", borderRadius: 14, padding: 18, border: "1px solid rgba(176,141,87,0.15)", marginBottom: 14 }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "#b08d57", fontFamily: "'Cinzel', serif", fontWeight: 700, marginBottom: 14, textAlign: "center" }}>Mauern verbessern</div>
                {(() => {
                  const upgradeable = [];
                  for (let L = 1; L < wallMaxLevel; L++) {
                    if ((wallsByLevel[L] || 0) > 0) upgradeable.push(L);
                  }
                  if (upgradeable.length === 0) {
                    return <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", textAlign: "center" }}>🎉 Alle Mauern auf maximal möglichem Level!</div>;
                  }
                  return upgradeable.map((L) => {
                    const toLevel = L + 1;
                    const cost = WALL_COST_TABLE[L];
                    const resource = L >= ELIXIR_ALLOWED_FROM ? "Gold/Elixir" : "Gold";
                    const caps = WALL_LEVEL_CAPS[thLevel] || {};
                    const capAtTo = caps[toLevel];
                    const atFrom = wallsByLevel[L] || 0;
                    const atTo = wallsByLevel[toLevel] || 0;
                    const maxUpgradable = capAtTo !== undefined ? Math.min(atFrom, capAtTo - atTo) : atFrom;
                    return (
                      <div key={L} style={{ marginBottom: 12, padding: 10, background: "rgba(0,0,0,0.25)", borderRadius: 10, border: "1px solid rgba(176,141,87,0.08)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 4 }}>
                          <span style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, color: "#d4a843" }}>
                            L{L} <span style={{ color: "rgba(255,255,255,0.3)" }}>→</span> L{toLevel}
                          </span>
                          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontFamily: "'Oswald', sans-serif" }}>
                            {formatNum(cost)} {resource}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
                          {[1, 5, 10, 25].map((n) => {
                            const disabled = maxUpgradable < n;
                            return (
                              <button key={n} onClick={() => upgradeWallsAtLevel(L, n)} disabled={disabled}
                                style={{ background: disabled ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg, #8B6914, #b08d57)", color: disabled ? "rgba(255,255,255,0.2)" : "#1a0f00", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 14, fontFamily: "'Oswald', sans-serif", fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", transition: "all 0.2s", minWidth: 44 }}>
                                +{n}
                              </button>
                            );
                          })}
                          {maxUpgradable > 0 && maxUpgradable < 1 && (
                            <button onClick={() => upgradeWallsAtLevel(L, maxUpgradable)}
                              style={{ background: "linear-gradient(135deg, #8B6914, #b08d57)", color: "#1a0f00", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 14, fontFamily: "'Oswald', sans-serif", fontWeight: 700, cursor: "pointer" }}>
                              Max: +{maxUpgradable}
                            </button>
                          )}
                        </div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 6, textAlign: "center" }}>
                          {atFrom} verfügbar auf L{L}{capAtTo !== undefined ? ` · L${toLevel}: ${atTo}/${capAtTo}` : ""}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            )}

            {/* Wall Stats */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
              <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: "14px 18px", border: "1px solid rgba(176,141,87,0.1)" }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "rgba(255,255,255,0.4)", fontFamily: "'Cinzel', serif", marginBottom: 10 }}>Kosten bis voll geupgraded</div>
                {wallCostObj.gold > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ color: "#FFD700", fontSize: 13 }}>Nur Gold (L1–L4)</span>
                    <span style={{ fontFamily: "'Oswald', sans-serif", color: "#FFD700", fontSize: 16 }}>{formatNum(wallCostObj.gold)}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#d4a843", fontSize: 13 }}>Gold ODER Elixir</span>
                  <span style={{ fontFamily: "'Oswald', sans-serif", color: "#d4a843", fontSize: 16 }}>{formatNum(wallCostObj.goldOrElixir)}</span>
                </div>
                <div style={{ height: 1, background: "rgba(176,141,87,0.15)", margin: "8px 0" }} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, fontFamily: "'Cinzel', serif", letterSpacing: 1 }}>GESAMT</span>
                  <span style={{ fontFamily: "'Oswald', sans-serif", color: "#d4a843", fontSize: 22, fontWeight: 700 }}>{formatNum(wallCostRemaining)}</span>
                </div>
              </div>

              {aggStats && wallCostRemaining > 0 && (
                <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: "14px 18px", border: "1px solid rgba(176,141,87,0.1)" }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "rgba(255,255,255,0.4)", fontFamily: "'Cinzel', serif", marginBottom: 10 }}>
                    Prognose (basierend auf {aggStats.sessionCount} Session{aggStats.sessionCount > 1 ? "s" : ""})
                  </div>
                  {(() => {
                    const hoursNeeded = wallCostRemaining / aggStats.goldElixirPerHour;
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>Ø Gold+Elixir / Stunde</span>
                          <span style={{ fontFamily: "'Oswald', sans-serif", color: "#d4a843", fontSize: 16 }}>{formatNum(aggStats.goldElixirPerHour)}</span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>Reine Farming-Stunden</span>
                          <span style={{ fontFamily: "'Oswald', sans-serif", color: "#d4a843", fontSize: 16 }}>{hoursNeeded.toFixed(1)}h</span>
                        </div>
                        <div style={{ height: 1, background: "rgba(176,141,87,0.15)", margin: "4px 0" }} />
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>Bei 3h Farming/Tag</span>
                          <span style={{ fontFamily: "'Oswald', sans-serif", color: "#d4a843", fontSize: 16 }}>~{Math.ceil(hoursNeeded / 3)} Tage</span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>Bei 5h Farming/Tag</span>
                          <span style={{ fontFamily: "'Oswald', sans-serif", color: "#d4a843", fontSize: 16 }}>~{Math.ceil(hoursNeeded / 5)} Tage</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {!aggStats && wallCostRemaining > 0 && (
                <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 12, padding: 14, border: "1px solid rgba(176,141,87,0.08)", textAlign: "center" }}>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)" }}>💡 Speichere Farming-Sessions, um eine Prognose zu sehen, wie lange du noch für alle Mauern brauchst!</div>
                </div>
              )}

              {wallCostRemaining === 0 && (
                <div style={{ background: "linear-gradient(135deg, rgba(0,255,100,0.1), rgba(212,168,67,0.1))", borderRadius: 12, padding: 18, border: "1px solid rgba(0,255,100,0.2)", textAlign: "center" }}>
                  <div style={{ fontSize: 24, marginBottom: 4 }}>🏆</div>
                  <div style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: "#00ff64", letterSpacing: 2, fontWeight: 700 }}>ALLE MAUERN MAX!</div>
                </div>
              )}
            </div>

            {/* Wall Log */}
            {wallLog.length > 0 && (
              <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 12, padding: 14, border: "1px solid rgba(176,141,87,0.08)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <h3 style={{ fontFamily: "'Cinzel', serif", fontSize: 12, letterSpacing: 2, color: "rgba(255,255,255,0.5)", margin: 0 }}>VERLAUF</h3>
                  <button onClick={async () => { await saveWalls(wallsByLevel, []); showToast("Verlauf gelöscht"); }}
                    style={{ background: "none", border: "none", color: "rgba(255,255,255,0.25)", cursor: "pointer", fontSize: 11 }}>Löschen</button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" }}>
                  {[...wallLog].reverse().slice(0, 30).map((entry, i) => {
                    const isUp = entry.change > 0;
                    const isManual = entry.manualSet;
                    return (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", borderRadius: 4, background: "rgba(0,0,0,0.2)" }}>
                        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>{entry.date}</span>
                        <span style={{ fontFamily: "'Oswald', sans-serif", fontSize: 12, color: isManual ? "#b08d57" : isUp ? "#00ff64" : "#ff6b6b" }}>
                          {isManual
                            ? "manuell gesetzt"
                            : entry.fromLevel !== undefined
                            ? `${isUp ? "+" : ""}${entry.change} · L${entry.fromLevel}→L${entry.toLevel}`
                            : `${isUp ? "+" : ""}${entry.change}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ STATS ═══ */}
        {phase === PHASES.STATS && (
          <div style={{ animation: "fadeIn 0.4s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 16, color: "#FFD700", margin: 0 }}>📊 STATISTIKEN</h2>
              <Btn small secondary color="rgba(255,255,255,0.4)" onClick={() => setPhase(PHASES.SETUP)}>← Zurück</Btn>
            </div>

            {!lifetimeStats && (
              <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 12, padding: 30, textAlign: "center", border: "1px solid rgba(255,215,0,0.08)" }}>
                <div style={{ fontSize: 36, marginBottom: 8 }}>📊</div>
                <div style={{ fontSize: 14, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>Noch keine Daten</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)" }}>Speichere deine erste Session, um hier Statistiken zu sehen.</div>
              </div>
            )}

            {lifetimeStats && (
              <>
                {/* Streak & Active days */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
                  <div style={{ background: "rgba(255,215,0,0.06)", borderRadius: 10, padding: 12, textAlign: "center", border: "1px solid rgba(255,215,0,0.15)" }}>
                    <div style={{ fontSize: 22, marginBottom: 2 }}>🔥</div>
                    <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 22, color: "#FFD700", lineHeight: 1 }}>{lifetimeStats.currentStreak}</div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 4, textTransform: "uppercase", letterSpacing: 1 }}>Aktueller Streak</div>
                  </div>
                  <div style={{ background: "rgba(232,76,255,0.06)", borderRadius: 10, padding: 12, textAlign: "center", border: "1px solid rgba(232,76,255,0.15)" }}>
                    <div style={{ fontSize: 22, marginBottom: 2 }}>🏅</div>
                    <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 22, color: "#E84CFF", lineHeight: 1 }}>{lifetimeStats.longestStreak}</div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 4, textTransform: "uppercase", letterSpacing: 1 }}>Bester Streak</div>
                  </div>
                  <div style={{ background: "rgba(61,214,245,0.06)", borderRadius: 10, padding: 12, textAlign: "center", border: "1px solid rgba(61,214,245,0.15)" }}>
                    <div style={{ fontSize: 22, marginBottom: 2 }}>📅</div>
                    <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 22, color: "#3DD6F5", lineHeight: 1 }}>{lifetimeStats.activeDays}</div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 4, textTransform: "uppercase", letterSpacing: 1 }}>Aktive Tage</div>
                  </div>
                </div>

                {/* Lifetime totals */}
                <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: 16, border: "1px solid rgba(255,215,0,0.1)", marginBottom: 12 }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "rgba(255,255,255,0.4)", fontFamily: "'Cinzel', serif", marginBottom: 12 }}>Insgesamt erfarmt</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 13, color: "#FFD700" }}>💰 Gold</span>
                      <span style={{ fontFamily: "'Oswald', sans-serif", fontSize: 18, color: "#FFD700" }}>{formatNum(lifetimeStats.totalGold)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 13, color: "#E84CFF" }}>🧪 Elixir</span>
                      <span style={{ fontFamily: "'Oswald', sans-serif", fontSize: 18, color: "#E84CFF" }}>{formatNum(lifetimeStats.totalElixir)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 13, color: "#3DD6F5" }}>🌑 Dunkles Elixir</span>
                      <span style={{ fontFamily: "'Oswald', sans-serif", fontSize: 18, color: "#3DD6F5" }}>{formatNum(lifetimeStats.totalDark)}</span>
                    </div>
                    <div style={{ height: 1, background: "rgba(255,215,0,0.1)", margin: "4px 0" }} />
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>⚔ Angriffe gesamt</span>
                      <span style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, color: "#FFA500" }}>{lifetimeStats.totalAttacks}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>⏱ Farming-Zeit</span>
                      <span style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, color: "#FFA500" }}>{formatMs(lifetimeStats.totalMs)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>🧱 Mauern verbessert</span>
                      <span style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, color: "#b08d57" }}>{lifetimeStats.wallsUpgraded}</span>
                    </div>
                  </div>
                </div>

                {/* Averages */}
                <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: 16, border: "1px solid rgba(255,215,0,0.1)", marginBottom: 12 }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "rgba(255,255,255,0.4)", fontFamily: "'Cinzel', serif", marginBottom: 12 }}>Ø pro Stunde (Lifetime)</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>Gold / h</span>
                      <span style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, color: "#FFD700" }}>{formatNum(lifetimeStats.avgGoldPerHour)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>Elixir / h</span>
                      <span style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, color: "#E84CFF" }}>{formatNum(lifetimeStats.avgElixirPerHour)}</span>
                    </div>
                    {lifetimeStats.avgDarkPerHour > 0 && (
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>Dunkles / h</span>
                        <span style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, color: "#3DD6F5" }}>{formatNum(lifetimeStats.avgDarkPerHour)}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Personal Records */}
                <div style={{ background: "linear-gradient(135deg, rgba(255,215,0,0.06), rgba(232,76,255,0.04))", borderRadius: 12, padding: 16, border: "1px solid rgba(255,215,0,0.15)" }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "#FFD700", fontFamily: "'Cinzel', serif", marginBottom: 12, fontWeight: 700 }}>🏆 Persönliche Rekorde</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {[
                      { label: "Bestes Gold / h", rec: records.bestGoldPerHour, format: formatNum, color: "#FFD700" },
                      { label: "Bestes Elixir / h", rec: records.bestElixirPerHour, format: formatNum, color: "#E84CFF" },
                      { label: "Bestes Dunkles / h", rec: records.bestDarkPerHour, format: formatNum, color: "#3DD6F5", hideIfZero: true },
                      { label: "Bestes G+E / h", rec: records.bestGoldElixirPerHour, format: formatNum, color: "#FFD700" },
                      { label: "Größter Einzel-Loot", rec: records.biggestLoot, format: formatNum, color: "#FFA500" },
                      { label: "Meiste Angriffe", rec: records.mostAttacks, format: (v) => String(v), color: "#FFA500" },
                      { label: "Längste Session", rec: records.longestSession, format: formatMs, color: "#FFA500" },
                      { label: "Schnellste Ø-Lap", rec: records.fastestAvgLap, format: formatMs, color: "#00ff64", hideIfInfinity: true },
                    ].filter(item => {
                      if (item.hideIfZero && item.rec.value === 0) return false;
                      if (item.hideIfInfinity && item.rec.value === Infinity) return false;
                      return item.rec.sessionId !== null;
                    }).map((item) => {
                      const session = sessions.find((s) => s.id === item.rec.sessionId);
                      return (
                        <div key={item.label}
                          onClick={() => { if (session) { setViewingSession(session); setPhase(PHASES.HISTORY); } }}
                          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: "rgba(0,0,0,0.3)", borderRadius: 8, cursor: session ? "pointer" : "default", transition: "background 0.2s" }}
                          onMouseEnter={(e) => { if (session) e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
                          onMouseLeave={(e) => { if (session) e.currentTarget.style.background = "rgba(0,0,0,0.3)"; }}>
                          <div>
                            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>{item.label}</div>
                            {session && <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>{session.date}</div>}
                          </div>
                          <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, color: item.color, fontWeight: 700 }}>{item.format(item.rec.value)}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ═══ BACKUP ═══ */}
        {phase === PHASES.BACKUP && (
          <div style={{ animation: "fadeIn 0.4s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 16, color: "#3DD6F5", margin: 0 }}>💾 BACKUP</h2>
              <Btn small secondary color="rgba(255,255,255,0.4)" onClick={() => setPhase(PHASES.SETUP)}>← Zurück</Btn>
            </div>

            <div style={{ background: "rgba(61,214,245,0.06)", borderRadius: 12, padding: 16, border: "1px solid rgba(61,214,245,0.18)", marginBottom: 14 }}>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", margin: 0, lineHeight: 1.6 }}>
                ⚠ Alle Daten werden lokal im Browser gespeichert. Wenn du den Browser-Speicher löschst oder das Gerät wechselst, sind deine Sessions weg. <strong style={{ color: "#3DD6F5" }}>Erstelle regelmäßig ein Backup!</strong>
              </p>
            </div>

            {/* Export */}
            <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: 16, border: "1px solid rgba(61,214,245,0.1)", marginBottom: 12 }}>
              <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 2, color: "rgba(255,255,255,0.5)", fontFamily: "'Cinzel', serif", marginBottom: 6 }}>📤 Backup erstellen</div>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 0, marginBottom: 12 }}>
                Lädt eine JSON-Datei mit all deinen Sessions, Mauern und Einstellungen herunter.
              </p>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 12, display: "flex", flexDirection: "column", gap: 3 }}>
                <span>• {sessions.length} Session{sessions.length !== 1 ? "s" : ""}</span>
                <span>• {wallLog.length} Mauer-Log-Einträge</span>
                <span>• Aktuelle Verteilung TH{thLevel}</span>
              </div>
              <Btn color="#3DD6F5" style={{ width: "100%" }} onClick={() => {
                const payload = {
                  version: 1,
                  exportedAt: new Date().toISOString(),
                  sessions: sessions,
                  walls: { thLevel: thLevel, wallsByLevel: wallsByLevel, log: wallLog },
                };
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `coc-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showToast("Backup heruntergeladen!");
              }}>
                💾 Backup als Datei herunterladen
              </Btn>
            </div>

            {/* Import */}
            <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: 16, border: "1px solid rgba(61,214,245,0.1)", marginBottom: 12 }}>
              <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 2, color: "rgba(255,255,255,0.5)", fontFamily: "'Cinzel', serif", marginBottom: 6 }}>📥 Backup wiederherstellen</div>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 0, marginBottom: 12 }}>
                ⚠ Überschreibt alle aktuellen Daten. Erst lokales Backup machen!
              </p>
              <input id="backup-import-input" type="file" accept="application/json,.json" style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = async (ev) => {
                    try {
                      const data = JSON.parse(ev.target.result);
                      if (!data || !Array.isArray(data.sessions)) {
                        showToast("Ungültige Backup-Datei");
                        return;
                      }
                      if (!confirm(`Backup vom ${data.exportedAt ? new Date(data.exportedAt).toLocaleString("de-DE") : "?"} wiederherstellen?\n\n${data.sessions.length} Sessions werden importiert. Aktuelle Daten werden ÜBERSCHRIEBEN!`)) return;
                      await saveSessions(data.sessions);
                      if (data.walls?.wallsByLevel) {
                        await saveWalls(data.walls.wallsByLevel, data.walls.log || [], data.walls.thLevel || 18);
                      }
                      showToast("Backup wiederhergestellt!");
                    } catch (err) {
                      showToast("Fehler beim Lesen: " + err.message);
                    }
                  };
                  reader.readAsText(file);
                }} />
              <label htmlFor="backup-import-input" style={{
                display: "block", textAlign: "center", padding: "12px 24px",
                background: "transparent", border: "1px solid #3DD6F5",
                borderRadius: 8, color: "#3DD6F5", fontFamily: "'Cinzel', serif",
                fontSize: 15, fontWeight: 700, cursor: "pointer", letterSpacing: 1,
              }}>
                📂 Backup-Datei wählen
              </label>
            </div>

            {/* Danger zone */}
            <div style={{ background: "rgba(255,80,80,0.04)", borderRadius: 12, padding: 16, border: "1px solid rgba(255,80,80,0.15)" }}>
              <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 2, color: "#ff6b6b", fontFamily: "'Cinzel', serif", marginBottom: 6 }}>⚠ Danger Zone</div>
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 0, marginBottom: 12 }}>
                Löscht alle Sessions unwiderruflich. Mauer-Daten bleiben erhalten.
              </p>
              <button
                onClick={async () => {
                  if (sessions.length === 0) { showToast("Keine Sessions vorhanden"); return; }
                  if (!confirm(`Wirklich ALLE ${sessions.length} Sessions löschen? Das kann nicht rückgängig gemacht werden.`)) return;
                  await saveSessions([]);
                  showToast("Alle Sessions gelöscht");
                }}
                style={{ width: "100%", padding: "10px 16px", background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.3)", borderRadius: 8, color: "#ff6b6b", fontFamily: "'Cinzel', serif", fontSize: 12, fontWeight: 700, letterSpacing: 1, cursor: "pointer" }}>
                🗑 Alle Sessions löschen
              </button>
            </div>
          </div>
        )}

        {/* ═══ HELP ═══ */}
        {phase === PHASES.HELP && (
          <div style={{ animation: "fadeIn 0.4s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 16, color: "#E84CFF", margin: 0 }}>❓ ANLEITUNG</h2>
              <Btn small secondary color="rgba(255,255,255,0.4)" onClick={() => setPhase(PHASES.SETUP)}>← Zurück</Btn>
            </div>

            {[
              {
                icon: "▶", title: "Eine Session starten", color: "#FFD700",
                content: "Trage auf dem Startbildschirm dein aktuelles Loot (Gold/Elixir/DE) ein und drücke „SESSION STARTEN“. Ein 3-2-1-Countdown gibt dir Zeit, ins Spiel zu wechseln, dann startet der Timer.",
              },
              {
                icon: "📷", title: "Loot automatisch erfassen (OCR)", color: "#FFD700",
                content: "Statt Zahlen manuell einzutragen, tippe auf „📷 Screenshot scannen“. Wähle einen Screenshot vom Beute-Bildschirm oder mache direkt ein Foto – die App liest Gold/Elixir/DE automatisch aus.",
              },
              {
                icon: "⚔", title: "Laps während der Session", color: "#FFA500",
                content: "Drücke nach jedem Angriff den „LAP“-Button (oder Leertaste auf dem Desktop). Das speichert die Zeit für diesen Angriff. So bekommst du am Ende Statistiken wie Ø Angriffsdauer, schnellster/langsamster Lap.",
              },
              {
                icon: "⏸", title: "Pausieren & Loot ausgeben", color: "#FFA500",
                content: "Mit dem Pause-Button (oder „P“) hältst du den Timer an. Während der Pause kannst du mit „💸 LOOT AUSGEBEN“ tracken, was du zwischendurch in Upgrades steckst – die App rechnet die Ausgaben aus den Gesamtwerten raus.",
              },
              {
                icon: "💾", title: "Session beenden & speichern", color: "#FFD700",
                content: "Mit „BEENDEN“ (oder „E“) wechselst du zum Ergebnis-Screen. Trage dein neues Loot ein → die App berechnet, wieviel du erfarmt hast, Gold/h, Elixir/h usw. Dann auf „SPEICHERN“ tippen.",
              },
              {
                icon: "🧱", title: "Mauer-Tracker", color: "#b08d57",
                content: "Wähle dein Rathauslevel im Mauer-Screen. Die App weiß automatisch, wie viele Mauern du hast und welches Max-Level möglich ist. „Anpassen“ erlaubt die genaue Verteilung einzugeben (z.B. 297× L18 + 28× L19). Dann verbesserst du Mauern level-für-level. Eine Prognose zeigt, wie viele Tage du noch farmen musst.",
              },
              {
                icon: "📊", title: "Statistiken & Rekorde", color: "#FFD700",
                content: "Im Stats-Tab findest du Lifetime-Werte (Gesamt-Loot, Mauern, Streak) sowie persönliche Rekorde. Wenn eine Session eine Bestleistung erzielt, bekommt sie automatisch eine Trophäe – sichtbar in der History und im Ergebnis-Screen.",
              },
              {
                icon: "💾", title: "Backup nicht vergessen!", color: "#3DD6F5",
                content: "Alle Daten liegen im Browser-Speicher. Wenn du den Browser-Cache löschst, sind sie weg. Im Backup-Tab kannst du jederzeit eine JSON-Datei runterladen und später wiederherstellen.",
              },
              {
                icon: "🎯", title: "Tages-/Wochenziele", color: "#FFD700",
                content: "Im Ziele-Tab kannst du dir Mengen-Ziele setzen (z.B. 5M Gold pro Tag). Der Fortschritt wird automatisch aus deinen Sessions berechnet – heute oder seit Montag. Ein Fortschrittsbalken auf dem Startbildschirm zeigt dir live, wie nahe du dran bist.",
              },
              {
                icon: "🎨", title: "Farbschema ändern", color: "#FFD700",
                content: "Im Einstellungs-Menü (Zahnrad ⚙ oben rechts) kannst du zwischen 5 Farbschemata wählen: Royal Gold (Standard), Emerald Knight, Crimson Lord, Ocean Mage, Midnight Stealth. Hintergrund, Titel und Akzentfarben passen sich an.",
              },
              {
                icon: "⏰", title: "Lange-Session-Warnung", color: "#FFA500",
                content: "Falls eine Session zu lange läuft (z.B. weil du vergessen hast sie zu beenden), warnt die App nach 1/2/3/4h. Einstellbar im Einstellungs-Menü (⚙). Verhindert verfälschte Statistiken.",
              },
              {
                icon: "⌨", title: "Tastenkürzel (Desktop)", color: "#E84CFF",
                content: "LEERTASTE: Neuer Lap · P: Pause/Weiter · L: Loot ausgeben · E: Session beenden",
              },
            ].map((item) => (
              <div key={item.title} style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: 14, border: `1px solid ${item.color}22`, marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 20 }}>{item.icon}</span>
                  <span style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: item.color, fontWeight: 700, letterSpacing: 1 }}>{item.title}</span>
                </div>
                <p style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", margin: 0, lineHeight: 1.55 }}>{item.content}</p>
              </div>
            ))}
          </div>
        )}

        {/* ═══ GOALS ═══ */}
        {phase === PHASES.GOALS && (
          <div style={{ animation: "fadeIn 0.4s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 16, color: "#FFD700", margin: 0 }}>🎯 ZIELE</h2>
              <Btn small secondary color="rgba(255,255,255,0.4)" onClick={() => { setPhase(PHASES.SETUP); setEditingGoals(false); setGoalsDraft(null); }}>← Zurück</Btn>
            </div>

            {/* Today's progress */}
            <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: 16, border: "1px solid rgba(255,215,0,0.1)", marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "#FFD700", fontFamily: "'Cinzel', serif", fontWeight: 700 }}>📅 Heute</span>
                {!editingGoals && (
                  <button onClick={() => { setEditingGoals(true); setGoalsDraft({ daily: { ...goals.daily }, weekly: { ...goals.weekly } }); }}
                    style={{ background: "rgba(255,215,0,0.15)", border: "1px solid rgba(255,215,0,0.35)", borderRadius: 6, color: "#FFD700", padding: "4px 10px", fontSize: 11, fontFamily: "'Cinzel', serif", letterSpacing: 1, cursor: "pointer", fontWeight: 700 }}>
                    ✎ Bearbeiten
                  </button>
                )}
              </div>
              {!goalProgress.anyDailyGoal && !editingGoals && (
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", textAlign: "center", padding: "8px 0" }}>Keine Tagesziele gesetzt</div>
              )}
              {[
                { label: "Gold", key: "gold", data: goalProgress.today.gold, color: "#FFD700" },
                { label: "Elixir", key: "elixir", data: goalProgress.today.elixir, color: "#E84CFF" },
                { label: "Dunkles Elixir", key: "dark", data: goalProgress.today.dark, color: "#3DD6F5" },
              ].map((item) => {
                if (!editingGoals && item.data.target === 0) return null;
                return (
                  <div key={item.key} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: item.color }}>{item.label}</span>
                      {editingGoals ? (
                        <input type="number" min="0"
                          value={goalsDraft.daily[item.key] === 0 ? "" : goalsDraft.daily[item.key]}
                          placeholder="0"
                          onChange={(e) => { const v = parseInt(e.target.value) || 0; setGoalsDraft(d => ({ ...d, daily: { ...d.daily, [item.key]: Math.max(0, v) } })); }}
                          onFocus={(e) => e.target.select()}
                          style={{ background: "rgba(0,0,0,0.5)", border: `1px solid ${item.color}55`, borderRadius: 6, padding: "4px 8px", color: item.color, fontSize: 12, fontFamily: "'Oswald', sans-serif", width: 110, textAlign: "right", outline: "none" }} />
                      ) : (
                        <span style={{ fontFamily: "'Oswald', sans-serif", color: item.data.pct >= 100 ? "#00ff64" : item.color, fontSize: 13 }}>
                          {formatNum(item.data.current)} / {formatNum(item.data.target)} {item.data.pct >= 100 && "✓"}
                        </span>
                      )}
                    </div>
                    {!editingGoals && (
                      <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 4, height: 6, overflow: "hidden" }}>
                        <div style={{ height: "100%", borderRadius: 4, background: item.data.pct >= 100 ? "linear-gradient(90deg, #00ff64, #00d050)" : item.color, width: `${item.data.pct}%`, transition: "width 0.4s ease", boxShadow: item.data.pct >= 100 ? "0 0 8px rgba(0,255,100,0.4)" : "none" }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* This week's progress */}
            <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: 16, border: "1px solid rgba(255,215,0,0.1)", marginBottom: 12 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "#E84CFF", fontFamily: "'Cinzel', serif", fontWeight: 700, marginBottom: 12 }}>📊 Diese Woche (Mo–So)</div>
              {!goalProgress.anyWeeklyGoal && !editingGoals && (
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", textAlign: "center", padding: "8px 0" }}>Keine Wochenziele gesetzt</div>
              )}
              {[
                { label: "Gold", key: "gold", data: goalProgress.week.gold, color: "#FFD700" },
                { label: "Elixir", key: "elixir", data: goalProgress.week.elixir, color: "#E84CFF" },
                { label: "Dunkles Elixir", key: "dark", data: goalProgress.week.dark, color: "#3DD6F5" },
              ].map((item) => {
                if (!editingGoals && item.data.target === 0) return null;
                return (
                  <div key={item.key} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: item.color }}>{item.label}</span>
                      {editingGoals ? (
                        <input type="number" min="0"
                          value={goalsDraft.weekly[item.key] === 0 ? "" : goalsDraft.weekly[item.key]}
                          placeholder="0"
                          onChange={(e) => { const v = parseInt(e.target.value) || 0; setGoalsDraft(d => ({ ...d, weekly: { ...d.weekly, [item.key]: Math.max(0, v) } })); }}
                          onFocus={(e) => e.target.select()}
                          style={{ background: "rgba(0,0,0,0.5)", border: `1px solid ${item.color}55`, borderRadius: 6, padding: "4px 8px", color: item.color, fontSize: 12, fontFamily: "'Oswald', sans-serif", width: 110, textAlign: "right", outline: "none" }} />
                      ) : (
                        <span style={{ fontFamily: "'Oswald', sans-serif", color: item.data.pct >= 100 ? "#00ff64" : item.color, fontSize: 13 }}>
                          {formatNum(item.data.current)} / {formatNum(item.data.target)} {item.data.pct >= 100 && "✓"}
                        </span>
                      )}
                    </div>
                    {!editingGoals && (
                      <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 4, height: 6, overflow: "hidden" }}>
                        <div style={{ height: "100%", borderRadius: 4, background: item.data.pct >= 100 ? "linear-gradient(90deg, #00ff64, #00d050)" : item.color, width: `${item.data.pct}%`, transition: "width 0.4s ease", boxShadow: item.data.pct >= 100 ? "0 0 8px rgba(0,255,100,0.4)" : "none" }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {editingGoals ? (
              <div style={{ display: "flex", gap: 8 }}>
                <Btn color="#FFD700" style={{ flex: 1 }} onClick={async () => {
                  await saveGoals(goalsDraft);
                  setEditingGoals(false);
                  setGoalsDraft(null);
                  showToast("Ziele gespeichert!");
                }}>✓ Speichern</Btn>
                <Btn secondary color="rgba(255,255,255,0.4)" style={{ flex: 1 }} onClick={() => { setEditingGoals(false); setGoalsDraft(null); }}>Abbrechen</Btn>
              </div>
            ) : (
              <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: 10, textAlign: "center", border: "1px dashed rgba(255,255,255,0.1)" }}>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
                  Setze einen Wert auf 0 um ein Ziel zu deaktivieren
                </span>
              </div>
            )}
          </div>
        )}

        {/* ═══ SETTINGS ═══ */}
        {phase === PHASES.SETTINGS && (
          <div style={{ animation: "fadeIn 0.4s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 16, color: theme.primary, margin: 0 }}>⚙ EINSTELLUNGEN</h2>
              <Btn small secondary color="rgba(255,255,255,0.4)" onClick={() => setPhase(PHASES.SETUP)}>← Zurück</Btn>
            </div>

            {/* Theme section */}
            <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 14, padding: 16, border: `1px solid ${theme.primary}22`, marginBottom: 14 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: theme.primary, fontFamily: "'Cinzel', serif", fontWeight: 700, marginBottom: 12 }}>🎨 Farbschema</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {Object.entries(THEMES).map(([key, t]) => {
                const isActive = themeName === key;
                return (
                  <div key={key} onClick={() => saveSettings({ themeName: key })}
                    style={{ background: isActive ? `${t.primary}15` : "rgba(0,0,0,0.3)", borderRadius: 12, padding: 14, border: `2px solid ${isActive ? t.primary : "rgba(255,255,255,0.05)"}`, cursor: "pointer", transition: "all 0.2s" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <div style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: t.primary, fontWeight: 700, letterSpacing: 1 }}>
                        {isActive && "✓ "}{t.name}
                      </div>
                      {isActive && <span style={{ fontSize: 10, padding: "2px 8px", background: t.primary, color: "#000", borderRadius: 4, fontFamily: "'Cinzel', serif", letterSpacing: 1, fontWeight: 700 }}>AKTIV</span>}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <div style={{ flex: 1, height: 28, borderRadius: 6, background: t.primaryGradient }} title="Primary" />
                      <div style={{ flex: 1, height: 28, borderRadius: 6, background: t.secondaryGradient }} title="Secondary" />
                      <div style={{ flex: 1, height: 28, borderRadius: 6, background: `linear-gradient(135deg, ${t.wallDark}, ${t.wallLight})` }} title="Wall" />
                      <div style={{ flex: 1, height: 28, borderRadius: 6, background: t.accent }} title="Accent" />
                    </div>
                  </div>
                );
              })}
              </div>
            </div>

            {/* Long-session warning preference */}
            <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 14, padding: 16, border: "1px solid rgba(255,165,0,0.2)", marginBottom: 14 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "#FFA500", fontFamily: "'Cinzel', serif", fontWeight: 700, marginBottom: 8 }}>⏰ Lange-Session-Warnung</div>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", margin: "0 0 12px 0" }}>Nach wie vielen Stunden soll die App warnen, dass eine Session noch läuft?</p>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[
                  { label: "1h", val: 60 },
                  { label: "2h", val: 120 },
                  { label: "3h", val: 180 },
                  { label: "4h", val: 240 },
                  { label: "Aus", val: 0 },
                ].map((opt) => {
                  const isActive = longSessionWarnMin === opt.val;
                  return (
                    <button key={opt.val} onClick={() => saveSettings({ longSessionWarnMin: opt.val })}
                      style={{ flex: 1, minWidth: 56, padding: "8px 12px", background: isActive ? "#FFA500" : "rgba(255,255,255,0.05)", color: isActive ? "#1a0f00" : "rgba(255,255,255,0.6)", border: `1px solid ${isActive ? "#FFA500" : "rgba(255,255,255,0.12)"}`, borderRadius: 8, fontFamily: "'Cinzel', serif", fontSize: 12, fontWeight: 700, letterSpacing: 1, cursor: "pointer", transition: "all 0.2s" }}>
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Backup quick-access */}
            <div onClick={() => setPhase(PHASES.BACKUP)}
              style={{ background: "rgba(61,214,245,0.04)", borderRadius: 14, padding: 16, border: "1px solid rgba(61,214,245,0.2)", marginBottom: 14, cursor: "pointer", transition: "all 0.2s", display: "flex", justifyContent: "space-between", alignItems: "center" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(61,214,245,0.08)"; e.currentTarget.style.borderColor = "rgba(61,214,245,0.4)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(61,214,245,0.04)"; e.currentTarget.style.borderColor = "rgba(61,214,245,0.2)"; }}>
              <div>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: "#3DD6F5", fontFamily: "'Cinzel', serif", fontWeight: 700, marginBottom: 4 }}>💾 Backup & Wiederherstellen</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>{sessions.length} Session{sessions.length !== 1 ? "s" : ""} · Daten exportieren oder importieren</div>
              </div>
              <span style={{ fontSize: 18, color: "#3DD6F5" }}>→</span>
            </div>

            {/* App info */}
            <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 14, padding: 14, border: "1px solid rgba(255,255,255,0.05)", textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", lineHeight: 1.6 }}>
                ⚔ FARMING TRACKER<br />
                <span style={{ color: "rgba(255,255,255,0.25)", fontSize: 10 }}>Clash of Clans Companion · v1.0</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        @keyframes countdownPop {
          0% { transform: scale(0.4); opacity: 0; }
          40% { transform: scale(1.15); opacity: 1; }
          70% { transform: scale(0.95); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        input[type="number"]::-webkit-outer-spin-button, input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        input[type="number"] { -moz-appearance: textfield; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,215,0,0.2); border-radius: 4px; }
        .nav-row::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
  );
}
