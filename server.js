/* =====================================================================
 *  연상퀴즈 서버 (Express + Socket.IO)
 *  - 퀴즈방 1~10번, 방당 최대 5명, 12라운드
 *  - 휴대폰을 껐다 켜도 같은 브라우저면 자동 재접속 (localStorage 의 playerId 사용)
 * ===================================================================== */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { QUIZZES, SAMPLE } = require('./quizzes');

/* =====================================================================
 *  ⚙️ 게임 설정  ―  숫자만 바꾸면 바로 적용됩니다
 * ===================================================================== */
const CONFIG = {
  // ⏱ 힌트 단어가 나오는 간격(초).  4 → 4초마다 힌트 1개씩 등장
  //    예) 3으로 바꾸면 3초마다, 5로 바꾸면 5초마다 등장
  HINT_INTERVAL_SEC: 3,

  // 💡 한 라운드에 보여줄 최대 힌트 개수
  MAX_HINTS: 6,

  // ⌛ 한 라운드 제한시간(초)
  ROUND_TIME_SEC: 30,

  // 🔁 총 라운드 수
  TOTAL_ROUNDS: 12,

  // 👥 방당 최대 인원
  MAX_PLAYERS: 5,

  // 🏆 정답 순서별 점수 (1등, 2등, 3등, 4등 / 5등 이후는 0점)
  SCORES: [80, 60, 40, 20],

  // 🎬 라운드 시작 전 "ROUND n 준비!" 연출 시간(초)
  READY_SEC: 2,

  // 📢 정답 공개 화면 유지 시간(초) → 이후 자동으로 다음 라운드
  REVEAL_SEC: 5,

  // ⚡ 모든 접속자가 답을 제출하면 60초를 기다리지 않고 바로 공개할지
  END_EARLY_WHEN_ALL_SUBMITTED: true,

  // ✨ 두배 찬스 라운드 (이 라운드에서만 두배 찬스 발동)
  DOUBLE_ROUNDS: [5, 7, 9, 12],
  //    1등 점수의 절반 "미만"인 플레이어가 대상  (예: 1등 100점 → 50점 미만)
  //    대상자가 맞히면 그 라운드 획득 점수 × DOUBLE_MULTIPLIER
  DOUBLE_MULTIPLIER: 2,

  // 🏠 퀴즈방 개수
  ROOM_COUNT: 10,

  // 🔑 퀴즈방 개설 비밀번호 (Render 환경변수 ADMIN_PASSWORD 로도 변경 가능)
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin09',

  // 🧹 모든 참가자가 접속을 끊은 방을 자동 삭제하기까지의 시간(분)
  EMPTY_ROOM_TTL_MIN: 30,
};

/* ===================================================================== */
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 20000,
  // 연결이 잠깐 끊겨도 상태를 복구하도록 (휴대폰 화면 꺼짐 대응)
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

/* ---------------- 퀴즈 준비 ---------------- */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_.,!?~'"`·:;()\[\]{}<>]/g, '');
}

function getQuizList(roomId) {
  const own = Array.isArray(QUIZZES[roomId]) ? QUIZZES[roomId] : [];
  const valid = own.filter((q) => q && q.answer && Array.isArray(q.hints) && q.hints.length);
  const list = [];
  for (let i = 0; i < CONFIG.TOTAL_ROUNDS; i++) {
    list.push(valid[i] || SAMPLE[i % SAMPLE.length]);
  }
  if (valid.length < CONFIG.TOTAL_ROUNDS) {
    console.warn(`⚠️  ${roomId}번 퀴즈방: 작성된 문제 ${valid.length}개 → 나머지는 예시 문제로 채움`);
  }
  return list;
}

/* ---------------- 방 관리 ---------------- */
const rooms = new Map(); // roomId(Number) -> room
const kickedNotice = new Map(); // 연결이 끊긴 채 내보내진 플레이어에게 재접속 시 알려주기용

