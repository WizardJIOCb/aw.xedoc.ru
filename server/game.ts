import { randomUUID } from "node:crypto";
import type {
  ChatLine,
  CombatEvent,
  Entity,
  ItemDef,
  Player,
  PlayerRole,
  RecipeDef,
  Snapshot,
  WorldData,
} from "../src/shared/types.js";
import type { Bag, SavedState } from "./persist.js";
import type { CanonicalMapData } from "../src/shared/canonical-map.js";
import { mapIndex, terrainCombatClear, terrainSegmentClear, terrainWalkable } from "../src/shared/canonical-map.js";
import { closestWalkable, mapVersion } from "./canonical-world.js";
import { boundedXp, levelForXp, xpForLevel, derivedAttributes } from "../src/shared/progression.js";
import objectMetadata from "../data/reference/object-metadata.json";
const originalObjects = new Map(objectMetadata.map(d => [d.originalId, d]));

export type ActionMessage = {
  type?: string;
  action: string;
  target?: string;
  item?: string;
  recipe?: string;
  quantity?: number;
  value?: string | number;
  player?: string;
};
export type Notice = {
  type: "notice";
  text: string;
  kind: "info" | "success" | "error";
};
export class GameError extends Error {}
const WORLD_LIMIT = 120;
const SPEED = 7;
const SAFE_RADIUS = 24;
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const own = (object: object, key: string) =>
  Object.prototype.hasOwnProperty.call(object, key);
const copy = <T>(v: T): T => structuredClone(v);

export class Game {
  readonly items: Map<string, ItemDef>;
  readonly recipes: Map<string, RecipeDef>;
  readonly messages: ChatLine[] = [];
  private combatTargets = new Map<string, string>();
  private combatEvents: CombatEvent[] = [];
  private eventSequence = 0;
  private movementAt = new Map<string, number>();
  private cooldown = new Map<string, number>();
  private aggressors = new Map<
    string,
    { playerId: string; until: number; hitAt: number }
  >();
  private lastTick: number;
  private lastChat = new Map<string, number>();
  constructor(
    readonly world: WorldData,
    readonly state: SavedState,
    private now: () => number = Date.now,
    private notice: (id: string, message: Notice) => void = () => {},
    private changed: () => void = () => {},
    readonly map?: CanonicalMapData,
  ) {
    this.items = new Map(world.items.map((item) => [item.id, item]));
    this.recipes = new Map(world.recipes.map((recipe) => [recipe.id, recipe]));
    this.lastTick = now();
    const migratingMap = !!map && state.mapVersion !== mapVersion(map);
    if (migratingMap) {
      // Keep accounts, inventories, bank, jobs and bag contents. The old demo coordinates
      // belong to a different world; relocate once and never on subsequent restarts.
      for (const player of Object.values(state.players)) Object.assign(player, map!.spawn);
      for (const entity of state.entities) if (entity.type === "loot")
        Object.assign(entity, closestWalkable(map!, { x: entity.x + map!.spawn.x, z: entity.z + map!.spawn.z - 8 }));
      state.mapVersion = mapVersion(map!);
    }
    // Merge newly introduced static content while retaining active resources and monsters.
    const saved = new Map(state.entities.map((entity) => [entity.id, entity]));
    state.entities = world.entities.map((definition) => {
      const current = copy(definition);
      const previous = migratingMap ? undefined : saved.get(definition.id);
      if (!map) return { ...current, ...previous };
      // Source properties come from the current catalogue on every restart. Only
      // dynamic state survives; older adapters must not pin stale aggression or HP.
      if (!previous || previous.type !== current.type) return current;
      if (current.type === "monster") {
        current.x = previous.x;
        current.z = previous.z;
        current.hp = clamp(previous.hp ?? current.maxHp!, 0, current.maxHp!);
        current.alive = previous.alive ?? true;
        current.respawnAt = previous.respawnAt;
      } else if (current.type === "resource") {
        current.stock = previous.stock ?? current.stock;
        current.alive = previous.alive ?? true;
        current.respawnAt = previous.respawnAt;
      }
      return current;
    });
    for (const entity of saved.values())
      if (entity.type === "loot" && state.bags[entity.id])
        state.entities.push(entity);
    for (const entity of state.entities) {
      if (entity.type === "monster") {
        entity.maxHp ??= 25;
        entity.hp ??= entity.maxHp;
        entity.alive ??= true;
      }
      if (entity.type === "resource") {
        entity.stock ??= 30;
        entity.alive ??= true;
      }
    }
    for (const player of Object.values(state.players)) {
      player.role = this.role(player.id);
      player.online = false;
      player.quest ??= {};
      player.stats ??= {
        strength: 5,
        agility: 5,
        endurance: 5,
        intellect: 5,
        intuition: 1,
      };
      player.mode ??= "controlled";
      player.clan ??= null;
      player.equipment ??= {};
      if (state.progressionVersion !== "forever-v1") {
        player.xp = boundedXp(Math.max(player.xp, xpForLevel(player.level)));
        for (const [skill, level] of Object.entries(player.skills)) {
          const key = `skillXp:${skill}`;
          player.quest[key] = boundedXp(Math.max(player.quest[key] ?? 0, xpForLevel(level)));
        }
      }
      player.level = levelForXp(player.xp);
      if (map) this.attributes(player);
      if (map && (!this.teleportCoordinatesValid(player.x, player.z) ||
        (player.role !== "admin" && !terrainWalkable(map, player.x, player.z)))) Object.assign(player, map.spawn);
      this.pruneEquipment(player);
      player.action = state.jobs[player.id]
        ? `Изготовление: ${this.recipes.get(state.jobs[player.id].recipeId)?.name ?? state.jobs[player.id].recipeId}`
        : undefined;
    }
    state.progressionVersion = "forever-v1";
  }

