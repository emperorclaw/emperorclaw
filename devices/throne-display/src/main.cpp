// Emperor Claw Throne Display
// ESP32-2424S012C-I (ESP32-C3, GC9A01 240x240 round, CST816D touch).
//
// Frame pipeline: every frame renders into one 240x240 8-bit indexed sprite (57.6 KB,
// allocated first thing at boot to avoid heap fragmentation) and pushes it to the panel.
// Networking / demo simulation runs on a separate FreeRTOS task and publishes snapshots.
#include <Arduino.h>
#include <WiFi.h>
#include <esp_heap_caps.h>

#include "app.h"
#include "config_portal.h"
#include "data_model.h"
#include "display_config.h"
#include "live_client.h"
#include "palette.h"
#include "serial_setup.h"
#include "touch.h"
#include "ui_common.h"
#include "version.h"

static LGFX lcd;
static LGFX_Sprite s_canvas;

using namespace ui;
using pal::c;

static constexpr uint32_t FRAME_MS = 33;  // ~30 fps cap
static constexpr uint32_t DIM_AFTER_MS = 120000;
static constexpr uint8_t BL_ON = 200, BL_DIM = 18;

// Mode transition: fade + slide out, switch, fade + slide in.
static constexpr uint32_t T_OUT = 140, T_IN = 260;
static uint32_t s_transStart = 0;
static int8_t s_transDir = 0;  // +1 next, -1 previous, 0 idle
static uint8_t s_transTarget = 0;
static bool s_transSwitched = false;

static uint32_t s_lastTouchMs = 0;
static uint32_t s_bootMs = 0;
static int s_backlight = 0;
static bool s_portalScreen = false;

// Stats
static uint32_t s_frames = 0, s_statFrames = 0, s_statStart = 0, s_renderAccUs = 0, s_pushAccUs = 0;
static uint32_t s_lastStatLog = 0;
static uint32_t s_heapBoot = 0, s_heapAfterFb = 0, s_largestAfterFb = 0;
static bool s_fbOk = false;

static void logHeap(const char* tag) {
  Serial.printf("[heap] %s free=%u largest=%u min=%u\n", tag, (unsigned)ESP.getFreeHeap(),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT), (unsigned)ESP.getMinFreeHeap());
}

static void printBootSummary() {
  Serial.printf("[boot] %s rev %d @ %u MHz, flash %u KB, heap at boot %u, after framebuffer %u (largest %u), fb %s\n",
                ESP.getChipModel(), ESP.getChipRevision(), (unsigned)ESP.getCpuFreqMHz(),
                (unsigned)(ESP.getFlashChipSize() / 1024), (unsigned)s_heapBoot, (unsigned)s_heapAfterFb,
                (unsigned)s_largestAfterFb, s_fbOk ? "ok" : "FAILED");
}

static void printStats() {
  uint32_t el = app.now - s_statStart;
  float fps = el ? s_statFrames * 1000.0f / el : 0;
  Serial.printf("[stats] fps=%.1f render=%luus push=%luus mode=%d agents=%u net=%d\n", fps,
                (unsigned long)(s_statFrames ? s_renderAccUs / s_statFrames : 0),
                (unsigned long)(s_statFrames ? s_pushAccUs / s_statFrames : 0), app.mode, app.model.nAgents,
                g_net.status);
  logHeap("periodic");
  s_lastStatLog = app.now;
  s_statStart = app.now;
  s_statFrames = 0;
  s_renderAccUs = s_pushAccUs = 0;
}

static void startTransition(uint8_t target, int dir) {
  if (target == app.mode || s_transDir != 0) return;
  app.chatOpen = false;
  s_transTarget = target;
  s_transDir = (int8_t)dir;
  s_transStart = app.now;
  s_transSwitched = false;
}