function createRoom(id) {
  return {
    id,
    phase: 'waiting', // waiting | ready | playing | reveal | finished
    hostId: null,
    players: [], // { id, name, slot, score, connected, socketId, lastSeen }
    round: 0,
    quizList: getQuizList(id),
    quiz: null,
    readyEndsAt: 0,
    roundStartAt: 0,
    endsAt: 0,
    revealEndsAt: 0,
    hintCount: 0,
    answers: {}, // playerId -> { text, at, correct, rank, gained }
    doubleIds: [], // 이번 라운드 두배 찬스 대상 playerId 목록
    banned: new Set(), // 방장이 내보낸 플레이어 (이 방에 다시 못 들어옴)
    timer: null,
  };
}

function findPlayerRoom(playerId) {
  for (const room of rooms.values()) {
    const p = room.players.find((x) => x.id === playerId);
    if (p) return { room, player: p };
  }
  return null;
}

function roomSummary() {
  const list = [];
  for (let i = 1; i <= CONFIG.ROOM_COUNT; i++) {
    const r = rooms.get(i);
    list.push(
      r
        ? {
            id: i,
            open: true,
            phase: r.phase,
            count: r.players.length,
            max: CONFIG.MAX_PLAYERS,
            round: r.round,
            names: r.players.map((p) => p.name),
          }
        : { id: i, open: false }
    );
  }
  return list;
}

function broadcastRooms() {
  io.emit('rooms', roomSummary());
}

function visibleHintCount(room, now = Date.now()) {
  if (!room.quiz) return 0;
  const total = Math.min(CONFIG.MAX_HINTS, room.quiz.hints.length);
  if (room.phase === 'reveal' || room.phase === 'finished') return total;
  if (room.phase !== 'playing') return 0;
  const n = Math.floor((now - room.roundStartAt) / (CONFIG.HINT_INTERVAL_SEC * 1000)) + 1;
  return Math.max(0, Math.min(total, n));
}

function stateFor(room, viewerId) {
  const reveal = room.phase === 'reveal' || room.phase === 'finished';
  const q = room.quiz;
  return {
    roomId: room.id,
    me: viewerId,
    phase: room.phase,
    hostId: room.hostId,
    round: room.round,
    totalRounds: CONFIG.TOTAL_ROUNDS,
    serverNow: Date.now(),
    readyEndsAt: room.readyEndsAt,
    endsAt: room.endsAt,
    revealEndsAt: room.revealEndsAt,
    topic: q ? q.topic : '',
    length: q ? [...String(q.answer).replace(/\s/g, '')].length : 0,
    hints: q ? q.hints.slice(0, visibleHintCount(room)) : [],
    answer: reveal && q ? q.answer : null,
    doubleRound: room.doubleIds.length > 0,
    config: {
      hintInterval: CONFIG.HINT_INTERVAL_SEC,
      maxHints: CONFIG.MAX_HINTS,
      roundTime: CONFIG.ROUND_TIME_SEC,
      maxPlayers: CONFIG.MAX_PLAYERS,
    },
    players: room.players.map((p) => {
      const a = room.answers[p.id];
      const showText = reveal || p.id === viewerId;
      return {
        id: p.id,
        name: p.name,
        slot: p.slot,
        score: p.score,
        connected: p.connected,
        submitted: !!a,
        answer: showText && a ? a.text : null,
        correct: reveal ? !!(a && a.correct) : null,
        gained: reveal ? (a ? a.gained : 0) : null,
        rank: reveal && a && a.correct ? a.rank : null,
        double: room.doubleIds.includes(p.id),
      };
    }),
  };
}

function broadcastState(room) {
  for (const p of room.players) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', stateFor(room, p.id));
  }
}

/* ---------------- 게임 진행 ---------------- */
function startTicker(room) {
  if (room.timer) return;
  room.timer = setInterval(() => tick(room), 200);
}
function stopTicker(room) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
}

function tick(room) {
  const now = Date.now();
  if (room.phase === 'ready' && now >= room.readyEndsAt) {
    startPlaying(room);
  } else if (room.phase === 'playing') {
    const c = visibleHintCount(room, now);
    if (c !== room.hintCount) {
      room.hintCount = c;
      broadcastState(room);
    }
    if (now >= room.endsAt) doReveal(room);
  } else if (room.phase === 'reveal' && now >= room.revealEndsAt) {
    if (room.round >= CONFIG.TOTAL_ROUNDS) finishGame(room);
    else startRound(room);
  }
}

