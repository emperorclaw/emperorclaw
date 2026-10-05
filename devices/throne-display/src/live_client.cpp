#include "live_client.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "config_portal.h"
#include "data_model.h"
#include "demo_data.h"
#include "version.h"

// TLS: the server certificate (chain and hostname) is always verified. By default
// against the Mozilla CA bundle that ESP-IDF compiles into the core's mbedTLS
// library (x509_crt_bundle, CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_FULL), so any
// server with a certificate from a public CA works. To trust only your own CA (for
// example a private PKI), create src/root_ca.h with:
//   #define EMPEROR_ROOT_CA "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n"
// and it is used instead of the bundle.
#if __has_include("root_ca.h")
#include "root_ca.h"
#endif
#ifndef EMPEROR_ROOT_CA
extern const uint8_t x509_crt_bundle_start[] asm("_binary_x509_crt_bundle_start");
#endif

namespace {

constexpr uint32_t POLL_MS = 4000;
constexpr uint32_t MAX_BACKOFF_MS = 60000;
constexpr uint32_t HTTP_TIMEOUT_MS = 8000;

volatile bool s_demo = true;
volatile bool s_paused = false;
volatile bool s_kick = false;
TaskHandle_t s_task = nullptr;

Model s_model;  // producer-owned working copy
char s_etag[72] = "";

// Last Wi-Fi disconnect reason (wifi_err_reason_t), for a precise failure message.
volatile uint8_t s_discReason = 0;
// Heap held by the parsed JSON document, and the free heap while it is alive (the
// low point of a fetch, with the TLS session open).
uint32_t s_jsonBytes = 0;
uint32_t s_fetchLowHeap = 0;

WiFiClientSecure* s_tls = nullptr;
WiFiClient* s_plain = nullptr;
HTTPClient s_http;

// Reads an HTTP body that may be chunked or length-delimited, with per-byte timeout.
class BodyReader : public Stream {
 public:
  BodyReader(WiFiClient& c, bool chunked, int len) : _c(c), _chunked(chunked), _left(len) {}
  int available() override { return _eof ? 0 : 1; }
  int peek() override {
    if (_peeked < 0) _peeked = next();
    return _peeked;
  }
  int read() override {
    if (_peeked >= 0) {
      int v = _peeked;
      _peeked = -1;
      return v;
    }
    return next();
  }
  size_t write(uint8_t) override { return 0; }
  void drain(uint32_t budgetMs) {
    uint32_t t0 = millis();
    while (!_eof && millis() - t0 < budgetMs) {
      if (read() < 0) break;
    }
  }
  bool eof() const { return _eof; }

 private:
  WiFiClient& _c;
  bool _chunked;
  int _left;  // bytes left in current chunk / body; -1 = until close
  bool _eof = false;
  bool _firstChunk = true;
  int _peeked = -1;

