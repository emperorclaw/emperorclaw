#include "config_portal.h"

#include <DNSServer.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_system.h>  // esp_random

#include "data_model.h"
#include "live_client.h"

Config g_cfg;

static const char* NVS_NS = "throne";

void config_load() {
  memset(&g_cfg, 0, sizeof(g_cfg));
  Preferences p;
  if (!p.begin(NVS_NS, true)) return;  // namespace does not exist yet
  // isKey() first: reading a missing key makes the core log an error.
  if (p.isKey("ssid")) p.getString("ssid", g_cfg.ssid, sizeof(g_cfg.ssid));
  if (p.isKey("pass")) p.getString("pass", g_cfg.pass, sizeof(g_cfg.pass));
  if (p.isKey("server")) p.getString("server", g_cfg.server, sizeof(g_cfg.server));
  if (p.isKey("token")) p.getString("token", g_cfg.token, sizeof(g_cfg.token));
  g_cfg.demo = p.getBool("demo", false);
  p.end();
}

void config_save() {
  Preferences p;
  if (!p.begin(NVS_NS, false)) return;
  p.putString("ssid", g_cfg.ssid);
  p.putString("pass", g_cfg.pass);
  p.putString("server", g_cfg.server);
  p.putString("token", g_cfg.token);
  p.putBool("demo", g_cfg.demo);
  p.end();
}

void config_clear() {
  Preferences p;
  if (p.begin(NVS_NS, false)) {
    p.clear();
    p.end();
  }
  memset(&g_cfg, 0, sizeof(g_cfg));
}

bool config_complete() { return g_cfg.ssid[0] && g_cfg.server[0] && g_cfg.token[0]; }

bool server_isAllowed(const char* url) {
  const char* host;
  if (!strncasecmp(url, "https://", 8)) {
    host = url + 8;
  } else if (!strncasecmp(url, "http://", 7)) {
    host = url + 7;
  } else {
    return false;
  }
  size_t authority = strcspn(host, "/?#");
  if (memchr(host, '@', authority)) return false;  // userinfo can disguise the real host
  size_t n = strcspn(host, ":/?#");
  if (!n || n > 63) return false;
  if (host == url + 8) return true;  // https: the certificate is verified
  char h[64];
  for (size_t i = 0; i < n; i++) h[i] = (char)tolower((unsigned char)host[i]);
  h[n] = 0;
  if (n > 6 && !strcmp(h + n - 6, ".local")) return true;
  // Strict dotted quad: exactly four 1-3 digit octets with no leading zeros.
  // lwIP reads "010" as octal, so "010.1.1.1" would pass a %u parse as 10.x
  // yet connect to 8.1.1.1 and send the token in cleartext.
  unsigned o[4];
  const char* q = h;
  for (int i = 0; i < 4; i++) {
    if (!isdigit((unsigned char)*q)) return false;
    if (*q == '0' && isdigit((unsigned char)q[1])) return false;
    unsigned v = 0;
    int digits = 0;
    while (isdigit((unsigned char)*q)) {
      v = v * 10 + (unsigned)(*q++ - '0');
      if (++digits > 3) return false;
    }
    if (v > 255) return false;
    o[i] = v;
    if (i < 3 && *q++ != '.') return false;
  }
  if (*q) return false;
  return o[0] == 10 || (o[0] == 172 && o[1] >= 16 && o[1] <= 31) || (o[0] == 192 && o[1] == 168);
}

bool server_same(const char* a, const char* b) {
  size_t na = strlen(a), nb = strlen(b);
  while (na && a[na - 1] == '/') na--;
  while (nb && b[nb - 1] == '/') nb--;
  return na == nb && !strncasecmp(a, b, na);
}

// ---------------------------------------------------------------- captive portal

static WebServer* s_web = nullptr;
static DNSServer* s_dns = nullptr;
static bool s_active = false;
static char s_apPass[15] = "";  // xxxx-xxxx-xxxx + NUL
static uint32_t s_started = 0;
static uint32_t s_restartAt = 0;
static constexpr int MAX_SCAN = 14;
struct ScanEntry {
  char ssid[33];
  int8_t rssi;
  bool secure;
};
static ScanEntry s_scan[MAX_SCAN];  // strongest first, one entry per SSID
static int s_nScan = 0;
static constexpr const char* OTHER_SSID = "__other__";

