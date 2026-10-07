/*
  Smart Energy-Saving Room — ESP32 firmware
  -------------------------------------------
  Counts people through the door (2 x IR), watches for motion (PIR), reads
  temperature (DHT11) and switches the room's power through a relay.
  Talks to an MQTT broker over TLS (WiFiClientSecure) on ONE topic, using JSON
  messages told apart by their "type" key:

    status   device -> dashboard   every few seconds + on every change (retained)
    event    device -> dashboard   every entry / exit, and every power change
    command  dashboard -> device   {"action":"power","value":"on"|"off"|"auto"}
                                   {"action":"reset_count"}   {"action":"get_status"}
    ack      device -> dashboard   reply to a command, echoing its "id"

  Pins match the wiring board (30-pin ESP32 DevKit V1):
    IR A (outer, by the door) GPIO32   IR B (inner) GPIO33
    PIR OUT GPIO27   Relay IN GPIO26   Buzzer GPIO25   DHT11 DATA GPIO4
    LCD I2C  SDA GPIO21 / SCL GPIO22

  Libraries (Arduino Library Manager):
    PubSubClient (Nick O'Leary), ArduinoJson (Benoit Blanchon, v7),
    DHT sensor library + Adafruit Unified Sensor (Adafruit),
    LiquidCrystal I2C (Frank de Brabander)
  Board: "ESP32 Dev Module" (esp32 by Espressif Systems).
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
#include <time.h>
#include "secrets.h"   // copy secrets.h.example -> secrets.h and fill it in

// ======================= Pins =======================
const uint8_t PIN_IR_ENTER = 32; // "enter" IR: the OUTER one, by the door. Someone coming in passes it first.
const uint8_t PIN_IR_EXIT  = 33; // "exit" IR: the INNER one, room side. Someone going out passes it first.
const uint8_t PIN_PIR    = 27;
const uint8_t PIN_RELAY  = 26;
const uint8_t PIN_BUZZER = 25;
const uint8_t PIN_DHT    = 4;

// ======================= Hardware options =======================
const bool    RELAY_ACTIVE_LOW = false;    // most 1-channel modules switch ON with LOW. Set false if yours is active-high.
const bool    IR_ACTIVE_LOW    = true;    // FC-51 output goes LOW when it sees something
const uint8_t LCD_ADDRESS      = 0x27;    // run an I2C scanner if the screen stays blank (often 0x27 or 0x3F)

// ======================= Timing (demo values) =======================
const uint32_t STATUS_INTERVAL_MS   = 5000;   // regular status stream
const uint32_t VACANCY_TIMEOUT_MS   = 10000;  // empty + no motion for this long -> power off (use 5-15 min in real life)
const uint32_t WARNING_BEFORE_MS    = 5000;   // warning beeps this long before auto-off
const uint32_t DOOR_GAP_MS          = 1500;   // max wait for the second IR after the first one (walking speed)
const uint32_t DOOR_CLEAR_MS        = 300;    // doorway must be empty this long before a crossing is judged
const uint32_t DOOR_STUCK_MS        = 5000;   // an IR blocked this long is probably seeing the floor: warn
const bool     DEBUG_DOOR           = true;   // print every IR change to the Serial Monitor (set false when it works)
const uint32_t IR_DEBOUNCE_MS       = 30;
const uint32_t DHT_INTERVAL_MS      = 2500;   // DHT11 can't be read faster than ~1 per second
const uint32_t LCD_INTERVAL_MS      = 500;
const uint32_t MQTT_RETRY_MIN_MS    = 5000;
const uint32_t MQTT_RETRY_MAX_MS    = 60000;

// ======================= Objects =======================
WiFiClientSecure tlsClient;
PubSubClient     mqtt(tlsClient);
LiquidCrystal_I2C lcd(LCD_ADDRESS, 16, 2);
DHT              dht(PIN_DHT, DHT11);

// ======================= State =======================
enum class Mode { AUTO, MANUAL };
Mode  mode         = Mode::AUTO;
bool  powerOn      = false;
int   occupancy    = 0;
bool  motion       = false;
float temperature  = NAN;
float humidity     = NAN;

uint32_t lastActivityMs  = 0;    // last time the room looked occupied
bool     warningGiven    = false;
bool     statusDirty     = true; // publish a status as soon as possible
uint32_t lastStatusMs    = 0;
uint32_t lastDhtMs       = 0;
uint32_t lastLcdMs       = 0;
uint32_t nextMqttTryMs   = 0;
uint32_t mqttRetryMs     = MQTT_RETRY_MIN_MS;
char     clientId[32];

// Door counter types (declared up here so Arduino's auto-generated prototypes can see them)
struct DebouncedInput {
  uint8_t  pin;
  bool     stable;
  bool     lastRaw;
  uint32_t changedMs;
};
enum class Side : uint8_t { NONE, ENTER, EXIT };   // which IR sensor
struct Crossing {             // one person walking through the doorway
  bool     active;            // a crossing is in progress
  Side     first;             // the IR that saw them first  -> the side they came FROM
  Side     lastCleared;       // the IR that let go of them last -> the side they ended up ON
  bool     sawEnter;          // the enter IR was blocked at some point
  bool     sawExit;           // the exit IR was blocked at some point
  uint32_t lastChangeMs;      // last time either IR changed
};

// ======================= Buzzer (non-blocking patterns) =======================
// Each pattern: ON, OFF, ON, OFF ... in ms. 0 ends the pattern.
const uint16_t BEEP_POWER_ON[]  = {80, 80, 80, 0};
const uint16_t BEEP_POWER_OFF[] = {450, 0};
const uint16_t BEEP_WARNING[]   = {60, 90, 60, 90, 60, 0};
const uint16_t BEEP_ENTRY[]     = {40, 0};
const uint16_t BEEP_EXIT[]      = {40, 70, 40, 0};
const uint16_t BEEP_COMMAND[]   = {25, 0};

const uint16_t* beepPattern = nullptr;
uint8_t  beepIndex  = 0;
uint32_t beepNextMs = 0;

void beep(const uint16_t* pattern) {
  beepPattern = pattern;
  beepIndex   = 0;
  beepNextMs  = millis() + pattern[0];
  digitalWrite(PIN_BUZZER, HIGH);
}

void updateBuzzer() {
  if (!beepPattern || (int32_t)(millis() - beepNextMs) < 0) return;
  beepIndex++;
  uint16_t d = beepPattern[beepIndex];
  if (d == 0) {                         // pattern finished
    digitalWrite(PIN_BUZZER, LOW);
    beepPattern = nullptr;
    return;
  }
  digitalWrite(PIN_BUZZER, (beepIndex % 2 == 0) ? HIGH : LOW);
  beepNextMs = millis() + d;
}

// ======================= Helpers =======================
uint32_t nowEpoch() {                   // seconds since 1970, or 0 until NTP has synced
  time_t t = time(nullptr);
  return t > 1700000000 ? (uint32_t)t : 0;
}

const char* modeName()  { return mode == Mode::AUTO ? "auto" : "manual"; }
const char* powerName() { return powerOn ? "on" : "off"; }

void writeRelay(bool on) {
  bool level = RELAY_ACTIVE_LOW ? !on : on;
  digitalWrite(PIN_RELAY, level ? HIGH : LOW);
}

// ======================= MQTT publishing =======================
bool publishJson(JsonDocument& doc, bool retained) {
  if (!mqtt.connected()) return false;
  char buf[512];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  return mqtt.publish(MQTT_TOPIC, (const uint8_t*)buf, n, retained);
}

void baseFields(JsonDocument& doc, const char* type) {
  doc["type"]   = type;
  doc["source"] = "device";
  doc["room"]   = ROOM_ID;
  uint32_t ts = nowEpoch();
  if (ts) doc["ts"] = ts; else doc["ts"] = nullptr;
}

// Seconds left before auto-off, or -1 when no countdown is running.
long secondsUntilOff() {
  if (mode != Mode::AUTO || !powerOn || occupancy > 0 || motion) return -1;
  uint32_t idle = millis() - lastActivityMs;
  if (idle >= VACANCY_TIMEOUT_MS) return 0;
  return (VACANCY_TIMEOUT_MS - idle + 999) / 1000;
}

void publishStatus() {
  JsonDocument doc;
  baseFields(doc, "status");
  doc["online"]    = true;
  doc["occupancy"] = occupancy;
  doc["power"]     = powerName();
  doc["mode"]      = modeName();
  doc["motion"]    = motion;
  if (isnan(temperature)) doc["temperature"] = nullptr; else doc["temperature"] = roundf(temperature * 10) / 10.0;
  if (isnan(humidity))    doc["humidity"]    = nullptr; else doc["humidity"]    = roundf(humidity);
  long offIn = secondsUntilOff();
  if (offIn >= 0) doc["off_in"] = offIn; else doc["off_in"] = nullptr;
  doc["rssi"]   = WiFi.RSSI();
  doc["uptime"] = millis() / 1000;
  // Retained, so a dashboard that opens later gets the latest state straight away.
  if (publishJson(doc, true)) {
    lastStatusMs = millis();
    statusDirty  = false;
  }
}

void publishDoorEvent(const char* what) {
  JsonDocument doc;
  baseFields(doc, "event");
  doc["event"]     = what;          // "entry" or "exit"
  doc["occupancy"] = occupancy;
  publishJson(doc, false);
}

void publishPowerEvent(const char* reason) {
  JsonDocument doc;
  baseFields(doc, "event");
  doc["event"]  = "power";
  doc["power"]  = powerName();
  doc["mode"]   = modeName();
  doc["reason"] = reason;           // "auto", "admin"
  publishJson(doc, false);
}

void publishAck(const char* id, bool ok, const char* message) {
  JsonDocument doc;
  baseFields(doc, "ack");
  if (id && *id) doc["id"] = id; else doc["id"] = nullptr;
  doc["ok"]        = ok;
  doc["message"]   = message;
  doc["power"]     = powerName();
  doc["mode"]      = modeName();
  doc["occupancy"] = occupancy;
  publishJson(doc, false);
}

// ======================= Power control =======================
void setPower(bool on, const char* reason) {
  if (on == powerOn) return;
  powerOn = on;
  writeRelay(on);
  beep(on ? BEEP_POWER_ON : BEEP_POWER_OFF);
  warningGiven = false;
  Serial.printf("[power] %s (%s)\n", powerName(), reason);
  publishPowerEvent(reason);
  statusDirty = true;
}

void runAutoLogic() {
  bool occupied = occupancy > 0 || motion;
  if (occupied) {
    lastActivityMs = millis();
    warningGiven = false;
  }
  if (mode != Mode::AUTO) return;

  if (occupied) {
    if (!powerOn) setPower(true, "auto");
    return;
  }
  if (!powerOn) return;

  uint32_t idle = millis() - lastActivityMs;
  if (!warningGiven && idle + WARNING_BEFORE_MS >= VACANCY_TIMEOUT_MS) {
    warningGiven = true;
    beep(BEEP_WARNING);               // "wave now if you're still here"
    statusDirty = true;
  }
  if (idle >= VACANCY_TIMEOUT_MS) setPower(false, "auto");
}

// ======================= Door counter =======================
DebouncedInput irEnter = {PIN_IR_ENTER, false, false, 0};
DebouncedInput irExit  = {PIN_IR_EXIT,  false, false, 0};

bool readActive(DebouncedInput& in) {
  bool raw = digitalRead(in.pin) == (IR_ACTIVE_LOW ? LOW : HIGH);
  if (raw != in.lastRaw) { in.lastRaw = raw; in.changedMs = millis(); }
  if (raw != in.stable && millis() - in.changedMs >= IR_DEBOUNCE_MS) in.stable = raw;
  return in.stable;
}

Crossing crossing      = {false, Side::NONE, Side::NONE, false, false, 0};
bool     wasEnter      = false;   // last loop's state of each IR, to spot changes
bool     wasExit       = false;
bool     stuckReported = false;

const char* sideName(Side s) { return s == Side::ENTER ? "ENTER" : s == Side::EXIT ? "EXIT" : "none"; }

void personEntered() {
  occupancy++;
  Serial.printf("[door] entry -> %d inside\n", occupancy);
  beep(BEEP_ENTRY);
  publishDoorEvent("entry");
  statusDirty = true;
}

void personLeft() {
  if (occupancy > 0) occupancy--;
  Serial.printf("[door] exit -> %d inside\n", occupancy);
  beep(BEEP_EXIT);
  publishDoorEvent("exit");
  statusDirty = true;
}

/*
  Door counter: two IR sensors, "enter" (outside) and "exit" (inside).

    Coming IN :  enter IR sees the person first, exit IR lets go of them last.
    Going OUT :  exit IR sees the person first, enter IR lets go of them last.

  The decision is made only once the doorway is empty again, so:
    - someone who steps in and backs out is not counted (first and last are the same IR),
    - a small gap between the two sensors is fine (they don't have to be blocked together),
    - the count changes once per crossing, never twice.
*/
void judgeCrossing() {
  bool sawBoth = crossing.sawEnter && crossing.sawExit;

  if (sawBoth && crossing.first == Side::ENTER && crossing.lastCleared == Side::EXIT) {
    personEntered();
  } else if (sawBoth && crossing.first == Side::EXIT && crossing.lastCleared == Side::ENTER) {
    personLeft();
  } else if (DEBUG_DOOR) {
    Serial.printf("[door] ignored: first=%s last=%s %s\n", sideName(crossing.first),
                  sideName(crossing.lastCleared), sawBoth ? "(turned back)" : "(only one IR saw it)");
  }
  crossing.active = false;
}

