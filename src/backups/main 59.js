
// src/main.js
const TILE_SIZE = 48;

// Overworld dimensions
const WORLD_W = 80;
const WORLD_H = 80;

// Interior dimensions
const INTERIOR_W = 11;
const INTERIOR_H = 10;

// =======================
// Construction constants
// =======================
const BUILD_FOOTPRINT = 3;

const BUILD_STAGES = [
  {
    id: "build_site",
    icon: "build_site.png",
    needs: { concrete: 100 },     // Build Site -> Foundation
    next: "foundation"
  },
  {
    id: "foundation",
    icon: "foundation.png",
    needs: { plank: 200 },       // Foundation -> Framing
    next: "framing"
  },
  {
    id: "framing",
    icon: "framing.png",
    needs: { wood: 100, plank: 100 }, // Framing -> House
    next: "house"
  },
  {
    id: "house",
    icon: "house.png",
    needs: null,
    next: null
  }
];

const BUILD_NEXT = Object.fromEntries(
  BUILD_STAGES.map(s => [s.id, s.next])
);

const BUILD_STAGE_TIME_SEC = {
  build_site: 120,
  foundation: 150,
  framing: 180
};

const BUILD_STAMINA_COST_PER_SEC = 1.00;

// =======================
// Dev Console Commands
// =======================

window.additem = function (itemId, qty = 1) {
  if (!state?.data?.items?.[itemId]) {
    console.warn("additem: unknown item id:", itemId);
    return;
  }

  const inv = activeInv();
  const p = activePlayer();

  const added = addItem(inv, itemId, qty);
  if (!added) {
    addDroppedItem(p.x, p.y, itemId, qty);
    console.warn(`Inventory full → dropped ${itemId} x${qty}`);
  } else {
    console.log(`Added ${itemId} x${qty}`);
  }

  playSound("click");
};

// DEV: enter an interior instantly (no house required)
window.deventerior = function (interiorId = "house_small") {
  state.interiorId = interiorId;

  state.interior = generateInterior(interiorId);
  state.mode = "interior";

  state.players[0].x = 2; state.players[0].y = INTERIOR_H - 2;
  state.players[0].fx = 2; state.players[0].fy = INTERIOR_H - 2;
  state.players[0].path = [];

  state.players[1].x = 3; state.players[1].y = INTERIOR_H - 2;
  state.players[1].fx = 3; state.players[1].fy = INTERIOR_H - 2;
  state.players[1].path = [];

  state.cam.x = 0; state.cam.y = 0;
  clampCamera();
  closeMenu();

  logAction(`DEV: entered interior "${interiorId}".`);
};

// ------------- TUTORIAL CONSTANTS ----
const PROFILE_KEY = "yamhome_profile_v1";
const TUTORIAL_SEEN_KEY = "yamhome_tutorial_seen_v1";
const WANT_TUTORIAL_KEY = "yamhome_want_tutorial_v1";

const CUTSCENE_SEEN_KEY = "yamhome_cutscene_seen_v1";
const WANT_CUTSCENE_KEY = "yamhome_want_cutscene_v1";

const COLLECTIBLES_FOUND_KEY = "yamhome_collectibles_found_v1";

// Fog of war visibility radius (1 => 3x3 around each player)
const VIS_RADIUS = 1; // base
const CAMPFIRE_LIGHT_RADIUS = 2; // tiles lit around a campfire at night
const CAMPFIRE_BURN_SECONDS = 60;
const CAMPFIRE_ADD_WOOD_SECONDS = 20;
const NIGHT_DARK_ALPHA = 0.55;          // higher = darker night
const CAMPFIRE_LIT_DARK_ALPHA = 0.05;   // lower = brighter campfire

const HOLDING_HANDS_ICON = { type: "image", src: "src/icons/holding_hands.png" };

// FONTS
const BASE_FONT = "BaseFont";
const TITLE_FONT = "TitleFont";
const GLYPH_FONT = "GlyphFont";

// Inventory UI
const INV_COLS = 12;
const INV_ROWS = 2;
const INV_SLOTS = INV_COLS * INV_ROWS;

// UI sizes
const UI_TOP_H = 58;        // room for stamina bar
const UI_BOTTOM_H = 230;    // inventory + crafting + misc

// ---- Left sidebar UI ----
const UI_LEFTBAR_W = 64; // width of the new left sidebar

// Pointer drag threshold
const DRAG_THRESHOLD_PX = 8;

// ---- Hunger ----
const HUNGER_MAX = 100;
const HUNGER_PER_SEC = 0.25; // hunger gained per second
const STARVE_STAMINA_DRAIN_PER_SEC = 1.0;

// Movement + stamina
const MOVE_SPEED_TILES_PER_SEC = 6;
const STAMINA_MAX = 100;
const STAMINA_COST_PER_TILE = 1.0;
const REST_REGEN_PER_SEC = 12.0;
const HARVEST_STAMINA_COST_WOOD = 6;
const HARVEST_STAMINA_COST_STONE = 8;

// Double click threshold
const DOUBLE_CLICK_MS = 350;

// ---- Time / Farming ----
const DAY_SECONDS = 240;        // 4 minutes = 1 in-game day
const DAYLIGHT_SECONDS = 120;   // 2 min day, 2 min night
const GROW_DAYS = 3;

// Dungeon dimensions (generated on entry)
const DUNGEON_W = 70;
const DUNGEON_H = 70;

// ---- Dungeon music ----
const DUNGEON_TRACK_COUNT = 14;

// ---- Tree stuff ----
const TREE_REGROW_DAYS_STAGE1 = 3; // stump -> seedling
const TREE_REGROW_DAYS_STAGE2 = 6; // seedling -> tree

const RENEWABLE_RESPAWN_DAYS = 4;

async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return await res.json();
}

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

// -------------------------------------------------------------------------- State & Players ----
const state = {
  mode: "overworld", // "overworld" | "interior" | "dungeon"
  data: null,

net: {
  enabled: false,
  ws: null,
  playerId: null,   // assigned by server, e.g. "p1"
  isHost: false,    // optional later
  lastSnapshotAt: 0
},

// Dungeons are generated on entry and cached/saved by id
dungeon: null,       // current dungeon map { tiles, objects, ... }
dungeonId: null,     // string
dungeonReturn: null, // { x, y, type } overworld entrance that led here
dungeons: {},        // in-memory cache of saved payloads

  // 6x6 build placement mode
  placement: {
    active: false,
    blueprintItemId: null, // e.g. "blueprint_house"
    placeId: null,         // e.g. "build_site"
    anchorX: null,
    anchorY: null,
    dragging: false
  },

  // key: "x,y" → { stageId, mats, building, timeLeft, builders, ... }
  buildProjects: {},

  world: null,    // { tiles, objects, explored:boolean[][] }
  interior: null, // { tiles, objects }
  interiorId: "house_small",
  
  // Screen fade (sleep, etc.)
screenFade: null,

    // Interior edit mode (for decorating / changing tiles)
  interiorEdit: {
    on: false
  },

  actionLog: [],
  logScroll: 0,

  // Optional story cutscene (first-play; rewatchable via checkbox)
  wantCutscene: false,

  cutscene: {
    open: false,
    index: 0,
    seen: false,
    t: 0,       // animation timer
    _after: "",  // "tutorial" or "start"
	orbs: {
  a: { x: 0, y: 0, vx: 0, vy: 0 },
  b: { x: 0, y: 0, vx: 0, vy: 0 },
    stars: null,
  init: false
}
  },

  wantTutorial: true,

  tutorial: {
    open: false,
    index: 0,
    seen: false
  },

  players: [
    {
      id: "p1", name: "Scott", x: 2, y: 2, fx: 2, fy: 2,
      icon: { type: "image", src: "src/icons/scott_avatar.png" },
      path: [],
      stamina: STAMINA_MAX,
      hunger: 0,
      resting: false
    },
    {
      id: "p2", name: "Cristina", x: 3, y: 2, fx: 3, fy: 2,
      icon: { type: "image", src: "src/icons/cristina_avatar.png" },
      path: [],
      stamina: STAMINA_MAX,
      hunger: 0,
      resting: false
    }
  ],

  activePlayer: 0,

  inventories: [[], []],

  structures: {
    stockpiles: [],
    houses: []
  },

  markers: [],

  cam: { x: 0, y: 0 },

  pointer: {
    down: false,
    dragging: false,
    startX: 0, startY: 0,
    lastX: 0, lastY: 0
  },

  ui: {
    musicSliderOpen: false,
    musicDragging: false
  },

// Global Settings modal state
settingsOpen: false,
settingsTab: "audio",   // "audio" | "controls"
settingsDrag: null,     // "master" | "sfx" | "music" | "ambient" while dragging
_settingsUI: null,

  // Context menu
  menu: null, // { screenX, screenY, title, options:[...], hoverIndex:-1 }

  // Modal dialogs
  coordsOpen: false,     // saved coordinates modal
  coordsSelected: null, // string key for selected saved marker (for Travel There)
  stockpileOpen: null,   // { key } if stockpile UI open
  
  collectiblesOpen: false,   // archive modal open/closed
collectiblesView: "list",  // "list" | "reader"
collectiblesSelected: null, // itemId currently open in reader
collectiblesScroll: 0,     // list scroll offset
collectiblesFound: loadCollectiblesFound(), // persisted archive

  // Treasure map (revealed coords + dig target)
  treasureOpen: false,      // modal open/closed
  treasureTarget: null,     // { x, y, by }
  _treasureUI: null,
  
    // Rune combination lock (dungeon puzzle chest)
  comboLock: null,       // { open:true, x,y, digits:[...], solution:[...], tries:int }
  _comboLockUI: null,

  // Construction modal
constructionOpen: null, // { key, x, y }
constructionSelectedInvIdx: -1,
constructionLogScroll: 0,

 // Player-to-player interaction request (simple local “network”)
  interactionRequest: null, // { type, fromIndex, toIndex, createdAt }
  holdingHands: null,       // { a, b, leader }  (we’ll use this later),
  // Chat
  chatMessages: [], // { fromIndex, text, t }
  speechBubbles: [null, null], // per player: { text, until }


// Crafting
craftingOpen: false,
craftingMode: null,   // "craft" | "cook"
selectedForCraft: new Map(), // itemId -> qtySelected
selectedInvIdx: -1,
craftingDrag: null,
learnedRecipes: new Set(),
recipeLootExtra: {}, 
hoveredUI: null,
lastCraftItemId: null,

  // Placement modes
  placinghouse: false,
  placingStockpile: false,

  // Double click tracking
  lastInvClick: { idx: -1, t: 0 },

// ---- Music ----
music: {
  unlocked: false,     // autoplay policy unlock
  enabled: true,
  audio: null,
  contextKey: null,    // "daytime_outdoor" etc
  lastTrack: null,     // full file base name, e.g. "daytime_outdoor3"
  volume: 0.15,
  fadeMs: 900,           // fade duration
  _fade: null,            // internal fade state
    // --- Ambience (day/night loop, fades like music) ---
  ambienceEnabled: true,      // can be tied to your settings toggle if you want
  ambienceAudio: null,
  ambienceKey: null,          // "day" or "night"
  ambienceFadeMs: 900,
  _ambFade: null,
  ambSwitching: false,
  pendingAmbKey: null,
  ambienceGain: 0.70,         // ambience volume relative to music slider
  switching: false,
  pendingCtxKey: null,
  indexMax: 10         // how many numbered tracks to try 
},

// ---- Title Menu ----
title: {
  open: true,
  phase: "closed",  // "closed" | "intro" | "menu" | "pick"
  openP: 0,         // 0.1
  savedProfile: null,
  wantTutorial: true, // <-- add this
  _ui: null
},

  // ---- Time ----
  time: {
    t: 0,          // total seconds elapsed (for bookkeeping)
    day: 1,        // starts at Day 1
    phaseT: 0,     // seconds into current day (0..DAY_SECONDS)
    isDay: true
  },

  // Loop timing
  _lastTime: performance.now()
};

state.title.savedProfile = loadSavedProfile();
// Multiplayer-only: server assigns which player this client controls.
state.activePlayer = 0; // temporary until "welcome" arrives

state.tutorial.seen = loadTutorialSeen();
console.log("TUTORIAL SEEN AFTER LOAD:", state.tutorial.seen);

state.cutscene.seen = loadCutsceneSeen();

const wantC = loadWantCutscene();
if (wantC !== null) state.wantCutscene = wantC;

// After first forced tutorial, this becomes optional.
// Default is always OFF unless user explicitly enabled it.
const savedWant = loadWantTutorial();
state.wantTutorial = savedWant === true;

// ---- Log Actions ----
function logAction(text) {
  state.actionLog.unshift(text);
  if (state.actionLog.length > 50) state.actionLog.pop();
}

// -------------- 
function overworldReady() {
  const m = state.world;
  const tilesOk = Array.isArray(m?.tiles) && m.tiles.length === WORLD_H && Array.isArray(m.tiles[0]) && m.tiles[0].length === WORLD_W;
  const objsOk  = Array.isArray(m?.objects) && m.objects.length === WORLD_H && Array.isArray(m.objects[0]) && m.objects[0].length === WORLD_W;
  return tilesOk && objsOk;
}

// ---- Resize -----------------------------------------------------------------------------------------------
function resize() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  positionChatInput();
}
window.addEventListener("resize", resize);
resize();

// -------------------------------------------------------------------------- CO-OP Helpers ----

function connectOnline(url) {
  state.net.enabled = true;

  const ws = new WebSocket(url);
  state.net.ws = ws;

  ws.onopen = () => {
    console.log("[NET] connected:", url);
    ws.send(JSON.stringify({ type: "hello" }));
  };

  ws.onmessage = (ev) => {
    console.log("[NET] msg:", ev.data);

    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "welcome") {
      state.net.playerId = msg.playerId; // "p1" or "p2"
      state.activePlayer = (msg.playerId === "p2") ? 1 : 0;
      return;
    }

    if (msg.type === "snapshot") {
      applyServerSnapshot(msg.state);
      state.net.lastSnapshotAt = performance.now();
      return;
    }
  };

  ws.onclose = () => {
    console.log("[NET] disconnected");
    state.net.enabled = false;
    state.net.ws = null;
    state.net.playerId = null;
  };

  ws.onerror = (err) => {
    console.error("[NET] error:", err);
  };
}


function sendNetInput(payload) {
  const ws = state.net.ws;
  if (!state.net.enabled || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "input", payload }));
}

function applyServerSnapshot(s) {
  // Step 1 minimal: players only.
  if (!s || !Array.isArray(s.players)) return;

  let anyMoved = false;

  for (let i = 0; i < state.players.length && i < s.players.length; i++) {
    const sp = s.players[i];
    const lp = state.players[i];

    if (lp.x !== sp.x || lp.y !== sp.y) anyMoved = true;

    lp.x = sp.x; lp.y = sp.y;
    lp.fx = sp.x; lp.fy = sp.y;
    lp.path = []; // server owns movement for now
  }

  // Online movement comes from snapshots, so fog must update here.
  if (anyMoved) revealAroundPlayers();
}


// --- Online click-to-move: queue + drip-feed steps to server ---
state.net.moveQueue = state.net.moveQueue || [];
state.net.nextMoveAt = state.net.nextMoveAt || 0;

function netQueuePath(path) {
  // Only queue for the local controlled player
  state.net.moveQueue = Array.isArray(path) ? path.slice() : [];
}

function netTick() {
  if (!state.net?.enabled) return;
  if (!state.net.ws || state.net.ws.readyState !== 1) return;

  // Always obey the server-assigned slot (prevents title/profile UI from hijacking activePlayer)
  if (state.net.playerId) {
    const wantIdx = (state.net.playerId === "p2") ? 1 : 0;
    if (state.activePlayer !== wantIdx) state.activePlayer = wantIdx;
  }

  const now = performance.now();
  if (now < (state.net.nextMoveAt || 0)) return;

  const p = activePlayer();
  const q = state.net.moveQueue;
  if (!q || q.length === 0) return;

  // If we've already reached this queued node (server snapped us), pop it.
  while (q.length && q[0].x === p.x && q[0].y === p.y) q.shift();
  if (!q.length) return;

  const next = q[0];
  const dx = Math.sign(next.x - p.x);
  const dy = Math.sign(next.y - p.y);

  // Safety: only 4-dir steps
  if ((dx !== 0 && dy !== 0) || (dx === 0 && dy === 0)) {
    q.shift();
    return;
  }

  sendNetInput({ type: "move", dx, dy });

  // throttle so we don't spam
  state.net.nextMoveAt = now + 110;
}

// -------------------------------------------------------------------------- Chat UI (DOM + canvas draw) ----
function ensureChatInput() {
  if (document.getElementById("chatWrap")) return;

  const wrap = document.createElement("div");
  wrap.id = "chatWrap";
  wrap.style.position = "absolute";
  wrap.style.zIndex = "20";
  wrap.style.display = "flex";
  wrap.style.gap = "8px";
  wrap.style.alignItems = "center";
  wrap.style.pointerEvents = "auto";

  const input = document.createElement("input");
  input.id = "chatInput";
  input.type = "text";
  input.placeholder = "Type message… (Enter to send)";
  input.autocomplete = "off";
  input.spellcheck = true;

  input.style.width = "440px";
  input.style.maxWidth = "70vw";
  input.style.padding = "6px 18px";
  input.style.borderRadius = "10px";
  input.style.border = "1px solid rgba(255,255,255,0.18)";
  input.style.background = "rgba(20,20,20,0.92)";
  input.style.color = "rgba(255,255,255,0.92)";
  input.style.outline = "none";
  input.style.font = "10px system-ui";
  input.style.lineHeight = "12px";

  // Prevent your global hotkeys from firing while typing
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();

    if (e.key === "Enter") {
      e.preventDefault();
      const txt = input.value.trim();
      if (!txt) return;
      sendChatMessage(state.activePlayer, txt);
      input.value = "";
    }
  });

  wrap.appendChild(input);
  document.body.appendChild(wrap);

  positionChatInput();
}

function setChatInputVisible(visible) {
  const wrap = document.getElementById("chatWrap");
  if (!wrap) return;
  wrap.style.display = visible ? "flex" : "none";
}

function positionChatInput() {
  const wrap = document.getElementById("chatWrap");
  const input = document.getElementById("chatInput");
  if (!wrap || !input) return;

  const baseY = window.innerHeight - UI_BOTTOM_H;
  const cell = 44, pad = 10;

  const gridX = UI_LEFTBAR_W + pad;
  const gridY = baseY + 50;
  const gridW = INV_COLS * (cell + 6);

  // Anchor to the right of inventory
  const x = gridX + gridW + 12;

  // Compact log metrics (must match drawChatLog)
  const logY = gridY;
  const logH = 88;

  // Input sits below log
  const y = logY + logH + 10;

  // Fit in remaining horizontal space
  const maxW = Math.max(180, window.innerWidth - x - 12);
  const w = Math.min(340, maxW);

  input.style.width = `${w}px`;
  input.style.maxWidth = `${maxW}px`;

  wrap.style.left = `${x}px`;
  wrap.style.top = `${y}px`;
}

function sendChatMessage(fromIndex, text) {
  const now = performance.now();

  state.chatMessages.push({ fromIndex, text, t: now });
  if (state.chatMessages.length > 30) state.chatMessages.shift();

  // Speech bubble above the sender
  state.speechBubbles[fromIndex] = {
    text,
    until: now + 3500
  };

  playSound("message");
}

function drawChatLog() {
  ctx.save();
  ctx.globalAlpha = 1;

  // Bottom UI bar anchor
  const baseY = window.innerHeight - UI_BOTTOM_H;

  // Inventory layout assumptions (match your inv hitbox math)
  const pad = 10;
  const cell = 44;
  const gap = 6;

  const gridX = UI_LEFTBAR_W + pad;
  const gridY = baseY + 52;
  const invW = (INV_COLS * cell) + ((INV_COLS - 1) * gap);

  // Chat log sits to the RIGHT of inventory
  const x = gridX + invW + 12;
  const y = gridY;          // log goes on top
  const boxW = Math.min(380, Math.max(180, window.innerWidth - x - 12));
  const boxH = 88;

  drawRect(x, y, boxW, boxH, "rgba(0,0,0,0.50)");
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.strokeRect(x, y, boxW, boxH);

  // White text (no “maybe white”)
  const lines = state.chatMessages.slice(-4);
  let yy = y + 18;

  for (const m of lines) {
    const name = state.players[m.fromIndex]?.name ?? "???";
    drawText(`${name}: ${m.text}`, x + 10, yy, 11, "left", "#ffffff");
    yy += 16;
  }

  ctx.restore();
}

function drawSpeechBubbles() {
  const now = performance.now();
  const hh = state.holdingHands;

  const bubbleFor = (idx) => {
    const b = state.speechBubbles[idx];
    return b && now < b.until ? b : null;
  };

  // If holding hands, draw bubbles over the combined icon (midpoint), not invisible players
  if (hh) {
    for (const idx of [hh.a, hh.b]) {
      const b = bubbleFor(idx);
      if (!b) continue;

      const a = state.players[hh.a];
      const c = state.players[hh.b];

      const mx = (a.fx + c.fx) / 2;
      const my = (a.fy + c.fy) / 2;

      const { viewW, viewH } = viewTiles();
      const camX = state.cam.x;
      const camY = state.cam.y;

      if (mx < camX || mx >= camX + viewW || my < camY || my >= camY + viewH) continue;

      const sx = (mx - camX) * TILE_SIZE + TILE_SIZE / 2;
      const sy = UI_TOP_H + (my - camY) * TILE_SIZE;

      drawSpeechBubbleAt(sx, sy, b.text);
    }
    return;
  }

  // Normal: bubble above each player's icon
  for (let i = 0; i < state.players.length; i++) {
    const b = bubbleFor(i);
    if (!b) continue;

    const pl = state.players[i];
    const { viewW, viewH } = viewTiles();
    const camX = state.cam.x;
    const camY = state.cam.y;

    const px = pl.fx;
    const py = pl.fy;

    if (px < camX || px >= camX + viewW || py < camY || py >= camY + viewH) continue;

    const sx = (px - camX) * TILE_SIZE + TILE_SIZE / 2;
    const sy = UI_TOP_H + (py - camY) * TILE_SIZE;

    drawSpeechBubbleAt(sx, sy, b.text);
  }
}

function drawSpeechBubbleAt(centerX, topY, text) {
  // Simple bubble sizing
  ctx.font = "14px system-ui";
  const padX = 10;
  const padY = 6;
  const maxW = 220;

  // crude wrap: split on spaces
  const words = String(text).split(" ");
  const lines = [];
  let cur = "";

  for (const w of words) {
    const test = cur ? (cur + " " + w) : w;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);

  const lineH = 16;
  const textW = Math.min(maxW, Math.max(...lines.map(l => ctx.measureText(l).width)));
  const boxW = textW + padX * 2;
  const boxH = lines.length * lineH + padY * 2;

  const x = centerX - boxW / 2;
  const y = topY - boxH - 10;

  // bubble
ctx.fillStyle = "#ffffff";
ctx.beginPath();
ctx.roundRect(x, y, boxW, boxH, 10);
ctx.fill();

ctx.strokeStyle = "rgba(0,0,0,0.3)";
ctx.stroke();

  let yy = y + padY + 12;
  for (const l of lines) {
    drawText(l, centerX, yy, 12, "center", "#000000");
    yy += lineH;
  }
}

// ---- Helpers ----
function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }

// ---- Rune Combo Lock (Puzzle #1) ----
const RUNE_COUNT = 13;
const RUNE_COMBO_LEN = 4;

const _runeImgCache = Object.create(null);
function getRuneImg(n) {
  const nn = Math.max(1, Math.min(RUNE_COUNT, n | 0));
  const src = `src/icons/rune${nn}.png`;
  if (_runeImgCache[src]) return _runeImgCache[src];
  const img = new Image();
  img.src = src;
  _runeImgCache[src] = img;
  return img;
}

function openRuneComboLockForChest(mapX, mapY) {
  if (state.mode !== "dungeon") return;
  const map = state.dungeon;
  const obj = map?.objects?.[mapY]?.[mapX];
  if (!obj || obj.id !== "dungeon_chest") return;

  // Ensure this chest has a solution (generated at dungeon gen, but safe-guard anyway)
  if (!Array.isArray(obj.meta?.combo) || obj.meta.combo.length !== RUNE_COMBO_LEN) {
    obj.meta = obj.meta || {};
    obj.meta.combo = Array.from({ length: RUNE_COMBO_LEN }, () => randInt(1, RUNE_COUNT));
  }

  state.comboLock = {
    open: true,
    x: mapX,
    y: mapY,
    digits: (Array.isArray(obj.meta?.uiDigits) && obj.meta.uiDigits.length === RUNE_COMBO_LEN)
  ? obj.meta.uiDigits.slice(0, RUNE_COMBO_LEN)
  : [1, 1, 1, 1],
    solution: obj.meta.combo.slice(0, RUNE_COMBO_LEN),
    tries: 0
  };
  state._comboLockUI = null;
}

function closeRuneComboLock() {
  const cl = state.comboLock;

  // Persist the current dial positions back into THIS chest only
  if (cl?.open && state.mode === "dungeon") {
    const map = state.dungeon;
    const obj = map?.objects?.[cl.y]?.[cl.x];
    if (obj && obj.id === "dungeon_chest") {
      obj.meta = obj.meta || {};
      obj.meta.uiDigits = cl.digits.slice(0, RUNE_COMBO_LEN);
    }
  }

  state.comboLock = null;
  state._comboLockUI = null;
}

function drawRuneComboLockModal() {
  const cl = state.comboLock;
  if (!cl?.open) return;

  const W = window.innerWidth;
  const H = window.innerHeight;

  // darken background
  ctx.save();
  drawRect(0, 0, W, H, "rgba(0,0,0,0.70)");

  const boxW = 520;
  const boxH = 320;
  const bx = Math.floor((W - boxW) / 2);
  const by = Math.floor((H - boxH) / 2);

  // panel
  drawRect(bx, by, boxW, boxH, "rgba(20,20,20,0.96)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(bx, by, boxW, boxH);

  drawText("Runic Combination Lock", bx + boxW / 2, by + 36, 20, "center", "rgba(255,255,255,0.95)");
  drawText("Click a rune to rotate it.", bx + boxW / 2, by + 62, 13, "center", "rgba(255,255,255,0.70)");

  // close button (top-right)
  const closeBtn = { x: bx + boxW - 44, y: by + 14, w: 30, h: 30 };
  drawRect(closeBtn.x, closeBtn.y, closeBtn.w, closeBtn.h, "rgba(255,255,255,0.08)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(closeBtn.x, closeBtn.y, closeBtn.w, closeBtn.h);
  drawText("✕", closeBtn.x + closeBtn.w / 2, closeBtn.y + 21, 16, "center", "rgba(255,255,255,0.85)");

  // rune slots
  const slotW = 90;
  const slotH = 110;
  const gap = 18;
  const totalW = (slotW * RUNE_COMBO_LEN) + (gap * (RUNE_COMBO_LEN - 1));
  const startX = bx + Math.floor((boxW - totalW) / 2);
  const slotY = by + 90;

  const digitRects = [];
  for (let i = 0; i < RUNE_COMBO_LEN; i++) {
    const r = { x: startX + i * (slotW + gap), y: slotY, w: slotW, h: slotH };
    digitRects.push(r);

    drawRect(r.x, r.y, r.w, r.h, "rgba(255,255,255,0.06)");
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // rune image
    const img = getRuneImg(cl.digits[i]);
    const iw = 64, ih = 64;
    const ix = r.x + (r.w - iw) / 2;
    const iy = r.y + 18;
    try { ctx.drawImage(img, ix, iy, iw, ih); } catch (_) {}

    // tiny index label
    drawText(String(i + 1), r.x + r.w / 2, r.y + r.h - 12, 12, "center", "rgba(255,255,255,0.55)");
  }

  // unlock button
  const unlockBtn = { x: bx + (boxW / 2) - 90, y: by + boxH - 74, w: 180, h: 44 };
  drawRect(unlockBtn.x, unlockBtn.y, unlockBtn.w, unlockBtn.h, "rgba(120,255,160,0.20)");
  ctx.strokeStyle = "rgba(120,255,160,0.35)";
  ctx.strokeRect(unlockBtn.x, unlockBtn.y, unlockBtn.w, unlockBtn.h);
  drawText("Unlock", unlockBtn.x + unlockBtn.w / 2, unlockBtn.y + 28, 16, "center", "rgba(255,255,255,0.92)");

  // tries
  drawText(`Attempts: ${cl.tries ?? 0}`, bx + 14, by + boxH - 18, 12, "left", "rgba(255,255,255,0.55)");

  // save hitboxes
  state._comboLockUI = { panel: { x: bx, y: by, w: boxW, h: boxH }, closeBtn, digitRects, unlockBtn };

  ctx.restore();
}

function handleRuneComboLockClick(px, py) {
  const cl = state.comboLock;
  const ui = state._comboLockUI;
  if (!cl?.open || !ui) return false;

  // click outside panel closes (optional, but nice)
  if (!pointInRect(px, py, ui.panel)) {
    closeRuneComboLock();
    playSound("click");
    return true;
  }

  if (pointInRect(px, py, ui.closeBtn)) {
    closeRuneComboLock();
    playSound("click");
    return true;
  }

  // spin digits
  for (let i = 0; i < ui.digitRects.length; i++) {
    if (pointInRect(px, py, ui.digitRects[i])) {
      const v = (cl.digits[i] | 0) || 1;
      cl.digits[i] = (v % RUNE_COUNT) + 1;
      playSound("click");
      return true;
    }
  }

  // unlock attempt
  if (pointInRect(px, py, ui.unlockBtn)) {
    cl.tries = (cl.tries ?? 0) + 1;

    if (_comboMatches(cl.digits, cl.solution)) {
      const map = state.dungeon;
      const cx = cl.x, cy = cl.y;

      // Remove chest
      if (map?.objects?.[cy]) map.objects[cy][cx] = null;

      // Reward: 1 dungeon key (inventory or drop near player)
      const inv = activeInv();
      const p = activePlayer();
      addItemOrDrop(inv, "dungeon_key", 1, p.x, p.y, p.name);

      saveDungeonLayout(state.dungeonId);
      logAction(`${p.name} unlocked a runic chest.`);
      playSound("unlock");
      closeRuneComboLock();
    } else {
      logAction(`Wrong combination.`);
      playSound("error");
    }
    return true;
  }

  return true; // modal eats clicks
}

function _comboMatches(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if ((a[i] | 0) !== (b[i] | 0)) return false;
  return true;
}

function rollTreasureCoord() {
  // Pick a random GRASS tile on the overworld. Try a bunch of times, then fall back.
  const map = state.world;
  const h = map?.tiles?.length ?? 0;
  const w = map?.tiles?.[0]?.length ?? 0;

  for (let tries = 0; tries < 800; tries++) {
    const x = randInt(0, Math.max(0, w - 1));
    const y = randInt(0, Math.max(0, h - 1));
    if (map?.objects?.[y]?.[x]) continue; // don't bury it under an object
    if (map?.tiles?.[y]?.[x] === "grass") return { x, y };
  }

  // Fallback: just somewhere in bounds
  return { x: Math.max(0, Math.min(w - 1, 2)), y: Math.max(0, Math.min(h - 1, 2)) };
}

function inBounds(x, y, w, h) { return x >= 0 && y >= 0 && x < w && y < h; }

// ---------- Dice / chance system ----------
const ACTION_DICE_SIDES = 20;

// chance01: 0.0 to 1.0
function rollCheck(chance01, sides = ACTION_DICE_SIDES) {
  const c = Math.max(0, Math.min(1, chance01));
  const roll = randInt(1, sides);
  const target = Math.max(1, Math.min(sides, Math.round(c * sides))); // e.g. 0.70 -> 14 on d20
  return { ok: roll <= target, roll, target, sides };
}

function neighbors4(x, y) {
  return [[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
}

function currentDims() {
  if (state.mode === "overworld") return { w: WORLD_W, h: WORLD_H };
  if (state.mode === "interior") return { w: INTERIOR_W, h: INTERIOR_H };
  if (state.mode === "dungeon") {
    const m = state.dungeon;
    const h = m?.tiles?.length ?? 0;
    const w = m?.tiles?.[0]?.length ?? 0;
    return { w, h };
  }
  return { w: WORLD_W, h: WORLD_H };
}

function getCurrentMap() {
  if (state.mode === "overworld") return state.world;
  if (state.mode === "interior") return state.interior;
  if (state.mode === "dungeon") return state.dungeon;
  return state.world;
}

function activePlayer() { return state.players[state.activePlayer]; }
function activeInv() { return state.inventories[state.activePlayer]; }
function otherInvIndex() { return state.activePlayer === 0 ? 1 : 0; }

function tileAt(x, y) {
  const map = getCurrentMap();
  return map?.tiles?.[y]?.[x] ?? null;
}

function objectAt(x, y) {
  const map = getCurrentMap();
  return map?.objects?.[y]?.[x] ?? null;
}

function itemDef(itemId) { return state.data.items[itemId]; }

function objDef(objId) {
  // Normal objects from objects.json
  const d = state.data?.objects?.[objId];
  if (d) return d;

  // Fallback: construction stages (build_site/foundation/framing/house)
  const st = BUILD_STAGES.find(s => s.id === objId);
  if (st) {
    return {
      name: st.id,
      icon: { type: "image", src: `src/icons/${st.icon}` },
      blocks: true,                  // keeps it solid if anything relies on objectBlocks()
      footprint: BUILD_FOOTPRINT     // optional metadata (harmless if unused)
    };
  }

// Fallbacks for generated content
if (objId === "dungeon_gate") {
  return { name: "Locked Gate", icon: "🔒", blocks: true };
}
if (objId === "dungeon_gate_open") {
  return { name: "Gate", icon: "🚪", blocks: false };
}
if (objId === "dungeon_exit") {
  return { name: "Exit", icon: "⬆️", blocks: false };
}

  return null;
}

function getQty(inv, itemId) {
  let total = 0;
  for (const st of inv) {
    if (!st) continue;
    if (st.id === itemId) total += (st.qty ?? 0);
  }
  return total;
}

function hasTool(inv, toolId) { return getQty(inv, toolId) > 0; }

function isWalkableTile(tileId) {
  // Dungeon uses procedural tiles not defined in tiles.json
  if (state.mode === "dungeon") {
    return tileId === "floor";
  }

  const t = state.data.tiles[tileId];
  return !!t && t.walkable === true;
}


function objectBlocks(objId) {
  const d = objDef(objId);
  return d?.blocks === true;
}

function addItem(inv, itemId, qty) {
  const def = itemDef(itemId);
  if (!def) return { ok: false, added: 0, remaining: qty, reason: `Unknown item: ${itemId}` };

  qty = Math.max(0, Math.floor(qty || 0));
  if (qty <= 0) return { ok: true, added: 0, remaining: 0 };

  const maxStack = def.stack ?? 99;
  const startQty = qty;

  // 1) Fill *all* existing stacks with space
  for (const st of inv) {
    if (qty <= 0) break;
    if (!st || st.id !== itemId) continue;

    const space = Math.max(0, maxStack - (st.qty ?? 0));
    if (space <= 0) continue;

    const add = Math.min(space, qty);
    st.qty += add;
    qty -= add;
  }

  // 2) Create new stacks while we have qty and free slots
  while (qty > 0 && inv.length < INV_SLOTS) {
    const add = Math.min(maxStack, qty);
    inv.push({ id: itemId, qty: add });
    qty -= add;
  }

  const added = startQty - qty;

  return {
    ok: qty === 0,
    added,
    remaining: qty,
    reason: qty === 0 ? null : (inv.length >= INV_SLOTS ? "Inventory full" : `Stack cap (${maxStack})`)
  };
}

function eatItem(itemId, qty = 1) {
  const inv = activeInv();
  const p = activePlayer();

  if (typeof itemId !== "string") return;
  qty = Math.max(1, Math.floor(qty || 1));

  const def = itemDef(itemId);
  if (!def || typeof def.nourishment !== "number") return;

  // Only eat what you actually have
  const have = getQty(inv, itemId);
  const eatN = Math.min(qty, have);
  if (eatN <= 0) return;

  // Apply nourishment (hunger decreases)
  p.hunger = Math.max(0, p.hunger - def.nourishment * eatN);

  // Remove items (multi-stack safe)
  removeItem(inv, itemId, eatN);

  logAction(`${p.name} ate ${eatN} ${(def.name ?? itemId)}${eatN === 1 ? "" : "s"}.`);
  playSound("eat");
}

function _canStackDroppedItemAt(x, y, itemId) {
  const map = getCurrentMap();
  const obj = map?.objects?.[y]?.[x];
  return obj && obj.id === "dropped_item" && obj.meta?.itemId === itemId;
}

function findDropSpotNear(x, y, itemId, maxR = 3) {
  const { w, h } = currentDims();
  if (!inBounds(x, y, w, h)) return null;

  // prefer same tile if empty or stackable with same dropped item
  if (!isTileOccupiedForDrop(x, y) || _canStackDroppedItemAt(x, y, itemId)) return { x, y };

  // spiral-ish search (diamond rings)
  for (let r = 1; r <= maxR; r++) {
    for (let dx = -r; dx <= r; dx++) {
      const dy1 = r - Math.abs(dx);
      const candidates = [[x + dx, y + dy1], [x + dx, y - dy1]];
      for (const [nx, ny] of candidates) {
        if (!inBounds(nx, ny, w, h)) continue;
        if (!isTileOccupiedForDrop(nx, ny) || _canStackDroppedItemAt(nx, ny, itemId)) return { x: nx, y: ny };
      }
    }
  }

  return null;
}

function addOrDrop(inv, itemId, qty, dropX, dropY, logName = null) {
  const pName = logName ?? activePlayer().name;
  const name = itemDef(itemId)?.name ?? itemId;

  const res = addItem(inv, itemId, qty);
  if (res.added > 0) {
    logAction(`${pName} got ${res.added} ${name}${res.added === 1 ? "" : "s"}.`);
  }

  if (res.remaining > 0) {
    const spot = findDropSpotNear(dropX, dropY, itemId, 4);
    if (spot) {
      dropItemOnTile(itemId, res.remaining, spot.x, spot.y);
      logAction(`${pName} couldn't carry ${res.remaining} ${name}${res.remaining === 1 ? "" : "s"} and dropped it at (${spot.x},${spot.y}).`);
      return { ok: false, added: res.added, dropped: res.remaining, remaining: 0 };
    } else {
      logAction(`${pName} couldn't carry ${res.remaining} ${name}${res.remaining === 1 ? "" : "s"} and had nowhere to drop it.`);
      return { ok: false, added: res.added, dropped: 0, remaining: res.remaining };
    }
  }

  return { ok: true, added: res.added, dropped: 0, remaining: 0 };
}

function addItemOrDrop(inv, itemId, qty, dropX, dropY, logName = null) {
  const pName = logName ?? activePlayer().name;
  const name = itemDef(itemId)?.name ?? itemId;

  const res = addItem(inv, itemId, qty);
  if (res.remaining > 0) {
    const spot = findDropSpotNear(dropX, dropY, itemId, 4);
    if (spot) {
      dropItemOnTile(itemId, res.remaining, spot.x, spot.y);
      logAction(`${pName} couldn't carry ${res.remaining} ${name}${res.remaining === 1 ? "" : "s"} and dropped it at (${spot.x},${spot.y}).`);
      return { ...res, dropped: res.remaining, remaining: 0 };
    } else {
      logAction(`${pName} couldn't carry ${res.remaining} ${name}${res.remaining === 1 ? "" : "s"} and had nowhere to drop it.`);
      return { ...res, dropped: 0 };
    }
  }
  return { ...res, dropped: 0 };
}

function removeItem(inv, itemId, qty) {
  qty = Math.max(0, Math.floor(qty || 0));
  if (qty <= 0) return true;

  // verify we actually have enough across all stacks
  const have = getQty(inv, itemId);
  if (have < qty) return false;

  // remove across stacks (back-to-front so splices are safe)
  let left = qty;
  for (let i = inv.length - 1; i >= 0 && left > 0; i--) {
    const st = inv[i];
    if (!st || st.id !== itemId) continue;

    const take = Math.min(left, st.qty ?? 0);
    st.qty -= take;
    left -= take;

    if ((st.qty ?? 0) <= 0) inv.splice(i, 1);
  }

  return left === 0;
}

function isAdjacentOrSame(ax, ay, bx, by) {
  return (ax === bx && ay === by) || (Math.abs(ax - bx) + Math.abs(ay - by) === 1);
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function musicDebug(msg) {
  console.log(`[MUSIC] ${msg}`, {
    unlocked: state.music?.unlocked,
    enabled: state.music?.enabled,
    ctx: state.music?.contextKey,
    isDay: state.time?.isDay,
    mode: state.mode,
    src: state.music?.audio?.src,
    vol: state.music?.audio?.volume
  });
}

function setMusicVolume(v) {
  v = clamp01(v);
  // store it on state
  state.music.volume = v;

  // apply to active music audio if it exists
  if (state.music?.audio) state.music.audio.volume = v;
}

function getMusicVolume() {
  // default if missing
  const v = (state.music?.volume ?? state.music?.audio?.volume ?? 0.35);
  return clamp01(v);
}

function setMusicEnabled(v) {
  state.music.enabled = !!v;

  // Stop everything immediately if disabled
  if (!state.music.enabled) {
    if (state.music.audio) { try { state.music.audio.pause(); } catch (_) {} }
    if (state.music.ambienceAudio) { try { state.music.ambienceAudio.pause(); } catch (_) {} }
    return;
  }

  // If enabling and already unlocked, resume
  if (state.music.unlocked) {
    playRandomMusicForContext(true);
    playAmbienceForContext(true);
  }
}

// Your UI label says “Ambient enabled” but it toggles state.audio.ambientEnabled.
// We'll keep that and map it to music ambienceEnabled so it actually does something.
function setAmbientEnabled(v) {
  if (!state.audio) state.audio = {};
  state.audio.ambientEnabled = !!v;
  state.music.ambienceEnabled = !!v;

  if (!state.music.ambienceEnabled) {
    if (state.music.ambienceAudio) {
      beginAmbFadeTo(0, state.music.ambienceFadeMs, () => {
        try { state.music.ambienceAudio.pause(); } catch (_) {}
      });
    }
  } else if (state.music.enabled && state.music.unlocked) {
    playAmbienceForContext(true);
  }
}

function drawLeftSidebar() {
  // Full-height sidebar
  drawRect(0, 0, UI_LEFTBAR_W, window.innerHeight, "rgba(0,0,0,0.78)");
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.strokeRect(0, 0, UI_LEFTBAR_W, window.innerHeight);

  const pad = 10;
  const gap = 10;

  const mkBtn = (y) => ({
    x: 8,
    y,
    w: UI_LEFTBAR_W - 16,
    h: UI_LEFTBAR_W - 16
  });

  const compassBtn = mkBtn(UI_TOP_H + pad);
const volBtn = mkBtn(compassBtn.y + compassBtn.h + gap);
const settingsBtn = mkBtn(volBtn.y + volBtn.h + gap);
const collectiblesBtn = mkBtn(settingsBtn.y + settingsBtn.h + gap);

// Only show Edit Mode in interior
const editBtn = (state.mode === "interior")
  ? mkBtn(collectiblesBtn.y + collectiblesBtn.h + gap)
  : null;


  // Draw button helper
const drawBtn = (b, icon, active = false) => {
  if (!b) return;
  drawRect(b.x, b.y, b.w, b.h, active ? "rgba(60,120,60,0.90)" : "rgba(20,20,20,0.92)");
  ctx.strokeStyle = active ? "rgba(120,255,160,0.45)" : "rgba(255,255,255,0.16)";
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  drawText(icon, b.x + b.w / 2, b.y + b.h / 2 + 8, 22, "center", "rgba(255,255,255,0.95)");
};

  drawBtn(compassBtn, "🧭");
  drawBtn(volBtn, "🔊");
  drawBtn(settingsBtn, "⚙️");
  drawBtn(editBtn, "✏️", !!state.interiorEdit?.on);
  drawBtn(collectiblesBtn, "📜", !!state.collectiblesOpen);

  // Save hitboxes
  state._leftbarUI = {
    compassBtn,
    volBtn,
    settingsBtn,
	collectiblesBtn,
	editBtn,
    sliderBox: null,
    sliderTrack: null,
    sliderKnob: null
  };

  // Slider popup (anchored to the volume button)
  if (!state.ui.musicSliderOpen) return;

  const ui = state._leftbarUI;
  const boxW = 220;
  const boxH = 58;

  // Pop to the RIGHT of the sidebar, aligned to the volume button
  const bx = UI_LEFTBAR_W + 8;
  const by = volBtn.y + (volBtn.h / 2) - (boxH / 2);

  drawRect(bx, by, boxW, boxH, "rgba(10,10,10,0.92)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(bx, by, boxW, boxH);

  drawText("Music Volume", bx + 10, by + 16, 13, "left", "rgba(255,255,255,0.9)");

  const track = { x: bx + 10, y: by + 30, w: boxW - 20, h: 10 };
  const vol = getMusicVolume();

  drawRect(track.x, track.y, track.w, track.h, "rgba(255,255,255,0.10)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(track.x, track.y, track.w, track.h);

  drawRect(track.x, track.y, Math.max(2, track.w * vol), track.h, "rgba(255,255,255,0.22)");

  const knobX = track.x + track.w * vol;
  const knob = { x: knobX - 6, y: track.y - 4, w: 12, h: 18 };
  drawRect(knob.x, knob.y, knob.w, knob.h, "rgba(255,255,255,0.22)");
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.strokeRect(knob.x, knob.y, knob.w, knob.h);

  drawText(`${Math.round(vol * 100)}%`, bx + boxW - 10, by + 16, 13, "right", "rgba(255,255,255,0.75)");

  ui.sliderBox = { x: bx, y: by, w: boxW, h: boxH };
  ui.sliderTrack = track;
  ui.sliderKnob = knob;
}

function nowMs() { return performance.now(); }

function beginFadeTo(targetVol, ms, onDone) {
  const a = state.music.audio;
  if (!a) { if (onDone) onDone(); return; }

  const from = (isFinite(a.volume) ? a.volume : 0);
  const to = clamp01(targetVol);
  const dur = Math.max(0, ms | 0);

  state.music._fade = {
    from, to,
    start: nowMs(),
    dur,
    onDone: onDone || null
  };
}

// call every frame
function tickMusicFade() {
  const f = state.music._fade;
  const a = state.music.audio;
  if (!f || !a) return;

  const t = nowMs();
  const p = f.dur <= 0 ? 1 : clamp01((t - f.start) / f.dur);
  a.volume = f.from + (f.to - f.from) * p;

  if (p >= 1) {
    state.music._fade = null;
    if (typeof f.onDone === "function") f.onDone();
  }
}

function ensureAmbienceAudio() {
  if (state.music.ambienceAudio) return state.music.ambienceAudio;

  const a = new Audio();
  a.loop = true;
  a.volume = 0;
  state.music.ambienceAudio = a;
  return a;
}

function getAmbienceKey() {
  // No ambience on title screen or indoors
  if (state.title?.open) return null;
  if (state.mode === "interior") return null;

  const isDay = state.time?.isDay ?? true;
  return isDay ? "day" : "night";
}

function beginAmbFadeTo(targetVol, ms, onDone) {
  const a = state.music.ambienceAudio;
  if (!a) { if (onDone) onDone(); return; }

  const from = (isFinite(a.volume) ? a.volume : 0);
  const to = clamp01(targetVol);
  const dur = Math.max(0, ms | 0);

  state.music._ambFade = {
    from, to,
    start: nowMs(),
    dur,
    onDone: onDone || null
  };
}

function tickAmbienceFade() {
  const f = state.music._ambFade;
  const a = state.music.ambienceAudio;
  if (!f || !a) return;

  const t = nowMs();
  const p = f.dur <= 0 ? 1 : clamp01((t - f.start) / f.dur);
  a.volume = f.from + (f.to - f.from) * p;

  if (p >= 1) {
    state.music._ambFade = null;
    if (typeof f.onDone === "function") f.onDone();
  }
}

function getAmbienceVolume() {
  // Use music slider as the master, scaled down a bit
  return clamp01(getMusicVolume() * (state.music.ambienceGain ?? 0.7));
}

function playAmbienceForContext(force = false) {
  if (!state.music.enabled) return;
  if (!state.music.unlocked) return;
  if (!state.music.ambienceEnabled) return;

  const key = getAmbienceKey();
  if (!key) return;

  const a = ensureAmbienceAudio();

  // already correct and playing
  if (!force && state.music.ambienceKey === key && !a.paused) return;

  // prevent spam during fades / switching
  if (state.music.ambSwitching) {
    state.music.pendingAmbKey = key;
    return;
  }

  state.music.ambSwitching = true;

  const nextSrc = (key === "day")
    ? "src/sounds/ambience_day.mp3"
    : "src/sounds/ambience_night.mp3";

  const startNew = () => {
    a.src = nextSrc;
    a.load();
    a.currentTime = 0;
    a.muted = false;
    a.volume = 0;

    a.play().then(() => {
      // Only commit after playback actually starts
      state.music.ambienceKey = key;

      beginAmbFadeTo(getAmbienceVolume(), state.music.ambienceFadeMs);

      state.music.ambSwitching = false;

      // Catch up if time flipped during the switch
      const nowKey = getAmbienceKey();
      const pending = state.music.pendingAmbKey;
      state.music.pendingAmbKey = null;

      if ((pending && pending !== state.music.ambienceKey) || (nowKey && nowKey !== state.music.ambienceKey)) {
        playAmbienceForContext(true);
      }
    }).catch(() => {
      state.music.ambSwitching = false;
    });
  };

  // fade out current ambience if playing, then swap
  if (!a.paused && a.currentTime > 0 && a.volume > 0.001) {
    beginAmbFadeTo(0, state.music.ambienceFadeMs, () => {
      try { a.pause(); } catch (_) {}
      startNew();
    });
  } else {
    startNew();
  }
}

function pickRandomDungeonTrack(lastTrack = null) {
  let name;

  do {
    const n = Math.floor(Math.random() * DUNGEON_TRACK_COUNT) + 1;
    name = `dungeon${n}`;
  } while (name === lastTrack && DUNGEON_TRACK_COUNT > 1);

  return name;
}

function handleLeftSidebarTap(px, py) {
  const ui = state._leftbarUI;
  if (!ui) return false;

  // Compass
  if (ui.compassBtn && hitRect(px, py, ui.compassBtn)) {
    playSound("click");
    state.coordsOpen = true;
    closeMenu();
    return true;
  }

  // Volume button toggles slider
  if (ui.volBtn && hitRect(px, py, ui.volBtn)) {
    playSound("click");
    state.ui.musicSliderOpen = !state.ui.musicSliderOpen;
    state.ui.musicDragging = false;
    return true;
  }

  // Settings button opens the global Settings modal
if (ui.settingsBtn && hitRect(px, py, ui.settingsBtn)) {
  playSound("click");
  openSettingsDialog("audio"); // default tab
  return true;
}

// Collectibles archive
if (ui.collectiblesBtn && hitRect(px, py, ui.collectiblesBtn)) {
  playSound("click");
  state.collectiblesOpen = !state.collectiblesOpen;
  state.collectiblesView = "list";
  state.collectiblesSelected = null;
  state.collectiblesScroll = 0;

  // Don’t let other UI overlap
  closeMenu();
  state.coordsOpen = false;
  state.stockpileOpen = null;

  return true;
}

  // Interior Edit Mode toggle
  if (ui.editBtn && hitRect(px, py, ui.editBtn)) {
    playSound("click");
    state.interiorEdit.on = !state.interiorEdit.on;

    // Don’t let other UI overlap
    closeMenu();
    state.coordsOpen = false;
    state.stockpileOpen = null;

    return true;
  }

  // If slider is open, allow clicking the track to set volume or clicking outside to close.
  if (state.ui.musicSliderOpen) {
    if (ui.sliderBox && hitRect(px, py, ui.sliderBox)) {
      if (ui.sliderTrack && hitRect(px, py, ui.sliderTrack)) {
        const t = ui.sliderTrack;
        const v = (px - t.x) / t.w;
        setMusicVolume(v);
        state.ui.musicDragging = true;
      }
      return true;
    }

    // click outside closes it
    state.ui.musicSliderOpen = false;
    state.ui.musicDragging = false;
    return true;
  }

  return false;
}

function handleLeftSidebarDrag(px, py) {
  if (!state.ui.musicSliderOpen) return false;
  if (!state.ui.musicDragging) return false;

  const ui = state._leftbarUI;
  if (!ui?.sliderTrack) return false;

  const t = ui.sliderTrack;
  const v = (px - t.x) / t.w;
  setMusicVolume(v);
  return true;
}

function contributeMaterialToProject(stageId, proj, inv, itemId, qty, who) {
  qty = Math.max(0, Math.floor(qty || 0));
  if (qty <= 0) return 0;

  // clamp to what this stage still needs
  const remaining = buildRemainingStage(stageId, proj.mats);
  const need = remaining?.[itemId] ?? 0;
  if (need <= 0) return 0;

  const give = Math.min(qty, need, getQty(inv, itemId));
  if (give <= 0) return 0;

  // actually remove from inventory (multi-stack safe now)
  const ok = removeItem(inv, itemId, give);
  if (!ok) return 0;
  
    // ✅ concrete consumes a bucket: give empty bucket(s) back
  if (itemId === "concrete") {
    addItem(inv, "bucket", give);
  }

  proj.mats = proj.mats || {};
  proj.mats[itemId] = (proj.mats[itemId] || 0) + give;

  proj.contribLog = proj.contribLog || [];
  proj.contribLog.push({ who, itemId, qty: give, t: Date.now() });

  return give;
}

function withdrawMaterialFromProject(proj, inv, itemId, qty, dropX, dropY, who) {
  qty = Math.max(0, Math.floor(qty || 0));
  if (qty <= 0) return 0;

  const have = proj.mats?.[itemId] || 0;
  const take = Math.min(qty, have);
  if (take <= 0) return 0;

  // addItem returns an object; only subtract what was actually added
  const res = addItem(inv, itemId, take);
  const added = res?.added ?? 0;
  if (added <= 0) return 0;

  proj.mats[itemId] = have - added;
  if (proj.mats[itemId] <= 0) delete proj.mats[itemId];

  proj.contribLog = proj.contribLog || [];
  proj.contribLog.push({ who, itemId, qty: -added, t: Date.now() });

  // optional: if inventory was full, drop the remainder at the build tile
  const remaining = (res?.remaining ?? 0);
  if (remaining > 0 && typeof dropItemOnTile === "function") {
    dropItemOnTile(itemId, remaining, dropX, dropY);
    // NOTE: we did NOT subtract "remaining" from proj.mats, because it never left the project.
  }

  return added;
}

function placeBuildSite(x, y) {
  const map = state.world;
  if (!map || !map.objects) return false;

  const size = BUILD_FOOTPRINT;
  const h = map.objects.length;
  const w = map.objects[0].length;

  // Bounds + occupancy check
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const yy = y + dy;
      const xx = x + dx;

      if (yy < 0 || yy >= h || xx < 0 || xx >= w) return false;
      if (map.objects[yy][xx] !== null) return false;
    }
  }

  const key = `${x},${y}`;

  // Place anchor object (top-left of footprint)
  map.objects[y][x] = {
    id: "build_site",
    hp: 999,
    meta: { key }
  };

  // Register build project
  state.buildProjects[key] = {
    stageId: "build_site",
    mats: {},
    building: false,
    timeLeft: 0,
    builders: []
  };

  logAction(`${activePlayer().name} placed a build site.`);
  return true;
}

// ---------------------------------------------- Settings Modal ----
function openSettingsDialog(tab = "audio") {
  state.settingsOpen = true;
  state.settingsTab = (tab === "controls") ? "controls" : "audio";
  state.settingsDrag = null;
  state._settingsUI = null;
  closeMenu();
  state.ui.musicSliderOpen = false;
  state.ui.musicDragging = false;

  // Don’t let other modals overlap
  state.coordsOpen = false;
  state.stockpileOpen = null;
}

function closeSettingsDialog() {
  state.settingsOpen = false;
  state.settingsDrag = null;
  state._settingsUI = null;
}

function drawSlider(label, x, y, w, value01) {
  drawText(label, x, y + 10, 13, "left", "rgba(255,255,255,0.90)");

  const track = { x, y: y + 18, w, h: 10 };
  drawRect(track.x, track.y, track.w, track.h, "rgba(255,255,255,0.10)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(track.x, track.y, track.w, track.h);

  const fillW = Math.max(2, track.w * clamp01(value01));
  drawRect(track.x, track.y, fillW, track.h, "rgba(255,255,255,0.22)");

  const knobX = track.x + track.w * clamp01(value01);
  const knob = { x: knobX - 6, y: track.y - 4, w: 12, h: 18 };
  drawRect(knob.x, knob.y, knob.w, knob.h, "rgba(255,255,255,0.22)");
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.strokeRect(knob.x, knob.y, knob.w, knob.h);

  drawText(`${Math.round(clamp01(value01) * 100)}%`, x + w + 10, y + 26, 12, "left", "rgba(255,255,255,0.70)");

  return { track, knob };
}

function drawCheckbox(label, x, y, checked) {
  const box = { x, y, w: 18, h: 18 };
  drawRect(box.x, box.y, box.w, box.h, "rgba(255,255,255,0.08)");
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.strokeRect(box.x, box.y, box.w, box.h);

  if (checked) {
    drawText("✓", box.x + box.w / 2, box.y + box.h / 2 + 6, 16, "center", "rgba(255,255,255,0.90)");
  }

  drawText(label, box.x + box.w + 10, box.y + box.h / 2 + 6, 13, "left", "rgba(255,255,255,0.90)");
  return { box, label: { x: box.x + box.w + 10, y: box.y, w: 240, h: box.h } };
}

function drawSettingsModal() {
  if (!state.settingsOpen) return;

  const W = Math.min(820, window.innerWidth - 40);
  const H = Math.min(520, window.innerHeight - 40);
  const x = Math.floor((window.innerWidth - W) / 2);
  const y = Math.floor((window.innerHeight - H) / 2);

  // Backdrop
  drawRect(0, 0, window.innerWidth, window.innerHeight, "rgba(0,0,0,0.55)");

  // Panel
  drawRect(x, y, W, H, "rgba(10,10,10,0.92)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(x, y, W, H);

  // Header
  drawText("Settings", x + 14, y + 18, 18, "left", "rgba(255,255,255,0.95)");

  const close = { x: x + W - 44, y: y + 10, w: 34, h: 26 };
  drawRect(close.x, close.y, close.w, close.h, "rgba(255,255,255,0.10)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(close.x, close.y, close.w, close.h);
  drawText("X", close.x + close.w / 2, close.y + close.h / 2 + 5, 14, "center", "rgba(255,255,255,0.85)");

  // Tabs (left rail)
  const tabW = 170;
  const tabX = x + 12;
  const tabY = y + 46;
  const tabH = 38;

  const audioTab = { x: tabX, y: tabY, w: tabW, h: tabH };
  const ctrlTab  = { x: tabX, y: tabY + tabH + 10, w: tabW, h: tabH };

  const drawTab = (r, label, active) => {
    drawRect(r.x, r.y, r.w, r.h, active ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.08)");
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    drawText(label, r.x + 10, r.y + r.h / 2 + 6, 14, "left", "rgba(255,255,255,0.90)");
  };

  drawTab(audioTab, "Audio", state.settingsTab === "audio");
  drawTab(ctrlTab, "Controls", state.settingsTab === "controls");

  // Content
  const contentX = x + tabW + 30;
  const contentY = y + 54;
  const contentW = x + W - 16 - contentX;

  const ui = {
    panel: { x, y, w: W, h: H },
    close,
    tabs: { audio: audioTab, controls: ctrlTab },
    sliders: {},
    toggles: {}
  };

  if (state.settingsTab === "audio") {
    drawText("Audio", contentX, contentY, 16, "left", "rgba(255,255,255,0.95)");

    const sx = contentX;
    let yy = contentY + 28;
    const sw = Math.min(380, contentW - 20);

    // Master
    let s = drawSlider("Master Volume", sx, yy, sw, clamp01(state.audio?.master ?? 1));
    ui.sliders.master = { ...s, key: "master" };
    yy += 48;

    // SFX
    s = drawSlider("Sound Effects", sx, yy, sw, clamp01(state.audio?.sfx ?? 1));
    ui.sliders.sfx = { ...s, key: "sfx" };
    yy += 48;

    // Music
    s = drawSlider("Music", sx, yy, sw, clamp01(state.music?.volume ?? 0.35));
    ui.sliders.music = { ...s, key: "music" };
    yy += 48;

    // Ambient
    s = drawSlider("Ambient Sounds", sx, yy, sw, clamp01(state.audio?.ambient ?? 1));
    ui.sliders.ambient = { ...s, key: "ambient" };
    yy += 56;

    // Toggles
    const t1 = drawCheckbox("Music enabled", sx, yy, !!state.music?.enabled);
    ui.toggles.music = { ...t1, key: "musicEnabled" };
    yy += 28;

    const t2 = drawCheckbox("Ambient enabled", sx, yy, !!state.audio?.ambientEnabled);
    ui.toggles.ambient = { ...t2, key: "ambientEnabled" };
    yy += 28;

  } else {
    drawText("Controls", contentX, contentY, 16, "left", "rgba(255,255,255,0.95)");

    const colX = contentX;
    const col2X = contentX + Math.min(340, contentW / 2);
    let yy = contentY + 30;

    // Mobile
    drawText("Mobile (tapping)", colX, yy, 14, "left", "rgba(255,255,255,0.90)");
    yy += 18;
    const mobile = [
      "Tap ground: move",
      "Tap object/item: open actions",
      "Tap left sidebar icons: compass / audio / settings",
      "Drag map: pan camera"
    ];
    for (const line of mobile) {
      drawText(`• ${line}`, colX, yy, 13, "left", "rgba(255,255,255,0.82)");
      yy += 18;
    }

    // PC
    let yy2 = contentY + 30;
    drawText("PC (keyboard & mouse)", col2X, yy2, 14, "left", "rgba(255,255,255,0.90)");
    yy2 += 18;
    const pc = [
      "W/A/S/D: move",
      "Left click: move / interact",
      "Right click: quick harvest/pickup",
      "R: rest toggle",
      "B: place house (build mode)",
      "M: saved coordinates",
      "C: craft/cook (when crafting is open)",
      "Esc: close crafting",
      "E: eat selected inventory food"
    ];
    for (const line of pc) {
      drawText(`• ${line}`, col2X, yy2, 13, "left", "rgba(255,255,255,0.82)");
      yy2 += 18;
    }
  }

  state._settingsUI = ui;
}

function settingsSliderValueFromPx(track, px) {
  if (!track) return 0;
  return clamp01((px - track.x) / track.w);
}

function handleSettingsPointerDown(px, py) {
  if (!state.settingsOpen) return false;
  const ui = state._settingsUI;
  if (!ui) return true;

  // Close if clicked outside panel
  if (!hitRect(px, py, ui.panel)) {
    closeSettingsDialog();
    return true;
  }

  // Close button
  if (ui.close && hitRect(px, py, ui.close)) {
    playSound("click");
    closeSettingsDialog();
    return true;
  }

  // Tabs
  if (ui.tabs?.audio && hitRect(px, py, ui.tabs.audio)) {
    playSound("click");
    state.settingsTab = "audio";
    return true;
  }
  if (ui.tabs?.controls && hitRect(px, py, ui.tabs.controls)) {
    playSound("click");
    state.settingsTab = "controls";
    return true;
  }

  // Sliders (only in audio tab)
  if (state.settingsTab === "audio") {
    for (const s of Object.values(ui.sliders ?? {})) {
      const hit = (s.track && hitRect(px, py, s.track)) || (s.knob && hitRect(px, py, s.knob));
      if (hit) {
        state.settingsDrag = s.key;
        const v = settingsSliderValueFromPx(s.track, px);
        if (s.key === "master") setMasterVolume(v);
        if (s.key === "sfx") setSfxVolume(v);
        if (s.key === "music") setMusicVolume(v);
        if (s.key === "ambient") setAmbientVolume(v);
        return true;
      }
    }

    // Toggles
    const t = ui.toggles ?? {};
    if (t.music && (hitRect(px, py, t.music.box) || hitRect(px, py, t.music.label))) {
      playSound("click");
      setMusicEnabled(!state.music.enabled);
      return true;
    }
    if (t.ambient && (hitRect(px, py, t.ambient.box) || hitRect(px, py, t.ambient.label))) {
      playSound("click");
      setAmbientEnabled(!state.audio.ambientEnabled);
      return true;
    }
  }

  return true;
}

function handleSettingsDrag(px, py) {
  if (!state.settingsOpen) return false;
  if (!state.settingsDrag) return false;

  const ui = state._settingsUI;
  if (!ui) return true;

  const target = Object.values(ui.sliders ?? {}).find(v => v.key === state.settingsDrag);
  if (!target) return true;

  const v = settingsSliderValueFromPx(target.track, px);
  if (state.settingsDrag === "master") setMasterVolume(v);
  if (state.settingsDrag === "sfx") setSfxVolume(v);
  if (state.settingsDrag === "music") setMusicVolume(v);
  if (state.settingsDrag === "ambient") setAmbientVolume(v);

  return true;
}

function handleSettingsPointerUp() {
  if (!state.settingsOpen) return false;
  state.settingsDrag = null;
  return true;
}

// ---- Camera math ----------------------------------------------------------------------------------------
function viewTiles() {
  // Reserve space for left sidebar + right-side log panel + a small safe pad
  const LOG_PANEL_W = 440; // matches log width + padding
  const SAFE_PAD = 16;

  const usableW = window.innerWidth - UI_LEFTBAR_W - LOG_PANEL_W - SAFE_PAD;
  const usableH = window.innerHeight - UI_TOP_H - UI_BOTTOM_H;

  const viewW = Math.floor(usableW / TILE_SIZE);
  const viewH = Math.floor(usableH / TILE_SIZE);

  return {
    viewW: Math.max(6, viewW),
    viewH: Math.max(6, viewH),
  };
}

function clampCamera() {
  const { w, h } = currentDims();
  const { viewW, viewH } = viewTiles();
  state.cam.x = Math.max(0, Math.min(state.cam.x, w - viewW));
  state.cam.y = Math.max(0, Math.min(state.cam.y, h - viewH));
}

function ensureCameraEdgeScroll() {
  // scroll by 1 tile when player hits screen edge
  const p = activePlayer();
  const { w, h } = currentDims();
  const { viewW, viewH } = viewTiles();

  const left = state.cam.x;
  const top = state.cam.y;
  const right = state.cam.x + viewW - 1;
  const bottom = state.cam.y + viewH - 1;

  let moved = false;
  if (p.x <= left && left > 0) { state.cam.x -= 1; moved = true; }
  if (p.x >= right && right < w - 1) { state.cam.x += 1; moved = true; }
  if (p.y <= top && top > 0) { state.cam.y -= 1; moved = true; }
  if (p.y >= bottom && bottom < h - 1) { state.cam.y += 1; moved = true; }

  if (moved) clampCamera();
}

function screenToMap(px, py) {
  const x = Math.floor((px - UI_LEFTBAR_W) / TILE_SIZE) + state.cam.x;
  const y = Math.floor((py - UI_TOP_H) / TILE_SIZE) + state.cam.y;
  return { x, y };
}

function mapToScreen(x, y) {
  const sx = UI_LEFTBAR_W + (x - state.cam.x) * TILE_SIZE;
  const sy = UI_TOP_H + (y - state.cam.y) * TILE_SIZE;
  return { sx, sy };
}

function recenterCameraOnPlayer(pl) {
  if (!pl) return;

  // Center camera so player is in the middle of the screen
  camera.x = pl.x * TILE_SIZE - canvas.width / 2 + TILE_SIZE / 2;
  camera.y = pl.y * TILE_SIZE - canvas.height / 2 + TILE_SIZE / 2;
}

// ---------------------------------------------------------------------------- SOUND FX & MUSIC FUNCTIONS ----
const sounds = {};

function loadSound(name, file, volume = 1) {
  const audio = new Audio(`src/sounds/${file}`);
  audio.volume = volume;
  sounds[name] = audio;
}

function playSound(name) {
  const s = sounds[name];
  if (!s) return;
  s.currentTime = 0;
  s.play().catch(() => {});
}

// -------------------------------------------------------------------------- MUSIC ----

function getMusicContextKey() {

  if (state.mode === "dungeon") {
    return "dungeon";
  }

  if (state.title?.open) return "title";

  const isDay = state.time?.isDay ?? true;
  const indoor = (state.mode === "interior");
  return `${isDay ? "daytime" : "nighttime"}_${indoor ? "indoor" : "outdoor"}`;
}

function ensureMusicAudio() {
  if (state.music.audio) return state.music.audio;
  const a = new Audio();
  a.loop = false;
  a.volume = getMusicVolume();
  state.music.audio = a;

  a.addEventListener("ended", () => {

  if (state.mode === "dungeon") {
    const nextName = pickRandomDungeonTrack(state.music.lastTrack);
    state.music.lastTrack = nextName;

    a.src = `src/music/${nextName}.mp3`;
    a.currentTime = 0;
    a.play().catch(()=>{});
    return;
  }

  playRandomMusicForContext(false);
});

  a.addEventListener("error", () => {
    // if a track fails (missing file), try another
    // (keeps it from getting stuck if you haven't added every number)
    playRandomMusicForContext(false, /*allowRetry*/ true);
  });

  return a;
}

// Call on first user interaction to satisfy autoplay policies
function unlockMusicIfNeeded() {
  if (!state.music.enabled) return;
  if (state.music.unlocked) return;

  const a = ensureMusicAudio();

  // Pick a real track and play it NOW (this is what browsers actually accept).
  const ctxKey = getMusicContextKey();
  state.music.contextKey = ctxKey;

  const prefix = `${ctxKey}`;
  const nextName = pickRandomTrackName(prefix, state.music.lastTrack, state.music.indexMax);
  state.music.lastTrack = nextName;

  a.src = `src/music/${nextName}.mp3`;
  a.currentTime = 0;

  // Start muted, then fade to your slider volume
  a.volume = 0;

  a.play().then(() => {
    state.music.unlocked = true;

    // Fade music in
    beginFadeTo(getMusicVolume(), state.music.fadeMs);

    // Start ambience AFTER unlock so it can play too
    ensureAmbienceAudio();
    playAmbienceForContext(true);
  }).catch((err) => {
    // Still blocked, so stay locked and try again on next interaction
    state.music.unlocked = false;
    console.warn("[MUSIC] unlock play() rejected:", err);
  });
}


// ----------------------------------------------------------------------------
// TITLE MENU (profile + heart + start/continue)
const titleImgs = {
  left: null,
  right: null,
  loaded: false
};

// --------------------------------------------------------------------------- CUTSCENE SLIDES ----
const CUTSCENE_SLIDES = [
  { title: "", text: "Long ago, in a place beyond time and space, there were two souls..." },
  { title: "", text: "They were bound by an imperishable love, taking such joy in the company of one another, that they made a promise to each other..." },
  { title: "", text: "A promise to stay together for all eternity. To learn and grow together as souls, forever side by side..." },
  { title: "", text: "And so, as they embarked on their journey through the realms of Creation, they sought to find each other in every lifetime, so that they might remember the promise they had made to each other..." },
  { title: "", text: "And though the mortal body knows only what it has endured in its short lifespan, they were drawn to each other as if by some unseen force, for the will of the soul is far greater than the mind of man can comprehend..." },
  { title: "", text: "And so in each life, against all odds, they found each other, recognizing one another by the nature of their soul, and they knew that at last, their longing for home had been answered..." },
  { title: "", text: "And they knew... They knew without any doubt because of the way they felt together, even at a distance. They knew because they felt an understanding that was beyond language. They knew, because together, they felt at home..." },
  { title: "", text: "You Are My Home" }
];

// --------------------------------------------------------------------------- TUTORIAL SLIDES ----
const TUTORIAL_SLIDES = [
  { title: "Tutorial 🙂", text: "Welcome! If this is your first time playing You Are My Home, don't worry- this game is very simple! But here's some tips to get you started..." },
  { title: "Movement 🚶‍♂️‍➡️", text: "To move around on the map, click or tap where you want to go! If you're using a computer with a keyboard, you can also move with W, A, S, D." },
  { title: "Stamina ⚡️", text: "Moving and performing certain actions costs stamina. You can rest at any time to recover stamina! Just tap or click on your character to access the character menu, and choose rest! On a keyboard, you can use the R key." },
  { title: "Items & Resources 🪵", text: "There are many items and resources with various purposes scattered accross the map. You can use these items for crafting, cooking, and more! You can harvest resources and pick up items by tapping or clicking on them and choosing from the options in the menu! Just make sure you're equipped with the right tool for the job!" },
  { title: "Crafting and Cooking 🛠", text: "Crafting can be done from the Workbench. Cooking can be done from a Campfire or a Stove. You'll find various crafting and cooking recipes as you explore, but feel free to try out your own creations!" },
  { title: "Home Construction 🔨", text: "Once you've obtained a complete blueprint and the proper resources, you can build and customize a house!" },
  { title: "Inventory 💼", text: "Inventory space is limited, so manage your items wisely! If you run out of space, you can create a Stockpile to safely store your items anywhere!" },
  { title: "Hunger 🍎", text: "Your character will become hungry after a while, so keep an eye on the hunger meter and be on the lookout for delicious snacks! If you get too hungry, you'll lose stamina!" },
  { title: "Locations & Travel 🧭", text: "If you ever feel lost, you can always access the Location Markers by clicking on the Compass or pressimg M on a keyboard. Certain map objects will automatically be marked for your convenience. Additionally, you can manually mark any location on the map!" },
  { title: "Survive Together 👫", text: "Explore, build, thrive. And remember, everything is better together! 😉." }
];

function loadTitleImages() {
  if (titleImgs.loaded) return;
  titleImgs.loaded = true;

  titleImgs.left = new Image();
  titleImgs.right = new Image();

  titleImgs.left.src = "src/images/heart_left.png";
  titleImgs.right.src = "src/images/heart_right.png";
}

loadTitleImages();

function loadWantTutorial() {
  try {
    const v = localStorage.getItem(WANT_TUTORIAL_KEY);
    return v === null ? null : (v === "1");
  } catch (_) {
    return null;
  }
}
function saveWantTutorial(v) {
  try { localStorage.setItem(WANT_TUTORIAL_KEY, v ? "1" : "0"); } catch (_) {}
}

function lerp(a, b, t) { return a + (b - a) * t; }

function approachVel(p, tx, ty, accel, damp) {
  const dx = tx - p.x;
  const dy = ty - p.y;

  // accelerate toward target
  p.vx += dx * accel;
  p.vy += dy * accel;

  // damping (prevents infinite speed)
  p.vx *= damp;
  p.vy *= damp;

  p.x += p.vx;
  p.y += p.vy;
}

function drawGlowOrb(x, y, r, alpha = 1) {
  // Outer glow
  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 6);
  g.addColorStop(0.0, `rgba(255,255,255,${0.35 * alpha})`);
  g.addColorStop(0.2, `rgba(255,255,255,${0.20 * alpha})`);
  g.addColorStop(1.0, `rgba(255,255,255,0)`);

  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 6, 0, Math.PI * 2);
  ctx.fill();

  // Inner core
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = `rgba(255,255,255,${0.95 * alpha})`;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  // Tiny hot center
  ctx.fillStyle = `rgba(255,255,255,${0.85 * alpha})`;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function loadWantCutscene() {
  try {
    const v = localStorage.getItem(WANT_CUTSCENE_KEY);
    return v === null ? null : (v === "1");
  } catch (_) {
    return null;
  }
}
function saveWantCutscene(v) {
  try { localStorage.setItem(WANT_CUTSCENE_KEY, v ? "1" : "0"); } catch (_) {}
}

function loadCutsceneSeen() {
  try { return localStorage.getItem(CUTSCENE_SEEN_KEY) === "1"; } catch (_) { return false; }
}
function saveCutsceneSeen(v) {
  try { localStorage.setItem(CUTSCENE_SEEN_KEY, v ? "1" : "0"); } catch (_) {}
}

function loadTutorialSeen() {
  try { return localStorage.getItem(TUTORIAL_SEEN_KEY) === "1"; } catch (_) { return false; }
}

function saveTutorialSeen(v) {
  try { localStorage.setItem(TUTORIAL_SEEN_KEY, v ? "1" : "0"); } catch (_) {}
}

function loadSavedProfile() {
  try { return localStorage.getItem(PROFILE_KEY); } catch (_) { return null; }
}
function saveProfile(id) {
  try { localStorage.setItem(PROFILE_KEY, id); } catch (_) {}
}

// Call this ONLY from a real user gesture (click/tap on title menu)
function titleStartOrContinue() {
  // Close title overlay and begin music
  state.title.open = false;
  state.title._ui = null;

  // Close any stray UI
  state.ui.musicSliderOpen = false;
  state.ui.musicDragging = false;
  closeMenu();
  state.coordsOpen = false;
  state.stockpileOpen = null;

  // Hard mark unlocked (we're inside a user gesture)
  state.music.unlocked = true;

  // Start the contextual music now
  playRandomMusicForContext(true);
}

function updateTitleMenu(dt) {
  if (!state.title.open) return;

  if (state.title.phase === "intro") {
    const speed = 1 / 1.1; // ~1.1s open
    state.title.openP = clamp01(state.title.openP + dt * speed);

    if (state.title.openP >= 1) {
      state.title.phase = "menu";
    }
  }
}

function updateBuildTimers(dt) {
  if (!state.world?.objects) return;

  for (const key of Object.keys(state.buildProjects)) {
    const proj = state.buildProjects[key];
    if (!proj?.building) continue;

    const [x, y] = key.split(",").map(Number);

    // Builder list: active builders only (must be near and have stamina)
    const builders = state.players.filter(p => proj.builders?.includes(p.id));
    if (!builders.length) {
      stopBuildTimer(key);
      continue;
    }

   // Interrupt rules (pause if any builder is too far or exhausted)
let paused = false;
for (const p of builders) {
  const tooFar = Math.abs(p.x - x) > 1 || Math.abs(p.y - y) > 1;
  if (tooFar || p.stamina <= 0) {
    paused = true;
    break;
  }
  p.stamina = Math.max(0, p.stamina - BUILD_STAMINA_COST_PER_SEC * dt);
}
if (paused) {
  stopBuildTimer(key);
  logAction(`Building paused.`);
  continue;
}

    // Coop speed: 25% faster if 2 builders
    const speed = builders.length > 1 ? 1.25 : 1;

    proj.timeLeft -= dt * speed;

    if (proj.timeLeft <= 0) {
      finishBuildStage(key, x, y);
    }
  }
}

function loadCollectiblesFound() {
  try {
    const raw = localStorage.getItem(COLLECTIBLES_FOUND_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  } catch (_) {
    return {};
  }
}

function saveCollectiblesFound(obj) {
  try { localStorage.setItem(COLLECTIBLES_FOUND_KEY, JSON.stringify(obj || {})); } catch (_) {}
}

// Record a collectible as found by a player (keeps counts per player)
function markCollectibleFound(itemId, playerName) {
  if (!state.collectiblesFound) state.collectiblesFound = {};
  const entry = state.collectiblesFound[itemId] ?? { by: {}, firstAt: Date.now() };

  if (!entry.by || typeof entry.by !== "object") entry.by = {};
  entry.by[playerName] = (entry.by[playerName] ?? 0) + 1;

  state.collectiblesFound[itemId] = entry;
  saveCollectiblesFound(state.collectiblesFound);
}

function isCollectible(itemId) {
  const it = itemDef(itemId);
  return Array.isArray(it?.tags) && it.tags.includes("collectible");
}

function allCollectibleIds() {
  return Object.keys(state.data.items).filter(id => isCollectible(id));
}

function easeInOutCubic(t) {
  t = Math.max(0, Math.min(1, t));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function drawRoundedRect(x, y, w, h, r, fill, stroke) {
  r = Math.max(0, Math.min(r, Math.min(w, h) / 2));

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }

  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }

  ctx.restore();
}

function drawHeartOpening(cx, cy, size, p, opts) {
  opts = opts || {};
  const showPanel = opts.showPanel !== false;
  const showText = opts.showText !== false;

  const t = easeInOutCubic(p);

// animated opening distance (delay so panel has time to appear)
const splitT = clamp01((t - 0.08) / 1.10);   // <-- 0.08 delays separation
const split = size * 0.34 * easeInOutCubic(splitT) + size * 0.003;

const insetNow = 0;

// CLOSED fit offset: makes the halves meet at p=0
// tweak 0.18 if needed (0.14..0.24)
const closedInset = size * 0.18;

  // Panel behind
  const panelW = size * 0.78;
  const panelH = size * 0.50;

  // Text fade
  const textA = showText ? Math.max(0, Math.min(1, (t - 0.35) / 0.65)) : 0;

  // Shadow
  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  ctx.ellipse(cx, cy + size * 0.48, size * 0.45, size * 0.16, 0, 0, Math.PI * 2);
  ctx.fillStyle = "black";
  ctx.fill();
  ctx.restore();

// Panel (grow from center for "origami unfolding")
if (showPanel) {

  // --- TIMING CONTROLS ---
  // When the panel STARTS appearing (relative to heart opening)
  // 0.00 = instantly
  // 0.10 = slight delay (nice)
  // 0.20 = more dramatic pause
  const startDelay = 0.09;

  // How long the unfold animation lasts
  // smaller = faster snap open
  // bigger  = slower, smoother reveal
  const unfoldDuration = 0.75;

  // Normalized growth progress (0 → 1)
  const g = clamp01((t - startDelay) / unfoldDuration);

  // Smoothed easing (makes it feel organic instead of robotic)
  const gg = easeInOutCubic(g);

  // --- SIZE CONTROLS ---
  // Width-only unfold (height stays constant)
  const curW = panelW * gg;
  const curH = panelH;

  // --- POSITION CONTROLS ---
  // X centers on heart
  const px = cx - curW / 2;

  // Y centers vertically, with slight downward offset
  // Increase 0.02 → moves panel downward
  const py = cy - curH / 2 + size * 0.04;

  // --- VISUAL CONTROLS ---
  // Fade-in tied to growth so it doesn't pop
  const a = 0.95 * gg;

  // --- DRAW ---
  drawRoundedRect(
    px, py,
    curW, curH,
    14,
    `rgba(255, 210, 210, ${a})`,
    `rgba(255,255,255, ${0.25 * gg})`
  );
}

  // Text
  if (textA > 0) {
    ctx.save();
    ctx.globalAlpha = textA;
    drawText("You are", cx, cy - size * 0.08, 28, "center", "rgba(40,20,35,0.95)", TITLE_FONT);
drawText("my",     cx, cy + size * 0.04, 28, "center", "rgba(40,20,35,0.95)", TITLE_FONT);
drawText("home!",  cx, cy + size * 0.16, 28, "center", "rgba(40,20,35,0.95)", TITLE_FONT);
    ctx.restore();
  }

  // Ensure images are loading
  if (typeof loadTitleImages === "function") loadTitleImages();

  const leftImg = titleImgs.left;
  const rightImg = titleImgs.right;

  const leftOK = leftImg && leftImg.complete && leftImg.naturalWidth > 0;
  const rightOK = rightImg && rightImg.complete && rightImg.naturalWidth > 0;

  // Draw image centered at cx,cy with max-dimension = size
function drawLeftHalf(img, seamX) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;

  const scale = size / Math.max(iw, ih);
  const w = iw * scale;
  const h = ih * scale;

  // LEFT half seam is at the RIGHT edge of the image
  const x = seamX - w;   // right edge sits on seamX
  const y = cy - h / 2;
  ctx.drawImage(img, x, y, w, h);
}

function drawRightHalf(img, seamX) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;

  const scale = size / Math.max(iw, ih);
  const w = iw * scale;
  const h = ih * scale;

  // RIGHT half seam is at the LEFT edge of the image
  const x = seamX;       // left edge sits on seamX
  const y = cy - h / 2;
  ctx.drawImage(img, x, y, w, h);
}

const seamX = cx;
const leftSeamX  = seamX - split;
const rightSeamX = seamX + split;


if (leftOK)  drawLeftHalf(leftImg, leftSeamX);
else         drawRect(leftSeamX - size * 0.42, cy - size * 0.32, size * 0.42, size * 0.64, "#ffd2d2");

if (rightOK) drawRightHalf(rightImg, rightSeamX);
else         drawRect(rightSeamX, cy - size * 0.32, size * 0.42, size * 0.64, "#ffd2d2");

  // Debug: once per draw, show why it’s not using images
  // (Remove after it works.)
  if (!leftOK || !rightOK) {
    ctx.save();
    ctx.globalAlpha = 0.7;
    drawText(
      `heart imgs: L=${leftOK ? "OK" : "no"} R=${rightOK ? "OK" : "no"}`,
      cx, cy + size * 0.62, 12, "center", "rgba(255,255,255,0.8)"
    );
    ctx.restore();
  }
}

function drawTitleMenu() {
  if (!state.title.open) return;

  // Dim background
  drawRect(0, 0, window.innerWidth, window.innerHeight, "rgba(0,0,0,0.75)");

  const cx = Math.floor(window.innerWidth / 2);
  const cy = 170;
  const size = 220;
  const TITLE_Y_OFF = 40;

  // Build hit rects
  state.title._ui = {
    heartBtn: null,
    startBtn: null,
    scottBtn: null,
    cristinaBtn: null,
	cutsceneToggle: null,
    tutorialToggle: null
  };

  // Heart clickable area (rough but works well)
  state.title._ui.heartBtn = {
    x: cx - size * 0.55,
    y: cy - size * 0.55,
    w: size * 1.10,
    h: size * 1.10
  };

  // CLOSED: full heart only, no text, no panel, no menu
  if (state.title.phase === "closed") {
    drawHeartOpening(cx, cy + TITLE_Y_OFF, size, 0, { showPanel: false, showText: false });
    drawText("Click the heart", cx, cy + 150, 14, "center", "rgba(255,255,255,0.65)");
    return;
  }

  // INTRO/MENU/PICK: show opening heart with panel/text
  drawHeartOpening(cx, cy + TITLE_Y_OFF, size, state.title.openP, { showPanel: true, showText: true });

  // Message below heart (appears after click)
  const msgY = cy + 150;
  if (state.title.phase !== "closed") {
    // optional: fade in as it opens
    const msgA = 0.20 + 0.80 * state.title.openP; // 0.2 → 1.0
    drawText(
      "Dedicado ao amor da minha existência, Cristina.",
      cx,
      msgY,
      14,
      "center",
      `rgba(255,255,255,${0.65 * msgA})`
    );
  }

 // Checkboxes (placed BELOW the message so they can't overlap)
const cbSize = 16;
let cbY = msgY + 26;

// STORY checkbox (only after first watch)
state.title._ui.cutsceneToggle = null;
if (state.cutscene.seen) {
  state.title._ui.cutsceneToggle = { x: cx - 110, y: cbY, w: 220, h: cbSize + 6 };

  drawRect(cx - 110, cbY, cbSize, cbSize, "rgba(30,30,30,0.95)");
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.strokeRect(cx - 110, cbY, cbSize, cbSize);

  if (state.wantCutscene) {
    drawText("✓", (cx - 110) + (cbSize / 2), cbY + 13, 16, "center", "#fff");
  }

  drawText("View Story", cx - 80, cbY + 13, 14, "left", "rgba(255,255,255,0.85)");
  cbY += 22;
}

// TUTORIAL checkbox (only after first watch)
state.title._ui.tutorialToggle = null;
if (state.tutorial.seen) {
  state.title._ui.tutorialToggle = { x: cx - 110, y: cbY, w: 220, h: cbSize + 6 };

  drawRect(cx - 110, cbY, cbSize, cbSize, "rgba(30,30,30,0.95)");
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.strokeRect(cx - 110, cbY, cbSize, cbSize);

  if (state.wantTutorial) {
    drawText("✓", (cx - 110) + (cbSize / 2), cbY + 13, 16, "center", "#fff");
  }

  drawText("View Tutorial", cx - 80, cbY + 13, 14, "left", "rgba(255,255,255,0.85)");
}

  // Don’t show any buttons until fully open
  if (state.title.openP < 1) return;

  const saved = state.title.savedProfile;
  const isPick = (state.title.phase === "pick");
  const mainLabel = saved ? "Continue" : "Start Game";

  if (!isPick) {
    const bw = 220, bh = 44;
    const bx = cx - bw / 2;

    // Start button placed BELOW checkbox so it never overlaps
    const by = cbY + 34;

    drawRect(bx, by, bw, bh, "rgba(30,30,30,0.95)");
    ctx.strokeStyle = "rgba(255,255,255,0.20)";
    ctx.strokeRect(bx, by, bw, bh);
    drawText(mainLabel, cx, by + 29, 18, "center", "rgba(255,255,255,0.92)");

    state.title._ui.startBtn = { x: bx, y: by, w: bw, h: bh };
    return;
  }

  // Pick screen (unchanged)
  drawText("Choose your character", cx, cy + 230, 18, "center", "rgba(255,255,255,0.92)");

  const cardW = 170, cardH = 210;
  const gap = 22;
  const rowY = cy + 250;

  const leftX = cx - cardW - gap / 2;
  const rightX = cx + gap / 2;
  
  

 function drawCard(x, y, label, imgPath) {
  drawRect(x, y, cardW, cardH, "rgba(20,20,20,0.92)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(x, y, cardW, cardH);

  const pad = 12;
  const imgBox = {
    x: x + pad,
    y: y + pad,
    w: cardW - pad * 2,
    h: cardW - pad * 2
  };

  drawRect(imgBox.x, imgBox.y, imgBox.w, imgBox.h, "rgba(0,0,0,0.35)");
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.strokeRect(imgBox.x, imgBox.y, imgBox.w, imgBox.h);

  // --- RAW IMAGE DRAW (no helpers, no cache dependency) ---
  if (!drawCard._cache) drawCard._cache = {};
  let img = drawCard._cache[imgPath];

  if (!img) {
    img = new Image();
    img.src = imgPath;
    drawCard._cache[imgPath] = img;
  }

  if (img.complete && img.naturalWidth > 0) {
    const scale = Math.min(imgBox.w / img.width, imgBox.h / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const dx = imgBox.x + (imgBox.w - w) / 2;
    const dy = imgBox.y + (imgBox.h - h) / 2;
    ctx.drawImage(img, dx, dy, w, h);
  }

  drawText(label, x + cardW / 2, y + cardH - 16, 16, "center", "rgba(255,255,255,0.92)");
}

  drawCard(leftX, rowY, "Scott", "src/images/scott_thumbnail.jpg");
  drawCard(rightX, rowY, "Cristina", "src/images/cristina_thumbnail.jpg");

  state.title._ui.scottBtn = { x: leftX, y: rowY, w: cardW, h: cardH };
  state.title._ui.cristinaBtn = { x: rightX, y: rowY, w: cardW, h: cardH };
}

// ------------------------------------------------------- Title Menu Function -----------
function handleTitleMenuTap(px, py) {
  if (!state.title.open) return false;
  const ui = state.title._ui;
  if (!ui) return true;

  // CLOSED: click heart to begin opening
  if (state.title.phase === "closed") {
    if (ui.heartBtn && hitRect(px, py, ui.heartBtn)) {
      playSound("click"); // ✅ click sfx

      state.title.phase = "intro";
      state.title.openP = 0;

      // Start title music on user gesture
      state.music.unlocked = true;
      playRandomMusicForContext(true);
    }
    return true;
  }

  // If not fully open yet, ignore clicks
  if (state.title.openP < 1) return true;

// Pick phase
if (state.title.phase === "pick") {

  // ONLINE: ignore manual character selection. Server assigns who this tab controls.
  if (state.net?.enabled) {
    state.title.phase = "menu";
    return true;
  }

  // OFFLINE: normal profile pick
  if (ui.scottBtn && hitRect(px, py, ui.scottBtn)) {
    playSound("click");
    saveProfile("scott");
    state.title.savedProfile = "scott";
    state.activePlayer = 0;
    state.title.phase = "menu";
    return true;
  }
  if (ui.cristinaBtn && hitRect(px, py, ui.cristinaBtn)) {
    playSound("click");
    saveProfile("cristina");
    state.title.savedProfile = "cristina";
    state.activePlayer = 1;
    state.title.phase = "menu";
    return true;
  }
  return true;
}


// Cutscene checkbox (toggle) - MUST be before startBtn so clicks don't get eaten
if (ui.cutsceneToggle && hitRect(px, py, ui.cutsceneToggle)) {
  playSound("click");
  state.wantCutscene = !state.wantCutscene;
  saveWantCutscene(state.wantCutscene);
  return true;
}

  // Tutorial checkbox (toggle) - MUST be before startBtn so clicks don't get eaten
  if (ui.tutorialToggle && hitRect(px, py, ui.tutorialToggle)) {
    playSound("click"); // ✅ click sfx

    state.wantTutorial = !state.wantTutorial;
    saveWantTutorial(state.wantTutorial);
    return true;
  }

  // Start/Continue button
  if (ui.startBtn && hitRect(px, py, ui.startBtn)) {
    playSound("click"); // ✅ click sfx

   // FIRST-EVER PLAY: FORCE CUTSCENE, THEN TUTORIAL
if (!state.cutscene.seen) {
  state.cutscene.open = true;
  state.cutscene.index = 0;
  state.cutscene.t = 0;
  state.cutscene._after = "tutorial";
  return true;
}

    // Normal flow
    if (!state.title.savedProfile) {
      state.title.phase = "pick";
      return true;
    }

// If story cutscene is enabled, play it BEFORE tutorial/start
if (state.wantCutscene) {
  state.cutscene.open = true;
  state.cutscene.index = 0;
  state.cutscene.t = 0;
  state.cutscene._after = (state.wantTutorial ? "tutorial" : "start");
  return true;
}

    // If tutorial is enabled, open tutorial instead of starting immediately
    if (state.wantTutorial) {
      state.tutorial.open = true;
      state.tutorial.index = 0;
      return true;
    }

    // Otherwise start game
    titleStartOrContinue();
    return true;
  }

  return true;
}

function drawCutscene() {
  if (!state.cutscene?.open) return;

  const slide = CUTSCENE_SLIDES[state.cutscene.index] || { title: "", text: "" };
  state.cutscene.t = (state.cutscene.t ?? 0) + 1 / 60;

  const t = state.cutscene.t;

  // ---- Background
  drawRect(0, 0, window.innerWidth, window.innerHeight, "rgba(0,0,0,0.85)");

  // Center (declare EARLY so everything can use it)
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;

  // ---- 3D starfield (moving toward camera)
const STAR_COUNT = 140;          // more stars = richer space
const STAR_SPEED = 120;          // pixels/sec toward camera (lower = slower)
const Z_FAR = 1200;              // depth range
const FOV = 420;                 // perspective strength (higher = less extreme)

// init once
if (!state.cutscene.stars || state.cutscene.stars.length !== STAR_COUNT) {
  state.cutscene.stars = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    state.cutscene.stars.push({
      x: (Math.random() * 2 - 1) * window.innerWidth,   // scattered
      y: (Math.random() * 2 - 1) * window.innerHeight,  // scattered
      z: Math.random() * Z_FAR + 1
    });
  }
}

// frame dt (your cutscene advances at ~60fps)
const dt = 1 / 60;

// update + draw
for (const s of state.cutscene.stars) {
  // move toward camera
  s.z -= STAR_SPEED * dt;

  // if passed camera, respawn far away
  if (s.z <= 1) {
    s.x = (Math.random() * 2 - 1) * window.innerWidth;
    s.y = (Math.random() * 2 - 1) * window.innerHeight;
    s.z = Z_FAR;
  }

  // project to screen (centered at cx/cy)
  const px = cx + (s.x / s.z) * FOV;
  const py = cy + (s.y / s.z) * FOV;

  // skip offscreen stars
  if (px < -10 || px > window.innerWidth + 10 || py < -10 || py > window.innerHeight + 10) continue;

  // size/brightness based on depth (nearer stars look brighter and slightly larger)
  const k = 1 - (s.z / Z_FAR); // 0 far -> 1 near
  const size = 1 + k * 2.2;
  const a = 0.15 + k * 0.55;

  drawRect(px, py, size, size, `rgba(255,255,255,${a})`);
}

  // ---- Orbs (leader + follower)
  const roamR = Math.min(window.innerWidth, window.innerHeight) * 0.40;

  // Ensure orb state exists
  if (!state.cutscene.orbs) {
    state.cutscene.orbs = {
      a: { x: cx - 40, y: cy, vx: 0, vy: 0 },
      b: { x: cx + 40, y: cy, vx: 0, vy: 0 },
      init: true
    };
  }

  const orbs = state.cutscene.orbs;

  // Re-init once if needed (or if screen resized wildly you can re-init too)
  if (!orbs.init) {
    orbs.a.x = cx - 40; orbs.a.y = cy;
    orbs.b.x = cx + 40; orbs.b.y = cy;
    orbs.a.vx = orbs.a.vy = 0;
    orbs.b.vx = orbs.b.vy = 0;
    orbs.init = true;
  }

  // Leader target (organic wandering)
  const targetX =
    cx + Math.cos(t * 0.65) * roamR * 0.85 +
    Math.cos(t * 1.40 + 1.7) * roamR * 0.25;

  const targetY =
    cy + Math.sin(t * 0.58) * roamR * 0.65 +
    Math.sin(t * 1.20 + 0.9) * roamR * 0.30;

  // Move leader
  approachVel(orbs.a, targetX, targetY, 0.0022, 0.92);

  // Follower target: behind + playful side wiggle
  const ang = Math.atan2(orbs.a.vy, orbs.a.vx || 0.0001);
  const behind = 44;
  const side = 26;

  const fx =
    orbs.a.x - Math.cos(ang) * behind +
    Math.cos(t * 2.6) * side;

  const fy =
    orbs.a.y - Math.sin(ang) * behind +
    Math.sin(t * 2.2) * side;

  // Move follower
  approachVel(orbs.b, fx, fy, 0.0030, 0.90);

  // Boundaries
  const pad = 30;
  orbs.a.x = clamp(orbs.a.x, pad, window.innerWidth - pad);
  orbs.a.y = clamp(orbs.a.y, pad, window.innerHeight - pad);
  orbs.b.x = clamp(orbs.b.x, pad, window.innerWidth - pad);
  orbs.b.y = clamp(orbs.b.y, pad, window.innerHeight - pad);

// Draw orbs only (no tails)
drawGlowOrb(orbs.a.x, orbs.a.y, 7, 1);
drawGlowOrb(orbs.b.x, orbs.b.y, 6, 0.95);

  // ---- Panel on top
  const boxW = Math.min(640, window.innerWidth - 80);
  const boxH = 300;
  const px = cx - boxW / 2;
  const py = cy - boxH / 2;

  drawRect(px, py, boxW, boxH, "rgba(20,20,20,0.95)");
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.strokeRect(px, py, boxW, boxH);

  const textY = py + 95;
  drawText(slide.title, cx, py + 48, 32, "center", "#fff", TITLE_FONT);
  drawWrappedText(slide.text, cx, textY, boxW - 80, 20, 14, "center", "#fff", BASE_FONT);

  drawText(
    `Scene ${state.cutscene.index + 1} / ${CUTSCENE_SLIDES.length}`,
    cx, py + boxH - 70, 12, "center", "rgba(255,255,255,0.55)", BASE_FONT
  );
  drawText("Click to continue", cx, py + boxH - 38, 14, "center", "rgba(255,255,255,0.75)", BASE_FONT);

  state._cutsceneUI = { x: px, y: py, w: boxW, h: boxH };
}


function drawTutorial() {
  if (!state.tutorial?.open) return;

  const slide = TUTORIAL_SLIDES[state.tutorial.index] || { title: "", text: "" };

  // fullscreen dim
  drawRect(0, 0, window.innerWidth, window.innerHeight, "rgba(0,0,0,0.85)");

  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;

const TITLE_Y_OFF = 40; // move title group down (tweak this number)

  const boxW = Math.min(640, window.innerWidth - 80);
  const boxH = 300;
  const bx = cx - boxW / 2;
  const by = cy - boxH / 2;

  drawRect(bx, by, boxW, boxH, "rgba(20,20,20,0.95)");
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.strokeRect(bx, by, boxW, boxH);

  const textY = by + 95;

drawText(slide.title, cx, by + 48, 32, "center", "#fff", TITLE_FONT);
drawWrappedText(slide.text, cx, textY, boxW - 80, 20, 14, "center", "#fff", BASE_FONT);

  drawText(
    `Slide ${state.tutorial.index + 1} / ${TUTORIAL_SLIDES.length}`,
    cx, by + boxH - 70, 12, "center", "rgba(255,255,255,0.55)", BASE_FONT
  );

  drawText("Click to continue", cx, by + boxH - 38, 14, "center", "rgba(255,255,255,0.75)", BASE_FONT);

  // simple click hitbox (optional)
  state._tutorialUI = { x: bx, y: by, w: boxW, h: boxH };
}

function pickRandomTrackName(prefix, lastName, indexMax) {
  // pick a random numbered track, avoid repeating last track when possible
  // e.g. prefix="daytime_outdoor" -> "daytime_outdoor7"
  const max = Math.max(1, indexMax | 0);
  let tries = 12;

  while (tries-- > 0) {
    const n = 1 + Math.floor(Math.random() * max);
    const name = `${prefix}${n}`;
    if (name !== lastName || max === 1) return name;
  }
  return `${prefix}1`;
}

function playRandomMusicForContext(force = false, allowRetry = false) {
  if (!state.music.enabled) return;
  if (!state.music.unlocked) return;

  const a = ensureMusicAudio();

  // Use pending context if updateMusic set it; otherwise compute now
  const ctxKey = state.music.pendingCtxKey || getMusicContextKey();

  // If we're not forcing, and we're already in the right context and playing, do nothing
  if (!force && state.music.contextKey === ctxKey && !a.paused) return;

  // If we're already switching, don't restart the switch over and over.
  // Just remember the latest desired context and bail.
  if (state.music.switching) {
    state.music.pendingCtxKey = ctxKey;
    return;
  }

  // Lock switching so updateMusic won't spam this during the fade
  state.music.switching = true;

  // IMPORTANT: set context immediately so updateMusic stops retriggering
  state.music.contextKey = ctxKey;
  state.music.pendingCtxKey = null;

  let nextName;

if (ctxKey === "title") {
  // single, fixed title track: src/music/title.mp3
  nextName = "title";
} else {
  const prefix = `${ctxKey}`;
  nextName = pickRandomTrackName(prefix, state.music.lastTrack, state.music.indexMax);
}

state.music.lastTrack = nextName;

  const startNewTrack = () => {
    // Set source. If you implemented setMusicSource() (mp3/wav/ogg), use it.
    if (typeof setMusicSource === "function") {
      setMusicSource(a, nextName);
    } else {
      a.src = `src/music/${nextName}.mp3`;
      a.load();
    }

    a.currentTime = 0;

// Title: start immediately (no fade) + louder
// Others: start silent and fade in normally
const isTitle = (ctxKey === "title");

a.volume = isTitle
  ? Math.min(1, getMusicVolume() * 3.0)  // <-- volume boost (change 2.0 to taste)
  : 0;

a.muted = false;

a.play().then(() => {
  if (!isTitle) {
    beginFadeTo(getMusicVolume(), state.music.fadeMs);
  }

      // Switching complete
      state.music.switching = false;

      // If context changed while we were switching, queue a new switch next tick
      const desired = getMusicContextKey();
      if (desired !== state.music.contextKey) {
        state.music.pendingCtxKey = desired;
      }
    }).catch((err) => {
      console.warn("[MUSIC] play() rejected:", err);

      // Switching complete (even if failed)
      state.music.switching = false;

      // If this failed because file missing, try another track once
      if (!allowRetry) {
        // Keep same context; just pick again
        state.music.pendingCtxKey = state.music.contextKey;
        playRandomMusicForContext(true, true);
      }
    });
  };

  // If something is currently playing, fade it out first, then switch
  if (!a.paused && a.currentTime > 0) {
    beginFadeTo(0, state.music.fadeMs, () => {
      a.pause();
      startNewTrack();
    });
  } else {
    startNewTrack();
  }
}

function updateMusic(dt) {
  if (!state.music.enabled) return;
  if (!state.music.unlocked) return;

  tickMusicFade();
  tickAmbienceFade();

  // --- MUSIC switching ---
  const ctxKey = getMusicContextKey();

  if (state.music.switching) {
    state.music.pendingCtxKey = ctxKey;
  } else if (ctxKey !== state.music.contextKey) {
    state.music.pendingCtxKey = ctxKey;
    playRandomMusicForContext(true);
  }

  // --- AMBIENCE switching (day/night) ---
  if (state.music.ambienceEnabled) {
    const ambKey = getAmbienceKey();

    if (state.music.ambSwitching) {
      state.music.pendingAmbKey = ambKey;
      return;
    }

    if (ambKey && ambKey !== state.music.ambienceKey) {
      state.music.pendingAmbKey = ambKey;
      playAmbienceForContext(true);
    }
  }
}

function withSfx(sfx, fn) {
  return () => {
    // Play unless the callback explicitly says "no"
    const ok = fn?.();
    if (ok !== false) playSound(sfx);
    return ok;
  };
}

function playFootstep() {
  const steps = ["footstepsoutdoor1", "footstepsoutdoor2", "footstepsoutdoor3", "footstepsoutdoor4", "footstepsoutdoor5", "footstepsoutdoor6", "footstepsoutdoor7", "footstepsoutdoor8", "footstepsoutdoor9", "footstepsoutdoor10"];
  playSound(steps[Math.floor(Math.random() * steps.length)]);
}

loadSound("chop", "chop_wood.MP3", 0.25);
loadSound("chest", "chest.mp3", 0.5);
loadSound("pickup", "collect.mp3", 0.6);
loadSound("cook", "cook.mp3", 0.4);
loadSound("cow", "cow.mp3", 0.5);
loadSound("fishingreel", "fishing_reel.mp3", 0.5);
loadSound("hammer", "hammer.mp3", 0.5);
loadSound("water", "water_droplet.mp3", 0.5);
loadSound("pickaxe", "pickaxe.mp3", 0.5);
loadSound("harvest", "rustling.mp3", 0.5);
loadSound("saw", "saw.mp3", 0.5);
loadSound("footstepsindoor", "footsteps_indoor.mp3", 0.25);
loadSound("footstepsoutdoor1", "footsteps_outdoor1.mp3", 0.25);
loadSound("footstepsoutdoor2", "footsteps_outdoor2.mp3", 0.25);
loadSound("footstepsoutdoor3", "footsteps_outdoor3.mp3", 0.25);
loadSound("footstepsoutdoor4", "footsteps_outdoor4.mp3", 0.25);
loadSound("footstepsoutdoor5", "footsteps_outdoor5.mp3", 0.25);
loadSound("footstepsoutdoor6", "footsteps_outdoor6.mp3", 0.25);
loadSound("footstepsoutdoor7", "footsteps_outdoor7.mp3", 0.25);
loadSound("footstepsoutdoor8", "footsteps_outdoor8.mp3", 0.25);
loadSound("footstepsoutdoor9", "footsteps_outdoor9.mp3", 0.25);
loadSound("footstepsoutdoor10", "footsteps_outdoor10.mp3", 0.25);
loadSound("message", "message.mp3", 0.5);
loadSound("notification", "notification.mp3", 0.5);
loadSound("interact", "interact.mp3", 0.5);
loadSound("achievement", "achievement.mp3", 0.25);
loadSound("hunt", "arrow.mp3", 0.5);
loadSound("fillwater", "fill_water.mp3", 0.4);
loadSound("fireburning", "fire.mp3", 0.5);
loadSound("lightfire", "fire_start.mp3", 0.5);
loadSound("extinguish", "extinguish.mp3", 0.5);
loadSound("dig", "dig.mp3", 0.5);
loadSound("day", "day.mp3", 0.15);
loadSound("night", "night.mp3", 0.3);
loadSound("cat", "cat.mp3", 0.4);
loadSound("eat", "eat.mp3", 0.5);
loadSound("click", "click.mp3", 0.75);
loadSound("pop", "pop.mp3", 0.4);
loadSound("unlock", "unlock.mp3", 0.4);

// ----------------------------------------------------------------------------------- WORLD GENERATION ----
function emptyMap(w, h, fillTile) {
  const tiles = Array.from({ length: h }, () => Array.from({ length: w }, () => fillTile));
  const objects = Array.from({ length: h }, () => Array.from({ length: w }, () => null));
  return { tiles, objects };
}

const iconImageCache = {};

function getIconImage(src) {
  if (!iconImageCache[src]) {
    const img = new Image();
    img.src = src;
    iconImageCache[src] = img;
  }
  return iconImageCache[src];
}

function emptyExplored(w, h) {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => false));
}

function growBlob(map, w, h, tileId, seeds, steps) {
  const frontier = [...seeds];
  for (const [sx, sy] of seeds) map.tiles[sy][sx] = tileId;

  for (let i = 0; i < steps; i++) {
    const idx = randInt(0, frontier.length - 1);
    const [x, y] = frontier[idx];
    const [nx, ny] = neighbors4(x, y)[randInt(0, 3)];
    if (!inBounds(nx, ny, w, h)) continue;
    if (map.tiles[ny][nx] !== tileId) {
      map.tiles[ny][nx] = tileId;
      frontier.push([nx, ny]);
    }
  }
}

function placeObjects(map, w, h, objectId, allowTiles, count) {
  let placed = 0;
  while (placed < count) {
    const x = randInt(1, w - 2);
    const y = randInt(1, h - 2);
    if (map.objects[y][x]) continue;
    if (!allowTiles.includes(map.tiles[y][x])) continue;
    map.objects[y][x] = { id: objectId, hp: objDef(objectId)?.hp ?? 1, meta: {} };
    placed++;
  }
}

function manhattan(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function isMovingAnimalDef(def) {
  // "hunt" animals: you said you tag them hunt; also support an explicit ai flag
  if (!def) return false;
  if (def.ai === "animal") return true;
  if (Array.isArray(def.tags) && def.tags.includes("hunt")) return true;

  // fallback: anything that requires bow_and_arrow to harvest is "huntable" and should move
  const h = def.hunt || def.harvest;
  if (h && h.requiresTool === "bow_and_arrow") return true;

  return false;
}

function isHuntableDef(def) {
  if (!def) return false;
  if (Array.isArray(def.tags) && def.tags.includes("hunt")) return true;
  const h = def.hunt || def.harvest;
  return !!h && h.requiresTool === "bow_and_arrow";
}

function isOccupiedByPlayer(x, y) {
  return state.players.some(p => p.x === x && p.y === y && state.mode === "overworld");
}

function isPassableForAnimal(x, y) {
  const { w, h } = currentDims();
  if (!inBounds(x, y, w, h)) return false;

  const t = tileAt(x, y);
  if (!isWalkableTile(t)) return false;

  if (objectAt(x, y)) return false;
  if (isOccupiedByPlayer(x, y)) return false;

  return true;
}

function getSpawnables() {
  return Object.values(state.data.objects)
    .filter(d => d?.spawn?.enabled)
    .map(d => ({ id: d.id, spawn: d.spawn }));
}

function countObjectsOnOverworld(objectId) {
  const map = state.world;
  let n = 0;
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      if (map.objects[y][x]?.id === objectId) n++;
    }
  }
  return n;
}

function isSpawnTileAllowed(tileId, spawn) {
  if (!spawn?.tiles || spawn.tiles.length === 0) return true;
  return spawn.tiles.includes(tileId);
}

function findRandomEmptyTileForSpawn(spawn) {
  for (let tries = 0; tries < 140; tries++) {
    const x = randInt(1, WORLD_W - 2);
    const y = randInt(1, WORLD_H - 2);

    if (state.world.objects[y][x]) continue;
    if (state.players.some(p => p.x === x && p.y === y)) continue;

    const tileId = state.world.tiles[y][x];
    if (!isSpawnTileAllowed(tileId, spawn)) continue;

    return { x, y };
  }
  return null;
}

function updateCampfires(dt) {
  const map = state.world;
  if (!map?.objects) return;

  for (let y = 0; y < WORLD_H; y++) {
    const row = map.objects[y];
    if (!row) continue;

    for (let x = 0; x < WORLD_W; x++) {
      const obj = row[x];
      if (!obj || obj.id !== "campfire") continue;

      const prev = obj.meta?.fireT ?? 0;
      if (prev <= 0) continue;

      const next = Math.max(0, prev - dt);
      if (next <= 0) {
        row[x] = null;           // was map.objects[y][x] = null
        playSound("extinguish");
      } else {
        obj.meta.fireT = next;
      }
    }
  }
}

function updateSpawns(dt) {
  if (state.mode !== "overworld") return;

  const map = state.world;

  // pulse 4x/sec so we’re not doing extra work every frame
  map._spawnPulse = (map._spawnPulse ?? 0) + dt;
  if (map._spawnPulse < 0.25) return;
  map._spawnPulse = 0;

  const spawnables = getSpawnables();
  if (!spawnables.length) return;

  map._spawnCd = map._spawnCd || {};

  for (const s of spawnables) {
    const interval = Math.max(0.5, s.spawn.intervalSec ?? 10);

    map._spawnCd[s.id] = (map._spawnCd[s.id] ?? (Math.random() * interval)) - 0.25;
    if (map._spawnCd[s.id] > 0) continue;
    map._spawnCd[s.id] = interval;

    const max = Math.max(1, s.spawn.max ?? 20);
    const cur = countObjectsOnOverworld(s.id);
    if (cur >= max) continue;

    // density-aware chance
    const baseChance = s.spawn.chance ?? 0.25;
    const falloff = Math.max(1, s.spawn.falloff ?? 2);

    const density = Math.min(1, Math.max(0, cur / max));
    const mult = Math.pow(1 - density, falloff);
    const effectiveChance = baseChance * mult;

    if (Math.random() > effectiveChance) continue;

    const spot = findRandomEmptyTileForSpawn(s.spawn);
    if (!spot) continue;

    map.objects[spot.y][spot.x] = {
      id: s.id,
      hp: objDef(s.id)?.hp ?? 1,
      meta: {}
    };
  }
}

function updateAnimals(dt) {
  // =========================
  // DUNGEON: only rats wander
  // =========================
  if (state.mode === "dungeon") {
    const map = state.dungeon;
    if (!map?.tiles?.length || !map?.objects?.length) return;

    const H = map.tiles.length;
    const W = map.tiles[0].length;

    // throttle movement so rats don’t jitter every frame
    map._animalTick = (map._animalTick ?? 0) + dt;
    if (map._animalTick < 0.18) return;
    map._animalTick = 0;

    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];

    const playerOccupied = new Set(state.players.map(p => `${p.x},${p.y}`));
    const isFloor = (x, y) => map.tiles?.[y]?.[x] === "floor";

    const canMove = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      if (!isFloor(x, y)) return false;
      if (playerOccupied.has(`${x},${y}`)) return false;

      const o = map.objects?.[y]?.[x];
      if (!o) return true;
      return !objectBlocks(o.id);
    };

    // scan grid for rats
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const obj = map.objects[y][x];
        if (!obj) continue;

        if (obj.id !== "rat1" && obj.id !== "rat2") continue;

        obj.meta = obj.meta || {};
        obj.meta.moveCd = (obj.meta.moveCd ?? (Math.random() * 0.4)) - dt;
        if (obj.meta.moveCd > 0) continue;
        obj.meta.moveCd = 0.25 + Math.random() * 0.35;

        // wander sometimes (same vibe as overworld, no flee logic for rats)
        if (Math.random() < 0.55) continue;

        const candidates = [];
        for (const [dx, dy] of dirs) {
          const nx = x + dx, ny = y + dy;
          if (canMove(nx, ny)) candidates.push([nx, ny]);
        }

        if (!candidates.length) continue;

        const [nx, ny] = candidates[Math.floor(Math.random() * candidates.length)];

        map.objects[ny][nx] = obj;
        map.objects[y][x] = null;
      }
    }

    return;
  }

  // =========================
  // OVERWORLD: existing logic
  // =========================
  if (state.mode !== "overworld") return;

  const { w, h } = currentDims();
  const map = state.world;

  // throttle movement so animals don’t jitter every frame
  map._animalTick = (map._animalTick ?? 0) + dt;
  if (map._animalTick < 0.18) return;
  map._animalTick = 0;

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];

  // scan grid for animals
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const obj = map.objects[y][x];
      if (!obj) continue;

      const def = objDef(obj.id);
      if (!isMovingAnimalDef(def)) continue;

      obj.meta = obj.meta || {};
      obj.meta.moveCd = (obj.meta.moveCd ?? (Math.random() * 0.4)) - dt;
      if (obj.meta.moveCd > 0) continue;
      obj.meta.moveCd = 0.25 + Math.random() * 0.35;

      // find nearest player distance
      let nearest = null;
      let nearestD = Infinity;
      for (const p of state.players) {
        const d = manhattan(x, y, p.x, p.y);
        if (d < nearestD) {
          nearestD = d;
          nearest = p;
        }
      }

      const fleeRadius = 2;

      // decide movement
      let candidates = [];

      // if close, move away (maximize distance)
      if (nearest && nearestD <= fleeRadius) {
        let bestScore = -Infinity;
        for (const [dx, dy] of dirs) {
          const nx = x + dx, ny = y + dy;
          if (!isPassableForAnimal(nx, ny)) continue;
          const score = manhattan(nx, ny, nearest.x, nearest.y);
          if (score > bestScore) {
            bestScore = score;
            candidates = [[nx, ny]];
          } else if (score === bestScore) {
            candidates.push([nx, ny]);
          }
        }
      } else {
        // wander sometimes
        if (Math.random() < 0.55) continue;
        for (const [dx, dy] of dirs) {
          const nx = x + dx, ny = y + dy;
          if (isPassableForAnimal(nx, ny)) candidates.push([nx, ny]);
        }
      }

      if (!candidates.length) continue;

      const [nx, ny] = candidates[Math.floor(Math.random() * candidates.length)];

      // move object
      map.objects[ny][nx] = obj;
      map.objects[y][x] = null;
    }
  }
}

function surroundWithWater(map) {
  for (let x = 0; x < WORLD_W; x++) {
    map.tiles[0][x] = "water";
    map.tiles[WORLD_H - 1][x] = "water";
    map.objects[0][x] = null;
    map.objects[WORLD_H - 1][x] = null;
  }
  for (let y = 0; y < WORLD_H; y++) {
    map.tiles[y][0] = "water";
    map.tiles[y][WORLD_W - 1] = "water";
    map.objects[y][0] = null;
    map.objects[y][WORLD_W - 1] = null;
  }
}

function generateOverworld() {
  const map = emptyMap(WORLD_W, WORLD_H, "grass");

  // some water blobs
  const waterSeeds = Array.from({ length: 3 }, () => [randInt(3, WORLD_W - 4), randInt(3, WORLD_H - 4)]);
  for (const [sx, sy] of waterSeeds) {
    growBlob(map, WORLD_W, WORLD_H, "water", [[sx, sy]], randInt(100, 200));
  }

  // sand near water
  for (let y = 1; y < WORLD_H - 1; y++) {
    for (let x = 1; x < WORLD_W - 1; x++) {
      if (map.tiles[y][x] !== "grass") continue;
      const nearWater = neighbors4(x, y).some(([nx, ny]) =>
        inBounds(nx, ny, WORLD_W, WORLD_H) && map.tiles[ny][nx] === "water"
      );
      if (nearWater && Math.random() < 0.55) map.tiles[y][x] = "sand";
    }
  }

// ---- Fish along coastlines ----
for (let y = 1; y < WORLD_H - 1; y++) {
  for (let x = 1; x < WORLD_W - 1; x++) {
    if (map.tiles[y][x] !== "water") continue;

    const nearLand = neighbors4(x, y).some(([nx, ny]) =>
      inBounds(nx, ny, WORLD_W, WORLD_H) && map.tiles[ny][nx] !== "water"
    );

    if (nearLand && Math.random() < 0.18) {
      map.objects[y][x] = { id: "fish_spot", hp: 1, meta: {} };
    }
  }
}

  // -------------------------------------------------------------------------------- MAP RESOURCES ----
  placeObjects(map, WORLD_W, WORLD_H, "tree1", ["grass"], 20);
  placeObjects(map, WORLD_W, WORLD_H, "tree2", ["grass"], 20);
  placeObjects(map, WORLD_W, WORLD_H, "tree3", ["grass"], 20);
  placeObjects(map, WORLD_W, WORLD_H, "tree4", ["grass"], 20);
  placeObjects(map, WORLD_W, WORLD_H, "tree5", ["grass"], 20);
  placeObjects(map, WORLD_W, WORLD_H, "tree6", ["grass"], 20);
  placeObjects(map, WORLD_W, WORLD_H, "tree7", ["grass"], 20);
  placeObjects(map, WORLD_W, WORLD_H, "tree8", ["grass"], 20);
  placeObjects(map, WORLD_W, WORLD_H, "rock", ["grass", "sand"], 35);
  placeObjects(map, WORLD_W, WORLD_H, "bush", ["grass"], 70);
  placeObjects(map, WORLD_W, WORLD_H, "apple_tree", ["grass"], 20);
  placeObjects(map, WORLD_W, WORLD_H, "berry_bush", ["grass"], 30);
  placeObjects(map, WORLD_W, WORLD_H, "grapevine", ["grass"], 30);
  placeObjects(map, WORLD_W, WORLD_H, "wheat", ["grass"], 40);
  placeObjects(map, WORLD_W, WORLD_H, "cave", ["grass"], 6);

  // free pickups
  placeObjects(map, WORLD_W, WORLD_H, "stick_pickup", ["grass", "sand"], 60);
  placeObjects(map, WORLD_W, WORLD_H, "stone", ["grass", "sand"], 60);
  placeObjects(map, WORLD_W, WORLD_H, "wild_mushrooms", ["grass"], 30);
  placeObjects(map, WORLD_W, WORLD_H, "wild_strawberries", ["grass"], 30);

  // chests
  placeObjects(map, WORLD_W, WORLD_H, "chest", ["grass"], 12);
  placeObjects(map, WORLD_W, WORLD_H, "toolbox", ["grass"], 12);

 // animals (only place if they exist in objects.json)
  if (objDef("deer")) placeObjects(map, WORLD_W, WORLD_H, "deer", ["grass", "sand"], 10);
  if (objDef("squirrel")) placeObjects(map, WORLD_W, WORLD_H, "squirrel", ["grass", "sand"], 15);
  if (objDef("pig")) placeObjects(map, WORLD_W, WORLD_H, "pig", ["grass", "sand"], 10);
  if (objDef("chicken")) placeObjects(map, WORLD_W, WORLD_H, "chicken", ["grass", "sand"], 15);
  if (objDef("cow")) placeObjects(map, WORLD_W, WORLD_H, "cow", ["grass", "sand"], 5);
  if (objDef("cat")) placeObjects(map, WORLD_W, WORLD_H, "cat", ["grass", "sand"], 1);

  // clear spawn pocket (inside water border)
  for (let y = 1; y < 7; y++) for (let x = 1; x < 9; x++) map.objects[y][x] = null;

  // Water boundary ring
  surroundWithWater(map);

  map.explored = emptyExplored(WORLD_W, WORLD_H);
  return map;
}

// ---- Built interior walls that match existing wall style ----
// Drawn in 2 passes: "back" (before players/objects) and "front" (after players) for occlusion.

function drawBuiltInteriorWallsPass(pass) {
  // We only use this for HORIZONTAL interior built walls right now.
  if (state.mode !== "interior") return;
  if (pass !== "front") return;

  const map = state.interior;
  const walls = map?.walls;
  if (!walls || !walls.h) return;

  const { viewW, viewH } = viewTiles();
  const camX = state.cam.x, camY = state.cam.y;

  // Match your interior palette vibe
  const wallOuter = "#3e2a17";
  const wallInner = "#523621";

  // Wall “strip” thickness (this is the ONLY area that should cover sprites)
  const band = Math.floor(TILE_SIZE * 0.35);
  const inset = 2;

  // Simple cap highlight so it reads like a ledge
  const capH = 3;
  const capWood = "rgba(180,120,60,0.55)";
  const capHi   = "rgba(255,255,255,0.16)";
  const capSh   = "rgba(0,0,0,0.28)";

  for (let y = camY; y < camY + viewH; y++) {
    const row = walls.h[y];
    if (!row) continue;

    for (let x = camX; x < camX + viewW; x++) {
      if (!row[x]) continue;

      const sx = UI_LEFTBAR_W + (x - camX) * TILE_SIZE;
      const sy = UI_TOP_H + (y - camY) * TILE_SIZE;

      // Horizontal wall sits on the BOTTOM edge of this tile
      const by = sy + TILE_SIZE;
      const y0 = by - band;

      // CRITICAL: clip to the wall band ONLY
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, y0, TILE_SIZE, band);
      ctx.clip();

      // Wall body
      drawRect(sx, y0, TILE_SIZE, band, wallOuter);
      drawRect(sx + inset, y0 + inset, TILE_SIZE - inset * 2, band - inset * 2, wallInner);

      // Cap (still clipped, so it never “grows” into other tiles)
      drawRect(sx, y0, TILE_SIZE, capH, capWood);
      drawRect(sx, y0, TILE_SIZE, 1, capHi);
      drawRect(sx, y0 + capH - 1, TILE_SIZE, 1, capSh);

      ctx.restore();
    }
  }
}

// --- Hardcoded interiors (ignore localStorage, never persist) ---
const HARDCODED_INTERIORS = {
  // We'll paste house_small layout data here in a minute.
  // house_small: { tiles: [...], walls: {...}, objects: [...] }
};

function generateInterior(interiorId) {
  const def = state.data.interiors[interiorId];
  const map = emptyMap(INTERIOR_W, INTERIOR_H, def.floorTile);

  // walls border (default template)
  for (let x = 0; x < INTERIOR_W; x++) {
    map.tiles[0][x] = def.wallTile;
    map.tiles[INTERIOR_H - 1][x] = def.wallTile;
  }
  for (let y = 0; y < INTERIOR_H; y++) {
    map.tiles[y][0] = def.wallTile;
    map.tiles[y][INTERIOR_W - 1] = def.wallTile;
  }

  // door at bottom middle (default template)
  map.tiles[INTERIOR_H - 1][Math.floor(INTERIOR_W / 2)] = def.doorTile;

  // init wall-edges container (between tiles)
  ensureInteriorWalls(map);
  
    // If this interior is hard-coded, apply it from JSON and return (no persistence)
  if (def?.fixedLayout && def?.layout) {
    if (Array.isArray(def.layout.tiles)) map.tiles = def.layout.tiles;
    if (def.layout.walls) map.walls = def.layout.walls;
    ensureInteriorWalls(map);

    // Objects (anchors only)
    if (Array.isArray(def.layout.objects)) {
      for (const o of def.layout.objects) {
        if (!o) continue;
        const { x, y, id, meta } = o;
        if (!inBounds(x, y, INTERIOR_W, INTERIOR_H)) continue;
       const wTiles = meta?.wTiles ?? (id === "bed" ? 2 : 1);
const hTiles = meta?.hTiles ?? (id === "bed" ? 2 : 1);
stampInteriorObject(map, x, y, id, wTiles, hTiles, meta ?? null);
      }
    }

    return map;
  }

  // HARD-CODED layout wins: ignore saved layouts entirely
  const hard = HARDCODED_INTERIORS[interiorId];
  if (hard) {
    if (Array.isArray(hard.tiles)) map.tiles = hard.tiles;
    if (hard.walls) map.walls = hard.walls;
    ensureInteriorWalls(map);

    // objects (anchors only) -> rebuild occupied proxies
    if (Array.isArray(hard.objects)) {
      for (const o of hard.objects) {
        if (!o) continue;
        const { x, y, id, meta } = o;
        if (!inBounds(x, y, INTERIOR_W, INTERIOR_H)) continue;
        const wTiles = meta?.wTiles ?? (id === "bed" ? 2 : 1);
        const hTiles = meta?.hTiles ?? (id === "bed" ? 2 : 1);
stampInteriorObject(map, x, y, id, wTiles, hTiles, meta ?? null);
      }
    }
    return map;
  }

    // If this interior has a fixed JSON layout, use it and DO NOT load/save persistence.
  if (def && def.fixedLayout && def.layout) {
    const L = def.layout;

    // tiles
    if (Array.isArray(L.tiles)) map.tiles = L.tiles;

    // walls
    if (L.walls) map.walls = L.walls;
    ensureInteriorWalls(map);

    // objects (anchors only) -> rebuild occupied proxies
    if (Array.isArray(L.objects)) {
      for (const o of L.objects) {
        if (!o) continue;
        const { x, y, id, meta } = o;
        if (!inBounds(x, y, INTERIOR_W, INTERIOR_H)) continue;
        const wTiles = meta?.wTiles ?? (id === "bed" ? 2 : 1);
const hTiles = meta?.hTiles ?? (id === "bed" ? 2 : 1);
placeInteriorObjectAt(x, y, id, wTiles, hTiles);
      }
    }

    return map;
  }

  // Otherwise, fall back to saved/persistent layout (editor mode)
  const saved = loadInteriorLayout(interiorId);
  if (saved) {
    if (Array.isArray(saved.tiles)) map.tiles = saved.tiles;
    if (saved.walls) map.walls = saved.walls;
    ensureInteriorWalls(map);

    if (Array.isArray(saved.objects)) {
      for (const o of saved.objects) {
        if (!o) continue;
        const { x, y, id, meta } = o;
        if (!inBounds(x, y, INTERIOR_W, INTERIOR_H)) continue;
        const wTiles = meta?.wTiles ?? 1;
        placeInteriorObjectAt(x, y, id, wTiles);
      }
    }
    return map;
  }

  // default starter chest ONLY if nothing saved
  map.objects[2][2] = { id: "storage_chest", hp: 999, meta: {} };

  // save the initial template once, so you have a baseline persisted
  if (!def?.fixedLayout) saveInteriorLayout(interiorId);

  return map;
}

// ---- Interior persistence + wall-edges (between tiles) ----

function interiorStorageKey(interiorId) {
  return `YAMHOME:interior:${interiorId}`;
}

function ensureInteriorWalls(map) {
  if (!map) return;
  const h = map.tiles?.length ?? INTERIOR_H;
  const w = map.tiles?.[0]?.length ?? INTERIOR_W;

  if (!map.walls) map.walls = { v: [], h: [] };

  // v[y][x] blocks between (x,y) and (x+1,y)   size: h rows, (w-1) cols
  if (!Array.isArray(map.walls.v) || map.walls.v.length !== h) {
    map.walls.v = Array.from({ length: h }, () => Array.from({ length: Math.max(0, w - 1) }, () => 0));
  } else {
    for (let y = 0; y < h; y++) {
      if (!Array.isArray(map.walls.v[y]) || map.walls.v[y].length !== Math.max(0, w - 1)) {
        map.walls.v[y] = Array.from({ length: Math.max(0, w - 1) }, () => 0);
      }
    }
  }

  // h[y][x] blocks between (x,y) and (x,y+1)   size: (h-1) rows, w cols
  if (!Array.isArray(map.walls.h) || map.walls.h.length !== Math.max(0, h - 1)) {
    map.walls.h = Array.from({ length: Math.max(0, h - 1) }, () => Array.from({ length: w }, () => 0));
  } else {
    for (let y = 0; y < Math.max(0, h - 1); y++) {
      if (!Array.isArray(map.walls.h[y]) || map.walls.h[y].length !== w) {
        map.walls.h[y] = Array.from({ length: w }, () => 0);
      }
    }
  }
}

function saveInteriorLayout(interiorId = state.interiorId) {
	  if (HARDCODED_INTERIORS[interiorId]) return;

  if (!interiorId) return;
  const map = state.interior;
  if (!map) return;

  ensureInteriorWalls(map);

  // Save only anchor objects (skip "occupied" proxies)
  const anchors = [];
  for (let y = 0; y < (map.objects?.length ?? 0); y++) {
    for (let x = 0; x < (map.objects?.[y]?.length ?? 0); x++) {
      const o = map.objects[y][x];
      if (!o) continue;
      if (o.id === "occupied" && o.meta?.anchor) continue;
      anchors.push({ x, y, id: o.id, meta: o.meta ?? {} });
    }
  }

  const payload = {
    tiles: map.tiles,
    walls: map.walls,
    objects: anchors
  };

  try {
    localStorage.setItem(interiorStorageKey(interiorId), JSON.stringify(payload));
  } catch (e) {
    console.warn("saveInteriorLayout failed:", e);
  }
}

function loadInteriorLayout(interiorId = state.interiorId) {
	    if (HARDCODED_INTERIORS[interiorId]) return null;
  if (!interiorId) return null;
  try {
    const raw = localStorage.getItem(interiorStorageKey(interiorId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn("loadInteriorLayout failed:", e);
    return null;
  }
}

// --------------------------------------------------------------------------------- Fog of war ----
function _ensureExploredGrid(map, w, h) {
  if (!map) return;
  if (!map.explored || map.explored.length !== h || map.explored[0]?.length !== w) {
    map.explored = Array.from({ length: h }, () => Array.from({ length: w }, () => false));
  }
}

function revealAroundPlayers() {
  // Applies to overworld + dungeon (interior does not use fog)
  if (state.mode !== "overworld" && state.mode !== "dungeon") return;

  const map = getCurrentMap();
  if (!map) return;

  const { w, h } = currentDims();
  _ensureExploredGrid(map, w, h);

  const exp = map.explored;

  const mult = state.holdingHands ? 2 : 1;
  const r = VIS_RADIUS * mult;

  for (const pl of state.players) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = pl.x + dx;
        const y = pl.y + dy;
        if (inBounds(x, y, w, h)) exp[y][x] = true;
      }
    }
  }
}

function isInPlayerSight(x, y) {
  // Only meaningful for overworld + dungeon
  if (state.mode !== "overworld" && state.mode !== "dungeon") return true;

  const mult = state.holdingHands ? 2 : 1;
  const r = VIS_RADIUS * mult;

  for (const pl of state.players) {
    if (Math.abs(pl.x - x) <= r && Math.abs(pl.y - y) <= r) return true;
  }
  return false;
}


function isLitByCampfire(x, y) {
  if (state.mode !== "overworld") return false;

  const map = state.world;
  if (!map?.objects) return false;

  for (let yy = Math.max(0, y - CAMPFIRE_LIGHT_RADIUS); yy <= Math.min(WORLD_H - 1, y + CAMPFIRE_LIGHT_RADIUS); yy++) {
    for (let xx = Math.max(0, x - CAMPFIRE_LIGHT_RADIUS); xx <= Math.min(WORLD_W - 1, x + CAMPFIRE_LIGHT_RADIUS); xx++) {
      const obj = map.objects[yy][xx];
      if (!obj || obj.id !== "campfire") continue;

      // must be burning
      const lit = (obj.meta?.fireT ?? 0) > 0;
      if (!lit) continue;

      if (Math.abs(xx - x) <= CAMPFIRE_LIGHT_RADIUS && Math.abs(yy - y) <= CAMPFIRE_LIGHT_RADIUS) {
        return true;
      }
    }
  }
  return false;
}

function isVisibleNow(x, y) {
  const isDay = state.time?.isDay ?? true;
  if (isDay) return state.mode !== "overworld" || state.world.explored[y][x];
  return (state.mode !== "overworld") ? true : (isInPlayerSight(x, y) || isLitByCampfire(x, y));
}

// --------------------------------------------------------------------------------- Passability ----
// --------------------------------------------------------------------------------- Passability ----

// Treat every tile inside a build project's footprint as blocked.
function isInBuildFootprint(x, y) {
  if (state.mode !== "overworld") return false;

  const fp = (BUILD_FOOTPRINT ?? 3) | 0;

  // state.buildProjects keys are "x,y" anchors (top-left of the 3x3)
  for (const key in state.buildProjects) {
    const proj = state.buildProjects[key];
    if (!proj) continue;

    const parts = key.split(",");
    if (parts.length !== 2) continue;

    const ax = Number(parts[0]);
    const ay = Number(parts[1]);
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) continue;

    if (x >= ax && x < ax + fp && y >= ay && y < ay + fp) return true;
  }

  return false;
}

function isPassable(x, y) {
  const { w, h } = currentDims();
  if (!inBounds(x, y, w, h)) return false;

  const t = tileAt(x, y);
  if (!isWalkableTile(t)) return false;

 // ✅ INTERIOR: wall + door tiles should never be passable
if (state.mode === "interior") {
  const idef = state.data.interiors?.[state.interiorId];
  const wallTile = idef?.wallTile;
  const doorTile = idef?.doorTile;
  if (wallTile && t === wallTile) return false;
  if (doorTile && t === doorTile) return false; // NEW: door is impassable
}

  // NEW: block the entire 3x3 build footprint, not just the anchor tile.
  if (isInBuildFootprint(x, y)) return false;

const obj = objectAt(x, y);
if (obj) {
  // HARD BLOCK: locked dungeon gates must stop movement, period.
  if (state.mode === "dungeon" && obj.id === "dungeon_gate") return false;

  // (If you later add an opened gate object id, allow it)
  if (state.mode === "dungeon" && obj.id === "dungeon_gate_open") {
    // passable
  } else {
    const d = objDef(obj.id);
    if (d?.blocks) return false;
  }
}
return true;

}

// -------------------------------------------------------- Pathfinding (BFS; fine for small maps) ----
function findPathBFS(start, goal) {
  const { w, h } = currentDims();
  const key = (x, y) => `${x},${y}`;

  const q = [];
  const prev = new Map();
  const seen = new Set();

  q.push(start);
  seen.add(key(start.x, start.y));
  prev.set(key(start.x, start.y), null);

  let found = false;

  while (q.length) {
    const cur = q.shift();
    if (cur.x === goal.x && cur.y === goal.y) { found = true; break; }

    for (const [nx, ny] of neighbors4(cur.x, cur.y)) {
      if (!inBounds(nx, ny, w, h)) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
            if (!canStep(cur.x, cur.y, nx, ny)) continue;

      seen.add(k);
      prev.set(k, cur);
      q.push({ x: nx, y: ny });
    }
  }

  if (found) {
    const path = [];
    let cur = goal;
    while (cur) {
      path.push(cur);
      cur = prev.get(key(cur.x, cur.y));
    }
    path.reverse();
    // remove start node
    return path.slice(1);
  }

  // If goal not reachable, find nearest reachable tile to goal
  // We already have `seen` and `prev` filled with reachable tiles.
  let best = null;
  let bestDist = Infinity;

  for (const k of seen) {
    const [sx, sy] = k.split(",").map(Number);
    const d = Math.abs(sx - goal.x) + Math.abs(sy - goal.y);
    if (d < bestDist) {
      bestDist = d;
      best = { x: sx, y: sy };
    }
  }

  if (!best || (best.x === start.x && best.y === start.y)) return [];
  // reconstruct path to best
  const path = [];
  let cur = best;
  while (cur) {
    path.push(cur);
    cur = prev.get(key(cur.x, cur.y));
  }
  path.reverse();
  return path.slice(1);
}

function setPathTo(x, y) {
  const p = activePlayer();

  if (state.holdingHands) state.holdingHands.leader = state.activePlayer;

  // movement interrupts resting
  p.resting = false;

  if (!inBounds(x, y, currentDims().w, currentDims().h)) return;

  const path = findPathBFS({ x: p.x, y: p.y }, { x, y });

  // ONLINE: queue the path and let netTick() drip-feed steps to server
  if (state.net?.enabled) {
    netQueuePath(path);
    return;
  }

  // OFFLINE: local movement
  p.path = path;
}

// --------------------------------------------------------------------------- Stamina + movement update ----
function consumeStaminaForTile(pl) {
  pl.stamina = Math.max(0, pl.stamina - STAMINA_COST_PER_TILE);
}

function otherHandHolderIndex(me) {
  const hh = state.holdingHands;
  if (!hh) return null;
  if (hh.a === me) return hh.b;
  if (hh.b === me) return hh.a;
  return null;
}

function updatePlayers(dt) {
  for (const pl of state.players) {
    // Rest regen
    if (pl.resting && pl.path.length === 0) {
      pl.stamina = Math.min(STAMINA_MAX, pl.stamina + REST_REGEN_PER_SEC * dt);
    }

    // Hunger ticking (fills as you get hungry)
    if (pl.hunger === undefined) pl.hunger = 0;
    pl.hunger = clamp(pl.hunger + HUNGER_PER_SEC * dt, 0, HUNGER_MAX);

// Starvation stamina drain when hunger is maxed
if (pl.hunger >= HUNGER_MAX) {
  pl.stamina = clamp(pl.stamina - STARVE_STAMINA_DRAIN_PER_SEC * dt, 0, STAMINA_MAX);
}

    // Move along path smoothly
    if (pl.path.length > 0) {
      if (pl.stamina <= 0) {
        // too tired, stop
        pl.path = [];
        // mark as not moving so footsteps stop cleanly
        pl._wasMoving = false;
        continue;
      }

      const next = pl.path[0];

      // move fx/fy toward next tile center (tile coords)
      const dx = next.x - pl.fx;
      const dy = next.y - pl.fy;
      const dist = Math.hypot(dx, dy);

      const step = MOVE_SPEED_TILES_PER_SEC * dt;

      if (dist <= step || dist === 0) {
        // arrive at next tile
        const prevX = pl.x;
        const prevY = pl.y;

        pl.fx = next.x;
        pl.fy = next.y;
        pl.x = next.x;
        pl.y = next.y;
        pl.path.shift();

        // Holding hands: if this mover is the leader, pull the other player into our previous tile
        const hh = state.holdingHands;
        if (hh && hh.leader === state.players.indexOf(pl)) {
          const otherIdx = otherHandHolderIndex(hh.leader);
          if (otherIdx !== null) {
            const other = state.players[otherIdx];

            // Only “drag” if the other player isn't currently mid-path (keeps it tidy)
            if (other.path.length === 0) {
              // Make the other step into our previous tile (true linked movement)
                            if (canStep(other.x, other.y, prevX, prevY)) {
                other.resting = false;
                other.path = [{ x: prevX, y: prevY }];
              }
            }
          }
        }

        // 👣 Footstep SFX: play only when a tile is actually entered,
        // and only if we're still moving or just moved this tick.
        // If you want both players to make steps, remove the activePlayer() check.
        if (pl === activePlayer()) {
          playFootstep(pl);
        }

        consumeStaminaForTile(pl);

        // fog reveal on overworld
        revealAroundPlayers();

        // edge scroll only for active player
        if (pl === activePlayer()) ensureCameraEdgeScroll();

        pl._wasMoving = true;
      } else {
        // interpolate
        pl.fx += (dx / dist) * step;
        pl.fy += (dy / dist) * step;
        pl._wasMoving = true;
      }
    } else {
      // snap floats to ints when not moving
      pl.fx = pl.x;
      pl.fy = pl.y;

      // movement stopped: mark so no step logic tries to "continue"
      pl._wasMoving = false;
    }
  }
}

// ---------------------------------------------------------------------------------- Structures + markers ----
function markerKey(m) {
  return `${m.type}:${m.x},${m.y}`;
}

function addMarker(label, x, y, type) {
  // prevent duplicates for same type/coord
  const exists = state.markers.some(m => m.x === x && m.y === y && m.type === type);
  if (!exists) state.markers.push({ label, x, y, type });
}

function saveHouseAt(x, y) {
  const key = `house:${x},${y}`;
  if (!state.structures.houses.some(h => h.key === key)) {
    state.structures.houses.push({ key, x, y, label: "House" });
    addMarker("House", x, y, "house");
  }
}

function saveStockpileAt(x, y, key) {
  addMarker(`Stockpile`, x, y, "stockpile");
}

function isRenewableDef(def) {
  if (!def) return false;
  if (def.renewable === true) return true;
  if (Array.isArray(def.tags) && def.tags.includes("renewable")) return true;
  return false;
}

// ---------------------------------------------------------------------------------------- PLAYER ACTIONS ----
function harvestObject(x, y) {
  const map = getCurrentMap();
  const obj = map.objects[y][x];
  if (!obj) return;

  const def = objDef(obj.id);
  if (!def) return;

  // Support BOTH harvest and hunt
  const interact = def.hunt || def.harvest;
  if (!interact) return;

  const inv = activeInv();
  const requiredTool = interact.requiresTool || null;
  if (requiredTool && !hasTool(inv, requiredTool)) return;

  const p = activePlayer();

  // Wood + stone cost stamina
  if (obj.id === "tree1" || obj.id === "tree2" || obj.id === "tree3" || obj.id === "tree4" || obj.id === "tree5" || obj.id === "tree6" || obj.id === "tree7" || obj.id === "tree8") {
    if (p.stamina < HARVEST_STAMINA_COST_WOOD) return;
    p.stamina -= HARVEST_STAMINA_COST_WOOD;
  }

  if (obj.id === "rock") {
    if (p.stamina < HARVEST_STAMINA_COST_STONE) return;
    p.stamina -= HARVEST_STAMINA_COST_STONE;
  }

  const pName = activePlayer().name;

  // --- Chance of failure (fishing / hunting) ---
  // Allow per-object tuning via JSON: def.hunt.chance or def.harvest.chance (0..1)
  const baseChance =
    (typeof interact.chance === "number") ? interact.chance :
    (obj.id === "fish_spot") ? 0.65 :
    (def.hunt) ? 0.75 :
    1;

  if (baseChance < 1) {
    const chk = rollCheck(baseChance);

    if (!chk.ok) {
      if (obj.id === "fish_spot") {
        logAction(`${pName} tried to fish… nothing. (d${chk.sides}: ${chk.roll} > ${chk.target})`);
      } else if (def.hunt) {
        logAction(`${pName} tried to hunt… failed. (d${chk.sides}: ${chk.roll} > ${chk.target})`);
      } else {
        logAction(`${pName} tried to harvest… failed. (d${chk.sides}: ${chk.roll} > ${chk.target})`);
      }

      closeMenu();
      return;
    }
  }

  // Give loot
  for (const [itemId, amt] of Object.entries(interact.gives || {})) {
    const res = addItemOrDrop(inv, itemId, amt, x, y, pName);

    const itemName = itemDef(itemId)?.name ?? itemId;
    const got = (typeof res === "object" && typeof res.added === "number") ? res.added : amt;

    if (got > 0) {
      if (itemId === "fish") {
        logAction(`${pName} caught a fish!`);
      } else if (def.hunt) {
        logAction(`${pName} hunted ${got} ${itemName}${got === 1 ? "" : "s"}!`);
      } else {
        logAction(`${pName} harvested ${got} ${itemName}${got === 1 ? "" : "s"}!`);
      }
    }
    // If inventory was full, addItemOrDrop already logs the drop message.
  }

  // Damage / remove object (run ONCE per harvest, not per item)
  obj.hp = (obj.hp ?? 1) - 1;

  if (obj.hp <= 0) {
    // Tree regrowth system
    if (obj.id === "tree1" || obj.id === "tree2" || obj.id === "tree3" || obj.id === "tree4" || obj.id === "tree5" || obj.id === "tree6" || obj.id === "tree7" || obj.id === "tree8") {
      map.objects[y][x] = {
  id: "stump",
  meta: {
    originalTree: obj.id,
    regrowDay: state.time.day,  
    regrowStage: "stump"
  }
};
return;
    }

    if (isRenewableDef(def)) {
  obj.hp = 0;
  obj.meta = obj.meta || {};
  obj.meta.depleted = true;
  obj.meta.depletedDay = state.time.day; // <-- track when it depleted
} else {
  map.objects[y][x] = null;
}
  }

  closeMenu();
}

function chopDownObject(x, y) {
  const p = activePlayer();
  if (p.stamina < HARVEST_STAMINA_COST_WOOD) return;
  p.stamina -= HARVEST_STAMINA_COST_WOOD;

  const map = getCurrentMap();
  const obj = map.objects?.[y]?.[x];
  if (!obj) return;

  const def = objDef(obj.id);
  if (!def) return;

  const inv = activeInv();
  if (!hasTool(inv, "axe")) return;

  // Only for the “anti-softlock” blockers you listed
  const choppable = new Set(["bush", "berry_bush", "apple_tree", "grapevine"]);
  if (!choppable.has(obj.id)) return;

  playSound("chop");

  const pName = activePlayer().name;

  // “All of its apples/fiber/etc” = whatever the normal harvest would give,
  // unless it's already depleted.
  const isDepleted = !!obj.meta?.depleted;
  const harvest = def.harvest || null;

  if (!isDepleted && harvest?.gives) {
    for (const [itemId, amt] of Object.entries(harvest.gives)) {
      addItem(inv, itemId, amt);
      const itemName = itemDef(itemId)?.name ?? itemId;
      logAction(`${pName} got ${amt} ${itemName}${amt === 1 ? "" : "s"} from chopping.`);
    }
  }

  // Extra chop loot
  if (obj.id === "apple_tree") {
    addItem(inv, "wood", 2);
    logAction(`${pName} got 2 wood from chopping.`);
  } else if (obj.id === "bush") {
    const sticks = randInt(2, 4);
    addItem(inv, "stick", sticks);
    logAction(`${pName} got ${sticks} stick${sticks === 1 ? "" : "s"} from chopping.`);
  } else if (obj.id === "berry_bush") {
    const sticks = randInt(1, 3);
    addItem(inv, "stick", sticks);
    logAction(`${pName} got ${sticks} stick${sticks === 1 ? "" : "s"} from chopping.`);
  }

  // Clear the blocker no matter what (this is the whole point)
  map.objects[y][x] = null;
  logAction(`${pName} chopped down the ${def.name ?? obj.id} at (${x},${y}).`);

  closeMenu();
}

function firstExistingItemId(ids) {
  for (const id of ids) if (itemDef(id)) return id;
  return null;
}

function openMenuForWaterTile(mapX, mapY, screenX, screenY) {
  const p = activePlayer();
  const inv = activeInv();

  // you probably have ONE of these (pick what exists)
  const emptyBucketId = firstExistingItemId(["bucket", "empty_bucket"]);
  const filledBucketId = firstExistingItemId(["bucket_water", "water_bucket", "bucket_of_water"]);

  let disabledReason = null;

  if (!isAdjacentOrSame(p.x, p.y, mapX, mapY)) disabledReason = "Too far";
  else if (!emptyBucketId) disabledReason = "No bucket item exists (add one in items.json)";
  else if (!filledBucketId) disabledReason = "No filled-water bucket item exists (add one in items.json)";
  else if (getQty(inv, emptyBucketId) <= 0) disabledReason = "Needs an empty bucket";

  openMenu({
    screenX, screenY,
    title: "Water",
    options: [
      {
        label: "Fill bucket",
        disabledReason,
        action: () => {
          if (disabledReason) return;
          removeItem(inv, emptyBucketId, 1);
	  playSound("fillwater");
          addItem(inv, filledBucketId, 1);
          logAction(`${p.name} filled a bucket with water.`);
          closeMenu();
        }
      }
    ]
  });
}

function openInteriorEditMenu(tx, ty, px, py) {
  if (state.mode !== "interior") return;

  openMenu({
    screenX: px,
    screenY: py,
    title: `Edit (${tx},${ty})`,
    options: [
      {
        label: "Place Object",
        action: () => {
          playSound("click");
          openInteriorPlaceObjectMenu(tx, ty, px, py);
        }
      },
      {
        label: "Modify Tile",
        action: () => {
          playSound("click");
          openInteriorModifyTileMenu(tx, ty, px, py);
        }
      },
	        {
        label: "Build Wall",
        action: () => {
          playSound("click");
          openInteriorBuildWallMenu(tx, ty, px, py);
        }
      },
      {
        label: "Exit Edit Mode",
        action: () => {
          playSound("click");
          state.interiorEdit.on = false;
          closeMenu();
        }
      }
    ]
  });
}

function openInteriorPlaceObjectMenu(tx, ty, px, py) {
  const map = state.interior;
  if (!map?.objects?.[ty]) return;

  // Build list from objects.json: anything tagged "household"
 const householdIds = Object.entries(state.data?.objects ?? {})
  .filter(([id, o]) => Array.isArray(o.tags) && o.tags.includes("household"))
  .map(([id]) => id);

  // Sort by display name for sanity
  householdIds.sort((a, b) => {
    const an = (objDef(a)?.name ?? a).toLowerCase();
    const bn = (objDef(b)?.name ?? b).toLowerCase();
    return an.localeCompare(bn);
  });

  const getObjAt = (x, y) => map.objects?.[y]?.[x] ?? null;

  // If this tile is an occupied proxy (e.g. right-half of a bed), operate on the anchor instead.
  const cur = getObjAt(tx, ty);
  const anchor = (cur?.id === "occupied" && cur.meta?.anchor)
    ? cur.meta.anchor
    : { x: tx, y: ty };

  const existing = getObjAt(anchor.x, anchor.y);

  const opts = [];

  // Clear existing (clears anchor + any occupied tiles it owns)
  if (existing) {
    const name = objDef(existing.id)?.name ?? existing.id;
    opts.push({
      label: `Clear Object (${name})`,
      action: () => {
        playSound("pop");
        clearInteriorPlacedObject(anchor.x, anchor.y);
        closeMenu();
      }
    });
  }

  if (householdIds.length === 0) {
    opts.push({
      label: "(No household objects found)",
      disabledReason: "Tag interior objects with tags:[\"household\"] in objects.json",
      action: () => {}
    });
  } else {
    for (const objId of householdIds) {
      const name = objDef(objId)?.name ?? objId;

      // Bed is special: 2 tiles wide (to the right)
      const wTiles = (objId === "bed") ? 2 : 1;
const hTiles = (objId === "bed") ? 2 : 1;

      let disabledReason = null;
      if (!canPlaceInteriorObjectAt(anchor.x, anchor.y, wTiles, hTiles)) {
        disabledReason = "Blocked / out of bounds";
      }

      opts.push({
        label: (wTiles === 2) ? `Place: ${name} (2-wide)` : `Place: ${name}`,
        disabledReason,
        action: () => {
          if (disabledReason) return;
          playSound("pop");
          placeInteriorObjectAt(anchor.x, anchor.y, objId, wTiles, hTiles);
          closeMenu();
        }
      });
    }
  }

  openMenu({
    screenX: px,
    screenY: py,
    title: `Place Object (${anchor.x},${anchor.y})`,
    options: opts
  });
}

// ---- interior wall-edge building (between tiles) ----

function hasInteriorWallBetween(ax, ay, bx, by) {
  if (state.mode !== "interior") return false;
  const map = state.interior;
  if (!map) return false;
  ensureInteriorWalls(map);

  const dx = bx - ax;
  const dy = by - ay;

  // horizontal move -> check v walls
  if (dy === 0 && Math.abs(dx) === 1) {
    const x = Math.min(ax, bx);
    const y = ay;
    return !!map.walls.v?.[y]?.[x];
  }

  // vertical move -> check h walls
  if (dx === 0 && Math.abs(dy) === 1) {
    const x = ax;
    const y = Math.min(ay, by);
    return !!map.walls.h?.[y]?.[x];
  }

  return false;
}

function canStep(ax, ay, bx, by) {
  // base tile/objects rules
  if (!isPassable(bx, by)) return false;

  // add interior edge-wall blocking
  if (state.mode === "interior" && hasInteriorWallBetween(ax, ay, bx, by)) return false;

  return true;
}

function toggleInteriorWall(tx, ty, dir) {
  const map = state.interior;
  if (!map) return;
  ensureInteriorWalls(map);

  // dir is one of: "N","S","E","W"
  if (dir === "E") {
    if (tx >= 0 && tx < INTERIOR_W - 1 && ty >= 0 && ty < INTERIOR_H) {
      map.walls.v[ty][tx] = map.walls.v[ty][tx] ? 0 : 1;
    }
  } else if (dir === "W") {
    if (tx - 1 >= 0 && tx - 1 < INTERIOR_W - 1 && ty >= 0 && ty < INTERIOR_H) {
      map.walls.v[ty][tx - 1] = map.walls.v[ty][tx - 1] ? 0 : 1;
    }
  } else if (dir === "S") {
    if (tx >= 0 && tx < INTERIOR_W && ty >= 0 && ty < INTERIOR_H - 1) {
      map.walls.h[ty][tx] = map.walls.h[ty][tx] ? 0 : 1;
    }
  } else if (dir === "N") {
    if (tx >= 0 && tx < INTERIOR_W && ty - 1 >= 0 && ty - 1 < INTERIOR_H - 1) {
      map.walls.h[ty - 1][tx] = map.walls.h[ty - 1][tx] ? 0 : 1;
    }
  }

  saveInteriorLayout();
}

function clearAllInteriorWalls() {
  const map = state.interior;
  if (!map) return;
  ensureInteriorWalls(map);

  for (let y = 0; y < INTERIOR_H; y++) {
    for (let x = 0; x < INTERIOR_W - 1; x++) map.walls.v[y][x] = 0;
  }
  for (let y = 0; y < INTERIOR_H - 1; y++) {
    for (let x = 0; x < INTERIOR_W; x++) map.walls.h[y][x] = 0;
  }

  saveInteriorLayout();
}

function openInteriorBuildWallMenu(tx, ty, px, py) {
  const map = state.interior;
  if (!map) return;
  ensureInteriorWalls(map);

  const opts = [
    { label: "Toggle Wall: North (between this tile and tile above)", action: () => { playSound("pop"); toggleInteriorWall(tx, ty, "N"); closeMenu(); } },
    { label: "Toggle Wall: South (between this tile and tile below)", action: () => { playSound("pop"); toggleInteriorWall(tx, ty, "S"); closeMenu(); } },
    { label: "Toggle Wall: West (between this tile and tile left)", action: () => { playSound("pop"); toggleInteriorWall(tx, ty, "W"); closeMenu(); } },
    { label: "Toggle Wall: East (between this tile and tile right)", action: () => { playSound("pop"); toggleInteriorWall(tx, ty, "E"); closeMenu(); } },
    { label: "Clear ALL built walls", action: () => { playSound("deny"); clearAllInteriorWalls(); closeMenu(); } }
  ];

  openMenu({
    screenX: px,
    screenY: py,
    title: `Build Wall (${tx},${ty})`,
    options: opts
  });
}

// ---- interior placement helpers ----
function canPlaceInteriorObjectAt(x, y, wTiles, hTiles = 1) {
  const map = state.interior;
  const h = map?.tiles?.length ?? 0;
  const w = map?.tiles?.[0]?.length ?? 0;

  if (x < 0 || y < 0) return false;
  if (x + (wTiles - 1) >= w) return false;
  if (y + (hTiles - 1) >= h) return false;

  for (let dy = 0; dy < hTiles; dy++) {
    for (let dx = 0; dx < wTiles; dx++) {
      const t = map.objects?.[y + dy]?.[x + dx] ?? null;
      if (!t) continue;
      return false; // anything in the rectangle blocks placement
    }
  }
  return true;
}

function clearInteriorPlacedObject(x, y) {
  const map = state.interior;
  if (!map?.objects) return;

  const obj = map.objects?.[y]?.[x] ?? null;
  if (!obj) return;

  const wTiles = obj.meta?.wTiles ?? 1;
  const hTiles = obj.meta?.hTiles ?? 1;

  for (let dy = 0; dy < hTiles; dy++) {
    for (let dx = 0; dx < wTiles; dx++) {
      if (map.objects?.[y + dy]?.[x + dx]?.id === "occupied" || (dx === 0 && dy === 0)) {
        map.objects[y + dy][x + dx] = null;
      }
    }
  }

  saveInteriorLayout();
}

const PASSABLE_PROXY_ID = "occupied_pass";

function stampInteriorObject(map, x, y, objId, wTiles = 1, hTiles = 1, metaExtra = null) {
  if (!map?.objects) return false;

    // Clear rectangle first
  // Beds are drawn visually shifted up, so we also clear y-1 for their collision row.
  const clearStartDy = (objId === "bed") ? -1 : 0;
  const clearEndDy = Math.max(1, hTiles) - 1;

  for (let dy = clearStartDy; dy <= clearEndDy; dy++) {
    for (let dx = 0; dx < Math.max(1, wTiles); dx++) {
      if (map.objects?.[y + dy]?.[x + dx] !== undefined) {
        map.objects[y + dy][x + dx] = null;
      }
    }
  }


  const meta = { wTiles, hTiles, ...(metaExtra || {}) };

  // Anchor at top-left
  if (!map.objects?.[y]) return false;
  map.objects[y][x] = { id: objId, hp: 999, meta };

  // Occupied proxies for the rest of the rectangle
  for (let dy = 0; dy < hTiles; dy++) {
    for (let dx = 0; dx < wTiles; dx++) {
      if (dx === 0 && dy === 0) continue; // anchor tile
      if (!map.objects?.[y + dy]) continue;
      if (map.objects[y + dy][x + dx] === undefined) continue;

            // Decide whether this proxy tile blocks walking or is "soft occupied"
      // meta.blocksMask: 2D array [hTiles][wTiles] where 1=blocked, 0=walkable
      let _proxyId = "occupied";
      if (meta?.blocksMask) {
        const _row = meta.blocksMask[dy];
        const _cell = _row ? _row[dx] : 1;
        _proxyId = (_cell === 0) ? PASSABLE_PROXY_ID : "occupied";
      }

      map.objects[y + dy][x + dx] = {
        id: _proxyId,
        hp: 999,
        meta: { anchor: { x, y } }
      };
    }
  }

  // --- Bed special-case: block the row ABOVE the anchor (visual top of the bed)
  // This keeps the bed's visual Y offset while making the "red" tiles impassable.
  if (objId === "bed" && meta?.blocksMask && map.objects?.[y - 1]) {
    for (let dx = 0; dx < wTiles; dx++) {
      if (map.objects[y - 1][x + dx] === undefined) continue;

      // Use the FIRST row of the mask for the "above" collision row
      const row0 = meta.blocksMask[0];
      const cell = row0 ? row0[dx] : 1;

      // 1 = blocked, 0 = walkable (soft-occupied)
      const id = (cell === 0) ? PASSABLE_PROXY_ID : "occupied";

      map.objects[y - 1][x + dx] = {
        id,
        hp: 999,
        meta: { anchor: { x, y } }
      };
    }
  }

  return true;
}

function placeInteriorObjectAt(x, y, objId, wTiles, hTiles = 1) {
  const map = state.interior;
  if (!map?.objects?.[y]) return;

  stampInteriorObject(map, x, y, objId, wTiles, hTiles);

  const idef = state.data?.interiors?.[state.interiorId];
  if (!idef?.fixedLayout) saveInteriorLayout();
}

function openInteriorModifyTileMenu(tx, ty, px, py) {
  const map = state.interior;
  if (!map?.tiles?.[ty]) return;

  // Simple starter set: floor / wall / door.
  // These tile ids must exist in your tiles.json.
  const FLOOR = "floor";
  const WALL = "wall";
  const DOOR = "door";

  const tileExists = (id) => !!state.data?.tiles?.[id];

  const opts = [];

  const addSet = (label, tileId) => {
    opts.push({
      label,
      disabledReason: tileExists(tileId) ? null : `Missing tile id: ${tileId}`,
      action: () => {
        if (!tileExists(tileId)) return;
        playSound("pop");
        map.tiles[ty][tx] = tileId;
		saveInteriorLayout();
        closeMenu();
      }
    });
  };

  addSet("Set: Floor", FLOOR);
  addSet("Set: Wall", WALL);
  addSet("Set: Door", DOOR);

  opts.push({
    label: "Copy tile from cursor (next click)",
    action: () => {
      // Minimal “tool” hook: next click in edit mode copies that tile id here.
      // (We’ll wire this properly if you actually want it.)
      playSound("click");
      logAction("Copy tool not wired yet. (Tell future-you: implement a one-shot interiorEdit.copyTarget.)");
      closeMenu();
    }
  });

  openMenu({
    screenX: px,
    screenY: py,
    title: `Modify Tile (${tx},${ty})`,
    options: opts
  });
}

// ---- Dungeon persistence + generation ----
function dungeonStorageKey(dungeonId) {
  return `YAMHOME:dungeon:${dungeonId}`;
}

function saveDungeonLayout(dungeonId = state.dungeonId) {
  if (!dungeonId) return;
  const map = state.dungeon;
  if (!map) return;

  const anchors = [];
  for (let y = 0; y < (map.objects?.length ?? 0); y++) {
    for (let x = 0; x < (map.objects?.[y]?.length ?? 0); x++) {
      const o = map.objects[y][x];
      if (!o) continue;
      anchors.push({ x, y, id: o.id, meta: o.meta ?? {} });
    }
  }

const payload = {
  w: map.tiles?.[0]?.length ?? 0,
  h: map.tiles?.length ?? 0,
  tiles: map.tiles,
  objects: anchors,
  entrance: map.entrance ?? null,
  explored: map.explored ?? null
};

  state.dungeons[dungeonId] = payload;

  try {
    localStorage.setItem(dungeonStorageKey(dungeonId), JSON.stringify(payload));
  } catch (e) {
    console.warn("saveDungeonLayout failed:", e);
  }
}

function loadDungeonLayout(dungeonId) {
  if (!dungeonId) return null;
  if (state.dungeons?.[dungeonId]) return state.dungeons[dungeonId];

  try {
    const raw = localStorage.getItem(dungeonStorageKey(dungeonId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    state.dungeons[dungeonId] = parsed;
    return parsed;
  } catch (e) {
    console.warn("loadDungeonLayout failed:", e);
    return null;
  }
}

function dungeonIdForEntrance(type, x, y) {
  return `${type}:${x},${y}`;
}

function carveRect(map, x0, y0, w, h, tileId) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!inBounds(x, y, DUNGEON_W, DUNGEON_H)) continue;
      map.tiles[y][x] = tileId;
    }
  }
}

function pointInRect(x, y, r) {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

function pointNearRect(x, y, r, pad) {
  return x >= r.x - pad && x < r.x + r.w + pad &&
         y >= r.y - pad && y < r.y + r.h + pad;
}

function carveWigglyCorridor(map, ax, ay, bx, by) {
  const path = [];
  let x = ax, y = ay;
  let guard = 0;

  while ((x !== bx || y !== by) && guard++ < 6000) {
    map.tiles[y][x] = "floor";
    path.push([x, y]);

    const dx = Math.sign(bx - x);
    const dy = Math.sign(by - y);

    let stepX = 0, stepY = 0;

    const chaos = Math.random();
    if (chaos < 0.18) {
      if (Math.random() < 0.5) { stepX = 0; stepY = (Math.random() < 0.5 ? -1 : 1); }
      else { stepY = 0; stepX = (Math.random() < 0.5 ? -1 : 1); }
    } else {
      if (Math.abs(bx - x) > Math.abs(by - y)) { stepX = dx; stepY = 0; }
      else { stepY = dy; stepX = 0; }

      if (Math.random() < 0.22 && dx !== 0 && dy !== 0) {
        if (Math.random() < 0.5) { stepX = dx; stepY = 0; }
        else { stepY = dy; stepX = 0; }
      }
    }

// Failsafe: never allow a 0,0 step (creates duplicate path points and bad gate prev/next)
if (stepX === 0 && stepY === 0) {
  if (dx !== 0) stepX = dx;
  else if (dy !== 0) stepY = dy;
  else stepX = (Math.random() < 0.5 ? -1 : 1); // should never happen, but humans love edge cases
}

    const nx = clamp(x + stepX, 1, DUNGEON_W - 2);
    const ny = clamp(y + stepY, 1, DUNGEON_H - 2);
    x = nx; y = ny;
  }

  map.tiles[y][x] = "floor";
  path.push([x, y]);
  return path;
}

function carveManhattanCorridor(map, ax, ay, bx, by) {
  const path = [];
  let x = ax, y = ay;

  // horizontal first
  while (x !== bx) {
    map.tiles[y][x] = "floor";
    path.push([x, y]);
    x += Math.sign(bx - x);
  }
  // then vertical
  while (y !== by) {
    map.tiles[y][x] = "floor";
    path.push([x, y]);
    y += Math.sign(by - y);
  }

  map.tiles[y][x] = "floor";
  path.push([x, y]);
  return path;
}

function buildDungeonFromPayload(payload) {
  const w = payload?.w ?? (payload?.tiles?.[0]?.length ?? 0);
  const h = payload?.h ?? (payload?.tiles?.length ?? 0);
  const map = emptyMap(w, h, "wall");
  map.tiles = payload.tiles;
  map.objects = Array.from({ length: h }, () => Array.from({ length: w }, () => null));
  map.entrance = payload.entrance ?? null;

  // ---- restore explored (fog-of-war) ----
  map.explored = payload.explored ?? null;
  if (!map.explored || map.explored.length !== h || map.explored[0]?.length !== w) {
    map.explored = Array.from({ length: h }, () => Array.from({ length: w }, () => false));
  }

  if (Array.isArray(payload.objects)) {
    for (const o of payload.objects) {
      if (!o) continue;
      const { x, y, id, meta } = o;
      if (!inBounds(x, y, w, h)) continue;
      map.objects[y][x] = { id, hp: objDef(id)?.hp ?? 1, meta: meta ?? {} };
    }
  }
  return map;
}


function enforceGateChoke(map, gx, gy, prev, next) {
  const H = map.tiles.length;
  const W = map.tiles[0].length;

  const keep = new Set([
    `${gx},${gy}`,
    `${prev[0]},${prev[1]}`,
    `${next[0]},${next[1]}`
  ]);

  for (let y = gy - 1; y <= gy + 1; y++) {
    for (let x = gx - 1; x <= gx + 1; x++) {
      if (x < 1 || y < 1 || x > W - 2 || y > H - 2) continue;

      // keep only the gate tile + the two corridor tiles along the path
      if (keep.has(`${x},${y}`)) continue;

      // if it was carved as floor, re-wall it to prevent bypass
      if (map.tiles[y][x] === "floor") {
        map.tiles[y][x] = "wall";
        // also clear any object there, just in case
        map.objects[y][x] = null;
      }
    }
  }

  // Ensure the three "kept" tiles are definitely floor
  map.tiles[gy][gx] = "floor";
  map.tiles[prev[1]][prev[0]] = "floor";
  map.tiles[next[1]][next[0]] = "floor";
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function randomEmptyFloorInRect(map, rect, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const x = randInt(rect.x + 1, rect.x + rect.w - 2);
    const y = randInt(rect.y + 1, rect.y + rect.h - 2);
    if (map.tiles?.[y]?.[x] !== "floor") continue;
    if (map.objects?.[y]?.[x]) continue;
    return { x, y };
  }
  return null;
}

function placeRunestonesInDungeon(map, chambers) {
  if (!objDef("runestone")) return;

  // Max 2 per dungeon, and max 1 per chamber.
  const MAX_TOTAL = 2;

  // Avoid the first chamber (it contains spawn/exit), unless you want it there.
  const candidates = chambers.slice(1);
  if (!candidates.length) return;

  shuffleArray(candidates);

  let placed = 0;
  for (const chamber of candidates) {
    if (placed >= MAX_TOTAL) break;

    const spot = randomEmptyFloorInRect(map, chamber, 300);
    if (!spot) continue;

    map.objects[spot.y][spot.x] = {
      id: "runestone",
      hp: objDef("runestone")?.hp ?? 1,
      meta: {
        // you can swap this later for a real cipher system or message pool
        msg: pickRandomRunestoneMessage()
      }
    };

    placed++;
  }
}

function drawRunestoneReader() {
  const r = state.runestoneReader;
  if (!r?.open) return;

  const W = Math.min(720, window.innerWidth - 60);
  const H = Math.min(420, window.innerHeight - 120);
  const x = Math.floor((window.innerWidth - W) / 2);
  const y = Math.floor((window.innerHeight - H) / 2);

  // Backdrop
  drawRect(0, 0, window.innerWidth, window.innerHeight, "rgba(0,0,0,0.55)");

  // Panel
  drawRect(x, y, W, H, "rgba(10,10,10,0.92)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(x, y, W, H);

  drawText(r.title, x + 14, y + 22, 18, "center", "rgba(255,255,255,0.95)");

  const closeBtn = { x: x + W - 54, y: y + 10, w: 40, h: 28 };
  drawRect(closeBtn.x, closeBtn.y, closeBtn.w, closeBtn.h, "rgba(255,255,255,0.10)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(closeBtn.x, closeBtn.y, closeBtn.w, closeBtn.h);
  drawText("X", closeBtn.x + closeBtn.w / 2, closeBtn.y + 20, 14, "center", "rgba(255,255,255,0.9)");

  const bodyX = x + 16;
  const bodyY = y + 50;
  const bodyW = W - 32;
  const bodyH = H - 70;

  drawRect(bodyX, bodyY, bodyW, bodyH, "rgba(0,0,0,0.30)");
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.strokeRect(bodyX, bodyY, bodyW, bodyH);

  // Wrap text
  const msg = r.text || "";
  const maxW = bodyW - 24;
  const words = msg.split(/\s+/);
  let line = "";
  let yy = bodyY + 26;

  ctx.font = `14px sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
ctx.textAlign = "center";
ctx.textBaseline = "top";
const centerX = bodyX + bodyW / 2;

  for (const w0 of words) {
    const test = line ? (line + " " + w0) : w0;
    if (ctx.measureText(test).width > maxW) {
      ctx.fillText(line, centerX, yy);
      yy += 18;
      line = w0;
      if (yy > bodyY + bodyH - 14) break;
    } else {
      line = test;
    }
  }
  if (line && yy <= bodyY + bodyH - 14) ctx.fillText(line, centerX, yy);

  // Save hitboxes for clicking
  state._runestoneUI = { panel: { x, y, w: W, h: H }, closeBtn };
}

// Temporary: replace later with your real message table / seeded messages
function pickRandomRunestoneMessage() {
  const msgs = [
    "The gate yields to keys earned, not found.",
    "Two moons watch those who dare descend.",
    "Truth is a lock. Curiosity is the key.",
    "Speak softly. The stone remembers."
  ];
  return msgs[randInt(0, msgs.length - 1)];
}

// ----------------------------------------------------
// Rune puzzle clues (painted on dungeon floor)
// ----------------------------------------------------

function buildRuneClueCounts(combo) {
  return combo.map((rune, index) => ({
    rune,
    count: index + 1
  }));
}

function placeRuneCluesInChamber(map, chamber, combo, chestX, chestY) {
  const clues = buildRuneClueCounts(combo);
  const totalNeeded = clues.reduce((a, c) => a + c.count, 0); // must be 10

  const CRITICAL = new Set(["dungeon_chest", "dungeon_exit", "dungeon_gate", "rune_clue"]);

  const W = map.tiles?.[0]?.length ?? 0;
  const H = map.tiles?.length ?? 0;
  if (!(W && H)) return false;

  if (typeof chestX !== "number" || typeof chestY !== "number") return false;
  if (chestX < 0 || chestX >= W || chestY < 0 || chestY >= H) return false;

  const isFloor = (x, y) => map.tiles?.[y]?.[x] === "floor";

  const floorNeighbors = (x, y) => {
    let n = 0;
    if (x > 0 && isFloor(x - 1, y)) n++;
    if (x < W - 1 && isFloor(x + 1, y)) n++;
    if (y > 0 && isFloor(x, y - 1)) n++;
    if (y < H - 1 && isFloor(x, y + 1)) n++;
    return n;
  };

  // Room-ish tile heuristic:
  // Corridors typically have 1-2 floor neighbors; rooms have 3-4.
  const isRoomy = (x, y) => floorNeighbors(x, y) >= 3;

  // --- Room-only flood fill starting at chest ---
  // We allow starting tile even if it's not "roomy", but expansion only proceeds through roomy tiles.
  const q = [[chestX, chestY]];
  const seen = new Set([chestX + "," + chestY]);

  const region = [];
  let minX = chestX, maxX = chestX, minY = chestY, maxY = chestY;

  const push = (nx, ny) => {
    if (nx < 0 || nx >= W || ny < 0 || ny >= H) return;
    const k = nx + "," + ny;
    if (seen.has(k)) return;
    seen.add(k);
    q.push([nx, ny]);
  };

  while (q.length) {
    const [x, y] = q.shift();
    if (!isFloor(x, y)) continue;

    // Include this tile as part of the "room region" if it's roomy OR it's the chest tile itself
    const include = (x === chestX && y === chestY) || isRoomy(x, y);

    if (include) {
      region.push({ x, y });
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // Expand only through roomy tiles (prevents leaking down corridors)
      if (isRoomy(x, y)) {
        push(x + 1, y);
        push(x - 1, y);
        push(x, y + 1);
        push(x, y - 1);
      } else {
        // chest tile not roomy: still try to step into adjacent roomy tiles once
        if (x === chestX && y === chestY) {
          if (x > 0 && isRoomy(x - 1, y)) push(x - 1, y);
          if (x < W - 1 && isRoomy(x + 1, y)) push(x + 1, y);
          if (y > 0 && isRoomy(x, y - 1)) push(x, y - 1);
          if (y < H - 1 && isRoomy(x, y + 1)) push(x, y + 1);
        }
      }
    }
  }

  // Build candidate tiles INSIDE THIS ROOM REGION
  const candidates = [];
  for (const t of region) {
    const x = t.x, y = t.y;

    // never place directly on chest
    if (x === chestX && y === chestY) continue;

    const obj = map.objects?.[y]?.[x] ?? null;
    if (obj && CRITICAL.has(obj.id)) continue; // don't overwrite critical stuff

    candidates.push({ x, y });
  }

  if (candidates.length < totalNeeded) {
    console.warn("[DUNGEON] Not enough room tiles for rune clues (room-only)", {
      totalNeeded,
      available: candidates.length,
      chestX, chestY,
      regionSize: region.length
    });
    return false;
  }

  // Clear only within this room region (DON'T wipe other puzzle's clues)
  for (const t of region) {
    const o = map.objects?.[t.y]?.[t.x];
    if (o?.id === "rune_clue") map.objects[t.y][t.x] = null;
  }

  // --- Spread via grid buckets over this room's bounding box ---
  const boxW = Math.max(1, (maxX - minX + 1));
  const boxH = Math.max(1, (maxY - minY + 1));
  const gw = Math.max(4, Math.min(10, Math.floor(boxW / 4)));
  const gh = Math.max(4, Math.min(10, Math.floor(boxH / 4)));
  const cellW = boxW / gw;
  const cellH = boxH / gh;

  const buckets = new Map();
  for (const t of candidates) {
    const cx = Math.min(gw - 1, Math.max(0, Math.floor((t.x - minX) / cellW)));
    const cy = Math.min(gh - 1, Math.max(0, Math.floor((t.y - minY) / cellH)));
    const key = cx + "," + cy;
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    arr.push(t);
  }

  let bucketKeys = Array.from(buckets.keys());
  for (let i = bucketKeys.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [bucketKeys[i], bucketKeys[j]] = [bucketKeys[j], bucketKeys[i]];
  }
  for (const key of bucketKeys) {
    const arr = buckets.get(key);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  const picked = [];
  const used = new Set();
  let bi = 0;

  while (picked.length < totalNeeded && bucketKeys.length) {
    const key = bucketKeys[bi % bucketKeys.length];
    const arr = buckets.get(key);

    let chosen = null;
    while (arr && arr.length) {
      const t = arr.pop();
      const k = t.x + "," + t.y;
      if (used.has(k)) continue;
      used.add(k);
      chosen = t;
      break;
    }
    if (chosen) picked.push(chosen);

    if (!arr || arr.length === 0) {
      buckets.delete(key);
      bucketKeys = bucketKeys.filter(k => k !== key);
    } else {
      bi++;
    }
  }

  // Fallback: fill remaining from candidates shuffled
  if (picked.length < totalNeeded) {
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    for (const t of candidates) {
      const k = t.x + "," + t.y;
      if (used.has(k)) continue;
      used.add(k);
      picked.push(t);
      if (picked.length === totalNeeded) break;
    }
  }

  if (picked.length !== totalNeeded) {
    console.warn("[DUNGEON] Rune clue pick failed (room-only)", { totalNeeded, placed: picked.length });
    return false;
  }

  // Place runes (tag them to this chest so you can debug/clean later)
  let idx = 0;
  for (const clue of clues) {
    for (let i = 0; i < clue.count; i++) {
      const spot = picked[idx++];
      if (!spot) return false;
      if (!map.objects[spot.y]) map.objects[spot.y] = [];
      map.objects[spot.y][spot.x] = {
        id: "rune_clue",
        hp: 1,
        meta: { rune: clue.rune, chestX, chestY }
      };
    }
  }

  // Verify within THIS ROOM ONLY (not global)
  let placed = 0;
  for (const t of region) {
    if (map.objects?.[t.y]?.[t.x]?.id === "rune_clue") placed++;
  }
  if (placed !== totalNeeded) {
    console.warn("[DUNGEON] Rune clue mismatch in room", { placed, totalNeeded, chestX, chestY });
    return false;
  }

  return true;
}

function countRunes(map){
  let n=0;
  for(let y=0;y<map.objects.length;y++){
    for(let x=0;x<map.objects[y].length;x++){
      if(map.objects[y][x]?.id==="rune_clue") n++;
    }
  }
  console.log("Rune clues:", n);
}

function makeUniqueRuneCombo(len) {
  const pool = [];
  for (let i = 1; i <= RUNE_COUNT; i++) pool.push(i);

  // shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, len);
}

function randomEmptyFloorInRect(map, rect, tries = 400) {
  for (let i = 0; i < tries; i++) {
    const x = randInt(rect.x, rect.x + rect.w - 1);
    const y = randInt(rect.y, rect.y + rect.h - 1);
    if (map.tiles?.[y]?.[x] !== "floor") continue;
    if (map.objects?.[y]?.[x]) continue;
    return { x, y };
  }
  return null;
}

function rollRuneCombo(len = 4, maxRune = 13) {
  const combo = [];
  for (let i = 0; i < len; i++) {
    combo.push(randInt(1, maxRune));
  }
  return combo;
}

function placePuzzleChestInDungeon(map, chambers) {
  if (!chambers?.length) return;

  // pick a chamber (avoid spawn chamber if you track that; otherwise random)
  const chamber = chambers[randInt(0, chambers.length - 1)];

  // find a floor spot in that chamber
  const spot = randomEmptyFloorInRect(map, chamber, 500);
  if (!spot) return;

  // roll combo (whatever your existing generator is)
  const combo = rollRuneCombo(); // <-- keep YOUR existing combo generator name if different

// generate a 4-digit rune combo (values 1–13)
const puzzleCombo = [];
for (let i = 0; i < 4; i++) puzzleCombo.push(randInt(1, 13));

  // place chest
  if (!map.objects[spot.y]) map.objects[spot.y] = [];
  map.objects[spot.y][spot.x] = {
    id: "dungeon_chest",
    hp: 999,
    meta: {
      isRunePuzzle: true,
      combo: combo,
      // stash coords for debugging
      chestX: spot.x,
      chestY: spot.y
    }
  };

  // queue rune clue placement for finalization step
  if (!map._pendingRuneClues) map._pendingRuneClues = [];
  map._pendingRuneClues.push({
    chamber,
    combo,
    chestX: spot.x,
    chestY: spot.y
  });
}

function isProtectedDungeonObject(o) {
  if (!o) return false;
  if (o.id === "rune_clue") return true;
  if (o.id === "dungeon_chest") return true;
  if (o.id === "dungeon_gate") return true;
  if (o.id === "dungeon_exit") return true;
  return false;
}

function placeChestsInDungeon(map, chambers) {
  if (!objDef("chest")) return;
  if (!Array.isArray(chambers) || chambers.length === 0) return;

  for (const chamber of chambers) {
    const want = randInt(1, 3);

    let placed = 0;
    let safety = 0;

    while (placed < want && safety++ < 600) {
      const spot = randomEmptyFloorInRect(map, chamber, 250);
      if (!spot) break;

      // avoid stacking on spawn/exit if chamber 0 happens to contain them
      if (map.spawn && spot.x === map.spawn.x && spot.y === map.spawn.y) continue;

      const here = map.objects?.[spot.y]?.[spot.x];
      if (here) continue;

      map.objects[spot.y][spot.x] = {
        id: "chest",
        hp: objDef("chest")?.hp ?? 1,
        meta: { dungeonChest: true }
      };

      placed++;
    }
  }
}

function clearAllRuneClues(map) {
  for (let y = 0; y < (map.objects?.length ?? 0); y++) {
    for (let x = 0; x < (map.objects?.[y]?.length ?? 0); x++) {
      if (map.objects?.[y]?.[x]?.id === "rune_clue") map.objects[y][x] = null;
    }
  }
}

// Place rune clues AFTER all other dungeon content so nothing overwrites them.
function finalizePendingRuneClues(map) {
  const jobs = map._pendingRuneClues ?? [];
  if (!jobs.length) return true;

  // wipe any stray clue objects first (safety)
  clearAllRuneClues(map);

  for (const job of jobs) {
    const { chamber, combo, chestX, chestY } = job;

    // hard requirement: MUST place all 10 inside the chest's chamber
    const ok = placeRuneCluesInChamber(map, chamber, combo, chestX, chestY);
    if (!ok) {
      console.warn("[DUNGEON] finalizePendingRuneClues failed", job);
      return false;
    }
  }

  return true;
}

function generateDungeon(dungeonId, entrance) {
  const map = emptyMap(DUNGEON_W, DUNGEON_H, "wall");
  map.entrance = entrance;

  const chambersN = randInt(3, 5);
  const chambers = [];

  for (let i = 0; i < chambersN; i++) {
    const cw = randInt(12, 20);
    const ch = randInt(12, 20);

    let placed = false;
    for (let t = 0; t < 120 && !placed; t++) {
      const x = randInt(2, DUNGEON_W - cw - 3);
      const y = randInt(2, DUNGEON_H - ch - 3);

      const pad = 2;
      const overlaps = chambers.some(r =>
        x < r.x + r.w + pad && x + cw + pad > r.x &&
        y < r.y + r.h + pad && y + ch + pad > r.y
      );
      if (overlaps) continue;

      const rect = { x, y, w: cw, h: ch };
      chambers.push(rect);
      carveRect(map, x, y, cw, ch, "floor");
      placed = true;
    }
  }

  // --- HARD REQUIREMENT: at least 3 chambers, otherwise regenerate ---
  // Sometimes placement fails due to overlaps/space, leaving us with 0-1 rooms.
  if (chambers.length < 3) {
    console.warn("[DUNGEON] chamber placement failed (", chambers.length, "). Regenerating…");
    return generateDungeon(dungeonId, entrance);
  }

  // Connect chambers with twisty corridors + locked gates
  for (let i = 0; i < chambers.length - 1; i++) {
    const a = chambers[i];
    const b = chambers[i + 1];

    const ax = Math.floor(a.x + a.w / 2);
    const ay = Math.floor(a.y + a.h / 2);
    const bx = Math.floor(b.x + b.w / 2);
    const by = Math.floor(b.y + b.h / 2);

    let path = carveWigglyCorridor(map, ax, ay, bx, by);

// If the wiggle corridor failed to actually reach the target,
// fall back to a guaranteed Manhattan corridor so prune doesn't delete rooms.
const last = path[path.length - 1];
if (!last || last[0] !== bx || last[1] !== by) {
  console.warn("[DUNGEON] wiggly corridor failed, using fallback", { ax, ay, bx, by, last });
  path = carveManhattanCorridor(map, ax, ay, bx, by);
}

    // Gate roughly mid-connection, not inside either chamber
    let gate = null;
    let gateK = -1;

    const start = Math.floor(path.length * 0.35);
    const end = Math.floor(path.length * 0.65);

    for (let k = start; k <= end; k++) {
      const [gx, gy] = path[k];
      // Keep the gate far enough away that enforceGateChoke's 3x3 can't chew into room floors
if (pointNearRect(gx, gy, a, 2) || pointNearRect(gx, gy, b, 2)) continue;
      gate = { x: gx, y: gy };
      gateK = k;
      break;
    }

    if (!gate) {
      for (let k = 1; k < path.length - 1; k++) {
        const [gx, gy] = path[k];
        // Keep the gate far enough away that enforceGateChoke's 3x3 can't chew into room floors
if (pointNearRect(gx, gy, a, 2) || pointNearRect(gx, gy, b, 2)) continue;
        gate = { x: gx, y: gy };
        gateK = k;
        break;
      }
    }

    // HARD REQUIREMENT: ALWAYS place a gate between chambers.
    // If our “safe gate spot” logic couldn't find one, force it anyway.
    if (!gate && path.length >= 3) {
      const mid = Math.max(1, Math.min(path.length - 2, Math.floor(path.length / 2)));
      const [gx, gy] = path[mid];
      gate = { x: gx, y: gy };
      gateK = mid;
    }

    if (gate && gateK > 0 && gateK < path.length - 1) {
      const prev = path[gateK - 1];
      const next = path[gateK + 1];

      // Force a 1-tile choke point so the gate can't be bypassed
      enforceGateChoke(map, gate.x, gate.y, prev, next);

      map.objects[gate.y][gate.x] = {
        id: "dungeon_gate",
        hp: 999,
        meta: { locked: true, gateIndex: i }
      };
    }
  }

  // Entrance/exit: center of first chamber
  const first = chambers[0] ?? { x: Math.floor(DUNGEON_W / 2), y: Math.floor(DUNGEON_H / 2), w: 10, h: 10 };
  const ex = Math.floor(first.x + first.w / 2);
  const ey = Math.floor(first.y + first.h / 2);
  map.tiles[ey][ex] = "floor";
  map.objects[ey][ex] = { id: "dungeon_exit", hp: 999, meta: {} };
  map.spawn = { x: ex, y: ey };
  pruneDisconnectedFloors(map, ex, ey);
  
    // --- POST-PRUNE VALIDATION ---
  // If pruneDisconnectedFloors leaves only a tiny connected blob, reroll.
  let floorCount = 0;
  for (let yy = 0; yy < DUNGEON_H; yy++) {
    for (let xx = 0; xx < DUNGEON_W; xx++) {
      if (map.tiles[yy][xx] === "floor") floorCount++;
    }
  }

  const exitStillThere = (map.objects?.[ey]?.[ex]?.id === "dungeon_exit");

  // Tune this threshold if desired. 250 is a good “not pathetic” minimum.
  if (!exitStillThere || floorCount < 250) {
    console.warn("[DUNGEON] rejected after prune", { exitStillThere, floorCount, chambers: chambers.length });
    return generateDungeon(dungeonId, entrance);
  }

  // --- HARD REQUIREMENT: chambers must be separated by locked gates ---
  // We connect chambers sequentially, so minimum gates should be chambers.length - 1.
  let gateCountNow = 0;
  for (let yy = 0; yy < DUNGEON_H; yy++) {
    for (let xx = 0; xx < DUNGEON_W; xx++) {
      if (map.objects?.[yy]?.[xx]?.id === "dungeon_gate") gateCountNow++;
    }
  }

  const minGates = Math.max(2, chambers.length - 1); // at least 2, and ideally one per link
  if (gateCountNow < minGates) {
    console.warn("[DUNGEON] rejected: missing locked gates after prune", { gateCountNow, minGates, chambers: chambers.length });
    return generateDungeon(dungeonId, entrance);
  }

map._pendingRuneClues = [];
clearAllRuneClues(map);

  // Runestones: max 1 per chamber, max 2 per dungeon
placeRunestonesInDungeon(map, chambers);
placePuzzleChestInDungeon(map, chambers); 
placeChestsInDungeon(map, chambers);

  // Dungeon contents (only if they exist)
  const floorTiles = ["floor"];
  if (objDef("rock")) placeObjects(map, DUNGEON_W, DUNGEON_H, "rock", floorTiles, 18);
  if (objDef("stone")) placeObjects(map, DUNGEON_W, DUNGEON_H, "stone", floorTiles, 20);
  if (objDef("wild_mushrooms")) placeObjects(map, DUNGEON_W, DUNGEON_H, "wild_mushrooms", floorTiles, 14);
  if (objDef("rat1")) placeObjects(map, DUNGEON_W, DUNGEON_H, "rat1", floorTiles, 10);
  if (objDef("rat2")) placeObjects(map, DUNGEON_W, DUNGEON_H, "rat2", floorTiles, 8);

// --- Rune clues MUST be placed last so nothing overwrites them ---
if (!finalizePendingRuneClues(map)) {
  console.warn("[DUNGEON] rejected: rune clue finalization failed");
  return generateDungeon(dungeonId, entrance);
}

  // --- HARD REQUIREMENT: exit must exist at spawn ---
  // Re-stamp in case anything ever touched it.
  map.tiles[ey][ex] = "floor";
  map.objects[ey][ex] = { id: "dungeon_exit", hp: 999, meta: {} };
  map.spawn = { x: ex, y: ey };

  // Persist immediately
  state.dungeon = map;
  state.dungeonId = dungeonId;
  saveDungeonLayout(dungeonId);

// fog-of-war grid for dungeons
map.explored = Array.from({ length: DUNGEON_H }, () => Array.from({ length: DUNGEON_W }, () => false));

  return map;
}

function pruneDisconnectedFloors(map, sx, sy) {
  const H = map.tiles.length, W = map.tiles[0].length;
  const seen = Array.from({ length: H }, () => Array(W).fill(false));
  const q = [[sx, sy]];
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];

  const isFloor = (x,y) => map.tiles[y]?.[x] === "floor";

  if (!isFloor(sx, sy)) return;

  seen[sy][sx] = true;
  while (q.length) {
    const [x,y] = q.shift();
    for (const [dx,dy] of dirs) {
      const nx = x+dx, ny = y+dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (seen[ny][nx]) continue;
      if (!isFloor(nx, ny)) continue;
      seen[ny][nx] = true;
      q.push([nx, ny]);
    }
  }

  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (map.tiles[y][x] === "floor" && !seen[y][x]) {
      map.tiles[y][x] = "wall";
      map.objects[y][x] = null;
    }
  }
}
function pickupObject(x, y) {
  const map = getCurrentMap();
  const obj = map.objects[y][x];
  if (!obj) return;

  const def = objDef(obj.id);
  if (!def?.pickup) return;

  const pName = activePlayer().name;

  const inv = activeInv();
  for (const [itemId, amt] of Object.entries(def.pickup.gives)) {
    const res = addItemOrDrop(inv, itemId, amt, x, y, pName);
    playSound("pickup");

    const itemName = itemDef(itemId)?.name ?? itemId;
    const got = (typeof res === "object" && typeof res.added === "number") ? res.added : amt;

    if (got > 0) {
      logAction(`${pName} picked up ${got} ${itemName}${got === 1 ? "" : "s"}.`);
    }
  }

  map.objects[y][x] = null;
  closeMenu();
}

function toolboxLoot(inv, amount = 1, dropX, dropY) {
  const pName = activePlayer().name;
  playSound("chest");
  logAction(`${pName} opened a toolbox.`);

  const tools = ["axe","hammer","pickaxe","fishing_pole","matches","saw","bucket","wrench","shovel","spade","knife","bow_and_arrow"];

  for (let i = 0; i < amount; i++) {
    const toolId = tools[randInt(0, tools.length - 1)];
    const res = addItemOrDrop(inv, toolId, 1, dropX, dropY, pName);

    const toolName = itemDef(toolId)?.name ?? toolId;
    if (res.added > 0) {
      const article = /^[aeiou]/i.test(toolName) ? "an" : "a";
      logAction(`${pName} found ${article} ${toolName}!`);
    }
  }
}

function chestLoot(inv, dropX, dropY) {
  const pName = activePlayer().name;
  playSound("chest");
  logAction(`${pName} opened a chest.`);

  const tools = ["axe", "hammer", "pickaxe", "fishing_pole", "matches", "saw", "bucket", "wrench", "shovel", "spade", "knife", "bow_and_arrow"];

  // Chance to find a Cipher (used to decipher runestones)
  if (state.data?.items?.cipher) {
    const already = getQty(inv, "cipher") > 0;

    // Higher chance until you have one, then rarer extras
    const chance = already ? 0.12 : 0.45;

    if (Math.random() < chance) {
      const res = addItemOrDrop(inv, "cipher", 1, dropX, dropY, pName);
      if (res.added > 0) logAction(`${pName} found a Cipher!`);
    }
  }

const allRecipeScrolls = Object.keys(state.data.items).filter(id =>
  isRecipeScroll(id) && recipeIdFromScroll(id) // only if it maps to a real recipe
);

// Only allow:
// - unlearned recipes freely
// - learned recipes only if we haven't dropped the "one extra" copy yet
const lootableRecipeScrolls = allRecipeScrolls.filter(scrollId => {
  const rid = recipeIdFromScroll(scrollId);
  if (!rid) return false;
  if (!state.learnedRecipes.has(rid)) return true;
  return (state.recipeLootExtra[rid] ?? 0) < 1;
});

  const hashouseBlueprint = getQty(inv, "blueprint_house") > 0;
  const pieces = getQty(inv, "blueprint_piece");

  // Main loot roll
  const roll = Math.random();
  if (!hashouseBlueprint && pieces < 6 && roll < 0.65) {
    addItem(inv, "blueprint_piece", 1);
    logAction(`${pName} found a blueprint piece!`);
} else {
  // Chance to drop a recipe scroll; otherwise drop a tool like before
  if (lootableRecipeScrolls.length > 0 && Math.random() < 0.35) {
    const scrollId = lootableRecipeScrolls[randInt(0, lootableRecipeScrolls.length - 1)];
    const rid = recipeIdFromScroll(scrollId);

    addItem(inv, scrollId, 1);
    logAction(`${pName} found a ${itemDef(scrollId)?.name ?? scrollId}!`);

    // If it was already learned, this is the single allowed "extra" copy for trading
    if (rid && state.learnedRecipes.has(rid)) {
      state.recipeLootExtra[rid] = 1;
    }
  } else {
    const tool = tools[randInt(0, tools.length - 1)];
    addItem(inv, tool, 1);
    logAction(`${pName} found an ${itemDef(tool)?.name ?? tool}!`);
  }
}

  // Extra small loot (log each if it happens)
  if (Math.random() < 0.35) {
    const amt = randInt(1, 3);
    addItem(inv, "stick", amt);
    logAction(`${pName} found ${amt} ${itemDef("stick")?.name ?? "stick"}${amt === 1 ? "" : "s"}!`);
  }

  if (Math.random() < 0.25) {
    const amt = randInt(1, 4);
    addItem(inv, "stone", amt);
    logAction(`${pName} found ${amt} ${itemDef("stone")?.name ?? "stone"}${amt === 1 ? "" : "s"}!`);
  }

  // Snacks (items tagged "snack")
  const snackIds = Object.keys(state.data.items).filter(id => {
    const it = itemDef(id);
    return Array.isArray(it?.tags) && it.tags.includes("snack");
  });

  if (snackIds.length > 0 && Math.random() < 0.30) {
    const snackId = snackIds[randInt(0, snackIds.length - 1)];
    const amt = randInt(1, 2);
    addItemOrDrop(inv, snackId, amt, dropX, dropY, pName);
    const nm = itemDef(snackId)?.name ?? snackId;
    logAction(`${pName} found ${amt} ${nm}${amt === 1 ? "" : "s"}!`);
  }
  
    // Treasure maps (special quest item)
  if (Math.random() < 0.10) {
    const res = addItemOrDrop(inv, "treasure_map", 1, dropX, dropY, pName);
    if (res.added > 0) logAction(`${pName} found a Treasure Map!`);
  }

    // Collectibles (items tagged "collectible")
  const collectibleIds = Object.keys(state.data.items).filter(id => {
    const it = itemDef(id);
    return Array.isArray(it?.tags) && it.tags.includes("collectible");
  });

  // Small chance to drop a collectible (1x)
  if (collectibleIds.length > 0 && Math.random() < 0.22) {
    const cid = collectibleIds[randInt(0, collectibleIds.length - 1)];
    const res = addItemOrDrop(inv, cid, 1, dropX, dropY, pName);

    if (res.added > 0) {
      const nm = itemDef(cid)?.name ?? cid;
      const article = /^[aeiou]/i.test(nm) ? "an" : "a";
	  playSound("achievement");
      logAction(`${pName} found ${article} ${nm}!`);
    }
  }

  // Auto-assemble blueprint at 6 pieces
const newPieces = getQty(inv, "blueprint_piece");
if (newPieces >= 6 && getQty(inv, "blueprint_house") === 0) {
  // Find a slot that contains blueprint pieces
  const idx = inv.findIndex(s => s && s.id === "blueprint_piece" && s.qty > 0);

  if (idx !== -1) {
    // Remove 6 pieces from that slot first
    inv[idx].qty -= 6;

    // If that stack is now empty (<=0), CONVERT THAT SLOT into the blueprint.
    if (inv[idx].qty <= 0) {
      inv[idx] = { id: "blueprint_house", qty: 1 };
    } else {
      // Otherwise, we still need to add the blueprint somewhere else.
      // This should succeed because we didn't rely on a "freed slot".
      const ok = addItem(inv, "blueprint_house", 1);
      if (!ok) {
        // If your addItem can fail when full, drop it instead
        addDroppedItem(activePlayer().x, activePlayer().y, "blueprint_house", 1);
      }
    }

    playSound("achievement");
    logAction(`${pName} assembled a House Blueprint!`);
  }
}
}

function openContainerObject(mapX, mapY) {
  if (state.mode !== "overworld") return;

  const obj = state.world.objects?.[mapY]?.[mapX];
  if (!obj) return;

  const def = objDef(obj.id);
  if (!def?.container) return;

  if (obj.id === "chest") {
    chestLoot(activeInv(), mapX, mapY);
    state.world.objects[mapY][mapX] = null;
    closeMenu();
    return;
  }

  if (obj.id === "stockpile") {
    state.stockpileOpen = { key: obj.meta?.key };
    closeMenu();
    return;
  }

  if (obj.id === "toolbox") {
    const amount = def.container?.amount ?? 1;
    toolboxLoot(activeInv(), amount, mapX, mapY);
    state.world.objects[mapY][mapX] = null;
    closeMenu();
    return;
  }
}

function openToolkitForActivePlayer() {
  const inv = activeInv();
  if (getQty(inv, "toolkit") <= 0) return;

  const pName = activePlayer().name;

  // consume toolkit
  removeItem(inv, "toolkit", 1);
  playSound("pickup");
  logAction(`${pName} opened a toolkit.`);

  // starter matches for testing campfire
  addItem(inv, "matches", 24);
  logAction(`${pName} got 24 ${itemDef("matches")?.name ?? "matches"}!`);

  // TEMP TEST LOADOUT – one of everything
  const starterTools = [
    "axe",
    "hammer",
    "pickaxe",
    "fishing_pole",
    "saw",
    "knife",
    "bow_and_arrow",
    "bucket",
    "shovel",
    "spade"
  ];

  for (const toolId of starterTools) {
    if (!itemDef(toolId)) continue;
    addItem(inv, toolId, 1);
    const nm = itemDef(toolId)?.name ?? toolId;
    logAction(`${pName} got a ${nm}!`);
  }
}

function openCraftingScreen(mode) {
  state.craftingOpen = true;
  state.craftingMode = mode; // "craft" | "cook"
  state.selectedForCraft.clear();
}

function closeCraftingScreen() {
  state.craftingOpen = false;
  state.craftingMode = null;
  state.selectedForCraft.clear();
}

function tryEnterAt(x, y) {
  const obj = state.world.objects[y]?.[x];
  if (!obj) return;
  const def = objDef(obj.id);
  if (def?.type !== "house" && obj.id !== "house") return;

  // Store where the ACTIVE player entered from (so only they return)
  const p = activePlayer();
  state.interiorReturn = { x: p.x, y: p.y };

  // If we’re trying to keep players independent, don’t “link” them across maps.
  state.holdingHands = null;

  state.interiorId = obj.meta?.interiorId || "house_small";
  state.interior = generateInterior(state.interiorId);
  state.mode = "interior";

  // Place ONLY the active player near interior door
  p.x = 2; 
  p.y = INTERIOR_H - 2;
  p.fx = p.x; 
  p.fy = p.y;
  p.path = [];

  // Stop the other player from continuing a path inside the wrong map context
  for (const pl of state.players) {
    if (pl !== p) pl.path = [];
  }

  state.cam.x = 0; 
  state.cam.y = 0;
  clampCamera();
  closeMenu();
}

// DEV: enter an interior without needing a built house
function devEnterInterior(interiorId = "house_small") {
  state.interiorId = interiorId;
  state.interior = generateInterior(state.interiorId);
  state.mode = "interior";

  // place players near interior door (same as tryEnterAt)
  state.players[0].x = 2; state.players[0].y = INTERIOR_H - 2; state.players[0].fx = 2; state.players[0].fy = INTERIOR_H - 2;
  state.players[1].x = 3; state.players[1].y = INTERIOR_H - 2; state.players[1].fx = 3; state.players[1].fy = INTERIOR_H - 2;

  state.cam.x = 0; state.cam.y = 0;
  clampCamera();
  closeMenu();

  logAction(`DEV: entered interior "${state.interiorId}".`);
}

// DEV: jump to nearest cave/hole and enter dungeon
function devEnterNearestDungeon() {
  if (state.mode !== "overworld") {
    logAction("DEV: must be in overworld to enter a dungeon.");
    return false;
  }

  const p = activePlayer();
  const W = WORLD_W, H = WORLD_H;

  let best = null;
  let bestD = Infinity;

  for (let y = 0; y < H; y++) {
    const row = state.world.objects?.[y];
    if (!row) continue;
    for (let x = 0; x < W; x++) {
      const o = row[x];
      if (!o) continue;
      if (o.id !== "cave" && o.id !== "hole") continue;

      const d = Math.abs(x - p.x) + Math.abs(y - p.y);
      if (d < bestD) { bestD = d; best = { x, y, id: o.id }; }
    }
  }

  if (!best) {
    logAction("DEV: no cave/hole found on the map.");
    return false;
  }

  // Snap player near it first (optional but nice)
  state.players[0].x = best.x; state.players[0].y = best.y + 1;
  state.players[0].fx = state.players[0].x; state.players[0].fy = state.players[0].y; state.players[0].path = [];
  state.players[1].x = best.x + 1; state.players[1].y = best.y + 1;
  state.players[1].fx = state.players[1].x; state.players[1].fy = state.players[1].y; state.players[1].path = [];

  clampCamera();

  // Enter the dungeon using your real pipeline
  return tryEnterDungeonAt(best.x, best.y);
}

function tryExitInterior() {
  if (state.mode !== "interior") return false;
  const p = activePlayer();
  const doorTile = state.data.interiors[state.interiorId].doorTile;

  const nearDoor = neighbors4(p.x, p.y).some(([nx, ny]) =>
    inBounds(nx, ny, INTERIOR_W, INTERIOR_H) && state.interior.tiles[ny][nx] === doorTile
  );
  if (!nearDoor) return false;

  state.mode = "overworld";

  // Return ONLY the active player to where they entered from
  const ret = state.interiorReturn;
  const rx = ret?.x ?? 2;
  const ry = ret?.y ?? 2;

  p.x = rx; 
  p.y = ry;
  p.fx = rx; 
  p.fy = ry;
  p.path = [];

  // Safety: don’t let the other player “keep walking” with overworld rules mid-transition
  for (const pl of state.players) {
    if (pl !== p) pl.path = [];
  }

  clampCamera();
  closeMenu();
  return true;
}


function tryEnterDungeonAt(x, y) {
  if (state.mode !== "overworld") return false;
  const obj = state.world.objects?.[y]?.[x];
  if (!obj) return false;
  if (obj.id !== "cave" && obj.id !== "hole") return false;

  const type = obj.id;
  const dungeonId = dungeonIdForEntrance(type, x, y);
  state.dungeonReturn = { x, y, type };

  const saved = loadDungeonLayout(dungeonId);
console.log("[DUNGEON] enter", { dungeonId, hasSaved: !!saved });

const map = saved ? buildDungeonFromPayload(saved) : generateDungeon(dungeonId, { type, x, y });
console.log("[DUNGEON] source", saved ? "SAVED" : "GENERATED");

  state.dungeon = map;
  state.dungeonId = dungeonId;
  state.mode = "dungeon";

// Stop ambience immediately
if (state.music.ambienceAudio) {
  beginAmbFadeTo(0, 300, () => {
    try { state.music.ambienceAudio.pause(); } catch (_) {}
  });
}
 // --- Fade out current music, switch to a random dungeon track, fade back in ---
  beginFadeTo(0, 300);
  setTimeout(() => {
    const nextName = pickRandomDungeonTrack(state.music.lastTrack);
    state.music.lastTrack = nextName;

    const a = ensureMusicAudio();
    a.src = `src/music/${nextName}.mp3`;
    a.currentTime = 0;

    a.play().then(() => {
      // fade back to slider volume
      beginFadeTo(getMusicVolume(), 600);
    }).catch(() => {
      // if autoplay blocks, at least don't crash
    });
  }, 300);

  const sx = map.spawn?.x ?? 2;
const sy = map.spawn?.y ?? 2;

// Independence mode: entering player goes in, the other stays put.
const p = activePlayer();

// Also kill holding hands so the “drag” logic doesn’t yank the other player across maps.
state.holdingHands = null;

p.x = sx; 
p.y = sy;
p.fx = sx; 
p.fy = sy;
p.path = [];

// Stop non-active from marching around in dungeon rules
for (const pl of state.players) {
  if (pl !== p) pl.path = [];
}


// ---- Dungeon fog-of-war init + first reveal ----
{
  const { w, h } = currentDims();
  if (!state.dungeon.explored || state.dungeon.explored.length !== h || state.dungeon.explored[0]?.length !== w) {
    state.dungeon.explored = Array.from({ length: h }, () => Array.from({ length: w }, () => false));
  }
  revealAroundPlayers(); // reveals around both players using VIS_RADIUS (and holdingHands mult)
}

 const { viewW, viewH } = viewTiles();
state.cam.x = Math.floor(sx - viewW / 2);
state.cam.y = Math.floor(sy - viewH / 2);
clampCamera();
  closeMenu();
  logAction(`${activePlayer().name} entered a dungeon...`);
  return true;
}

function exitDungeon() {
  if (state.mode !== "dungeon") return false;
  const p = activePlayer();

  let nearExit = false;
  for (const [nx, ny] of [[p.x, p.y], ...neighbors4(p.x, p.y)]) {
    const o = state.dungeon?.objects?.[ny]?.[nx];
    if (o && o.id === "dungeon_exit") { nearExit = true; break; }
  }
  if (!nearExit) return false;

  saveDungeonLayout(state.dungeonId);

  const ret = state.dungeonReturn;
  state.mode = "overworld";
  playAmbienceForContext(true);
playRandomMusicForContext(true);
  state.dungeon = null;
  state.dungeonId = null;

const rx = ret?.x ?? 2;
const ry = ret?.y ?? 2;

// Return ONLY the active player
const p2 = activePlayer();
p2.x = rx; 
p2.y = ry;
p2.fx = rx; 
p2.fy = ry;
p2.path = [];

// Keep other player stable
for (const pl of state.players) {
  if (pl !== p2) pl.path = [];
}

  clampCamera();
  closeMenu();
  logAction(`${p.name} escaped the dungeon.`);
  return true;
}

// house placement (placeholder construction)
function canBuildhouseNow() {
  const inv = activeInv();
  return getQty(inv, "blueprint_house") > 0 && getQty(inv, "hammer") > 0;
}

function placehouseAt(x, y) {
  if (state.mode !== "overworld") return false;
  if (!canBuildhouseNow()) return false;

  // 2x2 footprint
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const tx = x + dx, ty = y + dy;
    if (!inBounds(tx, ty, WORLD_W, WORLD_H)) return false;
    if (!isPassable(tx, ty)) return false;
  }

  removeItem(activeInv(), "blueprint_house", 1);

  state.world.objects[y][x] = { id: "house", hp: 999, meta: { interiorId: "house_small" } };
  state.world.objects[y][x + 1] = { id: "occupied", hp: 999, meta: { parent: [x, y] } };
  state.world.objects[y + 1][x] = { id: "occupied", hp: 999, meta: { parent: [x, y] } };
  state.world.objects[y + 1][x + 1] = { id: "occupied", hp: 999, meta: { parent: [x, y] } };

  saveHouseAt(x, y);

  // Log placement with coords
  const pName = activePlayer().name;
  logAction(`${pName} placed a house at (${x},${y}).`);

  return true;
}

// Stockpile placement + inventory
function placeStockpileAt(x, y) {
  if (state.mode !== "overworld") return false;
  if (!isPassable(x, y)) return false;

  const key = `stockpile:${x},${y}:${Date.now()}`;
  state.structures.stockpiles.push({ key, x, y, inv: [] });
  state.world.objects[y][x] = { id: "stockpile", hp: 999, meta: { key } };

  saveStockpileAt(x, y, key);

  // Log placement with coords (requested)
  const pName = activePlayer().name;
  logAction(`${pName} placed a stockpile at (${x},${y}).`);

  return true;
}

function getStockpileByKey(key) {
  return state.structures.stockpiles.find(s => s.key === key) || null;
}

// ------------------------------------------------------------------------------ Context menu ----
function openMenu(opts) {
  state.menu = {
    screenX: opts.screenX,
    screenY: opts.screenY,
    title: opts.title,
    options: opts.options,
    hoverIndex: -1,
    _justOpened: true
  };
}

function closeMenu() { state.menu = null; }

function openMenuForPlayer(plIndex, screenX, screenY) {
  const pl = state.players[plIndex];
  const inv = activeInv();
  const options = [];

  if (!pl.resting) {
    options.push({
      label: "Rest",
      action: () => {
        pl.resting = true;
        pl.path = [];
        logAction(`${pl.name} started resting.`);
        closeMenu();
      }
    });
  } else {
    options.push({
      label: "Stop resting",
      action: () => {
        pl.resting = false;
        logAction(`${pl.name} stopped resting.`);
        closeMenu();
      }
    });
  }

 function buildWorkbenchAtPlayer() {
  if (state.mode !== "overworld") return false;

  const p = activePlayer();
  const inv = activeInv();

  if (state.world.objects[p.y][p.x]) return false;
  if (getQty(inv, "wood") < 10) return false;
  if (!hasTool(inv, "hammer")) return false;
  if (!hasTool(inv, "saw")) return false;

  removeItem(inv, "wood", 10);

  playSound("hammer");
  state.world.objects[p.y][p.x] = { id: "workbench", hp: 999 };

  // AUTO-MARK
  addMarker("Workbench", p.x, p.y, "workbench");

  logAction(`${p.name} built a workbench at (${p.x},${p.y}).`);
  return true;
}

  // ---- Build workbench option ----
  let workbenchDisabled = null;
  if (state.mode !== "overworld") workbenchDisabled = "Overworld only";
  else if (objectAt(pl.x, pl.y)) workbenchDisabled = "Tile occupied";
  else if (getQty(inv, "wood") < 10) workbenchDisabled = "Needs 10 wood";
  else if (!hasTool(inv, "hammer")) workbenchDisabled = "Needs hammer";
  else if (!hasTool(inv, "saw")) workbenchDisabled = "Needs saw";

  options.push({
    label: "Build workbench",
    disabledReason: workbenchDisabled,
    action: () => {
      if (workbenchDisabled) return;
      if (buildWorkbenchAtPlayer()) closeMenu();
    }
  });

  // ---- Build campfire option ----
  let campfireDisabled = null;
  if (state.mode !== "overworld") campfireDisabled = "Overworld only";
  else if (objectAt(pl.x, pl.y)) campfireDisabled = "Tile occupied";
  else if (getQty(inv, "wood") < 3) campfireDisabled = "Needs 3 wood";
  else if (getQty(inv, "matches") < 1) campfireDisabled = "Needs matches";

  options.push({
    label: "Build campfire",
    disabledReason: campfireDisabled,
    action: () => {
      if (campfireDisabled) return;
      if (buildCampfireAtPlayer()) closeMenu();
    }
  });

  // ---- Dig option (requires shovel) ----
  if (hasTool(inv, "shovel")) {
    let digDisabled = null;
    if (state.mode !== "overworld") digDisabled = "Overworld only";
    else if (tileAt(pl.x, pl.y) !== "grass") digDisabled = "Grass only";
    else if (objectAt(pl.x, pl.y)) digDisabled = "Tile occupied";

    options.push({
      label: "Dig",
      disabledReason: digDisabled,
      action: withSfx("dig", () => {
        if (digDisabled) return;
        digAtPlayerTile();
        closeMenu();
      })
    });
  }

  options.push({
    label: "Place stockpile",
    action: () => {
      playSound("pop");
      state.placingStockpile = true;
      closeMenu();
    }
  });

  openMenu({
    screenX,
    screenY,
    title: pl.name,
    options
  });
}

function sendInteractionRequest(type, fromIndex, toIndex) {
  // One request at a time. Humans can’t even handle one, so this is generous.
  if (state.interactionRequest) return;

  state.interactionRequest = {
    type,
    fromIndex,
    toIndex,
    createdAt: Date.now()
  };

  const fromName = state.players[fromIndex].name;
  const toName = state.players[toIndex].name;

  logAction(`${fromName} requested: ${type} → ${toName}.`);
  closeMenu();
}

function acceptInteractionRequest() {
  const req = state.interactionRequest;
  if (!req) return;

  // Only the intended receiver can accept
  if (state.activePlayer !== req.toIndex) return;

  const from = state.players[req.fromIndex].name;
  const to = state.players[req.toIndex].name;

  if (req.type === "Hold hands") {
    // We’ll implement movement linking next step.
    state.holdingHands = { a: req.fromIndex, b: req.toIndex, leader: req.fromIndex };
    logAction(`${to} accepted: Hold hands with ${from}.`);
    playSound("pickup"); // placeholder sfx, swap later if you add a cute sound
  } else if (req.type === "Kiss") {
    logAction(`${to} accepted: Kiss from ${from}.`);
    playSound("pickup"); // placeholder
  } else if (req.type === "Hug") {
    logAction(`${to} accepted: Hug from ${from}.`);
    playSound("pickup"); // placeholder
  } else if (req.type === "Trade") {
    logAction(`${to} accepted: Trade with ${from}.`);
    playSound("pickup"); // placeholder
    // Trade screen will be its own step.
  }

  state.interactionRequest = null;
}

function declineInteractionRequest() {
  const req = state.interactionRequest;
  if (!req) return;

  // Only the intended receiver can decline
  if (state.activePlayer !== req.toIndex) return;

  const from = state.players[req.fromIndex].name;
  const to = state.players[req.toIndex].name;

  logAction(`${to} declined: ${req.type} from ${from}.`);
  state.interactionRequest = null;
}

function openMenuForOtherPlayer(targetIndex, screenX, screenY) {
  const me = state.activePlayer;
  const other = targetIndex;

  const otherName = state.players[other].name;

  const reqBusy = !!state.interactionRequest;
  const holding = state.holdingHands &&
    (state.holdingHands.a === me || state.holdingHands.b === me);

  const options = [
    {
      label: "Hold hands",
      disabledReason: reqBusy ? "Pending request" : (holding ? "Already holding hands" : null),
      action: () => sendInteractionRequest("Hold hands", me, other)
    },
    {
      label: "Kiss",
      disabledReason: reqBusy ? "Pending request" : null,
      action: () => sendInteractionRequest("Kiss", me, other)
    },
    {
      label: "Hug",
      disabledReason: reqBusy ? "Pending request" : null,
      action: () => sendInteractionRequest("Hug", me, other)
    },
    {
      label: "Trade",
      disabledReason: reqBusy ? "Pending request" : null,
      action: () => sendInteractionRequest("Trade", me, other)
    }
  ];

  // If already holding hands, allow ending it from either player
  if (holding) {
    options.unshift({
      label: "End holding hands",
      action: () => {
        state.holdingHands = null;
        logAction(`${state.players[me].name} ended holding hands.`);
        closeMenu();
      }
    });
  }

  openMenu({ screenX, screenY, title: otherName, options });
}

function openMenuForHoldingHands(screenX, screenY) {
  const hh = state.holdingHands;
  if (!hh) return;

  const aName = state.players[hh.a].name;
  const bName = state.players[hh.b].name;

  openMenu({
    screenX, screenY,
    title: "Holding Hands",
    options: [
      { label: `${aName} + ${bName}`, disabledReason: "Aww." },
      {
        label: "End holding hands",
        action: () => {
          state.holdingHands = null;
          logAction(`Holding hands ended.`);
          closeMenu();
        }
      }
    ]
  });
}

function openMenuForTile(mapX, mapY, screenX, screenY) {
let obj = objectAt(mapX, mapY);
if (!obj) return;

// ---- INTERIOR PROXY RESOLVE ----
if (state.mode === "interior") {
  const isProxy =
    obj.id === "occupied" ||
    obj.id === "occupied_pass" ||
    (typeof obj.id === "string" && obj.id.startsWith("occupied"));

  const a = obj.meta?.anchor;

  if (isProxy && a && typeof a.x === "number" && typeof a.y === "number") {
    const real = objectAt(a.x, a.y);
    if (real) {
      obj = real;
      mapX = a.x;
      mapY = a.y;
    }
  }
}

  const p = activePlayer();
  const inv = activeInv();

// ---- Bed: sleep ----
if (obj.id === "bed") {
  openMenu({
    screenX, screenY,
    title: "Bed",
    options: [
      {
        label: "Sleep",
        action: withSfx("click", () => {
          closeMenu();
          sleepInBed();
        })
      }
    ]
  });
  return;
}

if (state.mode === "dungeon" && obj.id === "dungeon_exit") {
  const tooFar = !isAdjacentOrSame(p.x, p.y, mapX, mapY);
  openMenu({
    screenX, screenY,
    title: "Exit",
    options: [{
      label: "Exit dungeon",
      disabledReason: tooFar ? "Too far" : null,
      action: withSfx("door_open", () => {
        if (tooFar) return;
        closeMenu();
        exitDungeon();
      })
    }]
  });
  return;
}

if (state.mode === "dungeon" && obj.id === "dungeon_gate") {
  const tooFar = !isAdjacentOrSame(p.x, p.y, mapX, mapY);
  const needKey = !hasTool(inv, "dungeon_key");

  openMenu({
    screenX, screenY,
    title: "Locked Gate",
    options: [{
      label: "Unlock (1 Dungeon Key)",
      disabledReason: tooFar ? "Too far" : (needKey ? "Need Dungeon Key" : null),
      action: withSfx("click", () => {
        if (tooFar || needKey) return;
        removeItem(inv, "dungeon_key", 1);
        getCurrentMap().objects[mapY][mapX] = { id: "dungeon_gate_open", hp: 999, meta: {} };
        saveDungeonLayout(state.dungeonId);
		playSound("unlock");
        logAction(`${p.name} unlocked a gate.`);
        closeMenu();
      })
    }]
  });
  return;
}

// --- Runestone: Decipher (requires cipher in inventory) ---
if (obj.id === "runestone") {
  const hasCipher = getQty(inv, "cipher") > 0;

  let disabledReason = null;
  if (!isAdjacentOrSame(p.x, p.y, mapX, mapY)) disabledReason = "Too far";
  else if (!hasCipher) disabledReason = "Needs cipher";

  openMenu({
    screenX, screenY,
    title: "Runestone",
    options: [
      {
        label: "Decipher",
        disabledReason,
        action: withSfx("pickup", () => {
          if (disabledReason) return;

          const msg = obj.meta?.msg || "(The stone is weathered beyond reading.)";
          openRunestoneReader("Runestone", msg);
          closeMenu();
        })
      }
    ]
  });
  return;
}

// --- Puzzle Chest: Rune Combination Lock ---
if (state.mode === "dungeon" && obj.id === "dungeon_chest") {
  const tooFar = !isAdjacentOrSame(p.x, p.y, mapX, mapY);

  openMenu({
    screenX, screenY,
    title: "Locked Chest",
    options: [{
      label: "Unlock",
      disabledReason: tooFar ? "Too far" : null,
      action: withSfx("click", () => {
        if (tooFar) return;
        closeMenu();
        openRuneComboLockForChest(mapX, mapY);
      })
    }]
  });
  return;
}

// --- Dungeon Chest: Open ---
if (state.mode === "dungeon" && obj.id === "chest") {
  const tooFar = !isAdjacentOrSame(p.x, p.y, mapX, mapY);

  openMenu({
    screenX, screenY,
    title: "Chest",
    options: [{
      label: "Open",
      disabledReason: tooFar ? "Too far" : null,
      action: withSfx("chest", () => {
        if (tooFar) return;

        chestLoot(inv, mapX, mapY);
        getCurrentMap().objects[mapY][mapX] = null;
        saveDungeonLayout(state.dungeonId);
        closeMenu();
      })
    }]
  });

  return;
}

  // ---- Dropped item special menu (must be before objDef) ----
  if (obj.id === "dropped_item") {
    const tooFar = !isAdjacentOrSame(p.x, p.y, mapX, mapY);

    const itemId = obj.meta?.itemId;
    const qty = obj.meta?.qty ?? 1;
    const name = itemDef(itemId)?.name ?? itemId ?? "item";

    openMenu({
      screenX, screenY,
      title: name,
      options: [
        // Eat (only if item has nourishment)
        ...(typeof itemDef(itemId)?.nourishment === "number" ? [{
          label: `Eat (+${itemDef(itemId).nourishment})`,
          disabledReason: tooFar ? "Too far" : null,
          action: withSfx("eat", () => { 
            if (tooFar) return;

            const n = itemDef(itemId).nourishment;
            p.hunger = clamp((p.hunger ?? 0) - n, 0, HUNGER_MAX);

            // consume 1 from the ground stack
            const newQty = (obj.meta?.qty ?? 1) - 1;
            if (newQty <= 0) {
              getCurrentMap().objects[mapY][mapX] = null;
            } else {
              obj.meta = obj.meta || {};
              obj.meta.itemId = itemId;
              obj.meta.qty = newQty;
            }

            logAction(`${p.name} ate ${name}.`);
            closeMenu();
          })
        }] : []),

        {
          label: `Pick up (${qty})`,
          disabledReason: tooFar ? "Too far" : null,
          action: withSfx("pickup", () => {
  if (tooFar) return;

  // IMPORTANT: this expects addItem() to return { added, remaining, ok }
  const res = addItem(inv, itemId, qty);

  // Fallback if your addItem still returns boolean (old behavior)
  // (This won't do partial pickup until addItem is updated.)
  if (typeof res === "boolean") {
    if (res) {
      getCurrentMap().objects[mapY][mapX] = null;
      logAction(`${p.name} picked up ${qty} ${name}${qty === 1 ? "" : "s"}.`);
    } else {
      logAction(`${p.name}'s inventory is full. Couldn't pick up ${qty} ${name}${qty === 1 ? "" : "s"}.`);
    }
    closeMenu();
    return;
  }

  if (res.added > 0) {
    logAction(`${p.name} picked up ${res.added} ${name}${res.added === 1 ? "" : "s"}.`);
  }

  if (res.remaining <= 0) {
    getCurrentMap().objects[mapY][mapX] = null;
  } else {
    // Leave the remainder on the ground
    obj.meta = obj.meta || {};
    obj.meta.itemId = itemId;
    obj.meta.qty = res.remaining;

    logAction(`${p.name}'s inventory is full. ${res.remaining} ${name}${res.remaining === 1 ? "" : "s"} stayed on the ground.`);
  }

  closeMenu();
})
        }
      ]
    });

    return;
  }

  // ---- Planted seed special menu ----
  if (obj.id === "planted_seed") {
    const tooFar = !isAdjacentOrSame(p.x, p.y, mapX, mapY);
    const m = obj.meta ?? (obj.meta = {});
    const seedId = m.seedId;
    const seedName = itemDef(seedId)?.name ?? seedId ?? "Planted Seed";

    const today = state.time.day;
    const wateredToday = (m.lastWaterDay === today);
    const ready = !!m.ready || (m.progress ?? 0) >= GROW_DAYS;

    // bucket IDs you already use elsewhere
    const emptyBucketId = firstExistingItemId(["bucket", "empty_bucket"]);
    const filledBucketId = firstExistingItemId(["bucket_water", "water_bucket", "bucket_of_water"]);

    let waterDisabled = null;
    if (tooFar) waterDisabled = "Too far";
    else if (!filledBucketId) waterDisabled = "No water bucket item exists";
    else if (getQty(inv, filledBucketId) <= 0) waterDisabled = "Needs bucket of water";
    else if (wateredToday) waterDisabled = "Already watered today";

    let harvestDisabled = null;
    if (tooFar) harvestDisabled = "Too far";
    else if (!ready) harvestDisabled = `Not ready (${m.progress ?? 0}/${GROW_DAYS} days)`;

    openMenu({
      screenX, screenY,
      title: seedName,
      options: [
        { label: `Progress: ${m.progress ?? 0}/${GROW_DAYS}`, disabledReason: " " },
        { label: wateredToday ? "Watered: Yes (today)" : (m.wateredEver ? "Watered: No (today)" : "Watered: Never"), disabledReason: " " },
        {
          label: "Water",
          disabledReason: waterDisabled,
          action: withSfx("water", () => {
            if (waterDisabled) return;

            // spend 1 water bucket, return empty bucket
            removeItem(inv, filledBucketId, 1);
            if (emptyBucketId) addItem(inv, emptyBucketId, 1);

            m.lastWaterDay = today;
            m.wateredEver = true;

            logAction(`${p.name} watered the ${seedName}.`);
            closeMenu();
          })
        },
        {
          label: "Harvest",
          disabledReason: harvestDisabled,
          action: withSfx("pickup", () => {
            if (harvestDisabled) return;

            const growsTo = seedGrowsToItemId(seedId);
            if (!growsTo) return;

            getCurrentMap().objects[mapY][mapX] = {
              id: "dropped_item",
              hp: 1,
              meta: { itemId: growsTo, qty: 1 }
            };

            logAction(`${p.name} harvested ${itemDef(growsTo)?.name ?? growsTo}!`);
            closeMenu();
          })
        }
      ]
    });

    return;
  }

  const def = objDef(obj.id);
  if (!def) return;

  // Allow ranged interaction for huntable animals if player has bow_and_arrow (up to 3 tiles)
  const dist = Math.abs(p.x - mapX) + Math.abs(p.y - mapY);
  const huntData = def.hunt || def.harvest; // support either key
  const isHuntable =
    (Array.isArray(def.tags) && def.tags.includes("hunt")) ||
    (huntData && huntData.requiresTool === "bow_and_arrow");

  const hasBow = getQty(inv, "bow_and_arrow") > 0;
  const allowRangedHunt = isHuntable && hasBow && dist <= 3;

// Bed is always interactable if clicked (even if you're far away)
if (obj.id !== "bed" && !isAdjacentOrSame(p.x, p.y, mapX, mapY) && !allowRangedHunt) return;

  const options = [];

  // ---- Campfire menu ----
if (obj.id === "workbench") {
  options.push({
    label: "Craft",
    action: () => {
      openCraftingScreen("craft");
      closeMenu();
    }
  });
}

// ---- Stove menu ----
if (obj.id === "stove") {
  options.push({
    label: "Cook",
    action: () => {
      openCraftingScreen("cook");
      closeMenu();
    }
  });
}

// ---- Counter menu ----
if (obj.id === "counter") {
  options.push({
    label: "Prepare",
    action: () => {
      openCraftingScreen("prep");
      closeMenu();
    }
  });
}

if (state.mode === "overworld" && (obj.id === "cave" || obj.id === "hole")) {
  const tooFar = !isAdjacentOrSame(p.x, p.y, mapX, mapY);
  options.push({
    label: "Enter dungeon",
    disabledReason: tooFar ? "Too far" : null,
    action: withSfx("door_open", () => {
      if (tooFar) return;
      tryEnterDungeonAt(mapX, mapY);
      closeMenu();
    })
  });
}

// ---- Bed menu ----
if (obj.id === "bed") {
  const tooFar = !isAdjacentOrSame(p.x, p.y, mapX, mapY);

  options.push({
    label: "Sleep",
    disabledReason: tooFar ? "Too far" : null,
    action: () => {
      if (tooFar) return;
      closeMenu();
      sleepInBed();
    }
  });
}

if (obj.id === "campfire") {
  obj.meta = obj.meta || {};
  const fireT = obj.meta.fireT ?? 0;
  const lit = fireT > 0;

  // Info line
  options.push({
    label: lit ? `Fire: ${Math.ceil(fireT)}s remaining` : "Fire: Out",
    disabledReason: " "
  });

  // Cook only if burning
  options.push({
    label: "Cook",
    disabledReason: lit ? null : "Fire is out",
    action: () => {
      if (!lit) return;
      openCraftingScreen("cook");
      closeMenu();
    }
  });

  // Add wood: +20s per wood
  const tooFar = !isAdjacentOrSame(p.x, p.y, mapX, mapY);
  let addDisabled = null;
  if (tooFar) addDisabled = "Too far";
  else if (getQty(inv, "wood") <= 0) addDisabled = "Needs wood";

  options.push({
    label: `Add wood (+${CAMPFIRE_ADD_WOOD_SECONDS}s)`,
    disabledReason: addDisabled,
    action: withSfx("pickup", () => {
      if (addDisabled) return;

            removeItem(inv, "wood", 1);

      const wasOut = (obj.meta.fireT ?? 0) <= 0;

      // If the fire is currently OUT, lighting it can fail.
      if (wasOut) {
        const FIRE_LIGHT_CHANCE = 0.70; // tweak this
        const chk = rollCheck(FIRE_LIGHT_CHANCE);

        if (!chk.ok) {
          logAction(`${p.name} tried to light the campfire… failed. (d${chk.sides}: ${chk.roll} > ${chk.target})`);
          closeMenu();
          return;
        }

        playSound("lightfire");
      }

      // Only add time if it actually lit (or was already burning)
      obj.meta.fireT = (obj.meta.fireT ?? 0) + CAMPFIRE_ADD_WOOD_SECONDS;

      logAction(`${p.name} added wood to the campfire (+${CAMPFIRE_ADD_WOOD_SECONDS}s).`);
      closeMenu();
    })
  });

  // Extinguish: kill the fire (leave the campfire object so you can re-fuel it)
  options.push({
    label: "Extinguish",
    disabledReason: tooFar ? "Too far" : null,
    action: withSfx("extinguish", () => {
  if (tooFar) return false;

  // remove the campfire object entirely
  getCurrentMap().objects[mapY][mapX] = null;

  logAction(`${p.name} extinguished the campfire at (${mapX},${mapY}).`);
  closeMenu();
  return true;
})
  });

  openMenu({ screenX, screenY, title: def.name, options });
  return;
}

  // ---- Cat special: Pet instead of Hunt ----
  if (obj.id === "cat") {
    const tooFar = !isAdjacentOrSame(p.x, p.y, mapX, mapY);

    options.push({
  label: "Pet",
  disabledReason: tooFar ? "Too far" : null,
  action: withSfx("cat", () => {
    if (tooFar) return false;
    logAction(`${p.name} pets ${def.name ?? "the cat"}.`);
    closeMenu();
    return true;
  })
});

    // IMPORTANT: don't fall through and add Hunt/Harvest
    openMenu({ screenX, screenY, title: def.name, options });
    return;
  }

// ---- Stump behavior ----
if (obj.id === "stump") {
  const tooFar = !isAdjacentOrSame(p.x, p.y, mapX, mapY);
  let disabled = null;

  if (tooFar) disabled = "Too far";
  else if (!hasTool(inv, "axe")) disabled = "Needs axe";

  openMenu({
    screenX, screenY,
    title: "Tree Stump",
    options: [
      {
        label: "Remove stump",
        disabledReason: disabled,
        action: withSfx("chop", () => {
          if (disabled) return;
          state.world.objects[mapY][mapX] = null;
          logAction(`${p.name} removed a tree stump.`);
          closeMenu();
        })
      }
    ]
  });
  return;
}

  // ---- Existing object behavior ----
  const interact = def.hunt || def.harvest;

  if (interact) {
    const requiredTool = interact.requiresTool || null;
    let disabledReason = null;

if (obj.meta?.depleted) disabledReason = "Depleted";

    // Ranged hunting rules
    if (isHuntable) {
      if (getQty(inv, "bow_and_arrow") <= 0) disabledReason = "Needs bow and arrow";
      else if (dist > 3) disabledReason = "Too far";
    } else {
      // Normal harvesting stays adjacent-only
      if (!isAdjacentOrSame(p.x, p.y, mapX, mapY)) disabledReason = "Too far";
      else if (requiredTool && !hasTool(inv, requiredTool)) {
        disabledReason = `Requires ${itemDef(requiredTool)?.name ?? requiredTool}`;
      }
    }

   let sfx = "harvest";

// ---------------------------------------------------------------------------- Resource SFX -----
if (isHuntable) {
  sfx = (dist <= 1 ? "hunt" : "hunt");
} else {
  if (/^tree\d+$/.test(obj.id)) sfx = "chop";
else if (obj.id === "apple_tree") sfx = "harvest";
  else if (["rock", "stone", "ore"].includes(obj.id)) sfx = "pickaxe";
  else if (["bush", "berry_bush", "grapevine"].includes(obj.id)) sfx = "harvest";
  else if (obj.id === "fish_spot") sfx = "fishingreel";
  else if (obj.id === "cow") sfx = "cow";
}

options.push({
  label: isHuntable ? (dist <= 1 ? "Hunt" : "Hunt") : "Harvest resource",
  disabledReason,
  action: withSfx(sfx, () => {
    if (disabledReason) return false;
    harvestObject(mapX, mapY);
    closeMenu();
    return true;
  })
});

  }

if (def.pickup) {

  // Eat directly from map (only if item has nourishment)
  if (typeof def.nourishment === "number") {
    options.push({
      label: `Eat (+${def.nourishment})`,
      disabledReason: tooFar ? "Too far" : null,
      action: withSfx("pickup", () => {
        if (tooFar) return;

        p.hunger = clamp((p.hunger ?? 0) - def.nourishment, 0, HUNGER_MAX);
        logAction(`${p.name} eats ${def.name}.`);

        // remove object from map after eating
        getCurrentMap().objects[mapY][mapX] = null;

        closeMenu();
      })
    });
  }

  // Normal pickup
  options.push({
    label: "Pick up",
    action: withSfx("pickup", () => pickupObject(mapX, mapY))
  });

}

  // ---- Chop down option (anti-softlock) ----
if (["bush", "berry_bush", "apple_tree"].includes(obj.id)) {
  let chopDisabled = null;

  if (!isAdjacentOrSame(p.x, p.y, mapX, mapY)) chopDisabled = "Too far";
  else if (!hasTool(inv, "axe")) chopDisabled = "Needs axe";

  options.push({
    label: "Chop down",
    disabledReason: chopDisabled,
    action: withSfx("chop", () => {
      if (chopDisabled) return;
      chopDownObject(mapX, mapY);
      closeMenu();
    })
  });
}

  if (def.container) {
  let label = "Open";
  if (def.id === "stockpile") label = "Open stockpile";
  else if (def.id === "chest") label = "Open chest";
  else if (def.id === "toolbox") label = "Open toolbox";

  options.push({
  label,
  action: withSfx("chest", () => openContainerObject(mapX, mapY))
});

}

if (def.type === "house" || obj.id === "house") {
    options.push({
  label: "Enter",
  action: withSfx("door_open", () => tryEnterAt(mapX, mapY))
});

  }

if (obj.id === "build_site" || obj.id === "foundation" || obj.id === "framing") {
  options.push({
    label: "+ Contribute materials",
    action: () => {
      closeMenu();
      openConstructionUI(mapX, mapY);
    }
  });
}

  if (options.length === 0) return;

  openMenu({ screenX, screenY, title: def.name, options });
}

// --------------------------
// Construction UI (modal)
// --------------------------

// returns stage object from BUILD_STAGES by id
function buildStageDef(id) {
  return BUILD_STAGES.find(s => s.id === id) || null;
}

function buildStageIndex(id) {
  const i = BUILD_STAGES.findIndex(s => s.id === id);
  return i < 0 ? 0 : i;
}

// aggregated remaining needs across current stage + future stages (total house)
function buildRemainingTotal(stageId, mats) {
  const startIdx = buildStageIndex(stageId);
  const remaining = {};

  for (let i = startIdx; i < BUILD_STAGES.length; i++) {
    const needs = BUILD_STAGES[i].needs;
    if (!needs) continue;
    for (const k of Object.keys(needs)) {
      remaining[k] = (remaining[k] || 0) + needs[k];
    }
  }

  // subtract what has already been deposited (proj.mats holds total deposit)
  for (const k of Object.keys(remaining)) {
    const have = mats?.[k] || 0;
    remaining[k] = Math.max(0, remaining[k] - have);
  }

  return remaining; // matId -> qtyRemaining
}

// remaining needs for the CURRENT stage only (what’s required to build the next stage)
function buildRemainingStage(stageId, mats) {
  const stage = buildStageDef(stageId);
  const needs = stage?.needs || null;
  const remaining = {};
  if (!needs) return remaining;
  for (const k of Object.keys(needs)) {
    const have = mats?.[k] || 0;
    remaining[k] = Math.max(0, needs[k] - have);
  }
  return remaining; // matId -> qtyRemaining for this stage
}

function stageLabel(stageId) {
  if (!stageId) return "";
  return stageId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function buildTotalRequiredAll() {
  const total = {};
  for (const s of BUILD_STAGES) {
    if (!s.needs) continue;
    for (const k of Object.keys(s.needs)) {
      total[k] = (total[k] || 0) + s.needs[k];
    }
  }
  return total; // matId -> totalNeeded
}

const _BUILD_TOTAL_REQ = buildTotalRequiredAll();

function buildOverallProgressPct(stageId, mats) {
  // We measure overall progress by total required materials across all stages.
  let needSum = 0;
  let haveSum = 0;
  for (const k of Object.keys(_BUILD_TOTAL_REQ)) {
    const need = _BUILD_TOTAL_REQ[k];
    const have = mats?.[k] || 0;
    needSum += need;
    haveSum += Math.min(need, have);
  }
  if (needSum <= 0) return 0;
  return Math.max(0, Math.min(1, haveSum / needSum));
}

// filter inventory stacks to only those that are relevant (still needed >0)
function constructionRelevantInvStacks(inv, remaining) {
  const out = [];
  for (let i = 0; i < inv.length; i++) {
    const st = inv[i];
    if (!st || !st.id || !st.qty) continue;
    if ((remaining[st.id] || 0) <= 0) continue;
    out.push({ idx: i, stack: st });
  }
  return out;
}

function openConstructionUI(x, y) {
  const obj = state.world.objects?.[y]?.[x];
  if (!obj) return;

  const key = obj.meta?.key || `${x},${y}`;
  const proj = state.buildProjects[key];
  if (!proj) return;

  state.constructionOpen = { key, x, y };
  state.constructionSelectedInvIdx = -1;
  state.constructionLogScroll = 0;
}

function closeConstructionUI() {
  state.constructionOpen = null;
  state.constructionSelectedInvIdx = -1;
  state.constructionLogScroll = 0;
}

// record contributions in proj.contribLog
function pushContribLog(proj, playerName, itemId, qty) {
  proj.contribLog = proj.contribLog || [];
  proj.contribLog.push({
    t: Date.now(),
    who: playerName,
    itemId,
    qty
  });

  // cap to keep it sane
  if (proj.contribLog.length > 80) proj.contribLog.splice(0, proj.contribLog.length - 80);
}

// deposit from inventory into project mats (stockpile)
function contributeMaterial(proj, itemId, qty) {
  const inv = activeInv();
  const p = activePlayer();

  // clamp qty to what’s needed for the CURRENT stage
  const obj = state.world.objects?.[state.constructionOpen.y]?.[state.constructionOpen.x];
  const stageId = obj?.id || "build_site";
  const remaining = buildRemainingStage(stageId, proj.mats);
  const canUse = remaining[itemId] || 0;

  if (canUse <= 0) return false;

  // Sum quantity across ALL stacks (your getQty() only grabs first stack)
  let haveInv = 0;
  for (const st of inv) if (st?.id === itemId) haveInv += (st.qty || 0);

  // allow partial deposits
  const want = Math.max(1, Math.floor(qty || 0));
  const give = Math.min(want, canUse, haveInv);
  if (give <= 0) return false;

  const actuallyTaken = takeFromAllStacks(inv, itemId, give);
  if (actuallyTaken <= 0) return false;
  
  // ✅ concrete consumes a bucket: give empty bucket(s) back
  // If your empty bucket item id is different, change "bucket" here.
  if (itemId === "concrete") {
    addItem(inv, "bucket", actuallyTaken);
  }
  
  proj.mats = proj.mats || {};
  proj.mats[itemId] = (proj.mats[itemId] || 0) + actuallyTaken;

  pushContribLog(proj, p.name, itemId, actuallyTaken);
  playSound("click");
  return true;
}

function takeFromAllStacks(inv, itemId, qty) {
  let left = qty;

  for (let i = 0; i < inv.length && left > 0; i++) {
    const st = inv[i];
    if (!st || st.id !== itemId || !st.qty) continue;

    const take = Math.min(st.qty, left);
    st.qty -= take;
    left -= take;

    if (st.qty <= 0) inv[i] = null;
  }

  // optional cleanup: collapse nulls if you already do this elsewhere
  // inv = inv.filter(Boolean);

  return qty - left; // actually taken
}

// withdraw from stockpile back to inventory (optional but handy)
function withdrawMaterial(proj, itemId, qty) {
  const have = proj.mats?.[itemId] || 0;
  if (have <= 0) return false;

  const want = Math.max(1, Math.floor(qty || 0));
  const take = Math.min(want, have);

  const inv = activeInv();
  const res = addItem(inv, itemId, take);

  // If we couldn't add anything, deny and do nothing.
  if (!res || res.added <= 0) { playSound("deny"); return false; }

  // Only remove what we actually managed to put into inventory.
  const pulled = res.added;

  proj.mats[itemId] = have - pulled;
  if (proj.mats[itemId] <= 0) delete proj.mats[itemId];

  const p = activePlayer();
  pushContribLog(proj, p.name, itemId, -pulled);

  // If inventory was full and we only took part, let the player know.
  if (res.remaining > 0) logAction(`${p.name} couldn't carry all of it and only withdrew ${pulled}.`);

  playSound("click");
  return true;
}

// UI layout constants (match your other modals vibe)
function constructionUILayout() {
  const pad = 12;
  const leftW = 380;
  const rightW = 400;
  const boxW = leftW + rightW + (pad * 3);
  const boxH = Math.min(520, window.innerHeight - 120);
  const x = Math.floor((window.innerWidth - boxW) / 2);
  const y = Math.floor((window.innerHeight - boxH) / 2);

  return { x, y, boxW, boxH, pad, leftW, rightW };
}

function drawConstructionUI() {
  if (!state.constructionOpen) return;

  const { key, x: bx, y: by } = state.constructionOpen;
  const proj = state.buildProjects[key];
  const obj = state.world.objects?.[by]?.[bx];
  if (!proj || !obj) { closeConstructionUI(); return; }

  const stageId = obj.id;
  const stage = buildStageDef(stageId);
  const inv = activeInv();

  // what we still need for the NEXT stage only
  const remainingStage = buildRemainingStage(stageId, proj.mats);
  const invList = constructionRelevantInvStacks(inv, remainingStage);

  const { x, y, boxW, boxH, pad, leftW, rightW } = constructionUILayout();

  // panel
  drawRect(x, y, boxW, boxH, "rgba(20,20,20,0.96)");
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.strokeRect(x, y, boxW, boxH);

  drawText(`Construction`, x + 14, y + 18, 16);
  drawText(`(${bx},${by}) • Stage: ${stageId}`, x + 14, y + 38, 12, "left", "rgba(255,255,255,0.75)");

  // close button (top-right)
  const closeBtn = { x: x + boxW - 34, y: y + 10, w: 24, h: 24 };
  drawRect(closeBtn.x, closeBtn.y, closeBtn.w, closeBtn.h, "rgba(255,255,255,0.08)");
  drawText("✕", closeBtn.x + 12, closeBtn.y + 14, 14, "center", "rgba(255,255,255,0.85)");

  state._constructionUI = { closeBtn, x, y, boxW, boxH, leftW, rightW, pad, invList };

  // left: relevant inventory
  const lx = x + pad;
  const ly = y + 60;
  const lh = boxH - 70;

  drawRect(lx, ly, leftW, lh, "rgba(0,0,0,0.22)");
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.strokeRect(lx, ly, leftW, lh);

  drawText("Inventory", lx + 10, ly + 18, 13);

  // Move All button (inventory side)
  const allBtn = { x: lx + leftW - 120, y: ly + 8, w: 110, h: 22 };
  drawRect(allBtn.x, allBtn.y, allBtn.w, allBtn.h, "rgba(255,255,255,0.08)");
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.strokeRect(allBtn.x, allBtn.y, allBtn.w, allBtn.h);
  drawText("Move All >>", allBtn.x + allBtn.w / 2, allBtn.y + 15, 11, "center", "rgba(255,255,255,0.85)");
  state._constructionUI.allBtn = allBtn;

  const rowH = 34;
  let invY = ly + 34;

  for (let i = 0; i < invList.length; i++) {
    const { idx, stack } = invList[i];
    const item = itemDef(stack.id);
    const label = `${item?.name || stack.id}`;

    const row = { x: lx + 8, y: invY, w: leftW - 16, h: rowH };
    const selected = (state.constructionSelectedInvIdx === idx);

    drawRect(row.x, row.y, row.w, row.h, selected ? "rgba(120,200,255,0.18)" : "rgba(255,255,255,0.05)");
    drawText(`${label}`, row.x + 36, row.y + 20, 12, "left", "rgba(255,255,255,0.92)");

    // inventory side should ONLY show you have, not "needed"
    drawText(`x${stack.qty}`, row.x + row.w - 10, row.y + 20, 12, "right", "rgba(255,255,255,0.80)");

    // icon (shift label right enough so it never overlaps)
    if (item?.icon) drawCenteredEmoji(item.icon, row.x + 18, row.y + 18, 18);

    invList[i].hit = row;
    invY += rowH + 6;
    if (invY > ly + lh - rowH - 10) break;
  }

  if (invList.length === 0) {
    drawText("No relevant materials in inventory.", lx + 10, ly + 60, 12, "left", "rgba(255,255,255,0.55)");
  }

  // right: construction stockpile + big icon + progress + needs + log
  const rx = lx + leftW + pad;
  const ry = ly;
  const rh = lh;
  
const stageTitle = stage
  ? stage.id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
  : "Construction";

  drawRect(rx, ry, rightW, rh, "rgba(0,0,0,0.22)");
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.strokeRect(rx, ry, rightW, rh);
  drawText(stageTitle, rx + 10, ry + 18, 13);

  // big stage icon (full size)
  const stageDef = buildStageDef(stageId);
  if (stageDef?.icon) {
    const ico = { type: "image", src: `src/icons/${stageDef.icon}` };
    drawCenteredEmoji(ico, rx + 56, ry + 68, 96);
  }

  // build button label must say what we're building toward
  const target = BUILD_NEXT[stageId];
  const buildLabel = target ? `Build ${stageLabel(target)}` : "Build";

  // build button (top-right)
  const stageNeeds = stage?.needs || null;
  let buildBtn = null;

  if (stageNeeds) {
    const ready = Object.keys(stageNeeds).every(matId => (proj.mats?.[matId] || 0) >= stageNeeds[matId]);
    buildBtn = { x: rx + rightW - 130, y: ry + 12, w: 120, h: 26 };
    drawRect(buildBtn.x, buildBtn.y, buildBtn.w, buildBtn.h, ready ? "rgba(120,220,120,0.25)" : "rgba(255,255,255,0.06)");
    drawText(buildLabel, buildBtn.x + buildBtn.w / 2, buildBtn.y + 17, 12, "center",
      ready ? "rgba(120,220,120,0.95)" : "rgba(255,255,255,0.75)"
    );
    state._constructionUI.buildBtn = ready ? buildBtn : null;
  } else {
    state._constructionUI.buildBtn = null;
  }

  // overall progress bar (avoid overlap with button)
  const pct = buildOverallProgressPct(stageId, proj.mats);
  const progressX = rx + 110;
  const progressY = ry + 88;

  drawText(`Overall Progress: ${Math.round(pct * 100)}%`, progressX, progressY, 12, "left", "rgba(255,255,255,0.85)");

  const pbx = progressX;
  const pby = ry + 99;
  const pbw = Math.max(260, (rx + rightW) - pbx - 170);
  const pbh = 8;

  drawRect(pbx, pby, pbw, pbh, "rgba(0,0,0,0.55)");
  drawRect(pbx, pby, Math.floor(pbw * pct), pbh, "rgba(120,220,120,0.9)");

    // --- Right panel columns (prevents overlap) ---
  const needColW = Math.min(240, Math.floor(rightW * 0.44));
  const stockColW = rightW - needColW - 30; // padding + gutter
  const needX = pbx;   // right column start
  const needTitleY = ry + 32;

  drawText("Needed for construction:", needX, needTitleY, 13, "left", "rgba(255,255,255,0.90)");

  const remaining = buildRemainingStage(stageId, proj.mats);
  const needKeys = Object.keys(remaining).filter(k => remaining[k] > 0);

  let ny = needTitleY + 18;
  for (const matId of needKeys.slice(0, 6)) {
    const item = itemDef(matId);
    const label = item?.name || matId;
    drawText(`${label}: ${remaining[matId]}`, needX, ny, 16, "left", "rgba(255,230,10,0.80)");
    ny += 16;
  }
  if (needKeys.length === 0) {
    drawText("Nothing. Ready to build!", needX, ny, 16, "left", "rgba(120,220,120,0.9)");
    ny += 16;
  }

  // --- Site Stockpile: under Still Needed (left half) ---
  const stockTitleY = ry + 128;
  drawText("Site Stockpile", rx + 10, stockTitleY, 13);

  let sy = stockTitleY + 18;

  const mats = proj.mats || {};
  const matKeys = Object.keys(mats).sort();
  const stockRows = [];

  // keep it compact so the log can be BIG
  const stockStopY = ry + 230;

  for (const matId of matKeys) {
    const qty = mats[matId] || 0;
    if (qty <= 0) continue;

    const item = itemDef(matId);
    const label = item?.name || matId;

    const row = { x: rx + 10, y: sy, w: stockColW, h: 28, matId };
    drawRect(row.x, row.y, row.w, row.h, "rgba(255,255,255,0.05)");
    if (item?.icon) drawCenteredEmoji(item.icon, row.x + 14, row.y + 14, 16);

    // Fix overlap: push name right so icons never collide with text
    drawText(`${label}`, row.x + 36, row.y + 18, 12, "left", "rgba(255,255,255,0.90)");
    drawText(`x${qty}`, row.x + row.w - 10, row.y + 18, 12, "right", "rgba(255,255,255,0.75)");

    stockRows.push(row);
    sy += 34;

    if (sy > stockStopY) break;
  }

  // contribution log
  const logTitleY = stockStopY + 18;
  drawText("Contributions", rx + 10, logTitleY, 13);

  const logBox = { x: rx + 12, y: logTitleY + 15, w: rightW - (pad * 2), h: (ry + rh - pad) - (logTitleY + 18) };
  drawRect(logBox.x, logBox.y, logBox.w, logBox.h, "rgba(0,0,0,0.35)");

  const logs = proj.contribLog || [];
  const maxLines = Math.floor(logBox.h / 16) - 1;
  const start = Math.max(0, logs.length - maxLines);

  let ly2 = logBox.y + 18;
  for (let i = start; i < logs.length; i++) {
    const e = logs[i];
    const sign = e.qty >= 0 ? "+" : "";
    drawText(`${e.who} ${sign}${e.qty} ${e.itemId}`, logBox.x + 8, ly2, 11, "left", "rgba(255,255,255,0.70)");
    ly2 += 16;
  }

  // store clickable rows + (we keep invList already stored)
  state._constructionUI.stockRows = stockRows;
}

function handleConstructionTap(px, py) {
  if (!state.constructionOpen) return false;
  const ui = state._constructionUI;
  if (!ui) return true;

  // close
  if (ui.closeBtn && hitRect(px, py, ui.closeBtn)) {
    playSound("click");
    closeConstructionUI();
    return true;
  }
  
  // Move All (to next-stage needs only)
if (ui.allBtn && hitRect(px, py, ui.allBtn)) {
  const { key, x: bx, y: by } = state.constructionOpen;
  const proj = state.buildProjects[key];
  const obj = state.world.objects?.[by]?.[bx];
  if (!proj || !obj) return true;

  const stageId = obj.id;
  const inv = activeInv();
  const who = activePlayer().name;

  const remaining = buildRemainingStage(stageId, proj.mats);

  for (const itemId of Object.keys(remaining)) {
    const need = remaining[itemId] || 0;
    if (need <= 0) continue;
    contributeMaterialToProject(stageId, proj, inv, itemId, need, who);
  }

  playSound("click");
  return true;
}

if (ui.stockRows) {
  for (const r of ui.stockRows) {
    if (hitRect(px, py, r)) {
      const { key, x: bx, y: by } = state.constructionOpen;
      const proj = state.buildProjects[key];
      const inv = activeInv();
      const who = activePlayer().name;

      // example: withdraw 5 per click
      withdrawMaterialFromProject(proj, inv, r.matId, 5, bx, by, who);

      playSound("click");
      return true;
    }
  }
}

  const { key, x: bx, y: by } = state.constructionOpen;
  const proj = state.buildProjects[key];
  const obj = state.world.objects?.[by]?.[bx];
  if (!proj || !obj) { closeConstructionUI(); return true; }
  
  // Move All button
if (ui.allBtn && hitRect(px, py, ui.allBtn)) {
  playSound("click");
  const stageId = obj.id;
  const remainingStage = buildRemainingStage(stageId, proj.mats);
  for (const matId of Object.keys(remainingStage)) {
    const need = remainingStage[matId] || 0;
    if (need > 0) contributeMaterialToProject(stageId, proj, activeInv(), matId, need, activePlayer().name);
  }
  return true;
}

  // click inventory list rows
  for (const row of ui.invList) {
    if (row.hit && hitRect(px, py, row.hit)) {
      state.constructionSelectedInvIdx = row.idx;
      playSound("click");

      // single-click deposits 1 (simple, fast testing)
      contributeMaterial(proj, row.stack.id, 1);
      return true;
    }
  }

  // click stockpile rows to withdraw 1 (optional convenience)
  for (const r of (ui.stockRows || [])) {
    if (hitRect(px, py, r)) {
      withdrawMaterial(proj, r.matId, 1);
      return true;
    }
  }

  // build button
  if (ui.buildBtn && hitRect(px, py, ui.buildBtn)) {
    const stageId = obj.id;
    playSound("click");
    closeConstructionUI();
    startBuildTimer(key, bx, by, stageId);
    return true;
  }

  return true; // modal eats clicks
}

// ------------------------------------------------------------------------------------ Crafting & Recipes ----
function recipeList() { return Object.values(state.data.recipes); }

function canCraftRecipe(r) {
  const inv = activeInv();

   if (r.station) {
    const p = activePlayer();
    let ok = false;

    const needStations = recipeStations(r);

    // include SAME tile + adjacent tiles
    const tilesToCheck = [[p.x, p.y], ...neighbors4(p.x, p.y)];

    for (const [nx, ny] of tilesToCheck) {
      const obj = objectAt(nx, ny);
      if (!obj) continue;
      const odef = objDef(obj.id);

      // station match (supports recipes that list multiple valid stations)
      if (odef?.station && needStations.includes(odef.station)) { ok = true; break; }
    }

    if (!ok) return { ok: false, reason: `Needs ${needStations.join(" or ")}` };
  }

  if (r.requiresTool && !hasTool(inv, r.requiresTool)) {
    return { ok: false, reason: `Requires ${itemDef(r.requiresTool)?.name ?? r.requiresTool}` };
  }

  for (const [id, amt] of Object.entries(r.in)) {
    if (getQty(inv, id) < amt) return { ok: false, reason: "Missing items" };
  }
  return { ok: true };
}

function isRecipeScroll(itemId) {
  const def = itemDef(itemId);
  return !!def?.tags?.includes("recipe");
}

// recipe scroll items can either match a recipe id exactly, OR be <id>_recipe while the recipe is <id>
function recipeIdFromScroll(scrollItemId) {
  if (state.data.recipes[scrollItemId]) return scrollItemId;
  if (scrollItemId.endsWith("_recipe")) {
    const maybe = scrollItemId.slice(0, -"_recipe".length);
    if (state.data.recipes[maybe]) return maybe;
  }
  return null;
}

function recipeStations(r) {
  if (!r || !r.station) return [];
  return Array.isArray(r.station) ? r.station : [r.station];
}

function recipeHasStation(r, stationId) {
  return recipeStations(r).includes(stationId);
}

function buildCampfireAtPlayer() {
  if (state.mode !== "overworld") return false;

  const p = activePlayer();
  const inv = activeInv();

  // Don’t stack campfires like it’s a Minecraft exploit
  if (state.world.objects[p.y][p.x]) return false;

  if (getQty(inv, "wood") < 3) return false;
  if (getQty(inv, "matches") < 1) return false;

  removeItem(inv, "wood", 3);
  removeItem(inv, "matches", 1);

  state.world.objects[p.y][p.x] = {
    id: "campfire",
    hp: 999,
    meta: { fireT: CAMPFIRE_BURN_SECONDS }
  };

  // AUTO-MARK
  addMarker("Campfire", p.x, p.y, "campfire");

  playSound("lightfire");
  logAction(`${p.name} built a campfire at (${p.x},${p.y}).`);
  return true;
}

function getEmptyBucketId() {
  // Prefer an explicit empty bucket id if you have one, otherwise fall back to "bucket"
  const cands = ["empty_bucket", "bucket_empty", "bucket"];
  for (const id of cands) {
    if (state.data?.items?.[id]) return id;
  }
  return "bucket";
}

function refundContainerForConsumedItem(inv, itemId, qty) {
  // Concrete is assumed to be "concrete in a bucket"
  if (itemId === "concrete" && qty > 0) {
    addItem(inv, getEmptyBucketId(), qty);
  }
}

function craftRecipe(recipeId) {
  const r = state.data.recipes[recipeId];
  if (!r) return;

  const chk = canCraftRecipe(r);
  if (!chk.ok) return;

  const inv = activeInv();

 // consume inputs (+ refund containers like empty buckets)
for (const [id, amt] of Object.entries(r.in)) {
  removeItem(inv, id, amt);
  refundContainerForConsumedItem(inv, id, amt);
}

  // produce outputs
  for (const [id, amt] of Object.entries(r.out)) addItem(inv, id, amt);

  // log crafting (exclude movement, include crafting)
  const pName = activePlayer().name;
  
const isCooking = recipeHasStation(r, "campfire") || recipeHasStation(r, "stove");
playSound(isCooking ? "cook" : "saw");

  logAction(`${pName} crafted ${r.name}!`);
}

function attemptManualCraft() {
  if (state.selectedForCraft.size === 0) return;

  const sel = state.selectedForCraft; // Map itemId -> qty

  // Find recipe that matches selected ids AND selected quantities are a clean multiple of inputs
  const r = recipeList().find(r => {
    const ins = r.in ?? {};
    const inIds = Object.keys(ins);

    if (inIds.length !== sel.size) return false;

    // all selected ingredients must be present
    for (const id of inIds) {
      const s = sel.get(id) ?? 0;
      if (s <= 0) return false;

      const need = ins[id] ?? 0;
      if (need <= 0) return false;

      // must be an integer multiple
      if (s % need !== 0) return false;
    }

    // and all multiples must be the same across all inputs
    let mult = null;
    for (const id of inIds) {
      const m = (sel.get(id) ?? 0) / ins[id];
      if (mult === null) mult = m;
      else if (m !== mult) return false;
    }

    return mult !== null && mult >= 1;
  });

  if (!r) return;

  // Station gating (supports station arrays)
if (state.craftingMode === "craft" && !recipeHasStation(r, "workbench")) return;
if (state.craftingMode === "cook" && !(recipeHasStation(r, "campfire") || recipeHasStation(r, "stove"))) return;
if (state.craftingMode === "prep" && !recipeHasStation(r, "counter")) return;

  // Determine multiplier again (safe, since we validated)
  let mult = null;
  for (const [id, need] of Object.entries(r.in ?? {})) {
    const m = (sel.get(id) ?? 0) / need;
    mult = (mult === null) ? m : Math.min(mult, m);
  }
  mult = Math.floor(mult ?? 1);
  if (mult < 1) return;

  // Craft N times
  for (let i = 0; i < mult; i++) {
    const chk = canCraftRecipe(r);
    if (!chk.ok) break;
    craftRecipe(r.id);
  }

  // Learn recipe on success (if at least one craft occurred)
  learnRecipe(r.id);

  // Clear selection after crafting
  state.selectedForCraft.clear();
}

function recipesMatchingSelection() {
  const selected = state.selectedForCraft;
  const list = recipeList();
  return list.filter(r => {
    if (selected.size === 0) return true;
    return Object.keys(r.in).every(id => selected.has(id));
  });
}

function learnRecipe(recipeId, silent = false) {
  if (!recipeId) return;
  if (!state.learnedRecipes.has(recipeId)) {
    state.learnedRecipes.add(recipeId);

    if (!silent) {
      const r = state.data.recipes[recipeId];
      logAction(`Learned recipe: ${r?.name ?? recipeId}`);
      playSound?.("achievement");
    }
  }
}

// ---- Drawing ----
function drawRect(x, y, w, h, fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }

function drawText(text, x, y, size, align, color, font = BASE_FONT) {
  // Backward compat: some calls pass (color, align) instead of (align, color).
  // Detect and swap if align looks like a color and color looks like an alignment.
  const isAlign = (v) => v === "left" || v === "center" || v === "right";
  const looksLikeColor = (v) =>
    typeof v === "string" && (
      v.startsWith("rgb") ||
      v.startsWith("#") ||
      v.startsWith("hsl") ||
      v === "white" || v === "black"
    );

  // Handle omitted args safely
  if (align === undefined) align = "left";
  if (color === undefined) color = "#fff";

  // Swap if passed as (color, align)
  if (looksLikeColor(align) && isAlign(color)) {
    const tmp = align;
    align = color;
    color = tmp;
  }

  // Final safety: never feed canvas garbage
  if (!isAlign(align)) align = "left";
  if (typeof color !== "string") color = "#fff";
  if (!font) font = BASE_FONT;

  ctx.font = `${size}px ${font}`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawWrappedText(
  text,
  x,
  y,
  maxWidth,
  lineHeight,
  size = 14,
  align = "center",
  color = "#fff",
  font = BASE_FONT
) {
  ctx.save();
  ctx.font = `${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "top";

  const words = text.split(" ");
  let line = "";
  let yy = y;

  for (let i = 0; i < words.length; i++) {
    const test = line + words[i] + " ";
    const w = ctx.measureText(test).width;

    if (w > maxWidth && i > 0) {
      ctx.fillText(line, x, yy);
      line = words[i] + " ";
      yy += lineHeight;
    } else {
      line = test;
    }
  }

  ctx.fillText(line, x, yy);
  ctx.restore();
}

function drawCenteredEmoji(icon, cx, cy, size = 24) {
  // Unicode / emoji path
  if (typeof icon === "string") {
    ctx.font = `${size}px system-ui, Apple Color Emoji, Segoe UI Emoji`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(icon, cx, cy);
    return;
  }

  // Image icon path
  if (icon && icon.type === "image") {
    const img = getIconImage(icon.src);
    if (img && img.complete) {
      const iw = img.naturalWidth;
const ih = img.naturalHeight;

const scale = size / Math.max(iw, ih);

const w = iw * scale;
const h = ih * scale;

ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);

    }
  }
}

function drawIconFitWidth(icon, x, y, targetW) {
  if (!icon) return;

  // Emoji/string path: just center it in the tile width
  if (typeof icon === "string") {
    ctx.font = `${Math.floor(targetW * 0.6)}px system-ui, Apple Color Emoji, Segoe UI Emoji`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(icon, x + targetW / 2, y + TILE_SIZE / 2);
    return;
  }

  // Image path: scale to match target width, preserve aspect ratio
  if (icon.type === "image" && icon.src) {
    const img = getIconImage(icon.src); // ✅ your existing cache loader
    if (!img || !img.complete || img.naturalWidth <= 0) return;

    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    const scale = targetW / iw;
    const w = targetW;
    const h = ih * scale;

    // anchor to tile bottom so tall sprites look natural
    const dx = x;
    const dy = y + TILE_SIZE - h;

    ctx.drawImage(img, dx, dy, w, h);
  }
}

// Overworld object sizing based on def.size
function objSizeParams(def) {
  const s = (def?.size || "medium").toLowerCase();
  if (s === "large") return { scale: 1.5, yOff: Math.round(TILE_SIZE * 0.5) }; // spill into tile above
  if (s === "small") return { scale: 0.5, yOff: 0 };
  if (s === "tiny")  return { scale: 0.25, yOff: 0 };
  return { scale: 1.0, yOff: 0 }; // medium/default
}

// Draw an overworld object icon honoring size category.
// - Images: anchored to tile bottom, scaled by TILE_SIZE * scale, with optional upward offset.
// - Emoji: placed near tile bottom so "large" doesn't float weirdly.
function drawOverworldObjectIcon(def, icon, sx, sy) {
  const { scale, yOff } = objSizeParams(def);

  // Emoji / string path
  if (typeof icon === "string") {
    const sizePx = Math.round(26 * scale); // base 26 like your current overworld draw
    ctx.font = `${sizePx}px system-ui, Apple Color Emoji, Segoe UI Emoji`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    // anchor near bottom of tile, then push up if large
    const cx = sx + TILE_SIZE / 2;
    const cy = sy + TILE_SIZE - 6 - yOff;
    ctx.fillStyle = "#fff";
    ctx.fillText(icon, Math.round(cx), Math.round(cy));
    return;
  }

  // Image path
  if (icon && icon.type === "image" && icon.src) {
    const img = getIconImage(icon.src);
    if (!img || !img.complete || img.naturalWidth <= 0) return;

    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    // Scale by HEIGHT relative to tile (like avatars): 1.0 = 1 tile tall
    const h = TILE_SIZE * scale;
    const w = iw * (h / ih);

    const dx = sx + (TILE_SIZE - w) / 2;
    const dy = sy + TILE_SIZE - h - yOff; // bottom-anchored + optional upward spill

    ctx.drawImage(
      img,
      Math.round(dx),
      Math.round(dy),
      Math.round(w),
      Math.round(h)
    );
  }
}

// Draw avatar with a chosen HEIGHT multiplier; width is natural from aspect ratio.
// Bottom anchored to tile, centered horizontally on the tile.
function drawAvatarTall(icon, tileX, tileY, scaleY = 1) {
  if (!icon) return;

  // Emoji fallback
  if (typeof icon === "string") {
    const cx = tileX + TILE_SIZE / 2;
    const cy = tileY + TILE_SIZE / 2;
    ctx.font = `${Math.floor(28 * scaleY)}px system-ui, Apple Color Emoji, Segoe UI Emoji`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(icon, cx, cy);
    return;
  }

  // Image
  if (icon.type === "image" && icon.src) {
    const img = getIconImage(icon.src);
    if (!img || !img.complete || img.naturalWidth <= 0) return;

    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    // Base height: fit inside 1 tile by height (instead of forcing width)
    const baseH = TILE_SIZE;

    // Desired height (grows upward)
    const h = baseH * scaleY;

    // Natural width from aspect ratio
    const w = iw * (h / ih);

    // Bottom-align; keep centered on the tile
    const dx = tileX + (TILE_SIZE - w) / 2;
    const dy = tileY + TILE_SIZE - h;

    const yOff = 6; // move avatar up; adjust to taste

    ctx.drawImage(
      img,
      Math.round(dx),
      Math.round(dy - yOff),
      Math.round(w),
      Math.round(h)
    );
  }
}


function staminaBar(pl, x, y, w, h) {
  // background
  drawRect(x, y, w, h, "rgba(255,255,255,0.10)");
  // fill
  const pct = pl.stamina / STAMINA_MAX;
  drawRect(x, y, w * pct, h, "rgba(40,220,80,0.85)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(x, y, w, h);
}

function drawHungerBar(x, y, w, h, hunger) {
  drawRect(x, y, w, h, "rgba(0,0,0,0.55)");
  const pct = clamp(hunger / HUNGER_MAX, 0, 1);
  drawRect(x + 2, y + 2, (w - 4) * pct, h - 4, "#c96c2c");
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.strokeRect(x, y, w, h);
}

function drawTopBar() {
  drawRect(0, 0, window.innerWidth, UI_TOP_H, "rgba(0,0,0,0.74)");

  const p = activePlayer();
  const inv = activeInv();
  const pieces = getQty(inv, "blueprint_piece");
  const hasBP = getQty(inv, "blueprint_house") > 0;

  drawText(
    `Mode: ${state.mode} | Active: ${p.name} | Pieces: ${pieces}${hasBP ? " (House Blueprint ✅)" : ""}`,
    10, 16, 13
  );

  // ---- Day/Night indicator (top-center) ----
  const isDay = state.time?.isDay ?? true;
  const icon = isDay ? "☀️" : "🌙";
  const label = isDay ? "Daytime" : "Nighttime";
  const dayNum = state.time?.day ?? 1;
  drawText(`${icon} ${label}  (Day ${dayNum})`, window.innerWidth / 2, 16, 13, "center", "#fff", BASE_FONT);

  // coords on top-right (requested)
if (state.mode === "overworld" || state.mode === "dungeon") {
    const p1 = state.players[0], p2 = state.players[1];
    const rightText = `P1 (${p1.x},${p1.y})  P2 (${p2.x},${p2.y})`;
    drawText(rightText, window.innerWidth - 10, 16, 13, "right");
  }

  // stamina + hunger HUD should start after the left sidebar
  const hudX = UI_LEFTBAR_W + 10;

  // stamina bar
  drawText("Stamina", hudX, 40, 12, "left", "rgba(255,255,255,0.85)");
  staminaBar(p, hudX + 60, 34, 160, 12);

  // hunger bar (to the right of stamina)
  const staminaX = hudX + 60, staminaY = 34, staminaW = 160, staminaH = 12;

  const hungerX = staminaX + staminaW + 150; // spacing between bars
  const hungerY = staminaY;
  const hungerW = 150;
  const hungerH = staminaH;

  drawText("Hunger", hungerX - 60, 40, 12, "left", "rgba(255,255,255,0.85)");
  drawHungerBar(hungerX, hungerY, hungerW, hungerH, p.hunger);

  // status text stays by stamina (as you wanted)
  const restTxt = p.resting ? "Resting…" : (p.stamina <= 0 ? "Exhausted" : "");
  if (restTxt) drawText(restTxt, staminaX + staminaW + 12, 40, 12, "left", "rgba(255,255,255,0.75)");
}

// -------------------------------------------------------- DROPPING ITEMS ----
function isTileOccupiedForDrop(x, y) {
  x = Math.round(x);
  y = Math.round(y);

  const map = getCurrentMap();
  const obj = map.objects?.[y]?.[x];
  if (!obj) return false;

  // Allow stacking onto an existing dropped_item
  if (obj.id === "dropped_item") return false;

  const def = objDef(obj.id);
  if (def?.blocks) return true;

  return true;
}

function dropItemOnTile(itemId, qty, x, y) {
  x = Math.round(x);
  y = Math.round(y);

  const map = getCurrentMap();
  if (!map?.objects?.[y]) return false;

  const existing = map.objects[y][x];
  if (existing && existing.id === "dropped_item" && existing.meta?.itemId === itemId) {
    existing.meta.qty = (existing.meta.qty ?? 0) + qty;
    return true;
  }

  if (existing) return false;

  map.objects[y][x] = {
    id: "dropped_item",
    hp: 1,
    meta: { itemId, qty }
  };
  return true;
}

// -------------------------------------------------- MAP GENERATION ----
function drawWorld() {
  const map = getCurrentMap();
  if (!map) return;

    // ---- Safety guards: maps can be null/half-built for a frame during transitions/net sync ----
  if (!state.data?.tiles) return;

  const tiles = map.tiles;
  if (!Array.isArray(tiles) || tiles.length === 0 || !Array.isArray(tiles[0])) return;

  const h = tiles.length;
  const w = tiles[0].length;

  // Ensure objects grid exists and matches tiles
  if (!Array.isArray(map.objects) || map.objects.length !== h || !Array.isArray(map.objects[0])) {
    map.objects = Array.from({ length: h }, () => Array.from({ length: w }, () => null));
  }

  // explored is optional, but if you want it always present during overworld/dungeon:
  // if ((state.mode === "overworld" || state.mode === "dungeon") && !Array.isArray(map.explored)) {
  //   map.explored = emptyExplored(w, h);
  // }

  const { viewW, viewH } = viewTiles();
  const camX = state.cam.x;
  const camY = state.cam.y;
  const deferredBuildIcons = [];
  const deferredWindowBeams = [];
  const deferredLargeObjects = []; // overworld "large" objects for proper occlusion
  const deferredInteriorMulti = [];

  // Will hold "large" overworld objects that must draw AFTER players
let _largeFront = null;

  const deferredInteriorWallFront = [];
  const playerTileSet = new Set();

  // Cache player tiles for this frame (so wall can cover player only when on same tile)
  {
    const hh = state.holdingHands;
    if (hh) {
      const leadIndex = (typeof hh.leader === "number") ? hh.leader : hh.a;
      const lead = state.players[leadIndex];
      playerTileSet.add(`${Math.floor(lead.fx + 0.5)},${Math.floor(lead.fy + 0.5)}`);
    } else {
      for (const pl of state.players) {
        playerTileSet.add(`${Math.floor(pl.fx + 0.5)},${Math.floor(pl.fy + 0.5)}`);
      }
    }
  }

for (let y = Math.max(0, camY); y < Math.min(h, camY + viewH); y++) {
  for (let x = Math.max(0, camX); x < Math.min(w, camX + viewW); x++) {
      const { sx, sy } = mapToScreen(x, y);

const tileId = map.tiles?.[y]?.[x];
if (tileId == null) continue;

const t = state.data.tiles?.[tileId] ?? null;

const obj = map.objects?.[y]?.[x] ?? null;


// For dungeon + overworld, use that map's explored[][]
let explored = true;
if (state.mode === "overworld" || state.mode === "dungeon") {
  // Safety: if explored grid missing, treat as unexplored until revealAroundPlayers runs
  explored = !!(map.explored?.[y]?.[x]);
}

const isDay = !!state.time?.isDay;

// Night rules only apply to overworld (campfire, darkness, etc.)
const visNow =
  (state.mode === "overworld")
    ? (isDay ? explored : (isInPlayerSight(x, y) || isLitByCampfire(x, y)))
    : (state.mode === "dungeon")
      ? explored // dungeon visibility is strictly fog-based
      : true;     // interior: always visible

     // --- Tile draw (with planted dirt if visible) ---
let tileColor = t?.color ?? "#333";

if (state.mode === "dungeon") {
  if (tileId === "wall") tileColor = "#1b1b1b";
  else if (tileId === "floor") tileColor = "#3a3a3a";
  else tileColor = "#2a2a2a";
}

// Overworld special-case
if (visNow && obj && obj.id === "planted_seed") {
  tileColor = "#6b4f2a"; // dirt brown
}

if (state.mode === "interior") {
  const idef = state.data.interiors?.[state.interiorId];
  const wallTile = idef?.wallTile;
  const doorTile = idef?.doorTile;

  const isWall = (tileId === wallTile);
  const isDoor = (tileId === doorTile);

  // Base palette (solid colors, no textures)
  const floorA = "#7a5534";   // wood
  const floorB = "#6f4d30";   // wood shade
  const wallOuter = "#3e2a17";
  const wallInner = "#523621";
  const doorOuter = "#2b1b10";
  const doorInner = "#3a2415";
  // ---- Interior wall cap styling (shared)
const capH = 7;
const capWood = "rgba(180,120,60,0.60)";
const capHi   = "rgba(255,255,255,0.18)";
const capSh   = "rgba(0,0,0,0.30)";

  // Subtle floor variation (checker-ish) for depth
  if (!isWall && !isDoor) {
    const alt = ((x + y) & 1) === 0;
    drawRect(sx, sy, TILE_SIZE, TILE_SIZE, alt ? floorA : floorB);

    // inner vignette to fake “room depth”
    drawRect(sx + 2, sy + 2, TILE_SIZE - 4, TILE_SIZE - 4, "rgba(0,0,0,0.10)");
  } else {
    // Walls / door = thicker, raised look
    const outer = isDoor ? doorOuter : wallOuter;
    const inner = isDoor ? doorInner : wallInner;

const isLeftWall  = (x === 0);
const isRightWall = (x === INTERIOR_W - 1);
const isTopWall   = (y === 0);
const isBottomWall = (y === INTERIOR_H - 1);

const half = Math.floor(TILE_SIZE / 2);
const inset = 4;

// --- Side walls: half thickness ---
if (isLeftWall) {
  // draw on right half of tile
  drawRect(sx + half, sy, half, TILE_SIZE, outer);
  drawRect(sx + half + inset, sy + inset, half - inset * 2, TILE_SIZE - inset * 2, inner);

} else if (isRightWall) {
  // draw on left half of tile
  drawRect(sx, sy, half, TILE_SIZE, outer);
  drawRect(sx + inset, sy + inset, half - inset * 2, TILE_SIZE - inset * 2, inner);

} else {
  // --- Top & bottom walls stay full thickness ---
  drawRect(sx, sy, TILE_SIZE, TILE_SIZE, outer);
  drawRect(sx + inset, sy + inset, TILE_SIZE - inset * 2, TILE_SIZE - inset * 2, inner);
}

    const midX = Math.floor(INTERIOR_W / 2);
    const doorHere = isDoor || (isBottomWall && x === midX); // visual fallback door

    // ===== CLIPPED highlights + CLIPPED exterior logs (works with half-width side walls) =====

    // Compute the wall "slab" bounds for THIS tile (matches your half-width side wall rendering)
    const _half = Math.floor(TILE_SIZE / 2);
    let _wx = sx, _ww = TILE_SIZE;

    // Left wall tile: slab is on the RIGHT half
    if (x === 0) { _wx = sx + _half; _ww = _half; }
    // Right wall tile: slab is on the LEFT half
    else if (x === INTERIOR_W - 1) { _wx = sx; _ww = _half; }

    const _lipInset = Math.max(3, Math.floor(_ww * 0.12));

    // --- Bottom wall = exterior log wall (CLIPPED at corners to match half-width side walls) ---
	// Grass strip "outside" the cabin (at the very bottom edge of the tile)
if (isBottomWall) {
  const isDayNow = !!(state.time?.isDay);
  const gCol = isDayNow ? "#2f6f3a" : "rgba(47,111,58,0.35)";

  // Clip width at corners the same way as the logs do
  let _gx = sx, _gw = TILE_SIZE;
  const _half = Math.floor(TILE_SIZE / 2);
  if (x === 0) { _gx = sx + _half; _gw = _half; }
  else if (x === INTERIOR_W - 1) { _gx = sx; _gw = _half; }

  drawRect(_gx, sy + TILE_SIZE - 8, _gw, 8, gCol);
}

    if (isBottomWall && !doorHere) {
      const logA = "#c8923b";
      const logB = "#b47c2f";
      const chink = "rgba(40,20,8,0.55)";
      const hi = "rgba(255,255,255,0.10)";

      // Clip logs on bottom-left/bottom-right corners using the slab bounds
      let _lx = sx, _lw = TILE_SIZE;
      if (x === 0) { _lx = sx + _half; _lw = _half; }
      else if (x === INTERIOR_W - 1) { _lx = sx; _lw = _half; }

      const usableH = TILE_SIZE - (capH + 2) - 6; // space below cap and above grass/edge
const _bandH = Math.floor(usableH / 3);
      const _insetX = Math.max(4, Math.floor(_lw * 0.14));
      const _startY = sy + capH + 2; // start BELOW the bottom cap so nothing overlaps it

      for (let i = 0; i < 3; i++) {
        const yy = _startY + i * _bandH;
        const alt = ((x + i) & 1) === 0;

        drawRect(_lx + _insetX, yy, _lw - _insetX * 2, _bandH - 2, alt ? logA : logB);
        drawRect(_lx + _insetX, yy + 1, _lw - _insetX * 2, 1, hi);

        if (i < 2) {
          const _cx = _lx + Math.max(3, _insetX - 2);
          const _cw = _lw - Math.max(3, _insetX - 2) * 2;
          drawRect(_cx, yy + _bandH - 2, _cw, 2, chink);
        }
      }
    } else if (isBottomWall) {
      // Bottom wall but not log-painted (door area): subtle inner lip
      drawRect(sx + 4, sy + 4, TILE_SIZE - 8, 2, "rgba(255,255,255,0.12)");
    }

    // --- Door details (cabin style) ---
    if (doorHere) {
      // Door frame
      drawRect(sx + 6, sy + 6, TILE_SIZE - 12, TILE_SIZE - 12, "#8c5b22");

      // Door panel
      drawRect(sx + 10, sy + 14, TILE_SIZE - 20, TILE_SIZE - 26, "#744615");
      drawRect(sx + 12, sy + 16, TILE_SIZE - 24, TILE_SIZE - 30, "rgba(255,255,255,0.06)");

      // Knob
      drawRect(sx + TILE_SIZE - 18, sy + TILE_SIZE - 28, 3, 3, "#d8d8d8");

      // Threshold (exterior edge)
      if (isBottomWall) {
        drawRect(sx + 8, sy + TILE_SIZE - 6, TILE_SIZE - 16, 3, "rgba(0,0,0,0.35)");
        drawRect(sx + 10, sy + TILE_SIZE - 3, TILE_SIZE - 20, 1, "rgba(255,255,255,0.12)");
      }
    }

// ===== FINAL: wall caps drawn LAST so nothing draws over them =====

// Helper: corner clip width to match your half-thickness side walls (same idea as logs/grass)
function capSpanForRow() {
  // default: full tile width (no inset) to avoid seams/ticks between tiles
  let cx = sx;
  let cw = TILE_SIZE;

  // left corner: wall mass is effectively the right half
  if (x === 0) {
    cx = sx + half;
    cw = half;
  }
  // right corner: wall mass is effectively the left half
  else if (x === INTERIOR_W - 1) {
    cx = sx;
    cw = half;
  }

  if (cw < 2) cw = 2;
  return { cx, cw };
}

// TOP wall: cap at VERY TOP of the wall tile (does NOT touch floor tiles)
if (isTopWall) {
  const { cx, cw } = capSpanForRow();
  drawRect(cx, sy, cw, capH, capWood);
  drawRect(cx, sy, cw, 1, capHi);
  drawRect(cx, sy + capH - 1, cw, 1, capSh);
}

const sideCapH = isBottomWall ? capH : TILE_SIZE;

if (isLeftWall) {
  const lx = sx + half;
  drawRect(lx, sy, capH, sideCapH, capWood);
  drawRect(lx, sy, 1, sideCapH, capHi);
  drawRect(lx + capH - 1, sy, 1, sideCapH, capSh);
}

if (isRightWall) {
  const rx = sx + half - capH;
  drawRect(rx, sy, capH, sideCapH, capWood);
  drawRect(rx, sy, 1, sideCapH, capHi);
  drawRect(rx + capH - 1, sy, 1, sideCapH, capSh);
}


// BOTTOM wall: cap at TOP of the bottom wall tile (between wall + floor tiles)
if (isBottomWall) {
  const { cx, cw } = capSpanForRow();
  drawRect(cx, sy, cw, capH, capWood);
  drawRect(cx, sy, cw, 1, capHi);
  drawRect(cx, sy + capH - 1, cw, 1, capSh);
}

  }

  // Windows (drawn as insets on wall tiles)
// 8x8: put 2 windows per wall, avoid corners, avoid door
const midX = Math.floor(INTERIOR_W / 2);  // 4 for 8
const winXs = [2, INTERIOR_W - 3];        // [2,5]
const winYs = [2, INTERIOR_H - 3];        // [2,5]

let isWindowSpot = false;

// Top wall
if (y === 0 && winXs.includes(x)) isWindowSpot = true;
// Bottom wall (skip door position)
if (y === INTERIOR_H - 1 && winXs.includes(x) && x !== midX) isWindowSpot = true;
// Left wall
if (x === 0 && winYs.includes(y)) isWindowSpot = true;
// Right wall
if (x === INTERIOR_W - 1 && winYs.includes(y)) isWindowSpot = true;

if (isWindowSpot && isWall) {
  const isLeftWall  = (x === 0);
  const isRightWall = (x === INTERIOR_W - 1);
  const isTopWall   = (y === 0);
  const isBottomWall = (y === INTERIOR_H - 1);

  const half = Math.floor(TILE_SIZE / 2);
  const inset = 4;

  // Compute the wall "slab" bounds (matches your half-width side walls)
  let wx = sx, wy = sy, ww = TILE_SIZE, wh = TILE_SIZE;

  if (isLeftWall) {
    wx = sx + half; ww = half;              // left wall slab is on the right half
  } else if (isRightWall) {
    wx = sx; ww = half;                     // right wall slab is on the left half
  }

  // Door area safety: don't draw window over it
  const doorHere = (isBottomWall && x === midX);
  if (doorHere) {
    // nothing
  } else {
    // Window frame sized relative to slab
    const pad = Math.max(6, Math.floor(ww * 0.20));
    let fx = wx + pad;
    let fy = wy + 10;
    let fw = ww - pad * 2;
    let fh = TILE_SIZE - 20;

    // Bottom exterior wall: keep the window a bit higher so it sits in the "wall"
    // and doesn't clash with your log bands/door threshold vibe.
    if (isBottomWall) {
      fy = wy + 8;
      fh = TILE_SIZE - 24;
    }

    // Clamp in case slab is tight
    if (fw < 8 || fh < 8) return;

const isDayNow = !!(state.time?.isDay);

// Interior windows (top/left/right):
// - Day: pale glass + rays
// - Night: dark glass
//
// Exterior-facing bottom wall windows:
// - Day: brown tint (seeing floor through)
// - Night: warm glow (lights on)
const glassColor = (isBottomWall)
  ? (isDayNow ? "#6b4a2b" : "rgba(255,210,140,0.92)")
  : (isDayNow ? "rgba(210,230,255,0.70)" : "rgba(25,25,35,0.65)");

const innerSheen = (isBottomWall)
  ? (isDayNow ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.22)")
  : (isDayNow ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)");

// Frame stays the same
drawRect(fx, fy, fw, fh, "rgba(255,255,255,0.25)");                 // outer frame
drawRect(fx + 2, fy + 2, fw - 4, fh - 4, glassColor);              // glass
drawRect(fx + 3, fy + 3, fw - 6, fh - 6, innerSheen);

    // Cross muntin
    drawRect(fx + Math.floor(fw / 2) - 1, fy + 4, 2, fh - 8, "rgba(255,255,255,0.35)");
    drawRect(fx + 4, fy + Math.floor(fh / 2) - 1, fw - 8, 2, "rgba(255,255,255,0.35)");
	
	// ---- Defer window light beam so floors drawn later can't cover it
// (This only affects interior-facing beams; bottom wall windows are "exterior view" in your setup.)
if (!isBottomWall && (state.time?.isDay ?? true)) {
  const beamLen = TILE_SIZE * 3;

  if (isTopWall) {
    // Top wall beams go DOWN into the room
    deferredWindowBeams.push({
      dir: "down",
      x: fx + 2,
      y: fy + fh,
      w: fw - 4,
      h: beamLen
    });
  } else if (isLeftWall) {
    // Left wall beams go RIGHT into the room
    deferredWindowBeams.push({
      dir: "right",
      x: fx + fw,
      y: fy + 6,
      w: beamLen,
      h: fh - 12
    });
  } else if (isRightWall) {
    // Right wall beams go LEFT into the room
    deferredWindowBeams.push({
      dir: "left",
      x: fx - beamLen,
      y: fy + 6,
      w: beamLen,
      h: fh - 12
    });
  }
}

  }
}

  // IMPORTANT: don’t draw tile icons in interior mode (that’s your “brick texture”)
} else {
  // Overworld: keep your normal behavior
  drawRect(sx, sy, TILE_SIZE, TILE_SIZE, tileColor);

  // Tile icon stays (tiles aren't "objects")
  if (t?.icon) drawCenteredEmoji(t.icon, sx + TILE_SIZE / 2, sy + TILE_SIZE / 2, 24);
}
	 
	    // --- 6x6 placement highlight (preview) ---
  if (state.placement?.active && typeof state.pointer.x === "number") {
    const { x: hx, y: hy } = screenToMap(state.pointer.x, state.pointer.y);

    for (let dy = 0; dy < BUILD_FOOTPRINT; dy++) {
      for (let dx = 0; dx < BUILD_FOOTPRINT; dx++) {
        const tx = hx + dx;
        const ty = hy + dy;
        const s = mapToScreen(tx, ty);
        drawRect(s.sx, s.sy, TILE_SIZE, TILE_SIZE, "rgba(100,200,255,0.25)");
      }
    }
  }

          // --- Objects (hidden at night unless visible now) ---
      if (obj && visNow) {
		  // --- Dungeon rune clue decal (floor-painted rune) ---
if (obj.id === "rune_clue") {
  const rune = obj.meta?.rune ?? 1;
  const img = getRuneImg(rune);

  // subtle "painted" look: slightly lower and smaller than a normal icon
  try {
    ctx.globalAlpha = 0.85;
    ctx.drawImage(
      img,
      sx + TILE_SIZE / 2 - 14,
      sy + TILE_SIZE / 2 - 12,
      28,
      28
    );
  } catch (_) {}
  ctx.globalAlpha = 1;

  // IMPORTANT: don't let normal object drawing run for this tile
  continue;
}

        // Special-case dropped items (not in objects.json)
        if (obj.id === "dropped_item") {
          const id = obj.meta?.itemId;
          const def = itemDef(id);
          const icon = def?.icon ?? "📦";
          drawCenteredEmoji(icon, sx + TILE_SIZE / 2, sy + TILE_SIZE / 2, 24);

          // qty label
          const q = obj.meta?.qty ?? 1;
          ctx.fillStyle = "rgba(255,255,255,0.9)";
          ctx.font = "12px system-ui";
          ctx.textAlign = "right";
          ctx.textBaseline = "bottom";
          ctx.fillText(String(q), sx + TILE_SIZE - 4, sy + TILE_SIZE - 3);

        } else {
          const o = objDef(obj.id);
          if (o?.icon) {
            const isBuildStage =
              (obj.id === "build_site" || obj.id === "foundation" || obj.id === "framing" || obj.id === "house");

            if (isBuildStage) {
              const size = TILE_SIZE * BUILD_FOOTPRINT;
              deferredBuildIcons.push({
                icon: o.icon,
                sx,
                sy,
                size
              });

            } else {
                           // Interior: household image icons should be fit-to-tile-width (bed is 2 tiles)
              if (state.mode === "interior") {
                // Skip occupied proxies (right-half of bed)
                if (obj.id === "occupied" && obj.meta?.anchor) {
                  // draw nothing
                } else {
                  const wTiles = obj.meta?.wTiles ?? (obj.id === "bed" ? 2 : 1);
                  const targetW = TILE_SIZE * wTiles;
                  const isHousehold = Array.isArray(o.tags) && o.tags.includes("household");
                  const yOff = isHousehold ? Math.floor(TILE_SIZE / 2) : 0;

                  // IMPORTANT:
                  // Multi-tile sprites (bed) spill into the next tile.
                  // The next tile's floor draws later and overwrites the spill.
                  // So we defer multi-tile interior objects until AFTER the tile loops.
                  if (wTiles > 1) {
                    deferredInteriorMulti.push({
                      icon: o.icon,
                      sx,
                      sy,
                      yOff,
                      targetW
                    });
                  } else {
                    drawIconFitWidth(o.icon, sx, sy - yOff, targetW);
                  }
                }

              } else {

  // Overworld: defer "large" so we can draw it in front of the player when needed
  const sizeTag = String(o?.size ?? "medium").toLowerCase();
  const isLarge = (sizeTag === "large");

  if (isLarge) {
    deferredLargeObjects.push({ def: o, sx, sy, x, y });
  } else {
    drawOverworldObjectIcon(o, o.icon, sx, sy);
  }
}


            }
          }

          // Build progress bar (if object is tied to a build project)
          const key = obj?.meta?.key;
          if (key) {
            const proj = state.buildProjects[key];
            if (proj?.building && proj.timeLeft != null && proj.stageId) {
              const total = BUILD_STAGE_TIME_SEC[proj.stageId] || 1;
              const done = Math.max(0, Math.min(1, 1 - (proj.timeLeft / total)));

              const barW = TILE_SIZE * BUILD_FOOTPRINT;
              const barH = 5;

              drawRect(sx, sy - 8, barW, barH, "rgba(0,0,0,0.6)");
              drawRect(sx, sy - 8, barW * done, barH, "rgba(120,220,120,0.9)");
            }
          }

          // Optional coord labels (only if you can see the object)
          if (state.mode === "overworld" && (obj.id === "house" || obj.id === "stockpile")) {
            drawText(`(${x},${y})`, sx + TILE_SIZE / 2, sy + 8, 11, "center", "rgba(255,255,255,0.85)");
          }
        }
      }

// --- Interior players are drawn PER-TILE for correct occlusion/order ---
if (state.mode === "interior") {
  const hh = state.holdingHands;

  // Helper: does this tile contain the (visual) player for this frame?
  const tileKey = `${x},${y}`;
  const playerHere = playerTileSet.has(tileKey);

  // Draw player(s) on THIS tile
  if (hh) {
    const leadIndex = (typeof hh.leader === "number") ? hh.leader : hh.a;
    const lead = state.players[leadIndex];

    const tx = Math.floor(lead.fx + 0.5);
    const ty = Math.floor(lead.fy + 0.5);

    if (tx === x && ty === y) {
      const psx = sx + (lead.fx - x) * TILE_SIZE;
      const psy = sy + (lead.fy - y) * TILE_SIZE;
      drawCenteredEmoji(HOLDING_HANDS_ICON, psx + TILE_SIZE / 2, psy + TILE_SIZE / 2, 34);
    }
  } else {
    for (let i = 0; i < state.players.length; i++) {
      const pl = state.players[i];
      const tx = Math.floor(pl.fx + 0.5);
      const ty = Math.floor(pl.fy + 0.5);
      if (tx !== x || ty !== y) continue;

      const psx = sx + (pl.fx - x) * TILE_SIZE;
      const psy = sy + (pl.fy - y) * TILE_SIZE;
      drawAvatarTall(pl.icon, psx, psy, 1.25);
    }
  }

  // --- Perimeter bottom wall occlusion ONLY when player stands on the SAME wall tile ---
  // Re-draw the "front" portion of the bottom exterior wall AFTER the player so legs get hidden.
  if (playerHere) {
    const idef = state.data.interiors?.[state.interiorId];
    const wallTile = idef?.wallTile;
    const doorTile = idef?.doorTile;

    const tileId2 = map.tiles[y][x];
    const isWall2 = (tileId2 === wallTile);
    const isDoor2 = (tileId2 === doorTile);

    const isBottomWall = (y === INTERIOR_H - 1);
    if ((isWall2 || isDoor2) && isBottomWall) {
      const midX = Math.floor(INTERIOR_W / 2);
      const doorHere = isDoor2 || (x === midX);

      // Clip to a bottom band so ONLY “wall height” hides sprites on this tile
      const band = 40;
      const y0 = sy + TILE_SIZE - band;

      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, y0, TILE_SIZE, band);
      ctx.clip();

      // Match your existing bottom-wall look (grass strip + logs/threshold)
      const capH = 7;
      const half = Math.floor(TILE_SIZE / 2);

      // Grass strip (clipped at corners like your wall slabs)
      {
        const isDayNow = !!(state.time?.isDay);
        const gCol = isDayNow ? "#2f6f3a" : "rgba(47,111,58,0.35)";
        let _gx = sx, _gw = TILE_SIZE;
        if (x === 0) { _gx = sx + half; _gw = half; }
        else if (x === INTERIOR_W - 1) { _gx = sx; _gw = half; }
        drawRect(_gx, sy + TILE_SIZE - 8, _gw, 8, gCol);
      }

      // Logs (skip if door tile)
      if (!doorHere) {
        const logA = "#c8923b";
        const logB = "#b47c2f";
        const chink = "rgba(40,20,8,0.55)";
        const hi = "rgba(255,255,255,0.10)";

        let _lx = sx, _lw = TILE_SIZE;
        if (x === 0) { _lx = sx + half; _lw = half; }
        else if (x === INTERIOR_W - 1) { _lx = sx; _lw = half; }

        const usableH = TILE_SIZE - (capH + 2) - 6;
        const _bandH = Math.floor(usableH / 3);
        const _insetX = Math.max(4, Math.floor(_lw * 0.14));
        const _startY = sy + capH + 2;

        for (let i = 0; i < 3; i++) {
          const yy = _startY + i * _bandH;
          const alt = ((x + i) & 1) === 0;

          drawRect(_lx + _insetX, yy, _lw - _insetX * 2, _bandH - 2, alt ? logA : logB);
          drawRect(_lx + _insetX, yy + 1, _lw - _insetX * 2, 1, hi);

          if (i < 2) {
            const _cx = _lx + Math.max(3, _insetX - 2);
            const _cw = _lw - Math.max(3, _insetX - 2) * 2;
            drawRect(_cx, yy + _bandH - 2, _cw, 2, chink);
          }
        }
      } else {
        // Door threshold vibe (matches your existing bottom-wall door styling)
        drawRect(sx + 8, sy + TILE_SIZE - 6, TILE_SIZE - 16, 3, "rgba(0,0,0,0.35)");
        drawRect(sx + 10, sy + TILE_SIZE - 3, TILE_SIZE - 20, 1, "rgba(255,255,255,0.12)");
      }

      ctx.restore();
    }
  }
}

  // --- Interior built HORIZONTAL + VERTICAL walls (per-tile) ---
// This must be INSIDE the tile loop and AFTER objects on this tile.
if (state.mode === "interior") {
  const walls = state.interior?.walls;

  // -------- HORIZONTAL (already working) --------
  if (walls?.h?.[y]?.[x]) {
    const band = 40;
    const inset = 2;

    const wallOuter = "#3e2a17";
    const wallInner = "#523621";

    const capH = 3;
    const capWood = "rgba(180,120,60,0.55)";
    const capHi   = "rgba(255,255,255,0.16)";
    const capSh   = "rgba(0,0,0,0.28)";

    const y0 = sy + TILE_SIZE - band;

    ctx.save();
    ctx.beginPath();
    ctx.rect(sx, y0, TILE_SIZE, band);
    ctx.clip();

    drawRect(sx, y0, TILE_SIZE, band, wallOuter);
    drawRect(sx + inset, y0 + inset, TILE_SIZE - inset * 2, band - inset * 2, wallInner);

    drawRect(sx, y0, TILE_SIZE, capH, capWood);
    drawRect(sx, y0, TILE_SIZE, 1, capHi);
    drawRect(sx, y0 + capH - 1, TILE_SIZE, 1, capSh);

    ctx.restore();
  }

  // -------- VERTICAL (thin implied line + cap; continuous; no 3D) --------
{
  const thick = 2;
  const lineCol = "rgba(30,18,10,0.85)";
  const capCol  = "rgba(180,120,60,0.60)";
  const capHi   = "rgba(255,255,255,0.18)";
  const capSh   = "rgba(0,0,0,0.25)";

  const capW = 10;
  const capH = 3;

  const band = 40;                 // match horizontal band
  const yBandTop = sy + TILE_SIZE - band;

  // Draw only ONE copy of each edge: walls.v[y][x] owns the RIGHT edge of tile (x,y)
  if (walls?.v?.[y]?.[x]) {
    const lx = sx + TILE_SIZE - thick;

    // Full-height line so it doesn't look "unfinished"
    drawRect(lx, sy, thick, TILE_SIZE, lineCol);

    // Cap only at start of a continuous run (no segment above)
    // Continuous "cap" look: a highlight + shadow that runs down the wall *within the band*
// ---- Vertical "cap" strip: offset UP, and EXCLUDE bottom portion ----
const CAP_Y_OFF = 18;        // move it UP more (try 18–26)
const CAP_BOTTOM_CUT = 40;   // how much to remove at the very bottom of the run

const hasBelow = (y < INTERIOR_H - 1) && !!(walls?.v?.[y + 1]?.[x]);
const bottomCut = hasBelow ? 0 : CAP_BOTTOM_CUT;

let capBottom = (sy + TILE_SIZE) - bottomCut;
let capTop = yBandTop - CAP_Y_OFF;

// Clamp so we never invert or draw outside tile bounds
capTop = Math.max(sy, capTop);
capBottom = Math.min(sy + TILE_SIZE, capBottom);

const capHgt = Math.max(0, capBottom - capTop);
if (capHgt > 0) {
  // subtle wood-ish edge (optional)
  drawRect(lx - 1, capTop, 1, capHgt, capCol);

  // highlight edge
  drawRect(lx - 2, capTop, 1, capHgt, capHi);

  // shadow edge
  drawRect(lx + thick, capTop, 1, capHgt, capSh);
}

  }
}
}

// --- Fog + night darkness overlays ---
if (state.mode === "overworld" || state.mode === "dungeon") {
  // Unexplored tiles remain fogged always
  if (!explored) {
    // slightly different fog for dungeon vs overworld (optional, but nice)
    const fog = (state.mode === "dungeon")
      ? "rgba(0,0,0,0.92)"
      : "rgba(70,70,70,0.88)";
    drawRect(sx, sy, TILE_SIZE, TILE_SIZE, fog);
  } else if (state.mode === "overworld") {
    // At night: explored tiles are dark everywhere, except campfire glow
    if (!isDay) {
      const byFire = isLitByCampfire(x, y);

      if (!byFire) {
        drawRect(sx, sy, TILE_SIZE, TILE_SIZE, `rgba(0,0,0,${NIGHT_DARK_ALPHA})`);
      } else {
        drawRect(sx, sy, TILE_SIZE, TILE_SIZE, `rgba(0,0,0,${CAMPFIRE_LIT_DARK_ALPHA})`);
      }
    }
  }
}
    }
  }

// Draw deferred window beams ON TOP (so floor tiles can't cover them)
if (state.mode === "interior" && deferredWindowBeams.length) {
  for (const b of deferredWindowBeams) {
    ctx.save();

    if (b.dir === "down") {
      const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
      g.addColorStop(0, "rgba(255,240,200,0.05)");
      g.addColorStop(1, "rgba(255,240,200,0.00)");
      ctx.fillStyle = g;
      ctx.fillRect(b.x, b.y, b.w, b.h);
    } else if (b.dir === "right") {
      const g = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0);
      g.addColorStop(0, "rgba(255,240,200,0.05)");
      g.addColorStop(1, "rgba(255,240,200,0.00)");
      ctx.fillStyle = g;
      ctx.fillRect(b.x, b.y, b.w, b.h);
    } else if (b.dir === "left") {
      const g = ctx.createLinearGradient(b.x + b.w, 0, b.x, 0);
      g.addColorStop(0, "rgba(255,240,200,0.05)");
      g.addColorStop(1, "rgba(255,240,200,0.00)");
      ctx.fillStyle = g;
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }

    ctx.restore();
  }
}

// --- Deferred overworld "large" objects: split into back vs front (occlusion) ---
function _tileOfPlayer(pl) {
  // fx/fy are floats; use the tile we're actually in (prevents half-tile flicker)
  return { x: Math.floor(pl.fx), y: Math.floor(pl.fy) };
}

function _playerIsAboveObject(objX, objY) {
  // If holding hands, treat the combined icon as the only "player" tile
  const hh = state.holdingHands;
  if (hh) {
    const leadIndex = (typeof hh.leader === "number") ? hh.leader : hh.a;
    const lead = state.players[leadIndex];
    const t = _tileOfPlayer(lead);
    return (t.x === objX && t.y === objY - 1);
  }

  // Otherwise check each player
  for (const pl of state.players) {
    const t = _tileOfPlayer(pl);
    if (t.x === objX && t.y === objY - 1) return true;
  }
  return false;
}

// Draw the "back" large objects now (before players)
_largeFront = [];
if (state.mode === "overworld" && deferredLargeObjects.length) {
  for (const d of deferredLargeObjects) {
    if (_playerIsAboveObject(d.x, d.y)) _largeFront.push(d);
    else drawOverworldObjectIcon(d.def, d.def.icon, d.sx, d.sy);
  }
}

  // Draw deferred interior multi-tile icons AFTER all tiles are drawn
  // so floor tiles can't overwrite the spill (fixes bed missing half)
  if (state.mode === "interior" && deferredInteriorMulti.length) {
    for (const d of deferredInteriorMulti) {
      drawIconFitWidth(d.icon, d.sx, d.sy - d.yOff, d.targetW);
    }
  }

    // Draw deferred big build-stage icons ON TOP so tiles don’t overwrite them
  for (const d of deferredBuildIcons) {
    const cx = d.sx + d.size / 2;
    const cy = d.sy + d.size / 2;
    drawCenteredEmoji(d.icon, cx, cy, d.size * 0.9);
  }

  // Built interior walls: back pass before players, front pass after players
if (state.mode === "overworld") {
  // --- Players (use fx/fy for smooth movement) ---
const hh = state.holdingHands;

// If holding hands: hide both players and draw ONE combined icon on the leader tile
if (hh) {
  const leadIndex = (typeof hh.leader === "number") ? hh.leader : hh.a;
  const lead = state.players[leadIndex];

  const px = lead.fx;
  const py = lead.fy;

  if (px >= camX && px < camX + viewW && py >= camY && py < camY + viewH) {
    const sx = UI_LEFTBAR_W + (px - camX) * TILE_SIZE;
    const sy = UI_TOP_H + (py - camY) * TILE_SIZE;

    drawCenteredEmoji(HOLDING_HANDS_ICON, sx + TILE_SIZE / 2, sy + TILE_SIZE / 2, 34);
  }

} else {
  // Normal: draw each player icon
  for (let i = 0; i < state.players.length; i++) {
    const pl = state.players[i];

    const px = pl.fx;
    const py = pl.fy;

    if (px < camX || px >= camX + viewW || py < camY || py >= camY + viewH) continue;

    const sx = UI_LEFTBAR_W + (px - camX) * TILE_SIZE;
    const sy = UI_TOP_H + (py - camY) * TILE_SIZE;

    drawAvatarTall(pl.icon, sx, sy, 1.25);
  }
}
}

// --- Dungeon players (simple draw, no overworld depth sorting junk) ---
if (state.mode === "dungeon") {
  for (const pl of state.players) {
    const { sx, sy } = mapToScreen(pl.fx ?? pl.x, pl.fy ?? pl.y);
    drawAvatarTall(pl.icon, sx, sy, 1.25);
  }
}

// Draw any "front" large objects AFTER players (so player looks behind them)
if (state.mode === "overworld" && _largeFront && _largeFront.length) {
  for (const d of _largeFront) {
    drawOverworldObjectIcon(d.def, d.def.icon, d.sx, d.sy);
  }
}

}

function drawInventoryUI() {
  const baseY = window.innerHeight - UI_BOTTOM_H;
  drawRect(0, baseY, window.innerWidth, UI_BOTTOM_H, "rgba(0,0,0,0.78)");

  // --- Header text ---
  const leftX = UI_LEFTBAR_W
  const line1Y = baseY + 16;
  const line2Y = baseY + 34;
  const line3Y = baseY + 52;

  drawText("Tap map: pathfind + walk | Drag: pan camera | 1/2 switch player", leftX, line1Y, 13);
  drawText("Double-tap toolkit to open | C: craft | B: place house | M: saved coords | E: exit interior", leftX, line2Y, 13);

  const inv = activeInv();

  const sel = inv[state.selectedInvIdx];
const selectedNames = sel ? (itemDef(sel.id)?.name ?? sel.id) : "";


  drawText(`Selected: ${selectedNames || "(none)"}`, leftX, line3Y, 13, "left", "rgba(255,255,255,0.88)");

  // --- Inventory grid ---
  const cell = 44, pad = 10;
  const gridX = UI_LEFTBAR_W + pad;
  const gridY = baseY + 72;

  const UI_COLS = 12;
  const UI_ROWS = 2;

  drawText(`Inventory (${inv.length}/${INV_SLOTS})`, gridX, gridY - 10, 13);

  const slots = Array.from({ length: INV_SLOTS }, (_, i) => inv[i] ?? null);

  for (let i = 0; i < INV_SLOTS; i++) {
    const r = Math.floor(i / UI_COLS);
    const c = i % UI_COLS;
    if (r >= UI_ROWS) break;

    const x = gridX + c * (cell + 6);
    const y = gridY + r * (cell + 6);

    drawRect(x, y, cell, cell, "rgba(255,255,255,0.06)");
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.strokeRect(x, y, cell, cell);

// Selected inventory slot highlight (normal gameplay)
if (!state.craftingOpen && i === state.selectedInvIdx) {
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
  ctx.lineWidth = 1;
}

    const stack = slots[i];
    if (!stack) continue;

    const def = itemDef(stack.id);
    const icon = def?.icon ?? "❓";
    drawCenteredEmoji(icon, x + cell / 2, y + cell / 2 - 2, 20);

    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "12px system-ui";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(String(stack.qty), x + cell - 4, y + cell - 3);

    if (state.selectedForCraft.has(stack.id)) {
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 2, y + 2, cell - 4, cell - 4);
      ctx.lineWidth = 1;
    }
  }

  // ---- Activity Log (right-side panel) ----
  const logW = 420;
  const lx = UI_LEFTBAR_W + (viewTiles().viewW * TILE_SIZE) + pad;
  const ly = UI_TOP_H + pad;
  const logH = window.innerHeight - UI_TOP_H - UI_BOTTOM_H - pad * 2;

  state._logUI = { x: lx, y: ly, w: logW, h: logH };

  drawRect(lx, ly, logW, logH, "rgba(0,0,0,0.85)");
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.strokeRect(lx, ly, logW, logH);

  drawText("Activity Log", lx + 10, ly + 14, 13);

  const visible = Math.max(1, Math.floor((logH - 30) / 20));
  const start = state.logScroll;
  const logs = state.actionLog.slice(start, start + visible);

  let yy = ly + 34;

  for (const raw0 of logs) {
    // ---- Display-time grammar cleanup (doesn't touch game logic) ----
    let rawLine = raw0;

    // "2 Woods" -> "2 Wood" (uncountable resource tone)
    rawLine = rawLine.replace(/\b(\d+)\s+Woods\b/g, "$1 Wood");

    // Fix "an Hammer" etc: " an " before consonant-start word -> " a "
    // (Good enough rule: if next word starts with consonant letter)
    rawLine = rawLine.replace(/\ban\s+([bcdfghjklmnpqrstvwxyz])/gi, "a $1");

    const line = "> " + rawLine;
    const lower = rawLine.toLowerCase();

    // Decide subject color
    let subjectColor = null;

    if (lower.includes("harvest") || lower.includes("caught") || lower.includes("picked up")) {
      subjectColor = "rgba(120,255,120,0.95)";
    } else if (lower.includes("crafted")) {
      subjectColor = "rgba(120,220,255,0.95)";
    } else if (lower.includes("placed") || lower.includes("built") || lower.includes("constructed")) {
      subjectColor = "rgba(255,200,120,0.95)";
    } else if (lower.includes("found") || lower.includes("discovered") || lower.includes("opened") || lower.includes("got")) {
      subjectColor = "rgba(190,140,255,0.95)";
    }

    // If we don't know the action type, draw whole line in white
    if (!subjectColor) {
      drawText(line, lx + 10, yy, 12, "left", "rgba(255,255,255,0.85)");
      yy += 20;
      continue;
    }

    // Everything AFTER these phrases is "subject-ish"
    // (Order matters: longer phrases first)
    const subjectStartsAfter = [
      "picked up ",
      "constructed ",
      "harvested ",
      "discovered ",
      "opened ",
      "crafted ",
      "placed ",
      "built ",
      "found an ",
      "found a ",
      "found ",
      "got an ",
      "got a ",
      "got ",
      "caught "
    ];

    let cutIdx = -1;
    for (const phrase of subjectStartsAfter) {
      const idx = lower.indexOf(phrase);
      if (idx !== -1) {
        cutIdx = idx + phrase.length;
        break;
      }
    }

    if (cutIdx === -1 || cutIdx >= rawLine.length) {
      drawText(line, lx + 10, yy, 12, "left", "rgba(255,255,255,0.85)");
      yy += 20;
      continue;
    }

    // Subject chunk (may include qty / multiword name)
    let subjectChunk = rawLine.slice(cutIdx).trim();
    subjectChunk = subjectChunk.replace(/[!?.,]+$/, ""); // strip trailing punctuation

    // Strip leading articles from the COLORED part only
    // (keep them white by shifting them into the prefix)
    let leadingArticle = "";
    const subjLower = subjectChunk.toLowerCase();
    if (subjLower.startsWith("a ")) {
      leadingArticle = subjectChunk.slice(0, 2); // "a "
      subjectChunk = subjectChunk.slice(2);
    } else if (subjLower.startsWith("an ")) {
      leadingArticle = subjectChunk.slice(0, 3); // "an "
      subjectChunk = subjectChunk.slice(3);
    } else if (subjLower.startsWith("the ")) {
      leadingArticle = subjectChunk.slice(0, 4); // "the "
      subjectChunk = subjectChunk.slice(4);
    }

    subjectChunk = subjectChunk.trim();

    // If subject becomes empty, fallback
    if (!subjectChunk) {
      drawText(line, lx + 10, yy, 12, "left", "rgba(255,255,255,0.85)");
      yy += 20;
      continue;
    }

    // We render as: prefix (white) + leadingArticle (white) + subjectChunk (colored) + suffix (white)
    // Build the exact prefix string by reconstructing up to the colored subject
    // Find the subjectChunk occurrence from the end to avoid matching earlier words
    const full = "> " + rawLine;
    const needle = subjectChunk;
    const subjIdx = full.toLowerCase().lastIndexOf(needle.toLowerCase());

    if (subjIdx === -1) {
      drawText(full, lx + 10, yy, 12, "left", "rgba(255,255,255,0.85)");
      yy += 20;
      continue;
    }

    // Prefix should include everything up to the subject chunk, but keep the article white too.
    // If we detected a leadingArticle, it should appear immediately before the subject chunk.
    // So we draw prefix up to (subjIdx - leadingArticle.length), then draw leadingArticle (white),
    // then subjectChunk (colored), then suffix.
    const prefixEnd = Math.max(0, subjIdx - leadingArticle.length);
    const prefix = full.slice(0, prefixEnd);
    const suffix = full.slice(subjIdx + subjectChunk.length);

    ctx.font = "12px system-ui";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    // prefix
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(prefix, lx + 10, yy);
    let xoff = ctx.measureText(prefix).width;

    // article (white)
    if (leadingArticle) {
      ctx.fillText(leadingArticle, lx + 10 + xoff, yy);
      xoff += ctx.measureText(leadingArticle).width;
    }

    // subject (colored)
    ctx.fillStyle = subjectColor;
    ctx.fillText(subjectChunk, lx + 10 + xoff, yy);
    xoff += ctx.measureText(subjectChunk).width;

    // suffix (white)
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(suffix, lx + 10 + xoff, yy);

    yy += 20;
  }

  if (state.craftingOpen) drawCraftingPopup(baseY);
  if (state.coordsOpen) drawCoordsModal();
  if (state.stockpileOpen) drawStockpileModal();
  if (state.collectiblesOpen) drawCollectiblesModal();
  if (state.treasureOpen) drawTreasureModal();
}

function invIndexAtScreen(px, py) {
  const baseY = window.innerHeight - UI_BOTTOM_H;
  const cell = 44, pad = 10;
  const gridX = UI_LEFTBAR_W + pad; // <-- sidebar offset
  const gridY = baseY + 72;         // <-- MUST match drawInventoryUI's gridY

  const col = Math.floor((px - gridX) / (cell + 6));
  const row = Math.floor((py - gridY) / (cell + 6));
  if (col < 0 || col >= INV_COLS || row < 0 || row >= INV_ROWS) return -1;

  return row * INV_COLS + col;
}

// ------------------------------------------------------------------------ CRAFTING FUNCTIONS ----
function drawCraftingPopup() {
  if (!state.craftingOpen) return;

const inv = (activeInv() || [])
  .filter(st => st && st.id) // <-- prevents "Cannot read properties of null (reading 'id')"
  .filter(st => {
    const def = itemDef(st.id);
    const tags = def?.tags ?? [];
    if (state.craftingMode === "craft") return tags.includes("resource");
    if (state.craftingMode === "cook") return tags.includes("food");
    return false;
  });

  const recipes = recipeList().filter(r => {
  if (state.craftingMode === "craft") return recipeHasStation(r, "workbench");
  if (state.craftingMode === "cook")  return (recipeHasStation(r, "campfire") || recipeHasStation(r, "stove"));
  if (state.craftingMode === "prep")  return recipeHasStation(r, "counter");
  return false;
});

  const learned = recipes.filter(r => state.learnedRecipes.has(r.id));

  const W = 700;
  const H = 420;
  const x = (window.innerWidth - W) / 2;
  const y = (window.innerHeight - H) / 2;

  // Backdrop
  drawRect(0, 0, window.innerWidth, window.innerHeight, "rgba(0,0,0,0.6)");

  // Panel
  drawRect(x, y, W, H, "rgba(20,20,20,0.95)");
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.strokeRect(x, y, W, H);

  drawText(
  state.craftingMode === "cook" ? "Cooking" :
  state.craftingMode === "prep" ? "Preparing" :
  "Crafting",
  x + W/2, y + 24, 20, "center"
);

  const leftX = x + 16;
  const rightX = x + W / 2 + 8;
  const listY = y + 60;

  // Inventory column
  drawText("Inventory", leftX, listY - 20, 14);

  inv.forEach((st, i) => {
  const iy = listY + i * 28;

  const sel = selectedQty(st.id);
  const isSelected = sel > 0;

  // Layout
  const rowW = W/2 - 32;
  const rowH = 24;
  const iconX = leftX + 8;
  const textX = leftX + 34;

  // Slider area on right side of inventory row
  const sliderW = 120;
  const sliderH = 8;
  const sliderX = leftX + rowW - sliderW - 10;
  const sliderY = iy + 8;

  drawRect(leftX, iy, rowW, rowH, isSelected ? "rgba(80,120,255,0.4)" : "rgba(255,255,255,0.05)");

  // Icon
  const icon = itemDef(st.id)?.icon;
if (icon) drawCenteredEmoji(icon, iconX + 8, iy + 12, 16);

  // Name + owned
  const name = itemDef(st.id)?.name ?? st.id;
  drawText(`${name} (${st.qty})`, textX, iy + 12, 13, "left", "rgba(255,255,255,0.9)");

  // Slider track
  drawRect(sliderX, sliderY, sliderW, sliderH, "rgba(255,255,255,0.12)");

  // Slider fill based on selected / owned
  const maxQ = Math.max(1, st.qty);
  const t = clamp(sel / maxQ, 0, 1);
  drawRect(sliderX, sliderY, Math.floor(sliderW * t), sliderH, "rgba(80,180,255,0.65)");

  // Knob
  const knobX = sliderX + Math.floor(sliderW * t);
  drawRect(knobX - 2, sliderY - 4, 4, sliderH + 8, "rgba(255,255,255,0.75)");

  // Selected amount label
  if (sel > 0) drawText(`${sel}`, sliderX + sliderW + 10, iy + 12, 13, "left", "rgba(255,255,255,0.85)");
});


  // Recipes column
  drawText("Recipes", rightX, listY - 20, 14);

learned.forEach((r, i) => {
  const iy = listY + i * 28;
  const chk = canCraftRecipe(r);

  const rowW = W/2 - 32;
  const rowH = 24;

  const isSelected = state.selectedRecipeId === r.id;

  // background: highlight selected recipe
  drawRect(
    rightX,
    iy,
    rowW,
    rowH,
    isSelected ? "rgba(100,160,255,0.25)" : "rgba(255,255,255,0.05)"
  );

  // store click rect for pointer handler
  r._ui = { x: rightX, y: iy, w: rowW, h: rowH, craftable: chk.ok };

  drawText(
    r.name ?? r.id,
    rightX + 8,
    iy + 12,
    13,
    "left",
    chk.ok ? "#fff" : "rgba(255,255,255,0.35)"
  );
});

// Craft button (bottom center)
const btnW = 140, btnH = 34;
const btnX = x + (W - btnW) / 2;
const btnY = y + H - btnH - 10;

state._craftBtnRect = { x: btnX, y: btnY, w: btnW, h: btnH };

drawRect(btnX, btnY, btnW, btnH, "rgba(255,255,255,0.10)");
ctx.strokeStyle = "rgba(255,255,255,0.25)";
ctx.strokeRect(btnX, btnY, btnW, btnH);
drawText(
  (state.craftingMode === "cook" ? "Cook" : (state.craftingMode === "prep" ? "Prepare" : "Craft")),
  btnX + btnW/2, btnY + btnH/2 + 1
);

  drawText("[C] Craft   [ESC] Close", x + W - 12, y + H - 18, 12, "right", "rgba(255,255,255,0.6)");
}

function handleCraftingClick(px, py) {
  const W = 700;
  const H = 420;
  const x = (window.innerWidth - W) / 2;
  const y = (window.innerHeight - H) / 2;

  if (px < x || px > x + W || py < y || py > y + H) {
    closeCraftingScreen();
    return;
  }

  const leftX = x + 16;
  const listY = y + 60;

  const inv = activeInv().filter(st => {
  const def = itemDef(st.id);
  const tags = def?.tags ?? [];
  if (state.craftingMode === "craft") return tags.includes("resource");
  if (state.craftingMode === "cook") return tags.includes("food");
  return false;
});

  inv.forEach((st, i) => {
  const iy = listY + i * 28;

  const rowW = W/2 - 32;
  const rowH = 24;

  const sliderW = 120;
  const sliderX = leftX + rowW - sliderW - 10;
  const sliderY = iy + 8;
  const sliderH = 8;

  const inRow = (px >= leftX && px <= leftX + rowW && py >= iy && py <= iy + rowH);
  if (!inRow) return;

  // If click is inside slider area: set quantity based on click position
  const inSlider = (px >= sliderX && px <= sliderX + sliderW && py >= sliderY - 6 && py <= sliderY + sliderH + 6);

  if (inSlider) {
    state.selectedRecipeId = null;
    const t = (px - sliderX) / sliderW;
    const qty = clamp(Math.round(t * st.qty), 0, st.qty);
    setSelectedQty(st.id, qty);
    return;
  }

  // Otherwise toggle: select 1 by default, or clear
  const cur = selectedQty(st.id);
  if (cur > 0) setSelectedQty(st.id, 0);
  else setSelectedQty(st.id, 1);
});

}

function selectedQty(itemId) {
  return state.selectedForCraft.get(itemId) ?? 0;
}

function setSelectedQty(itemId, qty) {
  if (qty <= 0) state.selectedForCraft.delete(itemId);
  else state.selectedForCraft.set(itemId, qty);
  state.lastCraftItemId = itemId;
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function itemIcon(itemId) {
  const def = itemDef(itemId);
  return def?.icon ?? "•";
}

function updateCraftingSliderFromPx(px) {
  const d = state.craftingDrag;
  if (!d) return;

  const t = clamp((px - d.sliderX) / d.sliderW, 0, 1);
  const qty = clamp(Math.round(t * d.maxQty), 0, d.maxQty);
  setSelectedQty(d.itemId, qty);
}

function handleCraftingPointerDown(px, py) {
  const W = 700, H = 420;
  const x = (window.innerWidth - W) / 2;
  const y = (window.innerHeight - H) / 2;

  if (px < x || px > x + W || py < y || py > y + H) {
    closeCraftingScreen();
    return;
  }

  const leftX = x + 16;
  const listY = y + 60;

// Craft button click
const b = state._craftBtnRect;
if (b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
  attemptManualCraft();
  return;
}

  const inv = getCraftingInvFiltered(); // use your existing filtered inv function

  inv.forEach((st, i) => {
    const iy = listY + i * 28;

    const rowW = W/2 - 32;
    const rowH = 24;

    const sliderW = 120;
    const sliderX = leftX + rowW - sliderW - 10;
    const sliderY = iy + 8;
    const sliderH = 8;

    const inRow = (px >= leftX && px <= leftX + rowW && py >= iy && py <= iy + rowH);
    if (!inRow) return;

    const inSlider = (px >= sliderX && px <= sliderX + sliderW && py >= sliderY - 6 && py <= sliderY + sliderH + 6);

    if (inSlider) {
      state.selectedRecipeId = null;
      state.craftingDrag = { itemId: st.id, sliderX, sliderW, maxQty: st.qty };
      updateCraftingSliderFromPx(px);
      return;
    }

    // normal row click: toggle 1 / 0
    const cur = selectedQty(st.id);
    if (cur > 0) setSelectedQty(st.id, 0);
    else setSelectedQty(st.id, 1);
  });

// --- Recipes column click: select recipe + load inputs into selection ---
const rightX = x + W / 2 + 8;
const listY2 = y + 60;

const recipes = recipeList().filter(r => {
  if (state.craftingMode === "craft") return recipeHasStation(r, "workbench");
  if (state.craftingMode === "cook")  return (recipeHasStation(r, "campfire") || recipeHasStation(r, "stove"));
  return false;
});

const learned = recipes.filter(r => state.learnedRecipes.has(r.id));

for (let i = 0; i < learned.length; i++) {
  const r = learned[i];
  if (!r._ui) continue;

  if (px >= r._ui.x && px <= r._ui.x + r._ui.w && py >= r._ui.y && py <= r._ui.y + r._ui.h) {
    if (!r._ui.craftable) return; // greyed out: ignore

    state.selectedRecipeId = r.id;

    // load exact recipe inputs into selection map
    state.selectedForCraft.clear();
    for (const [id, qty] of Object.entries(r.in ?? {})) {
      setSelectedQty(id, qty);
    }
    return;
  }
}

}

function handleCraftingPointerUp() {
  state.craftingDrag = null;
}

function getCraftingInvFiltered() {
  return (activeInv() || [])
    .filter(st => st && st.id)
    .filter(st => {
      const def = itemDef(st.id);
      const tags = def?.tags ?? [];
     if (state.craftingMode === "craft") return tags.includes("resource");
if (state.craftingMode === "cook") return tags.includes("food");
if (state.craftingMode === "prep") return (tags.includes("food") || tags.includes("dish") || tags.includes("resource"));
return false;
    });
}

// --- DIGGING (shovel) ----------------------------------------------------

const DIG_CRITTER_CHANCE = 0.25; // 25% chance per dig
const DIG_SEED_CHANCE = 0.15; // 15% chance per dig to find seeds
const DIG_HOLE_CHANCE = 0.06; // 6% chance per dig to discover a hole

function getCritterIdsFromObjects() {
  const objs = state.data?.objects ?? {};
  return Object.keys(objs).filter(id => {
    const tags = objs[id]?.tags ?? [];
    return tags.includes("critter");
  });
}

function digAtPlayerTile() {
  const p = activePlayer();
  const inv = activeInv();

  if (state.mode !== "overworld") {
    logAction(`${p.name} can't dig in here.`);
    return;
  }

  const tile = tileAt(p.x, p.y);
  if (tile !== "grass") {
    logAction(`${p.name} can't dig here (grass only).`);
    return;
  }
  
  // Don't dig on top of objects (prevents digging "through" holes, chests, etc.)
const px0 = Math.round(p.x);
const py0 = Math.round(p.y);
if (state.world?.objects?.[py0]?.[px0]) {
  logAction(`${p.name} can't dig here (something's in the way).`);
  return;
}

    // Treasure target check (from a revealed Treasure Map)
  const px = Math.round(p.x);
  const py = Math.round(p.y);
  if (state.treasureTarget && state.treasureTarget.x === px && state.treasureTarget.y === py) {
    playSound("dig");

    const collectibleIds = allCollectibleIds();
    if (collectibleIds.length > 0) {
      const cid = collectibleIds[randInt(0, collectibleIds.length - 1)];
      const res = addItemOrDrop(inv, cid, 1, px, py, p.name);

      if (res.added > 0) {
        const nm = itemDef(cid)?.name ?? cid;
        const article = /^[aeiou]/i.test(nm) ? "an" : "a";
		playSound("achievement");
        logAction(`${p.name} followed a treasure map and found ${article} ${nm}!`);
      } else {
        logAction(`${p.name} followed a treasure map, but couldn't carry the treasure.`);
      }
    } else {
      logAction(`${p.name} dug up an empty spot. (No collectibles exist yet.)`);
    }

    // Clear target (one map = one treasure)
    state.treasureTarget = null;
    state.treasureOpen = false;
    return;
  }

  playSound("dig");

  const r = Math.random();

// ---- Holes ----
if (objDef("hole") && r < DIG_HOLE_CHANCE) {
  getCurrentMap().objects[py][px] = {
    id: "hole",
    hp: objDef("hole")?.hp ?? 1,
    meta: { discoveredBy: p.name }
  };
  logAction(`${p.name} uncovered a hole!`);
  return;
}

  // ---- Seeds ----
  if (r < DIG_SEED_CHANCE) {
    const seeds = getSeedItemIds();

    if (seeds.length > 0) {
      const seedId = seeds[randInt(0, seeds.length - 1)];
      addItem(inv, seedId, 1);

      const name = itemDef(seedId)?.name ?? seedId;
      logAction(`${p.name} found ${name}!`);
    } else {
      logAction(`${p.name} dug around and found nothing.`);
    }

    return;
  }

  // ---- Critters ----
  if (r < DIG_SEED_CHANCE + DIG_CRITTER_CHANCE) {
    const critters = getCritterItemIds();

    if (critters.length > 0) {
      const critterId = critters[randInt(0, critters.length - 1)];
      addItem(inv, critterId, 1);

      const name = itemDef(critterId)?.name ?? critterId;
      logAction(`${p.name} dug up a ${name}!`);
    } else {
      logAction(`${p.name} dug around and found nothing.`);
    }

    return;
  }

  // ---- Nothing ----
  logAction(`${p.name} dug around and found nothing.`);
}

function getCritterItemIds() {
  const items = state.data?.items ?? {};
  return Object.keys(items).filter(id => {
    const tags = items[id]?.tags ?? [];
    return tags.includes("critter");
  });
}

function getSeedItemIds() {
  const items = state.data?.items ?? {};
  return Object.keys(items).filter(id => {
    const tags = items[id]?.tags ?? [];
    return tags.includes("seed");
  });
}

function openMenuForInventoryItem(invIdx, screenX, screenY) {
  const inv = activeInv();
  const st = inv[invIdx];
  if (!st) return;

  const p = activePlayer();
  const map = getCurrentMap();

  const itemId = st.id;
  const def = itemDef(itemId);
  const itemName = def?.name ?? itemId;

  const emptyBucketId = firstExistingItemId(["bucket", "empty_bucket"]);
  const filledBucketId = firstExistingItemId(["bucket_water", "water_bucket", "bucket_of_water"]);

    // NOTE: drop sometimes failed because p.x/p.y can be non-integers (movement smoothing).
  // That made dropItemOnTile() return false, and the revert addItem() shoved the stack to the last slot.
  const drop = (qty) => {
    // Lock to a real tile coordinate
    const tx = Math.round(p.x);
    const ty = Math.round(p.y);

    // Re-check occupancy at the moment of dropping (player may have moved since menu opened)
    const blocked = isTileOccupiedForDrop(tx, ty);
    if (blocked) return;

    // Snapshot for a clean revert that preserves the slot
    const beforeQty = st.qty;

    if (!removeItem(inv, itemId, qty)) return;

    const ok = dropItemOnTile(itemId, qty, tx, ty);
    if (!ok) {
      // Revert WITHOUT reordering inventory
      if (beforeQty <= qty) {
        // We removed the whole stack, so put it back in the same slot
        inv.splice(invIdx, 0, { id: itemId, qty: beforeQty });
      } else {
        // We reduced qty on the existing stack, restore it
        st.qty = beforeQty;
      }
      return;
    }

    logAction(`${p.name} dropped ${qty} ${itemName}${qty === 1 ? "" : "s"} at (${tx},${ty}).`);
    closeMenu();
  };

  const dropBlocked = isTileOccupiedForDrop(Math.round(p.x), Math.round(p.y));

  const canDump = filledBucketId && emptyBucketId && itemId === filledBucketId;

  openMenu({
    screenX, screenY,
    title: itemName,
    options: [
      // Eat (only if this item has nourishment)
      ...(typeof def?.nourishment === "number" ? [{
        label: `Eat (+${def.nourishment})`,
        action: withSfx("eat", () => { 
          // hunger system uses "fills as you get hungry", so eating reduces hunger
          p.hunger = clamp((p.hunger ?? 0) - def.nourishment, 0, HUNGER_MAX);
          if (!removeItem(inv, itemId, 1)) return;
          logAction(`${p.name} ate ${itemName}.`);
          closeMenu();
        })
      }] : []),
	        // Examine (shows items.json description)
      ...(typeof def?.description === "string" ? [{
        label: "Examine",
        disabledReason: (def.description.trim().length ? null : "No description"),
        action: withSfx("click", () => {
          const desc = def.description.trim();
          openRunestoneReader(itemName, desc.length ? desc : "(No description.)");
          closeMenu();
        })
      }] : []),
      {
  label: "Drop 1",
  disabledReason: dropBlocked ? "Tile occupied" : (st.qty >= 1 ? null : "None"),
  action: () => {
    playSound("pop");
    drop(1);
  },
},
      {
  label: `Drop all (${st.qty})`,
  disabledReason: dropBlocked ? "Tile occupied" : null,
  action: () => {
    playSound("pop");
    drop(st.qty);
  },
},

      ...(itemId === "shovel" ? [{
        label: "Dig (grass tile)",
        disabledReason: (() => {
          if (state.mode !== "overworld") return "Overworld only";
          if (tileAt(p.x, p.y) !== "grass") return "Grass only";
          if (objectAt(p.x, p.y)) return "Tile occupied";
          return null;
        })(),
        action: withSfx("dig", () => {
          digAtPlayerTile();
          closeMenu();
        })
      }] : []),
      ...( (def?.tags ?? []).includes("seed") ? [{
        label: "Plant (on your tile)",
        disabledReason: (() => {
  if (state.mode !== "overworld") return "Overworld only";
  if (!hasTool(activeInv(), "spade")) return "Needs spade";
  if (tileAt(p.x, p.y) !== "grass") return "Grass only";
  if (objectAt(p.x, p.y)) return "Tile occupied";
  if (!seedGrowsToItemId(itemId)) return "No crop item found";
  return null;
})(),
        action: withSfx("pickup", () => {
          plantSeedAtPlayerTile(itemId);
          closeMenu();
        })
      }] : []),
      ...(canDump ? [{
        label: "Dump out water",
        action: withSfx("water", () => {
          // convert filled -> empty
          if (!removeItem(inv, filledBucketId, 1)) return;
          addItem(inv, emptyBucketId, 1);
          logAction(`${p.name} dumped out a bucket of water.`);
          closeMenu();
        })
      }] : [])
    ]
  });
}

function drawInteractionRequestDialog() {
  const req = state.interactionRequest;
  if (!req) return;

  // Only show it to the intended receiver (the currently controlled character)
  if (state.activePlayer !== req.toIndex) return;

  const fromName = state.players[req.fromIndex].name;
  const type = req.type;

  const W = 420;
  const H = 170;
  const x = (window.innerWidth - W) / 2;
  const y = UI_TOP_H + 40;

  // Backdrop
  drawRect(0, 0, window.innerWidth, window.innerHeight, "rgba(0,0,0,0.35)");

  // Panel
  drawRect(x, y, W, H, "rgba(20,20,20,0.96)");
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.strokeRect(x, y, W, H);

  drawText("Interaction Request", x + 14, y + 22, 16);
  drawText(`${fromName} would like to: ${type}`, x + 14, y + 52, 14);

  // Buttons
  const btnW = 150;
  const btnH = 34;
  const gap = 16;

  const bx1 = x + W/2 - btnW - gap/2;
  const bx2 = x + W/2 + gap/2;
  const by = y + H - 54;

  // Save hit rects
  req._ui = {
    accept: { x: bx1, y: by, w: btnW, h: btnH },
    decline:{ x: bx2, y: by, w: btnW, h: btnH }
  };

  // Accept
  drawRect(bx1, by, btnW, btnH, "rgba(255,255,255,0.10)");
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.strokeRect(bx1, by, btnW, btnH);
  drawText("Accept", bx1 + btnW/2, by + 22, 14, "center", "rgba(255,255,255,0.92)");

  // Decline
  drawRect(bx2, by, btnW, btnH, "rgba(255,255,255,0.06)");
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.strokeRect(bx2, by, btnW, btnH);
  drawText("Decline", bx2 + btnW/2, by + 22, 14, "center", "rgba(255,255,255,0.85)");
}

function drawMenu() {
  if (!state.menu) return;

  const m = state.menu;
  const pad = 10;
  const lineH = 24;
  const width = 240;
  const height = pad + 18 + m.options.length * lineH + pad;

  let x = m.screenX;
  let y = m.screenY;
  if (x + width > window.innerWidth - 6) x = window.innerWidth - width - 6;
  if (y + height > window.innerHeight - UI_BOTTOM_H - 6) y = window.innerHeight - UI_BOTTOM_H - height - 6;
  if (y < UI_TOP_H + 6) y = UI_TOP_H + 6;

  m._drawRect = { x, y, w: width, h: height };

  drawRect(x, y, width, height, "rgba(20,20,20,0.95)");
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.strokeRect(x, y, width, height);

  drawText(m.title, x + pad, y + 14, 14);

  m._hit = [];
  let yy = y + 34;

  for (let i = 0; i < m.options.length; i++) {
    const opt = m.options[i];
    const disabled = !!opt.disabledReason;

    // hover color change (requested)
    if (i === m.hoverIndex) drawRect(x + 6, yy - 12, width - 12, 22, "rgba(255,255,255,0.10)");

    const label = disabled ? `${opt.label} (${opt.disabledReason})` : opt.label;
    drawText(label, x + pad, yy, 13, "left", disabled ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.92)");

    m._hit.push({ x, y: yy - 12, w: width, h: 22, opt, index: i });
    yy += lineH;
  }
}

function openRunestoneReader(title, text) {
  state.runestoneReader = {
    open: true,
    title: title || "Runestone",
    text: String(text ?? "")
  };
}

function closeRunestoneReader() {
  if (state.runestoneReader) state.runestoneReader.open = false;
}

function drawCoordsModal() {
  const w = 520;
  const h = 360;
  const x = Math.floor((window.innerWidth - w) / 2);
  const y = Math.floor((window.innerHeight - h) / 2);

  drawRect(x, y, w, h, "rgba(10,10,10,0.92)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(x, y, w, h);

  drawText("Saved Coordinates", x + 12, y + 18, 16);

  const p = activePlayer();
  drawText(`Current: (${p.x},${p.y})`, x + w - 12, y + 18, 13, "right", "rgba(255,255,255,0.85)");

  // Buttons
  state._coordsUI = {
    close:  { x: x + w - 90, y: y + h - 40, w: 80, h: 28 },
    mark:   { x: x + 12,      y: y + h - 40, w: 200, h: 28 },
    travel: { x: x + 230,     y: y + h - 40, w: 120, h: 28 },
    list: []
  };

  // list
  const listY = y + 44;
  let yy = listY;

  const items = state.markers.slice(0, 12);

  if (items.length === 0) {
    drawText("No saved locations yet (structures are auto-saved).", x + 12, yy + 10, 13, "left", "rgba(255,255,255,0.75)");
  } else {
    for (const m of items) {
      const key = markerKey(m);
      const row = { key, x: x + 10, y: yy, w: w - 20, h: 20 };
      state._coordsUI.list.push(row);

      // highlight selected
      if (state.coordsSelected === key) {
        drawRect(row.x, row.y, row.w, row.h, "rgba(255,255,255,0.10)");
      }

      drawText(`${m.label}: (${m.x},${m.y})`, x + 12, yy + 10, 13, "left", "rgba(255,255,255,0.9)");
      yy += 22;
    }
  }

  // buttons draw
  const b = state._coordsUI;

  // Mark current
  drawRect(b.mark.x, b.mark.y, b.mark.w, b.mark.h, "rgba(255,255,255,0.10)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(b.mark.x, b.mark.y, b.mark.w, b.mark.h);
  drawText("Mark current location", b.mark.x + 10, b.mark.y + b.mark.h / 2, 13);

  // Travel There (only if selected)
  const travelEnabled = !!state.coordsSelected && state.markers.some(m => markerKey(m) === state.coordsSelected);
  drawRect(
    b.travel.x, b.travel.y, b.travel.w, b.travel.h,
    travelEnabled ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)"
  );
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(b.travel.x, b.travel.y, b.travel.w, b.travel.h);
  drawText("Travel There", b.travel.x + b.travel.w / 2, b.travel.y + b.travel.h / 2, 13, "center",
    travelEnabled ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.45)"
  );

  // Close
  drawRect(b.close.x, b.close.y, b.close.w, b.close.h, "rgba(255,255,255,0.10)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(b.close.x, b.close.y, b.close.w, b.close.h);
  drawText("Close", b.close.x + b.close.w / 2, b.close.y + b.close.h / 2, 13, "center");
}

function drawCollectiblesModal() {
  const ids = allCollectibleIds();
  const found = state.collectiblesFound || {};

  const w = 640;
  const h = 420;
  const x = Math.floor((window.innerWidth - w) / 2);
  const y = Math.floor((window.innerHeight - h) / 2);

  drawRect(x, y, w, h, "rgba(10,10,10,0.92)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(x, y, w, h);

  drawText("Collectibles", x + 16, y + 30, 22, "left", "rgba(255,255,255,0.95)");
  drawText(`${Object.keys(found).length}/${ids.length} found`, x + w - 16, y + 80, 12, "right", "rgba(255,255,255,0.75)");

  const close = { x: x + w - 90, y: y + 10, w: 80, h: 28 };
  drawRect(close.x, close.y, close.w, close.h, "rgba(30,30,30,0.95)");
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.strokeRect(close.x, close.y, close.w, close.h);
  drawText("Close", close.x + close.w / 2, close.y + 20, 14, "center", "rgba(255,255,255,0.9)");

  // Tabs
  const tabList = { x: x + 16, y: y + 50, w: 120, h: 28 };
  const tabRead = { x: x + 16 + 128, y: y + 50, w: 120, h: 28 };

  const isList = (state.collectiblesView !== "reader");
  drawRect(tabList.x, tabList.y, tabList.w, tabList.h, isList ? "rgba(60,120,60,0.85)" : "rgba(30,30,30,0.95)");
  drawRect(tabRead.x, tabRead.y, tabRead.w, tabRead.h, !isList ? "rgba(60,120,60,0.85)" : "rgba(30,30,30,0.95)");
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.strokeRect(tabList.x, tabList.y, tabList.w, tabList.h);
  ctx.strokeRect(tabRead.x, tabRead.y, tabRead.w, tabRead.h);
  drawText("Archive", tabList.x + tabList.w / 2, tabList.y + 20, 14, "center", "rgba(255,255,255,0.95)");
  drawText("Reader", tabRead.x + tabRead.w / 2, tabRead.y + 20, 14, "center", "rgba(255,255,255,0.95)");

  const bodyX = x + 16;
  const bodyY = y + 90;
  const bodyW = w - 32;
  const bodyH = h - 150;

  state._collectiblesUI = {
    x, y, w, h,
    close,
    tabList, tabRead,
    rows: [],
    backBtn: null
  };

  // Reader view
  if (state.collectiblesView === "reader") {
    const id = state.collectiblesSelected;
    const it = id ? itemDef(id) : null;

    const backBtn = { x: x + 16, y: y + h - 40, w: 90, h: 28 };
    state._collectiblesUI.backBtn = backBtn;

    drawRect(bodyX, bodyY, bodyW, bodyH, "rgba(0,0,0,0.30)");
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.strokeRect(bodyX, bodyY, bodyW, bodyH);

    if (!it) {
      drawText("Nothing selected.", bodyX + 12, bodyY + 26, 16, "left", "rgba(255,255,255,0.9)");
    } else {
      drawText(it.name ?? id, bodyX + 12, bodyY + 26, 18, "left", "rgba(255,255,255,0.95)");
      const msg = (typeof it.message === "string" && it.message.trim())
        ? it.message
        : "(This collectible has no message yet.)";

      // Simple wrap
      const maxW = bodyW - 24;
      const words = msg.split(/\s+/);
      let line = "";
      let yy = bodyY + 56;

      ctx.font = `14px sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      for (const w0 of words) {
        const test = line ? (line + " " + w0) : w0;
        if (ctx.measureText(test).width > maxW) {
          ctx.fillText(line, bodyX + 12, yy);
          yy += 18;
          line = w0;
        } else {
          line = test;
        }
      }
      if (line) ctx.fillText(line, bodyX + 12, yy);

      // Found by
      const rec = found[id];
      if (rec?.by) {
        const parts = Object.entries(rec.by).map(([n, c]) => `${n} (${c})`);
        drawText(`Found by: ${parts.join(", ")}`, bodyX + 100, y + h - 18, 13, "left", "rgba(255,255,255,0.65)");
      }
    }

    drawRect(backBtn.x, backBtn.y, backBtn.w, backBtn.h, "rgba(30,30,30,0.95)");
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.strokeRect(backBtn.x, backBtn.y, backBtn.w, backBtn.h);
    drawText("Back", backBtn.x + backBtn.w / 2, backBtn.y + 20, 14, "center", "rgba(255,255,255,0.9)");

    return;
  }

  // Archive list view
  drawRect(bodyX, bodyY, bodyW, bodyH, "rgba(0,0,0,0.30)");
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.strokeRect(bodyX, bodyY, bodyW, bodyH);

  // Sort by name for sanity
  ids.sort((a, b) => (itemDef(a)?.name ?? a).localeCompare(itemDef(b)?.name ?? b));

  const rowH = 26;
  const visible = Math.floor((bodyH - 12) / rowH);
  const scroll = Math.max(0, Math.min(state.collectiblesScroll | 0, Math.max(0, ids.length - visible)));

  state.collectiblesScroll = scroll;

  const start = scroll;
  const end = Math.min(ids.length, start + visible);

  let ry = bodyY + 8;
  for (let i = start; i < end; i++) {
    const id = ids[i];
    const it = itemDef(id);
    const isFound = !!found[id];

    const row = { x: bodyX + 8, y: ry, w: bodyW - 16, h: rowH - 2, id };
    state._collectiblesUI.rows.push(row);

    drawRect(row.x, row.y, row.w, row.h, isFound ? "rgba(20,60,20,0.65)" : "rgba(30,30,30,0.55)");
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.strokeRect(row.x, row.y, row.w, row.h);

    const title = isFound ? (it?.name ?? id) : "???";
    drawText(title, row.x + 10, row.y + 18, 14, "left", "rgba(255,255,255,0.90)");

    if (isFound) {
      const by = found[id]?.by ? Object.keys(found[id].by).join(", ") : "";
      if (by) drawText(by, row.x + row.w - 10, row.y + 18, 12, "right", "rgba(255,255,255,0.55)");
    }

    ry += rowH;
  }

  // Page buttons (simple)
  const prevBtn = { x: x + 16, y: y + h - 44, w: 90, h: 28 };
  const nextBtn = { x: x + 112, y: y + h - 44, w: 90, h: 28 };
  state._collectiblesUI.prevBtn = prevBtn;
  state._collectiblesUI.nextBtn = nextBtn;

  drawRect(prevBtn.x, prevBtn.y, prevBtn.w, prevBtn.h, "rgba(30,30,30,0.95)");
  drawRect(nextBtn.x, nextBtn.y, nextBtn.w, nextBtn.h, "rgba(30,30,30,0.95)");
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.strokeRect(prevBtn.x, prevBtn.y, prevBtn.w, prevBtn.h);
  ctx.strokeRect(nextBtn.x, nextBtn.y, nextBtn.w, nextBtn.h);
  drawText("Prev", prevBtn.x + prevBtn.w / 2, prevBtn.y + 20, 14, "center", "rgba(255,255,255,0.9)");
  drawText("Next", nextBtn.x + nextBtn.w / 2, nextBtn.y + 20, 14, "center", "rgba(255,255,255,0.9)");
}

function handleCollectiblesTap(px, py) {
  const ui = state._collectiblesUI;
  if (!ui) return false;

  if (hitRect(px, py, ui.close)) {
    playSound("click");
    state.collectiblesOpen = false;
    state.collectiblesView = "list";
    state.collectiblesSelected = null;
    return true;
  }

  if (ui.tabList && hitRect(px, py, ui.tabList)) {
    playSound("click");
    state.collectiblesView = "list";
    return true;
  }
  if (ui.tabRead && hitRect(px, py, ui.tabRead)) {
    playSound("click");
    state.collectiblesView = "reader";
    return true;
  }

  if (state.collectiblesView === "reader") {
    if (ui.backBtn && hitRect(px, py, ui.backBtn)) {
      playSound("click");
      state.collectiblesView = "list";
      state.collectiblesSelected = null;
      return true;
    }
    return true; // reader eats clicks
  }

  // list paging
  if (ui.prevBtn && hitRect(px, py, ui.prevBtn)) {
    playSound("click");
    state.collectiblesScroll = Math.max(0, (state.collectiblesScroll | 0) - 10);
    return true;
  }
  if (ui.nextBtn && hitRect(px, py, ui.nextBtn)) {
    playSound("click");
    state.collectiblesScroll = (state.collectiblesScroll | 0) + 10;
    return true;
  }

  // row select (only if found)
  const found = state.collectiblesFound || {};
  for (const r of (ui.rows || [])) {
    if (hitRect(px, py, r) && found[r.id]) {
      playSound("click");
      state.collectiblesView = "reader";
      state.collectiblesSelected = r.id;
      return true;
    }
  }

  return true;
}

function drawTreasureModal() {
  const t = state.treasureTarget;
  const by = t?.by ? ` (by ${t.by})` : "";
  const coord = t ? `(${t.x}, ${t.y})` : "(?, ?)";

  const W = 360;
  const H = 160;
  const x = Math.floor((window.innerWidth - W) / 2);
  const y = Math.floor((window.innerHeight - H) / 2);

  // Backdrop
  drawRect(0, 0, window.innerWidth, window.innerHeight, "rgba(0,0,0,0.35)");

  // Panel
  drawRect(x, y, W, H, "rgba(15,15,15,0.96)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(x, y, W, H);

  drawText("Treasure Map", x + 14, y + 26, 18, "left", "rgba(255,255,255,0.95)");
  drawText(`X,Y: ${coord}`, x + 14, y + 56, 15, "left", "rgba(255,255,255,0.90)");

  // Close button
  const close = { x: x + W - 86, y: y + 10, w: 76, h: 28 };
  state._treasureUI = { close };

  drawRect(close.x, close.y, close.w, close.h, "rgba(30,30,30,0.95)");
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.strokeRect(close.x, close.y, close.w, close.h);
  drawText("Close", close.x + close.w / 2, close.y + 20, 14, "center", "rgba(255,255,255,0.9)");
}

function handleTreasureTap(px, py) {
  const ui = state._treasureUI;
  if (!ui) return false;

  if (ui.close && hitRect(px, py, ui.close)) {
    playSound("click");
    state.treasureOpen = false;
    state._treasureUI = null;
    return true;
  }

  // Eat clicks so it doesn't move the character behind the modal.
  return true;
}

function drawStockpileModal() {
  const key = state.stockpileOpen?.key;
  const sp = key ? getStockpileByKey(key) : null;
  if (!sp) { state.stockpileOpen = null; return; }

  const w = Math.min(650, window.innerWidth - 20);
  const h = Math.min(360, window.innerHeight - 140);
  const x = (window.innerWidth - w) / 2;
  const y = UI_TOP_H + 20;

  drawRect(x, y, w, h, "rgba(10,10,10,0.92)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(x, y, w, h);

  drawText(`Stockpile at (${sp.x},${sp.y})`, x + 12, y + 18, 16);

  // Close button
  state._stockUI = {
    close: { x: x + w - 90, y: y + h - 40, w: 80, h: 28 }
  };

  // Two columns: player inv, stockpile inv. Click stack to move full stack.
  const leftX = x + 12;
  const mid = x + w / 2;
  const topY = y + 44;

  drawText("Your Inventory (tap item to store)", leftX, topY, 13, "left", "rgba(255,255,255,0.85)");
  drawText("Stockpile (tap item to retrieve)", mid + 12, topY, 13, "left", "rgba(255,255,255,0.85)");

  const pInv = activeInv();
  const sInv = sp.inv;

  // draw lists
  const rowH = 22;
  let yyL = topY + 20;
  let yyR = topY + 20;

  state._stockUI.left = [];
  state._stockUI.right = [];

  for (let i = 0; i < Math.min(12, pInv.length); i++) {
    const st = pInv[i];
    const def = itemDef(st.id);
    drawText(`${def?.icon ?? "❓"} ${def?.name ?? st.id} x${st.qty}`, leftX, yyL, 13, "left", "rgba(255,255,255,0.9)");
    state._stockUI.left.push({ i, x: leftX, y: yyL - 10, w: (w/2) - 24, h: 20 });
    yyL += rowH;
  }
  if (pInv.length === 0) drawText("(empty)", leftX, yyL, 13, "left", "rgba(255,255,255,0.55)");

  for (let i = 0; i < Math.min(12, sInv.length); i++) {
    const st = sInv[i];
    const def = itemDef(st.id);
    drawText(`${def?.icon ?? "❓"} ${def?.name ?? st.id} x${st.qty}`, mid + 12, yyR, 13, "left", "rgba(255,255,255,0.9)");
    state._stockUI.right.push({ i, x: mid + 12, y: yyR - 10, w: (w/2) - 24, h: 20 });
    yyR += rowH;
  }
  if (sInv.length === 0) drawText("(empty)", mid + 12, yyR, 13, "left", "rgba(255,255,255,0.55)");

  // Close button
  const b = state._stockUI.close;
  drawRect(b.x, b.y, b.w, b.h, "rgba(255,255,255,0.10)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  drawText("Close", b.x + b.w/2, b.y + b.h/2, 13, "center");
}

function formatIO(obj) {
  return Object.entries(obj).map(([id, amt]) => `${amt} ${itemDef(id)?.name ?? id}`).join(", ");
}

// ---- Hit testing ----
function isInWorldArea(py) {
  return py >= UI_TOP_H && py <= (window.innerHeight - UI_BOTTOM_H);
}

function isInInventoryArea(py) {
  return py > (window.innerHeight - UI_BOTTOM_H);
}

function playerScreenRects() {
  const { viewW, viewH } = viewTiles();
  const camX = state.cam.x, camY = state.cam.y;

  const rects = [];
  for (let i = 0; i < state.players.length; i++) {
    const pl = state.players[i];
    const px = pl.fx, py = pl.fy;

    if (px < camX || px >= camX + viewW || py < camY || py >= camY + viewH) continue;

    const sx = (px - camX) * TILE_SIZE;
    const sy = UI_TOP_H + (py - camY) * TILE_SIZE;

    rects.push({ i, x: sx, y: sy, w: TILE_SIZE, h: TILE_SIZE });
  }
  return rects;
}

function hitRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

function upgradeBuildSite(x, y) {
  const key = `${x},${y}`;
  const proj = state.buildProjects[key];
  if (!proj) return;

  const obj = state.world.objects?.[y]?.[x];
  if (!obj) return;

  const stageId = obj.id; // "build_site" | "foundation" | "framing"
  const stage = BUILD_STAGES.find(s => s.id === proj.stageId);
  const req = stage?.needs;

  if (!req) return;

  const p = activePlayer();

  // Build menu: show remaining needs + deposit buttons + Build when ready
  const options = [];

  for (const matId of Object.keys(req)) {
    const need = req[matId];
    const have = proj.mats?.[matId] || 0;

    options.push({
      label: `${matId}: ${have}/${need}`,
      action: () => {
        if (removeItem(activeInv(), matId, 1)) {
          proj.mats = proj.mats || {};
          proj.mats[matId] = (proj.mats[matId] || 0) + 1;
          playSound("click");
          // reopen menu so the counts update
          upgradeBuildSite(x, y);
        } else {
          playSound("deny");
        }
      }
    });
  }

  const ready = Object.keys(req).every(matId => (proj.mats?.[matId] || 0) >= req[matId]);

  if (ready) {
    options.push({
      label: "Build",
      action: () => startBuildTimer(key, x, y, stageId)
    });
  }

  openMenu({
    screenX: (state.menu?.screenX ?? 200),
    screenY: (state.menu?.screenY ?? 200),
    title: `Construction: ${stageId}`,
    options
  });
}

function startBuildTimer(key, x, y, stageId) {
  const proj = state.buildProjects[key];
  if (!proj || proj.building) return;

  proj.building = true;
// Preserve partial progress if you paused mid-build.
const sameStage = (proj.stageId === stageId);
proj.stageId = stageId;
if (!sameStage || !isFinite(proj.timeLeft) || proj.timeLeft <= 0) {
  proj.timeLeft = BUILD_STAGE_TIME_SEC[stageId];
}

  // Add the active player as a builder
  const me = activePlayer();
  if (!proj.builders.includes(me.id)) proj.builders.push(me.id);

  playLoopSound("hammer");
  logAction(`${me.name} started building (${stageId})...`);
}

function stopBuildTimer(key) {
  const proj = state.buildProjects[key];
  if (!proj) return;
  proj.building = false;
  stopLoopSound("hammer");
}

function finishBuildStage(key, x, y) {
  const obj = state.world.objects?.[y]?.[x];
  if (!obj) return;

  const next = buildStageDef(obj.id)?.next || null;
  const proj = state.buildProjects[key];

  stopBuildTimer(key);

  if (next === "house") {
    // final: becomes enterable house door
    state.world.objects[y][x] = { id: "house", hp: 999, meta: { interiorId: "house_small" } };
    delete state.buildProjects[key];
    saveHouseAt(x, y);
    playSound("achievement");
    logAction(`${activePlayer().name} completed construction → House`);
    return;
  }

  // advance to next stage object
  obj.id = next;
  if (proj) {
    proj.mats = {};
    proj.building = false;
    proj.timeLeft = 0;
    proj.stageId = next;
  }

  playSound("achievement");
  logAction(`${activePlayer().name} advanced construction → ${next}`);
}

function playLoopSound(name) {
  const s = sounds[name];
  if (!s) return;
  s.loop = true;
  if (s.paused) {
    s.currentTime = 0;
    s.play().catch(() => {});
  }
}

function stopLoopSound(name) {
  const s = sounds[name];
  if (!s) return;
  try { s.pause(); } catch (_) {}
  s.loop = false;
  s.currentTime = 0;
}

// ---- Input handling ----
function handleMenuHover(px, py) {
  if (!state.menu || !state.menu._hit) return;
  let idx = -1;
  for (const h of state.menu._hit) {
    if (hitRect(px, py, h)) { idx = h.index; break; }
  }
  state.menu.hoverIndex = idx;
}

function handleMenuTap(px, py) {
  if (!state.menu || !state.menu._hit) return false;
  for (const h of state.menu._hit) {
    if (hitRect(px, py, h)) {
      if (h.opt.disabledReason) return true;
      h.opt.action();
      return true;
    }
  }
  closeMenu();
  return true;
}

function handleCoordsTap(px, py) {
  const ui = state._coordsUI;
  if (!ui) return false;

  if (hitRect(px, py, ui.close)) {
    playSound("click");
    state.coordsOpen = false;
    return true;
  }

  if (hitRect(px, py, ui.mark)) {
    const p = activePlayer();
    const n = state.markers.filter(m => m.type === "marker").length + 1;
    addMarker(`Marker ${n}`, p.x, p.y, "marker");
    return true;
  }

  // select a row
  for (const r of ui.list || []) {
    if (hitRect(px, py, r)) {
      state.coordsSelected = r.key;
      return true;
    }
  }

  // travel
  if (hitRect(px, py, ui.travel)) {
    if (!state.coordsSelected) return true;

    const m = state.markers.find(mm => markerKey(mm) === state.coordsSelected);
    if (!m) return true;

    setPathTo(m.x, m.y);
    state.coordsOpen = false;
    return true;
  }

  return true; // modal eats clicks
}

function handleStockpileTap(px, py) {
  const ui = state._stockUI;
  const key = state.stockpileOpen?.key;
  const sp = key ? getStockpileByKey(key) : null;
  if (!ui || !sp) return false;

  const pName = activePlayer().name;

  if (hitRect(px, py, ui.close)) {
    state.stockpileOpen = null;
    return true;
  }

  // Move full stack from player -> stockpile
  for (const r of ui.left) {
    if (hitRect(px, py, r)) {
      const inv = activeInv();
      const st = inv[r.i];
      if (!st) return true;

      const qty = st.qty;
      const id = st.id;

      removeItem(inv, id, qty);
      addItem(sp.inv, id, qty);

      const itemName = itemDef(id)?.name ?? id;
      logAction(`${pName} stored ${qty} ${itemName}${qty === 1 ? "" : "s"}.`);

      return true;
    }
  }

  // Move full stack from stockpile -> player
  for (const r of ui.right) {
    if (hitRect(px, py, r)) {
      const st = sp.inv[r.i];
      if (!st) return true;

      const qty = st.qty;
      const id = st.id;

      // try add, then remove from stockpile if success
      const res = addItem(activeInv(), id, qty);
      if (res.ok) {
        removeItem(sp.inv, id, qty);

        const itemName = itemDef(id)?.name ?? id;
        logAction(`${pName} retrieved ${qty} ${itemName}${qty === 1 ? "" : "s"}.`);
      }

      return true;
    }
  }

  return true;
}

function handleInventoryTap(px, py) {
  const baseY = window.innerHeight - UI_BOTTOM_H;

  // crafting recipe clicks
  if (state.craftingOpen) {
    const matches = recipesMatchingSelection();
    for (const r of matches.slice(0, 6)) {
      if (!r._ui) continue;
      if (hitRect(px, py, r._ui)) {
        if (r._ui.craftable) craftRecipe(r.id);
        return true;
      }
    }
  }

  // inventory grid
  const cell = 44, pad = 10;
  const gridX = UI_LEFTBAR_W + pad;
  const gridY = baseY + 72;

  const col = Math.floor((px - gridX) / (cell + 6));
  const row = Math.floor((py - gridY) / (cell + 6));
  if (col < 0 || col >= INV_COLS || row < 0 || row >= INV_ROWS) return false;

  const idx = row * INV_COLS + col;
  const inv = activeInv();
  const stack = inv[idx];
  if (!stack) return false;

// Blueprint interaction
if (stack.id === "blueprint_house") {
  openMenu({
    screenX: px,
    screenY: py,
    title: "House Blueprint",
    options: [
      {
        label: "Begin Construction",
        action: () => {
          // Enter placement mode (do not place yet)
          state.placement.active = true;
          state.placement.dragging = false;
          state.placement.anchorX = null;
          state.placement.anchorY = null;

          state.placement.blueprintItemId = "blueprint_house";
          state.placement.placeId = "build_site";

          logAction(`${activePlayer().name} is placing a 6x6 build site...`);
          closeMenu();
        }
      }
    ]
  });
  return true;
}

  const now = performance.now();
  const isDouble = (state.lastInvClick.idx === idx) && (now - state.lastInvClick.t <= DOUBLE_CLICK_MS);
  state.lastInvClick = { idx, t: now };

  // double click toolkit opens it (requested)
  if (isDouble && stack.id === "toolkit") {
    openToolkitForActivePlayer();
    return true;
  }

// double click recipe scroll learns it + consumes 1
if (isDouble && isRecipeScroll(stack.id)) {
  const rid = recipeIdFromScroll(stack.id);
  if (!rid) {
    logAction(`That recipe scroll doesn't match any recipe.`);
    return true;
  }

  if (state.learnedRecipes.has(rid)) {
    // Already learned: do NOT consume (so it can be traded)
    logAction(`Already learned: ${state.data.recipes[rid]?.name ?? rid}.`);
    return true;
  }

  learnRecipe(rid);
  removeItem(activeInv(), stack.id, 1);

  playSound("achievement");
  logAction(`${activePlayer().name} learned ${state.data.recipes[rid]?.name ?? rid}!`);
  return true;
}

// double click collectible opens it + consumes 1 + archives it
if (isDouble && isCollectible(stack.id)) {
  const pName = activePlayer().name;

  // Archive first (so even if inventory math goes weird, it's recorded)
  markCollectibleFound(stack.id, pName);

  // Consume one copy
  removeItem(activeInv(), stack.id, 1);

  // Open reader modal
  state.collectiblesOpen = true;
  state.collectiblesView = "reader";
  state.collectiblesSelected = stack.id;

  playSound("click");
  closeMenu();
  return true;
}

// double click treasure map: consume 1, reveal coords, set dig target
if (isDouble && stack.id === "treasure_map") {
  // Consume one map (stacked maps are treated as "one use = one roll")
  removeItem(activeInv(), stack.id, 1);

  // Roll a valid overworld grass coordinate
  const tgt = rollTreasureCoord();
  state.treasureTarget = { x: tgt.x, y: tgt.y, by: activePlayer().name };
  state.treasureOpen = true;

  playSound("click");
  closeMenu();
  return true;
}

  // toggle selection for crafting filters
 if (state.craftingOpen) {
  // crafting mode: clicking inventory selects ingredients
  if (state.selectedForCraft.has(stack.id))
    state.selectedForCraft.delete(stack.id);
  else
    state.selectedForCraft.add(stack.id);
} else {
  // normal gameplay: clicking inventory selects the slot
  state.selectedInvIdx = idx;
  playSound("click");
}

return true;
}

// Pointer events (CAPTURE gatekeeper to prevent click-through into world)
function pointerPos(e) {
  const r = canvas.getBoundingClientRect();
  // IMPORTANT: return CSS pixel coordinates to match draw-space (ctx is DPR-scaled)
  return {
    px: e.clientX - r.left,
    py: e.clientY - r.top,
  };
}

function isInWorldBounds(px, py) {
  const worldPxW = viewTiles().viewW * TILE_SIZE;

  const left = UI_LEFTBAR_W;
  const right = UI_LEFTBAR_W + worldPxW;

  const top = UI_TOP_H;
  const bottom = window.innerHeight - UI_BOTTOM_H; // CSS pixels, not canvas.height

  return px >= left && px < right && py >= top && py < bottom;
}

function isInRightSidebar(px) {
  const worldPxW = viewTiles().viewW * TILE_SIZE;
  const worldRight = UI_LEFTBAR_W + worldPxW;
  return px >= worldRight;
}

function renderActivityLogDOM() {
  const body = document.getElementById("activityLogBody");
  const panel = document.getElementById("activityLog");
  if (!body || !panel) return;

  const lines = state.actionLog || [];
  const wasNearBottom =
    panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 24;

  // Render
  body.innerHTML = lines
    .slice(-200) // keep it sane
    .map(t => `<div class="line">${escapeHTML(String(t))}</div>`)
    .join("");

  // Keep it pinned unless the user scrolled up
  if (wasNearBottom) panel.scrollTop = panel.scrollHeight;
}

function escapeHTML(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isInActivityLog(px, py) {
  // Prefer the real rect if it exists
  if (state._logUI) return hitRect(px, py, state._logUI);

  // Fallback: match your draw layout (same assumptions)
  const pad = 10;
  const { viewW } = viewTiles();
  const logX = UI_LEFTBAR_W + (viewW * TILE_SIZE) + pad;
  const logY = UI_TOP_H + pad;
  const logW = 420;
  const logH = window.innerHeight - UI_TOP_H - UI_BOTTOM_H - pad * 2;

  return (
    px >= logX && px <= (logX + logW) &&
    py >= logY && py <= (logY + logH)
  );
}

function updateMapCursor(px, py) {
  // Title screen: always default cursor
  if (state.title?.open) {
    canvas.style.cursor = "default";
    return;
  }

  // UI + modals always use default cursor
  if (
  state.settingsOpen ||
    state.coordsOpen ||
    state.stockpileOpen ||
    isInRightSidebar(px) ||
    isInActivityLog(px, py) ||
    !isInWorldBounds(px, py)
  ) {
    canvas.style.cursor = "default";
    return;
  }

  // While pointer is held down in the world (and not blocked), show grab/grabbing
  if (state.pointer.down && !state.pointer.blocked) {
    canvas.style.cursor = state.pointer.dragging ? "grabbing" : "grab";
    return;
  }

  // Hover world object → object-specific cursor
  const { x, y } = screenToMap(px, py);
  const obj = objectAt(x, y);

  // 1) Bushes → grab hand cursor
  if (obj && ["bush", "berry_bush"].includes(obj.id)) {
    canvas.style.cursor = "grab";
    return;
  }

  // 2) Explicit cursor icon mappings (axe/pick/key etc.)
  if (obj && OBJECT_CURSORS[obj.id]) {
    const c = OBJECT_CURSORS[obj.id];
    canvas.style.cursor = cursorFromIcon(c.icon, c.hotX, c.hotY);
    return;
  }

// 2b) Harvest tool cursor (auto: axe/pickaxe/fishing pole, etc.)
if (obj) {
  const def = objDef(obj.id);
  const tool = def?.harvest?.requiresTool;

  if (tool === "axe") {
    canvas.style.cursor = cursorFromIcon("axe.png", 10, 10);
    return;
  }
  if (tool === "pickaxe") {
    canvas.style.cursor = cursorFromIcon("pick.png", 10, 10);
    return;
  }
  if (tool === "fishing_pole") {
    canvas.style.cursor = cursorFromIcon("fishing_pole.png", 10, 10);
    return;
  }
}

  // 3) Pickup-able objects (sticks, stones, etc.) → hand cursor
  if (obj) {
    const def = objDef(obj.id);
    if (def?.pickup) {
      canvas.style.cursor = "grab";
      return;
    }
  }

  // Default world hover
  canvas.style.cursor = "default";
}

// ---- Cursor icon mapping for world objects ----
// Images must exist in: src/icons/
const OBJECT_CURSORS = {
  tree1: { icon: "axe.png", hotX: 10, hotY: 10 },
  tree2: { icon: "axe.png", hotX: 10, hotY: 10 },
    tree3: { icon: "axe.png", hotX: 10, hotY: 10 },
	  tree4: { icon: "axe.png", hotX: 10, hotY: 10 },
	    tree5: { icon: "axe.png", hotX: 10, hotY: 10 },
		  tree6: { icon: "axe.png", hotX: 10, hotY: 10 },
		    tree7: { icon: "axe.png", hotX: 10, hotY: 10 },
			  tree8: { icon: "axe.png", hotX: 10, hotY: 10 },
  rock: { icon: "pick.png", hotX: 10, hotY: 10 },
  chest: { icon: "search.png", hotX: 8, hotY: 4 },
  toolbox: { icon: "search.png", hotX: 8, hotY: 4 },
  fish_spot: { icon: "fishing_pole.png", hotX: 10, hotY: 10 },
  berry_bush: { icon: "basket.png", hotX: 10, hotY: 10 },
  apple_tree: { icon: "basket.png", hotX: 10, hotY: 10 },
  deer: { icon: "bow_and_arrow.png", hotX: 10, hotY: 10 },
  squirrel: { icon: "bow_and_arrow.png", hotX: 10, hotY: 10 },
  cow: { icon: "bucket.png", hotX: 10, hotY: 10 },
  pig: { icon: "bow_and_arrow.png", hotX: 10, hotY: 10 },
  chicken: { icon: "bow_and_arrow.png", hotX: 10, hotY: 10 }
};

function cursorFromIcon(icon, hotX = 0, hotY = 0, fallback = "pointer") {
  return `url("./src/icons/${icon}") ${hotX} ${hotY}, ${fallback}`;
}

canvas.addEventListener("pointerdown", (e) => {
  const { px, py } = pointerPos(e);

  // TITLE MENU ALWAYS EATS INPUT
  if (state.title?.open) {
    state.pointer.down = true;
    state.pointer.dragging = false;
    state.pointer.startX = px;
    state.pointer.startY = py;
    state.pointer.lastX = px;
    state.pointer.lastY = py;
    state.pointer.blocked = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    return;
  }

  state.pointer.down = true;
  state.pointer.dragging = false;
  state.pointer.startX = px;
  state.pointer.startY = py;
  state.pointer.lastX = px;
  state.pointer.lastY = py;

  // Settings modal MUST eat pointerdown so UI can be clicked (tabs, toggles, sliders).
  if (state.settingsOpen) {
    state.pointer.blocked = true;
    handleSettingsPointerDown(px, py);
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    return;
  }

  // Rune combo lock modal MUST eat pointerdown so the map doesn't start a drag/move.
  if (state.comboLock?.open) {
    state.pointer.blocked = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    return;
  }

 // Left sidebar (compass/volume/settings + volume slider)
if (handleLeftSidebarTap(px, py)) return;

// If any popup menu is open, it MUST eat the whole interaction.
// This prevents tiny mouse movement from being treated as a map drag that closes the menu.
if (state.menu) {
  state.pointer.blocked = true;
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  return;
}

  // Crafting/Cooking modal eats clicks. No map interaction.
  if (state.craftingOpen) {
    handleCraftingPointerDown(e.offsetX, e.offsetY);
    return;
  }

// Crafting/Cooking modal eats clicks. No map interaction.
  // Interior Edit Mode: clicking tiles edits instead of moving
if (state.mode === "interior" && state.interiorEdit?.on && isInWorldBounds(px, py)) {
  const { x, y } = screenToMap(px, py);
  openInteriorEditMenu(x, y, px, py);
  return;
}

// Placement mode: start drag anchor in world, but DO NOT place until pointerup
if (state.placement?.active && isInWorldBounds(px, py)) {
  const { x, y } = screenToMap(px, py);

  state.placement.anchorX = x;
  state.placement.anchorY = y;
  state.placement.dragging = true;

  state.pointer.blocked = true; // eat map drag + world clicks while placing
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  return;
}


  // Block if the press started outside world OR inside the activity log area.
  state.pointer.blocked = !isInWorldBounds(px, py) || isInActivityLog(px, py);

  // Keep getting move/up events even if pointer slips outside canvas while dragging.
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}

  updateMapCursor(px, py);
});

canvas.addEventListener("pointermove", (e) => {
  const { px, py } = pointerPos(e);
  
    // keep a live cursor position for placement highlight
  state.pointer.x = px;
  state.pointer.y = py;

// dragging the left-sidebar slider
if (handleLeftSidebarDrag(px, py)) return;

  // Settings modal drag (sliders)
  if (state.settingsOpen) {
    if (handleSettingsDrag(px, py)) return;
    return; // settings modal blocks map dragging/hover
  }

if (state.craftingOpen && state.craftingDrag) {
  updateCraftingSliderFromPx(e.offsetX);
  return;
}

  // hover effects
  if (state.menu) handleMenuHover(px, py);

  // crafting recipe hover
  state.hoveredUI = null;
  if (state.craftingOpen && isInInventoryArea(py)) {
    const matches = recipesMatchingSelection();
    for (const r of matches.slice(0, 6)) {
      if (r._ui && hitRect(px, py, r._ui)) {
        state.hoveredUI = { type: "recipe", id: r.id };
        break;
      }
    }
  }

  // Cursor feedback even when not dragging
  updateMapCursor(px, py);

  if (!state.pointer.down) return;
  if (state.pointer.blocked) return; // <- key line

  const dx = px - state.pointer.startX;
  const dy = py - state.pointer.startY;

  if (!state.pointer.dragging && (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX)) {
    state.pointer.dragging = true;
    closeMenu();
    updateMapCursor(px, py);
  }

  if (state.pointer.dragging) {
    const mx = px - state.pointer.lastX;
    const my = py - state.pointer.lastY;

    const tileShiftX = Math.round(-mx / TILE_SIZE);
    const tileShiftY = Math.round(-my / TILE_SIZE);

    if (tileShiftX !== 0 || tileShiftY !== 0) {
      state.cam.x += tileShiftX;
      state.cam.y += tileShiftY;
      clampCamera();
    }

    state.pointer.lastX = px;
    state.pointer.lastY = py;
  }
});

// Pointer up: handle UI clicks + world clicks
canvas.addEventListener("pointerup", (e) => {
  const wasDragging = state.pointer.dragging;

  state.pointer.down = false;
  state.pointer.dragging = false;

  const { px, py } = pointerPos(e);

// Cutscene modal: block all other input
if (state.cutscene?.open) {
  state.cutscene.index++;

  if (state.cutscene.index >= CUTSCENE_SLIDES.length) {
    state.cutscene.open = false;
    state.cutscene.seen = true;
    saveCutsceneSeen(true);

    // Always uncheck after playing (same logic as tutorial)
    state.wantCutscene = false;
    saveWantCutscene(false);

    // Decide what comes next
    if (state.cutscene._after === "tutorial") {
      state.tutorial.open = true;
      state.tutorial.index = 0;
      return;
    }

    // Otherwise start game
    titleStartOrContinue();
  }

  return;
}

// Tutorial modal: block all other input
if (state.tutorial?.open) {
  state.tutorial.index++;

  if (state.tutorial.index >= TUTORIAL_SLIDES.length) {
    state.tutorial.open = false;
state.tutorial.seen = true;
saveTutorialSeen(true);
state.wantTutorial = false; // uncheck next time, using the real flag
saveWantTutorial(false);
titleStartOrContinue();      // start game after tutorial
  }

  return;
}

if (state.constructionOpen) {
  handleConstructionTap(px, py);
  state.pointer.blocked = false;
  return;
}

// Runestone reader modal: swallow pointerup so world doesn't move
if (state.runestoneReader?.open) {
  const ui = state._runestoneUI;
  if (ui?.closeBtn && px >= ui.closeBtn.x && px <= ui.closeBtn.x + ui.closeBtn.w &&
      py >= ui.closeBtn.y && py <= ui.closeBtn.y + ui.closeBtn.h) {
    closeRunestoneReader();
  } else if (ui?.panel) {
    // click outside panel closes
    const inside = (px >= ui.panel.x && px <= ui.panel.x + ui.panel.w &&
                    py >= ui.panel.y && py <= ui.panel.y + ui.panel.h);
    if (!inside) closeRunestoneReader();
  }
  state.pointer.blocked = false;
  return;
}

// Rune combo lock modal: swallow pointerup so the world doesn't interpret it as a move
if (state.comboLock?.open) {
  handleRuneComboLockClick(px, py);
  state.pointer.blocked = false;
  return;
}

  // Settings modal: swallow pointerup so the world doesn't interpret it as a move
  if (state.settingsOpen) {
    handleSettingsPointerUp();
    state.pointer.blocked = false;
    return;
  }

if (state.title?.open) {
  handleTitleMenuTap(px, py);
  return;
}

  if (typeof updateMapCursor === "function") updateMapCursor(px, py);

// stop dragging if we were dragging volume
state.ui.musicDragging = false;

  // Crafting popup: end drag + eat click
  if (state.craftingOpen) {
    handleCraftingPointerUp();
    state.pointer.blocked = false;
    return;
  }
  
  // Placement mode: place on release
  if (state.placement?.active && state.placement.dragging) {
    const ok = placeBuildSite(state.placement.anchorX, state.placement.anchorY);

    if (ok) {
      // consume blueprint only AFTER successful placement
      removeItem(activeInv(), state.placement.blueprintItemId, 1);
    } else {
      logAction("Can't place a build site there.");
    }

    state.placement.active = false;
    state.placement.dragging = false;
    state.pointer.blocked = false;
    return;
  }

  // If we were dragging the map, we’re done. Don’t treat it as a click.
  if (wasDragging) {
    state.pointer.blocked = false;
    return;
  }

  // Interaction request dialog has top priority (blocks everything else)
  if (state.interactionRequest && state.activePlayer === state.interactionRequest.toIndex) {
    const ui = state.interactionRequest._ui;
    if (ui) {
      if (hitRect(px, py, ui.accept)) { acceptInteractionRequest(); state.pointer.blocked = false; return; }
      if (hitRect(px, py, ui.decline)) { declineInteractionRequest(); state.pointer.blocked = false; return; }
    }
    // Clicking outside does nothing (forces an explicit choice)
    state.pointer.blocked = false;
    return;
  }

  // UI should still work even if pointer.blocked is true (inventory is outside world bounds).
  if (state.coordsOpen) { handleCoordsTap(px, py); state.pointer.blocked = false; return; }
  if (state.collectiblesOpen) { handleCollectiblesTap(px, py); state.pointer.blocked = false; return; }
  if (state.treasureOpen) { handleTreasureTap(px, py); state.pointer.blocked = false; return; }
  if (state.stockpileOpen) { handleStockpileTap(px, py); state.pointer.blocked = false; return; }
  if (state.menu) {
  // If a menu was opened on pointerdown, do NOT let the immediate pointerup auto-close it.
  if (state.menu._justOpened) {
    state.menu._justOpened = false;
    state.pointer.blocked = false;
    return;
  }
  handleMenuTap(px, py);
  state.pointer.blocked = false;
  return;
}


  if (isInInventoryArea(py)) {
    handleInventoryTap(px, py);
    state.pointer.blocked = false;
    return;
  }

  // From here down: world clicks only.
  if (state.pointer.blocked) {
    state.pointer.blocked = false;
    return;
  }
  state.pointer.blocked = false;

  // Hard rule: log area is never a map click.
  if (isInActivityLog(px, py)) return;

  // Absolute rule: outside world rectangle = NOT a map click.
  if (!isInWorldBounds(px, py)) return;

  const { x, y } = screenToMap(px, py);

  // placement modes
  if (state.placinghouse) {
    if (placehouseAt(x, y)) state.placinghouse = false;
    return;
  }
  if (state.placingStockpile) {
    if (placeStockpileAt(x, y)) state.placingStockpile = false;
    return;
  }

  // Holding hands visual merge: clicking either person opens the holding-hands menu
  if (state.holdingHands) {
    const hh = state.holdingHands;
    const a = state.players[hh.a];
    const b = state.players[hh.b];

    if ((x === a.x && y === a.y) || (x === b.x && y === b.y)) {
      openMenuForHoldingHands(px, py);
      return;
    }
  }


// clicking a player => open menu (no more switching active player by clicking)
const clickedPlayerIndex = state.players.findIndex(pl => pl.x === x && pl.y === y);
if (clickedPlayerIndex !== -1) {
  if (clickedPlayerIndex === state.activePlayer) {
    // clicking yourself keeps the existing self menu
    openMenuForPlayer(clickedPlayerIndex, px, py);
  } else {
    // clicking the other player will become the interaction menu (next step)
    openMenuForOtherPlayer(clickedPlayerIndex, px, py);
  }
  return;
}

  // adjacent object => context menu (FIRST)
  const obj = objectAt(x, y);
  if (obj) {
    const def = objDef(obj.id);
    const pl = activePlayer();
    const dist = manhattan(pl.x, pl.y, x, y);

    const canShoot =
      isHuntableDef(def) &&
      dist <= 3 &&
      getQty(activeInv(), "bow_and_arrow") > 0;

    if (canShoot || isAdjacentOrSame(pl.x, pl.y, x, y)) {
      openMenuForTile(x, y, e.clientX, e.clientY);
      return;
    }
  }

  // water tile interaction (fill bucket) (ONLY if no object handled it)
  const t = tileAt(x, y);
  if (t === "water") {
    const pl = activePlayer();
    if (isAdjacentOrSame(pl.x, pl.y, x, y)) {
      openMenuForWaterTile(x, y, e.clientX, e.clientY);
      return;
    }
  }
  
// --- Interior door tile: context menu to Exit ---
if (state.mode === "interior") {
  const pl = activePlayer();
  const idef = state.data.interiors?.[state.interiorId];
  const doorTile = idef?.doorTile;
  const t2 = tileAt(x, y);

  if (doorTile && t2 === doorTile && isAdjacentOrSame(pl.x, pl.y, x, y)) {
    openMenu({
      screenX: e.clientX,
      screenY: e.clientY,
      title: "Door",
      options: [
        {
          label: "Exit",
          action: withSfx("door_open", () => {
            tryExitInterior();
            closeMenu();
          })
        }
      ]
    });
    return;
  }
}
  setPathTo(x, y);
});

// Right click: inventory context menu OR quick-harvest on map
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();

  const { px, py } = pointerPos(e);

  // --- Inventory right-click stays the same ---
  if (isInInventoryArea(py)) {
    const idx = invIndexAtScreen(px, py);
    if (idx < 0) return;

    const inv = activeInv();
    if (!inv[idx]) return;

    openMenuForInventoryItem(idx, px, py);
    return;
  }

  // --- World right-click: quick harvest/hunt (bypass context menu) ---

  // Don’t let right-click interact through overlays/menus
  if (state.coordsOpen || state.stockpileOpen) return;
  if (state.menu) closeMenu();

  // Hard rule: log area is never a map click.
  if (isInActivityLog(px, py)) return;

  // Outside world rectangle = no map interaction.
  if (!isInWorldBounds(px, py)) return;

  const { x, y } = screenToMap(px, py);

  const obj = objectAt(x, y);
  if (!obj) return;

  const def = objDef(obj.id);
  if (!def) return;

  const p = activePlayer();
  const inv = activeInv();
  const dist = manhattan(p.x, p.y, x, y);

  // Dropped item: adjacent-only pickup (matches your menu logic)
  if (obj.id === "dropped_item") {
    if (!isAdjacentOrSame(p.x, p.y, x, y)) return;

    const itemId = obj.meta?.itemId;
    const qty = obj.meta?.qty ?? 1;
    if (!itemId) return;

    playSound("pickup");
    addItem(inv, itemId, qty);

    const name = itemDef(itemId)?.name ?? itemId;
    getCurrentMap().objects[y][x] = null;
    logAction(`${p.name} picked up ${qty} ${name}${qty === 1 ? "" : "s"}.`);
    return;
  }

  // Pickup-able world object (sticks, stones, etc.): adjacent-only
  if (def.pickup) {
    if (!isAdjacentOrSame(p.x, p.y, x, y)) return;
    playSound("pickup");
    pickupObject(x, y);
    return;
  }

  // Harvest / Hunt quick action
  const interact = def.hunt || def.harvest;
  if (!interact) return;

  // Renewable-but-depleted objects stay but don't harvest
  if (obj.meta?.depleted) return;

  const isHuntable = isHuntableDef(def);
  const hasBow = getQty(inv, "bow_and_arrow") > 0;
  const allowRangedHunt = isHuntable && hasBow && dist <= 3;
  const allowAdjacent = isAdjacentOrSame(p.x, p.y, x, y);

  if (!allowRangedHunt && !allowAdjacent) return;

  // Tool gate for quick-harvest: don't play SFX (or harvest) if tool is missing
  const requiredTool = interact.requiresTool || null;
  if (!isHuntable && requiredTool && !hasTool(inv, requiredTool)) return;

  let sfx = "harvest";
  if (isHuntable) sfx = "hunt";
  else {
if (/^tree\d+$/.test(obj.id)) sfx = "chop";
else if (obj.id === "apple_tree") sfx = "harvest";
    else if (["rock", "stone", "ore"].includes(obj.id)) sfx = "pickaxe";
    else if (["bush", "berry_bush"].includes(obj.id)) sfx = "harvest";
    else if (obj.id === "fish_spot") sfx = "fishingreel";
    else if (obj.id === "cow") sfx = "cow";
  }

  playSound(sfx);
  harvestObject(x, y);
});

// Keyboard controls
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();

if (state.craftingOpen) {
  if (k === "c") {
    e.preventDefault();
    attemptManualCraft();
    return; // IMPORTANT: stop here so nothing else runs
  }
  if (k === "escape") {
    e.preventDefault();
    closeCraftingScreen();
    return;
  }
}

if (k === "r") {
  const pl = activePlayer();

  if (!pl.resting) {
    pl.resting = true;
    pl.path = [];
    logAction(`${pl.name} started resting.`);
  } else {
    pl.resting = false;
    logAction(`${pl.name} stopped resting.`);
  }

  closeMenu();
}

  if (k === "b") {
    state.placinghouse = true;
    state.placingStockpile = false;
    closeMenu();
  }
  
// F = recenter camera on active player
if (k === "f") {
  const pl = activePlayer();
  recenterCameraOnPlayer(pl);
  return;
}

  if (k === "m") {
    state.coordsOpen = !state.coordsOpen;
    state.stockpileOpen = null;
    closeMenu();
  }

// DEV: Shift+I = enter/exit interior instantly (testing)
if (k === "i" && e.shiftKey) {
  e.preventDefault();

  if (state.mode !== "interior") {
    devEnterInterior("house_small"); // change id if you want
  } else {
    state.mode = "overworld";
    closeMenu();
    logAction("DEV: exited interior.");
  }
  return;
}

// DEV: Shift+D = enter nearest dungeon instantly (testing)
if (k === "d" && e.shiftKey) {
  e.preventDefault();
  devEnterNearestDungeon();
  return;
}

// E = Eat selected inventory item (only if it has nourishment)
if (k === "e") {
  const idx = state.selectedInvIdx;
  if (idx == null) return;

  const inv = activeInv();
  const st = inv[idx];
  if (!st) return;

  const def = itemDef(st.id);
  if (!def || typeof def.nourishment !== "number") return;

  eatItem(st.id, 1); // your existing eat logic handles hunger + remove + log/sfx
  return;
}

// X = drop 1 of selected inventory item
if (k === "x") {
  const idx = state.selectedInvIdx;
  if (idx == null) return;

  const inv = activeInv();
  const st = inv[idx];
  if (!st) return;

  const p = activePlayer();
  const name = itemDef(st.id)?.name ?? st.id;

  const spot = findDropSpotNear(p.x, p.y, st.id, 4);
  if (!spot) {
    playSound("deny");
    logAction(`${p.name} had nowhere to drop ${name}.`);
    return;
  }

  // Drop exactly 1
  if (!removeItem(inv, st.id, 1)) return;

  dropItemOnTile(st.id, 1, spot.x, spot.y);

  playSound("pickup"); // swap sound if you want
  logAction(`${p.name} dropped 1 ${name} at (${spot.x},${spot.y}).`);
  return;
}

// ---- WASD Movement ----
const moveDir = {
  w: { dx: 0, dy: -1 },
  a: { dx: -1, dy: 0 },
  s: { dx: 0, dy: 1 },
  d: { dx: 1, dy: 0 }
};

if (moveDir[k]) {
  const { dx, dy } = moveDir[k];

  // ONLINE: server-authoritative movement
  if (state.net?.enabled) {
    sendNetInput({ type: "move", dx, dy });
    return;
  }

  // OFFLINE: keep existing local movement
  const p = activePlayer();
  const nx = p.x + dx;
  const ny = p.y + dy;

  if (canStep(p.x, p.y, nx, ny)) {
    p.resting = false;
    if (state.holdingHands) state.holdingHands.leader = state.activePlayer;
    p.path = [{ x: nx, y: ny }];
  }
}

});

// ------------------------------------------------------------------------ TIME FUNCTIONS ----

function seedGrowsToItemId(seedId) {
  // Convention: carrot_seeds -> carrot, tomato_seeds -> tomato, etc.
  if (typeof seedId !== "string") return null;
  if (!seedId.endsWith("_seeds")) return null;

  let base = seedId.slice(0, -"_seeds".length);

  // tiny plural/irregular helpers (adjust as your items demand)
  if (base === "pea") base = "peas";
  if (base === "grape") base = "grapes";

  // Only return it if the item actually exists
  return itemDef(base) ? base : null;
}

function plantSeedAtPlayerTile(seedId) {
  const p = activePlayer();
  const inv = activeInv();

  if (state.mode !== "overworld") {
    logAction(`${p.name} can't plant in here.`);
    return false;
  }

  if (tileAt(p.x, p.y) !== "grass") {
    logAction(`${p.name} can only plant on grass (for now).`);
    return false;
  }

  const map = getCurrentMap();
  if (map.objects?.[p.y]?.[p.x]) {
    logAction(`${p.name} can't plant here (tile occupied).`);
    return false;
  }

  const growsTo = seedGrowsToItemId(seedId);
  if (!growsTo) {
    logAction(`${p.name} can't plant that.`);
    return false;
  }

  if (!removeItem(inv, seedId, 1)) return false;

 map.objects[p.y][p.x] = {
  id: "planted_seed",
  hp: 1,
  meta: {
    seedId,
    plantedDay: state.time.day,

    // growth system
    progress: 0,        // 0..GROW_DAYS
    lost: 0,            // cumulative days "lost"
    wateredEver: false, // won't grow until first watering
    lastWaterDay: null, // day number last watered
    ready: false
  }
};

  logAction(`${p.name} planted ${itemDef(seedId)?.name ?? seedId}.`);
  return true;
}

function updateRenewablesOnNewDay() {
  if (state.mode !== "overworld") return;

  const map = state.world;
  if (!map?.objects) return;

  const today = state.time.day;

  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const obj = map.objects[y][x];
      if (!obj?.meta?.depleted) continue;

      const def = objDef(obj.id);
      if (!def || !isRenewableDef(def)) continue;

      const depletedDay = obj.meta.depletedDay;
      if (typeof depletedDay !== "number") continue;

      const daysGone = today - depletedDay;
      const waitDays = def.renewDays ?? RENEWABLE_RESPAWN_DAYS;

      if (daysGone >= waitDays) {
        obj.meta.depleted = false;
        delete obj.meta.depletedDay;
        obj.hp = def.hp ?? 1;
      }
    }
  }
}

function updatePlantsOnNewDay() {
  if (state.mode !== "overworld") return;

  const map = state.world;
  if (!map?.objects) return;

  const today = state.time.day;
  const yesterday = today - 1;

  let matured = 0;
  let died = 0;

  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const obj = map.objects[y][x];
      if (!obj || obj.id !== "planted_seed") continue;

      const m = obj.meta ?? (obj.meta = {});
      const plantedDay = m.plantedDay ?? today;
      const ageDays = today - plantedDay;

      // Hard fail-safe: if not adequately watered within 6 days, death.
      // (This includes never-watered seeds.)
      if (ageDays >= 6 && (m.progress ?? 0) < GROW_DAYS) {
        map.objects[y][x] = null;
        died++;
        continue;
      }

      // If never watered, it doesn't grow (but still ages toward the 6-day death rule above)
      if (!m.wateredEver) continue;

      const lastWater = m.lastWaterDay;

      // Watered yesterday → grow 1 day
      if (lastWater === yesterday) {
        m.progress = Math.min(GROW_DAYS, (m.progress ?? 0) + 1);
      } else {
        // Missed watering yesterday
        // - missed 1 day → halt (no change)
        // - missed 2+ days → lose days
        if (typeof lastWater === "number") {
          const missed = yesterday - lastWater; // 1 = missed 1 day, 2 = missed 2 days, etc.

          if (missed >= 2) {
            const loss = missed - 1; // 2 days missed => lose 1, 3 days missed => lose 2, etc.
            m.lost = (m.lost ?? 0) + loss;
            m.progress = Math.max(0, (m.progress ?? 0) - loss);

            // If it loses more days than it has been planted, it dies
            if ((m.lost ?? 0) > ageDays) {
              map.objects[y][x] = null;
              died++;
              continue;
            }
          }
        }
      }

      // Ready to harvest once progress hits target
      if ((m.progress ?? 0) >= GROW_DAYS) {
        m.ready = true;
        matured++;
      }
    }
  }

  if (died > 0) logAction(`${died} plant${died === 1 ? "" : "s"} died.`);
  if (matured > 0) logAction(`${matured} plant${matured === 1 ? "" : "s"} ready to harvest.`);
}

function updateTreeRegrowthOnNewDay() {
  if (state.mode !== "overworld") return;

  const map = state.world;

  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const obj = map.objects[y][x];
      if (!obj || obj.id !== "stump" && obj.id !== "stump_seedling") continue;

      const meta = (obj.meta ||= {});
      const age = state.time.day - (meta.regrowDay ?? state.time.day);

      // ---- Stage 1: stump → stump_seedling ----
      if (obj.id === "stump" && age >= TREE_REGROW_DAYS_STAGE1) {
        obj.id = "stump_seedling";
        meta.regrowStage = "seedling";
        meta.regrowDay = state.time.day;
        continue;
      }

      // ---- Stage 2: seedling → original tree ----
      if (obj.id === "stump_seedling" && age >= (TREE_REGROW_DAYS_STAGE2 - TREE_REGROW_DAYS_STAGE1)) {
        obj.id = meta.originalTree || "tree1";
        delete obj.meta;
      }
    }
  }
}

function updateChickenEggsOnNewDay() {
  if (state.mode !== "overworld") return;

  const map = state.world;
  const { w, h } = currentDims();

  // Tweakables:
  const EGG_CHANCE_PER_CHICKEN = 0.55; // 55% chance each chicken lays an egg each day
  const EGG_OBJECT_ID = "egg_pickup";

  let dropped = 0;

  // helper: list of nearby tiles to try (randomized)
  const offsets = [
    [0, 1], [1, 0], [0, -1], [-1, 0],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ].sort(() => Math.random() - 0.5);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const obj = map.objects?.[y]?.[x];
      if (!obj || obj.id !== "chicken") continue;

      // Ensure meta exists
      obj.meta = obj.meta || {};

      // Already handled today? (belt + suspenders)
      if (obj.meta.lastEggDay === state.time.day) continue;
      obj.meta.lastEggDay = state.time.day;

      // Random chance this chicken lays today
      if (Math.random() > EGG_CHANCE_PER_CHICKEN) continue;

      // Find an empty neighboring tile (walkable, not water, no object, no player)
      let placed = false;
      for (const [dx, dy] of offsets) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny, w, h)) continue;

        if (map.tiles?.[ny]?.[nx] === "water") continue;
        if (map.objects?.[ny]?.[nx]) continue;
        if (state.players.some(p => p.x === nx && p.y === ny)) continue;

        map.objects[ny][nx] = { id: EGG_OBJECT_ID, hp: 1, meta: {} };
        dropped++;
        placed = true;
        break;
      }

      // If it couldn't find space, it just doesn't drop today. Chickens are rude like that.
      if (!placed) continue;
    }
  }

  if (dropped > 0) logAction(`Chickens laid ${dropped} egg${dropped === 1 ? "" : "s"}.`);
}

function updateTime(dt) {
 // Don't advance time until the player actually starts the game
  if (state.title?.open || state.tutorial?.open) return;

  const t = state.time;

  t.t += dt;
  t.phaseT += dt;

  const wasDay = t.isDay;
  t.isDay = t.phaseT < DAYLIGHT_SECONDS;

  // Day/night transition sound
  if (t.isDay !== wasDay) {
    playSound(t.isDay ? "day" : "night");
  }

  if (t.phaseT >= DAY_SECONDS) {
  t.phaseT -= DAY_SECONDS;
  t.day += 1;
  updatePlantsOnNewDay();
  updateTreeRegrowthOnNewDay();
  updateRenewablesOnNewDay();
  updateChickenEggsOnNewDay();
}
}

function advanceTimeSeconds(secs) {
  // Keep behavior consistent with updateTime(dt)
  if (state.title?.open || state.tutorial?.open) return;

  const t = state.time;
  if (!t) return;

  // Track day/night change
  const wasDay = t.isDay;

  t.t += secs;
  t.phaseT += secs;

  // Handle day rollover(s) and run "new day" systems exactly like updateTime
  while (t.phaseT >= DAY_SECONDS) {
    t.phaseT -= DAY_SECONDS;
    t.day += 1;
    updatePlantsOnNewDay();
    updateTreeRegrowthOnNewDay();
    updateRenewablesOnNewDay();
    updateChickenEggsOnNewDay();
  }

  // Recompute day/night after final phaseT
  t.isDay = t.phaseT < DAYLIGHT_SECONDS;

  // Transition sound (same as updateTime)
  if (t.isDay !== wasDay) {
    playSound(t.isDay ? "day" : "night");
  }
}

function startScreenFadeToBlackThenBack(opts = {}) {
  const outSec = opts.outSec ?? 0.35;
  const holdSec = opts.holdSec ?? 0.10;
  const inSec = opts.inSec ?? 0.35;
  const onMid = typeof opts.onMid === "function" ? opts.onMid : null;

  state.screenFade = {
    active: true,
    phase: "out",      // "out" -> "hold" -> "in"
    t: 0,
    alpha: 0,
    outSec, holdSec, inSec,
    didMid: false,
    onMid
  };
}

function updateScreenFade(dt) {
  const f = state.screenFade;
  if (!f?.active) return;

  f.t += dt;

  if (f.phase === "out") {
    f.alpha = clamp(f.t / f.outSec, 0, 1);
    if (f.t >= f.outSec) {
      // Midpoint action happens at full black
      if (!f.didMid) {
        f.didMid = true;
        try { f.onMid && f.onMid(); } catch (e) { console.error(e); }
      }
      f.phase = "hold";
      f.t = 0;
      f.alpha = 1;
    }
    return;
  }

  if (f.phase === "hold") {
    f.alpha = 1;
    if (f.t >= f.holdSec) {
      f.phase = "in";
      f.t = 0;
    }
    return;
  }

  if (f.phase === "in") {
    f.alpha = 1 - clamp(f.t / f.inSec, 0, 1);
    if (f.t >= f.inSec) {
      state.screenFade = null;
    }
  }
}

function drawScreenFadeOverlay() {
  const f = state.screenFade;
  if (!f?.active) return;
  drawRect(0, 0, window.innerWidth, window.innerHeight, `rgba(0,0,0,${f.alpha})`);
}

function sleepInBed() {
  // Don’t stack sleeps like some kind of cursed time machine
  if (state.screenFade?.active) return;

  const p = activePlayer();

  startScreenFadeToBlackThenBack({
    outSec: 0.45,
    holdSec: 0.15,
    inSec: 0.45,
    onMid: () => {
      // 50% of *current* day length, automatically scales if you change DAY_SECONDS
      advanceTimeSeconds(DAY_SECONDS * 0.50);

      // Full stamina
      p.stamina = STAMINA_MAX;
      p.resting = false;
      p.path = [];

      logAction(`${p.name} slept. Stamina fully restored. (+50% day)`);
    }
  });
}

function drawNightOverlay() {
  if (!state.time || state.time.isDay) return;
if (state.mode === "interior") return;

  // Darken the world area (leave top bar + bottom UI readable)
  const y = UI_TOP_H;
  const h = window.innerHeight - UI_TOP_H - UI_BOTTOM_H;
  if (h <= 0) return;

  drawRect(0, y, window.innerWidth, h, "rgba(0,0,0,0.45)");
}

// ------------------------------------------------------------------------ Main loop & Render ----
function update(dt) {
	netTick();
  // Always update title/menu/cutscene stuff first so clicks work even before world arrives.
  updateTitleMenu(dt);
  updateScreenFade(dt);
  updateMusic(dt);

  // Multiplayer boot: don't run overworld sim until server world arrives
  // (but DO allow title/menu to function above)
  if (state.mode === "overworld" && !overworldReady()) return;

  updateTime(dt);
  updatePlayers(dt);
  updateAnimals(dt);
  updateSpawns(dt);
  updateCampfires(dt);
  updateBuildTimers(dt);
}

// --- Draw function ----
function render() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  setChatInputVisible(!state.title?.open);

if (state.cutscene?.open) drawCutscene();

if (state.tutorial?.open) {
  drawTutorial();
  return;
}

// Cutscene overlay: draw it and STOP. Otherwise title UI draws over it.
if (state.cutscene?.open) {
  drawCutscene();
  return;
}

  // If title is open, render ONLY the title screen (no world behind it)
  if (state.title?.open) {
    drawTitleMenu();
    return;
  }

  drawTopBar();
  drawWorld();
  drawLeftSidebar();
  drawSpeechBubbles();
  drawNightOverlay();
  drawInventoryUI();
  drawChatLog();
  drawMenu();
  drawRunestoneReader();
  drawRuneComboLockModal();
  drawInteractionRequestDialog();
  drawCraftingPopup();
  drawSettingsModal();
  drawConstructionUI();
  drawScreenFadeOverlay();
}

function loop(now) {
  const dt = Math.min(0.05, (now - state._lastTime) / 1000);
  state._lastTime = now;

  update(dt);
  render();

  requestAnimationFrame(loop);
}

function isSpawnableTile(map, x, y, occupied) {
  const h = map?.tiles?.length ?? 0;
  const w = map?.tiles?.[0]?.length ?? 0;
  if (x < 0 || y < 0 || x >= w || y >= h) return false;

  if (map.tiles[y][x] === "water") return false;
  if (map.objects?.[y]?.[x]) return false;
  if (occupied.has(`${x},${y}`)) return false;

  return true;
}

function findNearestSpawn(map, sx, sy, occupied) {
  const h = map?.tiles?.length ?? 0;
  const w = map?.tiles?.[0]?.length ?? 0;

  const q = [[sx, sy]];
  const seen = new Set([`${sx},${sy}`]);

  while (q.length) {
    const [x, y] = q.shift();
    if (isSpawnableTile(map, x, y, occupied)) return [x, y];

    const nb = [
      [x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1],
      [x + 1, y + 1], [x - 1, y + 1], [x + 1, y - 1], [x - 1, y - 1]
    ];

    for (const [nx, ny] of nb) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      seen.add(key);
      q.push([nx, ny]);
    }
  }

  return [1, 1];
}

function ensurePlayersNotOnWater(map) {
  const occupied = new Set();

  for (const p of state.players) {
    if (!isSpawnableTile(map, p.x, p.y, occupied)) {
      const [nx, ny] = findNearestSpawn(map, p.x, p.y, occupied);
      p.x = p.fx = nx;
      p.y = p.fy = ny;
    }
    occupied.add(`${p.x},${p.y}`);
  }
}

// ---- Boot ----
async function boot() {
  const [tiles, objects, items, recipes, buildings, interiors] = await Promise.all([
    loadJSON("./src/data/tiles.json"),
    loadJSON("./src/data/objects.json"),
    loadJSON("./src/data/items.json"),
    loadJSON("./src/data/recipes.json"),
    loadJSON("./src/data/buildings.json"),
    loadJSON("./src/data/interiors.json"),
  ]);

  state.data = {
    tiles: Object.fromEntries(tiles.map(x => [x.id, x])),
    objects: Object.fromEntries(objects.map(x => [x.id, x])),
    items: Object.fromEntries(items.map(x => [x.id, x])),
    recipes: Object.fromEntries(recipes.map(x => [x.id, x])),
    buildings: Object.fromEntries(buildings.map(x => [x.id, x])),
    interiors: Object.fromEntries(interiors.map(x => [x.id, x])),
  };

  // Build a real overworld immediately so you can play offline AND not render a blank void.
  // (Server sync can come later; right now server only sends players anyway.)
  state.world = state.world || generateOverworld();

  state.interior = state.interior || generateInterior(state.interiorId);

  // Make sure players don’t start in water / invalid tiles.
  ensurePlayersNotOnWater(state.world);

  // Actually connect to the co-op server (this used to run only on boot failure... lol).
  connectOnline("ws://localhost:8081");

  // camera start
  state.cam.x = 0;
  state.cam.y = 0;
  clampCamera();

  // Starter inventories: toolkit only
  addItem(state.inventories[0], "toolkit", 1);
  addItem(state.inventories[1], "toolkit", 1);

  // reveal initial fog
  revealAroundPlayers();
  ensureChatInput();
  requestAnimationFrame(loop);
}

boot().catch(err => {
  console.error(err);
  alert(err.message);
 
});
