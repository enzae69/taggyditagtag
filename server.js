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
// Field / gameplay constants (virtual coordinates, the client scales these)
// ---------------------------------------------------------------------------
const FIELD = { w: 1000, h: 600 };
const PLAYER_L = { x: 110, y: 300 };
const PLAYER_R = { x: 890, y: 300 };
const PIG_START = { x: 500, y: 300 };

const TICK_MS = 1000 / 30;           // 30 ticks per second
const CARD_SPEED = 900;              // virtual units per second along the throw path
const PIG_BASE_SPEED = 90;           // pig speed at the start of a round
const PIG_ACCEL = 28;                // extra units/sec added to pig speed every second
const HIT_RADIUS = 34;               // pig <-> card collision distance

// The "servers" players can join (like region servers in a real game).
const SERVER_NAMES = ["EU 1", "EU 2", "EU 3", "EU 4"];

/** @type {Map<string, {name:string, queue:string[], games:Map<string,Game>}>} */
const servers = new Map();
for (const name of SERVER_NAMES) {
  servers.set(name, { name, queue: [], games: new Map() });
}

function lobbyInfo() {
  return SERVER_NAMES.map((name) => {
    const s = servers.get(name);
    return {
      name,
      waiting: s.queue.length,
      players: s.queue.length + s.games.size * 2,
    };
  });
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function quadBezier(p0, c, p1, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

// Rough length of a quadratic bezier by sampling.
function bezierLength(p0, c, p1) {
  let len = 0;
  let prev = p0;
  for (let i = 1; i <= 16; i++) {
    const pt = quadBezier(p0, c, p1, i / 16);
    len += Math.hypot(pt.x - prev.x, pt.y - prev.y);
    prev = pt;
  }
  return len;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------------------
// Game room: authoritative simulation of one match (2 players + AI pig)
// ---------------------------------------------------------------------------
class Game {
  constructor(serverName, players) {
    this.serverName = serverName;
    this.id = `${serverName}-${Date.now()}`;
    this.players = players; // [socketId, socketId]
    this.slots = {
      [players[0]]: { side: "left", pos: PLAYER_L },
      [players[1]]: { side: "right", pos: PLAYER_R },
    };

    this.pig = { x: PIG_START.x, y: PIG_START.y };
    this.pigSpeed = PIG_BASE_SPEED;
    this.roundStart = Date.now();

    // The card always belongs to one player. owner = socketId who must throw it.
    this.card = {
      owner: players[0],
      pos: { ...PLAYER_L },
      inFlight: false,
      path: null, // {p0, c, p1, len}
      dist: 0,    // distance travelled along path
    };

    this.over = false;
    this.lastTick = Date.now();

    for (const id of players) {
      const sock = io.sockets.sockets.get(id);
      if (sock) sock.join(this.id);
    }

    this.broadcast("matchStart", {
      slots: Object.fromEntries(
        Object.entries(this.slots).map(([id, s]) => [id, s.side])
      ),
      you: null, // filled per-socket below
      field: FIELD,
    });
    // Tell each player which side they are.
    for (const id of players) {
      const sock = io.sockets.sockets.get(id);
      if (sock) sock.emit("youAre", { side: this.slots[id].side, owner: this.card.owner });
    }

    this.loop = setInterval(() => this.tick(), TICK_MS);
  }

  broadcast(event, data) {
    io.to(this.id).emit(event, data);
  }

  otherPlayer(id) {
    return this.players[0] === id ? this.players[1] : this.players[0];
  }

  // A player throws the card with a curve defined by a control point.
  throwCard(socketId, control) {
    if (this.over || this.card.inFlight) return;
    if (this.card.owner !== socketId) return; // only the holder may throw

    const from = this.slots[socketId].pos;
    const to = this.slots[this.otherPlayer(socketId)].pos;
    const c = {
      x: clamp(control.x, 0, FIELD.w),
      y: clamp(control.y, 0, FIELD.h),
    };
    const path = { p0: { ...from }, c, p1: { ...to } };
    path.len = bezierLength(path.p0, path.c, path.p1);

    this.card.inFlight = true;
    this.card.path = path;
    this.card.dist = 0;
    this.broadcast("thrown", { from, c, to, owner: socketId });
  }

  tick() {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (this.over) return;

    // Pig accelerates with elapsed round time.
    const elapsed = (now - this.roundStart) / 1000;
    this.pigSpeed = PIG_BASE_SPEED + PIG_ACCEL * elapsed;

    // Advance the card if it is flying.
    if (this.card.inFlight && this.card.path) {
      this.card.dist += CARD_SPEED * dt;
      const t = clamp(this.card.dist / this.card.path.len, 0, 1);
      this.card.pos = quadBezier(
        this.card.path.p0,
        this.card.path.c,
        this.card.path.p1,
        t
      );
      if (t >= 1) {
        // Caught by the receiver: possession changes, they must throw next.
        this.card.inFlight = false;
        this.card.owner = this.otherPlayer(this.card.owner);
        this.card.pos = { ...this.slots[this.card.owner].pos };
        this.card.path = null;
      }
    } else {
      // Resting in the owner's hand.
      this.card.pos = { ...this.slots[this.card.owner].pos };
    }

    // Pig chases the card.
    const dx = this.card.pos.x - this.pig.x;
    const dy = this.card.pos.y - this.pig.y;
    const d = Math.hypot(dx, dy) || 1;
    const step = this.pigSpeed * dt;
    this.pig.x += (dx / d) * step;
    this.pig.y += (dy / d) * step;

    // Collision: the player holding/last-throwing the card loses.
    if (d < HIT_RADIUS) {
      this.end(this.card.owner);
      return;
    }

    this.broadcast("state", {
      pig: { x: Math.round(this.pig.x), y: Math.round(this.pig.y) },
      card: {
        x: Math.round(this.card.pos.x),
        y: Math.round(this.card.pos.y),
        inFlight: this.card.inFlight,
        owner: this.card.owner,
      },
      pigSpeed: Math.round(this.pigSpeed),
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
      if (sock) {
        sock.emit("gameOver", {
          result: id === winnerId ? "win" : "lose",
          survived: Math.round((Date.now() - this.roundStart) / 1000),
        });
      }
    }
    servers.get(this.serverName).games.delete(this.id);
  }

  // A player left mid-game.
  abandon(leaverId) {
    if (this.over) return;
    this.over = true;
    clearInterval(this.loop);
    const other = this.otherPlayer(leaverId);
    const sock = io.sockets.sockets.get(other);
    if (sock) sock.emit("opponentLeft");
    servers.get(this.serverName).games.delete(this.id);
  }
}

// ---------------------------------------------------------------------------
// Matchmaking: 2 players in a server's queue start a game.
// ---------------------------------------------------------------------------
function tryMatch(serverName) {
  const s = servers.get(serverName);
  while (s.queue.length >= 2) {
    const a = s.queue.shift();
    const b = s.queue.shift();
    // Skip disconnected sockets.
    if (!io.sockets.sockets.get(a)) continue;
    if (!io.sockets.sockets.get(b)) {
      if (io.sockets.sockets.get(a)) s.queue.unshift(a);
      continue;
    }
    const game = new Game(serverName, [a, b]);
    s.games.set(game.id, game);
    sockState.get(a).game = game;
    sockState.get(b).game = game;
  }
  io.emit("lobby", lobbyInfo());
}

/** @type {Map<string, {server:string|null, game:Game|null}>} */
const sockState = new Map();

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

  socket.on("leaveQueue", () => {
    const st = sockState.get(socket.id);
    if (st.server && !st.game) {
      const q = servers.get(st.server).queue;
      const i = q.indexOf(socket.id);
      if (i >= 0) q.splice(i, 1);
      st.server = null;
      socket.emit("lobby", lobbyInfo());
      io.emit("lobby", lobbyInfo());
    }
  });

  socket.on("throw", (control) => {
    const st = sockState.get(socket.id);
    if (st.game && control && typeof control.x === "number") {
      st.game.throwCard(socket.id, control);
    }
  });

  socket.on("disconnect", () => {
    const st = sockState.get(socket.id);
    if (!st) return;
    if (st.game) {
      st.game.abandon(socket.id);
    } else if (st.server) {
      const q = servers.get(st.server).queue;
      const i = q.indexOf(socket.id);
      if (i >= 0) q.splice(i, 1);
    }
    sockState.delete(socket.id);
    io.emit("lobby", lobbyInfo());
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`TaggyTag server running on http://localhost:${PORT}`);
});
