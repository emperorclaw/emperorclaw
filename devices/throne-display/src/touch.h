// CST816D capacitive touch driver + software gesture recognizer.
// Gestures are derived from raw points (more consistent than the chip's
// built-in gesture codes, which vary between CST816 firmware revisions).
#pragma once
#include <Arduino.h>

enum GestureType : uint8_t {
  G_NONE = 0,
  G_TAP,
  G_SWIPE_LEFT,   // finger moved right -> left
  G_SWIPE_RIGHT,  // finger moved left -> right
  G_SWIPE_UP,
  G_SWIPE_DOWN,
  G_HOLD_2S,  // released after 1.5..5 s without moving: toggle demo / live
  G_HOLD_5S,  // still held at 5 s: open setup portal (fires while held)
};

struct TouchEvent {
  GestureType type;
  int16_t x, y;
};

void touch_init();
// Poll the controller (call once per frame). Returns true when a gesture completed.
bool touch_poll(TouchEvent& ev);
bool touch_down();
uint32_t touch_holdMs();  // ms the current stationary press has lasted (0 if moving / up)
int touch_x();
int touch_y();
extern bool g_touchDebug;
