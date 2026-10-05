// PULSE: health radar. One arc segment per agent around the edge, a rotating sweep with a
// fading trail, and the headline numbers in the middle.
#include <math.h>

#include "../app.h"
#include "../palette.h"
#include "../ui_common.h"

using namespace ui;
using pal::c;

static constexpr uint32_t SWEEP_MS = 4000;
static constexpr int SEG_R0 = 101, SEG_R1 = 111;

static int sweepAngle() { return (ANG_TOP + (int)((app.now % SWEEP_MS) * 1024 / SWEEP_MS)) & 1023; }

void pulse_draw() {
  const Model& m = app.model;
  clear(pal::BLACK);
  fillCircle(CX, CY, 119, pal::BG);
  // Radar grid.
  const uint8_t grid = c(pal::MINT, 2);
  circle(CX, CY, 32, grid);
  circle(CX, CY, 64, grid);
  circle(CX, CY, 96, grid);
  for (int k = 0; k < 8; k++) {
    int x, y;
    polar(96, k * 128, x, y);
    line(CX, CY, x, y, grid);
  }

  // Sweep with a fading trail (max-blend so it never darkens content).
  int sw = sweepAngle();
  for (int k = 0; k < 28; k++) {
    int a = sw - k * 3;
    int lv = 9 - k / 3;
    if (lv < 2) break;
    int x0, y0, x1, y1;
    polar(8, a, x0, y0);
    polar(97, a, x1, y1);
    line(x0, y0, x1, y1, c(pal::MINT, (uint8_t)lv), true);
  }
  int tx, ty;
  polar(97, sw, tx, ty);
  glow(tx, ty, 7, pal::MINT, 12);

  // Agent segments.
  int n = m.nAgents;
  if (n > 0) {
    int span = 1024 / n;
    int gap = span / 8 < 4 ? 4 : span / 8;
    for (int i = 0; i < n; i++) {
      const Agent& a = m.agents[i];
      uint8_t hr = healthRamp(a.health);
      int a0 = ANG_TOP + i * span + gap / 2;
      int a1 = ANG_TOP + (i + 1) * span - gap / 2;
      int mid = (a0 + a1) / 2;
      int since = (sw - mid) & 1023;  // how far the sweep has passed this segment
      int lv = 6;
      if (since < 160) lv += 7 * (160 - since) / 160;
      if (a.health == H_ATTENTION || a.health == H_DOWN) lv = lv > 8 ? lv : 6 + pulse(app.now, 800) * 6 / 1024;
      if (lv > 14) lv = 14;
      arc(CX, CY, SEG_R0, SEG_R1, a0, a1, c(hr, (uint8_t)lv));
      // Tiny state pip inside the segment.
      int px0, py0;
      polar(95, mid, px0, py0);
      uint8_t sr = stateRamp(a.state);
      fillCircle(px0, py0, 1, c(sr, (uint8_t)(a.state == S_IDLE ? 6 : 12)));
    }
  }

  // Headline: healthy / total.
  char buf[32];
  snprintf(buf, sizeof(buf), "%d/%d", m.s.healthy, m.s.agents);
  fillCircle(CX, CY - 14, 40, pal::BG);
  ring(CX, CY - 14, 40, 41, c(pal::MINT, 3));
  text(buf, CX, CY - 20, pal::WHITE, F_HUGE);
  text("HEALTHY", CX, CY + 8, c(pal::GREEN, 11), F_TINY);

  struct Row {
    int value;
    const char* label;
    uint8_t ramp;
    bool alert;
  } rows[4] = {
      {m.s.working, "working", pal::CYAN, false},
      {m.s.tasksInProgress, "in progress", pal::AZURE, false},
      {m.s.tasksOverdue, "overdue", pal::RED, m.s.tasksOverdue > 0},
      {m.s.pendingApprovals, "approvals", pal::GOLD, m.s.pendingApprovals > 0},
  };
  // Two columns of two, below the headline.
  for (int r = 0; r < 4; r++) {
    int col = r & 1, row = r >> 1;
    int x = CX + (col ? 34 : -34);
    int y = 158 + row * 27;
    const Row& rw = rows[r];
    bool dimmed = rw.value == 0 && (r >= 2);
    uint8_t vc = dimmed ? pal::TEXT_FAINT : c(rw.ramp, rw.alert ? (uint8_t)(10 + pulse(app.now, 900) * 4 / 1024) : 12);
    snprintf(buf, sizeof(buf), "%d", rw.value);
    text(buf, x, y, vc, F_MED);
    text(rw.label, x, y + 13, dimmed ? pal::TEXT_FAINT : pal::TEXT_DIM, F_TINY);
  }
  if (m.s.attention > 0 || m.s.down > 0) {
    snprintf(buf, sizeof(buf), "%d attention  %d down", m.s.attention, m.s.down);
    text(buf, CX, 54, c(m.s.down ? pal::RED : pal::ORANGE, 11), F_TINY);
  }
}

bool pulse_tap(int x, int y) {
  int n = app.model.nAgents;
  if (n <= 0) return false;
  int dx = x - CX, dy = y - CY;
  if (dx * dx + dy * dy < 80 * 80) return false;  // only the ring is tappable
  float ang = atan2f((float)dy, (float)dx);  // radians, clockwise on screen
  int a = (int)lroundf(ang * 1024.0f / (2.0f * (float)M_PI));
  int rel = (a - ANG_TOP) & 1023;
  int idx = rel * n / 1024;
  if (idx < 0 || idx >= n) return false;
  app.focus = (uint8_t)idx;
  return true;
}