  int raw() {
    uint32_t t0 = millis();
    while (!_c.available()) {
      if (!_c.connected()) return -1;
      if (millis() - t0 > HTTP_TIMEOUT_MS) return -1;
      delay(1);
    }
    return _c.read();
  }
  bool readChunkHeader() {
    if (!_firstChunk) {  // CRLF after previous chunk data
      int a = raw();
      if (a == '\r') raw();
    }
    _firstChunk = false;
    char line[20];
    int n = 0;
    for (;;) {
      int ch = raw();
      if (ch < 0) return false;
      if (ch == '\n') break;
      if (ch != '\r' && n < (int)sizeof(line) - 1) line[n++] = (char)ch;
    }
    line[n] = 0;
    _left = (int)strtol(line, nullptr, 16);
    if (_left == 0) {
      // Trailer section ends with an empty line.
      for (int guard = 0; guard < 8; guard++) {
        int len = 0;
        for (;;) {
          int ch = raw();
          if (ch < 0 || ch == '\n') break;
          if (ch != '\r') len++;
        }
        if (len == 0) break;
      }
      _eof = true;
    }
    return true;
  }
  int next() {
    if (_eof) return -1;
    if (_chunked) {
      if (_left == 0 && (!readChunkHeader() || _eof)) {
        _eof = true;
        return -1;
      }
      int ch = raw();
      if (ch < 0) {
        _eof = true;
        return -1;
      }
      _left--;
      return ch;
    }
    if (_left == 0) {
      _eof = true;
      return -1;
    }
    int ch = raw();
    if (ch < 0) {
      _eof = true;
      return -1;
    }
    if (_left > 0) _left--;
    return ch;
  }
};

uint8_t parseHealth(const char* s) {
  if (!s) return H_IDLE;
  if (!strcmp(s, "healthy")) return H_HEALTHY;
  if (!strcmp(s, "attention")) return H_ATTENTION;
  if (!strcmp(s, "down")) return H_DOWN;
  return H_IDLE;
}

uint8_t parseState(const char* s) {
  if (!s) return S_IDLE;
  if (!strcmp(s, "typing")) return S_TYPING;
  if (!strcmp(s, "working")) return S_WORKING;
  if (!strcmp(s, "offline")) return S_OFFLINE;
  return S_IDLE;
}

void buildFilter(JsonDocument& f) {
  f["v"] = true;
  f["company"]["name"] = true;
  f["summary"] = true;
  JsonObject a = f["agents"].add<JsonObject>();
  a["id"] = true;
  a["name"] = true;
  a["short"] = true;
  a["hue"] = true;
  a["health"] = true;
  a["state"] = true;
  a["activity"] = true;
  a["task"]["id"] = true;
  a["task"]["title"] = true;
  a["lastSeenSec"] = true;
  a["unanswered"] = true;
  JsonObject m = f["messages"].add<JsonObject>();
  m["id"] = true;
  m["from"] = true;
  m["agentId"] = true;
  m["text"] = true;
  m["ageSec"] = true;
  // The token creator's private chats (absent on older servers: treated as empty).
  JsonObject d = f["dm"].add<JsonObject>();
  d["agentId"] = true;
  JsonObject dm = d["messages"].add<JsonObject>();
  dm["me"] = true;
  dm["text"] = true;
  dm["ageSec"] = true;
}

// Maps `dm` into the fixed pool: up to MAX_DM_PER_AGENT per agent (newest first),
// MAX_DM in total, only for agents in the model.
void mapDm(JsonArray dm, Model& m) {
  for (int i = 0; i < m.nAgents; i++) m.agents[i].dmNewestSec = -1;
  if (dm.isNull()) return;
  for (JsonObject t : dm) {
    if (m.nDm >= MAX_DM) break;
    uint32_t h = fnv1a(t["agentId"] | "");
    int idx = -1;
    for (int i = 0; i < m.nAgents; i++)
      if (m.agents[i].idHash == h) {
        idx = i;
        break;
      }
    if (idx < 0 || m.agents[idx].dmCount) continue;
    Agent& a = m.agents[idx];
    a.dmStart = m.nDm;
    for (JsonObject x : t["messages"].as<JsonArray>()) {
      if (a.dmCount >= MAX_DM_PER_AGENT || m.nDm >= MAX_DM) break;
      DmMsg& g = m.dm[m.nDm];
      g.ageSec = x["ageSec"] | 0;
      if (g.ageSec < 0) g.ageSec = 0;
      g.me = x["me"] | false;
      asciiCopy(g.text, sizeof(g.text), x["text"] | "");
      if (!g.text[0]) continue;
      m.nDm++;
      a.dmCount++;
    }
    // Newest first regardless of server order (insertion sort on age).
    DmMsg* base = &m.dm[a.dmStart];
    for (int i = 1; i < a.dmCount; i++) {
      DmMsg tmp = base[i];
      int j = i - 1;
      while (j >= 0 && base[j].ageSec > tmp.ageSec) {
        base[j + 1] = base[j];
        j--;
      }
      base[j + 1] = tmp;
    }
    a.dmNewestSec = a.dmCount ? base[0].ageSec : -1;
  }
}

void mapDocument(JsonDocument& doc, Model& m) {
  memset(&m, 0, sizeof(m));
  m.demo = false;
  asciiCopy(m.company, sizeof(m.company), doc["company"]["name"] | "");
  for (JsonObject a : doc["agents"].as<JsonArray>()) {
    if (m.nAgents >= MAX_AGENTS) break;
    Agent& g = m.agents[m.nAgents++];
    g.idHash = fnv1a(a["id"] | "");
    asciiCopy(g.name, sizeof(g.name), a["name"] | "Agent");
    const char* sh = a["short"] | (const char*)nullptr;
    if (sh && *sh) {
      asciiCopy(g.shortName, sizeof(g.shortName), sh);
    } else {
      asciiCopy(g.shortName, sizeof(g.shortName), g.name);
      char* sp = strchr(g.shortName, ' ');
      if (sp) *sp = 0;
    }
    g.hue = (uint16_t)((a["hue"] | (int)(g.idHash % 360)) % 360);
    g.health = parseHealth(a["health"] | "idle");
    g.state = parseState(a["state"] | "idle");
    asciiCopy(g.activity, sizeof(g.activity), a["activity"] | "");
    JsonVariant t = a["task"];
    if (!t.isNull()) {
      g.taskHash = fnv1a(t["id"] | "task");
      asciiCopy(g.task, sizeof(g.task), t["title"] | "");
    }
    g.lastSeenSec = a["lastSeenSec"].isNull() ? -1 : a["lastSeenSec"].as<int32_t>();
    g.unanswered = (uint16_t)(a["unanswered"] | 0);
  }
  for (JsonObject x : doc["messages"].as<JsonArray>()) {
    if (m.nMsgs >= MAX_MESSAGES) break;
    Message& g = m.msgs[m.nMsgs++];
    g.idHash = fnv1a(x["id"] | "");
    const char* aid = x["agentId"] | (const char*)nullptr;
    g.agentHash = (aid && *aid) ? fnv1a(aid) : 0;
    asciiCopy(g.from, sizeof(g.from), x["from"] | "?");
    asciiCopy(g.text, sizeof(g.text), x["text"] | "");
    g.ageSec = x["ageSec"] | 0;
  }
  mapDm(doc["dm"].as<JsonArray>(), m);
  // Order oldest -> newest regardless of server ordering (stable insertion sort on age).
  for (int i = 1; i < m.nMsgs; i++) {
    Message tmp = m.msgs[i];
    int j = i - 1;
    while (j >= 0 && m.msgs[j].ageSec < tmp.ageSec) {
      m.msgs[j + 1] = m.msgs[j];
      j--;
    }
    m.msgs[j + 1] = tmp;
  }
  JsonObject s = doc["summary"];
  model_recount(m);  // fallback values from the agent list
  if (!s.isNull()) {
    m.s.agents = s["agents"] | m.s.agents;
    m.s.healthy = s["healthy"] | m.s.healthy;
    m.s.attention = s["attention"] | m.s.attention;
    m.s.down = s["down"] | m.s.down;
    m.s.idle = s["idle"] | m.s.idle;
    m.s.working = s["working"] | m.s.working;
    m.s.pendingApprovals = s["pendingApprovals"] | 0;
    m.s.tasksInProgress = s["tasksInProgress"] | 0;
    m.s.tasksOverdue = s["tasksOverdue"] | 0;
  }
}

// Returns HTTP status (200/304/...) or a negative HTTPClient error.
int fetchOnce() {
  bool https = strncmp(g_cfg.server, "https://", 8) == 0;
  WiFiClient* client;
  if (https) {
    if (!s_tls) {
      s_tls = new WiFiClientSecure();
#ifdef EMPEROR_ROOT_CA
      s_tls->setCACert(EMPEROR_ROOT_CA);
#else
      s_tls->setCACertBundle(x509_crt_bundle_start);
#endif
      s_tls->setHandshakeTimeout(12);
    }
    client = s_tls;
  } else {
    if (!s_plain) s_plain = new WiFiClient();
    client = s_plain;
  }
  char url[200];
  snprintf(url, sizeof(url), "%s/api/mcp/live?messages=8", g_cfg.server);

  static const char* kHeaders[] = {"ETag", "Transfer-Encoding"};
  s_http.setReuse(true);
  s_http.setTimeout(HTTP_TIMEOUT_MS);
  s_http.setConnectTimeout(HTTP_TIMEOUT_MS);
  if (!s_http.begin(*client, url)) return -100;
  s_http.collectHeaders(kHeaders, 2);
  s_http.setUserAgent("EmperorClaw-ThroneDisplay/" FW_VERSION);
  {
    // Build the auth header without ever logging it.
    String auth;
    auth.reserve(8 + strlen(g_cfg.token));
    auth = "Bearer ";
    auth += g_cfg.token;
    s_http.addHeader("Authorization", auth);
  }
  s_http.addHeader("Accept", "application/json");
  if (s_etag[0]) s_http.addHeader("If-None-Match", s_etag);

  int code = s_http.GET();
  if (code == 200) {
    String te = s_http.header("Transfer-Encoding");
    bool chunked = te.indexOf("chunked") >= 0;
    BodyReader body(s_http.getStream(), chunked, chunked ? 0 : s_http.getSize());
    static JsonDocument filter;
    if (filter.isNull()) buildFilter(filter);
    uint32_t heapBefore = ESP.getFreeHeap();
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, body, DeserializationOption::Filter(filter),
                                               DeserializationOption::NestingLimit(8));
    body.drain(2000);
    uint32_t heapParsed = ESP.getFreeHeap();
    s_jsonBytes = heapBefore > heapParsed ? heapBefore - heapParsed : 0;
    s_fetchLowHeap = heapParsed;
    if (err) {
      Serial.printf("[net] JSON error: %s\n", err.c_str());
      s_http.end();
      if (s_tls) s_tls->stop();
      return -200;
    }
    String et = s_http.header("ETag");
    strlcpy(s_etag, et.c_str(), sizeof(s_etag));
    if (!body.eof()) client->stop();  // could not find the body end: do not reuse
    mapDocument(doc, s_model);
    model_publish(s_model);
  } else if (code != 304) {
    // Errors (or unread error bodies) never leave a half-read socket around for reuse.
    client->stop();
  }
  s_http.end();
  return code;
}

