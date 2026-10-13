const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

const MIN_PLAYERS = 4;
const MAX_CLUES = 2;
const rooms = {};

function makeCode() {
  let code;
  do { code = Math.random().toString(36).substring(2, 7).toUpperCase(); } while (rooms[code]);
  return code;
}
const clean = (s, max) => String(s || '').trim().slice(0, max);
const active = (room) => room.players.filter((p) => p.connected);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// What each player is allowed to see (roles stay secret until results)
function viewFor(room, name) {
  const v = {
    code: room.code, host: room.host, state: room.state,
    players: room.players.map((p) => ({ name: p.name, connected: p.connected })),
    messages: room.messages.slice(-100),
    me: name, clue: room.clues[room.clues.length - 1] || '',
    clueCount: room.clues.length, maxClues: MAX_CLUES,
    readyCount: Object.keys(room.ready).filter((n) => room.ready[n]).length,
    activeCount: active(room).length, myReady: !!room.ready[name],
    voteCount: Object.keys(room.votes).length, myVote: room.votes[name] || null,
    minPlayers: MIN_PLAYERS,
  };
  if (room.state === 'game' || room.state === 'voting') {
    v.role = name === room.speaker ? 'speaker' : name === room.khawi ? 'khawi'
      : name === room.impostor ? 'impostor' : 'guesser';
    if (v.role === 'speaker') v.khawi = room.khawi;
  }
  if (room.state === 'results') {
    v.reveal = { speaker: room.speaker, impostor: room.impostor, khawi: room.khawi };
    v.finalScores = room.finalScores;
  }
  return v;
}

function broadcast(room) {
  room.players.forEach((p) => {
    if (p.connected && p.socketId) io.to(p.socketId).emit('room', viewFor(room, p.name));
  });
}

function sys(room, text) { room.messages.push({ sender: '__system__', text }); }

function reassignHost(room) {
  const cur = room.players.find((p) => p.name === room.host);
  if (!cur || !cur.connected) {
    const next = active(room)[0];
    if (next) room.host = next.name;
  }
}

function calculateScores(room) {
  const scores = {};
  room.players.forEach((p) => { scores[p.name] = 0; });
  const { speaker, impostor } = room;
  scores[speaker] += room.players.filter((p) => p.name !== speaker).length;
  room.players.forEach((p) => {
    if (p.name === speaker) return;
    const votedFor = room.votes[p.name];
    if (votedFor === speaker) scores[p.name] += 2;
    if (votedFor === impostor) scores[impostor] += 1;
  });
  room.finalScores = scores;
  room.state = 'results';
}

function checkProgress(room) {
  const act = active(room);
  if (room.state === 'game' && act.length >= MIN_PLAYERS &&
      act.every((p) => room.ready[p.name])) {
    room.state = 'voting';
    room.ready = {};
  } else if (room.state === 'voting' && act.length > 0 &&
             act.every((p) => room.votes[p.name])) {
    calculateScores(room);
  }
}

function removeFromRoom(socket) {
  const { code, name } = socket.data;
  const room = rooms[code];
  socket.data.code = null; socket.data.name = null;
  if (!room) return;
  socket.leave(code);
  if (room.state === 'lobby' || room.state === 'results') {
    room.players = room.players.filter((p) => p.name !== name);
  } else {
    const p = room.players.find((x) => x.name === name);
    if (p) { p.connected = false; p.socketId = null; }
  }
  reassignHost(room);
  if (active(room).length === 0) {
    setTimeout(() => { if (rooms[code] && active(rooms[code]).length === 0) delete rooms[code]; }, 10 * 60 * 1000);
    return;
  }
  checkProgress(room);
  broadcast(room);
}

io.on('connection', (socket) => {
  socket.data = { code: null, name: null };

  socket.on('createRoom', ({ name }, cb) => {
    name = clean(name, 20);
    if (!name) return cb && cb({ error: 'name' });
    const code = makeCode();
    rooms[code] = {
      code, host: name, state: 'lobby',
      players: [{ name, socketId: socket.id, connected: true }],
      speaker: '', impostor: '', khawi: '', clues: [], votes: {}, ready: {},
      messages: [], finalScores: null,
    };
    socket.join(code);
    socket.data = { code, name };
    cb && cb({ ok: true });
    broadcast(rooms[code]);
  });

  socket.on('joinRoom', ({ name, code }, cb) => {
    name = clean(name, 20); code = clean(code, 10).toUpperCase();
    if (!name) return cb && cb({ error: 'name' });
    const room = rooms[code];
    if (!room) return cb && cb({ error: 'notfound' });
    let p = room.players.find((x) => x.name === name);
    if (p && p.connected && p.socketId !== socket.id) return cb && cb({ error: 'taken' });
    if (!p) {
      if (room.state !== 'lobby') return cb && cb({ error: 'started' });
      p = { name, connected: true, socketId: socket.id };
      room.players.push(p);
    } else { p.connected = true; p.socketId = socket.id; }
    socket.join(code);
    socket.data = { code, name };
    reassignHost(room);
    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on('leaveRoom', () => removeFromRoom(socket));

  socket.on('startGame', () => {
    const room = rooms[socket.data.code];
    if (!room || room.host !== socket.data.name) return;
    if (room.state !== 'lobby' && room.state !== 'results') return;
    const act = active(room);
    if (act.length < MIN_PLAYERS) return socket.emit('toast', 'minPlayers');
    room.players = act;
    const names = act.map((p) => p.name);
    room.speaker = pick(names);
    room.impostor = pick(names.filter((n) => n !== room.speaker));
    room.khawi = pick(names.filter((n) => n !== room.speaker && n !== room.impostor));
    room.state = 'game'; room.clues = []; room.votes = {}; room.ready = {}; room.finalScores = null;
    broadcast(room);
  });

  socket.on('submitClue', (text) => {
    const room = rooms[socket.data.code];
    if (!room || room.state !== 'game' || socket.data.name !== room.speaker) return;
    text = clean(text, 100);
    if (!text || room.clues.length >= MAX_CLUES) return;
    room.clues.push(text);
    sys(room, JSON.stringify({ k: 'clue', who: room.speaker, text }));
    broadcast(room);
  });

  socket.on('chat', (text) => {
    const room = rooms[socket.data.code];
    text = clean(text, 300);
    if (!room || !text) return;
    room.messages.push({ sender: socket.data.name, text });
    if (room.messages.length > 200) room.messages.shift();
    broadcast(room);
  });

  socket.on('toggleReady', () => {
    const room = rooms[socket.data.code];
    if (!room || room.state !== 'game') return;
    room.ready[socket.data.name] = !room.ready[socket.data.name];
    checkProgress(room);
    broadcast(room);
  });

  socket.on('vote', (target) => {
    const room = rooms[socket.data.code];
    const me = socket.data.name;
    if (!room || room.state !== 'voting' || target === me) return;
    if (!room.players.some((p) => p.name === target)) return;
    room.votes[me] = target;
    checkProgress(room);
    broadcast(room);
  });

  socket.on('resetGame', () => {
    const room = rooms[socket.data.code];
    if (!room || room.host !== socket.data.name || room.state !== 'results') return;
    room.state = 'lobby'; room.clues = []; room.votes = {}; room.ready = {};
    room.finalScores = null; room.speaker = room.impostor = room.khawi = '';
    broadcast(room);
  });

  socket.on('disconnect', () => removeFromRoom(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
