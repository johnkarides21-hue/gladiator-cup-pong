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
- Emperor of Rome: when an Emperor beats a lower-ranked player, the loser pays a bounty of 10 + 5 x (ranks below Emperor) coins, taken from the loser and given to the Emperor.
- Leaderboards: `/leaderboard` (page) and `/api/leaderboard` (JSON), overall and per rank.
