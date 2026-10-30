
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";

const MARKETS = [
  { symbol: "R_10", name: "Volatility 10" },
  { symbol: "R_25", name: "Volatility 25" },
  { symbol: "R_50", name: "Volatility 50" },
  { symbol: "R_75", name: "Volatility 75" },
  { symbol: "R_100", name: "Volatility 100" },
  { symbol: "1HZ10V", name: "Volatility 10 (1s)" },
  { symbol: "1HZ25V", name: "Volatility 25 (1s)" },
  { symbol: "1HZ50V", name: "Volatility 50 (1s)" },
  { symbol: "1HZ75V", name: "Volatility 75 (1s)" },
  { symbol: "1HZ100V", name: "Volatility 100 (1s)" },
];

type Tick = {
  quote: number;
  digit: number;
  time: number;
};

type MarketState = {
  ticks: Tick[];
  price: number | null;
  pipSize: number;
  status: string;
};

type Contract =
  | "MATCHES"
  | "DIFFERS"
  | "EVEN"
  | "ODD"
  | "RISE"
  | "FALL";

type Candidate = {
  contract: Contract;
  target?: number;
  sampleRate: number;
  baseline: number;
  edge: number;
  recentRate: number;
  label: string;
};

const blankMarket = (): MarketState => ({
  ticks: [],
  price: null,
  pipSize: 0.01,
  status: "WAITING",
});

const initialMarkets = (): Record<string, MarketState> =>
  Object.fromEntries(
    MARKETS.map((market) => [market.symbol, blankMarket()])
  );

function decimals(pip: number): number {
  if (!Number.isFinite(pip) || pip <= 0) return 2;

  if (pip >= 1) {
    return Math.min(10, Math.round(pip));
  }

  const value = pip.toString();

  if (value.includes("e-")) {
    return Math.min(10, Number(value.split("e-")[1]));
  }

  return Math.min(10, (value.split(".")[1] || "").length);
}

function lastDigit(price: number, pip: number): number {
  const digits = price
    .toFixed(decimals(pip))
    .replace(".", "");

  return Number(digits[digits.length - 1]);
}

function percentage(count: number, total: number): number {
  return total > 0 ? (count / total) * 100 : 0;
}

function buildCandidates(
  ticks: Tick[],
  target: number
): Candidate[] {
  if (ticks.length < 100) return [];

  const recent = ticks.slice(-100);
  const digits = ticks.map((tick) => tick.digit);
  const recentDigits = recent.map((tick) => tick.digit);

  const candidates: Candidate[] = [];

  const matchFull = percentage(
    digits.filter((digit) => digit === target).length,
    digits.length
  );

  const matchRecent = percentage(
    recentDigits.filter((digit) => digit === target).length,
    recentDigits.length
  );

  const matchRate = 0.65 * matchFull + 0.35 * matchRecent;

  candidates.push({
    contract: "MATCHES",
    target,
    sampleRate: matchFull,
    baseline: 10,
    edge: matchRate - 10,
    recentRate: matchRecent,
    label: `Matches ${target}`,
  });

  const differFull = 100 - matchFull;
  const differRecent = 100 - matchRecent;
  const differRate = 0.65 * differFull + 0.35 * differRecent;

  candidates.push({
    contract: "DIFFERS",
    target,
    sampleRate: differFull,
    baseline: 90,
    edge: differRate - 90,
    recentRate: differRecent,
    label: `Differs ${target}`,
  });

  const evenFull = percentage(
    digits.filter((digit) => digit % 2 === 0).length,
    digits.length
  );

  const evenRecent = percentage(
    recentDigits.filter((digit) => digit % 2 === 0).length,
    recentDigits.length
  );

  const oddFull = 100 - evenFull;
  const oddRecent = 100 - evenRecent;

  const evenRate = 0.65 * evenFull + 0.35 * evenRecent;
  const oddRate = 0.65 * oddFull + 0.35 * oddRecent;

  candidates.push({
    contract: "EVEN",
    sampleRate: evenFull,
    baseline: 50,
    edge: evenRate - 50,
    recentRate: evenRecent,
    label: "Even",
  });

  candidates.push({
    contract: "ODD",
    sampleRate: oddFull,
    baseline: 50,
    edge: oddRate - 50,
    recentRate: oddRecent,
    label: "Odd",
  });

  let rises = 0;
  let falls = 0;
  const directions: number[] = [];

  for (let i = 1; i < ticks.length; i++) {
    const direction = Math.sign(
      ticks[i].quote - ticks[i - 1].quote
    );

    if (direction > 0) {
      rises++;
      directions.push(1);
    } else if (direction < 0) {
      falls++;
      directions.push(-1);
    }
  }

  const directionTotal = rises + falls;

  if (directionTotal >= 50) {
    const recentDirections = directions.slice(-100);

    const riseFull = percentage(rises, directionTotal);
    const riseRecent = percentage(
      recentDirections.filter((direction) => direction > 0).length,
      recentDirections.length
    );

    const fallFull = 100 - riseFull;
    const fallRecent = 100 - riseRecent;

    const riseRate = 0.65 * riseFull + 0.35 * riseRecent;
    const fallRate = 0.65 * fallFull + 0.35 * fallRecent;

    candidates.push({
      contract: "RISE",
      sampleRate: riseFull,
      baseline: 50,
      edge: riseRate - 50,
      recentRate: riseRecent,
      label: "Rise",
    });

    candidates.push({
      contract: "FALL",
      sampleRate: fallFull,
      baseline: 50,
      edge: fallRate - 50,
      recentRate: fallRecent,
      label: "Fall",
    });
  }

  return candidates.sort((a, b) => b.edge - a.edge);
}

