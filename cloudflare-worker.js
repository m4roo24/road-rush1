const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (url.pathname === "/health") return Response.json({ ok: true, service: "road-rush-cloudflare-multiplayer" }, { headers: corsHeaders });
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
      let code = (url.searchParams.get("roomCode") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
      const create = url.searchParams.get("create") === "1";
      if (!code && create) code = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
      if (!code) return new Response("Room code required", { status: 400 });
      const id = env.RACE_ROOMS.idFromName(code);
      const stub = env.RACE_ROOMS.get(id);
      const next = new URL(request.url);
      next.searchParams.set("roomCode", code);
      next.searchParams.set("create", create ? "1" : "0");
      return stub.fetch(new Request(next.toString(), request));
    }
    return new Response("Road Rush Cloudflare multiplayer is ready. Use /health or /ws.", { headers: { ...corsHeaders, "Content-Type": "text/plain" } });
  }
};

export class RaceRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.players = new Map();
    this.sockets = new Set();
    this.started = false;
    this.settled = false;
    this.roomCode = "";
  }
  send(ws, event, data) {
    try { ws.send(JSON.stringify({ event, data })); } catch {}
  }
  broadcast(event, data) {
    for (const ws of this.ctx.getWebSockets()) this.send(ws, event, data);
  }
  playerList() {
    return [...this.sockets].filter(ws => ws.readyState === 1).map(ws => {
      const a = ws._rr || {};
      const p = this.players.get(a.id) || a.player || {};
      return { id: a.id, username: p.username || "Driver", lane: p.lane || 1, km: p.km || 0, speed: p.speed || 0, running: !!p.running, lost: !!p.lost, color: p.color || "#42d9ff" };
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    const roomCode = url.searchParams.get("roomCode") || "";
    const create = url.searchParams.get("create") === "1";
    const existing = [...this.sockets].filter(ws => ws.readyState === 1);
    if (existing.length === 0 && !create) return new Response("Room not found. Ask the host to create it first.", { status: 404 });
    if (existing.length === 0 && create) this.roomCode = roomCode;
    if (this.settled || existing.length >= 2) return new Response("This room is full or already finished.", { status: 409 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    const id = crypto.randomUUID();
    const username = (url.searchParams.get("username") || "Driver").replace(/[<>\\u0000-\\u001f]/g, "").slice(0, 18) || "Driver";
    const wallet = Math.max(0, Math.min(1e9, Math.floor(Number(url.searchParams.get("wallet")) || 0)));
    const player = { username, lane: 1, km: 0, speed: 0, running: false, lost: false, wallet, color: existing.length ? "#ffce43" : "#42d9ff" };
    server.accept();
    server._rr = { id, player };
    this.sockets.add(server);
    this.players.set(id, player);
    server.addEventListener("message", event => this.webSocketMessage(server, event.data));
    server.addEventListener("close", () => this.webSocketClose(server));
    server.addEventListener("error", () => this.webSocketError(server));
    this.send(server, "race:joined", { roomCode, players: this.playerList() });
    this.broadcast("race:players", { roomCode, players: this.playerList() });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 12000) return;
    let packet;
    try { packet = JSON.parse(message); } catch { return; }
    const attachment = ws._rr || {};
    const id = attachment.id;
    const player = this.players.get(id);
    if (!player || !packet || typeof packet.event !== "string") return;
    if (packet.event === "race:update") {
      if (this.settled) return;
      const d = packet.data || {};
      player.lane = Number.isFinite(Number(d.lane)) ? Math.max(0, Math.min(4, Math.floor(Number(d.lane)))) : player.lane;
      player.km = Number.isFinite(Number(d.km)) ? Math.max(0, Math.min(100000, Number(d.km))) : player.km;
      player.speed = Number.isFinite(Number(d.speed)) ? Math.max(0, Math.min(500, Number(d.speed))) : player.speed;
      player.running = d.running === true;
      player.lost = d.lost === true;
      player.color = typeof d.color === "string" && /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : player.color;
      ws._rr = { id, player };
      const all = this.playerList();
      if (!this.started && all.length === 2 && all.every(p => p.running)) {
        this.started = true;
        this.broadcast("race:start", { roomCode: this.roomCode, players: all });
      }
      for (const other of this.ctx.getWebSockets()) if (other !== ws) this.send(other, "race:state", { ...player, id });
      if (this.started && player.lost && !player.running) {
        const winner = all.find(p => p.id !== id && p.running && !p.lost);
        if (winner) {
          this.settled = true;
          // Non-wagered fixed reward: loser keeps their balance; winner receives a fixed bonus.
          this.broadcast("race:result", { roomCode: this.roomCode, winnerId: winner.id, loserId: id, amount: 100, reason: "crash" });
        }
      }
      if (this.started && !this.settled && all.length === 2 && all.every(p => !p.running)) {
        this.settled = true;
        this.broadcast("race:result", { roomCode: this.roomCode, winnerId: "", loserId: "", amount: 0, reason: "draw" });
      }
    } else if (packet.event === "race:leave") {
      ws.close(1000, "Player left");
    }
  }
  async webSocketClose(ws) {
    const a = ws._rr || {};
    const id = a.id;
    this.players.delete(id);
    this.sockets.delete(ws);
    const others = [...this.sockets].filter(s => s.readyState === 1 && s !== ws);
    if (this.started && !this.settled && others.length === 1) {
      const winner = others[0]._rr || {};
      this.settled = true;
      this.send(others[0], "race:result", { roomCode: this.roomCode, winnerId: winner.id, loserId: id, amount: 100, reason: "opponent-disconnected" });
    }
    if (others.length) this.broadcast("race:players", { roomCode: this.roomCode, players: this.playerList() });
  }
  async webSocketError(ws) {
    try { ws.close(1011, "WebSocket error"); } catch {}
  }
}
