# Road Rush: real-time multiplayer deployment

## What this build adds
- Race friends screen with server URL, driver name, and room-code inputs.
- Create a room or join a friend's existing room.
- Live Socket.IO sync for driver lane, distance, speed, and running state.
- Other players appear as labeled ghost cars on your road.
- Works with the existing PC keyboard and mobile touch controls.

## Deploy frontend to Vercel
Deploy the root of this folder as a static project. The root contains `index.html`, `manifest.webmanifest`, `sw.js`, and the icon files. Vercel project settings: Framework Preset `Other`, no build command. If asked for an output directory, use `.`.

## Deploy multiplayer service
Vercel's static frontend is not the persistent Socket.IO service. Deploy `multiplayer-server/` as a separate Node web service on a WebSocket-capable host such as Render:
- Build command: `npm install`
- Start command: `npm start`
- Environment variable: `FRONTEND_ORIGIN=https://YOUR-VERCEL-PROJECT.vercel.app`

After deploy, check `https://YOUR-SERVICE.onrender.com/health`. Then on Road Rush, open Race friends, enter the Render URL, set a name, and create a room. Your friend enters the same server URL and the room code.

This is an initial ghost-racing prototype, not yet shared-physics racing: players see one another's cars but don't collide or affect one another's traffic. Rooms are memory-only and reset if the multiplayer service restarts.