export default function Home() {
  const [selectedMarket, setSelectedMarket] = useState("R_100");
  const [markets, setMarkets] =
    useState<Record<string, MarketState>>(initialMarkets);

  const [status, setStatus] = useState("CONNECTING");
  const [error, setError] = useState("");
  const [received, setReceived] = useState(0);
  const [scannerOn, setScannerOn] = useState(true);
  const [windowSize, setWindowSize] = useState(500);
  const [target, setTarget] = useState(5);

  const [analysis, setAnalysis] = useState<Candidate | null>(null);
  const [analysisMessage, setAnalysisMessage] = useState(
    "Collecting live ticks. At least 100 are needed before screening signals."
  );

  const socketRef = useRef<WebSocket | null>(null);
  const marketsRef = useRef(markets);
  const scannerRef = useRef(scannerOn);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    marketsRef.current = markets;
  }, [markets]);

  useEffect(() => {
    scannerRef.current = scannerOn;
  }, [scannerOn]);

  useEffect(() => {
    stoppedRef.current = false;

    let delay = 2500;

    const connect = () => {
      if (stoppedRef.current) return;

      setStatus("CONNECTING");

      let ws: WebSocket;

      try {
        ws = new WebSocket(WS_URL);
        socketRef.current = ws;
      } catch {
        setStatus("ERROR");
        setError("Could not start the Deriv connection.");

        reconnectRef.current = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
        return;
      }

      ws.onopen = () => {
        if (stoppedRef.current) return;

        delay = 2500;
        setStatus("CONNECTED");
        setError("");

        ws.send(
          JSON.stringify({
            active_symbols: "brief",
            req_id: 1,
          })
        );
      };

      ws.onmessage = (event) => {
        if (stoppedRef.current) return;

        setReceived((count) => count + 1);

        let message: any;

        try {
          message = JSON.parse(event.data);
        } catch {
          setError("Could not read the Deriv response.");
          return;
        }

        if (message.error) {
          setError(
            message.error.message ||
              message.error.code ||
              "Deriv API error."
          );
          return;
        }

        if (Array.isArray(message.active_symbols)) {
          const active = message.active_symbols
            .map((item: any) => ({
              symbol: item.symbol || item.underlying_symbol,
              pip: Number(item.pip_size ?? item.pip ?? 0.01) || 0.01,
            }))
            .filter((item: any) =>
              MARKETS.some((market) => market.symbol === item.symbol)
            );

          if (active.length === 0) {
            setError("Deriv did not return any of the requested markets.");
            return;
          }

          setMarkets((previous) => {
            const next = { ...previous };

            active.forEach((item: any) => {
              next[item.symbol] = {
                ...next[item.symbol],
                pipSize: item.pip,
                status: "SUBSCRIBING",
              };
            });

            return next;
          });

          active.forEach((item: any, index: number) => {
            if (ws.readyState !== WebSocket.OPEN) return;

            ws.send(
              JSON.stringify({
                ticks: item.symbol,
                subscribe: 1,
                req_id: 100 + index,
              })
            );
          });

          if (active.length !== MARKETS.length) {
            setError(
              `Deriv returned ${active.length} of ${MARKETS.length} requested markets.`
            );
          }

          return;
        }

        if (message.tick?.symbol) {
          const symbol = message.tick.symbol;
          const quote = Number(message.tick.quote);

          if (
            !Number.isFinite(quote) ||
            !MARKETS.some((market) => market.symbol === symbol) ||
            !scannerRef.current
          ) {
            return;
          }

          const oldMarket =
            marketsRef.current[symbol] || blankMarket();

          const pip =
            Number(message.tick.pip_size) ||
            oldMarket.pipSize ||
            0.01;

          const tick: Tick = {
            quote,
            digit: lastDigit(quote, pip),
            time: Number(message.tick.epoch) || Date.now() / 1000,
          };

          setMarkets((previous) => {
            const current = previous[symbol] || blankMarket();

            return {
              ...previous,
              [symbol]: {
                ...current,
                ticks: [...current.ticks, tick].slice(-1000),
                price: quote,
                pipSize: pip,
                status: "LIVE",
              },
            };
          });

          setError("");
        }
      };

      ws.onerror = () => {
        if (!stoppedRef.current) {
          setStatus("ERROR");
          setError("WebSocket error. Check your internet connection.");
        }
      };

      ws.onclose = (event) => {
        if (stoppedRef.current) return;

        setStatus("DISCONNECTED");
        setError(`Connection closed (${event.code}). Reconnecting…`);

        reconnectRef.current = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      };
    };

    connect();

    return () => {
      stoppedRef.current = true;

      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
      }

      if (socketRef.current) {
        socketRef.current.onopen = null;
        socketRef.current.onmessage = null;
        socketRef.current.onerror = null;
        socketRef.current.onclose = null;
        socketRef.current.close();
      }
    };
  }, []);

  const selected = markets[selectedMarket] || blankMarket();

  const ticks = useMemo(
    () => selected.ticks.slice(-windowSize),
    [selected.ticks, windowSize]
  );

  const digitCounts = useMemo(
    () =>
      Array.from({ length: 10 }, (_, digit) =>
        ticks.filter((tick) => tick.digit === digit).length
      ),
    [ticks]
  );

  const last = ticks[ticks.length - 1];

  const candidates = useMemo(
    () => buildCandidates(ticks, target),
    [ticks, target]
  );

  function analyseNow() {
    if (ticks.length < 100) {
      setAnalysis(null);
      setAnalysisMessage(
        `NO CONFIDENT SIGNAL — only ${ticks.length} ticks collected. At least 100 are needed for an initial screen.`
      );
      return;
    }

    const best = candidates[0];

    if (
      !best ||
      best.edge < 3 ||
      best.recentRate < best.baseline + 1
    ) {
      setAnalysis(null);
      setAnalysisMessage(
        "NO CONFIDENT SIGNAL — the historical sample does not show a sufficiently consistent difference from baseline."
      );
      return;
    }

    setAnalysis(best);
    setAnalysisMessage(
      "A statistical candidate was found for review. It is not a prediction guarantee or a trade instruction."
    );
  }

  const panel: CSSProperties = {
    background: "#151d30",
    border: "1px solid #293a58",
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
  };

  const muted: CSSProperties = {
    color: "#a9bad2",
    fontSize: 13,
  };

  const selectStyle: CSSProperties = {
    width: "100%",
    padding: 12,
    marginTop: 6,
    borderRadius: 8,
    background: "#0c1526",
    color: "white",
    border: "1px solid #405575",
  };

  const button: CSSProperties = {
    padding: "11px 14px",
    borderRadius: 9,
    border: "1px solid #496487",
    background: "#263b5d",
    color: "white",
    fontWeight: 700,
    cursor: "pointer",
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        maxWidth: 900,
        margin: "0 auto",
        padding: "18px 14px 40px",
        background: "#080e1b",
        color: "#f1f5ff",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <header style={{ marginBottom: 20 }}>
        <div
          style={{
            color: "#55d6be",
            fontSize: 12,
            fontWeight: 800,
          }}
        >
          HOPE AI • DERIV ANALYZER PRO V2.40
        </div>

        <h1 style={{ fontSize: 27, margin: "8px 0" }}>
          HOPE AI DERIV ANALYZER PRO
        </h1>

        <p style={muted}>
          Live synthetic-market monitoring and statistical signal screening
        </p>
      </header>

      <section style={panel}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          PUBLIC MARKET CONNECTION
        </h2>

        <strong
          style={{
            color: status === "CONNECTED" ? "#36d399" : "#ffc66d",
          }}
        >
          ● {status}
        </strong>

        <p style={muted}>
          Messages received: {received} · Public prices only · No account token used
        </p>

        {error && (
          <p style={{ color: "#ff9292", fontSize: 13 }}>{error}</p>
        )}

        <p style={muted}>
          This connection does not access your balance or place trades.
        </p>
      </section>

      <section style={panel}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>MARKET SELECTOR</h2>

        <label style={muted}>Choose one of the 10 synthetic markets</label>

        <select
          style={selectStyle}
          value={selectedMarket}
          onChange={(event) => {
            setSelectedMarket(event.target.value);
            setAnalysis(null);
            setAnalysisMessage("Market changed. Collect ticks and analyse again.");
          }}
        >
          {MARKETS.map((market) => (
            <option key={market.symbol} value={market.symbol}>
              {market.name} ({market.symbol})
            </option>
          ))}
        </select>

        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={muted}>Latest price</div>
            <strong>{selected.price ?? "--"}</strong>
          </div>

          <div style={{ flex: 1 }}>
            <div style={muted}>Last digit</div>
            <strong style={{ color: "#55d6be", fontSize: 24 }}>
              {last?.digit ?? "--"}
            </strong>
          </div>

          <div style={{ flex: 1 }}>
            <div style={muted}>Ticks in window</div>
            <strong>{ticks.length}</strong>
          </div>
        </div>

        <p style={muted}>
          Market feed: {selected.status}. Up to 1,000 ticks are stored per market during this session.
        </p>
      </section>

      <section style={panel}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>ANALYSIS SETTINGS</h2>

        <label style={muted}>Historical window</label>

        <select
          style={selectStyle}
          value={windowSize}
          onChange={(event) => {
            setWindowSize(Number(event.target.value));
            setAnalysis(null);
          }}
        >
          {[100, 500, 1000].map((size) => (
            <option key={size} value={size}>
              Last {size} ticks
            </option>
          ))}
        </select>

        <label
          style={{ ...muted, display: "block", marginTop: 14 }}
        >
          Target digit for Matches/Differs
        </label>

        <select
          style={selectStyle}
          value={target}
          onChange={(event) => setTarget(Number(event.target.value))}
        >
          {Array.from({ length: 10 }, (_, digit) => (
            <option key={digit} value={digit}>
              Digit {digit}
            </option>
          ))}
        </select>

        <p style={muted}>
          Supported contracts: Matches, Differs, Even, Odd, Rise and Fall.
          Over/Under and barrier controls have been removed.
        </p>
      </section>

      <section style={panel}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          DIGIT DISTRIBUTION
        </h2>

        {digitCounts.map((count, digit) => {
          const value = percentage(count, ticks.length);

          return (
            <div key={digit} style={{ marginBottom: 11 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 13,
                  marginBottom: 4,
                }}
              >
                <span>Digit {digit}</span>
                <span>
                  {value.toFixed(1)}% ({count})
                </span>
              </div>

              <div
                style={{
                  height: 8,
                  borderRadius: 20,
                  background: "#293750",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${value}%`,
                    height: "100%",
                    background: "#55d6be",
                  }}
                />
              </div>
            </div>
          );
        })}
      </section>

      <section style={panel}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          SIGNAL ANALYSIS ENGINE
        </h2>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button style={button} onClick={analyseNow}>
            ANALYSE NOW
          </button>

          <button
            style={button}
            onClick={() => setScannerOn((value) => !value)}
          >
            {scannerOn ? "PAUSE SCANNER" : "RESUME SCANNER"}
          </button>
        </div>

        <p
          style={{
            marginTop: 18,
            color: analysis ? "#55d6be" : "#ffc66d",
            fontWeight: 800,
          }}
        >
          {analysis ? "CANDIDATE FOR REVIEW" : "SIGNAL STATUS"}
        </p>

        <p>{analysisMessage}</p>

        {analysis && (
          <div
            style={{
              background: "#0c1526",
              borderRadius: 10,
              padding: 12,
              marginTop: 10,
            }}
          >
            <strong style={{ fontSize: 20 }}>{analysis.label}</strong>

            <p style={muted}>
              Full-window historical rate: {analysis.sampleRate.toFixed(1)}%
            </p>

            <p style={muted}>
              Recent 100-tick rate: {analysis.recentRate.toFixed(1)}%
            </p>

            <p style={muted}>
              Difference from baseline: {analysis.edge.toFixed(1)} percentage points
            </p>

            <p style={{ color: "#ffc66d", fontSize: 13 }}>
              This is a statistical screening result, not a true next-tick probability or a trade instruction.
            </p>
          </div>
        )}

        <p style={muted}>
          The engine compares the selected Matches/Differs digit, Even/Odd,
          and Rise/Fall. It requires at least 100 ticks and a historical
          difference from baseline. This screening method is experimental
          and has not yet been validated on unseen data.
        </p>
      </section>

      <section style={panel}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          ALL MARKETS STATUS
        </h2>

        {MARKETS.map((market) => {
          const data = markets[market.symbol] || blankMarket();

          return (
            <div
              key={market.symbol}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                padding: "9px 0",
                borderBottom: "1px solid #293650",
                fontSize: 13,
              }}
            >
              <span>{market.name}</span>

              <span
                style={{
                  color: data.status === "LIVE" ? "#36d399" : "#ffc66d",
                }}
              >
                {data.status === "LIVE" ? data.price : data.status}
              </span>
            </div>
          );
        })}
      </section>

      <section style={panel}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          ACCOUNT & MANUAL TRADE APPROVAL
        </h2>

        <strong style={{ color: "#ffc66d" }}>
          ACCOUNT NOT CONNECTED
        </strong>

        <p style={muted}>
          This version is a public market scanner and analysis tool.
          OAuth account connection, demo trade proposals, and a separate
          approval step still need to be implemented and tested securely.
        </p>

        <button
          style={{
            ...button,
            width: "100%",
            opacity: 0.55,
            cursor: "not-allowed",
          }}
          disabled
        >
          DEMO TRADE — NOT CONNECTED
        </button>

        <p style={{ color: "#ffc66d", fontSize: 13 }}>
          No trades are placed by this page. Never paste your Deriv access
          token into browser code.
        </p>
      </section>

      <footer style={{ ...muted, textAlign: "center" }}>
        HOPE AI DERIV ANALYZER PRO · PUBLIC MARKET DATA BUILD
      </footer>
    </main>
  );
}
