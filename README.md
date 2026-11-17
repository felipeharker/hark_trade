# Saltroad

A persistent, real-time empire-building sandbox with trading between players on top, built for a small group of friends or coworkers. There is no clock, no rounds and no winner. The world runs all the time: one hour on the clock is one hour in the world, and your empire keeps working while you are away.

It is a sibling of [Hark Urbanism](https://urbanism.felipeharker.org) and shares its look: a quiet planning-map, Overpass type and guide-sign green.

## How the world works

**On your own**

- **Land**: the map is a grid of plots over seeded terrain. You found a capital, which comes with the plots around it, then claim neighbouring plots one at a time or found outposts on far-off land. Terrain decides what a plot can do: plains grow grain and wool, forest gives timber, hills stone and wool, mountains iron and stone, and plots beside water take fisheries and saltworks. Some plots are richer than others.
- **Buildings** go on your plots: farms, pastures, fisheries, saltworks, lumber camps, quarries and mines make raw goods; weavers, breweries and smithies turn wool, grain, and iron with timber into cloth, ale and tools; houses hold people; warehouses hold more goods. Like buildings side by side help each other, and buildings can be upgraded.
- **People** move into your houses while their needs are met, work your buildings and pay taxes, which is your steady income. A hamlet wants grain, fish, salt and timber.
- **Ranks**: with enough people you pay for a charter and become a village, market town, city and metropolis. Each rank raises taxes, lets buildings go a level higher and holds more people, and your people start wanting more (cloth, ale, stone and wool, then tools and iron, then spices).

**With each other**

- **The Exchange**: list goods from your stores for a price in cash, in other goods with quantities, or both. Other players can accept the price or send a counter bid in cash or goods, which you accept or decline. Listed goods and bids are held in escrow, and couriers deliver the goods between capitals when a deal is struck.
- **Neutral towns** are markets run by the world. They produce from their land, consume what their size calls for, and grow or shrink with how well they are supplied. Prices follow stock, between 0.3x and 3.5x a good's base price with a 6% spread, and every unit bought or sold moves them. Your caravans carry what you buy and sell there, and standing orders keep them working while you are offline.
- **Roads** between towns and settlements make caravans and couriers 1.8x faster, keep bandits off, and charge everyone but the owner a toll. Roads can be sold to other players.
- **Events** (droughts, harvests, festivals, fires, bandits and more) come and go and show up in the Gazette, and Standings rank empires by worth.

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

The first account created is the admin. From the ☰ menu the admin can reset other players' passwords and **start a new world** (type RESET to confirm): the map and every empire are replaced, accounts stay, and the old world is saved to `world_backups` first. A world saved by an older version of the game is backed up and replaced the same way when the server starts.

`npm run smoke` runs the rules end to end without a server (found two empires, build, trade, strike a deal). `npm run simtest` lets a few simple bots run empires for some days and prints how they fare: `node tools/simtest.mjs [days] [players] [seed] [hours between check-ins]`.

## Code

- `shared/` game data (goods, ranks, buildings, costs, pricing), land rules and seeded terrain, used by both server and browser.
- `server/world.js` world generation, `server/sim.js` the simulation, `server/actions.js` player commands, `server/exchange.js` listings and bids, `server/index.js` auth and the HTTP API, `server/db.js` storage.
- `public/` the client: `map.js` draws the canvas map, `app.js` everything else. No build step.

## Deployment

Runs on Render as the `hark-trade` web service (Node, Starter plan) with the `hark-trade-db` Postgres (Basic 256 MB). It redeploys on every push to `main`.