  createPlayer(id: string, name: string): Player {
    if (own(this.state.players, id))
      throw new GameError("Персонаж уже существует.");
    const inventory: Record<string, number> = {};
    const starterIds = [
      "bronze_sword",
      "bronze_pickaxe",
      "net",
      "bronze_axe",
      "knife",
      "sickle",
      "stone_knife",
      "bronze_dagger",
      "dagger",
      "pickaxe",
      "fishing_rod",
      "axe",
    ];
    for (const itemId of starterIds) {
      const item = this.items.get(itemId);
      if (
        item &&
        (!item.requires ||
          Object.values(item.requires).every((level) => level <= 1))
      )
        inventory[itemId] = 1;
    }
    let weapon = Object.keys(inventory).find((itemId) =>
      this.isWeapon(this.items.get(itemId)!),
    );
    if (!weapon) {
      const first = worldAccessible(this.world.items).find((item) =>
        this.isWeapon(item),
      );
      if (first) {
        weapon = first.id;
        inventory[first.id] = 1;
      }
    }
    const food =
      this.items.get("bread") ??
      worldAccessible(this.world.items).find((item) => (item.healing ?? 0) > 0);
    if (food) inventory[food.id] = 3;
    const skills = Object.fromEntries(
      this.world.professions.map((skill) => [skill.id, 1]),
    );
    for (const skill of [
      "piercing",
      "fencing",
      "heavy",
      "punching",
      "medieval",
      "automatic",
    ])
      skills[skill] = 1;
    const player: Player = {
      id,
      name,
      role: this.role(id),
      x: this.map?.spawn.x ?? 0,
      z: this.map?.spawn.z ?? 8,
      rotation: Math.PI,
      hp: 105,
      maxHp: 105,
      stamina: 100,
      maxStamina: 100,
      force: 100,
      credits: this.map ? 200 : 120,
      level: 1,
      xp: 0,
      skills,
      stats: {
        strength: 5,
        agility: 5,
        endurance: 5,
        intellect: 5,
        intuition: 1,
      },
      inventory,
      bank: {},
      equipped: weapon ?? null,
      equipment: {},
      mode: "controlled",
      pk: 0,
      quest: {},
      online: false,
      clan: null,
    };
    this.state.players[id] = player;
    if (this.map) {
      player.stats = { strength: 1, agility: 1, endurance: 1, intellect: 1, intuition: 1 };
      this.attributes(player);
      player.hp = player.maxHp;
      player.stamina = player.maxStamina;
      player.force = player.maxForce!;
    }
    this.changed();
    return player;
  }

  connect(id: string) {
    const player = this.player(id);
    player.online = true;
    if (!this.movementAt.has(id)) this.movementAt.set(id, this.now());
    this.changed();
  }
  disconnect(id: string) {
    this.combatTargets.delete(id);
    const player = this.state.players[id];
    if (player) {
      player.online = false;
      this.changed();
    }
  }
  player(id: string) {
    if (!own(this.state.players, id))
      throw new GameError("Персонаж не найден.");
    const player = this.state.players[id];
    // This public mirror never authorizes privileges. Only the saved account does.
    player.role = this.role(id);
    return player;
  }

  private role(id: string): PlayerRole {
    return own(this.state.accounts, id) && this.state.accounts[id].role === "admin" ? "admin" : "player";
  }

  private teleportCoordinatesValid(x: unknown, z: unknown): boolean {
    if (!number(x) || !number(z)) return false;
    if (this.map) {
      const minimum = -this.map.layout.origin;
      return (x as number) >= minimum && (x as number) < this.map.layout.width - this.map.layout.origin &&
        (z as number) >= minimum && (z as number) < this.map.layout.height - this.map.layout.origin;
    }
    return Math.abs(x as number) <= WORLD_LIMIT && Math.abs(z as number) <= WORLD_LIMIT;
  }

  adminTeleport(id: string, x: unknown, z: unknown) {
    const player = this.player(id);
    if (this.role(id) !== "admin") throw new GameError("Телепортация доступна только администраторам.");
    if (!player.online) throw new GameError("Подключитесь к миру.");
    if (!this.teleportCoordinatesValid(x, z)) throw new GameError(this.map
      ? `Координаты должны быть числами от -${this.map.layout.origin} включительно до ${this.map.layout.width - this.map.layout.origin} исключительно.`
      : `Координаты должны быть числами от -${WORLD_LIMIT} до ${WORLD_LIMIT}.`);
    this.combatTargets.delete(id);
    for (const [enemyId, aggro] of this.aggressors)
      if (aggro.playerId === id) this.aggressors.delete(enemyId);
    // A craft job retains its reserved inputs and finishes exactly once. Warping
    // neither cancels the job nor grants health, stamina, XP or inventory.
    if (!this.state.jobs[id]) player.action = undefined;
    player.x = x as number;
    player.z = z as number;
    this.movementAt.set(id, this.now());
    this.changed();
    this.say(id, `Телепортация: ${player.x.toFixed(2)}, ${player.z.toFixed(2)}.`, "success");
    return { x: player.x, z: player.z };
  }

  move(id: string, x: unknown, z: unknown, rotation: unknown, running = false) {
    const player = this.player(id);
    if (!number(x) || !number(z) || !number(rotation))
      throw new GameError("Некорректные координаты.");
    const at = this.now();
    const elapsed = clamp(
      (at - (this.movementAt.get(id) ?? at)) / 1000,
      0,
      0.25,
    );
    this.movementAt.set(id, at);
    // A stationary reconciliation packet after an administrative edge warp must
    // not silently drag its coordinate back into the ordinary walking bounds.
    if (player.x === x && player.z === z) {
      player.rotation = (rotation as number) % (Math.PI * 2);
      this.changed();
      return;
    }
    const wanted = {
      x: clamp(x as number, -(this.map?.layout.limit ?? WORLD_LIMIT), this.map?.layout.limit ?? WORLD_LIMIT),
      z: clamp(z as number, -(this.map?.layout.limit ?? WORLD_LIMIT), this.map?.layout.limit ?? WORLD_LIMIT),
    };
    const length = dist(player, wanted);
    const runningNow = running && player.stamina > 0;
    const limit = (this.map ? runningNow ? 2 : 1 : SPEED) * elapsed;
    if (length > 0) {
      const ratio = Math.min(1, limit / length);
      const next = { x: player.x + (wanted.x - player.x) * ratio, z: player.z + (wanted.z - player.z) * ratio };
      if (!this.map || terrainSegmentClear(this.map, player, next)) {
        if (this.map && runningNow) {
          player.quest.runDistance = (player.quest.runDistance ?? 0) + dist(player, next);
          if (player.quest.runDistance >= 10) { player.stamina = Math.max(0, player.stamina - Math.floor(player.quest.runDistance / 10)); player.quest.runDistance %= 10; }
        }
        Object.assign(player, next);
        this.changed();
      }
    }
    player.rotation = (rotation as number) % (Math.PI * 2);
  }

