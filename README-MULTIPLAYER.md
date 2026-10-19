# Road Rush: 1v1 multiplayer coin-pot races

## Features
- Create a race room or join a friend's room with a code.
- The race waits until both drivers are connected before starting.
- Live driver lane, distance, speed, and running-state synchronization.
- Head-to-head match: when one driver crashes, the other driver wins.
- The winner receives the loser's current in-game coin balance; the loser's balance becomes zero.
- Draws transfer no coins. Disconnecting after the match starts counts as a forfeit.
- This is an in-game currency mechanic, not real-money betting.

## Deploy frontend to Vercel
Deploy the repository root as a static project. Use Framework Preset Other, no build command, and . as the output directory if asked.

## Deploy multiplayer server
Deploy the multiplayer-server/ directory as a separate Node web service:
- Build command: npm install
- Start command: npm start
- Environment variable: FRONTEND_ORIGIN=https://YOUR-VERCEL-PROJECT.vercel.app

After deployment, check https://YOUR-SERVICE.onrender.com/health. It should return JSON with ok: true.

## Play
1. Open Race friends and paste the Render service URL into Multiplayer Server URL.
2. Leave room code empty and tap Create / Join Race.
3. Share the room code.
4. Your opponent uses the same server URL and enters that room code.

## Important limitations
The server keeps rooms in memory, so rooms reset when the service restarts. The starting coin balance is reported by each browser, so this is suitable for casual play rather than cheat-proof competitive play. The server must be deployed separately; the static Vercel site cannot host persistent Socket.IO connections itself.