void updateDoor() {
  uint32_t now  = millis();
  bool enterNow = readActive(irEnter);   // true = something is under the enter IR
  bool exitNow  = readActive(irExit);

  // What changed since the last loop?
  bool enterBlocked = enterNow && !wasEnter;
  bool enterCleared = !enterNow && wasEnter;
  bool exitBlocked  = exitNow && !wasExit;
  bool exitCleared  = !exitNow && wasExit;
  wasEnter = enterNow;
  wasExit  = exitNow;
  bool changed = enterBlocked || enterCleared || exitBlocked || exitCleared;

  if (DEBUG_DOOR && changed) {
    Serial.printf("[door] enter IR %s | exit IR %s\n", enterNow ? "BLOCKED" : "clear  ", exitNow ? "BLOCKED" : "clear");
  }

  // 1. A new crossing starts when either IR becomes blocked.
  if (!crossing.active && (enterBlocked || exitBlocked)) {
    crossing.active      = true;
    crossing.first       = (enterBlocked && exitBlocked) ? Side::NONE      // both at once: direction unknown
                         : enterBlocked                  ? Side::ENTER : Side::EXIT;
    crossing.lastCleared = Side::NONE;
    crossing.sawEnter    = false;
    crossing.sawExit     = false;
  }
  if (!crossing.active) return;

  // 2. Record what happens during the crossing.
  if (changed) { crossing.lastChangeMs = now; stuckReported = false; }
  if (enterBlocked) crossing.sawEnter = true;
  if (exitBlocked)  crossing.sawExit  = true;
  if (enterCleared && exitCleared) crossing.lastCleared = Side::NONE;   // let go together: can't tell
  else if (enterCleared)           crossing.lastCleared = Side::ENTER;
  else if (exitCleared)            crossing.lastCleared = Side::EXIT;

  // 3. Judge it once the doorway has been empty long enough.
  //    If only one IR has fired so far, wait longer: the person may still reach the other one.
  uint32_t quietMs  = now - crossing.lastChangeMs;
  bool     doorEmpty = !enterNow && !exitNow;
  bool     sawBoth   = crossing.sawEnter && crossing.sawExit;
  if (doorEmpty && quietMs >= (sawBoth ? DOOR_CLEAR_MS : DOOR_GAP_MS)) {
    judgeCrossing();
  } else if (!doorEmpty && quietMs >= DOOR_STUCK_MS && !stuckReported) {
    // Something has sat under an IR for ages: usually the sensor seeing the floor.
    Serial.printf("[door] WARNING: %s IR blocked for %lus. Turn its screw until its LED is off with nothing under it.\n",
                  enterNow ? "enter" : "exit", (unsigned long)(quietMs / 1000));
    stuckReported = true;
  }
}