  action(id: string, message: ActionMessage) {
    const player = this.player(id);
    if (!player.online) throw new GameError("Подключитесь к миру.");
    if (
      this.state.jobs[id] &&
      !["mode", "forceMode", "talk", "clan", "disengage"].includes(
        message.action,
      )
    )
      throw new GameError("Дождитесь завершения изготовления.");
    switch (message.action) {
      case "engage": {
        const enemy = this.entity(message.target);
        if (
          enemy.type !== "monster" ||
          enemy.alive === false ||
          (enemy.hp ?? 0) <= 0
        )
          throw new GameError("Противник недоступен.");
        this.near(player, enemy, 6);
        this.combatTargets.set(id, enemy.id);
        break;
      }
      case "disengage":
        this.combatTargets.delete(id);
        break;
      case "gather":
        this.gather(player, message.target);
        break;
      case "attack":
        this.attack(player, message.target ?? message.player);
        break;
      case "craft":
        this.craft(player, message.recipe);
        break;
      case "equip":
        this.equip(player, message.item);
        break;
      case "use":
        this.use(player, message.item);
        break;
      case "bankDeposit":
        this.bank(player, message.item, message.quantity, true);
        break;
      case "bankWithdraw":
        this.bank(player, message.item, message.quantity, false);
        break;
      case "buy":
        this.shop(player, message.item, message.quantity, true);
        break;
      case "sell":
        this.shop(player, message.item, message.quantity, false);
        break;
      case "talk":
        this.talk(player, message.target);
        break;
      case "mode":
        this.setMode(player, message.value);
        break;
      case "forceMode":
        this.setForce(player, message.value);
        break;
      case "trade":
        this.trade(player, message);
        break;
      case "clan":
        this.clan(player, message.value);
        break;
      default:
        throw new GameError("Неизвестное действие.");
    }
    this.changed();
  }

  snapshot(id: string): Snapshot {
    const self = copy(this.player(id));
    self.combatTarget = this.combatTargets.get(id);
    // Other players' private inventory, bank, skills and quest state never cross the wire.
    const players = Object.values(this.state.players)
      .filter((p) => p.online && p.id !== id && (!this.map || dist(self, p) < 55))
      .map((p) => ({
        ...copy(p),
        inventory: {},
        bank: {},
        quest: {},
        skills: {},
        stats: {},
      }));
    const at = this.now();
    const entities = this.state.entities.filter(
      (e) =>
        (!this.map || dist(self, e) < 55) && (
        e.type !== "loot" ||
        !this.state.bags[e.id] ||
        this.state.bags[e.id].owner === id ||
        this.state.bags[e.id].privateUntil <= at),
    );
    return {
      type: "snapshot",
      self,
      players,
      entities: copy(entities),
      messages: copy(this.messages),
      time: at,
      online: Object.values(this.state.players).filter(p => p.online).length,
      events: this.combatEvents
        .filter((event) => at - event.at < 3000)
        .map(copy),
    };
  }

  chat(id: string, text: unknown) {
    const player = this.player(id);
    if (typeof text !== "string") throw new GameError("Введите сообщение.");
    const clean = text
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .trim()
      .slice(0, 280);
    if (!clean) return;
    if (this.now() - (this.lastChat.get(id) ?? -Infinity) < 700)
      throw new GameError("Чуть медленнее, пожалуйста.");
    this.lastChat.set(id, this.now());
    this.messages.push({
      id: randomUUID(),
      name: player.name,
      text: clean,
      at: this.now(),
      channel: "world",
    });
    this.messages.splice(0, Math.max(0, this.messages.length - 50));
  }

  tick() {
    const at = this.now();
    const dt = clamp((at - this.lastTick) / 1000, 0, 2);
    this.lastTick = at;
    let changed = false;
    for (const player of Object.values(this.state.players)) {
      if (player.online) {
        if (dt > 0) changed = true;
        if (this.map) {
          player.quest.recoveryMs = (player.quest.recoveryMs ?? 0) + dt * 1000;
          if (player.quest.recoveryMs >= 60000) {
            const recovery = Math.floor(player.quest.recoveryMs / 60000);
            player.stamina = Math.min(player.maxStamina, player.stamina + recovery);
            player.hp = Math.min(player.maxHp, player.hp + recovery);
            player.quest.recoveryMs %= 60000;
          }
        } else player.stamina = Math.min(player.maxStamina, player.stamina + dt * 5);
        const forceMode = player.quest.forceMode ?? 0;
        player.force = clamp(
          player.force + dt * (forceMode ? -2 : 1.25),
          0,
          player.maxForce ?? 100,
        );
        if (!player.force && forceMode) {
          player.quest.forceMode = 0;
          this.say(player.id, "Форс-энергия закончилась.", "info");
        }
        if ((!this.map && this.safe(player)) || forceMode === 1)
          player.hp = Math.min(
            player.maxHp,
            player.hp + dt * (forceMode === 1 ? 2.5 : 0.6),
          );
      }
      const job = this.state.jobs[player.id];
      if (job && job.completeAt <= at) {
        for (const [item, count] of Object.entries(job.outputs))
          this.add(player.inventory, item, count);
        const recipe = this.recipes.get(job.recipeId);
        if (recipe) this.gain(player, recipe.skill, 18);
        player.action = undefined;
        delete this.state.jobs[player.id];
        this.say(
          player.id,
          `Готово: ${recipe?.name ?? job.recipeId}.`,
          "success",
        );
        changed = true;
      }
    }
    // An engage packet only selects a target. Damage is resolved once per simulation step,
    // with the same weapon cooldown/proximity checks as keyboard attacks.
    for (const [id, target] of this.combatTargets) {
      const player = this.state.players[id],
        enemy = this.state.entities.find((e) => e.id === target);
      if (
        !player?.online ||
        !enemy ||
        enemy.alive === false ||
        (enemy.hp ?? 0) <= 0 ||
        this.state.jobs[id]
      ) {
        this.combatTargets.delete(id);
        continue;
      }
      if (dist(player, enemy) > 5) {
        this.combatTargets.delete(id);
        continue;
      }
      if ((this.cooldown.get(`${id}:attack`) ?? 0) > at || (!this.map && player.stamina < 8))
        continue;
      try {
        this.attack(player, target);
        changed = true;
      } catch (error) {
        this.combatTargets.delete(id);
        if (error instanceof GameError) this.say(id, error.message, "error");
        else throw error;
      }
      if ((enemy.hp ?? 0) <= 0) this.combatTargets.delete(id);
    }
    for (const entity of this.state.entities) {
      if (
        entity.respawnAt &&
        entity.respawnAt <= at &&
        entity.type !== "loot"
      ) {
        const original = this.world.entities.find((e) => e.id === entity.id);
        entity.alive = true;
        entity.hp = entity.maxHp;
        entity.stock = original?.stock ?? 30;
        entity.respawnAt = undefined;
        if (original) {
          entity.x = original.x;
          entity.z = original.z;
        }
        this.aggressors.delete(entity.id);
        changed = true;
      }
      if (entity.type !== "monster" || entity.alive === false) continue;
      let aggro = this.aggressors.get(entity.id);
      if (
        aggro &&
        (!this.state.players[aggro.playerId]?.online || aggro.until < at)
      ) {
        this.aggressors.delete(entity.id);
        aggro = undefined;
      }
      if (!aggro && entity.state === "aggressive") {
        const victim = Object.values(this.state.players).find(
          (p) =>
            p.online &&
            dist(p, entity) <= 7 &&
            !this.safe(p),
        );
        if (victim) {
          aggro = { playerId: victim.id, until: at + 12000, hitAt: at + 900 };
          this.aggressors.set(entity.id, aggro);
        }
      }
      if (aggro) {
        const victim = this.state.players[aggro.playerId];
        const distance = dist(entity, victim);
        if (
          distance > (this.map ? (entity.attackRange ?? 1) * .8 : 2.4) &&
          distance < 18 &&
          !this.safe(victim)
        ) {
          const step = Math.min(distance - (this.map ? (entity.attackRange ?? 1) * .8 : 2.4), dt * (this.map ? 2 : 2.2));
          const next = { x: entity.x + ((victim.x - entity.x) / distance) * step, z: entity.z + ((victim.z - entity.z) / distance) * step };
          if (!this.map || terrainSegmentClear(this.map, entity, next)) Object.assign(entity, next);
        }
        if (aggro.hitAt <= at && (this.map ? !this.safe(victim) && terrainCombatClear(this.map, entity, victim, entity.attackRange ?? 1) : dist(entity, victim) <= 5)) {
          const defense = victim.mode === "defensive" ? 0.65 : 1;
          const forceDefense = this.forceDefense(victim);
          victim.hp -= Math.max(
            1,
            Math.round(
              (entity.damage?.reduce((n, d) => n + d.amount, 0) || (4 + (entity.level ?? 1) * 1.6)) *
                defense *
                forceDefense *
                this.armorDefense(victim),
            ),
          );
          this.recordHit(
            entity.id,
            victim.id,
            Math.max(
              1,
              Math.round(
                (entity.damage?.reduce((n, d) => n + d.amount, 0) || (4 + (entity.level ?? 1) * 1.6)) *
                  defense *
                  forceDefense *
                  this.armorDefense(victim),
              ),
            ),
          );
          aggro.hitAt = at + 1000;
          if (victim.hp <= 0) this.die(victim);
          changed = true;
        }
      }
    }
    for (const [bagId, bag] of Object.entries(this.state.bags))
      if (bag.expiresAt <= at) {
        this.removeBag(bagId);
        changed = true;
      }
    if (changed) this.changed();
  }