// Returns palette brightness (0..256) and sets ui::ox for the content slide.
static int transitionStep() {
  if (s_transDir == 0) {
    ox = 0;
    return 256;
  }
  uint32_t t = app.now - s_transStart;
  if (t < T_OUT) {
    int k = (int)(t * 1024 / T_OUT);
    ox = -s_transDir * easeInOutCubic(k) * 36 / 1024;
    return 256 - k / 4;
  }
  if (!s_transSwitched) {
    s_transSwitched = true;
    app.mode = s_transTarget;
    clearParticles();
  }
  t -= T_OUT;
  if (t >= T_IN) {
    s_transDir = 0;
    ox = 0;
    return 256;
  }
  int k = easeOutCubic((int)(t * 1024 / T_IN));
  ox = s_transDir * (1024 - k) * 36 / 1024;
  return k / 4;
}

// ---------------------------------------------------------------- overlays

static void drawStatusDot() {
  int x, y;
  polar(103, ANG_TOP + 128, x, y);  // 1:30 position
  uint8_t r;
  int lv = 11;
  switch (g_net.status) {
    case NET_DEMO: r = pal::VIOLET; break;
    case NET_OK:
      r = pal::GREEN;
      if (g_net.fetching) lv = 15;
      else if (app.now - g_net.lastOkMs > 20000) r = pal::GOLD;
      break;
    case NET_ERROR: r = pal::RED; lv = 8 + pulse(app.now, 1000) * 6 / 1024; break;
    case NET_PORTAL: r = pal::GOLD; break;
    default: r = pal::GOLD; lv = 6 + pulse(app.now, 600) * 8 / 1024; break;
  }
  glow(x, y, 7, r, lv - 3);
  fillCircle(x, y, 2, c(r, (uint8_t)lv));
}

static void drawModeDots() {
  for (int i = 0; i < MODE_COUNT; i++) {
    int a = ANG_BOTTOM + (int)((3 - 2 * i) * 11);  // leftmost = mode 0
    int x, y;
    polar(110, a, x, y);
    bool on = i == (s_transDir && s_transSwitched ? s_transTarget : app.mode);
    if (on) {
      glow(x, y, 6, pal::GOLD, 7);
      fillCircle(x, y, 2, c(pal::GOLD, 14));
    } else {
      fillCircle(x, y, 1, c(pal::NEUTRAL, 8));
    }
  }
}

static void drawRimAlerts() {
  const Summary& s = app.model.s;
  if (s.down > 0) {
    int p = pulse(app.now, 1300);
    arc(CX, CY, 114, 119, 0, 1023, c(pal::RED, (uint8_t)(3 + p * 7 / 1024)), true);
    arc(CX, CY, 109, 113, 0, 1023, c(pal::RED, (uint8_t)(1 + p * 3 / 1024)), true);
  }
  if (s.pendingApprovals > 0) {
    int p = pulse(app.now + 500, 2100);
    int r0 = s.down > 0 ? 105 : 113;
    arc(CX, CY, r0, r0 + 4, 0, 1023, c(pal::GOLD, (uint8_t)(2 + p * 8 / 1024)), true);
  }
}

static void drawHoldProgress() {
  uint32_t h = touch_holdMs();
  if (h < 500) return;
  int a = (int)((h - 500) * 1024 / 4500);
  if (a > 1023) a = 1023;
  arc(CX, CY, 116, 119, ANG_TOP, ANG_TOP + a, h >= 1500 ? c(pal::GOLD, 13) : pal::WHITE);
  const char* msg = h < 1500 ? "keep holding" : (h < 5000 ? (net_demo() ? "release: live mode" : "release: demo mode") : "");
  if (h >= 3000) msg = "hold for setup";
  fillRoundRect(CX - 56, 206, 112, 14, 7, c(pal::NEUTRAL, 2));
  text(msg, CX, 213, pal::TEXT, F_TINY);
}

