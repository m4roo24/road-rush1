'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '*').split(',').map(x => x.trim()).filter(Boolean);
const io = new Server(server, {
  cors: { origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Origin is not allowed by FRONTEND_ORIGIN'));
  }, methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 16_000
});
const rooms = new Map();
const MAX_ROOMS = 500;
const MAX_PLAYERS_PER_ROOM = 2;
const COLORS = ['#42d9ff', '#ffce43'];
function cleanName(v) { return (typeof v === 'string' ? v : 'Driver').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18) || 'Driver'; }
function cleanRoom(v) { return (typeof v === 'string' ? v : '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
function newRoomCode() { let code; do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code)); return code; }
function roomPlayers(room) { return [...room.players].map(id => io.sockets.sockets.get(id)).filter(Boolean); }
function publicPlayer(socket) {
  const p = socket.data.player;
  return { id: socket.id, username: p.username, lane: p.lane, km: p.km, speed: p.speed, running: p.running, lost: p.lost, color: p.color };
}
function broadcastPlayers(code) {
  const room = rooms.get(code); if (!room) return;
  io.to(code).emit('race:players', { roomCode: code, players: roomPlayers(room).map(publicPlayer) });
}
function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code); socket.data.roomCode = '';
  if (room) {
    // If a match was underway and one driver disconnects, the remaining driver wins.
    if (room.match.started && !room.match.settled && room.players.size === 2) {
      const otherId = [...room.players].find(id => id !== socket.id);
      const other = otherId && io.sockets.sockets.get(otherId);
      if (other) settleMatch(code, room, other, socket.data.player.wallet || 0, 'opponent-disconnected');
    }
    room.players.delete(socket.id);
    if (!room.players.size) rooms.delete(code); else broadcastPlayers(code);
  }
}
function settleMatch(code, room, winner, loserWallet, reason) {
  if (!room || room.match.settled) return;
  room.match.settled = true;
  const amount = Math.max(0, Math.min(1e12, Math.floor(Number(loserWallet) || 0)));
  const result = { roomCode: code, winnerId: winner.id, loserId: [...room.players].find(id => id !== winner.id) || '', amount, reason };
  io.to(code).emit('race:result', result);
}
function safeWallet(v) { return Number.isFinite(Number(v)) ? Math.max(0, Math.min(1e12, Math.floor(Number(v)))) : 0; }

app.disable('x-powered-by');
app.get('/', (_req, res) => res.status(200).type('text').send('Road Rush multiplayer server is running. Socket.IO endpoint is ready.'));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'road-rush-multiplayer', rooms: rooms.size, players: io.engine.clientsCount }));
app.get('/api/rooms/:code', (req, res) => {
  const code = cleanRoom(req.params.code), room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  return res.json({ roomCode: code, players: room.players.size, capacity: MAX_PLAYERS_PER_ROOM, matchStarted: room.match.started, settled: room.match.settled });
});

io.on('connection', socket => {
  socket.data.roomCode = '';
  socket.data.lastUpdate = 0;
  socket.data.player = { username: 'Driver', lane: 1, km: 0, speed: 0, running: false, lost: false, wallet: 0, color: COLORS[0] };

  socket.on('race:join', payload => {
    if (socket.data.roomCode) leaveRoom(socket);
    let code = cleanRoom(payload?.roomCode);
    if (!code) code = newRoomCode();
    let room = rooms.get(code);
    if (!room && payload?.create === true) {
      if (rooms.size >= MAX_ROOMS) return socket.emit('race:error', { message: 'The server is full. Try again later.' });
      room = { players: new Set(), createdAt: Date.now(), match: { started: false, settled: false } };
      rooms.set(code, room);
    } else if (!room) {
      return socket.emit('race:error', { message: 'That room code does not exist. Ask your friend to create the room first.' });
    }
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) return socket.emit('race:error', { message: 'That race is full (maximum 2 drivers).' });
    if (room.match.started) return socket.emit('race:error', { message: 'This race has already started. Create a new room.' });
    socket.data.roomCode = code;
    socket.data.player = { username: cleanName(payload?.username), lane: 1, km: 0, speed: 0, running: false, lost: false, wallet: safeWallet(payload?.wallet), color: COLORS[room.players.size % COLORS.length] };
    room.players.add(socket.id);
    socket.join(code);
    socket.emit('race:joined', { roomCode: code, players: roomPlayers(room).map(publicPlayer), wallet: socket.data.player.wallet });
    broadcastPlayers(code);
  });

  socket.on('race:update', payload => {
    const code = socket.data.roomCode, room = rooms.get(code);
    if (!code || !room || !payload || typeof payload !== 'object' || room.match.settled) return;
    const now = Date.now();
    if (now - socket.data.lastUpdate < 70) return;
    socket.data.lastUpdate = now;
    const p = socket.data.player;
    const wasRunning = p.running;
    const lane = Number(payload.lane), km = Number(payload.km), speed = Number(payload.speed);
    p.lane = Number.isFinite(lane) ? Math.max(0, Math.min(4, Math.floor(lane))) : p.lane;
    p.km = Number.isFinite(km) ? Math.max(0, Math.min(100000, km)) : p.km;
    p.speed = Number.isFinite(speed) ? Math.max(0, Math.min(500, speed)) : p.speed;
    p.running = payload.running === true;
    p.lost = payload.lost === true;
    p.wallet = safeWallet(payload.wallet);
    if (typeof payload.color === 'string' && /^#[0-9a-f]{6}$/i.test(payload.color)) p.color = payload.color;
    const players = roomPlayers(room);
    if (!room.match.started && players.length === 2 && players.every(s => s.data.player.running)) {
      room.match.started = true;
      io.to(code).emit('race:start', { roomCode: code, players: players.map(publicPlayer) });
    }
    socket.to(code).emit('race:state', publicPlayer(socket));
    if (room.match.started && p.lost && !p.running) {
      const winner = players.find(s => s.id !== socket.id && s.data.player.running && !s.data.player.lost);
      if (winner) settleMatch(code, room, winner, p.wallet, 'crash');
    }
    if (room.match.started && !room.match.settled && players.length === 2 && players.every(s => !s.data.player.running)) {
      // Simultaneous stop without a clear crash is a draw; no coins move.
      room.match.settled = true;
      io.to(code).emit('race:result', { roomCode: code, winnerId: '', loserId: '', amount: 0, reason: 'draw' });
    }
  });

  socket.on('race:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
});
server.listen(PORT, '0.0.0.0', () => console.log(`Road Rush multiplayer listening on ${PORT}`));
