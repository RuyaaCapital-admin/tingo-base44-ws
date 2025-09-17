// server.mjs
import { WebSocketServer, WebSocket } from "ws";
import http from "http";

const PORT = process.env.PORT || 8080;
const TIINGO_FX_URL  = "wss://api.tiingo.com/fx";
const TIINGO_IEX_URL = "wss://api.tiingo.com/iex";
const TIINGO_API_KEY = process.env.TIINGO_API_KEY;    // set in Railway
const RELAY_SECRET   = process.env.RELAY_SECRET || ""; // set in Railway

// Basic health/root
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(200); res.end("tiingo-relay");
});

// WS relay at /ws
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (client) => {
  let upstream;

  // 1) Auth frame: {"__secret":"<RELAY_SECRET>"}
  client.once("message", (buf1) => {
    try {
      const { __secret } = JSON.parse(String(buf1));
      if (RELAY_SECRET && __secret !== RELAY_SECRET) {
        client.close(1008, "forbidden"); return;
      }
    } catch {
      client.close(1008, "bad auth"); return;
    }

    // 2) Subscribe frame: {"kind":"fx"|"iex","tickers":[...],"thresholdLevel":5}
    client.once("message", (buf2) => {
      try {
        const init = JSON.parse(String(buf2));
        const kind = init.kind === "iex" ? "iex" : "fx";
        const tickers = Array.isArray(init.tickers) ? init.tickers : [];
        const thresholdLevel = Number(init.thresholdLevel) || 5;

        if (!TIINGO_API_KEY || tickers.length === 0) {
          client.close(1008, "bad init"); return;
        }

        const url = kind === "iex" ? TIINGO_IEX_URL : TIINGO_FX_URL;

        // Connect to Tiingo with required Origin header
        upstream = new WebSocket(url, { headers: { Origin: "https://api.tiingo.com" } });

        upstream.on("open", () => {
          const sub = {
            eventName: "subscribe",
            authorization: TIINGO_API_KEY,
            eventData: { thresholdLevel, tickers: tickers.map(s => s.toLowerCase()) }
          };
          upstream.send(JSON.stringify(sub));
          client.send(JSON.stringify({ relay: "INIT_OK" }));
        });

        // Forward Tiingo -> browser as TEXT
        upstream.on("message", (data) => {
          client.send(typeof data === "string" ? data : data.toString());
        });

        // Tear down symmetry
        upstream.on("close", (code, reason) => client.close(code, reason));
        upstream.on("error", (err) => {
          try { client.send(JSON.stringify({ relay: "UPSTREAM_ERR", err: String(err) })); } catch {}
        });

        // (optional) forward any later client frames upstream
        client.on("message", (m) => { try { upstream?.send(m); } catch {} });
        client.on("close",   () => { try { upstream?.close(); } catch {} });
        client.on("error",   () => { try { upstream?.close(); } catch {} });

      } catch {
        client.close(1008, "bad json");
      }
    });
  });
});

server.listen(PORT, () => console.log("tiingo-relay listening", PORT));
