#include "touch.h"

#include <Wire.h>

#include "display_config.h"

// Optional orientation fixes if a board revision reports mirrored coordinates.
#ifndef TOUCH_SWAP_XY
#define TOUCH_SWAP_XY 0
#endif
#ifndef TOUCH_INVERT_X
#define TOUCH_INVERT_X 0
#endif
#ifndef TOUCH_INVERT_Y
#define TOUCH_INVERT_Y 0
#endif

bool g_touchDebug = false;

static volatile bool s_irq = false;
static bool s_down = false;
static bool s_holdFired = false;
static bool s_moved = false;
static int16_t s_x = 0, s_y = 0, s_sx = 0, s_sy = 0;
static uint32_t s_downMs = 0, s_lastPollMs = 0, s_lastSeenMs = 0;
static bool s_ok = false;

static void IRAM_ATTR onTouchIrq() { s_irq = true; }

static bool writeReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(pins::TOUCH_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

void touch_init() {
  pinMode(pins::TOUCH_RST, OUTPUT);
  digitalWrite(pins::TOUCH_RST, LOW);
  delay(10);
  digitalWrite(pins::TOUCH_RST, HIGH);
  delay(60);
  Wire.begin(pins::TOUCH_SDA, pins::TOUCH_SCL, 400000);
  Wire.setTimeOut(20);
  pinMode(pins::TOUCH_INT, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(pins::TOUCH_INT), onTouchIrq, FALLING);
  // 0xFE DisAutoSleep = 1 keeps the controller answering on I2C.
  // 0xFA IrqCtl = EnTouch | EnChange so INT pulses on every report.
  bool a = writeReg(0xFE, 0x01);
  bool b = writeReg(0xFA, 0x60);
  Wire.beginTransmission(pins::TOUCH_ADDR);
  Wire.write(0xA7);  // ChipID
  Wire.endTransmission(false);
  uint8_t id = 0;
  if (Wire.requestFrom((int)pins::TOUCH_ADDR, 1) == 1) id = Wire.read();
  s_ok = a || b || id;
  Serial.printf("[touch] CST816 init %s (chip id 0x%02X)\n", s_ok ? "ok" : "NO RESPONSE", id);
}

static bool readPoint(uint8_t& fingers, int16_t& x, int16_t& y) {
  Wire.beginTransmission(pins::TOUCH_ADDR);
  Wire.write(0x02);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)pins::TOUCH_ADDR, 5) != 5) return false;
  uint8_t d[5];
  for (int i = 0; i < 5; i++) d[i] = Wire.read();
  fingers = d[0] & 0x0F;
  int rx = ((d[1] & 0x0F) << 8) | d[2];
  int ry = ((d[3] & 0x0F) << 8) | d[4];
#if TOUCH_SWAP_XY
  int t = rx;
  rx = ry;
  ry = t;
#endif
#if TOUCH_INVERT_X
  rx = 239 - rx;
#endif
#if TOUCH_INVERT_Y
  ry = 239 - ry;
#endif
  x = (int16_t)constrain(rx, 0, 239);
  y = (int16_t)constrain(ry, 0, 239);
  return true;
}

bool touch_down() { return s_down; }
int touch_x() { return s_x; }
int touch_y() { return s_y; }
uint32_t touch_holdMs() { return (s_down && !s_moved && !s_holdFired) ? millis() - s_downMs : 0; }

bool touch_poll(TouchEvent& ev) {
  ev.type = G_NONE;
  uint32_t now = millis();
  // Poll on interrupt, while a finger is down, and as a slow fallback.
  bool want = s_irq || s_down || (now - s_lastPollMs > 60);
  if (!want) return false;
  s_irq = false;
  s_lastPollMs = now;
  uint8_t fingers = 0;
  int16_t x = 0, y = 0;
  bool got = readPoint(fingers, x, y);
  if (got && fingers > 0) {
    s_lastSeenMs = now;
    if (!s_down) {
      s_down = true;
      s_moved = false;
      s_holdFired = false;
      s_sx = x;
      s_sy = y;
      s_downMs = now;
      if (g_touchDebug) Serial.printf("[touch] down %d,%d\n", x, y);
    }
    s_x = x;
    s_y = y;
    if (abs(x - s_sx) > 14 || abs(y - s_sy) > 14) s_moved = true;
    if (!s_moved && !s_holdFired && now - s_downMs >= 5000) {
      s_holdFired = true;
      ev = {G_HOLD_5S, x, y};
      return true;
    }
    return false;
  }
  // No finger reported (or read failed). Treat a failed read as release only after a gap,
  // so a single I2C hiccup does not end a long press.
  if (!s_down) return false;
  if (!got && now - s_lastSeenMs < 150) return false;
  s_down = false;
  uint32_t dur = now - s_downMs;
  int dx = s_x - s_sx, dy = s_y - s_sy;
  if (g_touchDebug) Serial.printf("[touch] up %d,%d dx=%d dy=%d %ums\n", s_x, s_y, dx, dy, (unsigned)dur);
  if (s_holdFired) return false;
  int adx = abs(dx), ady = abs(dy);
  if (adx >= 36 || ady >= 36) {
    if (adx > ady) ev.type = dx < 0 ? G_SWIPE_LEFT : G_SWIPE_RIGHT;
    else ev.type = dy < 0 ? G_SWIPE_UP : G_SWIPE_DOWN;
  } else if (!s_moved && dur >= 1500) {
    ev.type = G_HOLD_2S;
  } else if (dur < 600) {
    ev.type = G_TAP;
  }
  ev.x = s_sx;
  ev.y = s_sy;
  return ev.type != G_NONE;
}