// Maps a disconnect reason to the word the web installer shows.
const char* wifiFailKind(uint8_t reason) {
  switch (reason) {
    case WIFI_REASON_AUTH_EXPIRE:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_MIC_FAILURE:
      return "wrong_password";
    case WIFI_REASON_NO_AP_FOUND:
      return "no_network";
    default:
      return "timeout";
  }
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  g_net.status = NET_WIFI;
  static bool hooked = false;
  if (!hooked) {
    hooked = true;
    WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) { s_discReason = info.wifi_sta_disconnected.reason; },
                 ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  }
  if (WiFi.getMode() != WIFI_STA) WiFi.mode(WIFI_STA);
  wifi_applyTxPower();
  WiFi.setAutoReconnect(true);
  s_discReason = 0;
  Serial.printf("[net] connecting to Wi-Fi '%s'\n", g_cfg.ssid);
  WiFi.begin(g_cfg.ssid, g_cfg.pass);
  wifi_applyTxPower();  // some core versions reset the limit inside begin()
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000 && !s_paused && !s_demo) delay(100);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[net] Wi-Fi connected, IP %s RSSI %d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else if (!s_paused && !s_demo) {
    uint8_t r = s_discReason;
    Serial.println("[net] Wi-Fi connect timed out");
    // Machine-readable: wrong_password | no_network | timeout (parsed by the web installer).
    Serial.printf("[net] wifi_fail %s reason=%u\n", r ? wifiFailKind(r) : "timeout", (unsigned)r);
  }
}