function startRound(room) {
  room.round += 1;
  room.quiz = room.quizList[room.round - 1];
  room.answers = {};
  room.hintCount = 0;
  room.doubleIds = pickDoublePlayers(room);
  room.phase = 'ready';
  room.readyEndsAt = Date.now() + CONFIG.READY_SEC * 1000;
  startTicker(room);
  broadcastState(room);
  broadcastRooms();
}

// ✨ 두배 찬스 대상 고르기 : 지정 라운드 + (점수 × 2 < 1등 점수)
function pickDoublePlayers(room) {
  if (!CONFIG.DOUBLE_ROUNDS.includes(room.round)) return [];
  const top = Math.max(0, ...room.players.map((p) => p.score));
  if (top <= 0) return [];
  return room.players.filter((p) => p.score * 2 < top).map((p) => p.id);
}

function startPlaying(room) {
  const now = Date.now();
  room.phase = 'playing';
  room.roundStartAt = now;
  room.endsAt = now + CONFIG.ROUND_TIME_SEC * 1000;
  room.hintCount = visibleHintCount(room, now);
  broadcastState(room);
}

function doReveal(room) {
  if (room.phase !== 'playing') return;
  room.phase = 'reveal';
  for (const p of room.players) {
    const a = room.answers[p.id];
    if (a && a.correct) p.score += a.gained;
  }
  room.revealEndsAt = Date.now() + CONFIG.REVEAL_SEC * 1000;
  broadcastState(room);
}

function finishGame(room) {
  room.phase = 'finished';
  stopTicker(room);
  broadcastState(room);
  broadcastRooms();
}

function checkAllSubmitted(room) {
  if (!CONFIG.END_EARLY_WHEN_ALL_SUBMITTED || room.phase !== 'playing') return;
  const active = room.players.filter((p) => p.connected);
  if (active.length && active.every((p) => room.answers[p.id])) doReveal(room);
}

function freeSlot(room) {
  for (let s = 0; s < CONFIG.MAX_PLAYERS; s++) {
    if (!room.players.some((p) => p.slot === s)) return s;
  }
  return -1;
}

function removePlayer(room, playerId) {
  room.players = room.players.filter((p) => p.id !== playerId);
  delete room.answers[playerId];
  room.doubleIds = room.doubleIds.filter((id) => id !== playerId);
  if (room.players.length === 0) {
    stopTicker(room);
    rooms.delete(room.id);
  } else {
    if (room.hostId === playerId) room.hostId = room.players[0].id;
    checkAllSubmitted(room);
    broadcastState(room);
  }
  broadcastRooms();
}

function cleanName(name) {
  const n = String(name || '').trim().slice(0, 8);
  return n || '마법사' + Math.floor(Math.random() * 90 + 10);
}