  die(player: Player) {
    this.combatTargets.delete(player.id);
    const inventory = copy(player.inventory);
    const job = this.state.jobs[player.id];
    if (job) {
      for (const [item, count] of Object.entries(job.inputs))
        this.add(inventory, item, count);
      delete this.state.jobs[player.id];
    }
    this.createBag(player, inventory, player.id, 0, `Вещи ${player.name}`);
    player.inventory = {};
    player.equipped = null;
    player.equipment = {};
    player.action = undefined;
    player.xp = Math.max(0, player.xp - Math.ceil(player.xp / 8));
    player.level = this.level(player.xp);
    if (this.map) {
      for (const [skill, level] of Object.entries(player.skills)) {
        const key = `skillXp:${skill}`, xp = player.quest[key] ?? xpForLevel(level);
        player.quest[key] = Math.max(0, xp - Math.ceil(xp / 8));
        player.skills[skill] = levelForXp(player.quest[key]);
      }
      for (const [stat, level] of Object.entries(player.stats)) {
        const key = `statXp:${stat}`, xp = player.quest[key] ?? xpForLevel(level);
        player.quest[key] = Math.max(0, xp - Math.ceil(xp / 8));
        player.stats[stat] = levelForXp(player.quest[key]);
      }
      this.attributes(player);
    }
    player.x = this.map?.spawn.x ?? 0;
    player.z = this.map?.spawn.z ?? 8;
    player.hp = player.maxHp;
    player.stamina = player.maxStamina;
    player.quest.forceMode = 0;
    for (const [id, aggro] of this.aggressors)
      if (aggro.playerId === player.id) this.aggressors.delete(id);
    this.movementAt.set(player.id, this.now());
    this.say(
      player.id,
      "Вы воскресли в Фармуне. Вещи остались на месте гибели, потеряна 1/8 опыта.",
      "error",
    );
    this.changed();
  }

  private gather(player: Player, target?: string) {
    const entity = this.entity(target);
    this.near(player, entity, 5);
    this.ready(player, "gather", 1100);
    if (entity.type === "loot") {
      const bag = this.state.bags[entity.id];
      if (!bag || (bag.owner !== player.id && bag.privateUntil > this.now()))
        throw new GameError("Добыча пока принадлежит другому игроку.");
      const weight = this.weight(bag.items);
      if (this.weight(player.inventory) + weight > this.capacity(player))
        throw new GameError("В сумке не хватает места.");
      for (const [item, count] of Object.entries(bag.items))
        this.add(player.inventory, item, count);
      this.removeBag(entity.id);
      this.say(player.id, "Вещи подобраны.", "success");
      return;
    }
    if (
      entity.type !== "resource" ||
      !entity.resource ||
      !this.items.has(entity.resource)
    )
      throw new GameError("Здесь нечего добывать.");
    if (entity.alive === false || (entity.stock ?? 0) <= 0)
      throw new GameError("Ресурс восстанавливается.");
    if (!this.map && player.stamina < 3) throw new GameError("Не хватает тонуса.");
    const item = this.items.get(entity.resource)!;
    if (item.requires) this.requirements(player, item.requires);
    this.checkWeight(player, { [item.id]: 1 });
    if (!this.map) player.stamina -= 3;
    this.add(player.inventory, item.id, 1);
    entity.stock = (entity.stock ?? 30) - 1;
    if (entity.stock <= 0) {
      entity.alive = false;
      entity.respawnAt = this.now() + 60000;
    }
    const skill =
      item.skill ??
      (/ore|stone|mineral/.test(item.id)
        ? "geology"
        : /fish/.test(item.id)
          ? "fishing"
          : /wood|log|timber/.test(item.id)
            ? "woodwork"
            : "herbalism");
    this.gain(player, skill, 12);
    if (skill === "geology")
      player.quest.bobOre = (player.quest.bobOre ?? 0) + 1;
    this.say(
      player.id,
      `+1 ${item.name}. ${this.skillName(skill)} +12 опыта.`,
      "success",
    );
  }

