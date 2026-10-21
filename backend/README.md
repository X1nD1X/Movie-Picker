# Staged backend outside Cloudflare

This backend is intentionally being prepared on the `staging/non-cloudflare-backend` branch. It does **not** change the live GitHub Pages site or the existing Cloudflare Worker.

It provides:
- `GET /discover/movie` and `GET /discover/tv` with the same response shape and `part=1/2` behavior as the current Worker.
- `GET /image/w342/:filename` as the TMDB image proxy, with a small in-memory cache.
- `wss://<service-host>/room/<CODE>?role=host|guest` as a WebSocket relay for online rooms. Room messages are relayed by this backend rather than relying on Cloudflare Workers or PeerJS Cloud.

## First step: test from the actual no-VPN connection

1. In Render, create a **Web Service** from repository `X1nD1X/Movie-Picker`, branch `staging/non-cloudflare-backend`.
2. Set **Root Directory** to `backend`, **Build Command** to `npm install`, and **Start Command** to `npm start`.
3. Choose the Free instance only for this first reachability test.
4. Add environment variable `TMDB_KEY` using your own TMDB API key. Do not put the key into GitHub or send it in chat. `ALLOWED_ORIGIN` is optional; it defaults to `https://x1nd1x.github.io`.
5. Deploy. Render assigns a service URL ending in `.onrender.com`.

Open `https://YOUR-SERVICE.onrender.com/health` from your ordinary home connection with VPN disabled. Expected JSON includes `"ok":true`, `"service":"movie-picker-backend"`, and `"tmdb_key_set":true`.

Then open a representative data response:
`https://YOUR-SERVICE.onrender.com/discover/movie?language=ru-RU&include_adult=false&sort_by=popularity.desc&vote_count.gte=300&page=1&part=1`

The key test is whether both endpoints return complete responses repeatedly without VPN. Do not switch the site until this passes and a real poster image URL has also been tested through `/image/w342/<poster-filename>.jpg`.

## Important free-plan caveat

Render's free service can spin down after 15 minutes without inbound traffic and take about a minute to start again. Use it to test network reachability first, not as a promise of production reliability. If the host is reachable but cold starts are unacceptable, decide on a paid always-on service or a VPS after the test. If `.onrender.com` itself is throttled or inaccessible from the home ISP, do not migrate the site to it; test a different host instead.

## Safety and rollback

The deployed Render service is separate from the live Worker. The app remains unchanged until its frontend configuration is deliberately updated after testing. Never commit `TMDB_KEY` or other secrets.