bool portal_active() { return s_active; }
uint32_t portal_startedMs() { return s_started; }
const char* portal_password() { return s_apPass; }

static void htmlEscape(String& out, const char* s) {
  for (; *s; s++) {
    switch (*s) {
      case '&': out += F("&amp;"); break;
      case '<': out += F("&lt;"); break;
      case '>': out += F("&gt;"); break;
      case '"': out += F("&quot;"); break;
      case '\'': out += F("&#39;"); break;
      default: out += *s;
    }
  }
}

static const char PAGE_HEAD[] PROGMEM = R"HTML(<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Emperor Claw Display</title>
<style>
:root{color-scheme:dark}body{margin:0;font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d17;color:#e8eaf6}
main{max-width:420px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}p.sub{color:#9aa0c3;margin:0 0 20px}
label{display:block;font-size:13px;color:#b9bee0;margin:14px 0 6px}input,select{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #2b3050;background:#141831;color:#fff;font-size:16px}
button{width:100%;margin-top:22px;padding:14px;border:0;border-radius:12px;background:#f2b632;color:#1a1300;font-weight:700;font-size:16px}
.alt{background:#232848;color:#e8eaf6;margin-top:10px}.hint{font-size:12px;color:#7d83a8;margin-top:6px}
</style></head><body><main><h1>&#x1F451; Throne Display setup</h1><p class="sub">Connect this display to your Emperor Claw company.</p>
)HTML";

static void sendForm() {
  String h;
  h.reserve(4600);
  h += FPSTR(PAGE_HEAD);
  // Networks come from the display's own scan, so a 5 GHz-only network (which the
  // ESP32-C3 cannot see or join) can't be picked by mistake. "Other" covers hidden SSIDs.
  bool savedListed = false;
  for (int i = 0; i < s_nScan; i++)
    if (!strcmp(s_scan[i].ssid, g_cfg.ssid)) savedListed = true;
  bool other = s_nScan == 0 || (g_cfg.ssid[0] && !savedListed);
  h += F("<form method='POST' action='/save'><label>Wi-Fi network</label><select name='ssid' id='ssid' "
         "onchange=\"document.getElementById('o').style.display=this.value=='__other__'?'block':'none'\">");
  for (int i = 0; i < s_nScan; i++) {
    h += F("<option value='");
    htmlEscape(h, s_scan[i].ssid);
    h += '\'';
    if (!other && (g_cfg.ssid[0] ? !strcmp(s_scan[i].ssid, g_cfg.ssid) : i == 0)) h += F(" selected");
    h += '>';
    htmlEscape(h, s_scan[i].ssid);
    int bars = s_scan[i].rssi >= -55 ? 4 : s_scan[i].rssi >= -67 ? 3 : s_scan[i].rssi >= -75 ? 2 : 1;
    h += F(" (");
    for (int b = 0; b < 4; b++) h += b < bars ? F("&#9679;") : F("&#9675;");
    h += s_scan[i].secure ? F(" &#128274;)") : F(" open)");
    h += F("</option>");
  }
  h += F("<option value='__other__'");
  if (other) h += F(" selected");
  h += F(">Other network (type its name)</option></select><div id='o' style='display:");
  h += other ? F("block") : F("none");
  h += F("'><input name='ssid_other' placeholder='Network name (2.4 GHz)' autocomplete='off' value='");
  if (other) htmlEscape(h, g_cfg.ssid);
  h += F("'></div><p class='hint'>Only 2.4 GHz networks are listed: this display cannot use 5 GHz Wi-Fi. "
         "If your router uses one name for both bands, pick it here.</p>"
         "<label>Wi-Fi password</label><input name='pass' type='password' placeholder='");
  h += g_cfg.pass[0] ? F("(saved - leave blank to keep)") : F("(open network)");
  h += F("'><label>Emperor Claw server URL</label><input name='server' type='url' placeholder='https://your-emperor-claw.example' value='");
  htmlEscape(h, g_cfg.server);
  h += F("' required><label>API token (Read only scope)</label><input name='token' type='password' autocomplete='off' placeholder='");
  h += g_cfg.token[0] ? F("(saved - blank keeps it; required if the URL changes)") : F("paste token");
  h += F("'><p class='hint'>Create it in Emperor Claw: Settings &rarr; Access Tokens &rarr; scope <b>Read only</b>. "
         "Changing the server URL erases the saved token, so paste a new one with it. "
         "Use https:// (http:// only for local network addresses).</p>"
         "<button type='submit'>Save and connect</button></form>"
         "<form method='POST' action='/demo'><button class='alt'>Run demo mode</button></form>"
         "<form method='POST' action='/reset' onsubmit=\"return confirm('Erase all settings?')\"><button class='alt'>Erase settings</button></form>"
         "</main></body></html>");
  s_web->send(200, "text/html", h);
}

static void sendMessage(const char* title, const char* body) {
  String h;
  h += FPSTR(PAGE_HEAD);
  h += F("<h1>");
  h += title;
  h += F("</h1><p class='sub'>");
  h += body;
  h += F("</p></main></body></html>");
  s_web->send(200, "text/html", h);
}

static void handleSave() {
  String ssid = s_web->arg("ssid");
  if (ssid == OTHER_SSID || !ssid.length()) ssid = s_web->arg("ssid_other");
  String pass = s_web->arg("pass");
  String server = s_web->arg("server");
  String token = s_web->arg("token");
  ssid.trim();
  server.trim();
  token.trim();
  while (server.endsWith("/")) server.remove(server.length() - 1);
  if (!ssid.length() || !(server.startsWith("http://") || server.startsWith("https://"))) {
    sendMessage("Check the form", "Wi-Fi name and a server URL starting with http:// or https:// are required.");
    return;
  }
  if (!server_isAllowed(server.c_str())) {
    sendMessage("Use https://",
                "Plain http:// is only allowed for local network addresses (10.x, 172.16-31.x, 192.168.x, *.local). "
                "Use your server's https:// address.");
    return;
  }
  // The saved token belongs to the saved server. Pointing the display at another
  // server without a new token would hand the old token to that server, so the
  // stored token is erased and must be entered again.
  if (!token.length() && g_cfg.token[0] && !server_same(server.c_str(), g_cfg.server)) {
    memset(g_cfg.token, 0, sizeof(g_cfg.token));
    config_save();
    Serial.println("[portal] server changed without a new token: saved token erased");
    sendMessage("Token required",
                "The server URL changed, so the saved token was erased. Paste a Read only token for the new server.");
    return;
  }
  if (!token.length() && !g_cfg.token[0]) {
    sendMessage("Token missing", "Paste a Read only API token from Emperor Claw settings.");
    return;
  }
  if (ssid != g_cfg.ssid) g_cfg.pass[0] = 0;  // a new network never reuses the old password
  strlcpy(g_cfg.ssid, ssid.c_str(), sizeof(g_cfg.ssid));
  if (pass.length()) strlcpy(g_cfg.pass, pass.c_str(), sizeof(g_cfg.pass));
  strlcpy(g_cfg.server, server.c_str(), sizeof(g_cfg.server));
  if (token.length()) strlcpy(g_cfg.token, token.c_str(), sizeof(g_cfg.token));
  g_cfg.demo = false;
  config_save();
  Serial.printf("[portal] saved config ssid='%s' server='%s' token=%u chars\n", g_cfg.ssid, g_cfg.server,
                (unsigned)strlen(g_cfg.token));
  sendMessage("Saved", "The display is restarting and will connect in a few seconds.");
  s_restartAt = millis() + 1500;
}

static void handleDemo() {
  g_cfg.demo = true;
  config_save();
  sendMessage("Demo mode", "Restarting into demo mode.");
  s_restartAt = millis() + 1500;
}

static void handleReset() {
  config_clear();
  sendMessage("Erased", "All settings were erased. Restarting.");
  s_restartAt = millis() + 1500;
}

static void handleCaptive() {
  s_web->sendHeader("Location", "http://192.168.4.1/", true);
  s_web->send(302, "text/plain", "");
}

void portal_begin() {
  if (s_active) return;
  Serial.println("[portal] starting captive portal");
  WiFi.disconnect(true);
  delay(100);
  WiFi.mode(WIFI_STA);
  wifi_applyTxPower();
  int n = WiFi.scanNetworks();
  s_nScan = 0;
  for (int i = 0; i < n; i++) {
    String s = WiFi.SSID(i);
    if (!s.length()) continue;
    int8_t rssi = (int8_t)WiFi.RSSI(i);
    int dup = -1;
    for (int j = 0; j < s_nScan; j++)
      if (s == s_scan[j].ssid) dup = j;
    if (dup >= 0) {
      if (rssi > s_scan[dup].rssi) s_scan[dup].rssi = rssi;
      continue;
    }
    if (s_nScan >= MAX_SCAN) continue;
    ScanEntry& e = s_scan[s_nScan++];
    strlcpy(e.ssid, s.c_str(), sizeof(e.ssid));
    e.rssi = rssi;
    e.secure = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
  }
  WiFi.scanDelete();
  for (int i = 1; i < s_nScan; i++) {  // strongest first
    ScanEntry tmp = s_scan[i];
    int j = i - 1;
    while (j >= 0 && s_scan[j].rssi < tmp.rssi) {
      s_scan[j + 1] = s_scan[j];
      j--;
    }
    s_scan[j + 1] = tmp;
  }
  WiFi.mode(WIFI_AP);
  wifi_applyTxPower();
  WiFi.softAPConfig(IPAddress(192, 168, 4, 1), IPAddress(192, 168, 4, 1), IPAddress(255, 255, 255, 0));
  // WPA2 with a fresh random password each time, shown only on the display, so
  // only someone looking at the screen can reach the setup page.
  // 12 symbols from a 31-character set (~59 bits) in three dash-separated
  // groups: long enough to resist offline cracking of a captured handshake,
  // and without look-alike characters (0/o, 1/l/i) so it is easy to type.
  static const char kAlphabet[] = "abcdefghjkmnpqrstuvwxyz23456789";
  int k = 0;
  for (int i = 0; i < 12; i++) {
    if (i && i % 4 == 0) s_apPass[k++] = '-';
    s_apPass[k++] = kAlphabet[esp_random() % (sizeof(kAlphabet) - 1)];
  }
  s_apPass[k] = 0;
  WiFi.softAP(PORTAL_AP_NAME, s_apPass);
  s_dns = new DNSServer();
  s_dns->setErrorReplyCode(DNSReplyCode::NoError);
  s_dns->start(53, "*", IPAddress(192, 168, 4, 1));
  s_web = new WebServer(80);
  s_web->on("/", HTTP_GET, sendForm);
  s_web->on("/save", HTTP_POST, handleSave);
  s_web->on("/demo", HTTP_POST, handleDemo);
  s_web->on("/reset", HTTP_POST, handleReset);
  s_web->onNotFound(handleCaptive);  // generate_204, hotspot-detect.html, etc.
  s_web->begin();
  s_active = true;
  s_started = millis();
  g_net.status = NET_PORTAL;
  Serial.printf("[portal] AP '%s' up at 192.168.4.1 (%d networks scanned), portal password shown on screen\n",
                PORTAL_AP_NAME, s_nScan);
}

void portal_loop() {
  if (!s_active) return;
  s_dns->processNextRequest();
  s_web->handleClient();
  if (s_restartAt && (int32_t)(millis() - s_restartAt) >= 0) {
    Serial.println("[portal] restarting");
    Serial.flush();
    ESP.restart();
  }
  if (millis() - s_started > PORTAL_TIMEOUT_MS) {
    Serial.println("[portal] timeout, restarting");
    ESP.restart();
  }
}
