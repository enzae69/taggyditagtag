import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(join(__dirname, "public")));

const httpServer = createServer(app);
const io = new Server(httpServer);

// ---------------------------------------------------------------------------
// 3D world / gameplay constants (world units; the client uses Three.js)
// ---------------------------------------------------------------------------
const WORLD_HALF = 22;                 // arena is 44 x 44 on the ground (x,z)
const START_L = { x: 0, y: 0, z: -16 };
const START_R = { x: 0, y: 0, z: 16 };
const PIG_START = { x: 0, y: 1.2, z: 0 };

const TICK_MS = 1000 / 30;
const CARD_SPEED = 16;                 // units/sec along the drawn path
const CARD_REST_Y = 1.4;               // height the card floats at a player
const ARC_HEIGHT = 4;                  // how high the thrown card arcs
const PIG_BASE_SPEED = 3.2;            // pig speed at round start
const PIG_ACCEL = 0.95;                // extra units/sec added per second
const HIT_RADIUS = 1.7;                // pig <-> card catch distance
const BOT_SPEED = 6.8;                 // practice bot movement speed

const SERVER_NAMES = ["EU 1", "EU 2", "EU 3", "EU 4"];

/** @type {Map<string, {name:string, queue:string[], games:Map<string,Game>}>} */
const servers = new Map();
for (const name of SERVER_NAMES) {
  servers.set(name, { name, queue: [], games: new Map() });
}
// Hidden bucket for solo practice matches (1 human + 1 bot); not shown in lobby.
servers.set("PRACTISE", { name: "PRACTISE", queue: [], games: new Map() });

const isBot = (id) => typeof id === "string" && id.startsWith("BOT-");

