import "./style.css";
import { PlanetScene } from "./scene";
import { NpcDialogue } from "./dialogue";
import { Vector3 } from "three";
import { mapPoint, terrainHeight, type CanonicalMapData } from "../shared/canonical-map";
import { xpForLevel, nextLevelXp } from "../shared/progression";
import type {
  Entity,
  Player,
  Snapshot,
  WorldData,
  ItemDef,
} from "../shared/types";

const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
let others: Player[] = [];
let world: WorldData = {
    items: [],
    recipes: [],
    professions: [],
    entities: [],
  },
  self: Player | undefined,
  ws: WebSocket | undefined,
  panel = "",
  target: Entity | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined,
  connecting = false,
  loggingOut = false,
  lastChat = "",
  lastPanelState = "";
const app = $("#app");
app.innerHTML = `
<div id="world"></div><div class="vignette"></div>
<header class="topbar"><a class="brand" href="/" aria-label="AWPlanet"><span class="planet-symbol">◉</span><span>AW<span class="brand-divider">/</span><b>PLANET</b><small>ВОЗВРАЩЕНИЕ</small></span></a><div class="status"><i id="status-dot"></i><span id="connection">ПОДКЛЮЧЕНИЕ К КОЛОНИИ</span></div><button class="quiet" id="quality" title="Переключить качество графики">Графика: высокая</button><button class="quiet" id="help">?</button></header>
<section id="welcome" class="welcome"><div class="eyebrow">СНОВА ДОМА. НА ДРУГОЙ ПЛАНЕТЕ.</div><h1>Твоя история<br>продолжается<span>.</span></h1><p>Колонии, ремёсла, опасные пустоши.<br>Вернись в мир AWPlanet — с изометрической камерой и живой колонией.</p><div class="landing-meta"><span>01 / ФАРМУН</span><span>БРАУЗЕРНАЯ АЛЬФА</span></div><form id="auth" class="auth"><div class="auth-tabs"><button type="button" data-auth="register" class="active">Новый колонист</button><button type="button" data-auth="login">Я уже здесь был</button></div><label>Имя колониста<input name="name" autocomplete="username" maxlength="24" minlength="3" required placeholder="Как тебя запомнит планета?"></label><label>Пароль<input name="password" type="password" autocomplete="new-password" minlength="8" required placeholder="Не меньше 8 символов"></label><button class="primary" id="enter" type="submit">Начать экспедицию <span>↗</span></button><div id="auth-error" role="alert"></div></form><p class="alpha-note">Фанатская реконструкция. Карта восстановлена из публичного клиента. Механики и история мира продолжают развиваться.</p></section>
<aside class="landing-coordinate">AW.01<br><span>ПЕРВАЯ КОЛОНИЯ</span><div class="coordinate-line"></div><small>ЖИВОЙ МИР · ОБЩИЙ СЕРВЕР</small></aside>
<div id="game-ui" hidden><aside class="player-card"><div class="avatar-icon">◈</div><div class="player-info"><div><strong id="player-name"></strong><span id="level"></span></div><div class="meter"><i id="hp-bar"></i><span id="hp-label"></span></div><div class="meter stamina"><i id="stamina-bar"></i><span id="stamina-label"></span></div></div></aside>
<aside class="map-card"><div class="map-heading"><span id="zone">ФАРМУН</span><span class="tiny">БЕЗОПАСНАЯ ЗОНА</span></div><canvas id="minimap" width="180" height="150"></canvas><div class="map-footer"><span id="coords">0 : 0</span><span id="credits">0 кр.</span></div></aside>
<aside class="quest-card"><span class="eyebrow">ПЕРВЫЕ ШАГИ</span><h3 id="quest-title">Голос из прошлого</h3><p id="quest-text">Поговори с отшельником Бобом. Он поможет освоиться в колонии.</p><button class="text-button" id="find-bob">Идти к Бобу ↗</button><button class="text-button" data-panel="guide" style="margin-left:12px">Мир ↗</button></aside>
<div id="interaction" class="interaction" hidden><kbd>E</kbd><div><strong id="interaction-name"></strong><small id="interaction-verb"></small></div></div>
<section class="chat"><div class="chat-head">ОБЩИЙ КАНАЛ <span id="online">1 в сети</span></div><div id="chat-log" aria-live="polite"></div><form id="chat-form"><input id="chat-input" maxlength="240" placeholder="Enter — написать в общий чат" autocomplete="off"><button aria-label="Отправить сообщение">↗</button></form></section>
<footer class="game-footer"><div class="shortcuts"><button data-panel="inventory"><kbd>I</kbd>Инвентарь</button><button data-panel="craft"><kbd>C</kbd>Ремёсла</button><button data-panel="skills"><kbd>K</kbd>Персонаж</button><button data-panel="map"><kbd>M</kbd>Карта</button><button data-panel="social"><kbd>B</kbd>Общение</button></div><div class="hotbar"><button id="attack"><kbd>1</kbd><span>⚔</span><small>Атака</small></button><button id="heal"><kbd>2</kbd><span>✚</span><small>Еда</small></button><button id="interact-hotbar"><kbd>E</kbd><span>◇</span><small>Действие</small></button></div><div class="movement-hint">WASD — движение · Shift — бег<br>ЛКМ — идти / взаимодействовать · ПКМ — камера</div></footer></div>
<div id="panel-backdrop" class="panel-backdrop" hidden><section class="panel"><div class="panel-heading"><div><span class="eyebrow" id="panel-kicker">ТВОЯ ЭКСПЕДИЦИЯ</span><h2 id="panel-title"></h2></div><button id="panel-close" class="quiet" aria-label="Закрыть">✕</button></div><nav class="panel-nav"><button data-panel="inventory">Инвентарь</button><button data-panel="craft">Ремёсла</button><button data-panel="skills">Персонаж</button><button data-panel="map">Карта</button><button data-panel="guide">Мир</button></nav><div id="panel-content"></div></section></div><div id="toasts" aria-live="polite"></div><div id="loading">Создаём планету<span></span></div>`;
let scene: PlanetScene;
let canonicalMap: CanonicalMapData;
try {
  const response = await fetch("/api/map");
  if (!response.ok) throw new Error("Не удалось загрузить карту мира.");
  canonicalMap = await response.json();
  scene = new PlanetScene($("#world"), canonicalMap);
  $("#loading").remove();
} catch (e) {
  $("#loading").innerHTML =
    "Не удалось загрузить мир. Обнови страницу и проверь соединение.";
  $("#loading").dataset.error = e instanceof Error ? e.message : String(e);
  throw e;
}
const item = (id: string): ItemDef | undefined =>
  world.items.find((i) => i.id === id);