void netTask(void*) {
  bool demoActive = false;
  uint32_t nextFetch = 0;
  uint32_t errStreak = 0;
  for (;;) {
    if (s_paused) {
      delay(200);
      continue;
    }
    if (s_demo) {
      if (!demoActive) {
        demo_init(s_model);
        model_publish(s_model);
        demoActive = true;
        Serial.println("[net] demo mode active");
      }
      g_net.status = NET_DEMO;
      if (demo_tick(s_model, millis())) model_publish(s_model);
      delay(100);
      continue;
    }
    if (demoActive) {
      // Leaving demo: clear the screen data so stale demo agents are never shown as live.
      demoActive = false;
      memset(&s_model, 0, sizeof(s_model));
      model_publish(s_model);
      s_etag[0] = 0;
      nextFetch = 0;
    }
    if (!config_complete()) {
      g_net.status = NET_ERROR;
      delay(500);
      continue;
    }
    if (!server_isAllowed(g_cfg.server)) {
      // Never send the token in clear text across the internet.
      static uint32_t lastWarn = 0;
      g_net.status = NET_ERROR;
      g_net.lastHttp = HTTP_INSECURE_SERVER;
      if (!lastWarn || millis() - lastWarn > 60000) {
        lastWarn = millis();
        Serial.println("[net] error insecure_server: use https:// (http:// only for 10.x, 172.16-31.x, 192.168.x, *.local)");
      }
      delay(1000);
      continue;
    }
    if (millis() < WIFI_START_DELAY_MS) {
      delay(100);  // see WIFI_START_DELAY_MS
      continue;
    }
    ensureWifi();
    if (WiFi.status() != WL_CONNECTED) {
      g_net.status = NET_WIFI;
      delay(2000);
      continue;
    }
    if (!s_kick && (int32_t)(millis() - nextFetch) < 0) {
      delay(50);
      continue;
    }
    s_kick = false;
    if (g_net.status != NET_OK) g_net.status = NET_CONNECTING;
    g_net.fetching = true;
    uint32_t t0 = millis();
    int code = fetchOnce();
    g_net.fetching = false;
    g_net.lastHttp = (int16_t)code;
    uint32_t dt = millis() - t0;
    if (code == 200 || code == 304) {
      errStreak = 0;
      g_net.status = NET_OK;
      g_net.lastOkMs = millis();
      g_net.okCount++;
      if (code == 200)
        Serial.printf("[net] 200 in %ums agents=%u msgs=%u dm=%u heap=%u json=%u low=%u min=%u\n", (unsigned)dt,
                      s_model.nAgents, s_model.nMsgs, s_model.nDm, (unsigned)ESP.getFreeHeap(),
                      (unsigned)s_jsonBytes, (unsigned)s_fetchLowHeap, (unsigned)ESP.getMinFreeHeap());
      nextFetch = millis() + POLL_MS;
    } else {
      errStreak++;
      g_net.errCount++;
      g_net.status = NET_ERROR;
      uint32_t back = POLL_MS << (errStreak > 4 ? 4 : errStreak);
      if (code == 401 || code == 403) back = MAX_BACKOFF_MS;
      if (back > MAX_BACKOFF_MS) back = MAX_BACKOFF_MS;
      Serial.printf("[net] fetch failed code=%d (%s) after %ums, retry in %us\n", code,
                    code < 0 ? HTTPClient::errorToString(code).c_str()
                             : (code == 401 || code == 403 ? "token rejected: needs a read_only company token" : "http"),
                    (unsigned)dt, (unsigned)(back / 1000));
      if (code < 0 && s_tls && strncmp(g_cfg.server, "https://", 8) == 0) {
        char why[96];
        int e = s_tls->lastError(why, sizeof(why));
        if (e) Serial.printf("[net] tls error %d: %s\n", e, why);  // e.g. certificate verification failed
      }
      nextFetch = millis() + back;
    }
  }
}

}  // namespace

void wifi_applyTxPower() { WiFi.setTxPower(WIFI_TX_POWER); }

void net_begin(bool demo) {
  s_demo = demo;
  g_net.status = demo ? NET_DEMO : NET_WIFI;
  xTaskCreate(netTask, "net", 10240, nullptr, 1, &s_task);
}

void net_setDemo(bool demo) {
  s_demo = demo;
  s_kick = true;
}
bool net_demo() { return s_demo; }
void net_pause(bool paused) { s_paused = paused; }
void net_kick() { s_kick = true; }
