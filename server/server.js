// server.js
console.log("=== RUNNING SERVER.JS FROM:", process.cwd(), "FILE:", new URL(import.meta.url).pathname, "===");

import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8081;

// Render wants you listening on its port, and on 0.0.0.0
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

const wss = new WebSocketServer({ server });

server.listen(PORT, "0.0.0.0", () => {
  console.log("WS server listening on port", PORT);
});

const players = [
  { id: "p1", x: 2, y: 2 },
  { id: "p2", x: 3, y: 2 }
];

const clients = new Map(); // ws -> playerIndex

// ---- World sync (authoritative on server once set) ----
let activeWorldId = null;      // number
let activeWorldPayload = null; // { tiles: string[][], objects: any[][], ... }
// Queue of world ops to deliver reliably (piggybacked on snapshots)
let pendingWorldOps = [];

// ---- Activity Log sync (authoritative) ----
let logSeq = 0;
let actionLog = [];          // [{ seq, text, by, at }]
let pendingLogEntries = [];  // piggyback on snapshots for reliability

function logsForSnapshot() {
  // Always include the last 200 lines so late/missed clients self-heal.
  return actionLog.length ? actionLog.slice(-200) : [];
}

function pushLog(text, by = "server") {
  const entry = {
    seq: ++logSeq,
    text: String(text ?? ""),
    by,
    at: Date.now()
  };

  actionLog.push(entry);
  if (actionLog.length > 200) actionLog.shift();

  pendingLogEntries.push(entry);
  if (pendingLogEntries.length > 500) pendingLogEntries.shift();

  return entry;
}

function broadcastToRoom(room, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    const meta = clients.get(ws);
    if (ws.readyState === 1 && meta?.room === room) ws.send(msg);
  }
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// Minimal structural validation so ops don't get ignored
function isValidWorldPayload(w) {
  if (!w || typeof w !== "object") return false;
  if (!Array.isArray(w.tiles) || !Array.isArray(w.objects)) return false;
  if (w.tiles.length < 1 || w.objects.length < 1) return false;
  if (!Array.isArray(w.tiles[0]) || !Array.isArray(w.objects[0])) return false;
  return true;
}