// ======================= Sensors =======================
void updateMotion() {
  bool m = digitalRead(PIN_PIR) == HIGH;
  if (m != motion) {
    motion = m;
    statusDirty = true;
  }
}

void updateClimate() {
  if (millis() - lastDhtMs < DHT_INTERVAL_MS) return;
  lastDhtMs = millis();

  float t = dht.readTemperature();
  float h = dht.readHumidity();

  if (isnan(t) || isnan(h)) {
    Serial.printf("[dht] ERROR: failed to read sensor (temp %s, humidity %s). "
                  "Check wiring on GPIO %d, the pull-up resistor and DHT_TYPE.\n",
                  isnan(t) ? "missing" : "ok", isnan(h) ? "missing" : "ok", PIN_DHT);
  }

  if (!isnan(t)) temperature = t;
  if (!isnan(h)) humidity = h;

  if (!isnan(t) && !isnan(h)) {
    Serial.printf("[dht] Temperature: %.1f °C   Humidity: %.0f %%\n", t, h);
  }
}

// ======================= LCD =======================
void updateLcd() {
  if (millis() - lastLcdMs < LCD_INTERVAL_MS) return;
  lastLcdMs = millis();

  char line1[32], line2[32];
  int  people = constrain(occupancy, 0, 999);
  if (isnan(temperature)) snprintf(line1, sizeof(line1), "In:%-3d  --.-C   ", people);
  else                    snprintf(line1, sizeof(line1), "In:%-3d  %4.1fC   ", people, temperature);

  long offIn = secondsUntilOff();
  const char* net = mqtt.connected() ? "*" : (WiFi.status() == WL_CONNECTED ? "~" : "!");
  if (offIn >= 0) snprintf(line2, sizeof(line2), "OFF in %-3ds   %s  ", (int)constrain(offIn, 0L, 999L), net);
  else            snprintf(line2, sizeof(line2), "PWR:%-3s %-6s %s", powerOn ? "ON" : "OFF",
                           mode == Mode::AUTO ? "AUTO" : "ADMIN", net);
  line1[16] = '\0';                      // the LCD is 16 characters wide
  line2[16] = '\0';
  lcd.setCursor(0, 0); lcd.print(line1);
  lcd.setCursor(0, 1); lcd.print(line2);
}

