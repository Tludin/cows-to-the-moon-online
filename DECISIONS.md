# Design Decisions — Phase 1 additions

Decisions #1–8 are recorded in the spec (Section 10). These were resolved by
Tomas at the start of Phase 1 and are implemented in the engine:

**#9 — Herding requires at least one rocket piece.** A cow can only be moved
into the rocket (via Herd or Super Speedy Cows) if the launch pad holds at
least one piece. Capacity limits (4, or 5 for a full matching set) always
apply. An event that can't move any cows still resolves as a legal no-op.

**#10 — Mini Rocket may target any player's cow**, from their farm or their
rocket — including an opponent's (which helps them, but is legal).

**#11 — Rocket pieces may be played in any order** (top before bottom is
fine), but a rocket may never contain two pieces for the same part. Wild
Cards flex to whatever part is missing, so any three legal pieces form a
complete rocket. Wilds never count toward the matching-set capacity bonus.

**#12 — Rocket Thief and cows aboard.** If stealing a piece drops the
rocket's capacity below the number of cows aboard, the excess cows return to
the owner's farm. If the last piece is stolen, all cows return to the farm.

**#13 — Turns end only via an explicit End Turn action** (added after the
first playtest). The physical game passes the turn the moment the third
action resolves; online that made the turn vanish under the player. The
engine no longer auto-ends turns: once all actions are spent, End Turn is the
only legal move, and it may also be pressed early to forfeit remaining
actions. The Rocket Store still refills as the last thing before the turn
passes (spec 6.1 #5), and End Turn is illegal while a Cownter window is open
or before drawing.

Decisions made at the start of Phase 3 (robustness):

**#14 — Turn timer: 90 seconds.** Decision #13 (turns end only via End Turn)
meant an AFK player's turn could never pass, so Decision #6 could never
trigger. Resolution: if the current player takes no action for 90 seconds
(config.json → `turnInactivityTimeoutSeconds`), the server skips their turn
from any phase. Each skip is one strike; any real own-turn action resets the
count; at `playerInactivityTurnLimit` (2) consecutive skips the player is
marked inactive per Decision #6. Disconnected players get the same timer.
*Refinement:* the strike only counts if the player took no action-phase
action that turn (Decision #6 says "takes no action"). A player who used
their actions and then paused at the End Turn button gets their turn
auto-ended after the same 90s, but with no strike — thinking after your
actions are spent is playing, not being AFK. Drawing alone doesn't count as
taking an action.

**#15 — Reactivation: reconnect or button.** An inactive player becomes
active again automatically on reconnecting, or via an "I'm back!" button if
they idled while connected. They rejoin the rotation on their next turn; a
response window already open when they return is not retroactively expanded.

**#16 — A skipped turn still counts as "the start of your next turn".**
So Bad Weather clears when its owner's seat is passed over — an AFK owner
can't lock the table out of launching indefinitely.

**#17 — Getting back into a running game after closing the tab.** Two doors,
both leading to the same seat: (a) the home screen shows "Rejoin" buttons for
seats saved in localStorage (up to a day old; sessionStorage still handles
same-tab refreshes); (b) entering the room code with the exact name you
played under reclaims your seat — but only while that seat is disconnected.
A connected seat can only be taken over with the reconnect token, and the
replaced connection is told (`seatTakenOver`) so it stops auto-reconnecting.
The name path is deliberately friends-scale trust: anyone with the code who
knows a disconnected player's name could claim that seat.
Supporting rules: names are unique per room (case-insensitive; enforced at
lobby join), and each browser tab heartbeats the seat it holds into
localStorage so sibling tabs neither list a Rejoin button for it nor
auto-reconnect into it — otherwise two tabs play tug-of-war over one seat.

Implementation notes (literal readings, flagged for review):

- **Bad Weather blocks its own player too** — "prevents anyone from
  launching" is read literally, so the owner can't launch for the rest of
  their own turn either. It clears at the start of the owner's next turn.
- **A Cownter cannot be played proactively** as a normal action; it only
  exists as a response to an event card.
- **Launching an empty completed rocket is legal** (if pointless).
- **A cancelled winning play does not end the game** — win detection runs
  only when an effect actually resolves.
