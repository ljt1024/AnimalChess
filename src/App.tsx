import { useEffect, useRef, useState } from 'react';
import './App.css';
import { io, Socket } from 'socket.io-client';
import { canCapture, isValidMove } from './gameLogic';
import type { CellData, Faction, Piece, ServerGameState } from '../server/types';

function resolveSocketUrl() {
  const configuredUrl = import.meta.env.VITE_SOCKET_URL?.trim();

  if (configuredUrl) {
    return configuredUrl;
  }

  if (import.meta.env.DEV) {
    return 'http://127.0.0.1:5011';
  }

  return window.location.origin;
}

const SOCKET_URL = resolveSocketUrl();
const socket: Socket = io(SOCKET_URL);

type FeedbackKind = 'capture' | 'trade' | 'victory';
type ToneKind = 'select' | 'flip' | 'capture' | 'trade' | 'victory';

interface BattleFeedback {
  id: number;
  kind: FeedbackKind;
  title: string;
  detail: string;
}

interface AudioEngine {
  context: AudioContext | null;
  master: GainNode | null;
  musicTimer: number | null;
}

interface RoomCheckResult {
  ok: boolean;
  roomId: string;
  message: string;
}

const FACTION_META: Record<Faction, { label: string; accent: string }> = {
  RED: { label: '红方', accent: '#ff7b6b' },
  BLUE: { label: '蓝方', accent: '#67d4ff' },
};

const PIECE_RANK_LABEL: Record<number, string> = {
  1: '一阶',
  2: '二阶',
  3: '三阶',
  4: '四阶',
  5: '五阶',
  6: '六阶',
  7: '七阶',
  8: '八阶',
};

const AUDIO_PRESETS: Record<
  ToneKind,
  {
    attack: number;
    release: number;
    volume: number;
    type: OscillatorType;
    notes: number[];
  }
> = {
  select: {
    attack: 0.02,
    release: 0.16,
    volume: 0.02,
    type: 'triangle',
    notes: [659.25, 783.99],
  },
  flip: {
    attack: 0.03,
    release: 0.22,
    volume: 0.028,
    type: 'triangle',
    notes: [329.63, 493.88],
  },
  capture: {
    attack: 0.015,
    release: 0.24,
    volume: 0.045,
    type: 'sawtooth',
    notes: [174.61, 261.63, 392],
  },
  trade: {
    attack: 0.01,
    release: 0.26,
    volume: 0.04,
    type: 'square',
    notes: [220, 196, 146.83],
  },
  victory: {
    attack: 0.02,
    release: 0.4,
    volume: 0.055,
    type: 'triangle',
    notes: [392, 523.25, 659.25],
  },
};

const MUSIC_SEQUENCE = [
  [164.81, 207.65, 246.94],
  [174.61, 220, 261.63],
  [196, 246.94, 293.66],
  [174.61, 220, 261.63],
];

function getPieceIcon(name: string) {
  switch (name) {
    case '象':
      return '🐘';
    case '狮':
      return '🦁';
    case '虎':
      return '🐯';
    case '豹':
      return '🐆';
    case '狼':
      return '🐺';
    case '狗':
      return '🐕';
    case '猫':
      return '🐈';
    case '鼠':
      return '🐀';
    default:
      return '';
  }
}

function getFactionName(faction: Faction | 'DRAW' | null) {
  if (!faction) return '未分配';
  if (faction === 'DRAW') return '平局';
  return FACTION_META[faction].label;
}

function getMyFactionFromState(state: ServerGameState | null, playerId: string) {
  if (!state || !playerId) return null;
  const player = state.players.find((item) => item.socketId === playerId);
  return player?.faction ?? null;
}

function normalizeServerMessage(message: string) {
  switch (message) {
    case 'Room already exists':
      return '房间已被占用，请更换房间号';
    case 'Room not found':
      return '房间不存在，不能加入空房间';
    case 'Room is full':
      return '房间已满';
    case 'Not your turn':
      return '还没轮到你';
    case 'Cannot move opponent piece':
      return '只能操作己方棋子';
    case 'Invalid move':
      return '只能移动到相邻格子';
    case 'Invalid capture':
      return '当前棋子无法吃掉目标';
    default:
      return message;
  }
}

