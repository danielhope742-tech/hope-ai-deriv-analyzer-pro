
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const APP_ID = "1089";

const SYNTHETIC_URL =
  `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}&l=EN&brand=deriv`;

const OPTIONS_URL =
  "wss://api.derivws.com/trading/v1/options/ws/public";

const MARKETS = [
  { symbol: "R_10", name: "Volatility 10" },
  { symbol: "R_25", name: "Volatility 25" },
  { symbol: "R_50", name: "Volatility 50" },
  { symbol: "R_75", name: "Volatility 75" },
  { symbol: "R_100", name: "Volatility 100" },
];

type Tick = {
  quote: number;
  digit: number;
  time: number;
};

type MarketData = {
  ticks: Tick[];
  price: number | null;
  status: string;
};

type ConnectionStatus =
  | "CONNECTING"
  | "CONNECTED"
  | "ERROR"
  | "CLOSED";

function emptyMarket(): MarketData {
  return {
    ticks: [],
    price: null,
    status: "WAITING",
  };
}

function getLastDigit(quote: number, pipSize: number): number {
  const decimals = Math.max(0, Math.min(10, pipSize));
  const fixed = quote.toFixed(decimals);
  return Number(fixed.charAt(fixed.length - 1));
}

function percentage(count: number, total: number): string {
  if (!total) return "0.0";
  return ((count / total) * 100).toFixed(1);
}

