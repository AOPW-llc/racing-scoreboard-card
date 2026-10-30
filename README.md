# Racing Scoreboard Card

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
[![Validate](https://github.com/AOPW-llc/racing-scoreboard-card/actions/workflows/validate.yml/badge.svg)](https://github.com/AOPW-llc/racing-scoreboard-card/actions/workflows/validate.yml)

A Home Assistant dashboard card for the NASCAR Cup Series. It shows one race
at a time: the starting lineup before the green flag, the running order while
the race is on, and the full results afterwards, next to the season points
standings. The arrows (or a swipe) move through the season's schedule.

No integration, sensor or API key is needed. The card reads ESPN's public
scoreboard, race and standings feeds straight from the browser.

## Features

- **One race per screen.** The header names the track and the race number
  (`Martinsville · Race 35 of 36`). Non-points races (the Clash, the Duels, the
  All-Star Race) are marked as such and don't count.
- **Opens on the right race.** A race that's on or finished in the last day
  and a half, otherwise the next one. **Current race** brings you back.
- **Race details.** Track and location, date, start time and TV, with a
  live lap counter during the race and the lap total once it's final.
- **Results and running order.**
  - Position, places gained or lost from the start (▲ / ▼), car number in the
    manufacturer's color (Chevrolet gold, Ford blue, Toyota red), driver, and
    team and sponsor.
  - Laps completed (and laps down), laps led, and race points once it's final.
  - The winner with the checkered flag.
- **Starting lineup** before the race, as soon as ESPN has it.
- **Points standings** with each driver's gap to the leader, and the Chase
  cut line drawn under the last driver in (16 in Cup, 12 in O'Reilly, 10 in
  Trucks): `Next Cutoff: Daytona` during the regular season, `Chase field · set
  at Daytona` once the Chase is on. Four drivers below the line show, with
  **Show all** for the rest.
- **Team standings.** A **Drivers | Teams** toggle above the standings. ESPN
  doesn't publish owner points, so the card builds an unofficial table: each
  driver's season wins, top 5s, top 10s and laps led, added up under their
  current team and ranked in that order, with the team's drivers listed. The
  card remembers which tab you picked.
- **Driver page.** Tap any driver in the results or standings for:
  - Headshot, car number, team and make, age and hometown, points position and
    whether they're in the Chase.
  - Season totals for points races: wins, top 5s, top 10s, poles, laps led,
    average start and finish, lead-lap finishes, starts, DNFs and points.
  - Every race this season with start, finish, laps led and points. Tap one to
    open that race.
  - Career totals and prize money aren't available from ESPN, so they aren't
    shown.
- **Favorite driver.** Highlighted in the results and standings, with a
  one-line summary: where they started, where they finished or are running,
  laps led and points.
- **Fold sections.** Tap the **Results** or **Points standings** heading to hide
  it; the browser remembers your choice.
- **Picks up where you left off.** Leave the dashboard and come back, and the
  card returns to the race you were on, for the rest of the day in that tab.
- **Live updates.** Refreshes every 30 seconds during a race (laps and laps led
  once a minute) and every 5 minutes otherwise.
- **Other series.** NASCAR O'Reilly Auto Parts Series and NASCAR Truck Series
  work too.

## Installation

### HACS (recommended)

1. In HACS, open the menu (⋮) → **Custom repositories**.
2. Add `https://github.com/AOPW-llc/racing-scoreboard-card` with category
   **Dashboard**.
3. Search for **Racing Scoreboard Card**, download it, and reload your browser.

### Manual

1. Download `racing-scoreboard-card.js` from the
   [latest release](https://github.com/AOPW-llc/racing-scoreboard-card/releases/latest).
2. Copy it to `/config/www/racing-scoreboard-card.js`.
3. Go to **Settings → Dashboards → ⋮ → Resources** and add
   `/local/racing-scoreboard-card.js` as a **JavaScript module**.

## Configuration

Add the card from the dashboard card picker (search "Racing"). Everything can
be set in the visual editor. The card works best wide, for example in a
**Panel** view; below about 720px the standings move under the results.

```yaml
type: custom:racing-scoreboard-card
series: nascar-premier
driver: Kyle Larson
show_standings: true
refresh_interval: 30
teams:
  "44": NY Racing Team
```

| Option | Default | Description |
|---|---|---|
| `series` | `nascar-premier` | `nascar-premier` (Cup Series), `nascar-secondary` (O'Reilly Auto Parts Series) or `nascar-truck` (Truck Series). |
| `driver` | none | Favorite driver, by name as ESPN writes it (`Kyle Larson`, `K. Larson`) or car number (`5`). |
| `show_standings` | `true` | Show the driver and team standings. |
| `teams` | none | Car number → team, for cars ESPN lists without a team (they show as "Team not listed"). Also overrides the card's built-in fixes. |
| `refresh_interval` | `30` | Seconds between refreshes during a race (10–300). |

## Notes

- Times are shown in your browser's time zone.
- Laps, laps led and points come from one ESPN request per driver, so during a
  race they update at most once a minute. A driver page makes one request per
  race they've run this season, and is kept for 10 minutes. The running order updates on every
  refresh.
- ESPN's race entries leave some teams blank. The card fills in 23XI Racing
  (#23, #35, #45, #67) and Haas Factory Team (#41) for the Cup Series; use
  `teams` for any others. A driver's team is the one they ran their most
  recent race with.
- The standings are ESPN's season points table. During the playoffs ESPN's
  order reflects the playoff reset.
- ESPN's feeds are public but undocumented, and can change without notice.

## Disclaimer

This is an unofficial, fan-made card. It is not affiliated with, endorsed by or
sponsored by NASCAR, its teams, drivers or sponsors, or ESPN. Names and marks are
trademarks of their respective owners.

## License

[MIT](LICENSE)