function samePiece(a: Piece | null, b: Piece | null) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.name === b.name && a.faction === b.faction && a.rank === b.rank;
}

function getChangedCellIds(previousBoard: CellData[], nextBoard: CellData[]) {
  const changedIds: number[] = [];

  nextBoard.forEach((cell, index) => {
    const previousCell = previousBoard[index];

    if (
      previousCell.isRevealed !== cell.isRevealed ||
      !samePiece(previousCell.piece, cell.piece)
    ) {
      changedIds.push(index);
    }
  });

  return changedIds;
}

function getNewestMatchingLog(logs: string[], matcher: (log: string) => boolean) {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    if (matcher(logs[index])) {
      return logs[index];
    }
  }

  return null;
}

async function ensureAudioEngine(audioRef: { current: AudioEngine }) {
  const browserWindow = window as Window & typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextCtor = window.AudioContext ?? browserWindow.webkitAudioContext;

  if (!AudioContextCtor) {
    return null;
  }

  if (!audioRef.current.context) {
    const context = new AudioContextCtor();
    const master = context.createGain();
    master.gain.value = 0.0001;
    master.connect(context.destination);

    audioRef.current.context = context;
    audioRef.current.master = master;
  }

  if (audioRef.current.context?.state === 'suspended') {
    await audioRef.current.context.resume();
  }

  return audioRef.current;
}

async function playTone(audioRef: { current: AudioEngine }, tone: ToneKind) {
  const engine = await ensureAudioEngine(audioRef);

  if (!engine?.context || !engine.master) {
    return;
  }

  const context = engine.context;
  const master = engine.master;
  const preset = AUDIO_PRESETS[tone];
  const start = context.currentTime + 0.01;

  preset.notes.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const noteStart = start + index * 0.035;

    oscillator.type = preset.type;
    oscillator.frequency.setValueAtTime(frequency, noteStart);
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(preset.volume, noteStart + preset.attack);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      noteStart + preset.attack + preset.release,
    );

    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + preset.attack + preset.release + 0.06);
  });
}

async function startMusic(audioRef: { current: AudioEngine }) {
  const engine = await ensureAudioEngine(audioRef);

  if (!engine?.context || !engine.master || engine.musicTimer !== null) {
    return;
  }

  const context = engine.context;
  const master = engine.master;
  let step = 0;

  master.gain.cancelScheduledValues(context.currentTime);
  master.gain.setTargetAtTime(0.16, context.currentTime, 0.25);

  const scheduleChord = () => {
    const now = context.currentTime + 0.04;
    const notes = MUSIC_SEQUENCE[step % MUSIC_SEQUENCE.length];

    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = index === 0 ? 'triangle' : 'sine';
      oscillator.frequency.setValueAtTime(frequency, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(index === 0 ? 0.04 : 0.024, now + 0.16);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.02);

      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(now + index * 0.01);
      oscillator.stop(now + 1.08);
    });

    const accent = context.createOscillator();
    const accentGain = context.createGain();

    accent.type = 'square';
    accent.frequency.setValueAtTime(notes[0] * 2, now + 0.24);
    accentGain.gain.setValueAtTime(0.0001, now + 0.24);
    accentGain.gain.exponentialRampToValueAtTime(0.013, now + 0.28);
    accentGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.46);

    accent.connect(accentGain);
    accentGain.connect(master);
    accent.start(now + 0.24);
    accent.stop(now + 0.5);

    step += 1;
  };

  scheduleChord();
  engine.musicTimer = window.setInterval(scheduleChord, 1120);
}