export default function Home() {
  const [selectedMarket, setSelectedMarket] = useState("R_100");
  const [contract, setContract] = useState("DIFFERS");
  const [targetDigit, setTargetDigit] = useState(5);
  const [barrierDigit, setBarrierDigit] = useState(4);

  const [markets, setMarkets] = useState<Record<string, MarketData>>(() => {
    const initial: Record<string, MarketData> = {};
    MARKETS.forEach((market) => {
      initial[market.symbol] = emptyMarket();
    });
    return initial;
  });

  const [syntheticStatus, setSyntheticStatus] =
    useState<ConnectionStatus>("CONNECTING");
  const [syntheticError, setSyntheticError] = useState("");
  const [syntheticMessages, setSyntheticMessages] = useState(0);
  const [syntheticReconnects, setSyntheticReconnects] = useState(0);

  const [optionsStatus, setOptionsStatus] =
    useState<ConnectionStatus>("CONNECTING");
  const [optionsError, setOptionsError] = useState("");
  const [optionsMessages, setOptionsMessages] = useState(0);
  const [optionsSymbols, setOptionsSymbols] = useState(0);
  const [optionsPrice, setOptionsPrice] = useState<number | null>(null);

  const [scannerActive, setScannerActive] = useState(true);
  const [analysisTime, setAnalysisTime] = useState("");

  const syntheticSocketRef = useRef<WebSocket | null>(null);
  const currentSubscriptionRef = useRef<string | null>(null);

  // --------------------------------------------------
  // SYNTHETIC INDICES CONNECTION
  // One selected market subscription at a time.
  // --------------------------------------------------

  
useEffect(() => {
  let socket: WebSocket | null = null;
  let timeout: ReturnType<typeof setTimeout>;

  setSyntheticStatus("CONNECTING");
  setSyntheticError("");
  setSyntheticMessages(0);

  try {
    socket = new WebSocket(
      "wss://ws.derivws.com/websockets/v3?app_id=1089"
    );

    socket.onopen = () => {
      setSyntheticStatus("CONNECTED");

      socket?.send(JSON.stringify({
        ping: 1,
        req_id: 100
      }));

      timeout = setTimeout(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            active_symbols: "brief",
            product_type: "basic",
            req_id: 101
          }));
        }
      }, 1000);
    };

    socket.onmessage = (event) => {
      setSyntheticMessages((count) => count + 1);

      try {
        const data = JSON.parse(event.data);
        console.log("SYNTHETIC TEST RESPONSE:", data);

        if (data.error) {
          setSyntheticError(data.error.message);
        }
      } catch {
        setSyntheticError("Received an unreadable response");
      }
    };

    socket.onerror = () => {
      setSyntheticStatus("ERROR");
      setSyntheticError("Browser reported a WebSocket error");
    };

    socket.onclose = (event) => {
      setSyntheticStatus("CLOSED");
      setSyntheticError(
        `Close code ${event.code}: ${event.reason || "No close reason"}`
      );
    };
  } catch (error) {
    setSyntheticStatus("ERROR");
    setSyntheticError(
      error instanceof Error ? error.message : "Unknown error"
    );
  }

  return () => {
    clearTimeout(timeout);
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  };
}, []);


  // --------------------------------------------------
  // OPTIONS PUBLIC CONNECTION
  // --------------------------------------------------

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectDelay = 3000;

    const connectOptions = () => {
      if (!active) return;

      setOptionsStatus("CONNECTING");
      setOptionsError("");

      try {
        socket = new WebSocket(OPTIONS_URL);

        socket.onopen = () => {
          if (!active || !socket) return;

          reconnectDelay = 3000;
          setOptionsStatus("CONNECTED");
          setOptionsError("");

          // Ask the public endpoint for its available symbols.
          socket.send(
            JSON.stringify({
              active_symbols: "brief",
              req_id: 1,
            })
          );

          // Test a public tick subscription.
          socket.send(
            JSON.stringify({
              ticks: "1HZ100V",
              subscribe: 1,
              req_id: 2,
            })
          );

          pingTimer = setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ ping: 1 }));
            }
          }, 12000);
        };

        socket.onmessage = (event) => {
          if (!active) return;

          setOptionsMessages((count) => count + 1);

          try {
            const data = JSON.parse(event.data);

            if (data.error) {
              setOptionsError(
                data.error.message || "Options API error"
              );
              return;
            }

            if (data.msg_type === "active_symbols") {
              setOptionsSymbols(
                Array.isArray(data.active_symbols)
                  ? data.active_symbols.length
                  : 0
              );
            }

            if (data.msg_type === "tick" && data.tick) {
              const price = Number(data.tick.quote);

              if (Number.isFinite(price)) {
                setOptionsPrice(price);
              }
            }
          } catch {
            setOptionsError("Could not read Options API response");
          }
        };

        socket.onerror = () => {
          if (!active) return;

          setOptionsStatus("ERROR");
          setOptionsError("Options WebSocket connection error");
        };

        socket.onclose = (event) => {
          if (!active) return;

          setOptionsStatus("CLOSED");
          setOptionsError(
            `Connection closed. Code: ${event.code}. ${
              event.reason || "No close reason supplied."
            }`
          );

          if (pingTimer) clearInterval(pingTimer);

          reconnectTimer = setTimeout(
            connectOptions,
            reconnectDelay
          );

          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        };
      } catch (error) {
        setOptionsStatus("ERROR");
        setOptionsError(
          error instanceof Error ? error.message : "Unknown connection error"
        );

        reconnectTimer = setTimeout(
          connectOptions,
          reconnectDelay
        );
      }
    };

    connectOptions();

    return () => {
      active = false;

      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);

      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, []);

  // --------------------------------------------------
  // SELECTED MARKET DATA
  // --------------------------------------------------

  const selectedData = markets[selectedMarket] || emptyMarket();
  const ticks = selectedData.ticks;

  const digitCounts = useMemo(() => {
    const counts = Array(10).fill(0);

    ticks.forEach((tick) => {
      counts[tick.digit]++;
    });

    return counts;
  }, [ticks]);

  const totalTicks = ticks.length;

  const matchCount = digitCounts[targetDigit];
  const differCount = totalTicks - matchCount;

  const evenCount = digitCounts.reduce(
    (sum, count, digit) =>
      sum + (digit % 2 === 0 ? count : 0),
    0
  );

  const oddCount = totalTicks - evenCount;

  const overCount = digitCounts.reduce(
    (sum, count, digit) =>
      sum + (digit > barrierDigit ? count : 0),
    0
  );

  const underCount = digitCounts.reduce(
    (sum, count, digit) =>
      sum + (digit < barrierDigit ? count : 0),
    0
  );

  const lastDigit = ticks.length
    ? ticks[ticks.length - 1].digit
    : null;

  const previousDigit = ticks.length > 1
    ? ticks[ticks.length - 2].digit
    : null;

  const riseFall =
    ticks.length < 2
      ? "WAITING"
      : ticks[ticks.length - 1].quote >
          ticks[ticks.length - 2].quote
        ? "RISE"
        : ticks[ticks.length - 1].quote <
            ticks[ticks.length - 2].quote
          ? "FALL"
          : "UNCHANGED";

  const selectedPercentage = (() => {
    switch (contract) {
      case "MATCHES":
        return Number(percentage(matchCount, totalTicks));
      case "DIFFERS":
        return Number(percentage(differCount, totalTicks));
      case "EVEN":
        return Number(percentage(evenCount, totalTicks));
      case "ODD":
        return Number(percentage(oddCount, totalTicks));
      case "OVER":
        return Number(percentage(overCount, totalTicks));
      case "UNDER":
        return Number(percentage(underCount, totalTicks));
      case "RISE":
        return riseFall === "RISE" ? 100 : 0;
      case "FALL":
        return riseFall === "FALL" ? 100 : 0;
      default:
        return 0;
    }
  })();

  const analysisSignal = !scannerActive
    ? "SCANNER PAUSED"
    : totalTicks < 50
      ? "COLLECTING TICKS"
      : selectedPercentage >= 60
        ? "HIGH HISTORICAL FREQUENCY"
        : selectedPercentage >= 50
          ? "MODERATE HISTORICAL FREQUENCY"
          : "NO STRONG HISTORICAL FREQUENCY";

  function analyseNow() {
    setAnalysisTime(new Date().toLocaleTimeString());
  }

  // --------------------------------------------------
  // STYLES
  // --------------------------------------------------

  const panelStyle: React.CSSProperties = {
    background: "#151d30",
    border: "1px solid #263653",
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
  };

  const mutedStyle: React.CSSProperties = {
    color: "#9caec9",
    fontSize: 13,
  };

  const buttonStyle: React.CSSProperties = {
    background: "#263b5d",
    color: "#ffffff",
    border: "1px solid #3c557c",
    padding: "11px 14px",
    borderRadius: 9,
    fontWeight: 700,
    cursor: "pointer",
  };

  const selectStyle: React.CSSProperties = {
    width: "100%",
    padding: 12,
    borderRadius: 8,
    background: "#0d1525",
    color: "white",
    border: "1px solid #344867",
    marginTop: 6,
  };

  const statusColor = (status: string) =>
    status === "CONNECTED" ? "#36d399" : "#ff7373";

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#080e1b",
        color: "#f1f5ff",
        padding: "18px 14px 40px",
        fontFamily: "Arial, sans-serif",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      <header style={{ marginBottom: 20 }}>
        <div style={{ color: "#55d6be", fontSize: 12, fontWeight: 800 }}>
          HOPE AI • DERIV ANALYZER
        </div>

        <h1 style={{ fontSize: 27, margin: "8px 0" }}>
          DIGITLAB PRO
        </h1>

        <p style={mutedStyle}>
          Live market monitoring and historical digit analysis
        </p>
      </header>

      {/* SYNTHETIC CONNECTION */}

      <section style={panelStyle}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          SYNTHETIC INDICES CONNECTION
        </h2>

        <div style={{ color: statusColor(syntheticStatus), fontWeight: 800 }}>
          ● {syntheticStatus}
        </div>

        <p style={mutedStyle}>
          API: Deriv WebSocket v3 • App ID: {APP_ID}
        </p>

        <p style={mutedStyle}>
          Incoming messages: {syntheticMessages}
        </p>

        <p style={mutedStyle}>
          Reconnection attempts: {syntheticReconnects}
        </p>

        {syntheticError && (
          <p style={{ color: "#ff8c8c", fontSize: 13 }}>
            {syntheticError}
          </p>
        )}
      </section>

      {/* OPTIONS CONNECTION */}

      <section style={panelStyle}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          DERIV OPTIONS PUBLIC CONNECTION
        </h2>

        <div style={{ color: statusColor(optionsStatus), fontWeight: 800 }}>
          ● {optionsStatus}
        </div>

        <p style={mutedStyle}>
          Messages received: {optionsMessages}
        </p>

        <p style={mutedStyle}>
          Available symbols: {optionsSymbols}
        </p>

        <p style={mutedStyle}>
          1HZ100V latest price:{" "}
          {optionsPrice === null ? "Waiting..." : optionsPrice}
        </p>

        {optionsError && (
          <p style={{ color: "#ff8c8c", fontSize: 13 }}>
            {optionsError}
          </p>
        )}

        <p style={mutedStyle}>
          Public market-data connection only. No account access or trading.
        </p>
      </section>

      {/* MARKET SELECTOR */}

      <section style={panelStyle}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          MARKET SELECTOR
        </h2>

        <label style={mutedStyle}>Choose synthetic market</label>

        <select
          style={selectStyle}
          value={selectedMarket}
          onChange={(event) => setSelectedMarket(event.target.value)}
        >
          {MARKETS.map((market) => (
            <option key={market.symbol} value={market.symbol}>
              {market.name} ({market.symbol})
            </option>
          ))}
        </select>

        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={mutedStyle}>Latest price</div>
            <strong style={{ fontSize: 20 }}>
              {selectedData.price === null
                ? "--"
                : selectedData.price}
            </strong>
          </div>

          <div style={{ flex: 1 }}>
            <div style={mutedStyle}>Latest digit</div>
            <strong style={{ fontSize: 25, color: "#55d6be" }}>
              {lastDigit === null ? "--" : lastDigit}
            </strong>
          </div>

          <div style={{ flex: 1 }}>
            <div style={mutedStyle}>Ticks collected</div>
            <strong style={{ fontSize: 20 }}>
              {totalTicks}
            </strong>
          </div>
        </div>
      </section>

      {/* CONTRACT SELECTOR */}

      <section style={panelStyle}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          CONTRACT ANALYSIS
        </h2>

        <label style={mutedStyle}>Choose contract type</label>

        <select
          style={selectStyle}
          value={contract}
          onChange={(event) => setContract(event.target.value)}
        >
          <option value="MATCHES">Matches</option>
          <option value="DIFFERS">Differs</option>
          <option value="EVEN">Even</option>
          <option value="ODD">Odd</option>
          <option value="OVER">Over</option>
          <option value="UNDER">Under</option>
          <option value="RISE">Rise</option>
          <option value="FALL">Fall</option>
        </select>

        {(contract === "MATCHES" || contract === "DIFFERS") && (
          <>
            <label style={mutedStyle}>Target digit</label>
            <select
              style={selectStyle}
              value={targetDigit}
              onChange={(event) => setTargetDigit(Number(event.target.value))}
            >
              {Array.from({ length: 10 }, (_, digit) => (
                <option key={digit} value={digit}>
                  Digit {digit}
                </option>
              ))}
            </select>
          </>
        )}

        {(contract === "OVER" || contract === "UNDER") && (
          <>
            <label style={mutedStyle}>Barrier digit</label>
            <select
              style={selectStyle}
              value={barrierDigit}
              onChange={(event) => setBarrierDigit(Number(event.target.value))}
            >
              {Array.from({ length: 10 }, (_, digit) => (
                <option key={digit} value={digit}>
                  {digit}
                </option>
              ))}
            </select>
          </>
        )}

        <div style={{ marginTop: 18 }}>
          <div style={mutedStyle}>
            Historical frequency in collected ticks
          </div>

          <strong style={{ fontSize: 30, color: "#55d6be" }}>
            {selectedPercentage.toFixed(1)}%
          </strong>
        </div>

        <p style={mutedStyle}>
          This describes the historical sample, not the probability of the
          next result.
        </p>
      </section>

      {/* DIGIT DISTRIBUTION */}

      <section style={panelStyle}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          DIGIT DISTRIBUTION
        </h2>

        {digitCounts.map((count, digit) => {
          const pct = Number(percentage(count, totalTicks));

          return (
            <div key={digit} style={{ marginBottom: 12 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 13,
                  marginBottom: 5,
                }}
              >
                <span>Digit {digit}</span>
                <span>
                  {pct.toFixed(1)}% ({count})
                </span>
              </div>

              <div
                style={{
                  background: "#26344d",
                  height: 9,
                  borderRadius: 20,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: "#55d6be",
                    borderRadius: 20,
                  }}
                />
              </div>
            </div>
          );
        })}
      </section>

      {/* ANALYSIS ENGINE */}

      <section style={panelStyle}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          ANALYSIS ENGINE
        </h2>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            style={buttonStyle}
            onClick={analyseNow}
          >
            ANALYSE NOW
          </button>

          <button
            style={buttonStyle}
            onClick={() => setScannerActive((value) => !value)}
          >
            {scannerActive ? "PAUSE SCANNER" : "RESUME SCANNER"}
          </button>
        </div>

        <div style={{ marginTop: 18 }}>
          <div style={mutedStyle}>Analysis status</div>

          <strong style={{ fontSize: 19, color: "#55d6be" }}>
            {analysisSignal}
          </strong>
        </div>

        <p style={mutedStyle}>Contract: {contract}</p>

        <p style={mutedStyle}>
          Historical frequency: {selectedPercentage.toFixed(1)}%
        </p>

        <p style={mutedStyle}>
          Latest digit: {lastDigit === null ? "--" : lastDigit}
        </p>

        <p style={mutedStyle}>
          Previous digit: {previousDigit === null ? "--" : previousDigit}
        </p>

        <p style={mutedStyle}>
          Latest price direction: {riseFall}
        </p>

        <p style={mutedStyle}>
          Last analysis: {analysisTime || "Not analysed yet"}
        </p>

        <p style={{ color: "#ffc66d", fontSize: 13 }}>
          A small sample is not enough to establish an advantage. This tool
          does not predict or guarantee the next tick.
        </p>
      </section>

      {/* ALL MARKETS STATUS */}

      <section style={panelStyle}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          ALL MARKETS STATUS
        </h2>

        {MARKETS.map((market) => {
          const data = markets[market.symbol];

          return (
            <div
              key={market.symbol}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "10px 0",
                borderBottom: "1px solid #293650",
              }}
            >
              <span>{market.name}</span>

              <span
                style={{
                  color:
                    data?.status === "LIVE"
                      ? "#36d399"
                      : "#ff8c8c",
                }}
              >
                {data?.price === null || data?.price === undefined
                  ? "WAITING"
                  : data.price}
              </span>
            </div>
          );
        })}
      </section>

      {/* TRADE EXECUTION */}

      <section style={panelStyle}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          TRADE EXECUTION
        </h2>

        <div style={{ color: "#ffc66d", fontWeight: 800 }}>
          DEMO EXECUTION NOT CONNECTED
        </div>

        <p style={mutedStyle}>
          This version analyses market data only. It does not place demo or
          real-money trades.
        </p>

        <button
          style={{
            ...buttonStyle,
            width: "100%",
            opacity: 0.5,
            cursor: "not-allowed",
          }}
          disabled
        >
          TRADE EXECUTION — NOT ENABLED
        </button>

        <p style={{ color: "#ffc66d", fontSize: 13 }}>
          Account authorization and secure demo trading must be added
          separately. Never put your Deriv access token in this page.
        </p>
      </section>

      <footer style={{ textAlign: "center", ...mutedStyle }}>
        HOPE AI DERIV ANALYZER • LIVE DATA BUILD
      </footer>
    </main>
  );
}