wss.on("connection", (ws) => {
// --- handshake: wait for client "hello" so they can claim a character + room ---
clients.set(ws, { room: null, idx: null });
console.log("[WS] connect -> awaiting hello. clients:", clients.size);

// helper: pick slot based on want
function chooseIdxForWant(want, used) {
  // want "scott" => idx 0 (p1), want "cristina" => idx 1 (p2)
  const preferred = (want === "cristina") ? 1 : (want === "scott") ? 0 : null;
  if (preferred !== null && !used.has(preferred)) return preferred;
  if (!used.has(0)) return 0;
  if (!used.has(1)) return 1;
  return null;
}

 ws.on("message", (raw, isBinary) => {
  let msg;

  // ws can hand you Buffer/ArrayBuffer/etc. Don't gamble, convert to string.
  const text =
    typeof raw === "string"
      ? raw
      : Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : String(raw);

  try {
    msg = JSON.parse(text);
  } catch (e) {
    console.warn("[WS][IN] JSON parse failed:", e.message, "rawType=", typeof raw, "isBinary=", !!isBinary, "textPreview=", text.slice(0, 120));
    return;
  }

// --- HELLO: claim room + preferred character ---
if (msg.type === "hello") {
  const want = (msg.want === "scott" || msg.want === "cristina") ? msg.want : null;
  const room = (typeof msg.room === "string" && msg.room.trim()) ? msg.room.trim() : "scott-cristina";

  // compute used slots in this room
  const used = new Set();
  for (const v of clients.values()) {
    if (v && v.room === room && (v.idx === 0 || v.idx === 1)) used.add(v.idx);
  }

  const idx = chooseIdxForWant(want, used);
  if (idx === null) {
    ws.close();
    console.log("[WS] reject (room full):", room);
    return;
  }

  clients.set(ws, { room, idx });
  console.log("[WS] hello -> room", room, "assigned", players[idx].id);

  // welcome
  send(ws, { type: "welcome", playerId: players[idx].id });

  // send current log
  send(ws, { type: "log_init", seq: logSeq, entries: actionLog });

  // if server has a world already, push it
  if (activeWorldPayload) {
    send(ws, { type: "world", worldId: activeWorldId, world: activeWorldPayload });
  }

  return;
}
  // HARD INBOUND TRACE
  try {
    if (msg?.type === "input") {
      console.log("[WS][IN] input payload:", msg.payload?.type, msg.payload);
    } else {
      console.log("[WS][IN]", msg?.type, msg);
    }
  } catch (e2) {
    console.warn("[WS][IN] trace failed:", e2);
  }

    // client asks for current world
    if (msg.type === "world_request") {
      if (activeWorldPayload) {
        send(ws, { type: "world", worldId: activeWorldId, world: activeWorldPayload });
      }
      return;
    }

 // ----------------------------------------------------------------------------
// WORLD: first writer wins (prevents host-order nonsense)
// ----------------------------------------------------------------------------
if (msg.type === "world_set") {
  if (msg.world && typeof msg.worldId === "number") {
    if (!isValidWorldPayload(msg.world)) {
      console.warn("[WS] world_set rejected (invalid payload shape)");
      return;
    }

    // If a world already exists, ignore further world_set to avoid tug-of-war.
    if (activeWorldPayload) {
      console.warn("[WS] world_set ignored (world already set):", activeWorldId);
      return;
    }

    activeWorldId = msg.worldId;
    activeWorldPayload = msg.world;
    console.log("[WS] world_set accepted:", activeWorldId);
    broadcast({ type: "world", worldId: activeWorldId, world: activeWorldPayload });
  }
  return;
}

// world operations (authoritative server applies + broadcasts)
let _worldPushTimer = null;

function scheduleWorldPush() {
  if (_worldPushTimer) return;
  _worldPushTimer = setTimeout(() => {
    _worldPushTimer = null;
    if (!activeWorldPayload) return;
    broadcast({ type: "world", worldId: activeWorldId, world: activeWorldPayload });
  }, 30); // tiny debounce so a "chop" that does 2 ops doesn't spam like crazy
}

if (msg.type === "world_op") {
  const op = msg.op;

  if (!activeWorldPayload) {
    console.warn("[WS] world_op ignored (no activeWorldPayload yet). Did host send world_set?");
    return;
  }
  if (!op || typeof op !== "object") {
    console.warn("[WS] world_op ignored (bad op):", op);
    return;
  }

  let changed = false;

  if (op.kind === "set_obj") {
    const x = op.x | 0, y = op.y | 0;
    const row = activeWorldPayload.objects?.[y];
    if (Array.isArray(row) && x >= 0 && x < row.length) {
      row[x] = op.value ?? null;
      changed = true;
    }
  } else if (op.kind === "set_tile") {
    const x = op.x | 0, y = op.y | 0;
    const row = activeWorldPayload.tiles?.[y];
    if (Array.isArray(row) && x >= 0 && x < row.length) {
      row[x] = String(op.value ?? "grass");
      changed = true;
    }
  }

  if (changed) {
    console.log("[WS] world_op applied:", op);

    // ✅ Immediate op broadcast so P2 doesn't depend on timing
    broadcast({ type: "world_op", op });

    // ✅ Hard guarantee: push full world shortly after
    scheduleWorldPush();
  } else {
    console.warn("[WS] world_op had no effect (out of bounds / bad rows):", op);
  }

  return;
}

    // existing input path
    if (msg.type !== "input") return;

    const i = clients.get(ws);
    if (i == null) return;

    const p = players[i];
    const pl = msg.payload;

// ✅ Activity log input
if (pl?.type === "log") {
  const entry = pushLog(pl.text, players[i].id);

console.log("[WS][LOG] RECEIVED from", players[i].id, "=>", entry);

  // immediate broadcast
  broadcast({ type: "log_entry", entry });
  console.log("[WS][LOG] BROADCAST log_entry seq", entry.seq, "to", wss.clients.size, "clients");


  // piggyback reliability: include in next snapshot too
  const ops = pendingWorldOps.length ? pendingWorldOps.splice(0, pendingWorldOps.length) : [];
// Full-history logs so every snapshot heals missing log_init/log_entry.
const logs = logsForSnapshot();
pendingLogEntries.length = 0;
broadcast({ type: "snapshot", state: { players }, ops, logs });
 console.log("[WS][LOG] BROADCAST snapshot logs=", logs.length, "ops=", ops.length);

  return;
}

// ✅ Allow world ops to come through the proven "input" channel
if (pl?.type === "world_op") {
  const op = pl.op;
console.log("[WS] got input world_op:", op, "hasWorld?", !!activeWorldPayload);

  if (!activeWorldPayload) {
    console.warn("[WS] input world_op ignored (no activeWorldPayload).");
    return;
  }
  if (!op || typeof op !== "object") {
    console.warn("[WS] input world_op ignored (bad op):", op);
    return;
  }

  let changed = false;

  if (op.kind === "set_obj") {
    const x = op.x | 0, y = op.y | 0;
    const row = activeWorldPayload.objects?.[y];
    if (Array.isArray(row) && x >= 0 && x < row.length) {
      row[x] = op.value ?? null;
      changed = true;
    }
  } else if (op.kind === "set_tile") {
    const x = op.x | 0, y = op.y | 0;
    const row = activeWorldPayload.tiles?.[y];
    if (Array.isArray(row) && x >= 0 && x < row.length) {
      row[x] = String(op.value ?? "grass");
      changed = true;
    }
  }

if (changed) {
  console.log("[WS] input world_op applied:", op);

  // ✅ Immediate broadcast so P2 updates instantly (no dependence on snapshot timing)
  broadcast({ type: "world_op", op });

  // ✅ Still queue it so anyone who missed it can catch it via snapshot
  pendingWorldOps.push(op);
  console.log("[WS] queued ops =", pendingWorldOps.length);
} else {
  console.warn("[WS] input world_op had no effect:", op);
}

  // Important: don't fall through into movement logic
const ops = pendingWorldOps.length ? pendingWorldOps.splice(0, pendingWorldOps.length) : [];
const logs = logsForSnapshot();
pendingLogEntries.length = 0;
broadcast({ type: "snapshot", state: { players }, ops, logs });

  return;
}

    // minimal move input
    if (pl?.type === "move") {
      p.x += pl.dx | 0;
      p.y += pl.dy | 0;
      // TODO: bounds + collision later
    }

   const ops = pendingWorldOps.length ? pendingWorldOps.splice(0, pendingWorldOps.length) : [];
const logs = logsForSnapshot();
pendingLogEntries.length = 0;
broadcast({ type: "snapshot", state: { players }, ops, logs });
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("[WS] close -> clients:", clients.size);
  });

// send initial snapshot
const ops = pendingWorldOps.length ? pendingWorldOps.splice(0, pendingWorldOps.length) : [];
const logs = logsForSnapshot();
pendingLogEntries.length = 0;
broadcast({ type: "snapshot", state: { players }, ops, logs });
});

console.log("WS server on ws://localhost:8081");
