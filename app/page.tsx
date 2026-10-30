
"use client";

import { useEffect, useMemo, useState } from "react";

const APP_ID = "1089";

const MARKETS = [
  { name: "Volatility 10", symbol: "R_10" },
  { name: "Volatility 25", symbol: "R_25" },
  { name: "Volatility 50", symbol: "R_50" },
  { name: "Volatility 75", symbol: "R_75" },
  { name: "Volatility 100", symbol: "R_100" }
];

type Tick = {
  quote: number;
  digit: number;
  time: number;
};

type MarketData = {
  ticks: Tick[];
  latest: number | null;
  connected: boolean;
};

export default function Home() {
  const [market, setMarket] = useState("R_100");
  const [contract, setContract] = useState("Matches");
  const [target, setTarget] = useState("5");
  const [barrier, setBarrier] = useState("5");
  const [lookback, setLookback] = useState(100);

  const [markets, setMarkets] = useState<
    Record<string, MarketData>
  >({});

  const [connection, setConnection] = useState("CONNECTING");
  const [connectionError, setConnectionError] = useState("");
  const [lastUpdate, setLastUpdate] = useState("--");
  const [scannerActive, setScannerActive] = useState(true);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let pingTimer: ReturnType<typeof setInterval>;
    let active = true;
    let reconnectAttempts = 0;

    const connect = () => {
      if (!active) return;

      setConnection("CONNECTING");
      setConnectionError("");

      try {
        socket = new WebSocket(
          `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`
        );

        socket.onopen = () => {
          if (!active || !socket) return;

          reconnectAttempts = 0;
          setConnection("LIVE");
          setConnectionError("");

          MARKETS.forEach(item => {
            socket?.send(JSON.stringify({
              ticks: item.symbol,
              subscribe: 1
            }));
          });

          if (pingTimer) clearInterval(pingTimer);

          pingTimer = setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ ping: 1 }));
            }
          }, 30000);
        };

        socket.onmessage = event => {
          if (!active) return;

          try {
            const response = JSON.parse(event.data);

            if (response.error) {
              setConnectionError(
                `${response.error.code || "API ERROR"}: ${response.error.message}`
              );
              return;
            }

            if (response.msg_type !== "tick" || !response.tick) {
              return;
            }

            const tick = response.tick;
            const symbol = tick.symbol;
            const quote = Number(tick.quote);
            const precision = Number(tick.pip_size ?? 2);

            if (!Number.isFinite(quote)) return;

            const formatted = quote.toFixed(precision);
            const digit = Number(formatted.slice(-1));

            setMarkets(previous => {
              const old = previous[symbol] || {
                ticks: [],
                latest: null,
                connected: true
              };

              return {
                ...previous,
                [symbol]: {
                  ticks: [
                    ...old.ticks,
                    {
                      quote,
                      digit,
                      time: Number(tick.epoch)
                    }
                  ].slice(-1000),
                  latest: quote,
                  connected: true
                }
              };
            });

            setLastUpdate(
              new Date(Number(tick.epoch) * 1000).toLocaleTimeString()
            );

            setConnection("LIVE");

          } catch {
            setConnectionError("Unable to read Deriv response");
          }
        };

        socket.onerror = () => {
          if (!active) return;

          setConnection("CONNECTION ERROR");
          setConnectionError(
            "WebSocket error. Check internet and Deriv App ID."
          );
        };

        socket.onclose = event => {
          if (!active) return;

          if (pingTimer) clearInterval(pingTimer);

          setConnection(`CLOSED ${event.code}`);

          setConnectionError(
            event.reason || "Connection closed without a reason"
          );

          reconnectAttempts++;

          const delay = Math.min(
            2000 * Math.pow(2, reconnectAttempts - 1),
            30000
          );

          reconnectTimer = setTimeout(connect, delay);
        };

      } catch (error) {
        setConnection("CONNECTION ERROR");
        setConnectionError(
          error instanceof Error ? error.message : "Unknown error"
        );

        reconnectTimer = setTimeout(connect, 5000);
      }
    };

    connect();

    return () => {
      active = false;
      clearTimeout(reconnectTimer);
      clearInterval(pingTimer);

      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, []);

  const data = markets[market];
  const ticks = data?.ticks || [];
  const recent = ticks.slice(-lookback);

  const counts = Array(10).fill(0);

  recent.forEach(tick => {
    counts[tick.digit]++;
  });

  const total = recent.length;
  const digit = Number(target);
  const limit = Number(barrier);

  const matchPct = total
    ? counts[digit] / total * 100
    : 0;

  const differPct = 100 - matchPct;

  const even = total
    ? recent.filter(t => t.digit % 2 === 0).length / total * 100
    : 0;

  const odd = 100 - even;

  const over = total
    ? recent.filter(t => t.digit > limit).length / total * 100
    : 0;

  const under = total
    ? recent.filter(t => t.digit < limit).length / total * 100
    : 0;

  const rising = recent.slice(1).filter(
    (tick, index) => tick.quote > recent[index].quote
  ).length;

  const falling = Math.max(0, total - 1 - rising);

  const risePct = total > 1
    ? rising / (total - 1) * 100
    : 0;

  const fallPct = total > 1
    ? falling / (total - 1) * 100
    : 0;

  const signal = useMemo(() => {
    if (total < 30) return "COLLECTING TICKS";

    if (!scannerActive) return "SCANNER PAUSED";

    switch (contract) {
      case "Matches":
        return matchPct > 15 ? "CHECK MATCH" : "WAIT";

      case "Differs":
        return differPct > 90 ? "CHECK DIFFER" : "WAIT";

      case "Even":
        return even > 55 ? "CHECK EVEN" : "WAIT";

      case "Odd":
        return odd > 55 ? "CHECK ODD" : "WAIT";

      case "Over":
        return over > 55 ? "CHECK OVER" : "WAIT";

      case "Under":
        return under > 55 ? "CHECK UNDER" : "WAIT";

      case "Rise":
        return risePct > 55 ? "CHECK RISE" : "WAIT";

      case "Fall":
        return fallPct > 55 ? "CHECK FALL" : "WAIT";

      default:
        return "WAIT";
    }
  }, [
    total, scannerActive, contract,
    matchPct, differPct, even, odd,
    over, under, risePct, fallPct
  ]);

  const latest = data?.latest;
  const currentDigit = ticks.length
    ? ticks[ticks.length - 1].digit
    : "--";

  return (
    <main className="dashboard">

      <header className="header">
        <div>
          <div className="logo">HOPE AI</div>
          <div className="small">
            DERIV ANALYZER PRO · V2.0
          </div>
        </div>

        <div className={
          connection === "LIVE" ? "green" : "red"
        }>
          ● {connection}
        </div>
      </header>

      <section className="panel">
        <h2>CONNECTION DIAGNOSTICS</h2>

        <div className="small">
          Deriv App ID: {APP_ID}
        </div>

        <div className="small">
          Last tick received: {lastUpdate}
        </div>

        {connectionError && (
          <p className="red">
            {connectionError}
          </p>
        )}

        <button onClick={() => window.location.reload()}>
          RELOAD CONNECTION
        </button>
      </section>

      <section className="panel">
        <h2>LIVE MARKET SCANNER</h2>

        <div className="controls">
          <div>
            <label>SELECT MARKET</label>

            <select
              value={market}
              onChange={e => setMarket(e.target.value)}
            >
              {MARKETS.map(m => (
                <option key={m.symbol} value={m.symbol}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label>ANALYSIS HISTORY</label>

            <select
              value={lookback}
              onChange={e => setLookback(Number(e.target.value))}
            >
              <option value={100}>100 TICKS</option>
              <option value={500}>500 TICKS</option>
              <option value={1000}>1000 TICKS</option>
            </select>
          </div>
        </div>

        <div className="grid">
          <div className="stat">
            <div className="small">LATEST PRICE</div>
            <div className="digit">
              {latest ?? "--"}
            </div>
          </div>

          <div className="stat">
            <div className="small">TICKS COLLECTED</div>
            <div className="digit">{ticks.length}</div>
          </div>

          <div className="stat">
            <div className="small">LAST DIGIT</div>
            <div className="digit">{currentDigit}</div>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>ALL MARKET SCANNER</h2>

        <div className="grid">
          {MARKETS.map(m => {
            const item = markets[m.symbol];

            return (
              <div className="stat" key={m.symbol}>
                <b>{m.name}</b>

                <div className="green">
                  {item?.ticks.length || 0} ticks
                </div>

                <div className="small">
                  {item?.latest ?? "Waiting for feed"}
                </div>

                <button onClick={() => setMarket(m.symbol)}>
                  ANALYSE
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <h2>LAST DIGIT DISTRIBUTION</h2>

        <div className="grid">
          {counts.map((count, index) => (
            <div className="stat" key={index}>
              <div className="digit">{index}</div>

              <b>{count}</b>

              <div className="small">
                {total
                  ? (count / total * 100).toFixed(1)
                  : "0.0"}%
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>CONTRACT ANALYSIS</h2>

        <div className="controls">
          <div>
            <label>CONTRACT TYPE</label>

            <select
              value={contract}
              onChange={e => setContract(e.target.value)}
            >
              {[
                "Matches", "Differs", "Even", "Odd",
                "Over", "Under", "Rise", "Fall"
              ].map(c => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>

          <div>
            <label>MATCH DIGIT</label>

            <select
              value={target}
              onChange={e => setTarget(e.target.value)}
            >
              {Array.from({ length: 10 }, (_, i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </div>

          <div>
            <label>OVER/UNDER BARRIER</label>

            <select
              value={barrier}
              onChange={e => setBarrier(e.target.value)}
            >
              {Array.from({ length: 9 }, (_, i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid">
          {[
            ["MATCHES " + target, matchPct],
            ["DIFFERS " + target, differPct],
            ["EVEN", even],
            ["ODD", odd],
            ["OVER " + barrier, over],
            ["UNDER " + barrier, under],
            ["RISE", risePct],
            ["FALL", fallPct]
          ].map(([name, value]) => (
            <div className="stat" key={String(name)}>
              <div className="small">{name}</div>
              <h2>{Number(value).toFixed(1)}%</h2>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>AI ANALYSIS ENGINE</h2>

        <div className="small">
          MARKET: {MARKETS.find(m => m.symbol === market)?.name}
        </div>

        <div className="small">
          ANALYSIS SAMPLE: {total} TICKS
        </div>

        <div className="digit">{signal}</div>

        <p className="small">
          {total < 30
            ? "Collecting ticks. At least 30 observations are needed."
            : "Signals are based on historical frequency, not guaranteed future outcomes."}
        </p>

        <button
          onClick={() => setScannerActive(!scannerActive)}
        >
          {scannerActive ? "PAUSE SCANNER" : "START SCANNER"}
        </button>
      </section>

      <section className="panel">
        <h2>TRADE EXECUTION</h2>

        <div className="small">
          Deriv account authorization and order execution
          will be added after live data connection is verified.
        </div>

        <p className="red">NO LIVE ORDERS ENABLED</p>

        <button disabled>
          EXECUTE TRADE — COMING NEXT
        </button>
      </section>

      <footer className="small" style={{ marginTop: 25 }}>
        HOPE AI DERIV ANALYZER PRO · V2.0
      </footer>

    </main>
  );
}
