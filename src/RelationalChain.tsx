import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Play, Activity, BrainCircuit, Zap, Crosshair, 
  RotateCw, Volume2, VolumeX, ShieldCheck, 
  TrendingUp, TrendingDown, AlertTriangle, Cpu,
  Compass, EyeOff, RotateCcw, Save, StopCircle, ArrowUp
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

interface GameState {
  status: 'idle' | 'playing' | 'gameover' | 'level_up' | 'level_down' | 'success_anim';
  currentLevel: number;
  stability: number; // 0 to 100
  maxLevel: number;
  score: number;
  multiplier: number;
  streak: number;
  soundEnabled: boolean;
  history: { level: number; result: 'win' | 'loss' }[];
}

const GRID_SIZE = 7; 
const STORAGE_KEY = 'vector_frame_persistent_v3';

const COLORS = {
  bg: '#050505',
  gridBorder: '#222',
  cellBg: '#0a0a0a',
  anchor: '#00ccff', // Cyan (Player)
  direct: '#00ff9d', // Green (True)
  inverted: '#ff3366', // Red (False)
  absolute: '#bd00ff', // Purple (Cardinal)
  text: '#eeeeee',
  muted: '#555555',
  warning: '#ffaa00',
  white: '#ffffff'
};

// --- SOUND ENGINE ---
const playSound = (type: string, enabled: boolean) => {
    if (!enabled) return;
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
    }
};

// --- LOGIC ENGINE ---