static void drawDemoTag() {
  if (!app.model.demo) return;
  text("DEMO", CX, 222 - 8, c(pal::VIOLET, 12), F_TINY);
  uint32_t t = app.now - s_bootMs;
  bool hint = t < 20000 || (t % 60000) < 5000;
  if (hint && touch_holdMs() < 500) arcText("hold 5s for setup", 96, ANG_BOTTOM, c(pal::NEUTRAL, 9), F_TINY, false);
}

static void drawNoDataNotice() {
  if (app.model.demo || app.model.nAgents > 0) return;
  const char* l1 = "Connecting";
  char l2[48] = "";
  switch (g_net.status) {
    case NET_WIFI: l1 = "Joining Wi-Fi"; strlcpy(l2, g_cfg.ssid, sizeof(l2)); break;
    case NET_ERROR:
      l1 = "Server error";
      if (g_net.lastHttp == 401 || g_net.lastHttp == 403) strlcpy(l2, "token rejected", sizeof(l2));
      else if (g_net.lastHttp == HTTP_INSECURE_SERVER) strlcpy(l2, "use an https:// URL", sizeof(l2));
      else snprintf(l2, sizeof(l2), "code %d - retrying", g_net.lastHttp);
      break;
    default: strlcpy(l2, "fetching live data", sizeof(l2)); break;
  }
  fillRoundRect(CX - 70, 150, 140, 36, 10, c(pal::NEUTRAL, 2));
  text(l1, CX, 161, pal::TEXT, F_SMALL);
  text(l2, CX, 177, pal::TEXT_DIM, F_TINY);
}

static void drawPortalScreen() {
  clear(pal::BLACK);
  fillCircle(CX, CY, 119, pal::BG);
  int p = pulse(app.now, 2200);
  ring(CX, CY, 112, 117, c(pal::GOLD, (uint8_t)(4 + p * 6 / 1024)));
  glow(CX, 40, 22, pal::GOLD, 5);
  drawCrown(CX, 40, 2);
  text("SETUP", CX, 66, pal::WHITE, F_MED);
  text("Join this Wi-Fi:", CX, 88, pal::TEXT_DIM, F_SMALL);
  text(PORTAL_AP_NAME, CX, 106, c(pal::GOLD, 12), F_MED);
  text("password", CX, 126, pal::TEXT_DIM, F_SMALL);
  // The random WPA2 password is only ever shown here (never on serial).
  text(portal_password()[0] ? portal_password() : "...", CX, 148, pal::WHITE, F_MED);
  text("then open", CX, 170, pal::TEXT_DIM, F_SMALL);
  text("192.168.4.1", CX, 188, c(pal::CYAN, 12), F_MED);
  uint32_t left = PORTAL_TIMEOUT_MS - (app.now - portal_startedMs());
  char buf[32];
  snprintf(buf, sizeof(buf), "tap to cancel  %lu:%02lu", (unsigned long)(left / 60000), (unsigned long)(left / 1000 % 60));
  text(buf, CX, 204, pal::TEXT_FAINT, F_TINY);
}

// ---------------------------------------------------------------- input

static void enterPortal() {
  if (portal_active()) return;
  if (setup_scanning()) {
    Serial.println("[ui] a Wi-Fi scan is running; try setup again in a few seconds");
    return;
  }
  net_pause(true);
  delay(300);  // let an in-flight request finish its current read
  s_portalScreen = true;
  // Render one frame so the user sees the instructions while the scan runs.
  app.now = millis();
  pal::apply(s_canvas, 256);
  drawPortalScreen();
  s_canvas.pushSprite(&lcd, 0, 0);
  portal_begin();
}