// ======================= MQTT receive =======================
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;       // not JSON: ignore

  const char* type   = doc["type"]   | "";
  const char* source = doc["source"] | "";
  if (strcmp(type, "command") != 0) return;                 // our own status/events echo back: ignore
  if (strcmp(source, "device") == 0) return;

  const char* room = doc["room"] | ROOM_ID;                 // commands may target a room; default = this one
  if (strcmp(room, ROOM_ID) != 0) return;

  const char* action = doc["action"] | "";
  const char* value  = doc["value"]  | "";
  const char* id     = doc["id"]     | "";
  Serial.printf("[mqtt] command %s %s\n", action, value);

  if (strcmp(action, "power") == 0) {
    if (strcmp(value, "on") == 0) {
      mode = Mode::MANUAL;
      beep(BEEP_COMMAND);
      setPower(true, "admin");
      publishAck(id, true, "Power forced ON by admin");
    } else if (strcmp(value, "off") == 0) {
      mode = Mode::MANUAL;
      beep(BEEP_COMMAND);
      setPower(false, "admin");
      publishAck(id, true, "Power forced OFF by admin");
    } else if (strcmp(value, "auto") == 0) {
      mode = Mode::AUTO;
      lastActivityMs = millis();                            // give the room a fresh timeout
      beep(BEEP_COMMAND);
      publishAck(id, true, "Back to automatic control");
    } else {
      publishAck(id, false, "value must be on, off or auto");
    }
  } else if (strcmp(action, "reset_count") == 0) {
    occupancy = 0;
    publishAck(id, true, "Occupancy reset to 0");
  } else if (strcmp(action, "get_status") == 0) {
    publishAck(id, true, "Status sent");
  } else {
    publishAck(id, false, "Unknown action");
    return;
  }
  statusDirty = true;
}

