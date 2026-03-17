import { canCapture, isValidMove } from './gameLogic';
import { serverEnv } from './env';
import type { Faction, ServerGameState } from './types';

export const AI_PLAYER_ID = 'AI:deepseek';
export const AI_PLAYER_NAME = 'DeepSeek';

interface AiAction {
  fromIndex: number;
  toIndex?: number;
  summary: string;
  detail: string;
}

interface AiMoveDecision {
  fromIndex: number;
  toIndex?: number;
  provider: 'deepseek' | 'heuristic';
}

function getPlayerFactionName(faction: Faction) {
  return faction === 'RED' ? '红方' : '蓝方';
}

function getCoordLabel(index: number) {
  const row = Math.floor(index / 4);
  const col = index % 4;
  return `${String.fromCharCode(65 + row)}${col + 1}`;
}

function getPieceLabel(
  piece: { name: string; rank: number; faction: Faction } | null | undefined,
) {
  if (!piece) {
    return '空位';
  }

  return `${getPlayerFactionName(piece.faction)}${piece.name}(阶${piece.rank})`;
}

function buildLegalActions(state: ServerGameState, faction: Faction): AiAction[] {
  const actions: AiAction[] = [];

  state.board.forEach((cell, index) => {
    if (!cell.isRevealed) {
      actions.push({
        fromIndex: index,
        summary: `flip ${index}`,
        detail: `翻开 ${getCoordLabel(index)} 的暗牌`,
      });
      return;
    }

    if (!cell.piece || cell.piece.faction !== faction) {
      return;
    }

    state.board.forEach((target, targetIndex) => {
      if (!isValidMove(index, targetIndex) || !target.isRevealed) {
        return;
      }

      if (!target.piece) {
        actions.push({
          fromIndex: index,
          toIndex: targetIndex,
          summary: `move ${index} ${targetIndex}`,
          detail: `${getCoordLabel(index)} -> ${getCoordLabel(targetIndex)}，移动到空位`,
        });
        return;
      }

      if (target.piece.faction === faction) {
        return;
      }

      if (cell.piece && canCapture(cell.piece, target.piece)) {
        actions.push({
          fromIndex: index,
          toIndex: targetIndex,
          summary: `capture ${index} ${targetIndex}`,
          detail: `${getCoordLabel(index)} -> ${getCoordLabel(targetIndex)}，${getPieceLabel(cell.piece)} 吃 ${getPieceLabel(target.piece)}`,
        });
      }
    });
  });

  return actions;
}

function scoreAction(state: ServerGameState, faction: Faction, action: AiAction) {
  const fromCell = state.board[action.fromIndex];
  const toCell = action.toIndex === undefined ? null : state.board[action.toIndex];

  if (!fromCell.isRevealed) {
    return 8;
  }

  if (!toCell?.piece) {
    return 4;
  }

  if (toCell.piece.faction === faction) {
    return Number.NEGATIVE_INFINITY;
  }

  const attackerRank = fromCell.piece?.rank ?? 0;
  const defenderRank = toCell.piece.rank;
  const rankDelta = defenderRank - attackerRank;

  if (attackerRank === defenderRank) {
    return 20 + defenderRank;
  }

  return 40 + defenderRank * 3 - Math.max(rankDelta, 0);
}

function pickHeuristicMove(state: ServerGameState, faction: Faction): AiMoveDecision | null {
  const actions = buildLegalActions(state, faction);

  if (actions.length === 0) {
    return null;
  }

  const scored = actions
    .map((action) => ({
      action,
      score: scoreAction(state, faction, action),
    }))
    .sort((left, right) => right.score - left.score);

  const bestScore = scored[0].score;
  const bestMoves = scored.filter((item) => item.score === bestScore);
  const selected = bestMoves[Math.floor(Math.random() * bestMoves.length)].action;

  return {
    fromIndex: selected.fromIndex,
    toIndex: selected.toIndex,
    provider: 'heuristic',
  };
}

function normalizeJsonCandidate(raw: string) {
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fencedMatch ? fencedMatch[1].trim() : raw.trim();
}

