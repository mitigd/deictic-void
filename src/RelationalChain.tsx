import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  BrainCircuit, Crosshair, 
  TrendingUp, AlertTriangle, EyeOff, 
  RotateCcw, Save, StopCircle, ArrowUp,
  Edit3, Lock, Unlock, BarChart2,
  Activity
} from 'lucide-react';

// --- TYPES & CONFIG ---

type RelativeDir = 'FRONT' | 'BACK' | 'LEFT' | 'RIGHT';
type CardinalDir = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST';
type Direction = RelativeDir | CardinalDir;

type ProtocolType = 'DIRECT' | 'INVERTED'; 
type FrameType = 'RELATIVE' | 'ABSOLUTE'; 

interface CommandStep {
  dir: Direction;
  frame: FrameType;
  protocol: ProtocolType;
  id: string;
  displayColor: string; 
}

interface MetricData {
    attempts: number;
    failures: number;
}

interface AnalyticsState {
    tags: Record<string, MetricData>; 
    sessions: { timestamp: number; maxLevel: number; score: number }[];
}

interface GameState {
  status: 'idle' | 'playing' | 'gameover' | 'level_up' | 'level_down' | 'success_anim' | 'analytics';
  currentLevel: number;
  stability: number; 
  maxLevel: number;
  score: number;
  multiplier: number;
  streak: number;
  soundEnabled: boolean;
  isPracticeMode: boolean;
  analytics: AnalyticsState;
  // Stats for HUD
  sessionCorrect: number;
  sessionTotal: number;
}

const GRID_SIZE = 7; 

// PERSISTENCE CONFIG
const PERMANENT_KEY = 'rft_trainer_universal_save_v3'; 
const LEGACY_KEYS = [
    'rft_trainer_universal_save_v2',
    'rft_trainer_universal_save',
    'vector_frame_persistent_v4'
];

const COLORS = {
  bg: '#050505',
  gridBorder: '#222',
  cellBg: '#0a0a0a',
  anchor: '#00ccff', 
  direct: '#00ff9d', 
  inverted: '#ff3366', 
  absolute: '#bd00ff', 
  text: '#eeeeee',
  muted: '#555555',
  warning: '#ffaa00',
  white: '#ffffff',
  practice: '#ffd700',
  chartBar: '#333'
};

// --- SOUND ENGINE ---
const playSound = (type: string, enabled: boolean) => {
    if (!enabled) return;
    try {
        const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const now = ctx.currentTime;
        
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === 'click') {
            osc.frequency.setValueAtTime(800, now);
            gain.gain.setValueAtTime(0.05, now);
            gain.gain.linearRampToValueAtTime(0, now + 0.05);
            osc.start(now);
            osc.stop(now + 0.05);
        } else if (type === 'success') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(400, now);
            osc.frequency.exponentialRampToValueAtTime(800, now + 0.1);
            gain.gain.setValueAtTime(0.1, now);
            gain.gain.linearRampToValueAtTime(0, now + 0.3);
            osc.start(now);
            osc.stop(now + 0.3);
        } else if (type === 'fail') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(150, now);
            osc.frequency.linearRampToValueAtTime(50, now + 0.3);
            gain.gain.setValueAtTime(0.1, now);
            gain.gain.linearRampToValueAtTime(0, now + 0.3);
            osc.start(now);
            osc.stop(now + 0.3);
        } else if (type === 'lock') {
            osc.frequency.setValueAtTime(200, now);
            osc.type = 'square';
            gain.gain.setValueAtTime(0.05, now);
            gain.gain.linearRampToValueAtTime(0, now + 0.1);
            osc.start(now);
            osc.stop(now + 0.1);
        }
    } catch (e) { }
};

// --- LOGIC ENGINE ---

const safeMod = (n: number, m: number) => ((n % m) + m) % m;

const getVector = (rotation: number, dir: Direction): { dx: number, dy: number } => {
  if (dir === 'NORTH') return { dx: 0, dy: -1 };
  if (dir === 'SOUTH') return { dx: 0, dy: 1 };
  if (dir === 'EAST') return { dx: 1, dy: 0 };
  if (dir === 'WEST') return { dx: -1, dy: 0 };

  let angleOffset = 0;
  if (dir === 'RIGHT') angleOffset = 90;
  if (dir === 'BACK') angleOffset = 180;
  if (dir === 'LEFT') angleOffset = 270;

  const finalAngle = safeMod(rotation + angleOffset, 360);
  
  if (finalAngle === 0) return { dx: 0, dy: -1 };
  if (finalAngle === 90) return { dx: 1, dy: 0 };
  if (finalAngle === 180) return { dx: 0, dy: 1 };
  if (finalAngle === 270) return { dx: -1, dy: 0 };
  return { dx: 0, dy: 0 };
};

