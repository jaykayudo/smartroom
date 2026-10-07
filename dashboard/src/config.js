const env = import.meta.env;

export const config = {
  url: env.VITE_MQTT_URL || "",
  username: env.VITE_MQTT_USERNAME || undefined,
  password: env.VITE_MQTT_PASSWORD || undefined,
  topic: env.VITE_MQTT_TOPIC || "smartroom/room-1",
  roomId: env.VITE_ROOM_ID || "room-1",
  statusIntervalMs: Number(env.VITE_STATUS_INTERVAL_MS || 5000),
};

export const missingConfig = !config.url;
