const express = require("express");
const http = require("node:http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 10000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://x1nd1x.github.io";
const API_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p/w342/";
const API_PATHS = new Set(["/discover/movie", "/discover/tv"]);
const API_PARAMS = new Set([
  "language", "include_adult", "sort_by", "vote_count.gte", "vote_average.gte",
  "with_genres", "without_genres", "with_runtime.gte", "with_runtime.lte",
  "primary_release_date.gte", "primary_release_date.lte",
  "first_air_date.gte", "first_air_date.lte", "page"
]);
const ROOM_CODE = /^[A-Z0-9]{5}$/;
const MAX_ROOM_MESSAGE = 256 * 1024;
const API_CACHE_MS = 5 * 60 * 1000;
const IMAGE_CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_IMAGE_CACHE_ENTRIES = 200;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_ROOM_MESSAGE });
const rooms = new Map();
const apiCache = new Map();
const apiInflight = new Map();
const imageCache = new Map();

app.disable("x-powered-by");

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    service: "movie-picker-backend",
    tmdb_key_set: Boolean(process.env.TMDB_KEY),
    rooms: rooms.size
  });
});

app.get("/discover/movie", handleDiscover);
app.get("/discover/tv", handleDiscover);
app.head("/image/w342/:filename", handleImage);
app.get("/image/w342/:filename", handleImage);

async function handleDiscover(req, res) {
  if (!process.env.TMDB_KEY) {
    return res.status(500).json({ status_message: "TMDB_KEY не задан в переменных окружения сервера" });
  }

  const part = req.query.part;
  const target = new URL(API_BASE + req.path);
  for (const [key, value] of Object.entries(req.query)) {
    if (API_PARAMS.has(key) && typeof value === "string") target.searchParams.set(key, value);
  }
  target.searchParams.set("api_key", process.env.TMDB_KEY);

  // Coalesce concurrent requests for part=1 and part=2 so each TMDB page is
  // fetched only once even when the client asks for both halves simultaneously.
  const cacheKey = target.pathname + "?" + [...target.searchParams.entries()]
    .filter(([key]) => key !== "api_key")
    .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value))
    .join("&");

  let data = apiCache.get(cacheKey);
  if (data && data.expiresAt <= Date.now()) {
    apiCache.delete(cacheKey);
    data = null;
  }

  try {
    if (!data) {
      let pending = apiInflight.get(cacheKey);
      if (!pending) {
        pending = fetch(target, { signal: AbortSignal.timeout(12000) })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
              const error = new Error(body.status_message || "TMDB request failed");
              error.status = response.status;
              throw error;
            }
            const entry = { value: body, expiresAt: Date.now() + API_CACHE_MS };
            apiCache.set(cacheKey, entry);
            trimMap(apiCache, 100);
            return entry;
          })
          .finally(() => apiInflight.delete(cacheKey));
        apiInflight.set(cacheKey, pending);
      }
      data = await pending;
    }

    const source = data.value;
    const list = (source.results || [])
      .filter((movie) => movie.poster_path && movie.overview)
      .map((movie) => ({
        id: movie.id,
        title: movie.title,
        name: movie.name,
        release_date: movie.release_date,
        first_air_date: movie.first_air_date,
        vote_average: movie.vote_average,
        genre_ids: movie.genre_ids,
        overview: shorten(movie.overview),
        poster_path: movie.poster_path
      }));

    const half = Math.ceil(list.length / 2);
    const results = part === "1" ? list.slice(0, half) : part === "2" ? list.slice(half) : list;
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.json({ total_pages: source.total_pages, results });
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 502;
    return res.status(status).json({
      status_message: status === 502
        ? "Не удалось получить данные от TMDB. Повторите запрос."
        : (error.message || "Ошибка TMDB")
    });
  }
}