// ======================= Network =======================
void startWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  lcd.clear(); lcd.print("WiFi..."); lcd.setCursor(0, 1); lcd.print(WIFI_SSID);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) { delay(250); Serial.print('.'); }
  Serial.println(WiFi.status() == WL_CONNECTED ? " ok" : " not yet (keeps trying in the background)");
  if (WiFi.status() == WL_CONNECTED) Serial.printf("[wifi] IP %s\n", WiFi.localIP().toString().c_str());
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");         // UTC; the dashboard shows local time
}

void maintainMqtt() {
  if (mqtt.connected()) { mqtt.loop(); return; }
  if (WiFi.status() != WL_CONNECTED) return;
  if ((int32_t)(millis() - nextMqttTryMs) < 0) return;

  // Last will: if the ESP32 drops off, the broker publishes this (retained) for us.
  char will[128];
  snprintf(will, sizeof(will), "{\"type\":\"status\",\"source\":\"device\",\"room\":\"%s\",\"online\":false}", ROOM_ID);

  Serial.printf("[mqtt] connecting to %s:%d ... ", MQTT_HOST, MQTT_PORT);
  if (mqtt.connect(clientId, MQTT_USER, MQTT_PASS, MQTT_TOPIC, 1, true, will)) {
    Serial.println("ok");
    mqtt.subscribe(MQTT_TOPIC, 1);
    mqttRetryMs = MQTT_RETRY_MIN_MS;
    statusDirty = true;
  } else {
    char err[100] = "";
    tlsClient.lastError(err, sizeof(err));
    Serial.printf("failed, state %d, tls: %s\n", mqtt.state(), err);
    nextMqttTryMs = millis() + mqttRetryMs;
    mqttRetryMs = min(mqttRetryMs * 2, MQTT_RETRY_MAX_MS);    // back off so the room logic keeps running
  }
}

