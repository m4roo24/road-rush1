# Road Rush Cloudflare multiplayer

## Features
- Create a room or join a friend's room with a code.
- Cloudflare Worker + Durable Objects provide live WebSocket rooms.
- The race starts when both drivers are connected and running.
- Winner earns a fixed 100 in-game coin bonus; the losing driver keeps their balance.
- A draw awards no bonus.
- This is a casual multiplayer prototype, not cheat-proof competitive infrastructure.

## Deploy
The static frontend remains on Vercel. Deploy the multiplayer Worker from the repository root with Wrangler:

```sh
npm install --save-dev wrangler
npx wrangler login
npx wrangler deploy
```

The `wrangler.jsonc` file defines the `RACE_ROOMS` Durable Object binding and initial migration. After deployment, open `https://YOUR-WORKER-URL/health` and confirm `ok: true`.

## Play
1. Open Race friends on the game website.
2. Enter the deployed Cloudflare Worker URL.
3. Leave the room code empty and create a room.
4. Share the room code with a friend; they use the same Worker URL and enter that code.

## Notes
The Worker must be deployed separately from the Vercel frontend. This prototype uses a fixed non-wagered reward; the losing player's coins are not taken.