async function handleImage(req, res) {
  const filename = req.params.filename || "";
  if (!/^[A-Za-z0-9_-]+\.jpg$/.test(filename)) {
    return res.status(404).send("Not found");
  }

  const cached = imageCache.get(filename);
  if (cached && cached.expiresAt > Date.now()) {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Type", cached.contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return req.method === "HEAD" ? res.status(200).end() : res.status(200).send(cached.body);
  }
  if (cached) imageCache.delete(filename);

  try {
    const upstream = await fetch(IMAGE_BASE + filename, { signal: AbortSignal.timeout(12000) });
    if (!upstream.ok) {
      return res.status(upstream.status === 404 ? 404 : 502).send("TMDB image unavailable");
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > 5 * 1024 * 1024) return res.status(502).send("Image too large");

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    imageCache.set(filename, {
      body,
      contentType,
      expiresAt: Date.now() + IMAGE_CACHE_MS
    });
    trimMap(imageCache, MAX_IMAGE_CACHE_ENTRIES);

    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return req.method === "HEAD" ? res.status(200).end() : res.status(200).send(body);
  } catch {
    return res.status(502).send("TMDB image fetch failed");
  }
}

function shorten(value) {
  const text = typeof value === "string" ? value : "";
  return text.length > 260 ? text.slice(0, 257).trimEnd() + "…" : text;
}

function trimMap(map, maxSize) {
  while (map.size > maxSize) map.delete(map.keys().next().value);
}

function sendControl(socket, payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify(payload)); } catch {}
  }
}

function rejectUpgrade(socket, status, message) {
  const reason = ({
    400: "Bad Request", 403: "Forbidden", 404: "Not Found",
    409: "Conflict", 413: "Payload Too Large", 500: "Internal Server Error"
  })[status] || "Bad Request";
  const body = String(message || reason);
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
  socket.destroy();
}

server.on("upgrade", (request, socket, head) => {
  let url;
  try {
    url = new URL(request.url, "http://localhost");
  } catch {
    return rejectUpgrade(socket, 400, "Invalid URL");
  }

  const origin = request.headers.origin;
  if (origin && origin !== ALLOWED_ORIGIN) return rejectUpgrade(socket, 403, "Origin not allowed");

  const match = url.pathname.match(/^\/room\/([A-Z0-9]{5})$/);
  if (!match) return rejectUpgrade(socket, 404, "Unknown WebSocket endpoint");

  const code = match[1];
  const role = url.searchParams.get("role");
  if (!ROOM_CODE.test(code) || !["host", "guest"].includes(role)) {
    return rejectUpgrade(socket, 400, "Invalid room or role");
  }

  let room = rooms.get(code);
  if (role === "guest" && (!room || !room.host || room.host.readyState !== WebSocket.OPEN)) {
    return rejectUpgrade(socket, 404, "Room not found or host is offline");
  }
  if (role === "host" && room && room.host && room.host.readyState === WebSocket.OPEN) {
    return rejectUpgrade(socket, 409, "Room code already in use");
  }
  if (role === "guest" && room.guest && room.guest.readyState === WebSocket.OPEN) {
    return rejectUpgrade(socket, 409, "Room already has a guest");
  }

  if (role === "host") {
    room = { host: null, guest: null, createdAt: Date.now() };
    rooms.set(code, room);
  }

  wss.handleUpgrade(request, socket, head, (client) => {
    client.roomCode = code;
    client.roomRole = role;
    if (role === "host") room.host = client;
    else room.guest = client;

    client.on("message", (data, isBinary) => {
      if (isBinary || data.length > MAX_ROOM_MESSAGE) {
        client.close(isBinary ? 1003 : 1009, isBinary ? "Text messages only" : "Message too large");
        return;
      }

      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        client.close(1003, "Invalid JSON");
        return;
      }
      if (!message || typeof message !== "object" ||
          !["movies", "vote", "exh", "end"].includes(message.t)) {
        client.close(1008, "Unsupported message");
        return;
      }

      const current = rooms.get(code);
      if (!current) return;
      const recipient = role === "host" ? current.guest : current.host;
      sendRaw(recipient, data.toString());
    });

    client.on("close", () => {
      const current = rooms.get(code);
      if (!current) return;

      if (role === "host" && current.host === client) {
        sendControl(current.guest, { __room: "host-disconnected" });
        try { current.guest && current.guest.close(4001, "Host disconnected"); } catch {}
        rooms.delete(code);
      } else if (role === "guest" && current.guest === client) {
        current.guest = null;
        sendControl(current.host, { __room: "guest-disconnected" });
        if (!current.host || current.host.readyState !== WebSocket.OPEN) rooms.delete(code);
      }
    });

    if (role === "guest") sendControl(room.host, { __room: "guest-joined" });
  });
});

function sendRaw(socket, text) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(text); } catch {}
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Movie Picker backend listening on 0.0.0.0:${PORT}`);
});