function buildSystemPrompt() {
  return [
    '你是一个认真、稳健的斗兽棋 AI，对局为 4x4 暗棋。',
    '你的任务是从给定合法动作里选择当前最优一步。',
    '规则如下：',
    '1. 每回合只能做一件事：翻开一张暗牌，或将己方已翻开的棋子移动到上下左右相邻格。',
    '2. 只能移动到相邻格，不能走斜线，不能走到暗牌上。',
    '3. 不能吃己方棋子。',
    '4. 吃子规则：通常高阶可以吃低阶；同阶相撞同归于尽。',
    '5. 特例：鼠可以吃象；象不能吃鼠。',
    '6. 胜负目标：让对方棋子全部消失即可获胜。',
    '策略要求：',
    '1. 能直接赚子时优先赚子。',
    '2. 避免无意义送子，尤其避免高阶白给低阶反吃。',
    '3. 同归于尽只有在能换掉关键高阶子、形成明显优势或避免被吃时才考虑。',
    '4. 在信息不足时，可以翻暗牌获取信息，但不要放弃明显更优的吃子机会。',
    '5. 必须严格从 legalActions 中选一步，不要发明不存在的动作。',
    '输出要求：仅返回 JSON，例如 {"fromIndex":3,"toIndex":7}。如果是翻牌，返回 {"fromIndex":3,"toIndex":null}。',
  ].join('\n');
}

function buildUserPayload(state: ServerGameState, faction: Faction, actions: AiAction[]) {
  return {
    side: getPlayerFactionName(faction),
    roomId: state.roomId,
    turn: state.turn ? getPlayerFactionName(state.turn) : null,
    boardLegend: '棋盘索引按 4x4 排列：第 0-3 格是 A1-A4，第 4-7 格是 B1-B4，第 8-11 格是 C1-C4，第 12-15 格是 D1-D4。',
    board: state.board.map((cell) => ({
      id: cell.id,
      coord: getCoordLabel(cell.id),
      isRevealed: cell.isRevealed,
      piece: cell.piece
        ? {
            name: cell.piece.name,
            rank: cell.piece.rank,
            faction: getPlayerFactionName(cell.piece.faction),
            shortLabel: getPieceLabel(cell.piece),
          }
        : null,
      description: cell.isRevealed
        ? `${getCoordLabel(cell.id)}: ${getPieceLabel(cell.piece)}`
        : `${getCoordLabel(cell.id)}: 暗牌`,
    })),
    legalActions: actions.map((action) => ({
      fromIndex: action.fromIndex,
      toIndex: action.toIndex ?? null,
      summary: action.summary,
      detail: action.detail,
    })),
    recentLogs: state.logs.slice(-8),
  };
}

async function requestDeepSeekMove(
  state: ServerGameState,
  faction: Faction,
  actions: AiAction[],
): Promise<AiMoveDecision | null> {
  const apiKey = serverEnv.deepseekApiKey;

  if (!apiKey) {
    return null;
  }

  const apiUrl = serverEnv.deepseekApiUrl;
  const model = serverEnv.deepseekModel;
  const payload = {
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(),
      },
      {
        role: 'user',
        content: JSON.stringify(buildUserPayload(state, faction, actions), null, 2),
      },
    ],
  };

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek request failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };

  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    return null;
  }

  const parsed = JSON.parse(normalizeJsonCandidate(content)) as {
    fromIndex?: number;
    toIndex?: number | null;
  };

  const matched = actions.find(
    (action) =>
      action.fromIndex === parsed.fromIndex &&
      (action.toIndex ?? null) === (parsed.toIndex ?? null),
  );

  if (!matched) {
    return null;
  }

  return {
    fromIndex: matched.fromIndex,
    toIndex: matched.toIndex,
    provider: 'deepseek',
  };
}

export async function chooseAiMove(
  state: ServerGameState,
  faction: Faction,
): Promise<AiMoveDecision | null> {
  const actions = buildLegalActions(state, faction);

  if (actions.length === 0) {
    return null;
  }

  try {
    const llmMove = await requestDeepSeekMove(state, faction, actions);
    if (llmMove) {
      return llmMove;
    }
  } catch (error) {
    console.warn('DeepSeek move failed, falling back to heuristic AI.', error);
  }

  return pickHeuristicMove(state, faction);
}
