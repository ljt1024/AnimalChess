import { RANKS } from './types';
import type { CellData, Faction, Piece, RankValue } from './types';

const PIECE_TYPES: { rank: RankValue; name: string }[] = [
  { rank: RANKS.RAT, name: '鼠' },
  { rank: RANKS.CAT, name: '猫' },
  { rank: RANKS.DOG, name: '狗' },
  { rank: RANKS.WOLF, name: '狼' },
  { rank: RANKS.LEOPARD, name: '豹' },
  { rank: RANKS.TIGER, name: '虎' },
  { rank: RANKS.LION, name: '狮' },
  { rank: RANKS.ELEPHANT, name: '象' },
];

export function createPieces(): Piece[] {
  const pieces: Piece[] = [];
  PIECE_TYPES.forEach((type) => {
    pieces.push({ ...type, faction: 'RED' });
    pieces.push({ ...type, faction: 'BLUE' });
  });
  return pieces;
}

export function shuffle<T>(array: T[]): T[] {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

export function initializeBoard(): CellData[] {
  const pieces = createPieces();
  const shuffledItems = shuffle(pieces);

  return shuffledItems.map((piece, index) => ({
    id: index,
    piece,
    isRevealed: false,
  }));
}

export function isValidMove(fromIdx: number, toIdx: number): boolean {
  // 4x4 grid
  const rowFrom = Math.floor(fromIdx / 4);
  const colFrom = fromIdx % 4;
  const rowTo = Math.floor(toIdx / 4);
  const colTo = toIdx % 4;

  const rowDiff = Math.abs(rowFrom - rowTo);
  const colDiff = Math.abs(colFrom - colTo);

  // Must be adjacent (up/down/left/right), not diagonal
  return (rowDiff + colDiff) === 1;
}

export function canCapture(attacker: Piece, defender: Piece): boolean {
  // Same faction cannot capture
  if (attacker.faction === defender.faction) return false;

  // Rat vs Elephant special case
  if (attacker.rank === RANKS.RAT && defender.rank === RANKS.ELEPHANT) {
    return true;
  }
  // Elephant vs Rat special case (Elephant cannot eat Rat)
  if (attacker.rank === RANKS.ELEPHANT && defender.rank === RANKS.RAT) {
    return false;
  }

  // General rank comparison
  return attacker.rank >= defender.rank;
}

export function checkWinCondition(board: CellData[]): Faction | 'DRAW' | null {
  const redPieces = board.filter(c => c.piece?.faction === 'RED');
  const bluePieces = board.filter(c => c.piece?.faction === 'BLUE');

  if (redPieces.length === 0 && bluePieces.length === 0) return 'DRAW';
  if (redPieces.length === 0) return 'BLUE';
  if (bluePieces.length === 0) return 'RED';

  return null;
}
