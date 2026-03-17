import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { AI_PLAYER_ID, AI_PLAYER_NAME, chooseAiMove } from './ai';
import { loadedEnvFiles, serverEnv } from './env';
import { canCapture, checkWinCondition, initializeBoard, isValidMove } from './gameLogic';
import type { Faction, PlayerInfo, ServerGameState } from './types';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: serverEnv.corsOrigin,
    methods: ['GET', 'POST'],
  },
});

const rooms: Record<string, ServerGameState> = {};
const pendingAiTurns = new Set<string>();

type RoomIntent = 'create' | 'join';

function normalizeRoomId(roomId: string) {
  return roomId.trim();
}

function getFactionName(faction: Faction | 'DRAW' | null) {
  if (!faction) return '未分配';
  if (faction === 'DRAW') return '平局';
  return faction === 'RED' ? '红方' : '蓝方';
}

function isAiPlayer(player: PlayerInfo | undefined): player is PlayerInfo & { isAi: true } {
  return Boolean(player?.isAi);
}

function getAiPlayer(room: ServerGameState) {
  return room.players.find(isAiPlayer) ?? null;
}

function getHumanCount(room: ServerGameState) {
  return room.players.filter((player) => !player.isAi).length;
}

function createBaseRoom(roomId: string, socket: Socket, mode: 'pvp' | 'pve'): ServerGameState {
  const room: ServerGameState = {
    roomId,
    players: [{ socketId: socket.id, faction: null, name: '你' }],
    board: initializeBoard(),
    turn: null,
    firstPlayerSocketId: null,
    gameOver: false,
    winner: null,
    logs: mode === 'pve' ? ['DeepSeek 已入座，请先手翻牌。'] : ['等待玩家加入...'],
    history: [],
    undoRequest: null,
    restartRequest: null,
    mode,
    aiProvider: mode === 'pve' ? 'heuristic' : null,
  };

  if (mode === 'pve') {
    room.players.push({
      socketId: AI_PLAYER_ID,
      faction: null,
      isAi: true,
      name: AI_PLAYER_NAME,
    });
  }

  return room;
}

function resetRoom(room: ServerGameState, reason: string) {
  pendingAiTurns.delete(room.roomId);
  room.board = initializeBoard();
  room.turn = null;
  room.firstPlayerSocketId = null;
  room.gameOver = false;
  room.winner = null;
  room.history = [];
  room.undoRequest = null;
  room.restartRequest = null;
  room.players.forEach((player) => {
    player.faction = null;
  });
  room.logs = [reason];
  room.aiProvider = room.mode === 'pve' ? 'heuristic' : null;
}

function getRoomCheckResult(roomId: string, intent: RoomIntent) {
  const normalizedRoomId = normalizeRoomId(roomId);

  if (!normalizedRoomId) {
    return {
      ok: false,
      roomId: normalizedRoomId,
      message: '房间号不能为空',
    };
  }

  const room = rooms[normalizedRoomId];

  if (intent === 'create') {
    if (room && room.players.length > 0) {
      return {
        ok: false,
        roomId: normalizedRoomId,
        message: '房间已被占用，请更换房间号',
      };
    }

    return {
      ok: true,
      roomId: normalizedRoomId,
      message: '',
    };
  }

  if (!room || room.players.length === 0) {
    return {
      ok: false,
      roomId: normalizedRoomId,
      message: '房间不存在，不能加入空房间',
    };
  }

  if (room.players.length >= 2) {
    return {
      ok: false,
      roomId: normalizedRoomId,
      message: '房间已满',
    };
  }

  return {
    ok: true,
    roomId: normalizedRoomId,
    message: '',
  };
}

function emitRoomState(roomId: string) {
  const room = rooms[roomId];

  if (!room) {
    return;
  }

  io.to(roomId).emit('gameState', room);
}

