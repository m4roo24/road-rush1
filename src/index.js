
export class RaceRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.players = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "road-rush-multiplayer"
      });
    }

    if (url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();

    const id = crypto.randomUUID();
    this.players.set(id, server);

    server.send(JSON.stringify({
      type: "welcome",
      id,
      players: this.players.size
    }));

    server.addEventListener("message", event => {
      let data;

      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      const message = JSON.stringify({
        ...data,
        playerId: id
      });

      for (const [playerId, socket] of this.players) {
        if (playerId !== id) {
          try {
            socket.send(message);
          } catch {
            this.players.delete(playerId);
          }
        }
      }
    });

    const remove = () => this.players.delete(id);
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
        rooms: "ready"
      });
    }

    const room = url.searchParams.get("room");

    if (!room || !/^[A-Za-z0-9_-]{1,32}$/.test(room)) {
      return Response.json(
        { error: "Provide a valid room code in ?room=CODE" },
        { status: 400 }
      );
    }

    const id = env.RACE_ROOMS.idFromName(room);
    const stub = env.RACE_ROOMS.get(id);

    return stub.fetch(request);
  }
};
