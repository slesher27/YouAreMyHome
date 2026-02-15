// src/main.js
const TILE_SIZE = 48;

// Overworld dimensions
const WORLD_W = 40;
const WORLD_H = 30;

// Interior dimensions
const INTERIOR_W = 12;
const INTERIOR_H = 8;

// Fog of war visibility radius (1 => 3x3 around each player)
const VIS_RADIUS = 1;

// Inventory UI
const INV_COLS = 12;
const INV_ROWS = 2;
const INV_SLOTS = INV_COLS * INV_ROWS;

// UI sizes
const UI_TOP_H = 58;        // room for stamina bar
const UI_BOTTOM_H = 230;    // inventory + crafting + misc

// Pointer drag threshold
const DRAG_THRESHOLD_PX = 8;

// Movement + stamina
const MOVE_SPEED_TILES_PER_SEC = 6;
const STAMINA_MAX = 100;
const STAMINA_COST_PER_TILE = 2.0;
const REST_REGEN_PER_SEC = 12.0;

// Double click threshold
const DOUBLE_CLICK_MS = 350;

async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return await res.json();
}

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

// -------------------------------------------------------------------------- State ----
const state = {
  mode: "overworld", // "overworld" | "interior"
  data: null,

  world: null,    // { tiles, objects, explored:boolean[][] }
  interior: null, // { tiles, objects }
  interiorId: "cabin_small",

actionLog: [],
logScroll: 0,

buildProjects: {},   // key: "x,y" → { stage, progress }

  players: [
    {
      id: "p1", name: "Scott", x: 2, y: 2, fx: 2, fy: 2,
      icon: "🧍‍♂️",
      path: [],
      stamina: STAMINA_MAX,
      resting: false
    },
    {
      id: "p2", name: "Cristina", x: 3, y: 2, fx: 3, fy: 2,
      icon: "🧍‍♀️",
      path: [],
      stamina: STAMINA_MAX,
      resting: false
    }
  ],
  activePlayer: 0,

  // Per-player inventories: array of stacks {id, qty}
  inventories: [[], []],

  // Structures in overworld (stockpiles etc)
  structures: {
    stockpiles: [], // { key, x, y, inv:[] }
    houses: []      // { key, x, y, label }
  },

  // Saved coordinate markers
  markers: [], // { label, x, y, type: "house"|"stockpile"|"marker" }

  // Camera top-left in tile coords
  cam: { x: 0, y: 0 },

  // Input drag tracking
  pointer: {
    down: false,
    dragging: false,
    startX: 0, startY: 0,
    lastX: 0, lastY: 0
  },

  // Context menu
  menu: null, // { screenX, screenY, title, options:[...], hoverIndex:-1 }

  // Modal dialogs
  coordsOpen: false,     // saved coordinates modal
  stockpileOpen: null,   // { key } if stockpile UI open

  // Crafting
// Crafting
craftingOpen: false,
craftingMode: null,   // "craft" | "cook"
selectedForCraft: new Set(),
learnedRecipes: new Set(),
hoveredUI: null,

  // Placement modes
  placingCabin: false,
  placingStockpile: false,

  // Double click tracking
  lastInvClick: { idx: -1, t: 0 },

  // Loop timing
  _lastTime: performance.now()
};

// ---- Log Actions ----
function logAction(text) {
  state.actionLog.unshift(text);
  if (state.actionLog.length > 50) state.actionLog.pop();
}

// ---- Resize -----------------------------------------------------------------------------------------------
function resize() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

// ---- Helpers ----
function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function inBounds(x, y, w, h) { return x >= 0 && y >= 0 && x < w && y < h; }