function applyMove(
  room: ServerGameState,
  actorSocketId: string,
  fromIndex: number,
  toIndex?: number,
) {
  if (room.gameOver) {
    return { ok: false, message: '对局已结束' };
  }

  const player = room.players.find((item) => item.socketId === actorSocketId);

  if (!player) {
    return { ok: false, message: '玩家不存在' };
  }

  if (room.players.length < 2) {
    return { ok: false, message: '请等待另一位玩家加入' };
  }

  if (fromIndex < 0 || fromIndex >= room.board.length) {
    return { ok: false, message: '无效位置' };
  }

  if (room.turn && player.faction && room.turn !== player.faction) {
    return { ok: false, message: '还没轮到你' };
  }

  const cell = room.board[fromIndex];

  if (!cell) {
    return { ok: false, message: '无效位置' };
  }

  if (!cell.isRevealed) {
    room.history.push({
      board: JSON.parse(JSON.stringify(room.board)),
      turn: room.turn,
      logs: [...room.logs],
    });

    if (room.history.length > 10) {
      room.history.shift();
    }

    const piece = cell.piece;
    const newBoard = [...room.board];
    newBoard[fromIndex] = { ...cell, isRevealed: true };
    room.board = newBoard;
    room.logs.push(`翻出 ${piece?.name ?? '空'} (${piece?.faction ? getFactionName(piece.faction) : '无'})`);

    if (room.turn === null && piece) {
      room.firstPlayerSocketId = actorSocketId;
      player.faction = piece.faction;

      const otherPlayer = room.players.find((item) => item.socketId !== actorSocketId);
      if (otherPlayer) {
        otherPlayer.faction = piece.faction === 'RED' ? 'BLUE' : 'RED';
      }

      room.turn = piece.faction === 'RED' ? 'BLUE' : 'RED';
      room.logs.push(`先手为 ${getFactionName(piece.faction)}。下一回合: ${getFactionName(room.turn)}`);
    } else if (room.turn !== null) {
      room.turn = room.turn === 'RED' ? 'BLUE' : 'RED';
    }

    return { ok: true };
  }

  if (toIndex === undefined) {
    return { ok: false, message: '目标位置不能为空' };
  }

  if (toIndex < 0 || toIndex >= room.board.length) {
    return { ok: false, message: '无效位置' };
  }

  if (cell.piece?.faction !== player.faction) {
    return { ok: false, message: '只能操作己方棋子' };
  }

  if (!isValidMove(fromIndex, toIndex)) {
    return { ok: false, message: '只能移动到相邻格子' };
  }

  const targetCell = room.board[toIndex];
  const selectedPiece = cell.piece;

  if (!selectedPiece || !targetCell) {
    return { ok: false, message: '无效位置' };
  }

  if (!targetCell.isRevealed) {
    return { ok: false, message: '不能移动到暗牌上' };
  }

  room.history.push({
    board: JSON.parse(JSON.stringify(room.board)),
    turn: room.turn,
    logs: [...room.logs],
  });

  if (room.history.length > 10) {
    room.history.shift();
  }

  if (!targetCell.piece) {
    room.board[toIndex].piece = selectedPiece;
    room.board[fromIndex].piece = null;
    room.logs.push(`${selectedPiece.name} 移动。`);
  } else if (canCapture(selectedPiece, targetCell.piece)) {
    if (selectedPiece.rank === targetCell.piece.rank) {
      room.logs.push(`${selectedPiece.name} 与 ${targetCell.piece.name} 同归于尽!`);
      room.board[toIndex].piece = null;
      room.board[fromIndex].piece = null;
    } else {
      room.logs.push(`${selectedPiece.name} 吃掉了 ${targetCell.piece.name}!`);
      room.board[toIndex].piece = selectedPiece;
      room.board[fromIndex].piece = null;
    }

    const winner = checkWinCondition(room.board);

    if (winner) {
      room.gameOver = true;
      room.winner = winner;
      room.logs.push(`游戏结束! ${winner === 'DRAW' ? '平局' : `${getFactionName(winner)} 获胜`}!`);
    }
  } else {
    return { ok: false, message: '当前棋子无法吃掉目标' };
  }

  if (!room.gameOver && room.turn) {
    room.turn = room.turn === 'RED' ? 'BLUE' : 'RED';
  }

  return { ok: true };
}