const kindName = (kind?: string) =>
  (
    ({
      weapon: "Оружие",
      armor: "Доспех",
      tool: "Инструмент",
      food: "Еда",
      ore: "Руда",
      material: "Материал",
      resource: "Ресурс",
      program: "Программа",
      component: "Компонент",
      quest: "Задание",
    }) as Record<string, string>
  )[kind || ""] || "Предмет";
const itemName = (id: string) => item(id)?.name || id;
const dialogue = new NpcDialogue({
  player: () => self,
  itemName,
  talk: (e) => action("talk", { target: e.id }),
  service: (name) => openPanel(name),
  opened: () => {
    closePanel();
    scene.destination = undefined;
    scene.keys.clear();
    scene.focused = false;
    if (self?.combatTarget) action("disengage");
  },
  closed: () => {
    scene.focused = !!self && !panel;
  },
});
let lastCombatEvent = 0;
const combatCard = document.createElement("aside");
combatCard.className = "combat-target";
combatCard.hidden = true;
$("#game-ui").append(combatCard);
function updateCombat(s: Snapshot) {
  const enemy = s.entities.find(
    (e) => e.id === s.self.combatTarget && e.alive !== false,
  );
  combatCard.hidden = !enemy;
  if (enemy) {
    combatCard.innerHTML = `<span class="dialogue-eyebrow">ПРОТИВНИК · УРОВЕНЬ ${enemy.level || 1}</span><strong>${esc(enemy.name)}</strong><div class="enemy-health"><i style="width:${(100 * (enemy.hp || 0)) / (enemy.maxHp || 1)}%"></i><span>${Math.ceil(enemy.hp || 0)} / ${enemy.maxHp || 1}</span></div><button aria-label="Прекратить бой">✕</button>`;
    combatCard.querySelector("button")!.onclick = () => action("disengage");
  }
  for (const event of s.events || []) {
    if (event.id <= lastCombatEvent) continue;
    lastCombatEvent = event.id;
    if (s.time - event.at > 1500) continue;
    const entity = s.entities.find((e) => e.id === event.target);
    if (event.attacker === s.self.id && entity) scene.triggerAttack(entity);
    else scene.triggerEntityAttack(event.attacker);
    const position =
      entity ||
      (event.target === s.self.id
        ? s.self
        : s.players.find((p) => p.id === event.target));
    if (!position) continue;
    const projection = new Vector3(position.x, terrainHeight(canonicalMap, position.x, position.z) + 1.8, position.z).project(
      scene.camera,
    );
    if (projection.z > 1) continue;
    const label = document.createElement("span");
    label.className = `damage-number ${event.target === s.self.id ? "incoming" : ""}`;
    label.textContent = `−${event.damage}`;
    label.style.left = `${(projection.x * 0.5 + 0.5) * 100}%`;
    label.style.top = `${(-projection.y * 0.5 + 0.5) * 100}%`;
    $("#world").append(label);
    setTimeout(() => label.remove(), 1000);
  }
}
const skillName = (id: string) =>
  world.professions.find((s) => s.id === id)?.name ||
  (
    {
      strength: "Сила",
      dexterity: "Ловкость",
      agility: "Ловкость",
      endurance: "Выносливость",
      intellect: "Интеллект",
      intuition: "Интуиция",
      attack: "Атака",
      defense: "Защита",
      reaction: "Реакция",
      accuracy: "Точность",
      melee: "Ближний бой",
      ranged: "Стрельба",
      health: "Здоровье",
    } as Record<string, string>
  )[id] ||
  id;
