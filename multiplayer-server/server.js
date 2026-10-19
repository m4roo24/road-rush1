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
const MAX_PLAYERS_PER_ROOM = 8;
const COLORS = ['#42d9ff', '#ffce43', '#ff5c91', '#79f2a4', '#b18cff', '#ff8a42', '#f0f2ff'];
function cleanName(v) { return (typeof v === 'string' ? v : 'Driver').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18) || 'Driver'; }
function cleanRoom(v) { return (typeof v === 'string' ? v : '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
function newRoomCode() {
  let code;
  do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
  return code;
}
function publicPlayer(socket) {
  const p = socket.data.player;
  return { id: socket.id, username: p.username, lane: p.lane, km: p.km, speed: p.speed, running: p.running, color: p.color };
}
function broadcastPlayers(code) {
  const room = rooms.get(code); if (!room) return;
  io.to(code).emit('race:players', { roomCode: code, players: [...room.players].map(id => io.sockets.sockets.get(id)).filter(Boolean).map(publicPlayer) });
}
function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code); socket.data.roomCode = '';
  if (room) {
    room.players.delete(socket.id);
    if (!room.players.size) rooms.delete(code); else broadcastPlayers(code);
  }
}
app.disable('x-powered-by');
app.get('/', (_req, res) => res.status(200).type('text').send('Road Rush multiplayer server is running. Socket.IO endpoint is ready.'));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'road-rush-multiplayer', rooms: rooms.size, players: io.engine.clientsCount }));
app.get('/api/rooms/:code', (req, res) => {
  const code = cleanRoom(req.params.code), room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  return res.json({ roomCode: code, players: room.players.size, capacity: MAX_PLAYERS_PER_ROOM });
});

io.on('connection', socket => {
  socket.data.roomCode = '';
  socket.data.lastUpdate = 0;
  socket.data.player = { username: 'Driver', lane: 1, km: 0, speed: 0, running: false, color: COLORS[0] };

  socket.on('race:join', payload => {
    if (socket.data.roomCode) leaveRoom(socket);
    let code = cleanRoom(payload?.roomCode);
    if (!code) {
      if (rooms.size >= MAX_ROOMS) return socket.emit('race:error', { message: 'The server is full. Try again later.' });
      code = newRoomCode();
    } else if (!rooms.has(code)) {
      return socket.emit('race:error', { message: 'That room code does not exist. Ask your friend to create the room first.' });
    }
    let room = rooms.get(code);
    if (!room) { room = { players: new Set(), createdAt: Date.now() }; rooms.set(code, room); }
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) return socket.emit('race:error', { message: 'That room is full (maximum 8 drivers).' });
    socket.data.roomCode = code;
    socket.data.player.username = cleanName(payload?.username);
    socket.data.player.color = COLORS[room.players.size % COLORS.length];
    room.players.add(socket.id);
    socket.join(code);
    socket.emit('race:joined', { roomCode: code, players: [...room.players].map(id => io.sockets.sockets.get(id)).filter(Boolean).map(publicPlayer) });
    broadcastPlayers(code);
  });

  socket.on('race:update', payload => {
    const code = socket.data.roomCode;
    if (!code || !rooms.has(code) || !payload || typeof payload !== 'object') return;
    const now = Date.now();
    if (now - socket.data.lastUpdate < 70) return;
    socket.data.lastUpdate = now;
    const p = socket.data.player;
    const lane = Number(payload.lane), km = Number(payload.km), speed = Number(payload.speed);
    p.lane = Number.isFinite(lane) ? Math.max(0, Math.min(4, Math.floor(lane))) : p.lane;
    p.km = Number.isFinite(km) ? Math.max(0, Math.min(100000, km)) : p.km;
    p.speed = Number.isFinite(speed) ? Math.max(0, Math.min(500, speed)) : p.speed;
    p.running = payload.running === true;
    if (typeof payload.color === 'string' && /^#[0-9a-f]{6}$/i.test(payload.color)) p.color = payload.color;
    socket.to(code).emit('race:state', publicPlayer(socket));
  });

  socket.on('race:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, '0.0.0.0', () => console.log(`Road Rush multiplayer listening on ${PORT}`));
