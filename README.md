# Gladiator Cup Pong – Game Server

Runs the game, online matchmaking, accounts, ranks, coins and leaderboards.

## Run locally
    npm install
    node server.js          # http://localhost:8080  (PORT to change)

## Deploy (Render, free tier)
1. Push this folder to a GitHub repo, create a Render "Web Service" (Node), build `npm install`, start `node server.js`.
2. Add a Persistent Disk and set env `DATA_FILE=/data/players.json` (free tier disk is wiped on restart, so ranks/coins would reset without it).
3. Optional env: `GOOGLE_CLIENT_ID` (enables real Google sign-in).
4. Open your Render URL to play. To host the page on Netlify instead, set `const SERVER_URL='https://your-app.onrender.com'` near the top of the script in index.html.

## Rules
- Start: 100 coins. Win/loss changes GLORY (rank points).
- Top 5 ranks are minimums: Centurion 6,000 glory, Senator 8,400, Consul 11,200, Caesar 14,400, Emperor of Rome 19,000.
- Each of the top 5 classes holds at most 50 players. The top 50 by glory hold the class. A 51st player takes the class's place and the lowest-glory player in that class drops to the next rank down (glory is kept, so they can climb back).
- Online matchmaking pairs players of similar glory: within 100 glory, or 15% of the higher player's glory. If nobody similar is waiting, a player who has searched for 3 seconds is matched with the nearest-skill opponent available.
- Tribute: the ten lowest ranks (Ludus Trainee to Rudis Bearer) pay 5 coins to the Imperial Treasury after every game, win or lose. Against an Emperor of Rome they also pay 15 coins straight to that Emperor. Constants: `TRIBUTE_SMALL`, `TRIBUTE_EMPEROR`.
- Crown: once per UTC day the top-glory gladiator receives 300 coins, paid by the game itself (`CROWN_BONUS`). The treasury total is saved in `meta.json` beside the player file.
- Guests playing without the server are not capped, since the server is what keeps the shared table.
- Emperor of Rome: when an Emperor beats a lower-ranked player, the loser pays a bounty of 10 + 5 x (ranks below Emperor) coins, taken from the loser and given to the Emperor.
- Leaderboards: `/leaderboard` (page) and `/api/leaderboard` (JSON), overall and per rank.

## Shop & Armory
- Upgrades (once per game, vs CPU): Eagle Eye 500, Second Wind 750, Aegis 1000, Phoenix Cup 1500 coins (`/api/shop`).
- Avatars (Armory): 80 to 700 coins (`/api/avatar`).

## CPU difficulty
- Easy, Medium, Hard, Emperor. Wins and losses are scaled by Easy x0.2, Medium x0.4, Hard win x1.6 and loss x2.5, Emperor win x2.5 and loss x4.
- Losing to a harder CPU costs more: the same multipliers apply to glory and coins lost.
- Emperor is far more accurate than the other levels and very hard to beat.