function toast(text: string, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 5500);
}
async function api(path: string, body?: unknown) {
  const r = await fetch(path, {
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok)
    throw new Error(
      data.error || data.message || "Сервер не смог выполнить запрос",
    );
  return data;
}
function send(data: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  else toast("Связь с колонией восстанавливается.");
}
function action(action: string, extra: Record<string, unknown> = {}) {
  if (!self) return;
  send({ type: "action", action, ...extra });
}
function connect() {
  if (!self || loggingOut || connecting || ws?.readyState === WebSocket.OPEN) return;
  connecting = true;
  const socket = ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
  );
  ws.onopen = () => {
    lastCombatEvent = 0;
    connecting = false;
    $("#connection").textContent = "НА СВЯЗИ С КОЛОНИЕЙ";
    $("#status-dot").classList.add("connected");
  };
  ws.onmessage = (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data.type === "snapshot") snapshot(data);
    else if (data.type === "notice" && !dialogue.notice(data.text, data.kind))
      toast(data.text, data.kind);
  };
  ws.onclose = async () => {
    if (ws !== socket) return;
    connecting = false;
    if (!self || loggingOut) return;
    $("#connection").textContent = "ВОССТАНАВЛИВАЕМ СВЯЗЬ";
    $("#status-dot").classList.remove("connected");
    try {
      const session = await api("/api/session");
      if (ws !== socket || !self || loggingOut) return;
      if (!session.player) {
        self = undefined;
        others = [];
        target = undefined;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        dialogue.close();
        closePanel();
        scene.destination = undefined;
        scene.keys.clear();
        scene.focused = false;
        scene.selfId = "";
        for (const avatar of scene.avatars.values()) scene.scene.remove(avatar.root);
        scene.avatars.clear();
        combatCard.hidden = true;
        $("#interaction").hidden = true;
        $("#game-ui").hidden = true;
        $("#welcome").hidden = false;
        $(".landing-coordinate").hidden = false;
        $("#connection").textContent = "КОЛОНИЯ ОНЛАЙН";
        $("#status-dot").classList.add("connected");
        document.querySelector<HTMLButtonElement>('[data-auth="login"]')?.click();
        $<HTMLInputElement>('#auth input[name="password"]').value = "";
        return;
      }
    } catch {
      // A failed session request can be a network outage; retain the player and retry.
    }
    if (ws === socket && self && !loggingOut) {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2500);
    }
  };
  ws.onerror = () => {
    connecting = false;
  };
}
function snapshot(s: Snapshot) {
  self = s.self;
  scene.focused = !panel && !dialogue.isOpen;
  others = s.players;
  scene.updatePlayers(s.self, s.players);
  scene.updateEntities(s.entities);
  dialogue.refresh();
  updateCombat(s);
  $("#welcome").hidden = true;
  $(".landing-coordinate").hidden = true;
  $("#game-ui").hidden = false;
  $("#player-name").textContent = s.self.name;
  $("#level").textContent = `ур. ${s.self.level}`;
  $("#hp-bar").style.width = `${(100 * s.self.hp) / s.self.maxHp}%`;
  $("#hp-label").textContent = `${Math.ceil(s.self.hp)} / ${s.self.maxHp}`;
  $("#stamina-bar").style.width =
    `${(100 * s.self.stamina) / s.self.maxStamina}%`;
  $("#stamina-label").textContent =
    `Тонус ${Math.floor(s.self.stamina)} / ${s.self.maxStamina}`;
  $("#credits").textContent = `${s.self.credits.toLocaleString("ru-RU")} кр.`;
  $("#online").textContent = `${s.online ?? s.players.length + 1} в сети`;
  const signature = s.messages.map((m) => m.id).join();
  if (signature !== lastChat) {
    lastChat = signature;
    $("#chat-log").innerHTML = s.messages
      .slice(-18)
      .map((m) => `<p><strong>${esc(m.name)}</strong> ${esc(m.text)}</p>`)
      .join("");
    $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  }
  const progress = s.self.quest.bobComplete
    ? 2
    : s.self.quest.bobStarted
      ? 1
      : 0;
  if (progress) {
    $("#quest-title").textContent =
      progress >= 2 ? "Первый день на планете" : "Помощь колонии";
    $("#quest-text").textContent =
      progress >= 2
        ? "Боб благодарен за помощь. Добывай руду, осваивай ремёсла и собирай снаряжение для вылазок."
        : "Принеси Бобу 5 единиц любой руды. Олово можно добывать с первого уровня геологии. Боб подскажет координаты.";
  }
  const changed = JSON.stringify([
    panel,
    s.self.inventory,
    s.self.bank,
    s.self.skills,
    s.self.stats,
    s.self.equipped,
    s.self.equipment,
    s.self.mode,
    Object.fromEntries(Object.entries(s.self.quest).filter(([key]) => key !== "recoveryMs" && key !== "runDistance")),
    Math.floor(s.self.force),
    s.self.credits,
    s.self.clan,
  ]);
  if (panel && changed !== lastPanelState && !scene.typing()) {
    lastPanelState = changed;
    renderPanel();
  }
}
let authMode = "register";
document.querySelectorAll<HTMLButtonElement>("[data-auth]").forEach(
  (b) =>
    (b.onclick = () => {
      authMode = b.dataset.auth!;
      document
        .querySelectorAll("[data-auth]")
        .forEach((el) => el.classList.toggle("active", el === b));
      $("#enter").innerHTML =
        (authMode === "register"
          ? "Начать экспедицию"
          : "Вернуться на планету") + " <span>↗</span>";
      $("#auth-error").textContent = "";
    }),
);
$("#auth").onsubmit = async (e) => {
  e.preventDefault();
  const form = new FormData(e.target as HTMLFormElement);
  const button = $<HTMLButtonElement>("#enter");
  button.disabled = true;
  $("#auth-error").textContent = "";
  try {
    const result = await api(`/api/auth/${authMode}`, {
      name: form.get("name"),
      password: form.get("password"),
    });
    self = result.player;
    connect();
  } catch (error) {
    $("#auth-error").textContent = (error as Error).message;
  } finally {
    button.disabled = false;
  }
};
$("#chat-form").onsubmit = (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("#chat-input");
  if (input.value.trim()) send({ type: "chat", text: input.value.trim() });
  input.value = "";
  input.blur();
};
function interaction() {
  interactEntity(scene.nearest());
}
function interactEntity(e?: Entity) {
  if (dialogue.isOpen) return;
  if (!e) {
    toast("Подойди к жителю, мастерской или ресурсу.");
    return;
  }
  target = e;
  if (e.type === "resource" || e.type === "loot")
    action("gather", { target: e.id });
  else if (e.type === "monster") {
    action("engage", { target: e.id });
  } else if (e.type === "npc") {
    dialogue.open(e);
  } else if (e.type === "station") {
    if (/bank/i.test(e.id)) openPanel("bank");
    else openPanel("craft");
  }
}
function attack() {
  if (dialogue.isOpen || panel) return;
  const e = scene.entities
    .filter((e) => e.type === "monster" && e.alive !== false)
    .sort(
      (a, b) =>
        Math.hypot(a.x - scene.player.x, a.z - scene.player.z) -
        Math.hypot(b.x - scene.player.x, b.z - scene.player.z),
    )[0];
  if (e && Math.hypot(e.x - scene.player.x, e.z - scene.player.z) < 4.5) {
    action("engage", { target: e.id });
  } else toast("Для атаки подойди к противнику.");
}
function heal() {
  const food = Object.keys(self?.inventory || {}).find(
    (id) => item(id)?.healing && self!.inventory[id] > 0,
  );
  if (food) action("use", { item: food });
  else toast("В инвентаре нет еды. Её можно приготовить или купить.");
}
scene.onMove = (x, z, rotation, running) => send({ type: "move", x, z, rotation, running });
scene.onEntityClick = interactEntity;
scene.onNavigate = () => {
  if (self?.combatTarget) action("disengage");
};
scene.onInteract = interaction;
scene.onAttack = attack;
scene.onShortcut = (k) => {
  if (k === "escape") {
    if (dialogue.isOpen) {
      dialogue.close();
      return;
    }
    if (self?.combatTarget) action("disengage");
    closePanel();
    return;
  }
  if (dialogue.isOpen) return;
  openPanel(
    (
      {
        i: "inventory",
        c: "craft",
        k: "skills",
        m: "map",
        b: "social",
      } as Record<string, string>
    )[k],
  );
};
window.addEventListener("keydown", (e) => {
  if (scene.typing() || dialogue.isOpen) return;
  if (e.key === "2") heal();
  if (e.key === "Enter" && self) {
    e.preventDefault();
    $("#chat-input").focus();
  }
});
$("#find-bob").onclick = () => {
  const bob = world.entities.find((e) => e.role === "bob" || /bob|боб/i.test(e.id + e.name));
  if (bob) {
    scene.destination = { x: bob.x, z: bob.z };
    toast("Идём к Бобу. WASD отменяет маршрут.");
  }
};
$("#attack").onclick = attack;
$("#heal").onclick = heal;
$("#interact-hotbar").onclick = interaction;
$("#help").onclick = () => openPanel("guide");
$("#panel-close").onclick = closePanel;
$("#quality").onclick = () => {
  const low = scene.quality !== "low";
  scene.setQuality(low ? "low" : "high");
  $("#quality").textContent = `Графика: ${low ? "экономная" : "высокая"}`;
};
document.addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLElement>("[data-panel]");
  if (button) openPanel(button.dataset.panel!);
});
$("#panel-backdrop").addEventListener("click", (e) => {
  if (e.target === $("#panel-backdrop")) closePanel();
});
function openPanel(name: string) {
  dialogue.close();
  lastPanelState = "";
  panel = name;
  scene.destination = undefined;
  scene.keys.clear();
  scene.focused = false;
  $("#panel-backdrop").hidden = false;
  renderPanel();
}
function closePanel() {
  panel = "";
  scene.focused = !!self;
  $("#panel-backdrop").hidden = true;
}
function inventoryRows(
  inventory: Record<string, number>,
  buttons: (id: string) => string,
) {
  const entries = Object.entries(inventory).filter(([, n]) => n > 0);
  return entries.length
    ? entries
        .map(([id, n]) => {
          const it = item(id);
          return `<div class="item-row"><span class="item-icon">${it?.damage ? "⚔" : it?.healing ? "✚" : it?.kind === "ore" ? "⬡" : "◇"}</span><div><strong>${esc(itemName(id))}</strong><small>${esc(it?.description || kindName(it?.kind))} · ${((it?.weight || 0) * n).toFixed(1)} кг</small></div><span class="quantity">${n}</span><div class="row-actions">${buttons(id)}</div></div>`;
        })
        .join("")
    : '<div class="empty-state">Здесь пока пусто. Всё большое начинается с первой находки.</div>';
}
function renderPanel() {
  const titles: Record<string, string> = {
    inventory: "Всё, что ты несёшь",
    craft: "Создавай своё снаряжение",
    skills: "Твой колонист",
    map: "За пределами дороги",
    guide: "Добро пожаловать на AW",
    bank: "Банк Фармуна",
    shop: "Торговая лавка",
    social: "Люди на планете",
  };
  $("#panel-title").textContent = titles[panel] || panel;
  document
    .querySelectorAll(".panel-nav [data-panel]")
    .forEach((el) =>
      el.classList.toggle(
        "active",
        (el as HTMLElement).dataset.panel === panel,
      ),
    );
  const content = $("#panel-content");
  if (panel === "inventory") {
    if (!self) {
      content.innerHTML = "<p>Создай колониста, чтобы открыть инвентарь.</p>";
      return;
    }
    const weight = Object.entries(self.inventory).reduce(
      (s, [id, n]) => s + (item(id)?.weight || 0) * n,
      0,
    );
    content.innerHTML = `<div class="panel-summary"><span>Снаряжение: <b>${esc(self.equipped ? itemName(self.equipped) : "пустые руки")}</b></span><span>${weight.toFixed(1)} кг</span></div>${inventoryRows(self.inventory, (id) => `${item(id)?.damage || item(id)?.kind === "armor" ? `<button data-action="equip" data-item="${esc(id)}">${self?.equipped === id || Object.values(self?.equipment || {}).includes(id) ? "Надето" : "Надеть"}</button>` : ""}${item(id)?.healing ? `<button data-action="use" data-item="${esc(id)}">Съесть</button>` : ""}`)}`;
  } else if (panel === "craft") {
    content.innerHTML = `<p class="panel-intro">Материалы списываются при начале работы. Для изготовления подойди к нужному станку в мастерских. Уровни ремёсел растут с практикой.</p><div class="recipe-grid">${world.recipes
      .map((r) => {
        const enough =
          !!self &&
          Object.entries(r.inputs).every(
            ([id, n]) => (self!.inventory[id] || 0) >= n,
          );
        return `<article class="recipe"><div class="recipe-top"><span>◇</span><small>${esc(skillName(r.skill))} · ур. ${r.level}</small></div><h3>${esc(r.name)}</h3><p>${Object.entries(
          r.inputs,
        )
          .map(
            ([id, n]) =>
              `<span class="${(self?.inventory[id] || 0) >= n ? "available" : "missing"}">${esc(itemName(id))} × ${n}</span>`,
          )
          .join(
            " + ",
          )}</p><footer><small>${r.seconds} сек. · ${esc(stationName(r.station))}</small><button data-action="craft" data-recipe="${esc(r.id)}" ${enough ? "" : "disabled"}>Создать</button></footer></article>`;
      })
      .join("")}</div>`;
  } else if (panel === "skills") {
    if (!self) {
      content.innerHTML = "<p>Характеристики доступны после входа.</p>";
      return;
    }
    content.innerHTML = `<div class="character-summary"><span class="character-emblem">◈</span><div><h3>${esc(self.name)}</h3><p>Боевой уровень ${self.level} · репутация PK ${self.pk}</p></div></div><div class="stat-grid">${Object.entries(
      self.stats,
    )
      .map(
        ([id, n]) =>
          `<div><small>${esc(skillName(id))}</small><strong>${n}</strong></div>`,
      )
      .join(
        "",
      )}</div><h3 class="section-title">Боевой режим</h3><div class="mode-options">${[
      ["defensive", "Защита"],
      ["offensive", "Нападение"],
      ["controlled", "Контроль"],
    ]
      .map(
        ([id, name]) =>
          `<button data-action="mode" data-value="${id}" class="${self!.mode === id ? "selected" : ""}">${name}</button>`,
      )
      .join(
        "",
      )}</div><h3 class="section-title">Форс · ${Math.floor(self.force)} / ${self.maxForce ?? 100}</h3><div class="mode-options force-options">${["Выключен", "Регенерация", "Точность", "Реакция", "Защита", "Шок", "Берсерк", "Оборона", "Нападение", "Форс-защита"].map((name, n) => `<button data-force="${n}" class="${(self!.quest.forceMode || 0) === n ? "selected" : ""}">${name}</button>`).join("")}</div><h3 class="section-title">Профессии и боевые навыки</h3><div class="skill-grid">${world.professions.map((s) => `<div class="skill"><div><strong>${esc(s.name)}</strong><span>${self!.skills[s.id] || 1}</span></div><p>${esc(s.description)}</p><small>${skillProgress(s.id).label}</small><div class="skill-track"><i style="width:${skillProgress(s.id).percent}%"></i></div></div>`).join("")}</div>`;
  } else if (panel === "map") {
    content.innerHTML = `<p class="panel-intro">Мир AWPlanet: полная сетка 512 × 512. Отметки показывают жителей, мастерские, ресурсы и противников. Щёлкни по карте, чтобы проложить маршрут.</p><div class="big-map"><canvas id="world-map" width="660" height="430"></canvas></div><div class="map-legend"><span>◆ Жители и мастерские</span><span>● Ресурсы</span><span>▲ Противники</span><span>◎ Ты</span></div>`;
    drawMap($("#world-map"), true);
    $("#world-map").onclick = (event) => {
      const canvas = $<HTMLCanvasElement>("#world-map"), rect = canvas.getBoundingClientRect(), scale = Math.min(canvas.width, canvas.height) / 540;
      const x = ((event.clientX - rect.left) / rect.width * canvas.width - canvas.width / 2) / scale;
      const z = ((event.clientY - rect.top) / rect.height * canvas.height - canvas.height / 2) / scale;
      closePanel(); scene.moveTo(x, z);
    };
  } else if (panel === "bank") {
    content.innerHTML = `<p class="panel-intro">Храни ресурсы перед вылазкой. Банковские предметы сохраняются после выхода и гибели. Операции доступны рядом с терминалом банка.</p><h3 class="section-title">С собой</h3>${inventoryRows(self?.inventory || {}, (id) => `<button data-action="bankDeposit" data-item="${esc(id)}">Положить 1</button><button data-action="bankDeposit" data-item="${esc(id)}" data-quantity="${self?.inventory[id]}">Всё</button>`)}<h3 class="section-title">В хранилище</h3>${inventoryRows(self?.bank || {}, (id) => `<button data-action="bankWithdraw" data-item="${esc(id)}">Забрать 1</button>`)}`;
  } else if (panel === "shop") {
    content.innerHTML = `<p class="panel-intro">Торговля доступна рядом с торговцем. Кредиты: <b>${self?.credits || 0}</b></p><h3 class="section-title">Приобрести</h3>${world.items
      .filter((i) => i.value > 0)
      .map(
        (i) =>
          `<div class="item-row"><span class="item-icon">◇</span><div><strong>${esc(i.name)}</strong><small>${esc(i.description || kindName(i.kind))}</small></div><span class="quantity">${i.value} кр.</span><button data-action="buy" data-item="${esc(i.id)}">Купить</button></div>`,
      )
      .join(
        "",
      )}<h3 class="section-title">Продать</h3>${inventoryRows(self?.inventory || {}, (id) => `<button data-action="sell" data-item="${esc(id)}">Продать 1</button>`)}`;
  } else if (panel === "social") {
    content.innerHTML = `<p class="panel-intro">Общий чат находится внизу экрана. Можно основать клан и передать предмет колонисту рядом с тобой.</p><form id="clan-form" class="inline-form"><input name="clan" minlength="3" maxlength="24" required placeholder="Название клана"><button>Создать / вступить</button></form><p>${self?.clan ? `Твой клан: <b>${esc(self.clan)}</b>` : "Ты пока свободный колонист."}</p><h3 class="section-title">Колонисты рядом</h3>${others.length ? others.map((p) => `<div class="item-row"><span class="item-icon">◈</span><div><strong>${esc(p.name)}</strong><small>Уровень ${p.level} · ${Math.round(Math.hypot(p.x - scene.player.x, p.z - scene.player.z))} м · ${esc(p.clan || "Свободный колонист")}</small></div><button data-player-attack="${esc(p.id)}">Атаковать</button></div>`).join("") : '<p class="small-note">Другие колонисты появятся здесь, когда войдут в мир.</p>'}<p class="small-note">PvP доступен с 10 уровня за пределами безопасной зоны.</p><h3 class="section-title">Передать предмет</h3><form id="trade-form" class="trade-form"><label>Имя получателя<input name="player" required placeholder="Колонист рядом"></label><label>Предмет<select name="item">${Object.keys(
      self?.inventory || {},
    )
      .filter((id) => self!.inventory[id] > 0)
      .map((id) => `<option value="${esc(id)}">${esc(itemName(id))}</option>`)
      .join(
        "",
      )}</select></label><label>Количество<input type="number" name="quantity" value="1" min="1" max="999" required></label><button>Передать</button></form><p class="small-note">Передача — подарок. Встречный обмен с подтверждением обеих сторон ещё в разработке.</p><button id="logout" class="quiet">Выйти из аккаунта</button>`;
  } else {
    content.innerHTML = `<div class="guide-hero"><span>01</span><h3>Планета помнит.</h3><p>AWPlanet — мир колоний, профессий и людей. Это независимая фанатская реконструкция. Карта и её население восстановлены по публичному клиенту Forever. История и механики мира продолжают возвращаться.</p></div><div class="guide-grid"><article><kbd>WASD</kbd><h3>Исследуй</h3><p>Shift для бега. Потяни мышью, чтобы повернуть камеру. Колесо меняет расстояние. Клик по земле или мини-карте задаёт маршрут. Клик по противнику запускает бой. ПКМ поворачивает камеру. Подойди к объекту и нажми E.</p></article><article><kbd>E</kbd><h3>Зарабатывай опытом</h3><p>Собирай древесину, руду, растения и рыбу. В мастерских плавь металл, готовь еду и изготавливай оружие.</p></article><article><kbd>1</kbd><h3>Будь готов к бою</h3><p>Надень оружие в инвентаре. Подойди к противнику и нажми 1 или пробел. Еда восстанавливает здоровье.</p></article><article><kbd>I</kbd><h3>Береги находки</h3><p>Сдай ценные материалы в банк. После гибели вещи могут остаться на месте боя, а часть опыта потеряется.</p></article></div><div class="development-note"><strong>Что сейчас доступно</strong><p>Общая зона, персонажи и чат, добыча, изготовление, PvE, снаряжение, банк, NPC-торговля, первый квест и сохранение. Данные каталога сверяются с оригиналом; часть баланса пока реконструирована. Все старые задания, переходы в подземелья, транспорт, полный обмен и особые боевые эффекты ещё требуют восстановления.</p><a href="https://github.com/WizardJIOCb/aw.xedoc.ru" target="_blank" rel="noopener">Исходный код и статус механик ↗</a></div>`;
  }
  content.querySelectorAll<HTMLButtonElement>("[data-action]").forEach(
    (b) =>
      (b.onclick = () =>
        action(b.dataset.action!, {
          item: b.dataset.item,
          recipe: b.dataset.recipe,
          quantity: Number(b.dataset.quantity || 1),
          value: b.dataset.value,
          target: target?.id,
        })),
  );
  content.querySelectorAll<HTMLButtonElement>("[data-player-attack]").forEach(
    (b) =>
      (b.onclick = () => {
        const p = others.find((p) => p.id === b.dataset.playerAttack);
        if (p) {
          scene.triggerAttack({
            id: p.id,
            type: "player",
            name: p.name,
            x: p.x,
            z: p.z,
          });
          action("attack", { target: p.id });
        }
      }),
  );
  content
    .querySelectorAll<HTMLButtonElement>("[data-force]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          action("forceMode", { value: Number(b.dataset.force) })),
    );
  const clan = content.querySelector<HTMLFormElement>("#clan-form");
  if (clan)
    clan.onsubmit = (e) => {
      e.preventDefault();
      action("clan", { value: new FormData(clan).get("clan") });
    };
  const trade = content.querySelector<HTMLFormElement>("#trade-form");
  if (trade)
    trade.onsubmit = (e) => {
      e.preventDefault();
      const d = new FormData(trade);
      const recipient = others.find(
        (p) =>
          p.name.toLocaleLowerCase() ===
          String(d.get("player")).trim().toLocaleLowerCase(),
      );
      if (!recipient) {
        toast("Игрок с этим именем сейчас не в сети.");
        return;
      }
      action("trade", {
        player: recipient.id,
        item: d.get("item"),
        quantity: Number(d.get("quantity")),
      });
    };
  const logout = content.querySelector<HTMLButtonElement>("#logout");
  if (logout)
    logout.onclick = async () => {
      loggingOut = true;
      try {
        await api("/api/auth/logout", {});
        self = undefined;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        ws?.close();
        location.reload();
      } catch (error) {
        loggingOut = false;
        toast((error as Error).message, "error");
        if (ws?.readyState === WebSocket.CLOSED) connect();
      }
    };
}
function stationName(s: string) {
  return (
    (
      {
        furnace: "Печь",
        forge: "Кузница",
        workshop: "Мастерская",
        workbench: "Лазерный станок",
        laboratory: "Лаборатория",
        kitchen: "Кухня",
        loom: "Ткацкий станок",
        press: "Пресс",
        campfire: "Костёр",
        none: "Ручная работа",
      } as Record<string, string>
    )[s] || s
  );
}
let mapBackground: HTMLCanvasElement | undefined;
function skillProgress(id: string) {
  const level = self?.skills[id] ?? 1, xp = self?.quest[`skillXp:${id}`] ?? xpForLevel(level),
    start = xpForLevel(level), next = nextLevelXp(level);
  return next === null ? { percent: 100, label: "Максимальный уровень" } :
    { percent: Math.min(100, Math.max(0, (xp - start) / (next - start) * 100)), label: `${Math.max(0, xp - start)} / ${next - start} опыта до уровня ${level + 1}` };
}
function drawMap(canvas: HTMLCanvasElement, large = false) {
  const ctx = canvas.getContext("2d")!,
    w = canvas.width,
    h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#172c29";
  ctx.fillRect(0, 0, w, h);
  const scale = large ? Math.min(w, h) / 540 : 2,
    cx = large ? 0 : scene.player.x,
    cz = large ? 0 : scene.player.z;
  const xy = (x: number, z: number) => [
    w / 2 + (x - cx) * scale,
    h / 2 + (z - cz) * scale,
  ];
  if (!mapBackground) {
    mapBackground = document.createElement("canvas"); mapBackground.width = mapBackground.height = 512;
    const context = mapBackground.getContext("2d")!, pixels = context.createImageData(512, 512);
    const palette = [[143,125,83],[123,113,76],[80,107,62],[77,100,65],[48,77,69],[106,103,90],[82,88,82],[63,89,85]];
    for (let index = 0; index < canonicalMap.terrain.length; index++) {
      const tile = (canonicalMap.terrain[index] >>> 8) & 255;
      const colour = tile >= 128 ? (tile & 15) >= 8 ? [126,130,117] : [139,116,86] : palette[(tile >>> 4) & 7];
      const offset = ((index % 512) * 512 + Math.floor(index / 512)) * 4;
      pixels.data.set([...colour, 255], offset);
    }
    context.putImageData(pixels, 0, 0);
  }
  const origin = xy(-256, -256);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(mapBackground, origin[0], origin[1], 512 * scale, 512 * scale);
  ctx.strokeStyle = "#2b4238";
  ctx.lineWidth = 1;
  for (let n = -256; n <= 256; n += 32) {
    const [x] = xy(n, 0),
      [, y] = xy(0, n);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  for (const e of large ? world.entities : scene.entities.length ? scene.entities : world.entities) {
    if (e.alive === false || e.stock === 0) continue;
    const [x, y] = xy(e.x, e.z);
    ctx.fillStyle =
      e.type === "monster"
        ? "#d39775"
        : e.type === "resource"
          ? "#79a07b"
          : "#ded8a0";
    ctx.beginPath();
    ctx.arc(x, y, large ? e.type === "npc" ? 1.8 : 1 : e.type === "resource" ? 2 : 3, 0, Math.PI * 2);
    ctx.fill();
  }
  if (large) {
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "#d4d6b4";
    const bob = world.entities.find(e => e.role === "bob");
    if (bob) {
      const p = xy(bob.x, bob.z);
      ctx.fillText("БОБ", p[0] + 4, p[1] - 6);
    }
  }
  const p = xy(scene.player.x, scene.player.z);
  ctx.fillStyle = "#eaf0c8";
  ctx.beginPath();
  ctx.arc(p[0], p[1], 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#c5d69b";
  ctx.beginPath();
  ctx.arc(p[0], p[1], 8, 0, Math.PI * 2);
  ctx.stroke();
}
setInterval(() => {
  const e = scene.nearest();
  $("#interaction").hidden = !e || !self || !!panel || dialogue.isOpen;
  if (e) {
    $("#interaction-name").textContent = e.name;
    $("#interaction-verb").textContent =
      (
        {
          resource: "Собрать ресурс",
          monster: `Атаковать · ${e.hp || 0} / ${e.maxHp || 0} HP`,
          npc: e.role === "bank" ? "Открыть банк" : "Поговорить",
          station: "Открыть мастерскую",
          loot: "Подобрать добычу",
        } as Record<string, string>
      )[e.type] || "Взаимодействовать";
  }
  $("#coords").textContent =
    `${Math.round(scene.player.x)} : ${Math.round(scene.player.z)}`;
  const safe = Math.hypot(scene.player.x - canonicalMap.spawn.x, scene.player.z - canonicalMap.spawn.z) < 12;
  $("#zone").textContent = safe ? "КОЛОНИЯ" : "МИР AWPLANET";
  $(".tiny").textContent = safe ? "БЕЗОПАСНАЯ ЗОНА" : "ДИКАЯ МЕСТНОСТЬ";
  drawMap($("#minimap"));
}, 200);
$("#minimap").onclick = (e) => {
  if (!self) return;
  const c = $<HTMLCanvasElement>("#minimap"),
    r = c.getBoundingClientRect();
  scene.destination = {
    x:
      scene.player.x +
      (((e.clientX - r.left) / r.width) * c.width - c.width / 2) / 2,
    z:
      scene.player.z +
      (((e.clientY - r.top) / r.height) * c.height - c.height / 2) / 2,
  };
};
async function init() {
  try {
    world = await api("/api/world");
    scene.updateEntities(world.entities);
    const session = await api("/api/session");
    if (session.player) {
      self = session.player;
      connect();
    } else {
      $("#connection").textContent = "КОЛОНИЯ ОНЛАЙН";
      $("#status-dot").classList.add("connected");
    }
  } catch (e) {
    $("#connection").textContent = "КОЛОНИЯ НЕДОСТУПНА";
    $("#auth-error").textContent =
      "Сервер временно недоступен. Обнови страницу через минуту.";
  }
}
void init();