  private attack(player: Player, target?: string) {
    if (target && own(this.state.players, target)) {
      const victim = this.player(target);
      if (victim.id === player.id || !victim.online)
        throw new GameError("Цель недоступна.");
      if (player.level < 10 || victim.level < 10)
        throw new GameError(
          "PvP открывается с боевого уровня 10 у обоих игроков.",
        );
      if (
        this.safe(player) || this.safe(victim)
      )
        throw new GameError("Фармун — безопасная зона.");
      this.near(player, victim, 5);
      if (this.map) this.weaponReach(player, victim);
      this.ready(player, "attack", 1000);
      if (!this.map && player.stamina < 8) throw new GameError("Не хватает тонуса.");
      if (!this.map) player.stamina -= 8;
      player.pk += 1;
      victim.hp -= Math.max(
        1,
        Math.round(
          this.damage(player) *
            (victim.mode === "defensive" ? 0.7 : 1) *
            this.forceDefense(victim) *
            this.armorDefense(victim),
        ),
      );
      this.recordHit(
        player.id,
        victim.id,
        Math.max(
          1,
          Math.round(
            this.damage(player) *
              (victim.mode === "defensive" ? 0.7 : 1) *
              this.forceDefense(victim) *
              this.armorDefense(victim),
          ),
        ),
      );
      this.say(victim.id, `${player.name} атакует вас!`, "error");
      if (victim.hp <= 0) this.die(victim);
      return;
    }
    const enemy = this.entity(target);
    if (
      enemy.type !== "monster" ||
      enemy.alive === false ||
      (enemy.hp ?? 0) <= 0
    )
      throw new GameError("Противник недоступен.");
    this.near(player, enemy, 5);
    if (this.map) this.weaponReach(player, enemy);
    this.ready(player, "attack", 1000);
    if (!this.map && player.stamina < 8) throw new GameError("Не хватает тонуса.");
    if (!this.map) player.stamina -= 8;
    const damage = this.damage(player);
    enemy.hp = Math.max(0, (enemy.hp ?? 25) - damage);
    this.recordHit(player.id, enemy.id, damage);
    const aggro = this.aggressors.get(enemy.id);
    this.aggressors.set(enemy.id, {
      playerId: player.id,
      until: this.now() + 20000,
      hitAt: aggro?.hitAt ?? this.now() + (this.map ? 1000 : 850),
    });
    if (this.map) this.combatXp(player, damage);
    else this.gain(player, this.items.get(player.equipped ?? "")?.skill ?? "punching", 8);
    if (enemy.hp <= 0) {
      enemy.alive = false;
      enemy.respawnAt = this.now() + 35000;
      this.aggressors.delete(enemy.id);
      if (!this.map) this.gain(player, "combat", 30 + (enemy.level ?? 1) * 8);
      const drop =
        this.items.get(enemy.resource ?? "") ??
        this.world.items.find((i) =>
          /raw_meat|meat_raw|raw_chicken|chicken_meat/.test(i.id),
        );
      const items: Record<string, number> = {};
      if (drop) items[drop.id] = 1;
      this.createBag(enemy, items, player.id, 30000, `Добыча: ${enemy.name}`);
      player.credits += 3 + (enemy.level ?? 1);
      this.say(
        player.id,
        `${enemy.name} побеждён. Добыча ваша в течение 30 секунд.`,
        "success",
      );
    }
  }

  private craft(player: Player, recipeId?: string) {
    const recipe = this.recipes.get(recipeId ?? "");
    if (!recipe) throw new GameError("Рецепт не найден.");
    if ((player.skills[recipe.skill] ?? 1) < recipe.level)
      throw new GameError(
        `${this.skillName(recipe.skill)}: нужен уровень ${recipe.level}.`,
      );
    const requirements = (
      recipe as RecipeDef & { requires?: Record<string, number> }
    ).requires;
    if (requirements) this.requirements(player, requirements);
    if (recipe.station && recipe.station !== "none") {
      const station = this.state.entities.find(
        (e) =>
          (e.type === "station" || e.type === "npc") &&
          (e.id === recipe.station ||
            e.state === recipe.station ||
            e.capabilities?.includes(recipe.station) ||
            e.id === `station_${recipe.station}`) &&
          dist(player, e) <= 6,
      );
      if (!station)
        throw new GameError("Подойдите к подходящему станку или костру.");
    }
    for (const [item, count] of Object.entries(recipe.inputs))
      if ((player.inventory[item] ?? 0) < count)
        throw new GameError(
          `Нужен предмет: ${this.items.get(item)?.name ?? item} ×${count}.`,
        );
    const netWeight = this.weight(recipe.outputs) - this.weight(recipe.inputs);
    if (this.weight(player.inventory) + netWeight > this.capacity(player))
      throw new GameError("Готовые предметы не поместятся в сумку.");
    for (const [item, count] of Object.entries(recipe.inputs))
      this.remove(player.inventory, item, count);
    this.pruneEquipment(player);
    this.state.jobs[player.id] = {
      playerId: player.id,
      recipeId: recipe.id,
      completeAt: this.now() + Math.max(0.2, recipe.seconds) * 1000,
      inputs: copy(recipe.inputs),
      outputs: copy(recipe.outputs),
    };
    player.action = `Изготовление: ${recipe.name}`;
    this.say(
      player.id,
      `Изготавливаю: ${recipe.name} (${recipe.seconds} с).`,
      "info",
    );
  }