async function queueAiTurn(roomId: string) {
  const room = rooms[roomId];

  if (!room || room.gameOver || pendingAiTurns.has(roomId)) {
    return;
  }

  const aiPlayer = getAiPlayer(room);

  if (!aiPlayer || !aiPlayer.faction || room.turn !== aiPlayer.faction) {
    return;
  }

  pendingAiTurns.add(roomId);

  try {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const freshRoom = rooms[roomId];

    if (!freshRoom || freshRoom.gameOver) {
      return;
    }

    const freshAi = getAiPlayer(freshRoom);
    if (!freshAi || !freshAi.faction || freshRoom.turn !== freshAi.faction) {
      return;
    }

    const decision = await chooseAiMove(freshRoom, freshAi.faction);

    if (!decision) {
      freshRoom.logs.push(`${AI_PLAYER_NAME} 暂时没有找到合法落子。`);
      emitRoomState(roomId);
      return;
    }

    const result = applyMove(freshRoom, freshAi.socketId, decision.fromIndex, decision.toIndex);

    if (!result.ok) {
      freshRoom.logs.push(`${AI_PLAYER_NAME} 决策失败：${result.message}`);
    } else {
      freshRoom.aiProvider = decision.provider;
      freshRoom.logs.push(
        decision.provider === 'deepseek'
          ? `${AI_PLAYER_NAME} 已完成思考。`
          : `${AI_PLAYER_NAME} 使用本地策略完成落子。`,
      );
    }

    emitRoomState(roomId);
  } catch (error) {
    const freshRoom = rooms[roomId];
    if (freshRoom) {
      freshRoom.logs.push(`${AI_PLAYER_NAME} 暂时离线，已跳过本次思考。`);
      emitRoomState(roomId);
    }
    console.error('AI turn failed:', error);
  } finally {
    pendingAiTurns.delete(roomId);
  }
}

