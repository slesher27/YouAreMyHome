// server.js
console.log("=== RUNNING SERVER.JS FROM:", process.cwd(), "FILE:", new URL(import.meta.url).pathname, "===");

import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8081 });

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

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(msg);
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
  // assign first free slot
  let idx = null;
  const used = new Set(clients.values());
  if (!used.has(0)) idx = 0;
  else if (!used.has(1)) idx = 1;

  if (idx === null) {
    ws.close();
    console.log("[WS] reject (2 clients already connected). clients:", clients.size);
    return;
  }

  clients.set(ws, idx);
  console.log("[WS] connect -> assigned", players[idx].id, "clients:", clients.size);

  // welcome
  send(ws, { type: "welcome", playerId: players[idx].id });

  // if server already has a chosen world, push it immediately
  if (activeWorldPayload) {
    send(ws, { type: "world", worldId: activeWorldId, world: activeWorldPayload });
  }

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

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

  // ✅ Do not depend on a separate world_op broadcast.
  // Queue it and ship it with the next snapshot (which both clients are receiving).
  pendingWorldOps.push(op);

} else {
  console.warn("[WS] world_op had no effect (out of bounds / bad rows):", op);
}

    // existing input path
    if (msg.type !== "input") return;

    const i = clients.get(ws);
    if (i == null) return;

    const p = players[i];
    const pl = msg.payload;

    // minimal move input
    if (pl?.type === "move") {
      p.x += pl.dx | 0;
      p.y += pl.dy | 0;
      // TODO: bounds + collision later
    }

    const ops = pendingWorldOps.length ? pendingWorldOps.splice(0, pendingWorldOps.length) : [];
broadcast({ type: "snapshot", state: { players }, ops });
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("[WS] close -> clients:", clients.size);
  });

  // send initial snapshot
  const ops = pendingWorldOps.length ? pendingWorldOps.splice(0, pendingWorldOps.length) : [];
broadcast({ type: "snapshot", state: { players }, ops });
});

console.log("WS server on ws://localhost:8081");