  private equip(player: Player, itemId?: string) {
    if (!itemId || !player.inventory[itemId])
      throw new GameError("Предмета нет в сумке.");
    const item = this.items.get(itemId);
    if (!item || (!this.isWeapon(item) && item.kind !== "armor"))
      throw new GameError("Этот предмет нельзя экипировать.");
    if (item.requires) this.requirements(player, item.requires);
    if (item.kind === "armor") {
      const slot = this.armorSlot(item);
      player.equipment ??= {};
      const remove = player.equipment[slot] === item.id;
      if (remove) delete player.equipment[slot];
      else player.equipment[slot] = item.id;
      this.say(
        player.id,
        `${remove ? "Снято" : "Надето"}: ${item.name}.`,
        "success",
      );
      return;
    }
    player.equipped = itemId;
    this.say(player.id, `В руках: ${item.name}.`, "success");
  }
  private use(player: Player, itemId?: string) {
    const item = this.items.get(itemId ?? "");
    if (!item || !player.inventory[item.id])
      throw new GameError("Предмета нет в сумке.");
    if (!item.healing) throw new GameError("Этот предмет нельзя съесть.");
    if (player.hp >= player.maxHp)
      throw new GameError("Здоровье уже восстановлено.");
    this.ready(player, "use", 1000);
    this.remove(player.inventory, item.id, 1);
    player.hp = Math.min(player.maxHp, player.hp + item.healing);
    this.say(player.id, `${item.name}: +${item.healing} здоровья.`, "success");
  }
  private bank(
    player: Player,
    itemId: string | undefined,
    quantity: number | undefined,
    deposit: boolean,
  ) {
    this.stationNear(player, /bank|банк/i);
    const item = this.validItem(itemId);
    const count = this.quantity(quantity);
    const source = deposit ? player.inventory : player.bank;
    const destination = deposit ? player.bank : player.inventory;
    if ((source[item.id] ?? 0) < count)
      throw new GameError("Недостаточно предметов.");
    if (!deposit) this.checkWeight(player, { [item.id]: count });
    this.remove(source, item.id, count);
    this.add(destination, item.id, count);
    this.pruneEquipment(player);
    this.say(
      player.id,
      `${deposit ? "В банке" : "В сумке"}: ${item.name} ×${count}.`,
      "success",
    );
  }
  private shop(
    player: Player,
    itemId: string | undefined,
    quantity: number | undefined,
    buy: boolean,
  ) {
    this.stationNear(player, /trader|shop|торгов|магазин/i);
    const item = this.validItem(itemId);
    const count = this.quantity(quantity);
    const unit = buy
      ? Math.max(1, Math.ceil(item.value))
      : Math.max(1, Math.floor(item.value / 2));
    const price = unit * count;
    if (buy) {
      if (player.credits < price) throw new GameError("Не хватает кредитов.");
      this.checkWeight(player, { [item.id]: count });
      player.credits -= price;
      this.add(player.inventory, item.id, count);
    } else {
      if ((player.inventory[item.id] ?? 0) < count)
        throw new GameError("В сумке недостаточно предметов.");
      this.remove(player.inventory, item.id, count);
      player.credits += price;
      this.pruneEquipment(player);
    }
    this.say(
      player.id,
      `${buy ? "Куплено" : "Продано"}: ${item.name} ×${count}, ${price} кредитов.`,
      "success",
    );
  }
  private talk(player: Player, target?: string) {
    const npc = this.entity(target);
    this.near(player, npc, 6);
    if (npc.type !== "npc" && npc.type !== "station")
      throw new GameError("Здесь некому говорить.");
    if (/bob|боб/i.test(npc.id + npc.name)) {
      if (!player.quest.bobStarted) {
        player.quest.bobStarted = 1;
        this.say(
          player.id,
          "Боб: добудь 5 единиц любой руды и принеси их мне. Руда нужна в сумке. Награда: 75 кредитов и опыт геологии.",
          "info",
        );
      } else if (!player.quest.bobComplete) {
        const ores = Object.entries(player.inventory).filter(([id]) =>
          /ore|руда/i.test(id + (this.items.get(id)?.name ?? "")),
        );
        if (ores.reduce((sum, [, count]) => sum + count, 0) < 5) {
          this.say(
            player.id,
            "Боб: жду 5 единиц руды. Начни с олова: для него достаточно первого уровня геологии.",
            "info",
          );
          return;
        }
        let left = 5;
        for (const [item, count] of ores) {
          const remove = Math.min(count, left);
          this.remove(player.inventory, item, remove);
          left -= remove;
          if (!left) break;
        }
        player.quest.bobComplete = 1;
        player.credits += 75;
        this.gain(player, "geology", 60);
        this.say(
          player.id,
          "Боб: хорошая работа! +75 кредитов, +60 опыта геологии.",
          "success",
        );
      } else
        this.say(
          player.id,
          "Боб: теперь попробуй плавку и кузнечный пресс. Сложные сплавы требуют навыков.",
          "info",
        );
    } else if (/bank|банк/i.test(npc.id + npc.name))
      this.say(
        player.id,
        "Банк: вещи в хранилище сохранятся после гибели. Выбери предмет в сумке или банке.",
        "info",
      );
    else if (/trader|shop|торгов|магазин/i.test(npc.id + npc.name))
      this.say(
        player.id,
        "Торговец: покупаю за половину цены. Выбери предмет и количество.",
        "info",
      );
    else
      this.say(
        player.id,
        `${npc.name}: добро пожаловать в Фармун. За границей поселения водятся опасные существа.`,
        "info",
      );
  }
  private setMode(player: Player, value: unknown) {
    const aliases: Record<string, string> = {
      offensive: "offensive",
      defensive: "defensive",
      controlled: "controlled",
      attack: "offensive",
      defense: "defensive",
      balanced: "controlled",
    };
    if (typeof value !== "string" || !own(aliases, value))
      throw new GameError(
        "Выберите наступательный, оборонительный или управляемый режим.",
      );
    player.mode = aliases[value];
    this.say(player.id, `Режим боя: ${player.mode}.`, "info");
  }
  private setForce(player: Player, value: unknown) {
    const modes = [
      "off",
      "regeneration",
      "accuracy",
      "reaction",
      "protection",
      "shock",
      "berserk",
      "defense",
      "offense",
      "forceProtection",
    ];
    const index =
      typeof value === "number" ? value : modes.indexOf(String(value));
    const required = [0, 1, 5, 10, 15, 20, 25, 30, 35, 40];
    if (!Number.isInteger(index) || index < 0 || index > 9)
      throw new GameError("Форс-режим не найден.");
    if ((player.stats.intuition ?? 1) < required[index])
      throw new GameError(`Нужна интуиция ${required[index]}.`);
    if (index && player.force < 5)
      throw new GameError("Не хватает форс-энергии.");
    player.quest.forceMode = index;
    this.say(player.id, `Форс-режим: ${modes[index]}.`, "info");
  }
  private trade(player: Player, message: ActionMessage) {
    const target = message.player ?? message.target;
    if (!target || target === player.id || !own(this.state.players, target))
      throw new GameError("Выберите другого игрока.");
    const recipient = this.player(target);
    if (!recipient.online) throw new GameError("Игрок вышел из мира.");
    this.near(player, recipient, 5);
    const item = this.validItem(message.item);
    const quantity = this.quantity(message.quantity);
    if ((player.inventory[item.id] ?? 0) < quantity)
      throw new GameError("Недостаточно предметов.");
    if (this.state.jobs[recipient.id])
      throw new GameError("Другой игрок занят изготовлением.");
    this.checkWeight(recipient, { [item.id]: quantity });
    this.remove(player.inventory, item.id, quantity);
    this.add(recipient.inventory, item.id, quantity);
    this.pruneEquipment(player);
    this.say(
      player.id,
      `${recipient.name} получил ${item.name} ×${quantity}.`,
      "success",
    );
    this.say(
      recipient.id,
      `${player.name} передал вам ${item.name} ×${quantity}.`,
      "success",
    );
  }
  private clan(player: Player, value: unknown) {
    if (value === "leave") {
      player.clan = null;
      this.say(player.id, "Вы вышли из клана.", "info");
      return;
    }
    if (typeof value !== "string")
      throw new GameError("Введите название клана.");
    const name = value.replace(/^(create|join):/, "").trim();
    if (!/^[\p{L}\p{N} _-]{3,24}$/u.test(name))
      throw new GameError("Название клана: 3–24 буквы, цифры, пробелы.");
    const existing = Object.values(this.state.players).some(
      (p) => p.clan?.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (value.startsWith("create:") && existing)
      throw new GameError("Клан с таким именем уже существует.");
    if (value.startsWith("join:") && !existing)
      throw new GameError("Такого клана пока нет.");
    player.clan = name;
    this.say(
      player.id,
      `Клан: ${name}. В этой сборке кланы открыты для вступления.`,
      "success",
    );
  }

  private level(xp: number) {
    return levelForXp(xp);
  }
  private gain(player: Player, skill: string, xp: number) {
    player.xp = boundedXp(player.xp + xp);
    const previous = player.level;
    player.level = this.level(player.xp);
    const key = `skillXp:${skill}`;
    const existingXp = Math.max(
      player.quest[key] ?? 0,
      xpForLevel(player.skills[skill] ?? 1),
    );
    player.quest[key] = boundedXp(existingXp + xp);
    player.skills[skill] = levelForXp(player.quest[key]);
    if (this.map) {
      this.attributes(player);
      if (player.level > previous) this.say(player.id, `Боевой уровень ${player.level}!`, "success");
      return;
    }
    const stat = ["geology", "woodwork", "heavy"].includes(skill)
      ? "strength"
      : ["fishing", "tailoring", "fencing", "piercing"].includes(skill)
        ? "agility"
        : "intellect";
    if (
      skill === "combat" ||
      [
        "punching",
        "piercing",
        "fencing",
        "heavy",
        "medieval",
        "automatic",
      ].includes(skill)
    ) {
      if (player.mode !== "defensive")
        player.stats.strength = 5 + Math.floor(player.xp / 200);
      if (player.mode !== "offensive")
        player.stats.agility = 5 + Math.floor(player.xp / 200);
    } else
      player.stats[stat] = Math.max(
        player.stats[stat] ?? 5,
        5 + Math.floor(player.quest[key] / 100),
      );
    player.stats.endurance = 5 + Math.floor(player.xp / 300);
    player.stats.intuition = 1 + Math.floor(player.xp / 200);
    player.maxHp = 90 + player.stats.endurance * 2 + player.level * 5;
    player.maxStamina = 90 + player.stats.endurance * 2;
    if (this.map) this.attributes(player);
    if (player.level > previous)
      this.say(player.id, `Боевой уровень ${player.level}!`, "success");
  }
  private damage(player: Player) {
    const weapon = this.items.get(player.equipped ?? "");
    const mode =
      player.mode === "offensive"
        ? 1.25
        : player.mode === "defensive"
          ? 0.8
          : 1;
    const force =
      [1, 1, 1.1, 1, 1, 1.3, 1.45, 0.8, 1.4, 1][player.quest.forceMode ?? 0] ??
      1;
    return Math.max(
      1,
      Math.round(
        ((weapon?.damage ?? 4) +
          player.stats.strength * 0.45 +
          player.level * 0.6) *
          mode *
          force,
      ),
    );
  }
  private attributes(player: Player) {
    const previous = { hp: player.maxHp, stamina: player.maxStamina };
    Object.assign(player, derivedAttributes(player.stats));
    player.hp = Math.min(player.hp, player.maxHp);
    player.stamina = Math.min(player.stamina, player.maxStamina);
    if (player.maxHp > previous.hp) player.hp += player.maxHp - previous.hp;
    if (player.maxStamina > previous.stamina) player.stamina += player.maxStamina - previous.stamina;
  }
  private combatXp(player: Player, damage: number) {
    // Forever f585: primary experience depends on damage and combat mode.
    const award = (stat: string, amount: number) => {
      const key = `statXp:${stat}`;
      player.quest[key] = boundedXp(Math.max(player.quest[key] ?? 0, xpForLevel(player.stats[stat] ?? 1)) + Math.max(1, Math.trunc(amount)));
      player.stats[stat] = levelForXp(player.quest[key]);
    };
    award("endurance", Math.floor(damage / 2));
    if (player.quest.forceMode && player.force > 0) award("intuition", Math.floor(damage / 2));
    if (player.mode === "defensive") award("agility", damage);
    else if (player.mode === "offensive") award("strength", damage);
    else { award("strength", Math.floor(damage / 2)); award("agility", Math.floor(damage / 2)); }
    const weapon = this.items.get(player.equipped ?? "");
    const original = originalObjects.get(weapon?.originalId ?? -1);
    const xpPercent = original?.propertyModifiers.find(p => p.xpPercent > 0)?.xpPercent;
    if (!weapon) this.gain(player, "punching", Math.max(1, Math.floor(damage / 2)));
    else if (xpPercent) this.gain(player, weapon.skill ?? "punching", Math.max(1, Math.trunc(damage / 100 * xpPercent)));
    this.attributes(player);
  }
  private requirements(player: Player, requires: Record<string, number>) {
    for (const [skill, level] of Object.entries(requires)) {
      const statAlias: Record<string, string> = {
        intelligence: "intellect",
        dexterity: "agility",
        constitution: "endurance",
      };
      const actual =
        skill === "combat" || skill === "level"
          ? player.level
          : (player.stats[statAlias[skill] ?? skill] ??
            player.skills[skill] ??
            1);
      if (actual < level)
        throw new GameError(
          `${this.skillName(skill)}: нужен уровень ${level}.`,
        );
    }
  }
  private forceDefense(player: Player) {
    return (
      [1, 1, 1, 0.8, 0.75, 1, 1.2, 0.6, 1.2, 0.7][
        player.quest.forceMode ?? 0
      ] ?? 1
    );
  }
  private armorSlot(item: ItemDef) {
    if (/helmet|helm|шлем/i.test(item.id + item.name)) return "helmet";
    if (/shield|щит/i.test(item.id + item.name)) return "shield";
    if (/leggings|legs|понож|штаны/i.test(item.id + item.name)) return "legs";
    if (/gloves|перчат/i.test(item.id + item.name)) return "gloves";
    if (/boots|сапог|ботин/i.test(item.id + item.name)) return "boots";
    return "body";
  }
  private pruneEquipment(player: Player) {
    if (player.equipped && !player.inventory[player.equipped])
      player.equipped = null;
    for (const [slot, id] of Object.entries(player.equipment ?? {})) {
      if (!player.inventory[id] || this.items.get(id)?.kind !== "armor")
        delete player.equipment![slot];
    }
  }
  private armorDefense(player: Player) {
    const weights: Record<string, number> = {
      helmet: 0.8,
      body: 2,
      legs: 1.2,
      shield: 1.5,
      gloves: 0.4,
      boots: 0.5,
    };
    let rating = 0;
    for (const [slot, id] of Object.entries(player.equipment ?? {})) {
      const item = this.items.get(id);
      if (!item || item.kind !== "armor" || !player.inventory[id]) continue;
      const material = 1 + (item.requires?.combat ?? 1) / 12;
      rating += (weights[slot] ?? 1) * material;
    }
    // Reconstructed diminishing protection, capped at 75%; exact original defense formula is unknown.
    return Math.max(0.25, 1 / (1 + rating / 12));
  }
  private createBag(
    position: { x: number; z: number },
    items: Record<string, number>,
    owner: string,
    privacy: number,
    name: string,
  ) {
    if (!Object.keys(items).length) return;
    const id = `loot_${randomUUID()}`;
    const bag: Bag = {
      id,
      items,
      owner,
      privateUntil: this.now() + privacy,
      expiresAt: this.now() + 900000,
    };
    this.state.bags[id] = bag;
    this.state.entities.push({
      id,
      name,
      type: "loot",
      x: position.x,
      z: position.z,
      alive: true,
    });
  }
  private removeBag(id: string) {
    delete this.state.bags[id];
    this.state.entities = this.state.entities.filter((e) => e.id !== id);
  }
  private entity(id?: string) {
    const entity = this.state.entities.find((e) => e.id === id);
    if (!entity) throw new GameError("Цель не найдена.");
    return entity;
  }
  private near(
    player: Player,
    target: { x: number; z: number },
    range: number,
  ) {
    if (dist(player, target) > range) throw new GameError("Подойдите ближе.");
  }
  private stationNear(player: Player, name: RegExp) {
    if (
      !this.state.entities.some(
        (e) =>
          ["npc", "station"].includes(e.type) &&
          name.test(e.id + e.name + (e.role ?? "")) &&
          dist(player, e) <= 6,
      )
    )
      throw new GameError("Подойдите к банку или торговцу.");
  }
  private safe(point: { x: number; z: number }) {
    return dist(point, this.map?.spawn ?? { x: 0, z: 8 }) < (this.map ? 12 : SAFE_RADIUS);
  }
  private weaponReach(player: Player, target: { x: number; z: number }) {
    const original = originalObjects.get(this.items.get(player.equipped ?? "")?.originalId ?? -1), range = original?.range || 1;
    const a = mapIndex(player.x, player.z), b = mapIndex(target.x, target.z);
    if (Math.max(Math.abs(Math.floor(a / 512) - Math.floor(b / 512)), Math.abs(a % 512 - b % 512)) > range) throw new GameError("Подойдите в радиус оружия.");
    if (!terrainCombatClear(this.map!, player, target, range)) throw new GameError("Между вами и целью препятствие.");
  }
  private ready(player: Player, action: string, seconds: number) {
    const key = `${player.id}:${action}`;
    if ((this.cooldown.get(key) ?? 0) > this.now())
      throw new GameError("Действие ещё восстанавливается.");
    this.cooldown.set(key, this.now() + seconds);
  }
  private validItem(id?: string) {
    const item = this.items.get(id ?? "");
    if (!item) throw new GameError("Предмет не найден.");
    return item;
  }
  private quantity(value?: number) {
    const count = value ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 1000)
      throw new GameError("Количество: целое число от 1 до 1000.");
    return count;
  }
  private add(items: Record<string, number>, id: string, quantity: number) {
    items[id] = (own(items, id) ? items[id] : 0) + quantity;
  }
  private remove(items: Record<string, number>, id: string, quantity: number) {
    const left = (items[id] ?? 0) - quantity;
    if (left < 0) throw new GameError("Недостаточно предметов.");
    if (left) items[id] = left;
    else delete items[id];
  }
  private weight(items: Record<string, number>) {
    return Object.entries(items).reduce(
      (weight, [id, count]) =>
        weight + (this.items.get(id)?.weight ?? 1) * count,
      0,
    );
  }
  private capacity(player: Player) {
    return 45 + (player.stats.strength ?? 5) * 3;
  }
  private checkWeight(player: Player, items: Record<string, number>) {
    if (
      this.weight(player.inventory) + this.weight(items) >
      this.capacity(player)
    )
      throw new GameError("Сумка переполнена.");
  }
  private skillName(id: string) {
    return this.world.professions.find((skill) => skill.id === id)?.name ?? id;
  }
  private isWeapon(item: ItemDef) {
    return (
      item.kind === "weapon" || (item.damage ?? 0) > 0 || item.kind === "tool"
    );
  }
  private say(id: string, text: string, kind: Notice["kind"]) {
    this.notice(id, { type: "notice", text, kind });
  }
  private recordHit(attacker: string, target: string, damage: number) {
    this.combatEvents.push({
      id: ++this.eventSequence,
      attacker,
      target,
      damage,
      at: this.now(),
    });
    this.combatEvents.splice(0, Math.max(0, this.combatEvents.length - 48));
  }
}

function worldAccessible(items: ItemDef[]) {
  return items.filter(
    (item) =>
      !item.requires ||
      Object.values(item.requires).every((level) => level <= 1),
  );
}
