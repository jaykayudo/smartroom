import { useCallback, useEffect, useRef, useState } from "react";
import mqtt from "mqtt";
import { config } from "./config.js";

const MAX_EVENTS = 100;
const MAX_HISTORY = 240;            // temperature points kept for the chart
const COMMAND_TIMEOUT_MS = 8000;

function makeId() {
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// Device timestamps are epoch seconds (or null before NTP sync).
function messageTime(msg) {
  return typeof msg.ts === "number" && msg.ts > 0 ? msg.ts * 1000 : Date.now();
}

/**
 * Connects to the broker, subscribes to the room topic and turns the JSON
 * messages (told apart by "type") into React state.
 */
export function useRoomMqtt() {
  const clientRef = useRef(null);
  const pendingRef = useRef(new Map());

  const [broker, setBroker] = useState("connecting");   // connecting | connected | reconnecting | offline | error
  const [brokerError, setBrokerError] = useState("");
  const [status, setStatus] = useState(null);           // last status from the room
  const [deviceOnline, setDeviceOnline] = useState(null); // true | false | null (unknown)
  const [lastSeen, setLastSeen] = useState(null);
  const [events, setEvents] = useState([]);
  const [history, setHistory] = useState([]);
  const [pending, setPending] = useState(null);         // { id, action, value }
  const [lastReply, setLastReply] = useState(null);     // { ok, message, at }

  const addEvent = useCallback((e) => {
    setEvents((list) => [e, ...list].slice(0, MAX_EVENTS));
  }, []);

  useEffect(() => {
    if (!config.url) return undefined;

    const client = mqtt.connect(config.url, {
      username: config.username,
      password: config.password,
      clientId: `dashboard-${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      reconnectPeriod: 3000,
      connectTimeout: 10000,
      keepalive: 30,
    });
    clientRef.current = client;

    client.on("connect", () => {
      setBroker("connected");
      setBrokerError("");
      client.subscribe(config.topic, { qos: 1 });
    });
    client.on("reconnect", () => setBroker("reconnecting"));
    client.on("offline", () => setBroker("offline"));
    client.on("close", () => setBroker((b) => (b === "connected" ? "reconnecting" : b)));
    client.on("error", (err) => {
      setBroker("error");
      setBrokerError(err?.message || String(err));
    });

    client.on("message", (topic, payload, packet) => {
      let msg;
      try {
        msg = JSON.parse(payload.toString());
      } catch {
        return;                                          // ignore anything that isn't JSON
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.room && msg.room !== config.roomId) return;

      switch (msg.type) {
        case "status": {
          if (msg.online === false) {
            setDeviceOnline(false);
            if (!packet.retain) {
              addEvent({ kind: "offline", at: Date.now(), text: "Room controller went offline" });
            }
            return;
          }
          const at = messageTime(msg);
          setDeviceOnline(true);
          setStatus(msg);
          setLastSeen(at);
          if (typeof msg.temperature === "number") {
            setHistory((h) => {
              const next = [...h, { t: at, v: msg.temperature, occ: msg.occupancy }];
              return next.slice(-MAX_HISTORY);
            });
          }
          return;
        }

        case "event": {
          const at = messageTime(msg);
          if (msg.event === "entry" || msg.event === "exit") {
            addEvent({
              kind: msg.event,
              at,
              occupancy: msg.occupancy,
              text: msg.event === "entry" ? "Someone entered" : "Someone left",
            });
          } else if (msg.event === "power") {
            const who = msg.reason === "admin" ? "by admin" : "automatically";
            addEvent({ kind: msg.power === "on" ? "power-on" : "power-off", at, text: `Power turned ${msg.power} ${who}` });
          }
          return;
        }

        case "ack": {
          const entry = msg.id ? pendingRef.current.get(msg.id) : null;
          if (entry) {
            clearTimeout(entry.timer);
            pendingRef.current.delete(msg.id);
            setPending(null);
            setLastReply({ ok: msg.ok !== false, message: msg.message || "Done", at: Date.now() });
          }
          return;
        }

        case "command": {
          // Commands we (or another admin) sent. Our own are already tracked as pending.
          if (msg.id && pendingRef.current.has(msg.id)) return;
          if (msg.source === "dashboard") {
            addEvent({ kind: "command", at: Date.now(), text: `Another admin sent: ${msg.action}${msg.value ? ` ${msg.value}` : ""}` });
          }
          return;
        }

        default:
          return;
      }
    });

    return () => {
      pendingRef.current.forEach((p) => clearTimeout(p.timer));
      pendingRef.current.clear();
      client.end(true);
    };
  }, [addEvent]);

  const sendCommand = useCallback((action, value) => {
    const client = clientRef.current;
    if (!client || !client.connected) {
      setLastReply({ ok: false, message: "Not connected to the broker", at: Date.now() });
      return;
    }
    const id = makeId();
    const message = {
      type: "command",
      source: "dashboard",
      room: config.roomId,
      action,
      ...(value !== undefined ? { value } : {}),
      id,
      ts: Math.floor(Date.now() / 1000),
    };
    const timer = setTimeout(() => {
      pendingRef.current.delete(id);
      setPending((p) => (p && p.id === id ? null : p));
      setLastReply({ ok: false, message: "No reply from the room. Is it online?", at: Date.now() });
    }, COMMAND_TIMEOUT_MS);
    pendingRef.current.set(id, { timer });
    setPending({ id, action, value });
    // Commands are never retained, so the ESP32 won't replay an old one when it reconnects.
    client.publish(config.topic, JSON.stringify(message), { qos: 1, retain: false });
  }, []);

  return { broker, brokerError, status, deviceOnline, lastSeen, events, history, pending, lastReply, sendCommand };
}