const getOpposite = (dir: Direction): Direction => {
  if (dir === 'NORTH') return 'SOUTH';
  if (dir === 'SOUTH') return 'NORTH';
  if (dir === 'EAST') return 'WEST';
  if (dir === 'WEST') return 'EAST';
  
  if (dir === 'FRONT') return 'BACK';
  if (dir === 'BACK') return 'FRONT';
  if (dir === 'LEFT') return 'RIGHT';
  return 'LEFT'; 
};

export default function VectorFramePersistent() {
  const [game, setGame] = useState<GameState>({ 
    status: 'idle', 
    currentLevel: 1, 
    stability: 50, 
    maxLevel: 1,
    score: 0, 
    multiplier: 1, 
    streak: 0,
    soundEnabled: true,
    isPracticeMode: false,
    analytics: { tags: {}, sessions: [] },
    sessionCorrect: 0,
    sessionTotal: 0
  });
  
  const [timer, setTimer] = useState(100);
  const [anchorPos, setAnchorPos] = useState({ x: 3, y: 3 });
  const [anchorRotation, setAnchorRotation] = useState(0); 
  const [chain, setChain] = useState<CommandStep[]>([]);
  const targetPos = useRef<{x: number, y: number} | null>(null);
  const [feedbackCell, setFeedbackCell] = useState<{x: number, y: number, type: 'success' | 'fail'} | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // --- PERSISTENCE & MIGRATION ---
  useEffect(() => {
    try {
      let saved = localStorage.getItem(PERMANENT_KEY);
      
      if (!saved) {
          for (const key of LEGACY_KEYS) {
              const legacyData = localStorage.getItem(key);
              if (legacyData) {
                  const parsed = JSON.parse(legacyData);
                  const migratedState = {
                      ...parsed,
                      analytics: parsed.analytics || { tags: {}, sessions: [] },
                      sessionCorrect: 0,
                      sessionTotal: 0
                  };
                  saved = JSON.stringify(migratedState);
                  localStorage.setItem(PERMANENT_KEY, saved); 
                  break; 
              }
          }
      }

      if (saved) {
        const data = JSON.parse(saved);
        setGame(prev => ({ 
          ...prev, 
          currentLevel: data.currentLevel || 1,
          maxLevel: data.maxLevel || 1,
          stability: data.stability !== undefined ? data.stability : 50,
          score: data.score || 0,
          analytics: data.analytics || { tags: {}, sessions: [] }
        }));
      }
      setIsLoaded(true);
    } catch (e) {
      console.error("Failed to load save", e);
      setIsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (isLoaded && game.status !== 'idle') {
      localStorage.setItem(PERMANENT_KEY, JSON.stringify({
        currentLevel: game.currentLevel,
        maxLevel: game.maxLevel,
        stability: game.stability,
        score: game.score,
        analytics: game.analytics
      }));
    }
  }, [game, isLoaded]);

  // --- ANALYTICS ENGINE ---
  const updateAnalytics = (result: 'win' | 'loss') => {
      // Don't track deep analytics in practice mode to avoid polluting data
      if (game.isPracticeMode) return;

      setGame(prev => {
          const newTags = { ...prev.analytics.tags };
          
          chain.forEach(step => {
              const protoKey = step.protocol;
              if (!newTags[protoKey]) newTags[protoKey] = { attempts: 0, failures: 0 };
              newTags[protoKey].attempts++;
              if (result === 'loss') newTags[protoKey].failures++;

              const frameKey = step.frame;
              if (!newTags[frameKey]) newTags[frameKey] = { attempts: 0, failures: 0 };
              newTags[frameKey].attempts++;
              if (result === 'loss') newTags[frameKey].failures++;

              const complexKey = `${step.protocol} ${step.dir}`;
              if (!newTags[complexKey]) newTags[complexKey] = { attempts: 0, failures: 0 };
              newTags[complexKey].attempts++;
              if (result === 'loss') newTags[complexKey].failures++;
          });

          return {
              ...prev,
              analytics: {
                  ...prev.analytics,
                  tags: newTags
              }
          };
      });
  };

  const recordSession = () => {
      if (game.score > 100 && !game.isPracticeMode) {
          setGame(prev => ({
              ...prev,
              analytics: {
                  ...prev.analytics,
                  sessions: [
                      ...prev.analytics.sessions, 
                      { timestamp: Date.now(), maxLevel: prev.currentLevel, score: prev.score }
                  ]
              }
          }));
      }
  };

  // --- ALGORITHM ---
  const generateLevel = useCallback((level: number) => {
    const chainLength = level < 5 ? 1 : (level < 10 ? 2 : (level < 15 ? 3 : 4));
    const allowInversion = level >= 4;
    const allowAbsolute = level >= 7;
    const allowInterference = level >= 12;

    let valid = false;
    let newAnchor, newRot, newChain, finalX, finalY;
    let attempts = 0;
    const MAX_ATTEMPTS = 500;

    while (!valid && attempts < MAX_ATTEMPTS) {
      attempts++;
      const padding = chainLength > 1 ? (chainLength > 3 ? 2 : 1) : 0;
      const safeSize = GRID_SIZE - (padding * 2);

      newAnchor = {
        x: Math.floor(Math.random() * safeSize) + padding,
        y: Math.floor(Math.random() * safeSize) + padding
      };
      
      newRot = Math.floor(Math.random() * 4) * 90;
      newChain = [];
      let currentX = newAnchor.x;
      let currentY = newAnchor.y;
      let pathFailed = false;

      for (let i = 0; i < chainLength; i++) {
        const relativeDirs: RelativeDir[] = ['FRONT', 'BACK', 'LEFT', 'RIGHT'];
        const absoluteDirs: CardinalDir[] = ['NORTH', 'SOUTH', 'EAST', 'WEST'];
        
        const isAbsolute = allowAbsolute && Math.random() > 0.6; 
        const frame: FrameType = isAbsolute ? 'ABSOLUTE' : 'RELATIVE';
        
        const rawDir: Direction = isAbsolute 
            ? absoluteDirs[Math.floor(Math.random() * absoluteDirs.length)]
            : relativeDirs[Math.floor(Math.random() * relativeDirs.length)];

        let protocol: ProtocolType = 'DIRECT';
        if (allowInversion && Math.random() > 0.6) protocol = 'INVERTED';

        let logicDir = protocol === 'INVERTED' ? getOpposite(rawDir) : rawDir;
        const vec = getVector(newRot, logicDir);
        
        currentX += vec.dx;
        currentY += vec.dy;
        
        let displayColor = protocol === 'DIRECT' ? COLORS.direct : COLORS.inverted;
        if (allowInterference && Math.random() > 0.5) {
            displayColor = Math.random() > 0.5 ? COLORS.inverted : COLORS.direct;
        }

        newChain.push({ 
            dir: rawDir, 
            protocol, 
            frame,
            id: Math.random().toString(36).substr(2, 9),
            displayColor
        });

        if (currentX < 0 || currentX >= GRID_SIZE || currentY < 0 || currentY >= GRID_SIZE) {
          pathFailed = true; 
          break;
        }
      }

      if (!pathFailed && (currentX !== newAnchor.x || currentY !== newAnchor.y)) {
        valid = true;
        finalX = currentX;
        finalY = currentY;
      }
    }

    // FIX: TypeScript assignability for string literals
    if (!valid) {
        newAnchor = { x: 3, y: 3 };
        newRot = 0;
        finalX = 3; 
        finalY = 2;
        newChain = [{ 
            dir: 'NORTH' as Direction, 
            frame: 'ABSOLUTE' as FrameType, 
            protocol: 'DIRECT' as ProtocolType, 
            id: 'failsafe', 
            displayColor: COLORS.direct 
        }];
    }

    setAnchorPos(newAnchor!);
    setAnchorRotation(newRot!);
    setChain(newChain!);
    targetPos.current = { x: finalX!, y: finalY! };
    setFeedbackCell(null);
    setTimer(100); 
  }, []);

  const startGame = () => {
    playSound('click', game.soundEnabled);
    generateLevel(game.currentLevel); 
    setGame(prev => ({ 
        ...prev, 
        status: 'playing', 
        multiplier: 1, 
        streak: 0, 
        history: [],
        sessionCorrect: 0,
        sessionTotal: 0
    }));
  };

  const manualSetLevel = () => {
      const input = prompt("MANUAL OVERRIDE: Enter Level (1-99)", game.currentLevel.toString());
      if (input) {
          const lvl = parseInt(input);
          if (!isNaN(lvl) && lvl > 0 && lvl < 100) {
              setGame(prev => ({ 
                  ...prev, 
                  currentLevel: lvl, 
                  maxLevel: Math.max(prev.maxLevel, lvl),
                  score: 0 
              }));
          }
      }
  };

  const togglePracticeMode = () => {
    playSound('lock', game.soundEnabled);
    
    setGame(prev => ({ ...prev, isPracticeMode: !prev.isPracticeMode }));
    
    // EXPLOIT FIX: If currently playing, regenerate immediately so user cannot
    // switch to practice, solve the current puzzle leisurely, switch back and score.
    if (game.status === 'playing') {
        generateLevel(game.currentLevel);
    }
  };

  const stopGame = () => {
      playSound('click', game.soundEnabled);
      recordSession();
      setGame(prev => ({ ...prev, status: 'gameover' }));
  };

  const resetProgress = () => {
    playSound('click', game.soundEnabled);
    if (window.confirm("Reset all training progress?")) {
      const newState = {
          currentLevel: 1,
          maxLevel: game.maxLevel,
          stability: 50,
          score: 0,
          analytics: { tags: {}, sessions: [] },
          sessionCorrect: 0,
          sessionTotal: 0
      };
      setGame(prev => ({ ...prev, ...newState, status: 'idle' }));
      localStorage.setItem(PERMANENT_KEY, JSON.stringify(newState));
    }
  };

  // --- GAME LOOP ---
  const failureHandled = useRef(false);

  useEffect(() => {
    if (game.status === 'playing') failureHandled.current = false;
  }, [game.status]);

  useEffect(() => {
    if (game.status !== 'playing') return;
    
    // PRACTICE MODE UPDATE: Timer does not decay
    if (game.isPracticeMode) return;

    const decay = 0.25 + (game.currentLevel * 0.04); 
    const interval = setInterval(() => {
      setTimer(prev => {
        if (prev <= 0) {
          if (!failureHandled.current) {
             failureHandled.current = true;
             handleFailure(); 
          }
          return 0;
        }
        return prev - decay;
      });
    }, 50); 
    return () => clearInterval(interval);
  }, [game.status, game.currentLevel, game.isPracticeMode]); // Added isPracticeMode dep

  // --- INTERACTION ---

  const handleSuccess = () => {
    playSound('success', game.soundEnabled);
    updateAnalytics('win');

    const timeBonus = Math.floor(timer);
    const points = (100 + timeBonus) * game.multiplier + (game.currentLevel * 50);

    const stabilityGain = game.isPracticeMode ? 0 : 15; 
    let newStability = game.stability + stabilityGain;
    
    let nextLevel = game.currentLevel;
    let nextStatus: GameState['status'] = 'playing';

    if (!game.isPracticeMode && newStability >= 100) {
        nextLevel++;
        newStability = 50; 
        nextStatus = 'level_up';
    } else if (newStability > 100) {
        newStability = 100;
    }

    setGame(prev => ({
        ...prev, 
        status: 'success_anim', 
        score: prev.isPracticeMode ? prev.score : Math.floor(prev.score + points),
        stability: newStability, 
        streak: prev.streak + 1,
        multiplier: Math.min(prev.multiplier + 0.5, 5),
        sessionCorrect: prev.isPracticeMode ? prev.sessionCorrect : prev.sessionCorrect + 1,
        sessionTotal: prev.isPracticeMode ? prev.sessionTotal : prev.sessionTotal + 1
    }));

    setTimeout(() => {
        if (nextStatus === 'level_up') {
            setGame(prev => ({ ...prev, status: 'level_up', currentLevel: nextLevel, maxLevel: Math.max(prev.maxLevel, nextLevel) }));
            setTimeout(() => {
                generateLevel(nextLevel);
                requestAnimationFrame(() => setGame(prev => ({ ...prev, status: 'playing' })));
            }, 1200);
        } else {
            generateLevel(nextLevel);
            requestAnimationFrame(() => setGame(prev => ({ ...prev, status: 'playing', currentLevel: nextLevel, maxLevel: Math.max(prev.maxLevel, nextLevel) })));
        }
    }, 400);
  };

  const handleFailure = () => {
    playSound('fail', game.soundEnabled);
    updateAnalytics('loss');
    
    const stabilityLoss = game.isPracticeMode ? 0 : 30; 
    let newStability = game.stability - stabilityLoss;
    
    let nextLevel = game.currentLevel;
    let nextStatus: GameState['status'] = 'playing';

    if (!game.isPracticeMode && newStability <= 0) {
        if (game.currentLevel > 1) {
            nextLevel--;
            newStability = 50;
            nextStatus = 'level_down';
        } else {
            newStability = 20; 
        }
    } else if (newStability < 0) {
        newStability = 0;
    }

    setGame(prev => ({
        ...prev, 
        status: 'success_anim', 
        multiplier: 1, streak: 0, stability: newStability,
        sessionTotal: prev.isPracticeMode ? prev.sessionTotal : prev.sessionTotal + 1
    }));

    setTimeout(() => {
        if (nextStatus === 'level_down') {
            setGame(prev => ({ ...prev, status: 'level_down', currentLevel: nextLevel }));
            setTimeout(() => {
                generateLevel(nextLevel);
                requestAnimationFrame(() => setGame(prev => ({ ...prev, status: 'playing', stability: 50 })));
            }, 1200);
        } else {
            generateLevel(nextLevel);
            requestAnimationFrame(() => setGame(prev => ({ ...prev, status: 'playing', currentLevel: nextLevel, stability: newStability })));
        }
    }, 500);
  };

  const handleCellClick = (x: number, y: number) => {
    if (game.status !== 'playing') return;
    if (x === targetPos.current?.x && y === targetPos.current?.y) {
        setFeedbackCell({ x, y, type: 'success' });
        handleSuccess();
    } else {
        setFeedbackCell({ x, y, type: 'fail' });
        handleFailure();
    }
  };

  // --- ANALYTICS VIEW HELPER ---
  const AnalyticsView = () => {
      const stats = game.analytics;
      
      const weaknesses = Object.entries(stats.tags)
        .filter(([_, data]) => data.attempts >= 5) 
        .map(([key, data]) => ({ key, rate: data.failures / data.attempts }))
        .sort((a, b) => b.rate - a.rate)
        .slice(0, 3); 

      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      
      const getAvgScore = (days: number) => {
          const relevant = stats.sessions.filter(s => (now - s.timestamp) < (days * oneDay));
          if (!relevant.length) return 0;
          return Math.floor(relevant.reduce((a, b) => a + b.score, 0) / relevant.length);
      };

      return (
          <motion.div initial={{opacity: 0, y: 20}} animate={{opacity: 1, y: 0}} exit={{opacity: 0}} style={{
              position: 'absolute', inset: 0, background: '#050505', zIndex: 60, padding: 20, overflowY: 'auto',
              display: 'flex', flexDirection: 'column', alignItems: 'center'
          }}>
              <h2 style={{color: COLORS.white, letterSpacing: '4px', marginBottom: 30, display:'flex', alignItems:'center', gap: 10}}>
                  <BarChart2 /> NEURAL METRICS
              </h2>

              <div style={{width: '100%', maxWidth: 500, marginBottom: 40}}>
                  <h3 style={{color: COLORS.muted, fontSize: 12, marginBottom: 10, letterSpacing: 2}}>COGNITIVE BOTTLENECKS</h3>
                  {weaknesses.length > 0 ? (
                      weaknesses.map(w => (
                          <div key={w.key} style={{
                              background: '#111', padding: '15px', marginBottom: 8, borderRadius: 8,
                              borderLeft: `4px solid ${COLORS.inverted}`, display: 'flex', justifyContent: 'space-between'
                          }}>
                              <span style={{color: COLORS.white, fontWeight: 'bold'}}>{w.key}</span>
                              <span style={{color: COLORS.inverted}}>{(w.rate * 100).toFixed(0)}% FAILURE</span>
                          </div>
                      ))
                  ) : (
                      <div style={{color: '#444', fontStyle: 'italic'}}>Insufficient Data (Play more rounds)</div>
                  )}
              </div>

              <div style={{width: '100%', maxWidth: 500, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                    <div style={{background: '#0a0a0a', padding: 20, borderRadius: 8, textAlign: 'center'}}>
                        <div style={{color: COLORS.muted, fontSize: 10, marginBottom: 5}}>24H AVG SCORE</div>
                        <div style={{fontSize: 24, color: COLORS.direct}}>{getAvgScore(1).toLocaleString()}</div>
                    </div>
                    <div style={{background: '#0a0a0a', padding: 20, borderRadius: 8, textAlign: 'center'}}>
                        <div style={{color: COLORS.muted, fontSize: 10, marginBottom: 5}}>7D AVG SCORE</div>
                        <div style={{fontSize: 24, color: COLORS.anchor}}>{getAvgScore(7).toLocaleString()}</div>
                    </div>
              </div>

              <button 
                onClick={() => setGame(prev => ({...prev, status: 'idle'}))}
                style={{marginTop: 50, background: 'transparent', border: '1px solid #444', color: '#fff', padding: '12px 32px', cursor: 'pointer'}}
              >
                  RETURN TO TERMINAL
              </button>
          </motion.div>
      );
  };

  // --- RENDER ---
  const styles = {
    container: {
      width: '100%', height: '100%',
      background: `radial-gradient(circle at 50% 50%, #111 0%, #000 100%)`,
      color: COLORS.text,
      fontFamily: '"JetBrains Mono", monospace',
      display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center',
      userSelect: 'none' as const, position: 'relative' as const, overflow: 'hidden'
    },
    grid: {
      display: 'grid', 
      gridTemplateColumns: `repeat(${GRID_SIZE}, 1fr)`, 
      gridTemplateRows: `repeat(${GRID_SIZE}, 1fr)`,
      gap: '6px', 
      width: '100%', 
      maxWidth: '440px', 
      aspectRatio: '1/1', 
      padding: '10px',
      background: 'rgba(255,255,255,0.02)', 
      borderRadius: '12px', 
      border: `1px solid ${game.isPracticeMode ? COLORS.practice : COLORS.gridBorder}`,
      boxShadow: '0 0 30px rgba(0,0,0,0.5)',
      position: 'relative' as const
    },
    cell: {
      background: COLORS.cellBg, 
      borderRadius: '4px', 
      cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', 
      position: 'relative' as const,
      width: '100%', height: '100%' 
    },
    overlay: {
        position: 'absolute' as const, inset: 0, background: 'rgba(0,0,0,0.92)',
        zIndex: 50, display: 'flex', flexDirection: 'column' as const,
        alignItems: 'center', justifyContent: 'center', padding: '32px'
    }
  };

  const isBlindLevel = game.currentLevel >= 15;
  const accuracy = game.sessionTotal > 0 ? Math.round((game.sessionCorrect / game.sessionTotal) * 100) : 100;

  return (
    <div style={styles.container}>
      {/* HEADER */}
      <div style={{ width: '100%', maxWidth: '440px', padding: '16px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', zIndex: 10 }}>
        <div>
            <div style={{display:'flex', alignItems:'center', gap: 6, fontSize: '10px', color: COLORS.muted, letterSpacing: '1px'}}>
                <BrainCircuit size={12} /> PROTOCOL LEVEL
            </div>
            <div style={{fontSize: '28px', fontWeight: 900, color: game.isPracticeMode ? COLORS.practice : '#fff', lineHeight: '1', display: 'flex', alignItems:'center', gap: 10}}>
                {game.currentLevel}
                {game.isPracticeMode && <span style={{fontSize: '12px', color: COLORS.practice, border: `1px solid ${COLORS.practice}`, padding: '2px 6px', borderRadius: 4}}>PRACTICE</span>}
                {isBlindLevel && <span style={{fontSize: '12px', color: COLORS.inverted, marginLeft: 8}}><EyeOff size={12} style={{display:'inline'}}/> BLIND</span>}
            </div>
        </div>
        <div style={{textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end'}}>
            <div style={{fontSize: '10px', color: COLORS.muted, letterSpacing: '1px', display:'flex', alignItems:'center', gap: 4}}>
                <Activity size={10} /> SYNAPTIC FIDELITY
            </div>
            <div style={{fontSize: '20px', fontWeight: 800, color: accuracy > 90 ? COLORS.direct : (accuracy > 70 ? COLORS.white : COLORS.inverted)}}>
                {accuracy}%
            </div>
        </div>
      </div>

      {/* STABILITY METER + CONTROLS */}
      <div style={{ width: '100%', maxWidth: '440px', marginBottom: '24px', zIndex: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Stability Bar */}
          <div style={{flex: 1, height: '6px', background: '#222', borderRadius: '3px', overflow: 'hidden', opacity: game.isPracticeMode ? 0.3 : 1}}>
              <motion.div 
                animate={{ width: `${game.stability}%`, backgroundColor: game.stability > 50 ? COLORS.anchor : COLORS.inverted }}
                transition={{ duration: 0.5 }}
                style={{ height: '100%' }}
              />
          </div>
          
           {/* PRACTICE TOGGLE */}
           <button 
              onClick={togglePracticeMode}
              title={game.isPracticeMode ? "Resume Progression" : "Freeze Level (Practice)"}
              style={{
                  background: 'transparent', 
                  border: `1px solid ${game.isPracticeMode ? COLORS.practice : '#ffffff'}`, 
                  color: game.isPracticeMode ? COLORS.practice : '#ffffff',
                  width: 32, height: 32, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', transition: 'all 0.2s'
              }}
           >
              {game.isPracticeMode ? <Lock size={16} /> : <Unlock size={16} />}
           </button>

           {/* STOP BUTTON */}
           <button 
              onClick={stopGame}
              title="End Session"
              disabled={game.status !== 'playing'}
              style={{
                  background: 'transparent', border: '1px solid #ffffff', color: '#ffffff',
                  width: 32, height: 32, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: game.status === 'playing' ? 'pointer' : 'default', opacity: game.status === 'playing' ? 1 : 0.5,
                  transition: 'all 0.2s'
              }}
           >
              <StopCircle size={16} />
           </button>

           {/* RESET BUTTON */}
           <button 
              onClick={resetProgress}
              title="Reset All Progress"
              style={{
                  background: 'transparent', border: '1px solid #ffffff', color: '#ffffff',
                  width: 32, height: 32, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', transition: 'all 0.2s'
              }}
           >
              <RotateCcw size={16} />
           </button>
      </div>

      {/* COMMAND CARDS */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '32px', height: '90px', perspective: '1000px', zIndex: 10 }}>
         <AnimatePresence mode='popLayout'>
            {chain.map((step, i) => (
                <motion.div
                    key={step.id}
                    initial={{ rotateX: -90, opacity: 0 }}
                    animate={{ rotateX: 0, opacity: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ delay: i * 0.1 }}
                    style={{
                        width: '70px', height: '90px',
                        borderRadius: '6px',
                        background: '#0a0a0a',
                        borderTop: `2px solid ${step.displayColor}`, 
                        borderBottom: '1px solid #222',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                        position: 'relative', overflow: 'hidden'
                    }}
                >
                    <div style={{position: 'absolute', top: 4, fontSize: '8px', color: '#555', fontWeight: 'bold'}}>
                        {step.frame === 'ABSOLUTE' ? 'GRID' : 'BODY'}
                    </div>

                    <div style={{
                        fontSize: '9px', fontWeight: '900', letterSpacing: '1px', marginBottom: '6px',
                        color: step.protocol === 'DIRECT' ? '#fff' : COLORS.muted 
                    }}>
                        {step.protocol === 'DIRECT' ? 'VERIFIED' : 'INVERTED'}
                    </div>

                    <div style={{
                        fontSize: '12px', fontWeight: 'bold', color: step.displayColor 
                    }}>
                        {step.dir}
                    </div>
                </motion.div>
            ))}
         </AnimatePresence>
      </div>

      {/* TIMER */}
      <motion.div style={{ width: '100%', maxWidth: '440px', height: '2px', background: '#222', marginBottom: '20px' }}>
          <motion.div animate={{ width: `${timer}%` }} style={{ height: '100%', background: '#fff', opacity: game.isPracticeMode ? 0 : 0.3 }} />
      </motion.div>

      {/* GRID */}
      <div style={styles.grid}>
         {Array.from({ length: GRID_SIZE * GRID_SIZE }).map((_, i) => {
            const x = i % GRID_SIZE;
            const y = Math.floor(i / GRID_SIZE);
            const isAnchor = x === anchorPos.x && y === anchorPos.y;
            const isFeedback = feedbackCell?.x === x && feedbackCell?.y === y;
            
            return (
                <motion.div
                    key={i}
                    onClick={() => handleCellClick(x, y)}
                    whileHover={{ backgroundColor: 'rgba(255,255,255,0.05)' }}
                    whileTap={{ scale: 0.95 }}
                    style={{
                        ...styles.cell,
                        background: isFeedback 
                            ? (feedbackCell?.type === 'success' ? 'rgba(0,255,157,0.2)' : 'rgba(255,51,102,0.2)')
                            : styles.cell.background,
                        borderColor: isFeedback
                            ? (feedbackCell?.type === 'success' ? COLORS.direct : COLORS.inverted)
                            : 'transparent',
                        borderWidth: '1px', borderStyle: 'solid'
                    }}
                >
                    {isAnchor && (
                          <motion.div
                            animate={{ rotate: anchorRotation, opacity: (isBlindLevel && game.status === 'playing') ? 0 : 1 }}
                            transition={{ 
                                rotate: { type: 'spring', stiffness: 200, damping: 20 },
                                opacity: { duration: 0.5, delay: 0.5 } 
                            }}
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}
                        >
                            <ArrowUp size={36} color={COLORS.anchor} fill={COLORS.anchor} style={{ filter: 'drop-shadow(0 0 8px rgba(0,204,255,0.5))' }} />
                        </motion.div>
                    )}
                    {/* Compass marks */}
                    {game.currentLevel >= 7 && (
                        <div style={{position:'absolute', inset: 2, pointerEvents:'none', opacity: 0.1}}>
                            {x===GRID_SIZE-1 && y===0 && <div style={{width: 4, height: 4, background: COLORS.absolute, borderRadius: '50%'}}/>}
                        </div>
                    )}
                </motion.div>
            );
         })}
      </div>

      {/* ANALYTICS VIEW */}
      <AnimatePresence>
        {game.status === 'analytics' && <AnalyticsView />}

        {game.status === 'idle' && (
            <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} style={styles.overlay}>
                <div style={{width: 60, height: 60, border: `2px solid ${COLORS.anchor}`, borderRadius: '50%', display:'flex', alignItems:'center', justifyContent:'center', marginBottom: 24}}>
                    <Crosshair size={32} color={COLORS.anchor} />
                </div>
                <h1 style={{fontSize: '2.5rem', fontWeight: 900, color: '#fff', marginBottom: 8}}>UNBREAKABLE</h1>
                <p style={{color: '#666', fontSize: '12px', letterSpacing: '2px', marginBottom: 24}}>RFT PROTOCOL // PERSISTENT STATE</p>
                
                <div style={{display: 'flex', gap: 32, marginBottom: 48, color: '#888', fontSize: '12px'}}>
                    <div style={{textAlign:'center', cursor: 'pointer'}} onClick={manualSetLevel} title="Click to Manually Set Level">
                        <div style={{fontSize: '24px', color: '#fff', fontWeight: 'bold', display:'flex', alignItems:'center', gap: 8}}>
                            {game.currentLevel} <Edit3 size={14} color="#555"/>
                        </div>
                        <div>CURRENT LVL</div>
                    </div>
                    <div style={{textAlign:'center'}}>
                        <div style={{fontSize: '24px', color: COLORS.anchor, fontWeight: 'bold'}}>{game.maxLevel}</div>
                        <div>RECORD LVL</div>
                    </div>
                </div>

                <div style={{display:'flex', flexDirection: 'column', gap: 12}}>
                    <button onClick={startGame} style={{background: COLORS.anchor, border: 'none', padding: '16px 48px', fontWeight: 'bold', cursor: 'pointer'}}>
                        {game.currentLevel > 1 ? 'RESUME PROTOCOL' : 'INITIATE'}
                    </button>
                    <button onClick={() => setGame(prev => ({...prev, status: 'analytics'}))} style={{background: 'transparent', border: '1px solid #333', color: '#fff', padding: '12px', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8}}>
                        <BarChart2 size={14}/> VIEW NEURAL METRICS
                    </button>
                </div>
            </motion.div>
        )}

        {game.status === 'level_up' && (
            <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} style={{...styles.overlay, background: 'rgba(0,0,0,0.8)'}}>
                <TrendingUp size={64} color={COLORS.direct} />
                <h2 style={{color: '#fff', marginTop: 24}}>LEVEL {game.currentLevel}</h2>
                <div style={{color: COLORS.direct, fontSize: '12px', letterSpacing: '2px'}}>NEURAL PLASTICITY INCREASED</div>
            </motion.div>
        )}

        {game.status === 'level_down' && (
            <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} style={{...styles.overlay, background: 'rgba(0,0,0,0.8)'}}>
                <AlertTriangle size={64} color={COLORS.inverted} />
                <h2 style={{color: '#fff', marginTop: 24}}>LEVEL {game.currentLevel}</h2>
                <div style={{color: COLORS.inverted, fontSize: '12px', letterSpacing: '2px'}}>STABILITY CRITICAL</div>
            </motion.div>
        )}

        {game.status === 'gameover' && (
            <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} style={styles.overlay}>
                {game.stability <= 0 ? (
                    <>
                        <AlertTriangle size={64} color={COLORS.inverted} />
                        <h2 style={{color: '#fff', marginTop: 24}}>FAILURE</h2>
                        <p style={{color: '#666', marginBottom: 32}}>COGNITIVE SHORTCUT DETECTED</p>
                    </>
                ) : (
                    <>
                        <Save size={64} color={COLORS.anchor} />
                        <h2 style={{color: '#fff', marginTop: 24}}>PAUSED</h2>
                        <p style={{color: '#666', marginBottom: 32}}>PROGRESS SAVED</p>
                    </>
                )}
                
                <div style={{fontSize: '32px', fontWeight: 'bold', color: COLORS.anchor, marginBottom: 48}}>
                    {Math.round((game.sessionCorrect / (game.sessionTotal || 1)) * 100)}% PRECISION
                </div>
                
                <div style={{display:'flex', gap: 16}}>
                    <button onClick={startGame} style={{background: 'transparent', border: '1px solid #fff', color: '#fff', padding: '12px 24px', cursor:'pointer'}}>
                        RESUME
                    </button>
                    <button onClick={() => setGame(g => ({...g, status: 'idle'}))} style={{background: '#fff', border: 'none', padding: '12px 24px', cursor:'pointer'}}>
                        MENU
                    </button>
                </div>
            </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}