export class RaceRoom {
constructor(ctx, env) {
this.ctx = ctx;
this.env = env;
this.players = new Map();
this.sockets = new Set();
}

async fetch(request) {
if (request.headers.get("Upgrade") !== "websocket") {
return Response.json({
ok: true,
service: "road-rush-multiplayer",
protocol: "websocket"
});
}

const pair = new WebSocketPair();
const client = pair[0];
const server = pair[1];
server.accept();

const id = crypto.randomUUID();
const player = {
  id,
  username: "Driver",
  lane: 1,
  km: 0,
  speed: 0,
  running: false,
  color: "#42d9ff"
};

this.players.set(id, player);
this.sockets.add(server);

const send = (socket, data) => {
  try {
    socket.send(JSON.stringify(data));
  } catch {}
};

const broadcast = (data, exceptId = null) => {
  for (const [socketId, socket] of this.sockets.entries()) {
    if (socketId !== exceptId) send(socket, data);
  }
};

send(server, {
  type: "welcome",
  id,
  players: Array.from(this.players.values())
});

broadcast({
  type: "players",
  players: Array.from(this.players.values())
}, id);

server.addEventListener("message", event => {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }

  const current = this.players.get(id);
  if (!current) return;

  if (data.type === "join") {
    current.username = String(data.username || "Driver").slice(0, 18);
  } else if (data.type === "update") {
    current.lane = Number(data.lane) || 0;
    current.km = Math.max(0, Number(data.km) || 0);
    current.speed = Math.max(0, Number(data.speed) || 0);
    current.running = !!data.running;
    current.color = String(data.color || "#42d9ff");
  } else if (data.type === "leave") {
    try { server.close(); } catch {}
    return;
  } else {
    return;
  }

  broadcast({
    type: "state",
    player: current
  }, id);

  broadcast({
    type: "players",
    players: Array.from(this.players.values())
  });
});

const remove = () => {
  this.players.delete(id);
  this.sockets.delete(server);
  broadcast({
    type: "players",
    players: Array.from(this.players.values())
  });
};

server.addEventListener("close", remove);
server.addEventListener("error", remove);

return new Response(null, {
  status: 101,
  webSocket: client
});

}
}

export default {
async fetch(request, env) {
const url = new URL(request.url);

if (url.pathname === "/health") {
  return Response.json({
    ok: true,
    service: "road-rush-multiplayer",
    protocol: "websocket"
  });
}

const room = url.searchParams.get("room");

if (!room || !/^[A-Za-z0-9_-]{1,32}$/.test(room)) {
  return Response.json({
    error: "Add a room code, for example ?room=RACE123"
  }, { status: 400 });
}

const id = env.RACE_ROOMS.idFromName(room);
return env.RACE_ROOMS.get(id).fetch(request);

}
};
