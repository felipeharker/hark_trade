# Saltroad

A persistent, real-time sandbox of rival trading companies, built for a small group of friends or coworkers. There is no clock, no rounds and no winner. The world runs all the time: one hour on the clock is one hour in the world, caravans keep moving while you are away, and towns grow or fade depending on what gets delivered to them.

It is a sibling of [Hark Urbanism](https://urbanism.felipeharker.org) and shares its look: a quiet planning-map, Overpass type and guide-sign green.

## How the world works

- **Towns** produce goods from their land (plains grow grain and wool, coasts fish and salt, forests timber, hills stone, mountains iron) and consume what their size calls for. A hamlet wants food, salt and timber. A village also wants cloth, stone, ale and wool, a market town tools and iron, and a city spices from the far frontier. Towns whose needs are met grow; neglected towns shrink.
- **Prices** follow stock against what the town considers normal, between 0.3× and 3.5× a good's base price, with a 6% spread. Every unit bought or sold moves the price, so flooding a market ruins it. NPC peddlers slowly even out the worst gaps between neighbours.
- **Caravans** (wagon, mule train, freight convoy) travel in straight lines between towns in real time. Give one a **route** (stops with buy, sell, load and unload orders and price limits) and it trades on its own forever.
- **Works**: a warehouse stores goods in a town; estates produce local goods into it; weavers, breweries and smithies turn wool, grain, iron and timber into cloth, ale and tools.
- **Roads** between towns make caravans 1.8× faster, protect them from bandits, help both towns grow, and charge rivals a toll the owner sets. Roads can be sold to other companies.
- **Events**: droughts, harvests, shoals, festivals, fires, mine collapses, booms, bandits and sickness come and go and show up in the Gazette.
- **Frontier**: the map starts mostly fogged. More towns are revealed as the known world's population grows, or when a company pays for an expedition (and names the town). A few far towns grow spices.
- **Each other**: the Exchange has a public notice board and public payments for sealing deals. Standings rank companies by worth, and the Gazette announces milestones and who controls which trade (more than half of a good's volume over the last day).

## Running it

```sh
npm install
INVITE_CODE=something npm start        # http://localhost:3000
```

Without `DATABASE_URL` the world and accounts are saved as JSON in `./data`. With `DATABASE_URL` set, they live in Postgres (tables `users`, `world`, `world_backups`, `meta`); the whole world is one JSONB row that is written every 20 seconds and after each action, with a backup every 6 hours (the last 14 are kept).

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Optional locally. |
| `INVITE_CODE` | Required to create an account. Leave unset for open sign-up. |
| `SESSION_SECRET` | Signs login cookies. If unset, one is generated and stored in the database. |
| `WORLD_SEED` | Seed for the first world. Random if unset. |
| `PORT` | Defaults to 3000. |

The first account created is the admin and can reset other players' passwords from the ☰ menu.

`npm run simtest` runs a fresh world for a week with no players and prints how towns and prices settle. `node tools/playtest.mjs` checks a company's route, works and roads over two simulated days.

## Code

- `shared/` game data (goods, tiers, vehicles, buildings, pricing) and seeded terrain, used by both server and browser.
- `server/world.js` world generation, `server/sim.js` the simulation, `server/actions.js` player commands, `server/index.js` auth and the HTTP API, `server/db.js` storage.
- `public/` the client: `map.js` draws the canvas map, `app.js` everything else. No build step.

## Deployment

Runs on Render as the `hark-trade` web service (Node, Starter plan) with the `hark-trade-db` Postgres (Basic 256 MB). It redeploys on every push to `main`.