function stopMusic(audioRef: { current: AudioEngine }) {
  const { context, master, musicTimer } = audioRef.current;

  if (musicTimer !== null) {
    window.clearInterval(musicTimer);
    audioRef.current.musicTimer = null;
  }

  if (context && master) {
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setTargetAtTime(0.0001, context.currentTime, 0.18);
  }
}

function App() {
  const [inLobby, setInLobby] = useState(true);
  const [roomId, setRoomId] = useState('');
  const [inputRoomId, setInputRoomId] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [gameState, setGameState] = useState<ServerGameState | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isAudioEnabled, setIsAudioEnabled] = useState(false);
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [pendingLobbyAction, setPendingLobbyAction] = useState<'create' | 'create-ai' | 'join' | null>(null);
  const [battleFeedback, setBattleFeedback] = useState<BattleFeedback | null>(null);
  const [impactCells, setImpactCells] = useState<number[]>([]);

  const previousGameStateRef = useRef<ServerGameState | null>(null);
  const clearErrorTimerRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const impactTimerRef = useRef<number | null>(null);
  const audioRef = useRef<AudioEngine>({
    context: null,
    master: null,
    musicTimer: null,
  });

  const enterRoom = (nextRoomId: string, nextPlayerId: string) => {
    setInLobby(false);
    setRoomId(nextRoomId);
    setPlayerId(nextPlayerId);
    setPendingLobbyAction(null);
    setSelectedId(null);
    setBattleFeedback(null);
    setImpactCells([]);
    setErrorMsg('');
    previousGameStateRef.current = null;
  };

  useEffect(() => {
    const handleConnect = () => {
      setIsConnected(true);
      console.log('Connected to server', socket.id);
    };

    const handleDisconnect = () => {
      setIsConnected(false);
      setPendingLobbyAction(null);
    };

    const handleConnectError = () => {
      setIsConnected(false);
      setPendingLobbyAction(null);
    };

    const handleRoomJoined = (payload: { roomId: string; playerId: string }) => {
      enterRoom(payload.roomId, payload.playerId);
    };

    const handleGameState = (state: ServerGameState) => {
      setGameState(state);

      if (
        inLobby &&
        state.players.some((item) => item.socketId === socket.id) &&
        (pendingLobbyAction !== null || state.roomId === inputRoomId.trim())
      ) {
        enterRoom(state.roomId, socket.id ?? '');
      }
    };

    const handleGameError = (msg: string) => {
      setPendingLobbyAction(null);
      setErrorMsg(normalizeServerMessage(msg));

      if (clearErrorTimerRef.current !== null) {
        window.clearTimeout(clearErrorTimerRef.current);
      }

      clearErrorTimerRef.current = window.setTimeout(() => {
        setErrorMsg('');
      }, 3000);
    };

    socket.on('connect', handleConnect);
    socket.on('connect_error', handleConnectError);
    socket.on('disconnect', handleDisconnect);
    socket.on('roomJoined', handleRoomJoined);
    socket.on('gameState', handleGameState);
    socket.on('gameError', handleGameError);
    socket.on('error', handleGameError);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('connect_error', handleConnectError);
      socket.off('disconnect', handleDisconnect);
      socket.off('roomJoined', handleRoomJoined);
      socket.off('gameState', handleGameState);
      socket.off('gameError', handleGameError);
      socket.off('error', handleGameError);
    };
  }, [inLobby, inputRoomId, pendingLobbyAction]);

  useEffect(() => {
    if (!gameState) {
      return;
    }

    const previous = previousGameStateRef.current;

    if (previous) {
      const changedIds = getChangedCellIds(previous.board, gameState.board);
      const newLogs = gameState.logs.slice(previous.logs.length);
      const captureLog = getNewestMatchingLog(newLogs, (log) => log.includes('吃掉了'));
      const tradeLog = getNewestMatchingLog(newLogs, (log) => log.includes('同归于尽'));
      const victoryLog = getNewestMatchingLog(newLogs, (log) => log.includes('游戏结束'));

      const showFeedback = (
        kind: FeedbackKind,
        title: string,
        detail: string,
        vibrationPattern: number | number[],
        tone: ToneKind,
      ) => {
        setBattleFeedback({
          id: Date.now(),
          kind,
          title,
          detail,
        });
        setImpactCells(changedIds);

        if (feedbackTimerRef.current !== null) {
          window.clearTimeout(feedbackTimerRef.current);
        }

        if (impactTimerRef.current !== null) {
          window.clearTimeout(impactTimerRef.current);
        }

        feedbackTimerRef.current = window.setTimeout(() => {
          setBattleFeedback(null);
        }, 1800);

        impactTimerRef.current = window.setTimeout(() => {
          setImpactCells([]);
        }, 900);

        if (navigator.vibrate) {
          navigator.vibrate(vibrationPattern);
        }

        if (isAudioEnabled) {
          void playTone(audioRef, tone);
        }
      };

      if (captureLog) {
        showFeedback('capture', '吃子命中', captureLog, [40, 30, 40], 'capture');
      } else if (tradeLog) {
        showFeedback('trade', '双方抵消', tradeLog, [60, 40, 60], 'trade');
      } else if (victoryLog) {
        showFeedback('victory', '对局结束', victoryLog, [120, 80, 120], 'victory');
      } else {
        const revealedCellChanged = changedIds.some(
          (cellId) =>
            !previous.board[cellId].isRevealed && gameState.board[cellId].isRevealed,
        );

        if (revealedCellChanged && isAudioEnabled) {
          void playTone(audioRef, 'flip');
        }
      }
    }

    previousGameStateRef.current = gameState;
  }, [gameState, isAudioEnabled]);

  useEffect(() => {
    if (!gameState || selectedId === null) {
      return;
    }

    const myFaction = getMyFactionFromState(gameState, playerId);
    const selectedCell = gameState.board[selectedId];

    if (
      !selectedCell?.piece ||
      selectedCell.piece.faction !== myFaction ||
      gameState.gameOver ||
      (gameState.turn && gameState.turn !== myFaction)
    ) {
      setSelectedId(null);
    }
  }, [gameState, selectedId, playerId]);

  useEffect(() => {
    return () => {
      if (clearErrorTimerRef.current !== null) {
        window.clearTimeout(clearErrorTimerRef.current);
      }

      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
      }

      if (impactTimerRef.current !== null) {
        window.clearTimeout(impactTimerRef.current);
      }

      stopMusic(audioRef);
    };
  }, []);

  const showLocalError = (message: string) => {
    setErrorMsg(message);

    if (clearErrorTimerRef.current !== null) {
      window.clearTimeout(clearErrorTimerRef.current);
    }

    clearErrorTimerRef.current = window.setTimeout(() => {
      setErrorMsg('');
    }, 3000);
  };

  const checkRoom = async (
    intent: 'create' | 'join',
    nextRoomId: string,
  ): Promise<RoomCheckResult | null> =>
    new Promise((resolve) => {
      socket.timeout(900).emit(
        'checkRoom',
        { roomId: nextRoomId, intent },
        (
          error: Error | null,
          result?: RoomCheckResult,
        ) => {
          if (error || !result) {
            resolve(null);
            return;
          }

          resolve(result);
        },
      );
    });

  const createRoom = () => {
    void (async () => {
    const nextRoomId = inputRoomId.trim();

    if (!isConnected) {
      showLocalError('正在连接服务器，请稍后重试');
      return;
    }

    if (pendingLobbyAction) {
      return;
    }

    if (!nextRoomId) {
      showLocalError('请输入房间号');
      return;
    }

    setPendingLobbyAction('create');
    const roomCheck = await checkRoom('create', nextRoomId);

    if (roomCheck && !roomCheck.ok) {
      setPendingLobbyAction(null);
      showLocalError(roomCheck.message);
      return;
    }

    socket.emit('createRoom', nextRoomId);
    })();
  };

  const createAiRoom = () => {
    void (async () => {
    const nextRoomId = inputRoomId.trim();

    if (!isConnected) {
      showLocalError('正在连接服务器，请稍后重试');
      return;
    }

    if (pendingLobbyAction) {
      return;
    }

    if (!nextRoomId) {
      showLocalError('请输入房间号');
      return;
    }

    setPendingLobbyAction('create-ai');
    const roomCheck = await checkRoom('create', nextRoomId);

    if (roomCheck && !roomCheck.ok) {
      setPendingLobbyAction(null);
      showLocalError(roomCheck.message);
      return;
    }

    socket.emit('createAiRoom', nextRoomId);
    })();
  };

  const joinRoom = () => {
    void (async () => {
    const nextRoomId = inputRoomId.trim();

    if (!isConnected) {
      showLocalError('正在连接服务器，请稍后重试');
      return;
    }

    if (pendingLobbyAction) {
      return;
    }

    if (!nextRoomId) {
      showLocalError('请输入房间号');
      return;
    }

    setPendingLobbyAction('join');
    const roomCheck = await checkRoom('join', nextRoomId);

    if (roomCheck && !roomCheck.ok) {
      setPendingLobbyAction(null);
      showLocalError(roomCheck.message);
      return;
    }

    socket.emit('joinRoom', nextRoomId);
    })();
  };

  const toggleAudio = async () => {
    if (isAudioEnabled) {
      setIsAudioEnabled(false);
      stopMusic(audioRef);
      return;
    }

    const engine = await ensureAudioEngine(audioRef);

    if (!engine) {
      showLocalError('当前浏览器不支持 Web Audio');
      return;
    }

    setIsAudioEnabled(true);
    await startMusic(audioRef);
    await playTone(audioRef, 'select');
  };

  const myFaction = getMyFactionFromState(gameState, playerId);
  const opponent =
    gameState?.players.find((item) => item.socketId !== playerId) ?? null;
  const opponentName = opponent?.name ?? (opponent?.isAi ? 'DeepSeek' : '等待加入');
  const selectedPiece =
    selectedId !== null && gameState ? gameState.board[selectedId]?.piece ?? null : null;
  const latestLogs = gameState ? gameState.logs.slice(-8).reverse() : [];

  const handleCellClick = (index: number) => {
    if (!gameState || gameState.gameOver) {
      return;
    }

    if (gameState.players.length < 2) {
      showLocalError('请等待对手加入房间');
      return;
    }

    if (gameState.turn && gameState.turn !== myFaction) {
      showLocalError('还没轮到你');
      return;
    }

    const cell = gameState.board[index];

    if (!cell.isRevealed) {
      setSelectedId(null);
      socket.emit('move', { roomId, fromIndex: index });
      return;
    }

    if (selectedId !== null) {
      if (index === selectedId) {
        setSelectedId(null);
        return;
      }

      if (cell.piece && cell.piece.faction === myFaction) {
        setSelectedId(index);

        if (isAudioEnabled) {
          void playTone(audioRef, 'select');
        }

        return;
      }

      socket.emit('move', { roomId, fromIndex: selectedId, toIndex: index });
      setSelectedId(null);
      return;
    }

    if (!myFaction || !cell.piece || cell.piece.faction !== myFaction) {
      return;
    }

    setSelectedId(index);

    if (isAudioEnabled) {
      void playTone(audioRef, 'select');
    }
  };

  const getCellHintClass = (cell: CellData) => {
    if (!gameState || selectedId === null || !myFaction) {
      return '';
    }

    if (cell.id === selectedId || !cell.isRevealed) {
      return '';
    }

    const selectedCell = gameState.board[selectedId];

    if (
      !selectedCell?.piece ||
      selectedCell.piece.faction !== myFaction ||
      !isValidMove(selectedId, cell.id)
    ) {
      return '';
    }

    if (!cell.piece) {
      return 'cell--hint-move';
    }

    if (cell.piece.faction === myFaction) {
      return 'cell--hint-switch';
    }

    if (canCapture(selectedCell.piece, cell.piece)) {
      return selectedCell.piece.rank === cell.piece.rank
        ? 'cell--hint-trade'
        : 'cell--hint-attack';
    }

    return 'cell--hint-blocked';
  };

  const getCellClass = (cell: CellData) => {
    const classes = ['cell'];

    if (!cell.isRevealed) {
      classes.push('cell--hidden');
    } else if (!cell.piece) {
      classes.push('cell--empty');
    } else if (cell.piece.faction === myFaction) {
      classes.push('cell--ally');
    } else {
      classes.push('cell--enemy');
    }

    if (cell.id === selectedId) {
      classes.push('cell--selected');
    }

    if (impactCells.includes(cell.id)) {
      classes.push('cell--impact');
    }

    const hintClass = getCellHintClass(cell);

    if (hintClass) {
      classes.push(hintClass);
    }

    return classes.join(' ');
  };

  const requestUndo = () => {
    if (!gameState || !roomId) {
      return;
    }

    if (gameState.undoRequest) {
      showLocalError('已有悔棋请求等待处理');
      return;
    }

    socket.emit('requestUndo', { roomId });
  };

  const respondUndo = (approved: boolean) => {
    if (!gameState || !roomId) {
      return;
    }

    socket.emit('respondUndo', { roomId, approved });
  };

  const requestRestart = () => {
    if (!gameState || !roomId) {
      return;
    }

    if (gameState.restartRequest) {
      showLocalError('已有重开请求等待处理');
      return;
    }

    socket.emit('requestRestart', { roomId });
  };

  const respondRestart = (approved: boolean) => {
    if (!gameState || !roomId) {
      return;
    }

    socket.emit('respondRestart', { roomId, approved });
  };

  const statusText = !gameState
    ? '正在同步棋盘...'
    : gameState.gameOver
      ? `胜负已定：${getFactionName(gameState.winner)}`
      : gameState.turn
        ? `当前回合：${getFactionName(gameState.turn)}`
        : '请翻开第一张暗牌';

  const selectionText = selectedPiece
    ? `已选中 ${selectedPiece.name}${getPieceIcon(selectedPiece.name)}，点击相邻亮牌移动或吃子。`
    : !gameState
      ? '正在准备对局。'
      : gameState.players.length < 2
        ? '等待第二位玩家加入房间。'
        : gameState.gameOver
          ? `对局结束，${getFactionName(gameState.winner)}获胜。`
          : gameState.turn === null
            ? '先翻一张暗牌，先手阵营会随翻牌确定。'
            : gameState.turn === myFaction
              ? '轮到你操作：点暗牌翻开，或点己方棋子行动。'
              : opponent?.isAi
                ? 'DeepSeek 正在思考下一步。'
                : '等待对手行动。';
  const canRequestRestart =
    !!gameState &&
    gameState.players.length >= 2 &&
    !gameState.restartRequest &&
    (gameState.gameOver || !!myFaction);

  const canUseLobbyButtons = isConnected && pendingLobbyAction === null;

  if (inLobby) {
    return (
      <main className="app-shell app-shell--lobby">
        <section className="lobby-card">
          <p className="eyebrow">ONLINE DARK CHESS</p>
          <h1 className="page-title">斗兽棋</h1>
          <p className="page-subtitle">输入房间号后创建双人房，或直接和 DeepSeek 对战。</p>

          <div className="lobby-form">
            <label className="field-label" htmlFor="room-id">
              房间号
            </label>
            <input
              id="room-id"
              className="room-input"
              type="text"
              placeholder="例如 2026"
              value={inputRoomId}
              onChange={(event) => setInputRoomId(event.target.value)}
            />

            <div className="action-row">
              <button
                type="button"
                className="button button--primary"
                onClick={createRoom}
                disabled={!canUseLobbyButtons}
              >
                {pendingLobbyAction === 'create' ? '创建中...' : '创建房间'}
              </button>
              <button
                type="button"
                className="button button--ai"
                onClick={createAiRoom}
                disabled={!canUseLobbyButtons}
              >
                {pendingLobbyAction === 'create-ai' ? '匹配中...' : '人机对战'}
              </button>
              <button
                type="button"
                className="button button--ghost"
                onClick={joinRoom}
                disabled={!canUseLobbyButtons}
              >
                {pendingLobbyAction === 'join' ? '加入中...' : '加入房间'}
              </button>
            </div>

            <button
              type="button"
              className={`button button--ghost sound-toggle ${
                isAudioEnabled ? 'sound-toggle--active' : ''
              }`}
              onClick={() => void toggleAudio()}
            >
              {isAudioEnabled ? '关闭音乐' : '开启音乐'}
            </button>

            <p className="helper-text">
              {isConnected ? '服务器已连接' : '正在连接服务器...'}
            </p>

            {errorMsg && <div className="inline-error">{errorMsg}</div>}
          </div>
        </section>
      </main>
    );
  }

  if (!gameState) {
    return (
      <main className="app-shell">
        <div className="loading-card">正在同步对局...</div>
      </main>
    );
  }

  return (
    <main className={`app-shell ${battleFeedback ? 'app-shell--feedback' : ''}`}>
      <header className="page-header">
        <div className="page-heading">
          <p className="eyebrow">房间 {roomId}</p>
          <h1 className="page-title">斗兽棋对战</h1>
          <p className="page-subtitle">{statusText}</p>
        </div>

        <button
          type="button"
          className={`sound-toggle ${isAudioEnabled ? 'sound-toggle--active' : ''}`}
          onClick={() => void toggleAudio()}
        >
          {isAudioEnabled ? '音乐已开' : '开启音乐'}
        </button>
      </header>

      <section className="arena-layout">
        <div className="board-stage">
          <div className="stage-strip">
            <span className="stage-pill">你方：{getFactionName(myFaction)}</span>
            <span
              className={`stage-pill ${
                gameState.turn === 'RED'
                  ? 'stage-pill--red'
                  : gameState.turn === 'BLUE'
                    ? 'stage-pill--blue'
                    : ''
              }`}
            >
              {gameState.turn ? `回合 ${getFactionName(gameState.turn)}` : '等待先手翻牌'}
            </span>
          </div>

          <section
            className={`board-shell ${
              battleFeedback ? `board-shell--${battleFeedback.kind}` : ''
            }`}
          >
            <div className="board">
              {gameState.board.map((cell) => (
                <button
                  key={cell.id}
                  type="button"
                  className={getCellClass(cell)}
                  onClick={() => handleCellClick(cell.id)}
                >
                  {!cell.isRevealed && (
                    <span className="cell-back">
                      <span className="cell-back__kanji">兽</span>
                      <span className="cell-back__sub">暗牌</span>
                    </span>
                  )}

                  {cell.isRevealed && cell.piece && (
                    <span
                      className={`piece piece--${
                        cell.piece.faction === 'RED' ? 'red' : 'blue'
                      }`}
                    >
                      <span className="piece-icon">{getPieceIcon(cell.piece.name)}</span>
                      <span className="piece-name">{cell.piece.name}</span>
                      <span className="piece-rank">
                        {PIECE_RANK_LABEL[cell.piece.rank] ?? `${cell.piece.rank}阶`}
                      </span>
                    </span>
                  )}

                  {cell.isRevealed && !cell.piece && <span className="cell-empty">空位</span>}
                </button>
              ))}
            </div>
          </section>

          <div className="selection-strip">
            <span className="selection-strip__label">操作提示</span>
            <span className="selection-strip__text">{selectionText}</span>
          </div>

          <section className="rule-panel">
            <p className="rule-panel__title">规则速记</p>
            <p>
              象 &gt; 狮 &gt; 虎 &gt; 豹 &gt; 狼 &gt; 狗 &gt; 猫 &gt; 鼠 &gt; 象，
              同级相撞会同归于尽。
            </p>
          </section>
        </div>

        <aside className="dashboard">
          <section className="dashboard-card">
            <div className="dashboard-card__header">
              <h2>对局信息</h2>
              <span className="dashboard-chip">
                {gameState.mode === 'pve' ? `人机 · ${roomId}` : roomId}
              </span>
            </div>

            <div className="player-grid">
              <div className={`player-card ${myFaction ? `player-card--${myFaction.toLowerCase()}` : ''}`}>
                <span className="player-card__label">你</span>
                <strong>{getFactionName(myFaction)}</strong>
              </div>

              <div
                className={`player-card ${
                  opponent?.faction ? `player-card--${opponent.faction.toLowerCase()}` : 'player-card--pending'
                }`}
              >
                <span className="player-card__label">{opponent?.isAi ? '模型' : '对手'}</span>
                <strong>
                  {opponent ? `${opponentName} · ${getFactionName(opponent.faction)}` : '等待加入'}
                </strong>
              </div>
            </div>

            {gameState.mode === 'pve' && (
              <p className="helper-text">
                当前人机来源：{gameState.aiProvider === 'deepseek' ? 'DeepSeek API' : '本地策略回退'}
              </p>
            )}
          </section>

          <section className="dashboard-card">
            <div className="dashboard-card__header">
              <h2>悔棋</h2>
              <span className="dashboard-chip">最多回退 10 步</span>
            </div>

            <button
              type="button"
              className="button button--ghost button--full"
              onClick={requestUndo}
              disabled={!!gameState.undoRequest || !myFaction || gameState.gameOver}
            >
              请求悔棋
            </button>

            {gameState.undoRequest && gameState.undoRequest.pending && (
              <div className="undo-box">
                {gameState.undoRequest.requesterFaction === myFaction ? (
                  <p>悔棋请求已发出，等待对方确认。</p>
                ) : (
                  <>
                    <p>对方请求悔棋，是否同意？</p>
                    <div className="action-row">
                      <button
                        type="button"
                        className="button button--success"
                        onClick={() => respondUndo(true)}
                      >
                        同意
                      </button>
                      <button
                        type="button"
                        className="button button--danger"
                        onClick={() => respondUndo(false)}
                      >
                        拒绝
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>

          <section className="dashboard-card">
            <div className="dashboard-card__header">
              <h2>再来一局</h2>
              <span className="dashboard-chip">{gameState.mode === 'pve' ? 'AI 秒同意' : '需双方确认'}</span>
            </div>

            <button
              type="button"
              className="button button--primary button--full"
              onClick={requestRestart}
              disabled={!canRequestRestart}
            >
              重开一把
            </button>

            {gameState.restartRequest && gameState.restartRequest.pending && (
              <div className="undo-box">
                {gameState.restartRequest.requesterFaction === myFaction ? (
                  <p>重开请求已发出，等待对方确认。</p>
                ) : (
                  <>
                    <p>对方想再来一局，是否同意？</p>
                    <div className="action-row">
                      <button
                        type="button"
                        className="button button--success"
                        onClick={() => respondRestart(true)}
                      >
                        同意
                      </button>
                      <button
                        type="button"
                        className="button button--danger"
                        onClick={() => respondRestart(false)}
                      >
                        拒绝
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>

          <section className="dashboard-card">
            <div className="dashboard-card__header">
              <h2>战报</h2>
              <span className="dashboard-chip">最新在上</span>
            </div>

            <div className="log-list">
              {latestLogs.map((log, index) => (
                <div key={`${log}-${index}`} className="log-item">
                  {log}
                </div>
              ))}
            </div>
          </section>
        </aside>
      </section>

      {errorMsg && <div className="error-toast">{errorMsg}</div>}

      {battleFeedback && (
        <div
          key={battleFeedback.id}
          className={`battle-banner battle-banner--${battleFeedback.kind}`}
          aria-live="assertive"
        >
          <span className="battle-banner__label">{battleFeedback.title}</span>
          <strong>{battleFeedback.detail}</strong>
        </div>
      )}
    </main>
  );
}

export default App;