/* ---------------- 소켓 이벤트 ---------------- */
io.on('connection', (socket) => {
  // 접속(또는 재접속) 시 클라이언트가 자신의 playerId 를 알려줌
  socket.on('hello', ({ playerId } = {}, ack) => {
    if (!playerId) return ack && ack({ ok: false });
    socket.data.playerId = playerId;
    const found = findPlayerRoom(playerId);
    if (found) {
      const { room, player } = found;
      player.socketId = socket.id;
      player.connected = true;
      player.lastSeen = Date.now();
      socket.join('room-' + room.id);
      broadcastState(room);
      ack && ack({ ok: true, inRoom: room.id });
    } else {
      const kickedFrom = kickedNotice.get(playerId);
      kickedNotice.delete(playerId);
      ack && ack({ ok: true, inRoom: null, kickedFrom: kickedFrom || null });
    }
    socket.emit('rooms', roomSummary());
  });

  socket.on('getRooms', () => socket.emit('rooms', roomSummary()));

  // 방 개설 (비밀번호 필요)
  socket.on('createRoom', ({ roomId, password, name } = {}, ack = () => {}) => {
    const playerId = socket.data.playerId;
    roomId = Number(roomId);
    if (!playerId) return ack({ ok: false, msg: '접속 정보가 없어요. 새로고침 해주세요.' });
    if (!(roomId >= 1 && roomId <= CONFIG.ROOM_COUNT)) return ack({ ok: false, msg: '잘못된 방 번호예요.' });
    if (password !== CONFIG.ADMIN_PASSWORD) return ack({ ok: false, msg: '비밀번호가 틀렸어요!' });
    if (rooms.has(roomId)) return ack({ ok: false, msg: '이미 개설된 방이에요.' });

    const prev = findPlayerRoom(playerId);
    if (prev) removePlayer(prev.room, playerId);

    const room = createRoom(roomId);
    rooms.set(roomId, room);
    room.hostId = playerId;
    room.players.push({
      id: playerId, name: cleanName(name), slot: 0, score: 0,
      connected: true, socketId: socket.id, lastSeen: Date.now(),
    });
    socket.join('room-' + roomId);
    ack({ ok: true });
    broadcastState(room);
    broadcastRooms();
  });

  // 방 입장
  socket.on('joinRoom', ({ roomId, name } = {}, ack = () => {}) => {
    const playerId = socket.data.playerId;
    roomId = Number(roomId);
    const room = rooms.get(roomId);
    if (!playerId) return ack({ ok: false, msg: '접속 정보가 없어요. 새로고침 해주세요.' });
    if (!room) return ack({ ok: false, msg: '아직 개설되지 않은 방이에요.' });

    const existing = room.players.find((p) => p.id === playerId);
    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;
      socket.join('room-' + roomId);
      ack({ ok: true });
      return broadcastState(room);
    }
    if (room.banned.has(playerId)) return ack({ ok: false, msg: '방장이 내보낸 방에는 다시 들어갈 수 없어요.' });
    if (room.phase !== 'waiting') return ack({ ok: false, msg: '이미 게임이 진행 중인 방이에요.' });
    const slot = freeSlot(room);
    if (slot < 0) return ack({ ok: false, msg: `방이 가득 찼어요! (최대 ${CONFIG.MAX_PLAYERS}명)` });

    const prev = findPlayerRoom(playerId);
    if (prev) removePlayer(prev.room, playerId);

    room.players.push({
      id: playerId, name: cleanName(name), slot, score: 0,
      connected: true, socketId: socket.id, lastSeen: Date.now(),
    });
    room.players.sort((a, b) => a.slot - b.slot);
    socket.join('room-' + roomId);
    ack({ ok: true });
    broadcastState(room);
    broadcastRooms();
  });

  // 게임 시작 (방장만)
  socket.on('startGame', (_d, ack = () => {}) => {
    const found = findPlayerRoom(socket.data.playerId);
    if (!found) return ack({ ok: false });
    const { room } = found;
    if (room.hostId !== socket.data.playerId) return ack({ ok: false, msg: '방장만 시작할 수 있어요.' });
    if (room.phase !== 'waiting') return ack({ ok: false });
    room.round = 0;
    room.players.forEach((p) => (p.score = 0));
    ack({ ok: true });
    startRound(room);
  });

  // 정답 제출 (라운드당 1번)
  socket.on('submit', ({ text } = {}, ack = () => {}) => {
    const found = findPlayerRoom(socket.data.playerId);
    if (!found) return ack({ ok: false });
    const { room, player } = found;
    if (room.phase !== 'playing') return ack({ ok: false, msg: '지금은 제출할 수 없어요.' });
    if (room.answers[player.id]) return ack({ ok: false, msg: '이미 제출했어요!' });
    const t = String(text || '').trim().slice(0, 30);
    if (!t) return ack({ ok: false, msg: '답을 입력해주세요.' });

    const q = room.quiz;
    const accepted = [q.answer, ...(q.alias || [])].map(normalize);
    const correct = accepted.includes(normalize(t));
    let rank = null;
    let gained = 0;
    if (correct) {
      rank = Object.values(room.answers).filter((a) => a.correct).length + 1;
      gained = CONFIG.SCORES[rank - 1] || 0;
      if (room.doubleIds.includes(player.id)) gained *= CONFIG.DOUBLE_MULTIPLIER; // ✨ 두배 찬스
    }
    room.answers[player.id] = { text: t, at: Date.now(), correct, rank, gained };
    ack({ ok: true });
    broadcastState(room);
    checkAllSubmitted(room);
  });

  // 다시 하기 (게임 종료 후 방장)
  socket.on('restart', (_d, ack = () => {}) => {
    const found = findPlayerRoom(socket.data.playerId);
    if (!found) return ack({ ok: false });
    const { room } = found;
    if (room.hostId !== socket.data.playerId) return ack({ ok: false, msg: '방장만 할 수 있어요.' });
    if (room.phase !== 'finished') return ack({ ok: false });
    room.phase = 'waiting';
    room.round = 0;
    room.quiz = null;
    room.answers = {};
    room.doubleIds = [];
    room.quizList = getQuizList(room.id);
    room.players.forEach((p) => (p.score = 0));
    ack({ ok: true });
    broadcastState(room);
    broadcastRooms();
  });

  // 👢 플레이어 내보내기 (방장만, 언제든 가능)
  socket.on('kick', ({ targetId } = {}, ack = () => {}) => {
    const found = findPlayerRoom(socket.data.playerId);
    if (!found) return ack({ ok: false });
    const { room } = found;
    if (room.hostId !== socket.data.playerId) return ack({ ok: false, msg: '방장만 내보낼 수 있어요.' });
    if (targetId === socket.data.playerId) return ack({ ok: false, msg: '자기 자신은 내보낼 수 없어요.' });
    const target = room.players.find((p) => p.id === targetId);
    if (!target) return ack({ ok: false, msg: '이미 나간 플레이어예요.' });
    room.banned.add(target.id);
    if (target.connected && target.socketId) {
      io.to(target.socketId).emit('kicked', { roomId: room.id });
      const ts = io.sockets.sockets.get(target.socketId);
      if (ts) ts.leave('room-' + room.id);
    } else {
      kickedNotice.set(target.id, room.id);
    }
    removePlayer(room, target.id);
    ack({ ok: true, name: target.name });
  });

  // 방 나가기
  socket.on('leave', (_d, ack = () => {}) => {
    const found = findPlayerRoom(socket.data.playerId);
    if (found) {
      socket.leave('room-' + found.room.id);
      removePlayer(found.room, socket.data.playerId);
    }
    ack({ ok: true });
    socket.emit('rooms', roomSummary());
  });

  // 방 닫기 (방장)
  socket.on('closeRoom', (_d, ack = () => {}) => {
    const found = findPlayerRoom(socket.data.playerId);
    if (!found) return ack({ ok: false });
    const { room } = found;
    if (room.hostId !== socket.data.playerId) return ack({ ok: false, msg: '방장만 닫을 수 있어요.' });
    stopTicker(room);
    for (const p of room.players) {
      if (p.socketId) io.to(p.socketId).emit('roomClosed', { roomId: room.id });
    }
    rooms.delete(room.id);
    ack({ ok: true });
    broadcastRooms();
  });

  socket.on('disconnect', () => {
    const found = findPlayerRoom(socket.data.playerId);
    if (!found) return;
    const { room, player } = found;
    if (player.socketId !== socket.id) return; // 이미 새 소켓으로 재접속함
    player.connected = false;
    player.lastSeen = Date.now();
    broadcastState(room);
    checkAllSubmitted(room);
  });
});

// 모든 참가자가 오래 접속하지 않은 방 자동 정리
setInterval(() => {
  const ttl = CONFIG.EMPTY_ROOM_TTL_MIN * 60 * 1000;
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (room.players.every((p) => !p.connected && now - p.lastSeen > ttl)) {
      stopTicker(room);
      rooms.delete(room.id);
      console.log(`🧹 ${room.id}번 방 자동 삭제`);
      broadcastRooms();
    }
  }
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🔮 연상퀴즈 서버 실행 중 : http://localhost:${PORT}`);
  for (let i = 1; i <= CONFIG.ROOM_COUNT; i++) getQuizList(i);
});