function neighbors4(x, y) {
  return [[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
}

function currentDims() {
  return state.mode === "overworld"
    ? { w: WORLD_W, h: WORLD_H }
    : { w: INTERIOR_W, h: INTERIOR_H };
}

function getCurrentMap() {
  return state.mode === "overworld" ? state.world : state.interior;
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
function objDef(objId) { return state.data.objects[objId]; }

function getQty(inv, itemId) {
  const s = inv.find(st => st.id === itemId);
  return s ? s.qty : 0;
}

function hasTool(inv, toolId) { return getQty(inv, toolId) > 0; }

function isWalkableTile(tileId) {
  const t = state.data.tiles[tileId];
  return !!t && t.walkable === true;
}

function objectBlocks(objId) {
  const d = objDef(objId);
  return d?.blocks === true;
}

function addItem(inv, itemId, qty) {
  const def = itemDef(itemId);
  if (!def) return { ok: false, reason: `Unknown item: ${itemId}` };
  const maxStack = def.stack ?? 99;

  // If stack exists, fill it
  let stack = inv.find(s => s.id === itemId);
  if (stack) {
    const space = maxStack - stack.qty;
    const add = Math.min(space, qty);
    stack.qty += add;
    qty -= add;
    if (qty <= 0) return { ok: true };
    return { ok: false, reason: `Stack full (${maxStack})` };
  }

  // Need a new slot
  if (inv.length >= INV_SLOTS) return { ok: false, reason: "Inventory full" };
  inv.push({ id: itemId, qty: Math.min(maxStack, qty) });
  qty -= Math.min(maxStack, qty);
  if (qty > 0) return { ok: false, reason: `Stack cap (${maxStack})` };
  return { ok: true };
}

function removeItem(inv, itemId, qty) {
  const stack = inv.find(s => s.id === itemId);
  if (!stack || stack.qty < qty) return false;
  stack.qty -= qty;
  if (stack.qty <= 0) inv.splice(inv.indexOf(stack), 1);
  return true;
}

function isAdjacentOrSame(ax, ay, bx, by) {
  return (ax === bx && ay === by) || (Math.abs(ax - bx) + Math.abs(ay - by) === 1);
}

// ---- Camera math ----------------------------------------------------------------------------------------
function viewTiles() {
  // Reserve space for right-side log panel and bottom UI bar
  const LOG_PANEL_W = 440;  // matches log width + padding
  const SAFE_PAD = 16;

  const usableW = window.innerWidth - LOG_PANEL_W - SAFE_PAD;
  const usableH = window.innerHeight - UI_TOP_H - UI_BOTTOM_H;

  const viewW = Math.floor(usableW / TILE_SIZE);
  const viewH = Math.floor(usableH / TILE_SIZE);

  return {
    viewW: Math.max(6, viewW),
    viewH: Math.max(6, viewH)
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
  const localY = py - UI_TOP_H;
  const x = Math.floor(px / TILE_SIZE) + state.cam.x;
  const y = Math.floor(localY / TILE_SIZE) + state.cam.y;
  return { x, y };
}

function mapToScreen(x, y) {
  const sx = (x - state.cam.x) * TILE_SIZE;
  const sy = UI_TOP_H + (y - state.cam.y) * TILE_SIZE;
  return { sx, sy };
}

// --------------------------------------------------------------------------------------- SOUND FX ----
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

function withSfx(sfxName, fn) {
  return () => {
    if (sfxName) playSound(sfxName);
    return fn();
  };
}

function playFootstep() {
  const steps = ["footstepsoutdoor1", "footstepsoutdoor2", "footstepsoutdoor3", "footstepsoutdoor4", "footstepsoutdoor5", "footstepsoutdoor6", "footstepsoutdoor7", "footstepsoutdoor8", "footstepsoutdoor9", "footstepsoutdoor10"];
  playSound(steps[Math.floor(Math.random() * steps.length)]);
}

loadSound("chop", "chop_wood.MP3", 0.6);
loadSound("chest", "chest.mp3", 0.6);
loadSound("pickup", "collect.mp3", 0.5);
loadSound("cook", "cook.mp3", 0.6);
loadSound("cow", "cow.mp3", 0.6);
loadSound("fishingreel", "fishing_reel.mp3", 0.5);
loadSound("hammer", "hammer.mp3", 0.7);
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
loadSound("achievement", "achievement.mp3", 0.5);
loadSound("hunt", "arrow.mp3", 0.5);
loadSound("fillwater", "fill_water.mp3", 0.5);
loadSound("fireburning", "fire.mp3", 0.5);
loadSound("lightfire", "fire_start.mp3", 0.5);
loadSound("extinguish", "extinguish.mp3", 0.5);


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
  placeObjects(map, WORLD_W, WORLD_H, "tree1", ["grass"], 70);
  placeObjects(map, WORLD_W, WORLD_H, "tree2", ["grass"], 70);
  placeObjects(map, WORLD_W, WORLD_H, "rock", ["grass", "sand"], 35);
  placeObjects(map, WORLD_W, WORLD_H, "bush", ["grass"], 70);
  placeObjects(map, WORLD_W, WORLD_H, "apple_tree", ["grass"], 20);
  placeObjects(map, WORLD_W, WORLD_H, "berry_bush", ["grass"], 50);
  placeObjects(map, WORLD_W, WORLD_H, "wheat", ["grass"], 50);

  // free pickups
  placeObjects(map, WORLD_W, WORLD_H, "stick_pickup", ["grass", "sand"], 60);
  placeObjects(map, WORLD_W, WORLD_H, "pebble_pickup", ["grass", "sand"], 60);
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

function generateInterior(interiorId) {
  const def = state.data.interiors[interiorId];
  const map = emptyMap(INTERIOR_W, INTERIOR_H, def.floorTile);

  // walls border
  for (let x = 0; x < INTERIOR_W; x++) {
    map.tiles[0][x] = def.wallTile;
    map.tiles[INTERIOR_H - 1][x] = def.wallTile;
  }
  for (let y = 0; y < INTERIOR_H; y++) {
    map.tiles[y][0] = def.wallTile;
    map.tiles[y][INTERIOR_W - 1] = def.wallTile;
  }

  // door at bottom middle
  map.tiles[INTERIOR_H - 1][Math.floor(INTERIOR_W / 2)] = def.doorTile;

  // starter storage chest inside
  map.objects[2][2] = { id: "storage_chest", hp: 999, meta: {} };

  return map;
}

// --------------------------------------------------------------------------------- Fog of war ----
function revealAroundPlayers() {
  if (state.mode !== "overworld") return;
  const exp = state.world.explored;

  for (const pl of state.players) {
    for (let dy = -VIS_RADIUS; dy <= VIS_RADIUS; dy++) {
      for (let dx = -VIS_RADIUS; dx <= VIS_RADIUS; dx++) {
        const x = pl.x + dx;
        const y = pl.y + dy;
        if (inBounds(x, y, WORLD_W, WORLD_H)) exp[y][x] = true;
      }
    }
  }
}

// --------------------------------------------------------------------------------- Passability ----
function isPassable(x, y) {
  const { w, h } = currentDims();
  if (!inBounds(x, y, w, h)) return false;

  const t = tileAt(x, y);
  if (!isWalkableTile(t)) return false;

  const obj = objectAt(x, y);
  if (obj) {
    const d = objDef(obj.id);
    if (d?.blocks) return false;
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
      if (!isPassable(nx, ny)) continue;

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

  // movement interrupts resting
  p.resting = false;

  if (!inBounds(x, y, currentDims().w, currentDims().h)) return;

  // If clicked impassable tile, still path to nearest reachable
  const path = findPathBFS({ x: p.x, y: p.y }, { x, y });
  p.path = path;
}

// --------------------------------------------------------------------------- Stamina + movement update ----
function consumeStaminaForTile(pl) {
  pl.stamina = Math.max(0, pl.stamina - STAMINA_COST_PER_TILE);
}

function updatePlayers(dt) {
  for (const pl of state.players) {
    // Rest regen
    if (pl.resting && pl.path.length === 0) {
      pl.stamina = Math.min(STAMINA_MAX, pl.stamina + REST_REGEN_PER_SEC * dt);
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
        pl.fx = next.x;
        pl.fy = next.y;
        pl.x = next.x;
        pl.y = next.y;
        pl.path.shift();

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

  const pName = activePlayer().name;

  // Give loot
  for (const [itemId, amt] of Object.entries(interact.gives || {})) {
    addItem(inv, itemId, amt);

    const itemName = itemDef(itemId)?.name ?? itemId;

    if (itemId === "fish") {
  logAction(`${pName} caught a fish!`);
} else if (def.hunt) {
  logAction(`${pName} hunted ${amt} ${itemName}${amt === 1 ? "" : "s"}!`);
} else {
  logAction(`${pName} harvested ${amt} ${itemName}${amt === 1 ? "" : "s"}!`);
}
  } 

  // Damage / remove object (run ONCE per harvest, not per item)
  obj.hp = (obj.hp ?? 1) - 1;

  if (obj.hp <= 0) {
    if (isRenewableDef(def)) {
      obj.hp = 0;
      obj.meta = obj.meta || {};
      obj.meta.depleted = true;   // stays on map, but marked depleted
    } else {
      map.objects[y][x] = null;   // normal behavior
    }
  }

  closeMenu();
} 


function chopDownObject(x, y) {
  const map = getCurrentMap();
  const obj = map.objects?.[y]?.[x];
  if (!obj) return;

  const def = objDef(obj.id);
  if (!def) return;

  const inv = activeInv();
  if (!hasTool(inv, "axe")) return;

  // Only for the “anti-softlock” blockers you listed
  const choppable = new Set(["bush", "berry_bush", "apple_tree"]);
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


function pickupObject(x, y) {
  const map = getCurrentMap();
  const obj = map.objects[y][x];
  if (!obj) return;

  const def = objDef(obj.id);
  if (!def?.pickup) return;

  const pName = activePlayer().name;

  for (const [itemId, amt] of Object.entries(def.pickup.gives)) {
    addItem(activeInv(), itemId, amt);
    playSound("pickup");

    const itemName = itemDef(itemId)?.name ?? itemId;
    logAction(`${pName} picked up ${amt} ${itemName}${amt === 1 ? "" : "s"}!`);
  }

  map.objects[y][x] = null;
  closeMenu();
}

function toolboxLoot(inv, amount = 1) {
  const pName = activePlayer().name;

  playSound("chest");
  logAction(`${pName} opened a toolbox.`);

  // Same pool you used for chest tools (adjust as you want)
  const tools = ["axe", "hammer", "pickaxe", "fishing_pole", "matches", "saw", "knife", "bow_and_arrow", "bucket"];

  for (let i = 0; i < amount; i++) {
    const toolId = tools[randInt(0, tools.length - 1)];
    addItem(inv, toolId, 1);

    const toolName = itemDef(toolId)?.name ?? toolId;

    // Article handling (a/an). Your log renderer also fixes "an Hammer" later,
    // but let's not rely on duct tape if we don't have to.
    const startsWithVowel = /^[aeiou]/i.test(toolName);
    const article = startsWithVowel ? "an" : "a";

    logAction(`${pName} found ${article} ${toolName}!`);
  }
}

function chestLoot(inv) {
  const pName = activePlayer().name;

  // Always log that a chest was opened (this is an action)
  playSound("chest");
  logAction(`${pName} opened a chest.`);

  const tools = ["axe", "hammer", "pickaxe", "fishing_pole", "matches", "saw", "bucket"];

  const hasCabinBlueprint = getQty(inv, "blueprint_cabin") > 0;
  const pieces = getQty(inv, "blueprint_piece");

  // Main loot roll
  const roll = Math.random();
  if (!hasCabinBlueprint && pieces < 6 && roll < 0.65) {
    addItem(inv, "blueprint_piece", 1);
    logAction(`${pName} found a blueprint piece!`);
  } else {
    const tool = tools[randInt(0, tools.length - 1)];
    addItem(inv, tool, 1);
    logAction(`${pName} found an ${itemDef(tool)?.name ?? tool}!`);
  }

  // Extra small loot (log each if it happens)
  if (Math.random() < 0.35) {
    const amt = randInt(1, 3);
    addItem(inv, "stick", amt);
    logAction(`${pName} found ${amt} ${itemDef("stick")?.name ?? "stick"}${amt === 1 ? "" : "s"}!`);
  }

  if (Math.random() < 0.25) {
    const amt = randInt(1, 4);
    addItem(inv, "pebble", amt);
    logAction(`${pName} found ${amt} ${itemDef("pebble")?.name ?? "pebble"}${amt === 1 ? "" : "s"}!`);
  }

  // Auto-assemble blueprint at 6 pieces
  const newPieces = getQty(inv, "blueprint_piece");
  if (newPieces >= 6 && getQty(inv, "blueprint_cabin") === 0) {
    removeItem(inv, "blueprint_piece", 6);
    addItem(inv, "blueprint_cabin", 1);
    playSound("achievement");
    logAction(`${pName} assembled a Cabin Blueprint!`);
  }
}

function openContainerObject(x, y) {
  if (state.mode !== "overworld") return;

  const obj = state.world.objects[y][x];
  if (!obj) return;

  const def = objDef(obj.id);
  if (!def?.container) return;

  if (obj.id === "chest") {
    chestLoot(activeInv());
    state.world.objects[y][x] = null;
    closeMenu();
    return;
  }

  if (obj.id === "stockpile") {
    // open stockpile transfer modal
    state.stockpileOpen = { key: obj.meta?.key };
    closeMenu();
    return;
  }

  if (obj.id === "toolbox") {
    const amount = def.container?.amount ?? 1; // pulls from your JSON
    toolboxLoot(activeInv(), amount);
    state.world.objects[y][x] = null; // consume toolbox like chest
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

  // "random tools" but ensure players don’t start identical
  if (state.activePlayer === 0) {
    addItem(inv, "axe", 1);
    logAction(`${pName} got an ${itemDef("axe")?.name ?? "axe"}!`);

    addItem(inv, "hammer", 1);
    logAction(`${pName} got a ${itemDef("hammer")?.name ?? "hammer"}!`);
  } else {
    addItem(inv, "pickaxe", 1);
    logAction(`${pName} got a ${itemDef("pickaxe")?.name ?? "pickaxe"}!`);

    addItem(inv, "fishing_pole", 1);
    logAction(`${pName} got a ${itemDef("fishing_pole")?.name ?? "fishing pole"}!`);
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
  if (def?.type !== "house_door") return;

  state.interiorId = obj.meta?.interiorId || "cabin_small";
  state.interior = generateInterior(state.interiorId);
  state.mode = "interior";

  // place players near interior door
  state.players[0].x = 2; state.players[0].y = INTERIOR_H - 2; state.players[0].fx = 2; state.players[0].fy = INTERIOR_H - 2;
  state.players[1].x = 3; state.players[1].y = INTERIOR_H - 2; state.players[1].fx = 3; state.players[1].fy = INTERIOR_H - 2;

  state.cam.x = 0; state.cam.y = 0;
  clampCamera();
  closeMenu();
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
  // back to spawn for now
  state.players[0].x = 2; state.players[0].y = 2; state.players[0].fx = 2; state.players[0].fy = 2; state.players[0].path = [];
  state.players[1].x = 3; state.players[1].y = 2; state.players[1].fx = 3; state.players[1].fy = 2; state.players[1].path = [];

  clampCamera();
  closeMenu();
  return true;
}

// Cabin placement (placeholder construction)
function canBuildCabinNow() {
  const inv = activeInv();
  return getQty(inv, "blueprint_cabin") > 0 && getQty(inv, "hammer") > 0;
}

function placeCabinAt(x, y) {
  if (state.mode !== "overworld") return false;
  if (!canBuildCabinNow()) return false;

  // 2x2 footprint
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const tx = x + dx, ty = y + dy;
    if (!inBounds(tx, ty, WORLD_W, WORLD_H)) return false;
    if (!isPassable(tx, ty)) return false;
  }

  removeItem(activeInv(), "blueprint_cabin", 1);

  state.world.objects[y][x] = { id: "house_door", hp: 999, meta: { interiorId: "cabin_small" } };
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
    hoverIndex: -1
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

  options.push({
    label: "Place stockpile",
    action: () => {
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

function openMenuForTile(mapX, mapY, screenX, screenY) {
  const obj = objectAt(mapX, mapY);
  if (!obj) return;

  const p = activePlayer();
  const inv = activeInv();

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
        {
          label: `Pick up (${qty})`,
          disabledReason: tooFar ? "Too far" : null,
          action: withSfx("pickup", () => {
            if (tooFar) return;
            addItem(inv, itemId, qty);
            getCurrentMap().objects[mapY][mapX] = null;
            logAction(`${p.name} picked up ${qty} ${name}${qty === 1 ? "" : "s"}.`);
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

  if (!isAdjacentOrSame(p.x, p.y, mapX, mapY) && !allowRangedHunt) return;

  const options = [];

  // -------------------------------------------------------------------------------- Campfire menu ----
if (obj.id === "workbench") {
  options.push({
    label: "Craft",
    action: () => {
      openCraftingScreen("craft");
      closeMenu();
    }
  });
}

if (obj.id === "campfire") {
  options.push({
    label: "Cook",
    action: () => {
      openCraftingScreen("cook");
      closeMenu();
    }
  });

  options.push({
    label: "Extinguish",
    action: withSfx("extinguish", () => {
      state.world.objects[mapY][mapX] = null;
      logAction(`${activePlayer().name} extinguished the campfire at (${mapX},${mapY}).`);
      closeMenu();
    })
  });

  openMenu({ screenX, screenY, title: def.name, options });
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
  if (["tree1", "apple_tree", "tree2"].includes(obj.id)) sfx = "chop";
  else if (["rock", "stone", "ore"].includes(obj.id)) sfx = "pickaxe";
  else if (["bush", "berry_bush"].includes(obj.id)) sfx = "harvest";
  else if (obj.id === "fish_spot") sfx = "fishingreel";
  else if (obj.id === "cow") sfx = "cow";
}

options.push({
  label: isHuntable ? (dist <= 1 ? "Hunt" : "Hunt") : "Harvest resource",
  disabledReason,
  action: withSfx(sfx, () => {
    if (disabledReason) return;
    harvestObject(mapX, mapY);
    closeMenu();
  })
});

  }

  if (def.pickup) {
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

  if (def.type === "house_door") {
    options.push({
  label: "Enter",
  action: withSfx("door_open", () => tryEnterAt(mapX, mapY))
});

  }

  if (obj.id === "build_site" || obj.id === "framework") {
    options.push({
  label: "Contribute materials",
  action: withSfx("hammer", () => upgradeBuildSite(mapX, mapY))
});

  }

  if (options.length === 0) return;

  openMenu({ screenX, screenY, title: def.name, options });
}

// ------------------------------------------------------------------------------------ Crafting ----
function recipeList() { return Object.values(state.data.recipes); }

function canCraftRecipe(r) {
  const inv = activeInv();

  if (r.station) {
    const p = activePlayer();
    let ok = false;

    // include SAME tile + adjacent tiles
    const tilesToCheck = [[p.x, p.y], ...neighbors4(p.x, p.y)];

    for (const [nx, ny] of tilesToCheck) {
      const obj = objectAt(nx, ny);
      if (!obj) continue;
      const odef = objDef(obj.id);
      if (odef?.station === r.station) { ok = true; break; }
    }

    if (!ok) return { ok: false, reason: `Needs ${r.station}` };
  }

  if (r.requiresTool && !hasTool(inv, r.requiresTool)) {
    return { ok: false, reason: `Requires ${itemDef(r.requiresTool)?.name ?? r.requiresTool}` };
  }

  for (const [id, amt] of Object.entries(r.in)) {
    if (getQty(inv, id) < amt) return { ok: false, reason: "Missing items" };
  }
  return { ok: true };
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

  state.world.objects[p.y][p.x] = { id: "campfire", hp: 999 };

  playSound("lightfire");
  logAction(`${p.name} built a campfire at (${p.x},${p.y}).`);
  return true;
}

function craftRecipe(recipeId) {
  const r = state.data.recipes[recipeId];
  if (!r) return;

  const chk = canCraftRecipe(r);
  if (!chk.ok) return;

  const inv = activeInv();

  // consume inputs
  for (const [id, amt] of Object.entries(r.in)) removeItem(inv, id, amt);

  // produce outputs
  for (const [id, amt] of Object.entries(r.out)) addItem(inv, id, amt);

  // log crafting (exclude movement, include crafting)
  const pName = activePlayer().name;
  playSound("saw");
  logAction(`${pName} crafted ${r.name}!`);
}

function attemptManualCraft() {
  const selected = [...state.selectedForCraft];
  if (selected.length === 0) return;

  const candidates = recipeList().filter(r =>
    Object.keys(r.in).every(id => selected.includes(id))
  );

  if (!candidates.length) return;

  const r = candidates[0];

  const chk = canCraftRecipe(r);
  if (!chk.ok) return;

  craftRecipe(r.id);
  state.learnedRecipes.add(r.id);
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

// ---- Drawing ----
function drawRect(x, y, w, h, fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }

function drawText(text, x, y, size = 16, align = "left", color = "#fff") {
  ctx.font = `${size}px system-ui, Apple Color Emoji, Segoe UI Emoji`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
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
      ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    }
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

function drawTopBar() {
  drawRect(0, 0, window.innerWidth, UI_TOP_H, "rgba(0,0,0,0.74)");

  const p = activePlayer();
  const inv = activeInv();
  const pieces = getQty(inv, "blueprint_piece");
  const hasBP = getQty(inv, "blueprint_cabin") > 0;

  drawText(
    `Mode: ${state.mode} | Active: ${p.name} | Pieces: ${pieces}${hasBP ? " (Cabin Blueprint ✅)" : ""}`,
    10, 16, 13
  );

  // coords on top-right (requested)
  if (state.mode === "overworld") {
    const p1 = state.players[0], p2 = state.players[1];
    const rightText = `P1 (${p1.x},${p1.y})  P2 (${p2.x},${p2.y})`;
    drawText(rightText, window.innerWidth - 10, 16, 13, "right");
  }

  // stamina bar (requested)
  drawText("Stamina", 10, 40, 12, "left", "rgba(255,255,255,0.85)");
  staminaBar(p, 70, 34, 160, 12);

  const restTxt = p.resting ? "Resting…" : (p.stamina <= 0 ? "Exhausted" : "");
  if (restTxt) drawText(restTxt, 240, 40, 12, "left", "rgba(255,255,255,0.75)");
}

// -------------------------------------------------------- DROPPING ITEMS ----
function isTileOccupiedForDrop(x, y) {
  const map = getCurrentMap();
  const obj = map.objects?.[y]?.[x];
  if (!obj) return false;

  // Allow stacking onto an existing dropped_item
  if (obj.id === "dropped_item") return false;

  // If it's a normal object, dropping is blocked
  const def = objDef(obj.id);
  if (def?.blocks) return true;

  // Even non-blocking objects are still "occupied" in your current world model
  // (since you only store 1 object per tile). Keep it simple.
  return true;
}

function dropItemOnTile(itemId, qty, x, y) {
  const map = getCurrentMap();
  if (!map?.objects?.[y]) return false;

  // If tile has same dropped_item, stack it
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

  const { w, h } = currentDims();
  const { viewW, viewH } = viewTiles();
  const camX = state.cam.x;
  const camY = state.cam.y;

  for (let y = camY; y < Math.min(h, camY + viewH); y++) {
    for (let x = camX; x < Math.min(w, camX + viewW); x++) {
      const { sx, sy } = mapToScreen(x, y);

      const tileId = map.tiles[y][x];
      const t = state.data.tiles[tileId];

      drawRect(sx, sy, TILE_SIZE, TILE_SIZE, t?.color ?? "#333");
      if (t?.icon) drawCenteredEmoji(t.icon, sx + TILE_SIZE/2, sy + TILE_SIZE/2, 20);

     // object (respect fog of war)
// object (respect fog of war)
const obj = map.objects[y][x];
const explored = state.mode !== "overworld" || state.world.explored[y][x];

if (obj && explored) {

  // Special-case dropped items (not in objects.json)
  if (obj.id === "dropped_item") {
    const id = obj.meta?.itemId;
    const def = itemDef(id);
    const icon = def?.icon ?? "📦";
    drawCenteredEmoji(icon, sx + TILE_SIZE/2, sy + TILE_SIZE/2, 24);

    // qty label
    const q = obj.meta?.qty ?? 1;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "12px system-ui";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(String(q), sx + TILE_SIZE - 4, sy + TILE_SIZE - 3);
  } else {
    const o = objDef(obj.id);
    if (o?.icon) drawCenteredEmoji(o.icon, sx + TILE_SIZE/2, sy + TILE_SIZE/2, 26);
  }


  if (state.mode === "overworld" && (obj.id === "house_door" || obj.id === "stockpile")) {
    drawText(`(${x},${y})`, sx + TILE_SIZE/2, sy + 8, 11, "center", "rgba(255,255,255,0.85)");
  }
}

      // fog of war only overworld
      if (state.mode === "overworld") {
        const explored = state.world.explored[y][x];
        if (!explored) drawRect(sx, sy, TILE_SIZE, TILE_SIZE, "rgba(70,70,70,0.88)");
      }

      ctx.strokeStyle = "rgba(0,0,0,0.15)";
      ctx.strokeRect(sx, sy, TILE_SIZE, TILE_SIZE);
    }
  }

  // players (use fx/fy for smooth movement)
  for (let i = 0; i < state.players.length; i++) {
    const pl = state.players[i];

    const px = pl.fx;
    const py = pl.fy;

    if (px < camX || px >= camX + viewW || py < camY || py >= camY + viewH) continue;

    const sx = (px - camX) * TILE_SIZE;
    const sy = UI_TOP_H + (py - camY) * TILE_SIZE;

    drawCenteredEmoji(pl.icon, sx + TILE_SIZE/2, sy + TILE_SIZE/2, 28);

    if (i === state.activePlayer) {
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 6, sy + 6, TILE_SIZE - 12, TILE_SIZE - 12);
      ctx.lineWidth = 1;
    }
  }
}

function drawInventoryUI() {
  const baseY = window.innerHeight - UI_BOTTOM_H;
  drawRect(0, baseY, window.innerWidth, UI_BOTTOM_H, "rgba(0,0,0,0.78)");

  // --- Header text ---
  const leftX = 10;
  const line1Y = baseY + 16;
  const line2Y = baseY + 34;
  const line3Y = baseY + 52;

  drawText("Tap map: pathfind + walk | Drag: pan camera | 1/2 switch player", leftX, line1Y, 13);
  drawText("Double-tap toolkit to open | C: craft | B: place cabin | M: saved coords | E: exit interior", leftX, line2Y, 13);

  const inv = activeInv();

  const selectedNames = [...state.selectedForCraft]
    .map(id => itemDef(id)?.name ?? id)
    .join(", ");

  drawText(`Selected: ${selectedNames || "(none)"}`, leftX, line3Y, 13, "left", "rgba(255,255,255,0.88)");

  // --- Inventory grid ---
  const cell = 44, pad = 10;
  const gridX = pad;
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
  const lx = viewTiles().viewW * TILE_SIZE + pad;
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
}

function invIndexAtScreen(px, py) {
  const baseY = window.innerHeight - UI_BOTTOM_H;
  const cell = 44, pad = 10;
  const gridX = pad;
  const gridY = baseY + 75;

  const col = Math.floor((px - gridX) / (cell + 6));
  const row = Math.floor((py - gridY) / (cell + 6));
  if (col < 0 || col >= INV_COLS || row < 0 || row >= INV_ROWS) return -1;

  return row * INV_COLS + col;
}

// ------------------------------------------------------------------------ CRAFTING FUNCTION ----
function drawCraftingPopup() {
  if (!state.craftingOpen) return;

  const inv = activeInv();
  const recipes = recipeList().filter(r => {
    if (state.craftingMode === "craft") return r.station === "workbench";
    if (state.craftingMode === "cook") return r.station === "campfire";
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

  drawText(state.craftingMode === "cook" ? "Cooking" : "Crafting", x + W/2, y + 24, 20, "center");

  const leftX = x + 16;
  const rightX = x + W / 2 + 8;
  const listY = y + 60;

  // Inventory column
  drawText("Inventory", leftX, listY - 20, 14);

  inv.forEach((st, i) => {
    const iy = listY + i * 28;
    const selected = state.selectedForCraft.has(st.id);

    drawRect(leftX, iy, W/2 - 32, 24, selected ? "rgba(80,120,255,0.4)" : "rgba(255,255,255,0.05)");
    drawText(`${itemDef(st.id)?.name ?? st.id} (${st.qty})`, leftX + 8, iy + 12, 13);
  });

  // Recipes column
  drawText("Recipes", rightX, listY - 20, 14);

  learned.forEach((r, i) => {
    const iy = listY + i * 28;
    const chk = canCraftRecipe(r);

    drawRect(rightX, iy, W/2 - 32, 24, "rgba(255,255,255,0.05)");
    drawText(
      r.name ?? r.id,
      rightX + 8,
      iy + 12,
      13,
      "left",
      chk.ok ? "#fff" : "rgba(255,255,255,0.35)"
    );
  });

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

  const inv = activeInv();

  inv.forEach((st, i) => {
    const iy = listY + i * 28;
    if (
      px >= leftX &&
      px <= leftX + W/2 - 32 &&
      py >= iy &&
      py <= iy + 24
    ) {
      if (state.selectedForCraft.has(st.id)) {
        state.selectedForCraft.delete(st.id);
      } else {
        state.selectedForCraft.add(st.id);
      }
    }
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

  const dropBlocked = isTileOccupiedForDrop(p.x, p.y);

  const drop = (qty) => {
    if (dropBlocked) return;
    if (!removeItem(inv, itemId, qty)) return;

    const ok = dropItemOnTile(itemId, qty, p.x, p.y);
    if (!ok) {
      // revert if something weird happened
      addItem(inv, itemId, qty);
      return;
    }

    logAction(`${p.name} dropped ${qty} ${itemName}${qty === 1 ? "" : "s"} at (${p.x},${p.y}).`);
    closeMenu();
  };

  const canDump = filledBucketId && emptyBucketId && itemId === filledBucketId;

  openMenu({
    screenX, screenY,
    title: itemName,
    options: [
      {
        label: "Drop 1",
        disabledReason: dropBlocked ? "Tile occupied" : (st.qty >= 1 ? null : "None"),
        action: () => drop(1)
      },
      {
        label: `Drop all (${st.qty})`,
        disabledReason: dropBlocked ? "Tile occupied" : null,
        action: () => drop(st.qty)
      },
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

function drawCoordsModal() {
  const w = Math.min(520, window.innerWidth - 20);
  const h = Math.min(320, window.innerHeight - 140);
  const x = (window.innerWidth - w) / 2;
  const y = UI_TOP_H + 20;

  drawRect(x, y, w, h, "rgba(10,10,10,0.92)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(x, y, w, h);

  drawText("Saved Coordinates", x + 12, y + 18, 16);

  const p = activePlayer();
  drawText(`Current: (${p.x},${p.y})`, x + w - 12, y + 18, 13, "right", "rgba(255,255,255,0.85)");

  // Buttons
  state._coordsUI = {
    close: { x: x + w - 90, y: y + h - 40, w: 80, h: 28 },
    mark:  { x: x + 12,      y: y + h - 40, w: 200, h: 28 }
  };

  // list
  const listY = y + 44;
  let yy = listY;

  const items = state.markers.slice(0, 12);
  if (items.length === 0) {
    drawText("No saved locations yet (house + stockpile are auto-saved).", x + 12, yy + 10, 13, "left", "rgba(255,255,255,0.75)");
  } else {
    for (const m of items) {
      drawText(`${m.label}: (${m.x},${m.y})`, x + 12, yy + 10, 13, "left", "rgba(255,255,255,0.9)");
      yy += 22;
    }
  }

  // buttons draw
  const b = state._coordsUI;
  drawRect(b.mark.x, b.mark.y, b.mark.w, b.mark.h, "rgba(255,255,255,0.10)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(b.mark.x, b.mark.y, b.mark.w, b.mark.h);
  drawText("Mark current location", b.mark.x + 10, b.mark.y + b.mark.h/2, 13);

  drawRect(b.close.x, b.close.y, b.close.w, b.close.h, "rgba(255,255,255,0.10)");
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(b.close.x, b.close.y, b.close.w, b.close.h);
  drawText("Close", b.close.x + b.close.w/2, b.close.y + b.close.h/2, 13, "center");
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

// ---- Build Site ----
function upgradeBuildSite(x, y) {
  const key = `${x},${y}`;
  const proj = state.buildProjects[key];
  if (!proj) return;

  proj.progress++;
  const p = activePlayer();

  if (proj.stage === 0 && proj.progress >= 3) {
    state.world.objects[y][x] = { id: "framework", hp: 999, meta: { key } };
    proj.stage = 1;
    proj.progress = 0;
    playSound("hammer");
    logAction(`${p.name} upgraded Build Site → Framework`);
  }

  else if (proj.stage === 1 && proj.progress >= 5) {
    state.world.objects[y][x] = { id: "house_door", hp: 999, meta: { interiorId: "cabin_small" } };
    delete state.buildProjects[key];
    playSound("achievement");
    logAction(`${p.name} completed construction → House`);
  }
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
    state.coordsOpen = false;
    return true;
  }
  if (hitRect(px, py, ui.mark)) {
    const p = activePlayer();
    const n = state.markers.filter(m => m.type === "marker").length + 1;
    addMarker(`Marker ${n}`, p.x, p.y, "marker");
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
  const gridX = pad;
  const gridY = baseY + 75;

  const col = Math.floor((px - gridX) / (cell + 6));
  const row = Math.floor((py - gridY) / (cell + 6));
  if (col < 0 || col >= INV_COLS || row < 0 || row >= INV_ROWS) return false;

  const idx = row * INV_COLS + col;
  const inv = activeInv();
  const stack = inv[idx];
  if (!stack) return false;

// Blueprint interaction
if (stack.id === "blueprint_cabin") {
  openMenu({
    screenX: px,
    screenY: py,
    title: "Cabin Blueprint",
    options: [{
      label: "Begin Construction",
      action: () => {
        const p = activePlayer();
        const key = `${p.x},${p.y}`;

        state.world.objects[p.y][p.x] = {
          id: "build_site",
          hp: 999,
          meta: { key }
        };

        state.buildProjects[key] = { stage: 0, progress: 0 };

	playSound("hammer");
        logAction(`${p.name} began construction (Build Site).`);
        removeItem(activeInv(), "blueprint_cabin", 1);
        closeMenu();
      }
    }]
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

  // toggle selection for crafting filters
  if (state.selectedForCraft.has(stack.id)) state.selectedForCraft.delete(stack.id);
  else state.selectedForCraft.add(stack.id);

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

  const top = UI_TOP_H;
  const bottom = window.innerHeight - UI_BOTTOM_H; // CSS pixels, not canvas.height

  return px >= 0 && px < worldPxW && py >= top && py < bottom;
}

function isInRightSidebar(px) {
  // World is only the left viewW tiles wide.
  const worldPxW = viewTiles().viewW * TILE_SIZE;
  return px >= worldPxW;
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
  const logX = viewW * TILE_SIZE + pad;
  const logY = UI_TOP_H + pad;
  const logW = 420;
  const logH = window.innerHeight - UI_TOP_H - UI_BOTTOM_H - pad * 2;

  return (
    px >= logX && px <= (logX + logW) &&
    py >= logY && py <= (logY + logH)
  );
}

function updateMapCursor(px, py) {
  // UI + modals always use default cursor
  if (
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

  state.pointer.down = true;
  state.pointer.dragging = false;
  state.pointer.startX = px;
  state.pointer.startY = py;
  state.pointer.lastX = px;
  state.pointer.lastY = py;

if (state.craftingOpen) {
  handleCraftingClick(e.offsetX, e.offsetY);
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

canvas.addEventListener("pointerup", (e) => {
  const wasDragging = state.pointer.dragging;

  state.pointer.down = false;
  state.pointer.dragging = false;

  const { px, py } = pointerPos(e);
  if (typeof updateMapCursor === "function") updateMapCursor(px, py);

  // If we were dragging the map, we’re done. Don’t treat it as a click.
  if (wasDragging) {
    state.pointer.blocked = false;
    return;
  }

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();

  const { px, py } = pointerPos(e);

  // Only inventory area for now
  if (!isInInventoryArea(py)) return;

  const idx = invIndexAtScreen(px, py);
  if (idx < 0) return;

  const inv = activeInv();
  if (!inv[idx]) return;

  openMenuForInventoryItem(idx, px, py);
});


  // UI should still work even if pointer.blocked is true (inventory is outside world bounds).
  if (state.coordsOpen) { handleCoordsTap(px, py); state.pointer.blocked = false; return; }
  if (state.stockpileOpen) { handleStockpileTap(px, py); state.pointer.blocked = false; return; }
  if (state.menu) { handleMenuTap(px, py); state.pointer.blocked = false; return; }

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
  const p = activePlayer();

  // placement modes
  if (state.placingCabin) {
    if (placeCabinAt(x, y)) state.placingCabin = false;
    return;
  }
  if (state.placingStockpile) {
    if (placeStockpileAt(x, y)) state.placingStockpile = false;
    return;
  }

    // clicking a player => player context menu (Rest / Stop resting)
  const clickedPlayerIndex = state.players.findIndex(pl => pl.x === x && pl.y === y);
  if (clickedPlayerIndex !== -1) {
    state.activePlayer = clickedPlayerIndex;
    openMenuForPlayer(clickedPlayerIndex, px, py);
    return;
  }

  // water tile interaction (fill bucket)
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


// default behavior
setPathTo(x, y);

});

// Keyboard controls
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();

if (state.craftingOpen) {
  if (e.key.toLowerCase() === "c") {
    attemptManualCraft();
  }
  if (e.key === "Escape") {
    closeCraftingScreen();
  }
}

  if (k === "1") { state.activePlayer = 0; closeMenu(); }
  if (k === "2") { state.activePlayer = 1; closeMenu(); }

  if (k === "c") {
    state.craftingOpen = !state.craftingOpen;
    if (!state.craftingOpen) state.selectedForCraft.clear();
  }

  if (k === "b") {
    state.placingCabin = true;
    state.placingStockpile = false;
    closeMenu();
  }

  if (k === "m") {
    state.coordsOpen = !state.coordsOpen;
    state.stockpileOpen = null;
    closeMenu();
  }

  if (k === "e") {
    if (state.mode === "interior") tryExitInterior();
  }

// ---- WASD Movement ----
const moveDir = {
  w: { dx: 0, dy: -1 },
  a: { dx: -1, dy: 0 },
  s: { dx: 0, dy: 1 },
  d: { dx: 1, dy: 0 }
};

if (moveDir[k]) {
  const p = activePlayer();
  const { dx, dy } = moveDir[k];

  const nx = p.x + dx;
  const ny = p.y + dy;

  if (isPassable(nx, ny)) {
    p.resting = false;
    p.path = [{ x: nx, y: ny }];
  }
}

});

// ---- Main loop ----
function update(dt) {
  updatePlayers(dt);
  updateAnimals(dt);
  updateSpawns(dt);
}

function render() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawTopBar();
  drawWorld();
  drawInventoryUI();
  drawMenu();
  drawCraftingPopup();
}

function loop(now) {
  const dt = Math.min(0.05, (now - state._lastTime) / 1000);
  state._lastTime = now;

  update(dt);
  render();

  requestAnimationFrame(loop);
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

  // Generate maps
  state.world = generateOverworld();
  state.interior = generateInterior(state.interiorId);

  // camera start
  state.cam.x = 0;
  state.cam.y = 0;
  clampCamera();

  // Starter inventories: toolkit only
  addItem(state.inventories[0], "toolkit", 1);
  addItem(state.inventories[1], "toolkit", 1);

  // reveal initial fog
  revealAroundPlayers();

  requestAnimationFrame(loop);
}

boot().catch(err => {
  console.error(err);
  alert(err.message);
});
