
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

const PUBLIC_WS =
  "wss://api.derivws.com/trading/v1/options/ws/public";

const WINDOW_SIZES = [100, 500, 1000] as const;

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

type MarketData = {
  ticks: Tick[];
  price: number | null;
  status: string;
  pipSize: number;
};

type ConnectionStatus =
  | "CONNECTING"
  | "CONNECTED"
  | "ERROR"
  | "CLOSED";

type ApiMessage = {
  msg_type?: string;
  error?: {
    message?: string;
    code?: string;
  };
  active_symbols?: Array<{
    symbol?: string;
    display_name?: string;
    pip?: number;
  }>;
  tick?: {
    symbol?: string;
    quote?: number | string;
    epoch?: number;
    pip_size?: number;
  };
};

function emptyMarket(): MarketData {
  return {
    ticks: [],
    price: null,
    status: "WAITING",
    pipSize: 2,
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

function makeInitialMarkets(): Record<string, MarketData> {
  const initial: Record<string, MarketData> = {};

  MARKETS.forEach((market) => {
    initial[market.symbol] = emptyMarket();
  });

  return initial;
}

export default function Home() {
  const [selectedMarket, setSelectedMarket] = useState("R_100");
  const [contract, setContract] = useState("DIFFERS");
  const [targetDigit, setTargetDigit] = useState(5);
  const [barrierDigit, setBarrierDigit] = useState(4);
  const [windowSize, setWindowSize] =
    useState<number>(500);

  const [markets, setMarkets] =
    useState<Record<string, MarketData>>(makeInitialMarkets);

  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("CONNECTING");

  const [connectionError, setConnectionError] = useState("");
  const [messagesReceived, setMessagesReceived] = useState(0);
  const [availableSymbols, setAvailableSymbols] = useState<string[]>([]);
  const [scannerActive, setScannerActive] = useState(true);
  const [analysisTime, setAnalysisTime] = useState("");

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const reconnectDelayRef = useRef(3000);
  const activeRef = useRef(true);
  const scannerActiveRef = useRef(true);
  const subscribedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    scannerActiveRef.current = scannerActive;
  }, [scannerActive]);

  // --------------------------------------------------
  // PUBLIC DERIV MARKET DATA CONNECTION
  // No App ID 1089 is used here.
  // --------------------------------------------------

  useEffect(() => {
    activeRef.current = true;

    const connect = () => {
      if (!activeRef.current) return;

      setConnectionStatus("CONNECTING");
      setConnectionError("");
      subscribedRef.current.clear();

      let socket: WebSocket;

      try {
        socket = new WebSocket(PUBLIC_WS);
        socketRef.current = socket;
      } catch (error) {
        setConnectionStatus("ERROR");
        setConnectionError(
          error instanceof Error ? error.message : "Could not create WebSocket"
        );

        reconnectTimerRef.current = setTimeout(
          connect,
          reconnectDelayRef.current
        );

        return;
      }

      socket.onopen = () => {
        if (!activeRef.current) return;

        reconnectDelayRef.current = 3000;
        setConnectionStatus("CONNECTED");
        setConnectionError("");

        // Request the available market symbols.
        socket.send(
          JSON.stringify({
            active_symbols: "brief",
            req_id: 1,
          })
        );

        socket.send(
          JSON.stringify({
            ping: 1,
            req_id: 2,
          })
        );
      };

      socket.onmessage = (event) => {
        if (!activeRef.current) return;

        setMessagesReceived((count) => count + 1);

        let data: ApiMessage;

        try {
          data = JSON.parse(event.data);
        } console.log("DERIV RAW RESPONSE:", data);
        catch {
          setConnectionError("Could not read the market-data response.");
          return;
        }

        if (data.error) {
          const message =
            data.error.message || data.error.code || "Deriv API error";

          setConnectionError(message);
          return;
        }

        // Subscribe only to symbols actually returned by Deriv.
        if (
          data.msg_type === "active_symbols" &&
          Array.isArray(data.active_symbols)
        ) {
          const returnedSymbols = data.active_symbols
            .map((item) => item.symbol)
            .filter((symbol): symbol is string => Boolean(symbol));

          const wantedSymbols = MARKETS
            .map((market) => market.symbol)
            .filter((symbol) => returnedSymbols.includes(symbol));

          setAvailableSymbols(wantedSymbols);

          if (wantedSymbols.length === 0) {
            setConnectionError(
              "No requested markets were returned by this endpoint. Check the API response and supported symbols."
            );
            return;
          }

          wantedSymbols.forEach((symbol, index) => {
            if (
              socket.readyState !== WebSocket.OPEN ||
              subscribedRef.current.has(symbol)
            ) {
              return;
            }

            subscribedRef.current.add(symbol);

            socket.send(
              JSON.stringify({
                ticks: symbol,
                subscribe: 1,
                req_id: 100 + index,
              })
            );

            setMarkets((previous) => ({
              ...previous,
              [symbol]: {
                ...previous[symbol],
                status: "SUBSCRIBING",
              },
            }));
          });

          return;
        }

        // Receive and store live tick data.
        if (data.msg_type === "tick" && data.tick) {
          const symbol = data.tick.symbol;
          const quote = Number(data.tick.quote);
          const epoch = Number(data.tick.epoch);
          const pipSize = Number(data.tick.pip_size ?? 2);

          if (
            !symbol ||
            !MARKETS.some((market) => market.symbol === symbol) ||
            !Number.isFinite(quote)
          ) {
            return;
          }

          if (!scannerActiveRef.current) return;

          const digit = getLastDigit(
            quote,
            Number.isFinite(pipSize) ? pipSize : 2
          );

          const tick: Tick = {
            quote,
            digit,
            time: Number.isFinite(epoch) ? epoch : Date.now() / 1000,
          };

          setMarkets((previous) => {
            const oldMarket = previous[symbol] || emptyMarket();

            const updatedTicks = [
              ...oldMarket.ticks,
              tick,
            ].slice(-1000);

            return {
              ...previous,
              [symbol]: {
                ticks: updatedTicks,
                price: quote,
                status: "LIVE",
                pipSize: Number.isFinite(pipSize)
                  ? pipSize
                  : oldMarket.pipSize,
              },
            };
          });
        }
      };

      socket.onerror = () => {
        if (!activeRef.current) return;

        setConnectionStatus("ERROR");
        setConnectionError(
          "WebSocket error. Check your internet connection and endpoint response."
        );
      };

      socket.onclose = (event) => {
        if (!activeRef.current) return;

        setConnectionStatus("CLOSED");
        setConnectionError(
          `Connection closed. Code: ${event.code}. ${
            event.reason || "No close reason supplied."
          }`
        );

        setMarkets((previous) => {
          const updated = { ...previous };

          Object.keys(updated).forEach((symbol) => {
            updated[symbol] = {
              ...updated[symbol],
              status: "DISCONNECTED",
            };
          });

          return updated;
        });

        reconnectTimerRef.current = setTimeout(
          connect,
          reconnectDelayRef.current
        );

        reconnectDelayRef.current = Math.min(
          reconnectDelayRef.current * 2,
          30000
        );
      };
    };

    connect();

    return () => {
      activeRef.current = false;

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }

      const socket = socketRef.current;

      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }

      socketRef.current = null;
    };
  }, []);

  // --------------------------------------------------
  // SELECTED MARKET ANALYSIS
  // --------------------------------------------------

  const selectedData =
    markets[selectedMarket] || emptyMarket();

  const allTicks = selectedData.ticks;

  const ticks = useMemo(
    () => allTicks.slice(-windowSize),
    [allTicks, windowSize]
  );

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

  const lastTick = ticks[ticks.length - 1];
  const previousTick = ticks[ticks.length - 2];

  const lastDigit = lastTick ? lastTick.digit : null;
  const previousDigit = previousTick ? previousTick.digit : null;

  let riseCount = 0;
  let fallCount = 0;
  let unchangedCount = 0;

  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i].quote > ticks[i - 1].quote) {
      riseCount++;
    } else if (ticks[i].quote < ticks[i - 1].quote) {
      fallCount++;
    } else {
      unchangedCount++;
    }
  }

  const directionTotal = riseCount + fallCount + unchangedCount;

  const riseFall =
    !lastTick || !previousTick
      ? "WAITING"
      : lastTick.quote > previousTick.quote
        ? "RISE"
        : lastTick.quote < previousTick.quote
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
        return Number(percentage(riseCount, directionTotal));
      case "FALL":
        return Number(percentage(fallCount, directionTotal));
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

  const panelStyle: CSSProperties = {
    background: "#151d30",
    border: "1px solid #263653",
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
  };

  const mutedStyle: CSSProperties = {
    color: "#9caec9",
    fontSize: 13,
  };

  const buttonStyle: CSSProperties = {
    background: "#263b5d",
    color: "#ffffff",
    border: "1px solid #3c557c",
    padding: "11px 14px",
    borderRadius: 9,
    fontWeight: 700,
    cursor: "pointer",
  };

  const selectStyle: CSSProperties = {
    width: "100%",
    padding: 12,
    borderRadius: 8,
    background: "#0d1525",
    color: "white",
    border: "1px solid #344867",
    marginTop: 6,
  };

  const statusColor = (status: string) => {
    if (status === "CONNECTED" || status === "LIVE") {
      return "#36d399";
    }

    if (status === "CONNECTING" || status === "SUBSCRIBING") {
      return "#ffc66d";
    }

    return "#ff7373";
  };

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
          HOPE AI • DERIV ANALYZER PRO
        </div>

        <h1 style={{ fontSize: 27, margin: "8px 0" }}>
          HOPE AI DERIV ANALYZER PRO
        </h1>

        <p style={mutedStyle}>
          Live synthetic-market monitoring and historical digit analysis
        </p>
      </header>

      {/* CONNECTION */}

      <section style={panelStyle}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          DERIV PUBLIC MARKET CONNECTION
        </h2>

        <div
          style={{
            color: statusColor(connectionStatus),
            fontWeight: 800,
          }}
        >
          ● {connectionStatus}
        </div>

        <p style={mutedStyle}>
          Public market-data endpoint. No legacy App ID 1089.
        </p>

        <p style={mutedStyle}>
          Messages received: {messagesReceived}
        </p>

        <p style={mutedStyle}>
          Requested markets available: {availableSymbols.length} / {MARKETS.length}
        </p>

        {connectionError && (
          <p style={{ color: "#ff8c8c", fontSize: 13 }}>
            {connectionError}
          </p>
        )}

        <p style={mutedStyle}>
          This connection reads public prices only. It does not access your
          Deriv account or place trades.
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
              {availableSymbols.includes(market.symbol) ? "" : " — checking"}
            </option>
          ))}
        </select>

        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={mutedStyle}>Latest price</div>
            <strong style={{ fontSize: 20 }}>
              {selectedData.price === null ? "--" : selectedData.price}
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
            <strong style={{ fontSize: 20 }}>{totalTicks}</strong>
          </div>
        </div>

        <p style={mutedStyle}>
          Market status:{" "}
          <span style={{ color: statusColor(selectedData.status) }}>
            {selectedData.status}
          </span>
        </p>
      </section>

      {/* ANALYSIS WINDOW */}

      <section style={panelStyle}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          ANALYSIS WINDOW
        </h2>

        <label style={mutedStyle}>Number of recent ticks</label>

        <select
          style={selectStyle}
          value={windowSize}
          onChange={(event) => setWindowSize(Number(event.target.value))}
        >
          {WINDOW_SIZES.map((size) => (
            <option key={size} value={size}>
              Last {size} ticks
            </option>
          ))}
        </select>

        <p style={mutedStyle}>
          The scanner stores up to 1,000 ticks per market.
        </p>
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
            Historical frequency in selected window
          </div>

          <strong style={{ fontSize: 30, color: "#55d6be" }}>
            {selectedPercentage.toFixed(1)}%
          </strong>
        </div>

        <p style={mutedStyle}>
          This is a historical sample frequency, not the probability of the
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
          <button style={buttonStyle} onClick={analyseNow}>
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
        <p style={mutedStyle}>Latest price direction: {riseFall}</p>
        <p style={mutedStyle}>
          Last analysis: {analysisTime || "Not analysed yet"}
        </p>

        <p style={{ color: "#ffc66d", fontSize: 13 }}>
          Historical frequency does not guarantee the next tick. Use this
          information for analysis, not as a guaranteed trading signal.
        </p>
      </section>

      {/* ALL MARKETS */}

      <section style={panelStyle}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          ALL MARKETS STATUS
        </h2>

        {MARKETS.map((market) => {
          const data = markets[market.symbol] || emptyMarket();

          return (
            <div
              key={market.symbol}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                padding: "10px 0",
                borderBottom: "1px solid #293650",
              }}
            >
              <span style={{ fontSize: 13 }}>
                {market.name}
              </span>

              <span
                style={{
                  color: statusColor(data.status),
                  fontSize: 13,
                  textAlign: "right",
                }}
              >
                {data.status === "LIVE"
                  ? data.price
                  : data.status}
              </span>
            </div>
          );
        })}
      </section>

      {/* TRADE EXECUTION */}

      <section style={panelStyle}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>
          DERIV ACCOUNT & TRADE EXECUTION
        </h2>

        <div style={{ color: "#ffc66d", fontWeight: 800 }}>
          ACCOUNT NOT CONNECTED
        </div>

        <p style={mutedStyle}>
          Your public market scanner is separate from your private Deriv
          account. OAuth account connection and demo trade execution must be
          configured through secure server routes.
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
          DEMO TRADING — NOT CONNECTED
        </button>

        <p style={{ color: "#ffc66d", fontSize: 13 }}>
          No real-money trades can be placed by this version. Never put your
          Deriv access token in this page.
        </p>
      </section>

      <footer style={{ textAlign: "center", ...mutedStyle }}>
        HOPE AI DERIV ANALYZER PRO • PUBLIC MARKET DATA BUILD
      </footer>
    </main>
  );
}
