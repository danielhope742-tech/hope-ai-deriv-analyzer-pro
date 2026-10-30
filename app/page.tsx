
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const STORAGE_KEY = "hope-ai-deriv-history-v242";
const MAX_TICKS = 10000;
const TRAINING_TICKS = 100;

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

const CONTRACTS = [
  "MATCHES",
  "DIFFERS",
  "EVEN",
  "ODD",
  "RISE",
  "FALL",
] as const;

type Contract = (typeof CONTRACTS)[number];

type Tick = {
  quote: number;
  digit: number;
  time: number;
};

type Prediction = {
  contract: Contract;
  digit?: number;
  expected: string;
  reason: string;
};

type TestResult = {
  prediction: Prediction;
  correct: boolean;
  time: number;
};

type MarketHistory = Record<string, Tick[]>;

function getDigit(price: number, pip: number): number {
  const decimals = Math.max(
    0,
    Math.min(10, Math.round(-Math.log10(pip)))
  );

  const formatted = price.toFixed(decimals);
  return Number(formatted.replace(".", "").slice(-1));
}

function countDigits(ticks: Tick[]) {
  const counts = Array(10).fill(0);

  ticks.forEach((tick) => {
    counts[tick.digit]++;
  });

  return counts;
}

function makePrediction(
  ticks: Tick[],
  contract: Contract
): Prediction | null {
  if (ticks.length < TRAINING_TICKS) return null;

  const sample = ticks.slice(-500);
  const counts = countDigits(sample);
  const total = sample.length;

  if (contract === "MATCHES") {
    const digit = counts.indexOf(Math.max(...counts));

    return {
      contract,
      digit,
      expected: `Digit ${digit}`,
      reason: `Digit ${digit} appeared most often in the training sample.`,
    };
  }

  if (contract === "DIFFERS") {
    const digit = counts.indexOf(Math.min(...counts));

    return {
      contract,
      digit,
      expected: `Differs from digit ${digit}`,
      reason: `Digit ${digit} appeared least often in the training sample.`,
    };
  }

  if (contract === "EVEN" || contract === "ODD") {
    const even = counts.reduce(
      (sum, count, digit) =>
        sum + (digit % 2 === 0 ? count : 0),
      0
    );

    const odd = total - even;
    const chosen = even >= odd ? "EVEN" : "ODD";

    return {
      contract,
      expected: chosen,
      reason: `Even: ${even} observations; Odd: ${odd} observations.`,
    };
  }

  let rises = 0;
  let falls = 0;

  for (let i = 1; i < sample.length; i++) {
    if (sample[i].quote > sample[i - 1].quote) rises++;
    if (sample[i].quote < sample[i - 1].quote) falls++;
  }

  const chosen = rises >= falls ? "RISE" : "FALL";

  return {
    contract,
    expected: chosen,
    reason: `Training movements: ${rises} rises and ${falls} falls.`,
  };
}

function evaluatePrediction(
  prediction: Prediction,
  nextTick: Tick,
  previousTick: Tick
): boolean {
  switch (prediction.contract) {
    case "MATCHES":
      return nextTick.digit === prediction.digit;

    case "DIFFERS":
      return nextTick.digit !== prediction.digit;

    case "EVEN":
      return nextTick.digit % 2 === 0;

    case "ODD":
      return nextTick.digit % 2 !== 0;

    case "RISE":
      return nextTick.quote > previousTick.quote;

    case "FALL":
      return nextTick.quote < previousTick.quote;

    default:
      return false;
  }
}

function getWalkForwardResults(
  ticks: Tick[],
  contract: Contract
): TestResult[] {
  const results: TestResult[] = [];

  // Test the most recent 1,000 possible predictions.
  const start = Math.max(TRAINING_TICKS, ticks.length - 1000);

  for (let i = start; i < ticks.length; i++) {
    const training = ticks.slice(Math.max(0, i - 500), i);
    const prediction = makePrediction(training, contract);

    if (!prediction) continue;

    const previousTick = ticks[i - 1];
    const nextTick = ticks[i];

    // Flat price movements are excluded from Rise/Fall testing.
    if (
      (contract === "RISE" || contract === "FALL") &&
      nextTick.quote === previousTick.quote
    ) {
      continue;
    }

    results.push({
      prediction,
      correct: evaluatePrediction(
        prediction,
        nextTick,
        previousTick
      ),
      time: nextTick.time,
    });
  }

  return results;
}

