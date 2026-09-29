# HTTP / WebSocket smoke verification

Run: 2026-09-29T20:58:30.309Z

Target: http://127.0.0.1:3188

Result: **PASSED — 16 passed, 0 failed**. Duration: 27.9 seconds.

| Check                                                                   | Result | Duration, ms |
| ----------------------------------------------------------------------- | ------ | ------------ |
| HTTP health and world catalog                                           | PASS   | 27           |
| Anonymous session does not expose a player                              | PASS   | 1            |
| Register two independent accounts with random passwords                 | PASS   | 411          |
| Two authenticated WebSockets see each other                             | PASS   | 250          |
| Other players inventory, bank, skills, stats and quests are private     | PASS   | 0            |
| Distant gathering is rejected without changing inventory                | PASS   | 320          |
| Ordinary walking to trader and atomic purchase                          | PASS   | 4617         |
| Walk to bank, deposit and withdraw preserve item totals                 | PASS   | 3483         |
| Nearby gathering adds one resource and rejects immediate cooldown retry | PASS   | 3698         |
| Walk to furnace and complete a real five-second smelting job            | PASS   | 12964        |
| World chat reaches the second player and rapid repeat is rejected       | PASS   | 247          |
| Session API contains current inventory, bank and position               | PASS   | 2            |
| Logout revokes the old cookie and closes its WebSocket                  | PASS   | 6            |
| Login with wrong password is rejected                                   | PASS   | 196          |
| Fresh login and WebSocket retain the same character state               | PASS   | 258          |
| HTTP health reports healthy persistence after state changes             | PASS   | 1304         |

Test accounts: qa_mun5s2sl_d7d3_a, qa_mun5s2sl_d7d3_b. Passwords and session values are random and were neither logged nor saved. Sessions were logged out after the run. Accounts remain because the server has no account deletion route.

The script used normal HTTP and authenticated WebSockets, ordinary movement at requested steps below 7 units/s with 120 ms spacing between movement messages, and occasional action packets. The server WebSocket rate limit was not triggered. It did not edit persisted state, modify clocks, teleport players, or call internal game methods.

Inventory, bank and coordinates survived logout and a fresh login. HTTP persistence health was checked after an automatic checkpoint. **Server restart durability was not tested by this script.** Browser rendering, visual quality, collision, frame rate, combat, high-tier crafting and complete original-game fidelity require separate checks.