static void handleGesture(const TouchEvent& ev) {
  s_lastTouchMs = app.now;
  if (s_portalScreen) {
    if (ev.type == G_TAP) {
      Serial.println("[ui] portal cancelled, restarting");
      delay(100);
      ESP.restart();
    }
    return;
  }
  // Private chat (inside FOCUS): tap or swipe left / right closes it; swipe
  // down shows older messages, swipe up newer ones.
  if (app.mode == MODE_FOCUS && app.chatOpen && s_transDir == 0) {
    switch (ev.type) {
      case G_TAP:
      case G_SWIPE_LEFT:
      case G_SWIPE_RIGHT: focus_openChat(false); return;
      case G_SWIPE_DOWN: focus_scrollChat(+1); return;
      case G_SWIPE_UP: focus_scrollChat(-1); return;
      default: break;
    }
  }
  switch (ev.type) {
    case G_SWIPE_LEFT: startTransition((app.mode + 1) % MODE_COUNT, +1); break;
    case G_SWIPE_RIGHT: startTransition((app.mode + MODE_COUNT - 1) % MODE_COUNT, -1); break;
    case G_SWIPE_UP:
      if (app.mode == MODE_FOCUS) focus_step(+1);
      break;
    case G_SWIPE_DOWN:
      if (app.mode == MODE_FOCUS) focus_step(-1);
      break;
    case G_TAP:
      if (app.mode == MODE_THRONE && throne_tap(ev.x, ev.y)) startTransition(MODE_FOCUS, +1);
      else if (app.mode == MODE_PULSE && pulse_tap(ev.x, ev.y)) startTransition(MODE_FOCUS, -1);
      else if (app.mode == MODE_FOCUS && s_transDir == 0) focus_openChat(true);
      break;
    case G_HOLD_2S:
      if (net_demo() && !config_complete()) {
        Serial.println("[ui] no configuration yet: staying in demo (hold 5 s for setup)");
      } else {
        bool demo = !net_demo();
        g_cfg.demo = demo;
        config_save();
        net_setDemo(demo);
        Serial.printf("[ui] switched to %s mode\n", demo ? "demo" : "live");
      }
      break;
    case G_HOLD_5S: enterPortal(); break;
    default: break;
  }
}