io.on('connection', (socket: Socket) => {
  console.log('User connected:', socket.id);

  socket.on(
    'checkRoom',
    (
      payload: { roomId: string; intent: RoomIntent },
      callback?: (result: { ok: boolean; roomId: string; message: string }) => void,
    ) => {
      const result = getRoomCheckResult(payload.roomId, payload.intent);
      callback?.(result);
    },
  );

  socket.on('createRoom', (roomId: string) => {
    const { ok, roomId: normalizedRoomId, message } = getRoomCheckResult(roomId, 'create');

    if (!ok) {
      socket.emit('gameError', message);
      return;
    }

    rooms[normalizedRoomId] = createBaseRoom(normalizedRoomId, socket, 'pvp');
    socket.join(normalizedRoomId);
    socket.emit('roomJoined', { roomId: normalizedRoomId, playerId: socket.id });
    socket.emit('gameState', rooms[normalizedRoomId]);
    console.log(`Room created: ${normalizedRoomId}`);
  });

  socket.on('createAiRoom', (roomId: string) => {
    const { ok, roomId: normalizedRoomId, message } = getRoomCheckResult(roomId, 'create');

    if (!ok) {
      socket.emit('gameError', message);
      return;
    }

    rooms[normalizedRoomId] = createBaseRoom(normalizedRoomId, socket, 'pve');
    socket.join(normalizedRoomId);
    socket.emit('roomJoined', { roomId: normalizedRoomId, playerId: socket.id });
    socket.emit('gameState', rooms[normalizedRoomId]);
    console.log(`AI room created: ${normalizedRoomId}`);
  });

  socket.on('joinRoom', (roomId: string) => {
    const { ok, roomId: normalizedRoomId, message } = getRoomCheckResult(roomId, 'join');

    if (!ok) {
      socket.emit('gameError', message);
      return;
    }

    const room = rooms[normalizedRoomId];

    if (!room) {
      socket.emit('gameError', '房间不存在，不能加入空房间');
      return;
    }

    const existingPlayer = room.players.find((player) => player.socketId === socket.id);

    if (existingPlayer) {
      socket.emit('roomJoined', { roomId: normalizedRoomId, playerId: socket.id });
      socket.emit('gameState', room);
      return;
    }

    room.players.push({ socketId: socket.id, faction: null, name: '对手' });
    socket.join(normalizedRoomId);

    const assignedPlayer = room.players.find((item) => item.faction !== null);
    const unassignedPlayer = room.players.find((item) => item.faction === null);

    if (assignedPlayer && unassignedPlayer) {
      unassignedPlayer.faction = assignedPlayer.faction === 'RED' ? 'BLUE' : 'RED';
      room.logs.push('玩家加入，已同步阵营，继续对局。');
    } else {
      room.logs.push('玩家加入! 游戏开始，请先手翻牌。');
    }

    socket.emit('roomJoined', { roomId: normalizedRoomId, playerId: socket.id });
    emitRoomState(normalizedRoomId);
    console.log(`User ${socket.id} joined room ${normalizedRoomId}. Players: ${room.players.length}`);
  });

  socket.on(
    'move',
    ({ roomId, fromIndex, toIndex }: { roomId: string; fromIndex: number; toIndex?: number }) => {
      const room = rooms[roomId];

      if (!room) {
        return;
      }

      const result = applyMove(room, socket.id, fromIndex, toIndex);

      if (!result.ok) {
        socket.emit('gameError', result.message);
        return;
      }

      emitRoomState(roomId);
      void queueAiTurn(roomId);
    },
  );

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    for (const roomId of Object.keys(rooms)) {
      const room = rooms[roomId];
      const playerIndex = room.players.findIndex((player) => player.socketId === socket.id);

      if (playerIndex === -1) {
        continue;
      }

      room.players.splice(playerIndex, 1);

      if (getHumanCount(room) === 0) {
        delete rooms[roomId];
        console.log(`Room ${roomId} deleted (no human players remaining)`);
        break;
      }

      room.logs.push('对方已断开连接');
      emitRoomState(roomId);
      break;
    }
  });

  socket.on('requestUndo', ({ roomId }) => {
    const room = rooms[roomId];

    if (!room || room.gameOver || room.history.length === 0) {
      return;
    }

    const player = room.players.find((item) => item.socketId === socket.id);

    if (!player || !player.faction) {
      return;
    }

    if (room.undoRequest) {
      return;
    }

    const aiPlayer = getAiPlayer(room);

    if (aiPlayer) {
      const prevState = room.history.pop();

      if (!prevState) {
        return;
      }

      room.board = prevState.board;
      room.turn = prevState.turn;
      room.logs = prevState.logs;
      room.undoRequest = null;
      room.logs.push(`${AI_PLAYER_NAME} 同意悔棋。`);
      emitRoomState(roomId);
      return;
    }

    room.undoRequest = {
      requesterFaction: player.faction,
      pending: true,
    };

    room.logs.push(`${getFactionName(player.faction)} 请求悔棋...`);
    emitRoomState(roomId);
  });

  socket.on('respondUndo', ({ roomId, approved }: { roomId: string; approved: boolean }) => {
    const room = rooms[roomId];

    if (!room || !room.undoRequest) {
      return;
    }

    const player = room.players.find((item) => item.socketId === socket.id);

    if (!player || !player.faction || player.faction === room.undoRequest.requesterFaction) {
      return;
    }

    if (approved) {
      const prevState = room.history.pop();

      if (prevState) {
        room.board = prevState.board;
        room.turn = prevState.turn;
        room.logs = prevState.logs;
        room.logs.push('对方同意悔棋。');
      }
    } else {
      room.logs.push('对方拒绝悔棋。');
    }

    room.undoRequest = null;
    emitRoomState(roomId);
  });

  socket.on('requestRestart', ({ roomId }) => {
    const room = rooms[roomId];

    if (!room || room.players.length < 2) {
      return;
    }

    const player = room.players.find((item) => item.socketId === socket.id);

    if (!player || !player.faction) {
      if (!room.gameOver) {
        return;
      }
    }

    if (room.restartRequest) {
      return;
    }

    const requesterFaction = player?.faction ?? 'RED';
    const aiPlayer = getAiPlayer(room);

    if (aiPlayer) {
      resetRoom(room, `${AI_PLAYER_NAME} 已同意，再来一局。`);
      emitRoomState(roomId);
      return;
    }

    room.restartRequest = {
      requesterFaction,
      pending: true,
    };

    room.logs.push(`${getFactionName(requesterFaction)} 请求重开一把...`);
    emitRoomState(roomId);
  });

  socket.on('respondRestart', ({ roomId, approved }: { roomId: string; approved: boolean }) => {
    const room = rooms[roomId];

    if (!room || !room.restartRequest) {
      return;
    }

    const player = room.players.find((item) => item.socketId === socket.id);

    if (!player || !player.faction || player.faction === room.restartRequest.requesterFaction) {
      return;
    }

    if (approved) {
      resetRoom(room, '双方同意，已重开新一局。');
    } else {
      room.logs.push('对方拒绝重开。');
      room.restartRequest = null;
    }

    emitRoomState(roomId);
  });
});

httpServer.listen(serverEnv.port, () => {
  if (loadedEnvFiles.length > 0) {
    console.log(`Loaded env files: ${loadedEnvFiles.join(', ')}`);
  }

  console.log(`Server running on port ${serverEnv.port}`);
});
