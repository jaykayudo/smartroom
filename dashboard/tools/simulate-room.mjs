// A fake room that speaks exactly the same MQTT protocol as the ESP32 sketch.
// Use it to build and demo the dashboard before the hardware is ready:
//   npm run simulate
// It reads SIM_MQTT_URL / SIM_MQTT_USERNAME / SIM_MQTT_PASSWORD, VITE_MQTT_TOPIC and VITE_ROOM_ID from .env
import "dotenv/config";
import mqtt from "mqtt";

const url = process.env.SIM_MQTT_URL;
const topic = process.env.VITE_MQTT_TOPIC || "smartroom/room-1";
const room = process.env.VITE_ROOM_ID || "room-1";
const STATUS_MS = Number(process.env.VITE_STATUS_INTERVAL_MS || 5000);
const VACANCY_MS = 20000;

if (!url) {
  console.error("Set SIM_MQTT_URL in .env (e.g. mqtts://your-cluster.s1.eu.hivemq.cloud:8883)");
  process.exit(1);
}

const state = { occupancy: 0, power: false, mode: "auto", motion: false, temperature: 26.5, humidity: 58, lastActivity: Date.now() };
const started = Date.now();
const ts = () => Math.floor(Date.now() / 1000);
const base = (type) => ({ type, source: "device", room, ts: ts() });

const client = mqtt.connect(url, {
  username: process.env.SIM_MQTT_USERNAME,
  password: process.env.SIM_MQTT_PASSWORD,
  clientId: `smartroom-sim-${Math.random().toString(16).slice(2, 8)}`,
  will: { topic, payload: JSON.stringify({ type: "status", source: "device", room, online: false }), qos: 1, retain: true },
});

const send = (msg, retain = false) => client.publish(topic, JSON.stringify(msg), { qos: 1, retain });

function offIn() {
  if (state.mode !== "auto" || !state.power || state.occupancy > 0 || state.motion) return null;
  return Math.max(0, Math.ceil((VACANCY_MS - (Date.now() - state.lastActivity)) / 1000));
}

function status() {
  send({
    ...base("status"), online: true, occupancy: state.occupancy, power: state.power ? "on" : "off", mode: state.mode,
    motion: state.motion, temperature: Math.round(state.temperature * 10) / 10, humidity: Math.round(state.humidity),
    off_in: offIn(), rssi: -55 - Math.round(Math.random() * 10), uptime: Math.floor((Date.now() - started) / 1000),
  }, true);
}

function setPower(on, reason) {
  if (state.power === on) return;
  state.power = on;
  send({ ...base("event"), event: "power", power: on ? "on" : "off", mode: state.mode, reason });
  console.log(`power ${on ? "ON" : "OFF"} (${reason})`);
}

function autoLogic() {
  const occupied = state.occupancy > 0 || state.motion;
  if (occupied) state.lastActivity = Date.now();
  if (state.mode !== "auto") return;
  if (occupied) setPower(true, "auto");
  else if (state.power && Date.now() - state.lastActivity >= VACANCY_MS) setPower(false, "auto");
}

client.on("connect", () => {
  console.log(`simulator connected, topic ${topic}`);
  client.subscribe(topic, { qos: 1 });
  status();
});
client.on("error", (e) => console.error("mqtt error:", e.message));

client.on("message", (_t, payload) => {
  let msg;
  try { msg = JSON.parse(payload.toString()); } catch { return; }
  if (msg.type !== "command" || msg.source === "device") return;
  if (msg.room && msg.room !== room) return;
  const ack = (ok, message) => send({ ...base("ack"), id: msg.id ?? null, ok, message, power: state.power ? "on" : "off", mode: state.mode, occupancy: state.occupancy });
  console.log("command:", msg.action, msg.value ?? "");
  if (msg.action === "power" && ["on", "off"].includes(msg.value)) {
    state.mode = "manual";
    setPower(msg.value === "on", "admin");
    ack(true, `Power forced ${msg.value.toUpperCase()} by admin`);
  } else if (msg.action === "power" && msg.value === "auto") {
    state.mode = "auto";
    state.lastActivity = Date.now();
    ack(true, "Back to automatic control");
  } else if (msg.action === "reset_count") {
    state.occupancy = 0;
    ack(true, "Occupancy reset to 0");
  } else if (msg.action === "get_status") {
    ack(true, "Status sent");
  } else {
    ack(false, "Unknown action");
    return;
  }
  autoLogic();
  status();
});

// People wander in and out; temperature drifts with occupancy and the AC.
setInterval(() => {
  const r = Math.random();
  if (r < 0.25 && state.occupancy < 4) {
    state.occupancy++;
    send({ ...base("event"), event: "entry", occupancy: state.occupancy });
  } else if (r < 0.45 && state.occupancy > 0) {
    state.occupancy--;
    send({ ...base("event"), event: "exit", occupancy: state.occupancy });
  }
  state.motion = state.occupancy > 0 && Math.random() < 0.6;
  const target = state.power ? 24 : 28 + state.occupancy * 0.4;
  state.temperature += (target - state.temperature) * 0.08 + (Math.random() - 0.5) * 0.2;
  state.humidity += (Math.random() - 0.5) * 1.5;
  autoLogic();
  status();
}, 4000);

setInterval(() => { autoLogic(); status(); }, STATUS_MS);
