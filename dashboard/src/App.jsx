import { useEffect, useState } from "react";
import { useRoomMqtt } from "./useRoomMqtt.js";
import { config, missingConfig } from "./config.js";
import TempChart from "./TempChart.jsx";

// ---------- small inline icons (stroke, inherit text colour) ----------
const Icon = ({ d, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.map((p, i) => <path key={i} d={p} />)}
  </svg>
);
const icons = {
  people: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  temp: ["M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"],
  power: ["M18.36 6.64a9 9 0 1 1-12.73 0", "M12 2v10"],
  enter: ["M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4", "M10 17l5-5-5-5", "M15 12H3"],
  exit: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  alert: ["M12 9v4", "M12 17h.01", "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"],
  send: ["M22 2L11 13", "M22 2l-7 20-4-9-9-4 20-7z"],
  motion: ["M13 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2", "M7 21l3-6 3 2v4", "M10 15l1-5 4 3h4", "M8 9l3-1"],
};

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function timeAgo(ms, now) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return new Date(ms).toLocaleString();
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatUptime(sec) {
  if (typeof sec !== "number") return "–";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min ${sec % 60} s`;
}

function signal(rssi) {
  if (typeof rssi !== "number") return "–";
  const q = rssi >= -60 ? "strong" : rssi >= -72 ? "good" : rssi >= -82 ? "weak" : "very weak";
  return `${q} (${rssi} dBm)`;
}

// ---------- pieces ----------
function Pill({ tone, children }) {
  return <span className={`pill pill-${tone}`}><span className="pill-dot" />{children}</span>;
}

function BrokerPill({ broker }) {
  const map = {
    connected: ["good", "Broker connected"],
    connecting: ["neutral", "Connecting to broker…"],
    reconnecting: ["warn", "Reconnecting…"],
    offline: ["bad", "Broker offline"],
    error: ["bad", "Broker error"],
  };
  const [tone, label] = map[broker] || map.connecting;
  return <Pill tone={tone}>{label}</Pill>;
}

function RoomPill({ deviceOnline, stale }) {
  if (deviceOnline === false) return <Pill tone="bad">Room offline</Pill>;
  if (deviceOnline === null) return <Pill tone="neutral">Waiting for room…</Pill>;
  if (stale) return <Pill tone="warn">No recent data</Pill>;
  return <Pill tone="good">Room online</Pill>;
}

function currentChoice(status) {
  if (!status) return null;
  if (status.mode === "auto") return "auto";
  return status.power === "on" ? "on" : "off";
}

function PowerControl({ status, pending, lastReply, onSend, disabled, now }) {
  const choice = currentChoice(status);
  const options = [
    { value: "on", label: "Force on", hint: "Stays on until you switch back to Auto" },
    { value: "auto", label: "Auto", hint: "Sensors decide: off when the room is empty" },
    { value: "off", label: "Force off", hint: "Cuts power even if someone is inside" },
  ];
  const busy = Boolean(pending);
  const showReply = lastReply && now - lastReply.at < 15000;

  return (
    <section className="card control">
      <div className="card-head">
        <h2>Power control</h2>
        {busy && <span className="muted small">Sending…</span>}
      </div>
      <div className="segmented" role="radiogroup" aria-label="Room power mode">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={choice === o.value}
            className={`seg seg-${o.value} ${choice === o.value ? "is-active" : ""}`}
            disabled={disabled || busy}
            onClick={() => onSend("power", o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="muted small hint">
        {options.find((o) => o.value === (pending?.value || choice))?.hint || "Choose how the room's power is controlled."}
      </p>
      <div className="control-foot">
        <button type="button" className="ghost-btn" disabled={disabled || busy} onClick={() => onSend("reset_count")}>
          Reset people count
        </button>
        {showReply && (
          <span className={`reply ${lastReply.ok ? "ok" : "fail"}`} role="status">
            {!lastReply.ok && <Icon d={icons.alert} size={16} />} {lastReply.message}
          </span>
        )}
      </div>
    </section>
  );
}

const EVENT_STYLE = {
  entry: { icon: icons.enter, cls: "ev-entry" },
  exit: { icon: icons.exit, cls: "ev-exit" },
  "power-on": { icon: icons.power, cls: "ev-on" },
  "power-off": { icon: icons.power, cls: "ev-off" },
  offline: { icon: icons.alert, cls: "ev-alert" },
  command: { icon: icons.send, cls: "ev-cmd" },
};

function EventLog({ events }) {
  return (
    <section className="card log">
      <div className="card-head">
        <h2>Activity</h2>
        <span className="muted small">{events.length ? `${events.length} events` : ""}</span>
      </div>
      {events.length === 0 ? (
        <div className="empty">Entries, exits and power changes will appear here as they happen.</div>
      ) : (
        <ol className="events">
          {events.map((e, i) => {
            const st = EVENT_STYLE[e.kind] || EVENT_STYLE.command;
            return (
              <li key={`${e.at}-${i}`} className={st.cls}>
                <span className="ev-icon"><Icon d={st.icon} size={16} /></span>
                <span className="ev-text">
                  {e.text}
                  {typeof e.occupancy === "number" && <span className="muted"> · {e.occupancy} inside</span>}
                </span>
                <time className="ev-time">{clock(e.at)}</time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// ---------- page ----------
export default function App() {
  const { broker, brokerError, status, deviceOnline, lastSeen, events, history, pending, lastReply, sendCommand } = useRoomMqtt();
  const now = useNow(1000);
  const stale = lastSeen ? now - lastSeen > config.statusIntervalMs * 3 : false;
  const live = deviceOnline && !stale;

  // Countdown to auto-off, counted down locally between status messages.
  let offIn = null;
  if (live && typeof status?.off_in === "number") {
    offIn = Math.max(0, Math.round(status.off_in - (now - lastSeen) / 1000));
  }

  const powerOn = status?.power === "on";
  const controlsDisabled = broker !== "connected" || deviceOnline === false;

  if (missingConfig) {
    return (
      <main className="page">
        <section className="card setup">
          <h1>Smart Room Admin</h1>
          <p>No broker is configured yet. Copy <code>.env.example</code> to <code>.env</code>, fill in your MQTT WebSocket URL and dashboard login, then restart <code>npm run dev</code>.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="top">
        <div>
          <div className="eyebrow">Smart energy-saving room</div>
          <h1>Admin dashboard <span className="room-id">{config.roomId}</span></h1>
        </div>
        <div className="pills">
          <BrokerPill broker={broker} />
          <RoomPill deviceOnline={deviceOnline} stale={stale} />
        </div>
      </header>

      {broker === "error" && brokerError && (
        <div className="banner" role="alert"><Icon d={icons.alert} size={16} /> {brokerError}</div>
      )}

      <section className={`stats ${live ? "" : "is-dim"}`}>
        <div className="card stat">
          <div className="stat-label"><Icon d={icons.people} /> People inside</div>
          <div className="stat-value">{status ? status.occupancy : "–"}</div>
          <div className="stat-sub">
            {status?.motion ? <span className="motion"><Icon d={icons.motion} size={14} /> Motion detected</span> : <span className="muted">No motion right now</span>}
          </div>
        </div>

        <div className="card stat">
          <div className="stat-label"><Icon d={icons.temp} /> Temperature</div>
          <div className="stat-value">
            {typeof status?.temperature === "number" ? status.temperature.toFixed(1) : "–"}<span className="unit">°C</span>
          </div>
          <div className="stat-sub muted">
            Humidity {typeof status?.humidity === "number" ? `${status.humidity}%` : "–"}
          </div>
        </div>

        <div className={`card stat power ${status ? (powerOn ? "is-on" : "is-off") : ""}`}>
          <div className="stat-label"><Icon d={icons.power} /> Room power</div>
          <div className="stat-value">{status ? (powerOn ? "ON" : "OFF") : "–"}</div>
          <div className="stat-sub">
            {status && (
              <span className={`mode-tag ${status.mode === "auto" ? "" : "is-admin"}`}>
                {status.mode === "auto" ? "Automatic" : "Admin override"}
              </span>
            )}
            {offIn !== null && <span className="countdown">Turning off in {offIn} s</span>}
          </div>
        </div>
      </section>

      <div className="grid">
        <div className="col">
          <PowerControl status={status} pending={pending} lastReply={lastReply} onSend={sendCommand}
                        disabled={controlsDisabled} now={now} />
          <section className="card"><TempChart points={history} /></section>
        </div>
        <EventLog events={events} />
      </div>

      <footer className="foot muted small">
        <span>Last update: {timeAgo(lastSeen, now)}</span>
        <span>Wi-Fi signal: {signal(status?.rssi)}</span>
        <span>Controller uptime: {formatUptime(status?.uptime)}</span>
        <span>Topic: <code>{config.topic}</code></span>
      </footer>
    </main>
  );
}
