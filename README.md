# Smart Room: ESP32 firmware + MQTT admin dashboard

```
firmware/smart_room/      ESP32 sketch (Arduino IDE)
  smart_room.ino
  secrets.h.example       -> copy to secrets.h and fill in
dashboard/                React admin dashboard (Vite)
  src/                    App, MQTT hook, chart
  tools/simulate-room.mjs a fake room for testing without hardware
  .env.example            -> copy to .env and fill in
```

## 1. Set up the broker (HiveMQ Cloud, free tier)

1. Create a free **HiveMQ Cloud Serverless** cluster at hivemq.com.
2. On the cluster's **Overview**, note the host (for example `abc123.s1.eu.hivemq.cloud`).
   - The ESP32 uses **TLS MQTT on port 8883**.
   - The browser uses **secure WebSockets on port 8884, path `/mqtt`**.
3. Under **Access Management**, create two logins:
   - `esp32-room`: used by the ESP32.
   - `dashboard-admin`: used by the dashboard.

Any broker with TLS and WebSockets works, such as EMQX or a Mosquitto you run yourself. If its certificate isn't from Let's Encrypt, replace `ROOT_CA` in `secrets.h`.

## 2. Flash the ESP32

1. Arduino IDE: in Boards Manager, install **esp32 by Espressif Systems**, then select board **ESP32 Dev Module**.
2. In Library Manager, install:
   - **PubSubClient** (Nick O'Leary)
   - **ArduinoJson** (Benoit Blanchon, v7)
   - **DHT sensor library** and **Adafruit Unified Sensor** (Adafruit)
   - **LiquidCrystal I2C** (Frank de Brabander)
3. Copy `secrets.h.example` to `secrets.h`, then fill in your Wi-Fi, broker host, the `esp32-room` login and the topic.
4. Upload, then open Serial Monitor at 115200. You should see `[mqtt] connecting ... ok`.
5. At the top of the sketch, check these settings:
   - `RELAY_ACTIVE_LOW`: most 1-channel modules switch on with LOW.
   - `LCD_ADDRESS`: usually `0x27`, sometimes `0x3F`.
   - `VACANCY_TIMEOUT_MS`: 20 s for the demo.

The pins match the wiring board: IR A 32, IR B 33, PIR 27, relay 26, buzzer 25, DHT11 4, LCD SDA 21 / SCL 22.

## 3. Run the dashboard

```bash
cd dashboard
cp .env.example .env        # fill in VITE_MQTT_URL, dashboard login, topic
npm install
npm run dev                 # open the printed http://localhost:5173
```

**No hardware yet?** Fill in the `SIM_*` lines in `.env` and run `npm run simulate` in a second terminal. It pretends to be the ESP32, using the same messages.

To put the dashboard online, run `npm run build` and upload the `dist/` folder to Netlify, Vercel or GitHub Pages.

## 4. The protocol

There is one topic, `MQTT_TOPIC` / `VITE_MQTT_TOPIC`. Every message is JSON and has a `type` key. Both sides subscribe and publish on that topic, and each side ignores the types it doesn't handle.

| type | from → to | when | example |
|---|---|---|---|
| `status` | ESP32 → dashboard | every 5 s and on every change. **Retained**, so a new dashboard sees the latest state at once | `{"type":"status","source":"device","room":"room-1","ts":1790771637,"online":true,"occupancy":2,"power":"on","mode":"auto","motion":true,"temperature":25.7,"humidity":59,"off_in":null,"rssi":-58,"uptime":312}` |
| `event` | ESP32 → dashboard | every entry and exit | `{"type":"event","source":"device","room":"room-1","ts":…,"event":"entry","occupancy":3}` |
| `event` | ESP32 → dashboard | every power change | `{"type":"event","source":"device","room":"room-1","ts":…,"event":"power","power":"off","mode":"auto","reason":"auto"}` |
| `command` | dashboard → ESP32 | admin clicks a button. **Never retained** | `{"type":"command","source":"dashboard","room":"room-1","action":"power","value":"off","id":"cmd-…"}` |
| `ack` | ESP32 → dashboard | reply to each command, echoing its `id` | `{"type":"ack","source":"device","room":"room-1","id":"cmd-…","ok":true,"message":"Power forced OFF by admin","power":"off","mode":"manual","occupancy":2}` |

These are the commands the ESP32 accepts:

| action | value | effect |
|---|---|---|
| `power` | `on` or `off` | admin override: stays that way until `auto` is sent |
| `power` | `auto` | sensors decide again, starting from a fresh vacancy timeout |
| `reset_count` | none | sets the people count to 0 if the door counter drifts |
| `get_status` | none | asks for an immediate status |

- **Offline detection:** when the ESP32 connects, it registers a retained *last will* with the broker, `{"type":"status","online":false}`. If it loses power or Wi-Fi, the broker publishes that message and the dashboard shows **Room offline**. The dashboard also shows **No recent data** after 3 missed status updates.
- **Timestamps:** `ts` is Unix time in seconds, taken from NTP. It is `null` until the ESP32 has synced its clock, and the dashboard then uses the time the message arrived.

## 5. How the room decides (auto mode)

- **Power on:** when the count is above 0 or the PIR sees motion. The motion rule catches someone the door counter missed.
- **Power off:** when the count is 0 and there has been no motion for `VACANCY_TIMEOUT_MS`. The buzzer gives a warning 5 s before the power goes off.
- **Buzzer patterns:**

  | Meaning | Pattern |
  |---|---|
  | Power on | 3 short beeps |
  | Power off | 1 long beep |
  | Entry | 1 chirp |
  | Exit | 2 chirps |
  | Warning before auto-off | 3 quick beeps |
  | Admin command received | 1 tick |

- **LCD:** line 1 shows the people count and temperature. Line 2 shows the power state and mode, or the countdown to auto-off. The last character is `*` when the ESP32 is connected to the broker, `~` when it has Wi-Fi only, and `!` when it has no Wi-Fi.
- **Offline behaviour:** the room keeps working without Wi-Fi. MQTT reconnects in the background, retrying at longer and longer intervals.

## Troubleshooting

- **`failed, state -2`:** the ESP32 can't reach the broker. Check the host and port, and check the `tls:` text printed after it. If it mentions the certificate, your broker uses another CA. To test without the check, set `MQTT_INSECURE 1`, then put it back to 0.
- **`state 4` or `5`:** wrong username or password, or that login isn't allowed on this topic.
- **Dashboard stuck on "Connecting to broker…":** the URL must be `wss://…:8884/mqtt`, not `mqtts://` or port 8883.
- **Relay clicks on at boot, or never switches off:** flip `RELAY_ACTIVE_LOW`.
- **Door count jumps by two, or counts backwards:** swap the IR A and IR B wires, or adjust the sensitivity screws so the floor isn't detected.

## Security note

The dashboard's broker login is bundled into the website, so anyone who can open the page can read it. For a class demo that's fine: use a separate `dashboard-admin` login, not the ESP32's, and don't publish the site URL. For anything more, put the dashboard behind a login, or restrict that login's permissions in HiveMQ.
