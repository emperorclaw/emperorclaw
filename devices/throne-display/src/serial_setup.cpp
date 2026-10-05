#include "serial_setup.h"

#include <ArduinoJson.h>
#include <WiFi.h>
#include <esp_heap_caps.h>
#include <mbedtls/base64.h>

#include "config_portal.h"
#include "live_client.h"

namespace {

constexpr int MAX_SCAN_OUT = 20;
constexpr uint32_t SCAN_TIMEOUT_MS = 15000;

bool s_scanning = false;
bool s_radioWasOff = false;
uint32_t s_scanStart = 0;

void finishScan() {
  s_scanning = false;
  WiFi.scanDelete();
  if (s_radioWasOff) WiFi.mode(WIFI_OFF);  // demo mode: keep the radio (and its current draw) off
  net_pause(false);
}

void printResults(int n) {
  // Strongest entry per SSID, strongest first. Hidden networks are skipped.
  int idx[MAX_SCAN_OUT];
  int count = 0;
  for (int i = 0; i < n; i++) {
    String ssid = WiFi.SSID(i);
    if (!ssid.length()) continue;
    int dup = -1;
    for (int j = 0; j < count; j++)
      if (WiFi.SSID(idx[j]) == ssid) dup = j;
    if (dup >= 0) {
      if (WiFi.RSSI(i) > WiFi.RSSI(idx[dup])) idx[dup] = i;
      continue;
    }
    if (count < MAX_SCAN_OUT) {
      idx[count++] = i;
    } else {
      // Full: replace the weakest if this one is stronger.
      int weakest = 0;
      for (int j = 1; j < count; j++)
        if (WiFi.RSSI(idx[j]) < WiFi.RSSI(idx[weakest])) weakest = j;
      if (WiFi.RSSI(i) > WiFi.RSSI(idx[weakest])) idx[weakest] = i;
    }
  }
  for (int i = 1; i < count; i++) {
    int v = idx[i], j = i - 1;
    while (j >= 0 && WiFi.RSSI(idx[j]) < WiFi.RSSI(v)) {
      idx[j + 1] = idx[j];
      j--;
    }
    idx[j + 1] = v;
  }
  for (int k = 0; k < count; k++) {
    int i = idx[k];
    JsonDocument d;
    d["ssid"] = WiFi.SSID(i);
    d["rssi"] = WiFi.RSSI(i);
    d["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
    d["ch"] = WiFi.channel(i);
    Serial.print("[scan] ");
    serializeJson(d, Serial);  // escapes quotes and control characters
    Serial.println();
  }
  Serial.printf("[scan] done %d\n", count);
}

bool copyField(char* dst, size_t cap, const char* src, size_t minLen) {
  size_t n = strlen(src);
  if (n < minLen || n >= cap) return false;
  memcpy(dst, src, n + 1);
  return true;
}

}  // namespace

bool setup_scanning() { return s_scanning; }

void setup_startScan() {
  if (s_scanning) {
    Serial.println("[scan] error busy");
    return;
  }
  if (portal_active()) {
    Serial.println("[scan] error portal_active");
    return;
  }
  Serial.println("[scan] start");
  // Keep the network task off the radio while scanning; an in-progress join makes the scan fail.
  net_pause(true);
  s_radioWasOff = WiFi.getMode() == WIFI_OFF;
  if (s_radioWasOff) {
    WiFi.mode(WIFI_STA);
    wifi_applyTxPower();
  }
  if (WiFi.status() != WL_CONNECTED) WiFi.disconnect(false, false);
  int r = WiFi.scanNetworks(true /* async */, false /* hidden */);
  if (r == WIFI_SCAN_FAILED) {
    Serial.println("[scan] error failed");
    finishScan();
    return;
  }
  s_scanning = true;
  s_scanStart = millis();
}

void setup_pollScan() {
  if (!s_scanning) return;
  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) {
    if (millis() - s_scanStart > SCAN_TIMEOUT_MS) {
      Serial.println("[scan] error timeout");
      finishScan();
    }
    return;
  }
  if (n < 0) {
    Serial.println("[scan] error failed");
  } else {
    printResults(n);
  }
  finishScan();
}

namespace {

// ArduinoJson allocator that wipes every block before freeing it, so the decoded
// Wi-Fi password and token never linger in freed heap.
struct WipingAllocator : ArduinoJson::Allocator {
  void* allocate(size_t size) override { return malloc(size); }
  void deallocate(void* p) override {
    if (!p) return;
    memset(p, 0, heap_caps_get_allocated_size(p));
    free(p);
  }
  void* reallocate(void* p, size_t size) override {
    if (!p) return malloc(size);
    void* q = malloc(size);
    if (!q) return nullptr;
    size_t old = heap_caps_get_allocated_size(p);
    memcpy(q, p, old < size ? old : size);
    deallocate(p);
    return q;
  }
};

// Reports a provisioning failure; the caller has already wiped its buffers.
void provFail(const char* reason) { Serial.printf("[prov] error %s\n", reason); }

}  // namespace

void setup_provision(const char* b64) {
  static unsigned char buf[600];
  static WipingAllocator alloc;
  Config next;
  memset(&next, 0, sizeof(next));
  const char* fail = nullptr;
  {
    JsonDocument d(&alloc);
    size_t inLen = strlen(b64);
    size_t outLen = 0;
    if (!inLen) {
      fail = "empty";
    } else if (mbedtls_base64_decode(buf, sizeof(buf) - 1, &outLen, (const unsigned char*)b64, inLen) != 0) {
      fail = "base64";
    } else {
      buf[outLen] = 0;
      DeserializationError err = deserializeJson(d, (const char*)buf, outLen);
      if (err || !d.is<JsonObject>()) {
        fail = "json";
      } else if ((d["v"] | 1) != 1) {
        fail = "version";
      } else if (!copyField(next.ssid, sizeof(next.ssid), d["ssid"] | "", 1)) {
        fail = "ssid";
      } else {
        const char* pass = d["pass"] | "";
        size_t passLen = strlen(pass);
        const char* server = d["server"] | "";
        if ((passLen > 0 && passLen < 8) || !copyField(next.pass, sizeof(next.pass), pass, 0)) {
          fail = "pass";
        } else if ((strncmp(server, "http://", 7) && strncmp(server, "https://", 8)) ||
                   !copyField(next.server, sizeof(next.server), server, 8)) {
          fail = "server";
        } else if (!server_isAllowed(next.server)) {
          fail = "insecure_server";
        } else if (!copyField(next.token, sizeof(next.token), d["token"] | "", 1)) {
          fail = "token";
        }
      }
    }
    memset(buf, 0, sizeof(buf));  // every path: the payload holds the password and token
  }  // d is destroyed here; WipingAllocator zeroes its memory
  if (fail) {
    memset(&next, 0, sizeof(next));
    provFail(fail);
    return;
  }
  size_t n = strlen(next.server);
  while (n && next.server[n - 1] == '/') next.server[--n] = 0;
  next.demo = false;
  g_cfg = next;
  memset(&next, 0, sizeof(next));
  config_save();
  Serial.printf("[prov] ok ssid='%s' server='%s'\n", g_cfg.ssid, g_cfg.server);
  Serial.println("[prov] restarting");
  Serial.flush();
  delay(300);
  ESP.restart();
}
