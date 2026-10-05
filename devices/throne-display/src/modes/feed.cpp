// FEED: latest messages as chat bubbles stacked from the bottom of the circle.
// A new message slides in from below and pushes older ones up.
#include "../app.h"
#include "../palette.h"
#include "../sprites.h"
#include "../ui_common.h"

using namespace ui;
using pal::c;

static constexpr int BOTTOM = 204;  // bottom edge of the newest bubble
static constexpr int LINE_H = 15;
static constexpr int MAX_LINES = 3;
static constexpr uint32_t SLIDE_MS = 450;

struct BubbleLayout {
  int h;
  int lines;
  uint16_t st[MAX_LINES];
  uint8_t ln[MAX_LINES];
  int textW;
};

static int bubbleWidthAt(int yTop, int yBot) {
  // Usable width = narrowest chord across the bubble's vertical extent.
  int a = chordHalf(yTop, 10), b = chordHalf(yBot, 10);
  int hw = a < b ? a : b;
  return hw * 2;
}

static void layoutBubble(const Message& msg, int yBottom, BubbleLayout& L) {
  // Estimate with two lines, then wrap against the chord available at that height.
  int estH = 16 + 2 * LINE_H + 6;
  int avail = bubbleWidthAt(yBottom - estH, yBottom) - 34;  // minus avatar column
  if (avail > 168) avail = 168;
  if (avail < 60) avail = 60;
  L.textW = avail - 12;
  L.lines = wrapText(msg.text, L.textW, F_SMALL, L.st, L.ln, MAX_LINES);
  if (L.lines == 0) L.lines = 1, L.st[0] = 0, L.ln[0] = 0;
  L.h = 16 + L.lines * LINE_H + 5;
}

static void drawBubble(const Message& msg, int yBottom, const BubbleLayout& L, int idx) {
  int yTop = yBottom - L.h;
  if (yBottom < 18 || yTop > 222) return;
  int agent = msg.agentHash ? app_agentByHash(msg.agentHash) : -1;
  uint8_t ramp = agent >= 0 ? app.anim[agent].ramp : pal::GOLD;
  int bw = L.textW + 12;
  int total = 28 + bw;
  int x0 = CX - total / 2;
  int bx = x0 + 28;
  // Avatar
  if (agent >= 0) {
    const Agent& a = app.model.agents[agent];
    bool ghost = a.health == H_DOWN || a.state == S_OFFLINE;
    int frame = (app.now / 500 + idx) & 1;
    drawCharacter(app.anim[agent].spr, frame, x0 + 12, yTop + 12, 2, ramp, ghost ? CF_GHOST : CF_NONE, app.now);
  } else {
    drawCrown(x0 + 12, yTop + 10, 2);
  }
  // Bubble body with a tail pointing at the avatar.
  fillRoundRect(bx, yTop, bw, L.h - 1, 7, c(ramp, 2));
  for (int t = 0; t < 4; t++) hline(bx - 4 + t, bx, yTop + 8 + t, c(ramp, 2));
  hline(bx + 6, bx + bw - 7, yTop, c(ramp, 5));
  // Header: name + age
  text(msg.from, bx + 7, yTop + 8, c(ramp, 12), F_TINY, lgfx::middle_left);
  char age[16];
  int32_t s = msg.ageSec + app_snapshotAgeSec();
  if (s < 60) snprintf(age, sizeof(age), "%lds", (long)s);
  else if (s < 3600) snprintf(age, sizeof(age), "%ldm", (long)(s / 60));
  else snprintf(age, sizeof(age), "%ldh", (long)(s / 3600));
  text(age, bx + bw - 7, yTop + 8, pal::TEXT_FAINT, F_TINY, lgfx::middle_right);
  // Body
  char buf[128];
  for (int l = 0; l < L.lines; l++) {
    int n = L.ln[l] < sizeof(buf) - 4 ? L.ln[l] : sizeof(buf) - 4;
    memcpy(buf, msg.text + L.st[l], n);
    buf[n] = 0;
    bool truncated = l == L.lines - 1 && L.st[l] + L.ln[l] < (int)strlen(msg.text);
    if (truncated) {
      textFit(buf, bx + 6, yTop + 16 + l * LINE_H + LINE_H / 2, L.textW - 6, pal::TEXT, F_SMALL, lgfx::middle_left);
      text("...", bx + bw - 6, yTop + 16 + l * LINE_H + LINE_H / 2, pal::TEXT_DIM, F_SMALL, lgfx::middle_right);
    } else {
      text(buf, bx + 6, yTop + 16 + l * LINE_H + LINE_H / 2, pal::TEXT, F_SMALL, lgfx::middle_left);
    }
  }
}

void feed_draw() {
  const Model& m = app.model;
  clear(pal::BLACK);
  fillCircle(CX, CY, 119, pal::BG);
  // Soft vertical gradient bands for depth.
  for (int y = 150; y < 240; y += 2) {
    int hw = chordHalf(y, 1);
    if (hw) hline(CX - hw, CX + hw, y, c(pal::NEUTRAL, 2));
  }
  const char* title = m.company[0] ? m.company : "Team feed";
  if (m.nMsgs == 0) {
    arcText(title, 103, ANG_TOP, c(pal::GOLD, 11), F_MED, true);
    text("No messages yet", CX, CY, pal::TEXT_DIM, F_SMALL);
    return;
  }

  // Detect a new newest message -> slide-in.
  uint32_t newest = m.msgs[m.nMsgs - 1].idHash;
  if (newest != app.feedNewestHash) {
    if (app.feedNewestHash != 0) app.feedSlideStart = app.now;
    app.feedNewestHash = newest;
  }
  BubbleLayout L;
  int y = BOTTOM;
  int slide = 0;
  bool sliding = app.now - app.feedSlideStart < SLIDE_MS;
  layoutBubble(m.msgs[m.nMsgs - 1], y, L);
  if (sliding) {
    int t = (int)((app.now - app.feedSlideStart) * 1024 / SLIDE_MS);
    slide = (1024 - easeOutCubic(t)) * (L.h + 6) / 1024;
  }
  y += slide;
  for (int i = m.nMsgs - 1; i >= 0; i--) {
    if (i != m.nMsgs - 1) layoutBubble(m.msgs[i], y, L);
    drawBubble(m.msgs[i], y, L, i);
    y -= L.h + 6;
    if (y < 20) break;
  }
  // Fade the top edge into the title.
  for (int yy = 30; yy < 40; yy++) {
    int hw = chordHalf(yy, 1);
    if ((yy & 1) == 0) hline(CX - hw, CX + hw, yy, pal::BG);
  }
  fillRect(0, 0, W, 30, pal::BG);
  arcText(title, 103, ANG_TOP, c(pal::GOLD, 11), F_MED, true);
}
