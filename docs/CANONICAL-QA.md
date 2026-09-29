# Canonical world checks

Checked locally on 30 September 2026 against `http://127.0.0.1:3190`.
The API reported simulation 2 Hz, snapshots 5 Hz, healthy persistence and
source package SHA-256
`9de0b9112f724166809ed91807333f806037721e45dba123e21056d15a63b848`.
These are checks of this implementation. Von Raven described a 0.5 s server
step for Classic in the [15 November 2010 interview](https://gamedev.ru/flame/forum/?id=140478).
The interview supports that historical cadence; these tests do not establish
complete collision/combat fidelity across all historical versions.

## Live HTTP and WebSocket

```powershell
node scripts/smoke-canonical.mjs http://127.0.0.1:3190
node scripts/smoke-canonical.mjs http://127.0.0.1:3190 --max-route=250
node scripts/smoke-canonical.mjs http://127.0.0.1:3190 --bank-only --max-route=250
node scripts/smoke-canonical.mjs http://127.0.0.1:3190 --combat-only --combat-target=aw:65054
```

The completed full run passed seven checks and skipped four in 15.50 s
(`1790721416771-127.0.0.1.json`, 250 m route cap, status **PARTIAL**).
It used a newly registered account with a random password, a real authenticated
WebSocket, periodic authoritative snapshots, ordinary movement and real actions.
It confirmed the API map's 512 by 512 cells, 13,085 placements, spawn beside Bob,
quest acceptance, repeated talk without an unearned reward, movement around
terrain walls and gathering one nearby flax resource. Final health remained OK.

After the shared movement helper was corrected, the focused automatic-combat
run passed its intended check (`1790722867495-127.0.0.1.json`, 69.258 s).
It followed **63.63 m with 520 ordinary movement packets**, each requested at
at most 1.8 m/s and each segment checked against the shared terrain rules.
The maximum requested step was 0.36 m. One `engage` packet against Scorpion
`aw:65054` produced **two server-driven hits of 5 damage**, separated by
**1,020 ms**. The player used defensive mode and the script could consume real
starter food if HP fell. Median observed snapshot spacing was 204 ms; final
health was OK. That focused run reports seven passes and four checks outside its
scope as SKIP, so the aggregate status remains PARTIAL. It establishes real
HTTP/WebSocket movement and automatic combat, not a mouse-controlled combat UI
success or coverage of bank/trader transactions.

A focused bank run actually registered and connected another ordinary account,
but skipped the long journey before sending movement: the live Zartul Elite
`aw:65042` at `(-129, -238)` blocked the conservative 7.5 m avoidance policy for
all five nearby bank candidates. Deposit and withdrawal were **not exercised
through the live API**. The static catalog marked that creature passive while
the persisted live snapshot still marked it aggressive; this discrepancy was
reported and corrected by refreshing source properties on load while retaining
dynamic progress. A later live snapshot confirmed the target scorpion passive
with source HP19 and level10. The script plans static NPCs through
`/api/world` because spatial snapshots intentionally omit NPCs beyond 55 m,
and overlays current local creature positions when avoiding aggressive groups.

The default route cap is 75 m. The trader, bank, completed Bob hand-in and two-hit
combat checks were explicitly skipped in that run. Their absence is not a pass.
The script uses shared `NavigationGrid`, `terrainWalkable` and
`terrainSegmentClear`, sends each move from the latest authoritative position
with `running=true`, and limits requested speed to 1.8 m/s. Tone exhaustion can
make the server apply the ordinary 1 m/s walking limit. It never edits persisted
state, changes server clocks or teleports players.

An earlier real run found a regression: novice maximum tone was below a legacy
gather cost, making gathering fail with `Не хватает тонуса`. The server was
corrected to its canonical tone rules, restarted, and the gathering check then
passed. The failed evidence was retained rather than overwritten.

Machine-readable local evidence under ignored `artifacts/canonical-smoke/`:

- `1790720472244-127.0.0.1.json`: initial failure after five passes, at gathering.
- `1790720969859-127.0.0.1.json`: current default run, seven passes, four skips.
- `1790720980268-127.0.0.1.json`: read-only 250 m route planning; a safe bank route
  of about 155.52 m exists, while no trader route met the avoidance policy.
- `1790721416771-127.0.0.1.json`: full 250 m run, seven passes, four explicit skips.
- `1790721727175-127.0.0.1.json`: focused bank scenario, six passes and five skips;
  route-rejection records identify the live Zartul Elite and blocked samples.
- `1790721783553-127.0.0.1.json`: retained failed attempt: an unoptimized avoidance
  planner spent 108.15 s without movement, then the final health fetch failed.
  Subsequent script planning uses spatial buckets rather than scanning every
  creature for every grid cell. This attempt is not bank success evidence.
- `1790722019444-127.0.0.1.json`: focused automatic-combat attempt, skipped without
  movement because a suitable safe melee route was unavailable. Its early
  version repeated the combat SKIP label; the final script corrects scenario
  labels and keeps one result per check.
- `1790722250680-127.0.0.1.json`: live target `aw:65054` is passive after metadata
  refresh, at its retained dynamic position `(-129, -226)`. A 62.69 m geometric
  melee approach exists; the default avoidance policy still skipped it.
- `1790722304847-127.0.0.1.json`: actual attempt along that explicitly selected
  route failed after 41 normal movement packets. The full diagonal
  `(-138.5, -217.5)` to `(-137.5, -218.5)` was planned as clear, but a fractional
  step near `(-138, -218)` failed the same terrain helper. No blocked packet was
  sent. The discrepancy was handed to the shared movement helper owner; it also
  affects real UI navigation and must not be hidden by a smoke-only detour.
- `1790722867495-127.0.0.1.json`: after the shared DDA correction, actual route
  and automatic combat pass; one engage, two 5-damage hits, 1,020 ms interval.

Passwords, cookies and session values are neither printed nor stored in these
reports. Test accounts remain because there is no account deletion API; sessions
are logged out after the run. Browser rendering/dialogue interaction, mouse
target selection, FPS and restart durability of the live process need separate
checks. The test file's restart check below is an in-memory saved-state roundtrip.

## Reachability from the canonical spawn

```powershell
node scripts/inspect-canonical-navigation.mjs http://127.0.0.1:3190
```

The audit flood-fills the same eight-neighbour navigation graph used by A*, with
1 m cells sampled at their centres, wall checks on each edge and corner cutting
disabled. The spawn is `(-141.5, -214.5)`. Its connected component contains
**32,614 of 152,785 walkable grid nodes**, with bounds X=-252.5..-5.5 and
Z=-253.5..-5.5. This is one component, not the whole original map.

| Runtime entity kind | Total retained placements | Within interaction range of the spawn component |
| ------------------- | ------------------------: | ----------------------------------------------: |
| Monsters            |                     1,571 |                                             265 |
| Resources           |                       688 |                                             233 |
| NPCs                |                       148 |                                              78 |
| Stations            |                        44 |                                              23 |
| Transitions         |                       152 |                                              38 |

Near flax placements `aw:58413`, `aw:56363`, `aw:56869` and Bob `aw:58407` are
reachable for interaction. A zero approach route length means already within
interaction range of a reachable cell; it does not mean standing on the object.
The nearest source scorpion placement `aw:66089` needs about 70.63 m of walking
to a 4 m approach; `aw:65054` has an approximately 15.01 m approach route.
Close combat needs a stricter weapon range and clear terrain line, so broad
interaction proximity is not proof of a usable melee position.

Before the DDA correction, a stricter 0.85 m approach to Scorpion `aw:65054` at
`(-128.5, -225.5)` was estimated at **61.23 m**. That earlier geometric example was:

```text
(-139.5,-217.5) -> (-138.5,-217.5) -> (-137.5,-218.5)
-> (-136.5,-219.5) -> (-135.5,-220.5) -> (-138.5,-224.5)
-> (-139.5,-232.5) -> (-139.5,-234.5) -> (-130.5,-234.5)
-> (-116.5,-230.5) -> (-116.5,-228.5) -> (-117.5,-227.5)
-> (-127.65,-225.5)
```

This is a geometric route, not proof of safe passage or mouse-controlled combat.
The closer-looking 15 m approach remains outside melee range.
An explicit `--combat-target` follows its geometric route without imposing the
script's additional creature-avoidance policy; terrain and speed checks remain
mandatory. Such a route can encounter other hostile creatures.

Banks near the spawn have about 124.82..155.78 m approach routes; nearby traders
need roughly 134.63..215.59 m despite much shorter direct distances. Terrain walls
explain the detours. The shared helper also prevents walking across the storage
seam at X=0. Transitions between disconnected areas are outside this flood audit.
Reachable does not mean safe from aggressive creatures. The live smoke's hostile
avoidance policy and shorter route cap intentionally provide a narrower result.

Full graph/entity evidence:
`artifacts/canonical-smoke/reachability-1790723006656.json`, refreshed after the
DDA correction. Component and entity counts remain unchanged; route lengths
reflect the corrected traversal. The earlier
`reachability-1790720754733.json` sampled integer nodes before the shared grid
was changed to cell centres and is retained as superseded evidence.

## Game tests with the actual map

```powershell
npx tsx --test server/canonical-world.test.ts server/combat.test.ts
npm test
npm run check
```

The complete project suite passed **57/57 tests**, and TypeScript checking
passed. The canonical-world/combat subset passed **14/14 tests**. Canonical tests use the
real map and `Game`'s optional sixth map argument; they confirm:

- All 1,571 monster placements cover 45 original creature IDs; all 148 NPC
  placements preserve their source IDs and tile indexes, including Bob ID285
  at index58407.
- First migration preserves accounts, sessions, inventories, bank contents,
  credits, quest state, active crafting inputs/outputs/timer and loot bag data.
- A subsequent saved-state roundtrip retains player position, depleted resource
  stock, monster HP/death/respawn state and active jobs.
- Canonical snapshots contain nearby entities/players and omit distant ones.
- Movement obeys 2 m/s running, 1 m/s walking, and the 250 ms elapsed clamp;
  the server rejects crossing a real encoded tile wall with walkable endpoints.
- Combat target packets cause no immediate damage; 500 ms steps apply hits at
  1,000 ms intervals; disengage, range exit and disconnect cancel the target;
  NPCs reject combat; two attackers produce one death award and one loot bag.

Direct fixture setup is used only inside these isolated Game tests. The live
HTTP/WebSocket smoke does not modify a character's state directly.