// Serial console: help / status / version / scan / provision B64 / demo / live / setup /
// reset / touch / mode N / ssid X / pass X / server X / token X / save
// (serial_setup.h documents the machine-readable setup commands).
static void handleSerial() {
  static char buf[768];  // fits `provision <base64>` with the longest allowed values
  static size_t len = 0;
  while (Serial.available()) {
    int ch = Serial.read();
    if (ch == '\r') continue;
    if (ch != '\n') {
      if (len < sizeof(buf) - 1) buf[len++] = (char)ch;
      continue;
    }
    buf[len] = 0;
    len = 0;
    char* cmd = buf;
    while (*cmd == ' ') cmd++;
    char* arg = strchr(cmd, ' ');
    if (arg) {
      *arg++ = 0;
      while (*arg == ' ') arg++;
    } else {
      arg = (char*)"";
    }
    if (!strcmp(cmd, "help")) {
      Serial.println("commands: status | stats | version | scan | provision <base64> | demo | live | setup |"
                     " reset | touch | mode <0-3> | ssid <v> | pass <v> | server <url> | token <v> | save");
    } else if (!strcmp(cmd, "version")) {
      Serial.println("[version] " FW_VERSION);
    } else if (!strcmp(cmd, "scan")) {
      setup_startScan();
    } else if (!strcmp(cmd, "provision")) {
      setup_provision(arg);
    } else if (!strcmp(cmd, "stats")) {
      printStats();
    } else if (!strcmp(cmd, "status")) {
      printBootSummary();
      Serial.printf("[status] mode=%d demo=%d net=%d http=%d ok=%u err=%u agents=%u msgs=%u wifi=%s ssid='%s' "
                    "server='%s' token=%s\n",
                    app.mode, net_demo(), g_net.status, g_net.lastHttp, (unsigned)g_net.okCount,
                    (unsigned)g_net.errCount, app.model.nAgents, app.model.nMsgs,
                    WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "down", g_cfg.ssid,
                    g_cfg.server, g_cfg.token[0] ? "set" : "missing");
      logHeap("status");
    } else if (!strcmp(cmd, "demo")) {
      g_cfg.demo = true;
      config_save();
      net_setDemo(true);
      Serial.println("[cmd] demo mode on");
    } else if (!strcmp(cmd, "live")) {
      if (!config_complete()) {
        Serial.println("[cmd] cannot go live: set ssid/server/token first (or use 'setup')");
      } else {
        g_cfg.demo = false;
        config_save();
        net_setDemo(false);
        Serial.println("[cmd] live mode on");
      }
    } else if (!strcmp(cmd, "setup")) {
      enterPortal();
    } else if (!strcmp(cmd, "reset")) {
      config_clear();
      Serial.println("[cmd] settings erased, restarting");
      delay(200);
      ESP.restart();
    } else if (!strcmp(cmd, "touch")) {
      g_touchDebug = !g_touchDebug;
      Serial.printf("[cmd] touch debug %s\n", g_touchDebug ? "on" : "off");
    } else if (!strcmp(cmd, "mode")) {
      int m = atoi(arg);
      if (m >= 0 && m < MODE_COUNT) startTransition((uint8_t)m, m > app.mode ? 1 : -1);
    } else if (!strcmp(cmd, "ssid")) {
      strlcpy(g_cfg.ssid, arg, sizeof(g_cfg.ssid));
      Serial.println("[cmd] ssid set (run 'save')");
    } else if (!strcmp(cmd, "pass")) {
      strlcpy(g_cfg.pass, arg, sizeof(g_cfg.pass));
      Serial.println("[cmd] password set (run 'save')");
    } else if (!strcmp(cmd, "server")) {
      if (!server_isAllowed(arg)) {
        Serial.println("[cmd] error insecure_server: use https:// (http:// only for 10.x, 172.16-31.x, 192.168.x, *.local)");
      } else {
        // A token is only ever sent to the server it was entered for.
        bool changed = !server_same(arg, g_cfg.server);
        strlcpy(g_cfg.server, arg, sizeof(g_cfg.server));
        size_t n = strlen(g_cfg.server);
        while (n && g_cfg.server[n - 1] == '/') g_cfg.server[--n] = 0;
        if (changed && g_cfg.token[0]) {
          memset(g_cfg.token, 0, sizeof(g_cfg.token));
          Serial.println("[cmd] server changed: token cleared, set 'token' again (then 'save')");
        } else {
          Serial.println("[cmd] server set (run 'save')");
        }
      }
    } else if (!strcmp(cmd, "token")) {
      strlcpy(g_cfg.token, arg, sizeof(g_cfg.token));
      Serial.printf("[cmd] token set (%u chars, run 'save')\n", (unsigned)strlen(g_cfg.token));
    } else if (!strcmp(cmd, "save")) {
      g_cfg.demo = !config_complete();
      config_save();
      Serial.println("[cmd] saved, restarting");
      delay(200);
      ESP.restart();
    } else if (*cmd) {
      Serial.printf("[cmd] unknown '%s' (try 'help')\n", cmd);
    }
    memset(buf, 0, sizeof(buf));  // a line can carry a password or token
  }
}

