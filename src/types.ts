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
  id: number; // Index 0-24
  piece: Piece | null;
  isRevealed: boolean;
}

export interface GameState {
  board: CellData[];
  turn: Faction; // Current turn
  // In this variant, the first person to flip determines their color.
  // We can track if the factions are assigned.
  redPlayerIsCurrent: boolean; // Is the current physical player "Red"? Or do we just track 'turn'
  // Actually, standard play:
  // Turn 1: Player A flips. If Red, Player A is Red. Next turn is Blue (Player B).
  myFaction: Faction | null; // For local play, we might just display "Red's Turn" or "Blue's Turn".
  // Let's stick to: "Current Turn: [Faction]"
  gameOver: boolean;
  winner: Faction | null;
  selectedCellId: number | null;
}
