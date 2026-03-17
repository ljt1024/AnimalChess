export type Faction = 'RED' | 'BLUE';

export const RANKS = {
  RAT: 1,
  CAT: 2,
  DOG: 3,
  WOLF: 4,
  LEOPARD: 5,
  TIGER: 6,
  LION: 7,
  ELEPHANT: 8,
} as const;

export type RankValue = typeof RANKS[keyof typeof RANKS];

export interface Piece {
  rank: RankValue;
  faction: Faction;
  name: string;
}

export interface CellData {
  id: number; // Index 0-15
  piece: Piece | null;
  isRevealed: boolean;
}

export interface PlayerInfo {
  socketId: string;
  faction: Faction | null; // Assigned after first move or randomly?
  isAi?: boolean;
  name?: string;
}

// Server Game State
export interface ServerGameState {
  roomId: string;
  players: PlayerInfo[];
  board: CellData[];
  turn: Faction | null; // Null until first flip
  firstPlayerSocketId: string | null; // Who flips first? Or random.
  gameOver: boolean;
  winner: Faction | 'DRAW' | null;
  logs: string[];
  mode?: 'pvp' | 'pve';
  aiProvider?: 'deepseek' | 'heuristic' | null;
  
  // Undo Logic
  history: {
    board: CellData[];
    turn: Faction | null;
    logs: string[]; // Snapshot of logs to revert? Or just append "Undo"? Usually revert board/turn is enough.
  }[]; // Stack of previous states
  undoRequest: {
    requesterFaction: Faction;
    pending: boolean;
  } | null;
  restartRequest: {
    requesterFaction: Faction;
    pending: boolean;
  } | null;
}