function lobbyInfo() {
  return SERVER_NAMES.map((name) => {
    const s = servers.get(name);
    return { name, waiting: s.queue.length, players: s.queue.length + s.games.size * 2 };
  });
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// ---------------------------------------------------------------------------
// Game room: authoritative pig + card; players move client-side and report pos
// ---------------------------------------------------------------------------
class Game {
  constructor(serverName, players) {
    this.serverName = serverName;
    this.id = `${serverName}-${Date.now()}`;
    this.players = players;
    this.slots = {
      [players[0]]: { side: "left", start: START_L },
      [players[1]]: { side: "right", start: START_R },
    };
    // Last reported position of each player (client-authoritative movement).
    this.pos = {
      [players[0]]: { ...START_L },
      [players[1]]: { ...START_R },
    };

    this.pig = { ...PIG_START };
    this.pigSpeed = PIG_BASE_SPEED;
    this.roundStart = Date.now();

    this.card = {
      owner: players[0],
      pos: { x: START_L.x, y: CARD_REST_Y, z: START_L.z },
      inFlight: false,
      path: null,   // { pts:[{x,z}], cum:[], total }
      dist: 0,
    };

    this.over = false;
    this.lastTick = Date.now();

    // Practice-bot AI state.
    this.bots = players.filter(isBot);
    this.botAI = {};
    for (const id of this.bots) this.botAI[id] = { throwAt: 0 };

    for (const id of players) {
      const sock = io.sockets.sockets.get(id);
      if (sock) {
        sock.join(this.id);
        sock.emit("youAre", {
          side: this.slots[id].side,
          start: this.slots[id].start,
          owner: this.card.owner,
          world: WORLD_HALF,
        });
      }
    }

    this.loop = setInterval(() => this.tick(), TICK_MS);
  }

  broadcast(event, data) { io.to(this.id).emit(event, data); }
  otherPlayer(id) { return this.players[0] === id ? this.players[1] : this.players[0]; }

  setPos(id, p) {
    if (!this.pos[id]) return;
    this.pos[id] = {
      x: clamp(p.x, -WORLD_HALF, WORLD_HALF),
      y: clamp(p.y, 0, 12),
      z: clamp(p.z, -WORLD_HALF, WORLD_HALF),
    };
  }

  // A player throws with a curved path of ground points {x,z} plus a loft
  // factor (how high it arcs). Accepts either a bare points array or
  // { path, loft } for backward compatibility.
  throwCard(socketId, payload) {
    if (this.over || this.card.inFlight) return;
    if (this.card.owner !== socketId) return;
    let rawPts = payload, loft = 1;
    if (payload && !Array.isArray(payload)) {
      rawPts = payload.path;
      loft = clamp(Number(payload.loft) || 1, 0.4, 3);
    }
    if (!Array.isArray(rawPts) || rawPts.length < 2) return;

    // Start the path at the thrower, then follow the drawn ground points.
    const here = this.pos[socketId];
    const pts = [{ x: here.x, z: here.z }];
    for (const p of rawPts) {
      if (typeof p.x !== "number" || typeof p.z !== "number") continue;
      pts.push({ x: clamp(p.x, -WORLD_HALF, WORLD_HALF), z: clamp(p.z, -WORLD_HALF, WORLD_HALF) });
    }
    if (pts.length < 2) return;

    const cum = [0];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      cum.push(total);
    }
    if (total < 1) return;

    this.card.path = { pts, cum, total };
    this.card.loft = loft;
    this.card.dist = 0;
    this.card.inFlight = true;
    this.broadcast("thrown", { path: pts, owner: socketId });
  }

  cardPointAt(dist) {
    const { pts, cum, total } = this.card.path;
    const d = clamp(dist, 0, total);
    let i = 1;
    while (i < cum.length && cum[i] < d) i++;
    const segStart = cum[i - 1];
    const segLen = cum[i] - segStart || 1;
    const t = (d - segStart) / segLen;
    const a = pts[i - 1], b = pts[i];
    const frac = d / total;
    return {
      x: a.x + (b.x - a.x) * t,
      y: CARD_REST_Y + Math.sin(frac * Math.PI) * ARC_HEIGHT * (this.card.loft || 1),
      z: a.z + (b.z - a.z) * t,
    };
  }

  // Practice bot: flee the pig and throw the card away (dodging the pig).
  updateBots(dt, now) {
    for (const id of this.bots) {
      const p = this.pos[id];
      // run away from the pig, with a gentle pull toward the centre
      const ax = p.x - this.pig.x, az = p.z - this.pig.z;
      const al = Math.hypot(ax, az) || 1;
      let nx = p.x + (ax / al) * BOT_SPEED * dt - p.x * 0.05 * dt;
      let nz = p.z + (az / al) * BOT_SPEED * dt - p.z * 0.05 * dt;
      this.pos[id] = {
        x: clamp(nx, -WORLD_HALF, WORLD_HALF),
        y: 0,
        z: clamp(nz, -WORLD_HALF, WORLD_HALF),
      };

      if (this.card.owner === id && !this.card.inFlight) {
        const ai = this.botAI[id];
        if (!ai.throwAt) ai.throwAt = now + 450 + Math.random() * 650;
        if (now >= ai.throwAt) {
          ai.throwAt = 0;
          this.throwCard(id, this.botDodgePath(id));
        }
      } else {
        this.botAI[id].throwAt = 0;
      }
    }
  }

  // A curved path from the bot toward the other player, bowed away from the pig.
  botDodgePath(id) {
    const from = this.pos[id];
    const target = this.pos[this.otherPlayer(id)];
    const mid = { x: (from.x + target.x) / 2, z: (from.z + target.z) / 2 };
    let ax = mid.x - this.pig.x, az = mid.z - this.pig.z;
    const al = Math.hypot(ax, az) || 1;
    const control = {
      x: clamp(mid.x + (ax / al) * 9, -WORLD_HALF, WORLD_HALF),
      z: clamp(mid.z + (az / al) * 9, -WORLD_HALF, WORLD_HALF),
    };
    return [control, { x: target.x, z: target.z }];
  }

  tick() {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (this.over) return;

    if (this.bots.length) this.updateBots(dt, now);

    const elapsed = (now - this.roundStart) / 1000;
    this.pigSpeed = PIG_BASE_SPEED + PIG_ACCEL * elapsed;

    if (this.card.inFlight && this.card.path) {
      this.card.dist += CARD_SPEED * dt;
      if (this.card.dist >= this.card.path.total) {
        // Landed: possession passes to the other player.
        this.card.inFlight = false;
        this.card.path = null;
        this.card.owner = this.otherPlayer(this.card.owner);
      } else {
        this.card.pos = this.cardPointAt(this.card.dist);
      }
    }
    if (!this.card.inFlight) {
      const o = this.pos[this.card.owner];
      this.card.pos = { x: o.x, y: o.y + CARD_REST_Y, z: o.z };
    }

    // Pig chases the card in 3D and accelerates.
    const dx = this.card.pos.x - this.pig.x;
    const dy = this.card.pos.y - this.pig.y;
    const dz = this.card.pos.z - this.pig.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const step = this.pigSpeed * dt;
    this.pig.x += (dx / d) * step;
    this.pig.y += (dy / d) * step;
    this.pig.z += (dz / d) * step;

    if (d < HIT_RADIUS) { this.end(this.card.owner); return; }

    const round = (v) => Math.round(v * 100) / 100;
    const rp = (p) => ({ x: round(p.x), y: round(p.y), z: round(p.z) });
    this.broadcast("state", {
      players: Object.fromEntries(Object.entries(this.pos).map(([id, p]) => [id, rp(p)])),
      pig: rp(this.pig),
      card: { ...rp(this.card.pos), owner: this.card.owner, inFlight: this.card.inFlight },
      pigSpeed: Math.round(this.pigSpeed * 10) / 10,
      elapsed: Math.round(elapsed),
    });
  }

  end(loserId) {
    if (this.over) return;
    this.over = true;
    clearInterval(this.loop);
    const winnerId = this.otherPlayer(loserId);
    for (const id of this.players) {
      const sock = io.sockets.sockets.get(id);
      if (sock) sock.emit("gameOver", {
        result: id === winnerId ? "win" : "lose",
        survived: Math.round((Date.now() - this.roundStart) / 1000),
      });
    }
    servers.get(this.serverName).games.delete(this.id);
  }

  abandon(leaverId) {
    if (this.over) return;
    this.over = true;
    clearInterval(this.loop);
    const sock = io.sockets.sockets.get(this.otherPlayer(leaverId));
    if (sock) sock.emit("opponentLeft");
    servers.get(this.serverName).games.delete(this.id);
  }
}