function emptyHistory(): MarketHistory {
  return Object.fromEntries(
    MARKETS.map((market) => [market.symbol, []])
  );
}

export default function Home() {
  const [history, setHistory] = useState<MarketHistory>(emptyHistory);
  const [selectedMarket, setSelectedMarket] = useState("R_100");
  const [contract, setContract] = useState<Contract>("MATCHES");
  const [connection, setConnection] = useState("CONNECTING");
  const [error, setError] = useState("");
  const [scannerOn, setScannerOn] = useState(true);
  const [loaded, setLoaded] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const historyRef = useRef<MarketHistory>(emptyHistory());
  const scannerRef = useRef(true);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  const pipRef = useRef<Record<string, number>>({});

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);

      if (saved) {
        const parsed = JSON.parse(saved) as MarketHistory;
        const restored = emptyHistory();

        MARKETS.forEach(({ symbol }) => {
          if (Array.isArray(parsed[symbol])) {
            restored[symbol] = parsed[symbol].slice(-MAX_TICKS);
          }
        });

        historyRef.current = restored;
        setHistory(restored);
      }
    } catch {
      setError("Saved history could not be loaded.");
    }

    setLoaded(true);
  }, []);

  useEffect(() => {
    scannerRef.current = scannerOn;
  }, [scannerOn]);

  useEffect(() => {
    if (!loaded) return;

    const save = setTimeout(() => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify(history)
        );
      } catch {
        setError("Phone storage is full. Some history may not save.");
      }
    }, 500);

    return () => clearTimeout(save);
  }, [history, loaded]);

  useEffect(() => {
    if (!loaded) return;

    stoppedRef.current = false;
    let reconnectDelay = 2500;

    function connect() {
      if (stoppedRef.current) return;

      setConnection("CONNECTING");

      let ws: WebSocket;

      try {
        ws = new WebSocket(WS_URL);
        socketRef.current = ws;
      } catch {
        setConnection("ERROR");
        reconnectRef.current = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        return;
      }

      ws.onopen = () => {
        if (stoppedRef.current) return;

        reconnectDelay = 2500;
        setConnection("CONNECTED");
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

        let message: any;

        try {
          message = JSON.parse(event.data);
        } catch {
          setError("Invalid response received from Deriv.");
          return;
        }

        if (message.error) {
          setError(message.error.message || "Deriv API error.");
          return;
        }


if (Array.isArray(message.active_symbols)) {
  const available = message.active_symbols
    .map((item: any) => ({
      symbol: item.underlying_symbol || item.symbol,
      pip: Number(item.pip_size ?? item.pip) || 0.01,
    }))
    .filter((item: any) =>
      MARKETS.some((market) => market.symbol === item.symbol)
    );

  available.forEach((item: any, index: number) => {
    pipRef.current[item.symbol] = item.pip;

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          ticks: item.symbol,
          subscribe: 1,
          req_id: 100 + index,
        })
      );
    }
  });

  if (available.length === 0) {
    setError(
      "No matching markets found. Check the active_symbols response."
    );
  } else {
    setError("");
  }

  return;
}


        if (message.tick?.symbol) {
          const symbol = message.tick.symbol;

          if (
            !scannerRef.current ||
            !MARKETS.some((market) => market.symbol === symbol)
          ) {
            return;
          }

          const quote = Number(message.tick.quote);
          if (!Number.isFinite(quote)) return;

          const pip = pipRef.current[symbol] || 0.01;

          const tick: Tick = {
            quote,
            digit: getDigit(quote, pip),
            time: Number(message.tick.epoch) || Date.now() / 1000,
          };

          const updated = {
            ...historyRef.current,
            [symbol]: [
              ...(historyRef.current[symbol] || []),
              tick,
            ].slice(-MAX_TICKS),
          };

          historyRef.current = updated;
          setHistory(updated);
          setError("");
        }
      };

      ws.onerror = () => {
        if (!stoppedRef.current) {
          setConnection("ERROR");
          setError("Connection error. Check your internet connection.");
        }
      };

      ws.onclose = (event) => {
        if (stoppedRef.current) return;

        setConnection("DISCONNECTED");
        setError(`Connection closed (${event.code}). Reconnecting…`);

        reconnectRef.current = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      };
    }

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
  }, [loaded]);

  const ticks = history[selectedMarket] || [];
  const latest = ticks[ticks.length - 1];

  const prediction = useMemo(
    () => makePrediction(ticks, contract),
    [ticks, contract]
  );

  const testResults = useMemo(
    () => getWalkForwardResults(ticks, contract),
    [ticks, contract]
  );

  const wins = testResults.filter((result) => result.correct).length;
  const losses = testResults.length - wins;
  const accuracy =
    testResults.length > 0
      ? (wins / testResults.length) * 100
      : 0;

  const digitCounts = useMemo(
    () => countDigits(ticks.slice(-500)),
    [ticks]
  );

  const styles = {
    panel: {
      background: "#151d30",
      border: "1px solid #293a58",
      borderRadius: 14,
      padding: 16,
      marginBottom: 14,
    } as React.CSSProperties,
    muted: {
      color: "#a9bad2",
      fontSize: 13,
    } as React.CSSProperties,
    select: {
      width: "100%",
      padding: 12,
      marginTop: 7,
      borderRadius: 8,
      background: "#0c1526",
      color: "white",
      border: "1px solid #405575",
    } as React.CSSProperties,
    button: {
      padding: "12px 15px",
      borderRadius: 9,
      border: "1px solid #496487",
      background: "#263b5d",
      color: "white",
      fontWeight: 700,
      cursor: "pointer",
    } as React.CSSProperties,
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
        <div style={{ color: "#55d6be", fontSize: 12, fontWeight: 800 }}>
          HOPE AI • DERIV ANALYZER PRO V2.42
        </div>
        <h1 style={{ fontSize: 26, margin: "8px 0" }}>
          HOPE AI DERIV ANALYZER PRO
        </h1>
        <p style={styles.muted}>
          Live synthetic market scanner · Automatic digit selection · Historical testing
        </p>
      </header>

      <section style={styles.panel}>
        <h2>CONNECTION</h2>
        <strong style={{
          color: connection === "CONNECTED" ? "#36d399" : "#ffc66d",
        }}>
          ● {connection}
        </strong>
        <p style={styles.muted}>
          Public market feed. This connection does not access your Deriv account.
        </p>
        {error && <p style={{ color: "#ff9292" }}>{error}</p>}
      </section>

      <section style={styles.panel}>
        <h2>MARKET SELECTOR</h2>
        <label style={styles.muted}>Choose your market</label>
        <select
          style={styles.select}
          value={selectedMarket}
          onChange={(event) => setSelectedMarket(event.target.value)}
        >
          {MARKETS.map((market) => (
            <option key={market.symbol} value={market.symbol}>
              {market.name} ({market.symbol})
            </option>
          ))}
        </select>

        <div style={{
          display: "flex",
          gap: 12,
          marginTop: 18,
          flexWrap: "wrap",
        }}>
          <div style={{ flex: 1 }}>
            <div style={styles.muted}>Latest price</div>
            <strong>{latest?.quote ?? "--"}</strong>
          </div>
          <div style={{ flex: 1 }}>
            <div style={styles.muted}>Last digit</div>
            <strong style={{ color: "#55d6be", fontSize: 24 }}>
              {latest?.digit ?? "--"}
            </strong>
          </div>
          <div style={{ flex: 1 }}>
            <div style={styles.muted}>Saved ticks</div>
            <strong>{ticks.length.toLocaleString()}</strong>
          </div>
        </div>
      </section>

      <section style={styles.panel}>
        <h2>CHOOSE CONTRACT TYPE</h2>
        <p style={styles.muted}>
          You choose the contract. Hope AI selects the digit or direction.
        </p>
        <select
          style={styles.select}
          value={contract}
          onChange={(event) =>
            setContract(event.target.value as Contract)
          }
        >
          <option value="MATCHES">Matches</option>
          <option value="DIFFERS">Differs</option>
          <option value="EVEN">Even</option>
          <option value="ODD">Odd</option>
          <option value="RISE">Rise</option>
          <option value="FALL">Fall</option>
        </select>
      </section>

      <section style={styles.panel}>
        <h2>AI ANALYSIS</h2>

        {ticks.length < TRAINING_TICKS ? (
          <>
            <h3 style={{ color: "#ffc66d" }}>COLLECTING DATA</h3>
            <p>
              {ticks.length} / {TRAINING_TICKS} minimum training ticks
            </p>
            <p style={styles.muted}>
              The analyzer needs more market history before selecting a candidate.
            </p>
          </>
        ) : prediction ? (
          <>
            <div style={{ color: "#55d6be", fontWeight: 800 }}>
              HISTORICAL CANDIDATE
            </div>
            <h2 style={{ fontSize: 28, margin: "12px 0" }}>
              {prediction.expected}
            </h2>
            <p style={styles.muted}>{prediction.reason}</p>
            <p style={styles.muted}>
              Contract selected: {contract}
            </p>
            <p style={{ color: "#ffc66d", fontSize: 13 }}>
              This is a historical-statistics candidate, not a guaranteed next-tick prediction.
            </p>
          </>
        ) : null}
      </section>

      <section style={styles.panel}>
        <h2>WALK-FORWARD TEST RESULTS</h2>
        <p style={styles.muted}>
          The analyzer uses earlier ticks to make each historical candidate,
          then checks it against the next observed tick.
        </p>

        <div style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 18,
          marginTop: 14,
        }}>
          <div>
            <div style={styles.muted}>Tested signals</div>
            <strong style={{ fontSize: 23 }}>
              {testResults.length}
            </strong>
          </div>
          <div>
            <div style={styles.muted}>Correct</div>
            <strong style={{ color: "#36d399", fontSize: 23 }}>
              {wins}
            </strong>
          </div>
          <div>
            <div style={styles.muted}>Incorrect</div>
            <strong style={{ color: "#ff9292", fontSize: 23 }}>
              {losses}
            </strong>
          </div>
          <div>
            <div style={styles.muted}>Historical accuracy</div>
            <strong style={{ fontSize: 23 }}>
              {testResults.length ? `${accuracy.toFixed(1)}%` : "--"}
            </strong>
          </div>
        </div>

        <p style={styles.muted}>
          Results are historical only. They do not establish the probability
          of winning the next trade. Testing is based on the current phone's
          saved tick history.
        </p>

        {testResults.length < 100 && (
          <p style={{ color: "#ffc66d", fontSize: 13 }}>
            Collect more data before treating the test results as meaningful.
          </p>
        )}
      </section>

      <section style={styles.panel}>
        <h2>DIGIT DISTRIBUTION</h2>
        {digitCounts.map((count, digit) => {
          const rate =
            ticks.length > 0
              ? (count / Math.min(ticks.length, 500)) * 100
              : 0;

          return (
            <div key={digit} style={{ marginBottom: 11 }}>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 13,
                marginBottom: 4,
              }}>
                <span>Digit {digit}</span>
                <span>{rate.toFixed(1)}% · {count}</span>
              </div>
              <div style={{
                height: 8,
                background: "#293750",
                borderRadius: 20,
                overflow: "hidden",
              }}>
                <div style={{
                  width: `${rate}%`,
                  height: "100%",
                  background: "#55d6be",
                }} />
              </div>
            </div>
          );
        })}
      </section>

      <section style={styles.panel}>
        <h2>ALL MARKET STATUS</h2>
        {MARKETS.map((market) => {
          const count = (history[market.symbol] || []).length;
          const live = market.symbol === selectedMarket && latest;

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
              <span style={{ color: live ? "#36d399" : "#a9bad2" }}>
                {live ? `LIVE · ${count} ticks` : `${count} saved ticks`}
              </span>
            </div>
          );
        })}
      </section>

      <section style={styles.panel}>
        <h2>SCANNER CONTROLS</h2>
        <button
          style={styles.button}
          onClick={() => setScannerOn((value) => !value)}
        >
          {scannerOn ? "PAUSE TICK COLLECTION" : "RESUME TICK COLLECTION"}
        </button>
        <p style={styles.muted}>
          Pausing stops new ticks from being added. Previously saved history remains on this phone.
        </p>
        <p style={styles.muted}>
          History is stored in this browser's local storage. Clearing browser
          data or changing devices can remove it.
        </p>
      </section>

      <section style={styles.panel}>
        <h2>ACCOUNT & TRADE EXECUTION</h2>
        <strong style={{ color: "#ffc66d" }}>
          DERIV ACCOUNT NOT CONNECTED
        </strong>
        <p style={styles.muted}>
          This version analyses public market data only. OAuth login,
          demo trade proposals, and manual trade approval are not yet connected.
        </p>
        <p style={{ color: "#ffc66d", fontSize: 13 }}>
          No trades are placed. Never paste your access token into this page.
        </p>
      </section>

      <footer style={{
        ...styles.muted,
        textAlign: "center",
        paddingBottom: 20,
      }}>
        HOPE AI DERIV ANALYZER PRO V2.42
      </footer>
    </main>
  );
}
