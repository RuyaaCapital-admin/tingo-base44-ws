import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";

const PORT = process.env.PORT || 8080;
const TIINGO_FX_URL  = "wss://api.tiingo.com/fx";
const TIINGO_IEX_URL = "wss://api.tiingo.com/iex";
const TIINGO_API_KEY = process.env.TIINGO_API_KEY;
const RELAY_SECRET   = process.env.RELAY_SECRET || "";

const server = createServer();
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (client) => {
  let upstream;

  client.once("message", (buf1) => {
    try {
      const { __secret } = JSON.parse(String(buf1));
      if (RELAY_SECRET && __secret !== RELAY_SECRET) { client.close(1008, "forbidden"); return; }
    } catch { client.close(1008, "bad auth"); return; }

    client.once("message", (buf2) => {
      try {
        const init = JSON.parse(String(buf2));
        const kind = init.kind === "iex" ? "iex" : "fx";
        const tickers = Array.isArray(init.tickers) ? init.tickers : [];
        const thresholdLevel = Number(init.thresholdLevel) || 5;
        if (!TIINGO_API_KEY || tickers.length === 0) { client.close(1008, "bad init"); return; }

        const url = kind === "iex" ? TIINGO_IEX_URL : TIINGO_FX_URL;
        upstream = new WebSocket(url, { headers: { Origin: "https://api.tiingo.com" } });

        upstream.on("open", () => {
          upstream.send(JSON.stringify({
            eventName: "subscribe",
            authorization: TIINGO_API_KEY,
            eventData: { thresholdLevel, tickers: tickers.map(s => s.toLowerCase()) }
          }));
          client.send(JSON.stringify({ relay: "INIT_OK" }));
        });

        upstream.on("message", (data) => client.send(data));
        upstream.on("close", (code, reason) => client.close(code, reason));
        upstream.on("error", (err) => { try { client.send(JSON.stringify({ relay:"UPSTREAM_ERR", err:String(err) })); } catch {} });

        client.on("message", (m) => { try { upstream?.send(m); } catch {} });
        client.on("close",   () => { try { upstream?.close(); } catch {} });
        client.on("error",   () => { try { upstream?.close(); } catch {} });
      } catch { client.close(1008, "bad json"); }
    });
  });
});

server.listen(PORT, () => console.log("tiingo-relay listening", PORT));
