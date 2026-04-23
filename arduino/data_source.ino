/*
  ============================================================
  Arduino Modbus TCP Server + Remote Data Pipeline
  For: Nonwoven Lamination AI Agent
  Board: ESP32 (WiFi) — connected to Raspberry Pi 4B network
  ============================================================
  
  This sketch does TWO things:
  
  1. MODBUS TCP SERVER (port 502)
     → The AI Agent / RPi polls this device for live sensor data
  
  2. HTTP POST to REMOTE BACKEND (ngrok)
     → Every N seconds, pushes sensor data to the cloud backend
       at https://mace-ebony-capital.ngrok-free.dev/ingest/tags
       using the exact IngestBatch schema the backend expects
  
  Register mapping matches modbus.ts:
    - FC 3 (Holding Registers): addr - 400001 = register offset
    - FC 1 (Coils): addr - 1 = coil offset
  
  Libraries required (install via Arduino IDE Library Manager):
    - "modbus-esp8266" by Andre Sarmento Barbosa
    - "ArduinoJson" by Benoit Blanchon (v7+)
    - HTTPClient (built into ESP32 core)
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ModbusIP_ESP8266.h>

// ── Network Config ───────────────────────────────────────────
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Static IP — must match HMI_IP in .env (default: 192.168.1.17)
// The Raspberry Pi 4B connects to this IP via Modbus TCP
IPAddress ip(192, 168, 1, 17);
IPAddress gateway(192, 168, 1, 1);
IPAddress subnet(255, 255, 255, 0);

// ── Remote Backend Config ────────────────────────────────────
const char* REMOTE_URL       = "https://mace-ebony-capital.ngrok-free.dev/ingest/tags";
const char* API_AUTH_TOKEN   = "dev-local-token";   // Must match API_AUTH_TOKEN in .env
const char* MACHINE_ID       = "lamination-01";
const char* MACHINE_REVISION = "v1";

// How often to push data to the remote backend (milliseconds)
const unsigned long REMOTE_PUSH_INTERVAL_MS = 5000;  // Every 5 seconds
unsigned long lastRemotePushMs = 0;
unsigned long ingestSeq = 0;

// ── Modbus TCP Server ────────────────────────────────────────
ModbusIP mb;

// ── Sensor Pin Assignments ───────────────────────────────────
// Wire actual sensors to these pins, or leave as-is for simulation
const int PIN_EXTRUDER_RPM_ANALOG  = 34;   // Analog input (ESP32 ADC)
const int PIN_EXTRUDER_AMP_ANALOG  = 35;
const int PIN_LAMINATOR_MPM_ANALOG = 32;
const int PIN_LAMINATOR_AMP_ANALOG = 33;
const int PIN_WINDER_AMP_ANALOG    = 36;
const int PIN_EMG_STOP_DIGITAL     = 4;    // Digital input (pull-up)

// ── Register Offsets (derived from modbus.ts TAGS) ───────────
// FC3 Holding Registers: offset = addr - 400001
//   400001 → EXTRUDER_SPEED_PCT → offset 0
//   400002 → LAMINATOR_SPEED_PCT→ offset 1
//   400003 → WINDER_TENSION_PCT → offset 2
//   400008 → RUNNING_METER (f)  → offset 7,8
//   400010 → TOTAL_METER (f)    → offset 9,10
//   400018 → SPLICE_SPEED       → offset 17
//   401040 → WINDER_TENSION_VOL → offset 1039,1040
//   401104 → EXTRUDER_RPM (f)   → offset 1103,1104
//   401106 → LAMINATOR_MPM (f)  → offset 1105,1106
//   401108 → EXTRUDER_AMP (f)   → offset 1107,1108
//   401110 → LAMINATOR_AMP (f)  → offset 1109,1110
//   401112 → WINDER_AMP (f)     → offset 1111,1112
//   401200 → EXTRUDER_SPEED_VOL → offset 1199,1200
//   401202 → LAMINATOR_SPEED_VOL→ offset 1201,1202
//   401300 → GSM_ENTRY (f)      → offset 1299,1300
//   403004 → GRAM_ENTRY (f)     → offset 3003,3004
//   403502 → UW_SET_TENSION     → offset 3501
//   403880 → UW_PV_TENSION      → offset 3879

// FC1 Coils: offset = addr - 1
//   9   → EMG_STOP          → coil 8
//   12  → EXTRUDER_FAULT    → coil 11
//   13  → LAMINATOR_FAULT   → coil 12
//   14  → WINDER_FAULT      → coil 13
//   100 → EXTRUDER_ON_OFF   → coil 99
//   101 → LAMINATOR_ON_OFF  → coil 100
//   102 → WINDER_ON_OFF     → coil 101
//   111 → SPLICE_ON_OFF     → coil 110
//   125 → ALARM_IND         → coil 124

// ── Simulation State ────────────────────────────────────────
float runningMeter = 0.0;
float totalMeter   = 12500.0;
unsigned long lastUpdateMs = 0;
const unsigned long UPDATE_INTERVAL_MS = 500;  // Update registers every 500ms

// ── Latest sensor values (shared between Modbus + HTTP push) ──
float g_extruderRpm     = 0;
float g_extruderAmp     = 0;
uint16_t g_extruderPct  = 0;
float g_laminatorMpm    = 0;
float g_laminatorAmp    = 0;
uint16_t g_laminatorPct = 0;
float g_winderAmp       = 0;
uint16_t g_winderTenPct = 0;
float g_gsm             = 0;
float g_gram            = 0;
uint16_t g_uwSetTension = 0;
uint16_t g_uwPvTension  = 0;
float g_extSpeedVol     = 0;
float g_lamSpeedVol     = 0;
float g_winderTenVol    = 0;
bool g_emgStop          = false;

// ── Helper: Write IEEE 754 float into two consecutive Modbus registers ──
// Agent reads: buf.writeUInt16BE(data[0], 0); buf.writeUInt16BE(data[1], 2);
// then buf.readFloatBE(0) → Big Endian word order.
void writeFloat(uint16_t regStart, float value) {
  uint32_t raw;
  memcpy(&raw, &value, 4);
  uint16_t hi = (raw >> 16) & 0xFFFF;
  uint16_t lo = raw & 0xFFFF;
  mb.Hreg(regStart, hi);
  mb.Hreg(regStart + 1, lo);
}

// ── Helper: Push data to remote backend via HTTP POST ────────
// Sends IngestBatch JSON to POST /ingest/tags:
// {
//   "machineId": "lamination-01",
//   "machineRevision": "v1",
//   "sentAt": "2026-04-23T12:00:00Z",
//   "seq": 42,
//   "tags": [
//     { "tagSlug": "EXTRUDER_RPM", "value": 62.5, "ts": "..." },
//     ...
//   ]
// }
void pushToRemoteBackend() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[HTTP] WiFi not connected, skipping push");
    return;
  }

  HTTPClient http;
  http.begin(REMOTE_URL);
  http.addHeader("Content-Type", "application/json");

  // Bearer token auth — matches requireApiAuth() in backend
  String authHeader = "Bearer ";
  authHeader += API_AUTH_TOKEN;
  http.addHeader("Authorization", authHeader);

  // Build JSON payload using ArduinoJson
  JsonDocument doc;
  doc["machineId"] = MACHINE_ID;
  doc["machineRevision"] = MACHINE_REVISION;

  // ISO 8601 timestamp (approximate — ESP32 doesn't have RTC by default)
  char tsBuffer[30];
  unsigned long secs = millis() / 1000;
  snprintf(tsBuffer, sizeof(tsBuffer), "2026-01-01T%02lu:%02lu:%02luZ",
           (secs / 3600) % 24, (secs / 60) % 60, secs % 60);
  doc["sentAt"] = tsBuffer;
  doc["seq"] = ingestSeq++;

  JsonArray tags = doc["tags"].to<JsonArray>();

  // Helper lambda-style macro to add tags
  #define ADD_TAG(slug, val) { \
    JsonObject t = tags.add<JsonObject>(); \
    t["tagSlug"] = slug; \
    t["value"] = val; \
    t["ts"] = tsBuffer; \
  }

  // ── Add all sensor tags ──
  ADD_TAG("EXTRUDER_RPM",          g_extruderRpm);
  ADD_TAG("EXTRUDER_AMP",          g_extruderAmp);
  ADD_TAG("EXTRUDER_SPEED_PCT",    g_extruderPct);
  ADD_TAG("LAMINATOR_MPM",         g_laminatorMpm);
  ADD_TAG("LAMINATOR_AMP",         g_laminatorAmp);
  ADD_TAG("LAMINATOR_SPEED_PCT",   g_laminatorPct);
  ADD_TAG("WINDER_AMP",            g_winderAmp);
  ADD_TAG("WINDER_TENSION_PCT",    g_winderTenPct);
  ADD_TAG("RUNNING_METER",         runningMeter);
  ADD_TAG("TOTAL_METER",           totalMeter);
  ADD_TAG("GSM_ENTRY",             g_gsm);
  ADD_TAG("GRAM_ENTRY",            g_gram);
  ADD_TAG("UW_SET_TENSION",        g_uwSetTension);
  ADD_TAG("UW_PV_TENSION",         g_uwPvTension);
  ADD_TAG("EXTRUDER_SPEED_VOL",    g_extSpeedVol);
  ADD_TAG("LAMINATOR_SPEED_VOL",   g_lamSpeedVol);
  ADD_TAG("WINDER_TENSION_VOL",    g_winderTenVol);
  ADD_TAG("MASTER_SPEED_PCT",      g_extruderPct);  // reuse
  ADD_TAG("EMG_STOP",              g_emgStop);
  ADD_TAG("EXTRUDER_ON_OFF",       true);
  ADD_TAG("LAMINATOR_ON_OFF",      true);
  ADD_TAG("WINDER_ON_OFF",         true);

  #undef ADD_TAG

  // Serialize to string
  String payload;
  serializeJson(doc, payload);

  Serial.printf("[HTTP] POST %s (seq=%lu, %d tags, %d bytes)\n",
    REMOTE_URL, ingestSeq - 1, tags.size(), payload.length());

  int httpCode = http.POST(payload);

  if (httpCode > 0) {
    String response = http.getString();
    if (httpCode == 200) {
      Serial.printf("[HTTP] ✓ 200 OK — %s\n", response.c_str());
    } else {
      Serial.printf("[HTTP] ✗ %d — %s\n", httpCode, response.c_str());
    }
  } else {
    Serial.printf("[HTTP] ✗ Connection failed: %s\n", http.errorToString(httpCode).c_str());
  }

  http.end();
}

// ══════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.println("============================================");
  Serial.println("  Nonwoven Modbus TCP + Remote Pipeline");
  Serial.println("  Board: ESP32 → RPi 4B Network");
  Serial.println("============================================");

  // ── Connect to WiFi ──
  WiFi.config(ip, gateway, subnet);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[WiFi] Connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("[WiFi] Connected! IP: ");
  Serial.println(WiFi.localIP());

  // ── Start Modbus TCP Server on port 502 ──
  mb.server();
  Serial.println("[Modbus TCP] Server started on port 502");

  // ── Allocate Holding Registers (FC3) ──
  // uint16 registers
  mb.addHreg(0);      // EXTRUDER_SPEED_PCT (addr 400001 → offset 0)
  mb.addHreg(1);      // LAMINATOR_SPEED_PCT (addr 400002 → offset 1)
  mb.addHreg(2);      // WINDER_TENSION_PCT  (addr 400003 → offset 2)
  mb.addHreg(17);     // SPLICE_SPEED        (addr 400018 → offset 17)
  mb.addHreg(3501);   // UW_SET_TENSION      (addr 403502 → offset 3501)
  mb.addHreg(3879);   // UW_PV_TENSION       (addr 403880 → offset 3879)

  // Float registers (2 regs each)
  mb.addHreg(7);  mb.addHreg(8);      // RUNNING_METER    (addr 400008)
  mb.addHreg(9);  mb.addHreg(10);     // TOTAL_METER      (addr 400010)
  mb.addHreg(1039); mb.addHreg(1040); // WINDER_TENSION_VOL (addr 401040)
  mb.addHreg(1103); mb.addHreg(1104); // EXTRUDER_RPM     (addr 401104)
  mb.addHreg(1105); mb.addHreg(1106); // LAMINATOR_MPM    (addr 401106)
  mb.addHreg(1107); mb.addHreg(1108); // EXTRUDER_AMP     (addr 401108)
  mb.addHreg(1109); mb.addHreg(1110); // LAMINATOR_AMP    (addr 401110)
  mb.addHreg(1111); mb.addHreg(1112); // WINDER_AMP       (addr 401112)
  mb.addHreg(1199); mb.addHreg(1200); // EXTRUDER_SPEED_VOL (addr 401200)
  mb.addHreg(1201); mb.addHreg(1202); // LAMINATOR_SPEED_VOL(addr 401202)
  mb.addHreg(1299); mb.addHreg(1300); // GSM_ENTRY        (addr 401300)
  mb.addHreg(3003); mb.addHreg(3004); // GRAM_ENTRY       (addr 403004)

  // ── Allocate Coils (FC1) ──
  mb.addCoil(8);     // EMG_STOP          (addr 9)
  mb.addCoil(11);    // EXTRUDER_FAULT    (addr 12)
  mb.addCoil(12);    // LAMINATOR_FAULT   (addr 13)
  mb.addCoil(13);    // WINDER_FAULT      (addr 14)
  mb.addCoil(99);    // EXTRUDER_ON_OFF   (addr 100)
  mb.addCoil(100);   // LAMINATOR_ON_OFF  (addr 101)
  mb.addCoil(101);   // WINDER_ON_OFF     (addr 102)
  mb.addCoil(110);   // SPLICE_ON_OFF     (addr 111)
  mb.addCoil(124);   // ALARM_IND         (addr 125)

  // ── Set initial coil states ──
  mb.Coil(8, false);    // EMG_STOP off
  mb.Coil(11, false);   // No faults
  mb.Coil(12, false);
  mb.Coil(13, false);
  mb.Coil(99, true);    // Extruder running
  mb.Coil(100, true);   // Laminator running
  mb.Coil(101, true);   // Winder running
  mb.Coil(110, false);  // Splice off
  mb.Coil(124, false);  // No alarm

  // ── Pin modes ──
  pinMode(PIN_EMG_STOP_DIGITAL, INPUT_PULLUP);

  Serial.println("[Ready] Modbus TCP + Remote Pipeline active");
  Serial.printf("[Remote] Pushing to %s every %lu ms\n", REMOTE_URL, REMOTE_PUSH_INTERVAL_MS);
  Serial.println("============================================");
  Serial.println();

  lastUpdateMs = millis();
  lastRemotePushMs = millis();
}

// ══════════════════════════════════════════════════════════════
void loop() {
  // Process incoming Modbus TCP requests from RPi 4B / Agent
  mb.task();

  unsigned long now = millis();
  if (now - lastUpdateMs < UPDATE_INTERVAL_MS) return;
  lastUpdateMs = now;

  // ── Read sensors (replace with real analogRead for production) ──

  // --- Extruder ---
  g_extruderRpm = 60.0 + (random(-100, 100) / 50.0);
  g_extruderAmp = 22.0 + (random(-100, 100) / 100.0);
  g_extruderPct = 65 + random(-2, 3);

  // --- Laminator ---
  g_laminatorMpm = 105.0 + (random(-200, 200) / 100.0);
  g_laminatorAmp = 7.5 + (random(-50, 50) / 100.0);
  g_laminatorPct = 70 + random(-2, 3);

  // --- Winder ---
  g_winderAmp = 5.5 + (random(-30, 30) / 100.0);
  g_winderTenPct = 55 + random(-3, 4);

  // --- Production meters ---
  float speedMps = g_laminatorMpm / 60.0;
  runningMeter += speedMps * (UPDATE_INTERVAL_MS / 1000.0);
  totalMeter   += speedMps * (UPDATE_INTERVAL_MS / 1000.0);

  // --- GSM / Gram ---
  g_gsm  = 30.5 + (random(-20, 20) / 100.0);
  g_gram = 150.0 + (random(-50, 50) / 100.0);

  // --- Tension ---
  g_uwSetTension = 400;
  g_uwPvTension  = 400 + random(-15, 16);

  // --- Voltages ---
  g_extSpeedVol  = g_extruderPct * 0.1;
  g_lamSpeedVol  = g_laminatorPct * 0.1;
  g_winderTenVol = g_winderTenPct * 0.08;

  // --- Safety ---
  g_emgStop = (digitalRead(PIN_EMG_STOP_DIGITAL) == LOW);

  // ══ UPDATE MODBUS REGISTERS ═══════════════════════════════

  // uint16 Holding Registers
  mb.Hreg(0,    g_extruderPct);       // EXTRUDER_SPEED_PCT
  mb.Hreg(1,    g_laminatorPct);      // LAMINATOR_SPEED_PCT
  mb.Hreg(2,    g_winderTenPct);      // WINDER_TENSION_PCT
  mb.Hreg(17,   g_laminatorPct);      // SPLICE_SPEED
  mb.Hreg(3501, g_uwSetTension);      // UW_SET_TENSION
  mb.Hreg(3879, g_uwPvTension);       // UW_PV_TENSION

  // Float Holding Registers (Big Endian word order)
  writeFloat(7,    runningMeter);      // RUNNING_METER
  writeFloat(9,    totalMeter);        // TOTAL_METER
  writeFloat(1039, g_winderTenVol);    // WINDER_TENSION_VOL
  writeFloat(1103, g_extruderRpm);     // EXTRUDER_RPM
  writeFloat(1105, g_laminatorMpm);    // LAMINATOR_MPM
  writeFloat(1107, g_extruderAmp);     // EXTRUDER_AMP
  writeFloat(1109, g_laminatorAmp);    // LAMINATOR_AMP
  writeFloat(1111, g_winderAmp);       // WINDER_AMP
  writeFloat(1199, g_extSpeedVol);     // EXTRUDER_SPEED_VOL
  writeFloat(1201, g_lamSpeedVol);     // LAMINATOR_SPEED_VOL
  writeFloat(1299, g_gsm);            // GSM_ENTRY
  writeFloat(3003, g_gram);           // GRAM_ENTRY

  // Coils
  mb.Coil(8, g_emgStop);              // EMG_STOP

  // ══ PUSH TO REMOTE BACKEND ════════════════════════════════
  if (now - lastRemotePushMs >= REMOTE_PUSH_INTERVAL_MS) {
    lastRemotePushMs = now;
    pushToRemoteBackend();
  }

  // ── Periodic serial log ──
  static unsigned long lastLogMs = 0;
  if (now - lastLogMs > 5000) {
    lastLogMs = now;
    Serial.printf("[Status] RPM=%.1f  MPM=%.1f  AMP=%.1f  RunM=%.0f  TotalM=%.0f  EMG=%d  seq=%lu\n",
      g_extruderRpm, g_laminatorMpm, g_extruderAmp, runningMeter, totalMeter, g_emgStop, ingestSeq);
  }
}