// ======================= Setup & loop =======================
void setup() {
  // Set the relay OFF before making it an output, so it doesn't click on at boot.
  writeRelay(false);
  pinMode(PIN_RELAY, OUTPUT);
  writeRelay(false);

  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  pinMode(PIN_IR_ENTER, INPUT);
  pinMode(PIN_IR_EXIT, INPUT);
  pinMode(PIN_PIR, INPUT);

  Serial.begin(115200);
  delay(200);
  Serial.println("\nSmart room starting");

  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  dht.begin();

  uint64_t mac = ESP.getEfuseMac();
  snprintf(clientId, sizeof(clientId), "smartroom-%04X%08X", (uint16_t)(mac >> 32), (uint32_t)mac);

  startWifi();

#if MQTT_INSECURE
  tlsClient.setInsecure();
#else
  tlsClient.setCACert(ROOT_CA);
#endif
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(768);
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(10);

  lastActivityMs = millis();
  lcd.clear();
}

void loop() {
  updateDoor();
  updateMotion();
  updateClimate();
  runAutoLogic();
  updateBuzzer();
  updateLcd();

  maintainMqtt();
  if (mqtt.connected() && (statusDirty || millis() - lastStatusMs >= STATUS_INTERVAL_MS)) {
    publishStatus();
  }
}