const getVector = (rotation: number, dir: Direction): { dx: number, dy: number } => {
  // RELATIVE LOGIC: 0=Up, 90=Right, 180=Down, 270=Left
  let angleOffset = 0;
  
  // Absolute override
  if (dir === 'NORTH') return { dx: 0, dy: -1 };
  if (dir === 'SOUTH') return { dx: 0, dy: 1 };
  if (dir === 'EAST') return { dx: 1, dy: 0 };
  if (dir === 'WEST') return { dx: -1, dy: 0 };

  if (dir === 'RIGHT') angleOffset = 90;
  if (dir === 'BACK') angleOffset = 180;
  if (dir === 'LEFT') angleOffset = 270;

  const finalAngle = (rotation + angleOffset) % 360;
  
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

export default function VectorFrameUnbreakable() {
  // --- STATE ---
  const [game, setGame] = useState<GameState>({ 
    status: 'idle', 
    currentLevel: 1, 
    stability: 50, 
    maxLevel: 1,
    score: 0, 
    multiplier: 1, 
    streak: 0,
    soundEnabled: true,
    history: []
  });
  
  const [timer, setTimer] = useState(100);
  const [anchorPos, setAnchorPos] = useState({ x: 3, y: 3 });
  const [anchorRotation, setAnchorRotation] = useState(0); 
  const [chain, setChain] = useState<CommandStep[]>([]);
  const targetPos = useRef<{x: number, y: number} | null>(null);
  const [feedbackCell, setFeedbackCell] = useState<{x: number, y: number, type: 'success' | 'fail'} | null>(null);

  // --- PERSISTENCE ---
  
  // 1. Load on Mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        setGame(prev => ({ 
          ...prev, 
          currentLevel: data.currentLevel || 1,
          maxLevel: data.maxLevel || 1,
          stability: data.stability !== undefined ? data.stability : 50,
          score: data.score || 0
        }));
      }
    } catch (e) {
      console.error("Failed to load save", e);
    }
  }, []);

  // 2. Save on Change (Auto-save)
  useEffect(() => {
    if (game.status !== 'idle') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        currentLevel: game.currentLevel,
        maxLevel: game.maxLevel,
        stability: game.stability,
        score: game.score
      }));
    }
  }, [game.currentLevel, game.maxLevel, game.stability, game.score, game.status]);

  // --- ALGORITHM ---
  const generateLevel = useCallback((level: number) => {
    const chainLength = level < 5 ? 1 : (level < 10 ? 2 : (level < 15 ? 3 : 4));
    
    const allowInversion = level >= 4;
    const allowAbsolute = level >= 7;
    const allowInterference = level >= 12;

    let valid = false;
    let newAnchor, newRot, newChain, finalX, finalY;

    // Safety break
    let attempts = 0;

    while (!valid && attempts < 100) {
      attempts++;
      newAnchor = {
        x: Math.floor(Math.random() * GRID_SIZE),
        y: Math.floor(Math.random() * GRID_SIZE)
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
        
        // Stroop Logic
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
          pathFailed = true; break;
        }
      }

      if (!pathFailed && (currentX !== newAnchor.x || currentY !== newAnchor.y)) {
        valid = true;
        finalX = currentX;
        finalY = currentY;
      }
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
    setGame(prev => ({ 
        ...prev, 
        status: 'playing', 
        // We do NOT reset level/score here, allowing continuation
        multiplier: 1, 
        streak: 0, 
        history: []
    }));
    generateLevel(game.currentLevel);
  };

  const resetProgress = () => {
      playSound('click', game.soundEnabled);
      if (window.confirm("Reset all training progress to Level 1?")) {
        const newState = {
            currentLevel: 1,
            maxLevel: game.maxLevel, // We keep the record high
            stability: 50,
            score: 0
        };
        setGame(prev => ({ ...prev, ...newState, status: 'idle' }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(newState));
      }
  };

  const stopGame = () => {
      playSound('click', game.soundEnabled);
      setGame(prev => ({ ...prev, status: 'gameover' })); // Shows summary screen
  };

  // --- GAME LOOP ---
  useEffect(() => {
    if (game.status !== 'playing') return;
    
    const decay = 0.25 + (game.currentLevel * 0.04); 
    
    const interval = setInterval(() => {
      setTimer(prev => {
        if (prev <= 0) {
          handleFailure(true); 
          return 0;
        }
        return prev - decay;
      });
    }, 50); 
    return () => clearInterval(interval);
  }, [game.status, game.currentLevel]);

  // --- INTERACTION ---

  const handleSuccess = () => {
    playSound('success', game.soundEnabled);
    const timeBonus = Math.floor(timer);
    const points = (100 + timeBonus) * game.multiplier + (game.currentLevel * 50);

    const stabilityGain = 15; 
    let newStability = game.stability + stabilityGain;
    
    let nextLevel = game.currentLevel;
    let nextStatus: GameState['status'] = 'playing';

    if (newStability >= 100) {
        nextLevel++;
        newStability = 50; 
        nextStatus = 'level_up';
    }

    setGame(prev => ({
        ...prev, 
        status: 'success_anim', 
        score: Math.floor(prev.score + points),
        currentLevel: nextLevel, 
        maxLevel: Math.max(prev.maxLevel, nextLevel),
        stability: newStability, 
        streak: prev.streak + 1,
        multiplier: Math.min(prev.multiplier + 0.5, 5)
    }));

    setTimeout(() => {
        setGame(prev => ({ ...prev, status: nextStatus === 'level_up' ? 'level_up' : 'playing' }));
        if (nextStatus === 'level_up') {
            setTimeout(() => {
                setGame(prev => ({ ...prev, status: 'playing' }));
                generateLevel(nextLevel);
            }, 1200);
        } else {
            generateLevel(nextLevel);
        }
    }, 400);
  };

  const handleFailure = (isTimeout: boolean) => {
    playSound('fail', game.soundEnabled);
    const stabilityLoss = 30; 
    let newStability = game.stability - stabilityLoss;
    
    let nextLevel = game.currentLevel;
    let nextStatus: GameState['status'] = 'playing';

    if (newStability <= 0) {
        if (game.currentLevel > 1) {
            nextLevel--;
            newStability = 50;
            nextStatus = 'level_down';
        } else {
            // Level 1 failure shouldn't kill the session, just reset stability
            newStability = 20; 
        }
    }

    setGame(prev => ({
        ...prev, status: nextStatus === 'gameover' ? 'gameover' : 'success_anim',
        multiplier: 1, streak: 0, stability: Math.max(0, newStability)
    }));

    if (nextStatus === 'gameover') return;

    setTimeout(() => {
        setGame(prev => ({ ...prev, status: nextStatus, currentLevel: nextLevel, stability: newStability <= 0 ? 50 : newStability }));
        setTimeout(() => {
            setGame(prev => ({ ...prev, status: 'playing' }));
            generateLevel(nextLevel);
        }, nextStatus === 'level_down' ? 1200 : 200);
    }, 500);
  };

  const handleCellClick = (x: number, y: number) => {
    if (game.status !== 'playing') return;
    if (x === targetPos.current?.x && y === targetPos.current?.y) {
        setFeedbackCell({ x, y, type: 'success' });
        handleSuccess();
    } else {
        setFeedbackCell({ x, y, type: 'fail' });
        handleFailure(false);
    }
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
    // Grid container with forced aspect ratio and equal rows/cols
    grid: {
      display: 'grid', 
      gridTemplateColumns: `repeat(${GRID_SIZE}, 1fr)`, 
      gridTemplateRows: `repeat(${GRID_SIZE}, 1fr)`,
      gap: '6px', 
      width: '100%', 
      maxWidth: '440px', 
      aspectRatio: '1/1', // Crucial for squareness
      padding: '10px',
      background: 'rgba(255,255,255,0.02)', 
      borderRadius: '12px', 
      border: `1px solid ${COLORS.gridBorder}`,
      boxShadow: '0 0 30px rgba(0,0,0,0.5)',
      position: 'relative' as const
    },
    cell: {
      background: COLORS.cellBg, 
      borderRadius: '4px', 
      cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', 
      position: 'relative' as const,
      width: '100%', height: '100%' // Fill the grid track
    },
    overlay: {
        position: 'absolute' as const, inset: 0, background: 'rgba(0,0,0,0.92)',
        zIndex: 50, display: 'flex', flexDirection: 'column' as const,
        alignItems: 'center', justifyContent: 'center', padding: '32px'
    }
  };

  const isBlindLevel = game.currentLevel >= 15;

  return (
    <div style={styles.container}>
      {/* HEADER */}
      <div style={{ width: '100%', maxWidth: '440px', padding: '16px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', zIndex: 10 }}>
        <div>
            <div style={{display:'flex', alignItems:'center', gap: 6, fontSize: '10px', color: COLORS.muted, letterSpacing: '1px'}}>
                <BrainCircuit size={12} /> PROTOCOL LEVEL
            </div>
            <div style={{fontSize: '28px', fontWeight: 900, color: '#fff', lineHeight: '1'}}>
                {game.currentLevel}
                {isBlindLevel && <span style={{fontSize: '12px', color: COLORS.inverted, marginLeft: 8}}><EyeOff size={12} style={{display:'inline'}}/> BLIND</span>}
            </div>
        </div>
        <div style={{textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end'}}>
            <div style={{fontSize: '10px', color: COLORS.muted, letterSpacing: '1px'}}>COGNITIVE LOAD</div>
            <div style={{fontSize: '20px', fontWeight: 800, color: COLORS.anchor}}>{game.score.toLocaleString()}</div>
        </div>
      </div>

      {/* STABILITY METER + RESET CONTROL */}
      <div style={{ width: '100%', maxWidth: '440px', marginBottom: '24px', zIndex: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{flex: 1, height: '6px', background: '#222', borderRadius: '3px', overflow: 'hidden'}}>
              <motion.div 
                animate={{ width: `${game.stability}%`, backgroundColor: game.stability > 50 ? COLORS.anchor : COLORS.inverted }}
                transition={{ duration: 0.5 }}
                style={{ height: '100%' }}
              />
          </div>
          
          {/* STOP BUTTON */}
           <button 
              onClick={stopGame}
              title="End Session (Saves Progress)"
              disabled={game.status !== 'playing'}
              style={{
                  background: 'transparent', border: '1px solid #333', color: game.status === 'playing' ? '#fff' : '#333',
                  width: 32, height: 32, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: game.status === 'playing' ? 'pointer' : 'default',
                  transition: 'all 0.2s'
              }}
           >
              <StopCircle size={16} />
           </button>

          {/* RESET BUTTON */}
          <button 
              onClick={resetProgress}
              title="Reset Level"
              style={{
                  background: 'transparent', border: '1px solid #333', color: '#fff',
                  width: 32, height: 32, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
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
                        borderTop: `2px solid ${step.displayColor}`, // Stroop Color
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
          <motion.div animate={{ width: `${timer}%` }} style={{ height: '100%', background: '#fff', opacity: 0.3 }} />
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
                    {/* Compass marks for Absolute Orientation aid */}
                    {game.currentLevel >= 7 && (
                        <div style={{position:'absolute', inset: 2, pointerEvents:'none', opacity: 0.1}}>
                            {x===GRID_SIZE-1 && y===0 && <div style={{width: 4, height: 4, background: COLORS.absolute, borderRadius: '50%'}}/>}
                        </div>
                    )}
                </motion.div>
            );
         })}
      </div>

      {/* IDLE / GAMEOVER LAYERS */}
      <AnimatePresence>
        {game.status === 'idle' && (
            <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} style={styles.overlay}>
                <div style={{width: 60, height: 60, border: `2px solid ${COLORS.anchor}`, borderRadius: '50%', display:'flex', alignItems:'center', justifyContent:'center', marginBottom: 24}}>
                    <Crosshair size={32} color={COLORS.anchor} />
                </div>
                <h1 style={{fontSize: '2.5rem', fontWeight: 900, color: '#fff', marginBottom: 8}}>UNBREAKABLE</h1>
                <p style={{color: '#666', fontSize: '12px', letterSpacing: '2px', marginBottom: 24}}>RFT PROTOCOL // PERSISTENT STATE</p>
                
                <div style={{display: 'flex', gap: 32, marginBottom: 48, color: '#888', fontSize: '12px'}}>
                    <div style={{textAlign:'center'}}>
                        <div style={{fontSize: '24px', color: '#fff', fontWeight: 'bold'}}>{game.currentLevel}</div>
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
                    {game.currentLevel > 1 && (
                        <button onClick={resetProgress} style={{background: 'transparent', border: '1px solid #333', color: '#666', padding: '8px', fontSize: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent:'center', gap: 6}}>
                           <RotateCcw size={10} /> RESET ALL PROGRESS
                        </button>
                    )}
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
                
                <div style={{fontSize: '32px', fontWeight: 'bold', color: COLORS.anchor, marginBottom: 48}}>{game.score}</div>
                
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