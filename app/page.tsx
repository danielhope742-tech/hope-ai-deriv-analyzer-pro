
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
  connected: boolean;
  latest: number | null;
  previous: number | null;
};

export default function Home() {
  const [market, setMarket] = useState("R_100");
  const [contract, setContract] = useState("Matches");
  const [target, setTarget] = useState("5");
  const [barrier, setBarrier] = useState("5");
  const [markets, setMarkets] = useState<Record<string, MarketData>>({});
  const [connection, setConnection] = useState("Connecting...");
  const [scanning, setScanning] = useState(true);
  const [lookback, setLookback] = useState(100);

  useEffect(() => {
    let socket: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let active = true;

    const connect = () => {
      if (!active) return;

      socket = new WebSocket(
        `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`
      );

      socket.onopen = () => {
        if (!active) return;
        setConnection("LIVE");
        MARKETS.forEach(item => {
          socket.send(JSON.stringify({
            ticks: item.symbol,
            subscribe: 1
          }));
        });
      };

      socket.onmessage = event => {
        if (!active) return;

        try {
          const data = JSON.parse(event.data);

          if (data.error) {
            setConnection("API error: " + data.error.message);
            return;
          }

          if (data.msg_type !== "tick" || !data.tick) return;

          const tick = data.tick;
          const symbol = tick.symbol;
          const quote = Number(tick.quote);
          const precision = Number(tick.pip_size ?? 2);
          const formatted = quote.toFixed(precision);
          const digit = Number(formatted.slice(-1));

          setMarkets(previous => {
            const old = previous[symbol] || {
              ticks: [],
              connected: true,
              latest: null,
              previous: null
            };

            const nextTick = {
              quote,
              digit,
              time: Number(tick.epoch)
            };

            return {
              ...previous,
              [symbol]: {
                ticks: [...old.ticks, nextTick].slice(-1000),
                connected: true,
                latest: quote,
                previous: old.latest
              }
            };
          });
        } catch {
          setConnection("Reading market data...");
        }
      };

      socket.onerror = () => {
        if (active) setConnection("Connection error");
      };

      socket.onclose = () => {
        if (!active) return;
        setConnection("Reconnecting...");
        reconnectTimer = setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      active = false;
      clearTimeout(reconnectTimer);
      if (socket) socket.close();
    };
  }, []);

  const data = markets[market];
  const ticks = data?.ticks || [];
  const recent = ticks.slice(-lookback);
  const counts = Array(10).fill(0);

  recent.forEach(tick => counts[tick.digit]++);

  const total = recent.length;
  const selectedDigit = Number(target);
  const matchPct = total
    ? counts[selectedDigit] / total * 100
    : 0;
  const differPct = 100 - matchPct;

  const even = total
    ? recent.filter(t => t.digit % 2 === 0).length / total * 100
    : 0;

  const odd = 100 - even;

  const over = total
    ? recent.filter(t => t.digit > Number(barrier)).length / total * 100
    : 0;

  const under = total
    ? recent.filter(t => t.digit < Number(barrier)).length / total * 100
    : 0;

  const rising = recent.slice(1).filter(
    (t, i) => t.quote > recent[i].quote
  ).length;

  const falling = Math.max(0, total - 1 - rising);

  const risePct = total > 1 ? rising / (total - 1) * 100 : 0;
  const fallPct = total > 1 ? falling / (total - 1) * 100 : 0;

  const analysis = useMemo(() => {
    if (total < 30) return "COLLECTING TICKS";

    if (contract === "Matches") {
      return matchPct > 15 ? "CHECK MATCH" : "WAIT";
    }

    if (contract === "Differs") {
      return differPct > 90 ? "CHECK DIFFER" : "WAIT";
    }

    if (contract === "Even") {
      return even > 55 ? "CHECK EVEN" : "WAIT";
    }

    if (contract === "Odd") {
      return odd > 55 ? "CHECK ODD" : "WAIT";
    }

    if (contract === "Over") {
      return over > 55 ? "CHECK OVER" : "WAIT";
    }

    if (contract === "Under") {
      return under > 55 ? "CHECK UNDER" : "WAIT";
    }

    if (contract === "Rise") {
      return risePct > 55 ? "CHECK RISE" : "WAIT";
    }

    if (contract === "Fall") {
      return fallPct > 55 ? "CHECK FALL" : "WAIT";
    }

    return "WAIT";
  }, [
    total, contract, matchPct, differPct,
    even, odd, over, under, risePct, fallPct
  ]);

  const latest = data?.latest;
  const selectedMarket = MARKETS.find(m => m.symbol === market);

  return (
    <main className="dashboard">
      <header className="header">
        <div>
          <div className="logo">HOPE AI</div>
          <div className="small">DERIV ANALYZER PRO · V1.0</div>
        </div>
        <div className="green">● {connection}</div>
      </header>

      <section className="panel">
        <h2>LIVE MARKET SCANNER</h2>
        <div className="controls">
          <div>
            <label>SELECT MARKET</label>
            <select value={market}
              onChange={e => setMarket(e.target.value)}>
              {MARKETS.map(m => (
                <option key={m.symbol} value={m.symbol}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label>ANALYSIS HISTORY</label>
            <select value={lookback}
              onChange={e => setLookback(Number(e.target.value))}>
              <option value={100}>100 ticks</option>
              <option value={500}>500 ticks</option>
              <option value={1000}>1000 ticks</option>
            </select>
          </div>
        </div>

        <div className="grid">
          <div className="stat">
            <div className="small">LATEST PRICE</div>
            <div className="digit">
              {latest === undefined || latest === null
                ? "--" : latest}
            </div>
          </div>
          <div className="stat">
            <div className="small">TICKS COLLECTED</div>
            <div className="digit">{ticks.length}</div>
          </div>
          <div className="stat">
            <div className="small">CURRENT LAST DIGIT</div>
            <div className="digit">
              {ticks.length ? ticks[ticks.length - 1].digit : "--"}
            </div>
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
        <h2>DIGIT DISTRIBUTION</h2>
        <div className="grid">
          {counts.map((count, digit) => (
            <div className="stat" key={digit}>
              <div className="digit">{digit}</div>
              <b>{count}</b>
              <div className="small">
                {total ? (count / total * 100).toFixed(1) : "0.0"}%
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
            <select value={contract}
              onChange={e => setContract(e.target.value)}>
              {[
                "Matches", "Differs", "Even", "Odd",
                "Over", "Under", "Rise", "Fall"
              ].map(c => <option key={c}>{c}</option>)}
            </select>
          </div>

          <div>
            <label>MATCH DIGIT</label>
            <select value={target}
              onChange={e => setTarget(e.target.value)}>
              {Array.from({ length: 10 }, (_, i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </div>

          <div>
            <label>OVER/UNDER BARRIER</label>
            <select value={barrier}
              onChange={e => setBarrier(e.target.value)}>
              {Array.from({ length: 9 }, (_, i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid">
          <div className="stat">
            <div className="small">MATCHES {target}</div>
            <h2>{matchPct.toFixed(1)}%</h2>
          </div>
          <div className="stat">
            <div className="small">DIFFERS {target}</div>
            <h2>{differPct.toFixed(1)}%</h2>
          </div>
          <div className="stat">
            <div className="small">EVEN</div>
            <h2>{even.toFixed(1)}%</h2>
          </div>
          <div className="stat">
            <div className="small">ODD</div>
            <h2>{odd.toFixed(1)}%</h2>
          </div>
          <div className="stat">
            <div className="small">OVER {barrier}</div>
            <h2>{over.toFixed(1)}%</h2>
          </div>
          <div className="stat">
            <div className="small">UNDER {barrier}</div>
            <h2>{under.toFixed(1)}%</h2>
          </div>
          <div className="stat">
            <div className="small">RISE</div>
            <h2>{risePct.toFixed(1)}%</h2>
          </div>
          <div className="stat">
            <div className="small">FALL</div>
            <h2>{fallPct.toFixed(1)}%</h2>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>AI ANALYSIS ENGINE</h2>
        <div className="small">
          MARKET: {selectedMarket?.name} · HISTORY: {total} TICKS
        </div>
        <div className="digit">{analysis}</div>
        <p className="small">
          {total < 30
            ? "Collecting at least 30 ticks before analysis."
            : "Statistical observation only. Historical frequency does not guarantee the next result."}
        </p>
        <button onClick={() => setScanning(!scanning)}>
          {scanning ? "SCANNER ACTIVE" : "SCANNER PAUSED"}
        </button>
      </section>

      <section className="panel">
        <h2>TRADE EXECUTION</h2>
        <div className="small">
          Execution will be connected after secure Deriv
          account authorization and demo testing.
        </div>
        <p className="red">NO LIVE ORDERS ENABLED</p>
        <button disabled>EXECUTE TRADE — COMING NEXT</button>
      </section>

      <footer className="small" style={{ marginTop: 25 }}>
        HOPE AI DERIV ANALYZER PRO · Market data analysis
      </footer>
    </main>
  );
}