// ---------------------------------------------------------------- setup / loop

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);  // never block rendering when no USB host is listening
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 1200) delay(10);
  Serial.println();
  Serial.println("=== Emperor Claw Throne Display ===");
  Serial.println("[boot] firmware " FW_VERSION);
  Serial.printf("chip %s rev %d, %u MHz, flash %u KB\n", ESP.getChipModel(), ESP.getChipRevision(),
                (unsigned)ESP.getCpuFreqMHz(), (unsigned)(ESP.getFlashChipSize() / 1024));
  s_heapBoot = ESP.getFreeHeap();
  logHeap("boot");

  // 1) Frame buffer first, while the heap is still one big contiguous block.
  s_canvas.setColorDepth(lgfx::palette_8bit);
  s_canvas.setPsram(false);
  if (!s_canvas.createSprite(W, H)) {
    Serial.println("[fatal] could not allocate the 240x240 frame buffer");
  }
  s_fbOk = s_canvas.getBuffer() != nullptr;
  s_heapAfterFb = ESP.getFreeHeap();
  s_largestAfterFb = heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);
  logHeap("after framebuffer");

  lcd.init();
  lcd.setBrightness(0);
  lcd.fillScreen(TFT_BLACK);

  pal::build();
  pal::apply(s_canvas, 256);
  ui::init(&s_canvas);

  touch_init();
  config_load();
  model_init();
  memset(&app, 0, sizeof(app));
  bool demo = g_cfg.demo || !config_complete();
  Serial.printf("[cfg] %s (ssid %s, server %s, token %s)\n", demo ? "demo mode" : "live mode",
                g_cfg.ssid[0] ? "set" : "missing", g_cfg.server[0] ? g_cfg.server : "missing",
                g_cfg.token[0] ? "set" : "missing");
  net_begin(demo);
  s_bootMs = millis();
  s_lastTouchMs = s_bootMs;
  s_statStart = s_bootMs;
  logHeap("setup done");
}

void loop() {
  uint32_t frameStart = millis();
  uint32_t prev = app.now;
  app.now = frameStart;
  app.dt = prev ? app.now - prev : 16;

  handleSerial();
  setup_pollScan();
  TouchEvent ev;
  if (touch_poll(ev)) handleGesture(ev);
  if (touch_down()) s_lastTouchMs = app.now;

  if (s_portalScreen) {
    portal_loop();
    pal::apply(s_canvas, 256);
    ox = oy = 0;
    drawPortalScreen();
  } else {
    bool first = !app.hasModel;
    if (model_take(app.model, app.modelSeq)) {
      app.hasModel = true;
      app.lastDataChangeMs = app.now;
      app_syncAnim(first);
    }
    app_update();

    uint32_t r0 = micros();
    int bright = transitionStep();
    pal::apply(s_canvas, bright);
    switch (app.mode) {
      case MODE_FOCUS: focus_draw(); break;
      case MODE_PULSE: pulse_draw(); break;
      case MODE_FEED: feed_draw(); break;
      default: throne_draw(); break;
    }
    ox = oy = 0;
    drawNoDataNotice();
    drawRimAlerts();
    drawStatusDot();
    drawModeDots();
    drawDemoTag();
    drawHoldProgress();
    s_renderAccUs += micros() - r0;
  }

  uint32_t p0 = micros();
  s_canvas.pushSprite(&lcd, 0, 0);
  s_pushAccUs += micros() - p0;

  // Backlight: fade in at boot, dim after inactivity, wake on touch or data change.
  uint32_t lastAct = s_lastTouchMs > app.lastDataChangeMs ? s_lastTouchMs : app.lastDataChangeMs;
  int target = (app.now - lastAct > DIM_AFTER_MS && !s_portalScreen) ? BL_DIM : BL_ON;
  if (s_backlight != target) {
    if (s_backlight < target) s_backlight = s_backlight + 8 > target ? target : s_backlight + 8;
    else s_backlight = s_backlight - 2 < target ? target : s_backlight - 2;
    lcd.setBrightness((uint8_t)s_backlight);
  }

  // Stats
  s_frames++;
  s_statFrames++;
  if (app.now - s_lastStatLog >= 30000 || (s_lastStatLog == 0 && app.now - s_bootMs > 5000)) {
    if (s_lastStatLog == 0) printBootSummary();
    printStats();
  }

  // Frame pacing; always yield at least one tick so the network task and idle task run.
  uint32_t spent = millis() - frameStart;
  delay(spent < FRAME_MS ? FRAME_MS - spent : 1);
}