// ---------------------------------------------------------------------------
// Matchmaking
// ---------------------------------------------------------------------------
function tryMatch(serverName) {
  const s = servers.get(serverName);
  while (s.queue.length >= 2) {
    const a = s.queue.shift();
    const b = s.queue.shift();
    if (!io.sockets.sockets.get(a)) continue;
    if (!io.sockets.sockets.get(b)) { if (io.sockets.sockets.get(a)) s.queue.unshift(a); continue; }
    const game = new Game(serverName, [a, b]);
    s.games.set(game.id, game);
    sockState.get(a).game = game;
    sockState.get(b).game = game;
  }
  io.emit("lobby", lobbyInfo());
}

/** @type {Map<string, {server:string|null, game:Game|null}>} */
const sockState = new Map();
let botCounter = 0;

io.on("connection", (socket) => {
  sockState.set(socket.id, { server: null, game: null });
  socket.emit("lobby", lobbyInfo());

  socket.on("joinServer", (name) => {
    if (!servers.has(name)) return;
    const st = sockState.get(socket.id);
    if (st.server || st.game) return;
    st.server = name;
    servers.get(name).queue.push(socket.id);
    socket.emit("waiting", { server: name });
    tryMatch(name);
  });

  socket.on("joinPractice", () => {
    const st = sockState.get(socket.id);
    if (st.server || st.game) return;
    const botId = "BOT-" + (++botCounter);
    const game = new Game("PRACTISE", [socket.id, botId]);
    servers.get("PRACTISE").games.set(game.id, game);
    st.game = game;
    st.server = "PRACTISE";
  });

  socket.on("leaveQueue", () => {
    const st = sockState.get(socket.id);
    if (st.server && !st.game) {
      const q = servers.get(st.server).queue;
      const i = q.indexOf(socket.id);
      if (i >= 0) q.splice(i, 1);
      st.server = null;
      io.emit("lobby", lobbyInfo());
    }
  });

  socket.on("move", (p) => {
    const st = sockState.get(socket.id);
    if (st.game && p && typeof p.x === "number") st.game.setPos(socket.id, p);
  });

  socket.on("throw", (path) => {
    const st = sockState.get(socket.id);
    if (st.game) st.game.throwCard(socket.id, path);
  });

  socket.on("disconnect", () => {
    const st = sockState.get(socket.id);
    if (!st) return;
    if (st.game) st.game.abandon(socket.id);
    else if (st.server) {
      const q = servers.get(st.server).queue;
      const i = q.indexOf(socket.id);
      if (i >= 0) q.splice(i, 1);
    }
    sockState.delete(socket.id);
    io.emit("lobby", lobbyInfo());
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`TaggyTag server running on http://localhost:${PORT}`));
