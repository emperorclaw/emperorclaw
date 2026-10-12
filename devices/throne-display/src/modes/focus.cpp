// FOCUS: one agent per page. Swipe up / down to cycle agents. Tap to open the
// agent's private chat (the token creator's own direct messages, when the token
// carries them); tap again, or swipe left / right, to close it. When the agent has a
// fresh thought (feed v2), it types out in a cloud under the character instead of
// the activity line.
#include "../app.h"
#include "../palette.h"
#include "../ui_common.h"

using namespace ui;
using pal::c;

void focus_step(int dir) {
  int n = app.model.nAgents;
  if (n <= 0) return;
  app.focus = (uint8_t)((app.focus + n + dir) % n);
  app.focusChangeMs = app.now;
  app.focusDir = (int8_t)dir;
  app.chatOpen = false;
}

void focus_openChat(bool open) {
  app.chatOpen = open;
  app.chatScroll = 0;
  app.chatOpenMs = app.now;
}

void focus_scrollChat(int dir) {
  if (!app.chatOpen || app.model.nAgents == 0) return;
  const Agent& a = app.model.agents[app.focus % app.model.nAgents];
  int s = (int)app.chatScroll + dir;
  if (s < 0) s = 0;
  if (s > (int)a.dmCount - 1) s = a.dmCount ? a.dmCount - 1 : 0;
  app.chatScroll = (uint8_t)s;
}

// ---------------------------------------------------------------- private chat

static constexpr int CHAT_TOP = 50, CHAT_BOTTOM = 204, BUBBLE_PAD = 4, LINE_H = 10, AGE_H = 10;

// Half-width of the circle usable for a bubble spanning rows y0..y1.
static int chatHalf(int y0, int y1) {
  int a = chordHalf(y0, 10), b = chordHalf(y1, 10);
  int h = a < b ? a : b;
  return h > 80 ? 80 : h;
}

static void drawChat(const Agent& a, const AgentAnim& an) {
  // Header: padlock + whose chat this is.
  char title[40], label[16];
  app_label(a, label, sizeof(label), true);
  snprintf(title, sizeof(title), "Private: %s", label);
  int tw = textWidth(title, F_SMALL);
  drawLock(CX - tw / 2 - 9, 31, c(pal::GOLD, 13));
  text(title, CX + 6, 31, c(an.ramp, 13), F_SMALL);
  int hw = chordHalf(43, 30);
  hline(CX - hw, CX + hw, 43, c(pal::NEUTRAL, 4));

  if (a.dmCount == 0) {
    text("No private messages", CX, 112, pal::TEXT_DIM, F_SMALL);
    text("Your direct chats with", CX, 136, pal::TEXT_FAINT, F_TINY);
    text("this agent show up here", CX, 147, pal::TEXT_FAINT, F_TINY);
    text("tap to go back", CX, 186, pal::TEXT_FAINT, F_TINY);
    return;
  }

  const DmMsg* msgs = &app.model.dm[a.dmStart];
  bool safe = app_camSafe();
  int32_t snapAge = app_snapshotAgeSec();
  int y = CHAT_BOTTOM;
  int first = app.chatScroll < a.dmCount ? app.chatScroll : 0;
  int shown = 0;
  uint16_t st[8];
  uint8_t ln[8];
  char buf[DM_TEXT];
  for (int i = first; i < a.dmCount; i++) {
    const DmMsg& msg = msgs[i];
    // Wrap for the narrower of the rows the bubble may cover, then re-check once.
    int half = chatHalf(y - 60, y);
    int lines = wrapText(msg.text, half * 2 - 26 - 2 * BUBBLE_PAD, F_TINY, st, ln, 8);
    int h = lines * LINE_H + 2 * BUBBLE_PAD - 2;
    int top = y - AGE_H - h;
    int realHalf = chatHalf(top, y);
    if (realHalf < half) {
      half = realHalf;
      lines = wrapText(msg.text, half * 2 - 26 - 2 * BUBBLE_PAD, F_TINY, st, ln, 8);
      h = lines * LINE_H + 2 * BUBBLE_PAD - 2;
      top = y - AGE_H - h;
    }
    if (top < CHAT_TOP && shown > 0) break;  // older messages are scrolled out above
    int widest = 0;
    for (int l = 0; l < lines; l++) {
      int n = ln[l] < sizeof(buf) - 1 ? ln[l] : sizeof(buf) - 1;
      memcpy(buf, msg.text + st[l], n);
      buf[n] = 0;
      int w = textWidth(buf, F_TINY);
      if (w > widest) widest = w;
    }
    int bw = widest + 2 * BUBBLE_PAD + 2;
    int bx = msg.me ? CX + half - bw : CX - half;
    uint8_t fill = msg.me ? c(pal::GOLD, 5) : c(an.ramp, 4);
    uint8_t ink = msg.me ? c(pal::GOLD, 15) : pal::WHITE;
    fillRoundRect(bx, top, bw, h, 5, fill);
    // A small tail on the speaker's side.
    int tx = msg.me ? bx + bw - 4 : bx + 3;
    fillRect(tx, top + h - 3, 2, 3, fill);
    for (int l = 0; l < lines; l++) {
      int n = ln[l] < sizeof(buf) - 1 ? ln[l] : sizeof(buf) - 1;
      memcpy(buf, msg.text + st[l], n);
      buf[n] = 0;
      textS(buf, bx + BUBBLE_PAD + 1, top + BUBBLE_PAD + l * LINE_H + 3, ink, F_TINY, lgfx::middle_left, safe);
    }
    char ago[24];
    fmtAgo(ago, sizeof(ago), msg.ageSec + snapAge);
    text(ago, msg.me ? bx + bw - 2 : bx + 2, top + h + 5, pal::TEXT_FAINT, F_TINY,
         msg.me ? lgfx::middle_right : lgfx::middle_left);
    y = top - 3;
    shown++;
    if (i == a.dmCount - 1) y = -1;  // everything shown
  }
  // Scroll hints: older messages above, newer ones below.
  if (y >= 0 && first + shown < a.dmCount) text("^ older", CX, CHAT_TOP - 2, pal::TEXT_FAINT, F_TINY);
  if (first > 0) text("v newer", CX, CHAT_BOTTOM + 8, c(pal::GOLD, 10), F_TINY);
}

void focus_draw() {
  const Model& m = app.model;
  clear(pal::BLACK);
  fillCircle(CX, CY, 119, pal::BG);
  if (m.nAgents == 0) return;
  int idx = app.focus % m.nAgents;
  const Agent& a = m.agents[idx];
  const AgentAnim& an = app.anim[idx];
  uint8_t hr = healthRamp(a.health);
  uint8_t sr = stateRamp(a.state);

  // Outer health ring + progress / pulse ring based on time in the current state.
  int p = pulse(app.now, a.health == H_HEALTHY ? 2400 : 900);
  ring(CX, CY, 113, 118, c(hr, 3));
  uint32_t inState = app.now - an.stateSince;
  int prog = (int)((inState % 60000UL) * 1024UL / 60000UL);
  arc(CX, CY, 113, 118, ANG_TOP, ANG_TOP + prog, c(hr, (uint8_t)(8 + p * 3 / 1024)));
  int hx, hy;
  polar(115, ANG_TOP + prog, hx, hy);
  glow(hx, hy, 9, hr, 12);
  fillCircle(hx, hy, 2, c(hr, 15));

  if (app.chatOpen) {
    // Fade-in slide from below when the chat opens.
    int k = app.now - app.chatOpenMs < 220 ? easeOutCubic((int)((app.now - app.chatOpenMs) * 1024 / 220)) : 1024;
    oy += (1024 - k) * 24 / 1024;
    drawChat(a, an);
    oy -= (1024 - k) * 24 / 1024;
    return;
  }

  // Page slide when cycling agents.
  int slide = 0;
  if (app.now - app.focusChangeMs < 320) {
    int t = (int)((app.now - app.focusChangeMs) * 1024 / 320);
    slide = (1024 - easeOutCubic(t)) * 50 / 1024 * app.focusDir;
  }
  oy += slide;

  // Name along the top arc (initials when camera-safe).
  bool safe = app_camSafe();
  char name[28];
  app_label(a, name, sizeof(name), false);
  arcText(name, 101, ANG_TOP, c(an.ramp, 13), F_MED, true);
  if (app_hasRecentDm(a)) drawDmBadge(CX + 38, 50);

  // Big character acting out its current act, with a soft halo.
  glow(CX, 70, 40, an.ramp, 4 + p / 512);
  bool ghost = an.act == ACT_OFFLINE;
  actor_draw(idx, CX, ghost ? 98 : 102, 3, false);

  // State chip.
  const char* sl = stateLabel(a.state);
  int tw = textWidth(sl, F_TINY);
  int cw = tw + 18;
  fillRoundRect(CX - cw / 2, 106, cw, 13, 6, c(sr, 4));
  fillCircle(CX - cw / 2 + 7, 112, 2, c(sr, 13));
  text(sl, CX + 4, 113, c(sr, 15), F_TINY);

  // Thought (typed out in a cloud) or activity, word-wrapped; long texts scroll line by line.
  const Thought* th = ghost ? nullptr : model_thought(m, a);
  const char* act = th ? th->text : (a.activity[0] ? a.activity : (ghost ? "Not responding" : "No current activity"));
  uint16_t st[12];
  uint8_t ln[12];
  int lines = wrapText(act, th ? 164 : 172, F_SMALL, st, ln, 12);
  const int lineH = 16, top = 124, visible = 3;
  int first = 0, sub = 0;
  static uint32_t s_thoughtHash = 0, s_thoughtStart = 0;
  int typed = 1 << 14;
  if (th) {
    uint32_t h = fnv1a(th->text) ^ a.idHash;
    if (h != s_thoughtHash) {
      s_thoughtHash = h;
      s_thoughtStart = app.now;
    }
    uint32_t elapsed = app.now - s_thoughtStart;
    if (elapsed > 60000) elapsed = 60000;  // fully typed long before; avoids overflow
    typed = (int)(elapsed * 30 / 1000);
    // Cloud behind the text, with two puffs rising from the character.
    fillCircle(CX + 22, 116, 2, c(an.ramp, 3));
    fillCircle(CX + 30, 121, 3, c(an.ramp, 3));
    fillRoundRect(CX - 88, top - 2, 176, visible * lineH + 6, 10, c(an.ramp, 3));
  }
  if (th && typed < (int)strlen(act)) {
    // Still typing: keep the line being typed in view.
    int last = 0;
    for (int l = 0; l < lines; l++)
      if (st[l] < typed) last = l;
    first = last - (visible - 1);
    if (first < 0) first = 0;
  } else if (lines > visible) {
    uint32_t period = 2200;
    uint32_t cyc = app.now % (period * (lines - visible + 2));
    int step = (int)(cyc / period);
    if (step > lines - visible) step = lines - visible;
    int t = (int)((cyc % period) * 1024 / period);
    first = step;
    if (step < lines - visible && t > 800) sub = easeInOutCubic((t - 800) * 1024 / 224) * lineH / 1024;
  }
  char buf[100];
  for (int l = 0; l < visible + 1 && first + l < lines; l++) {
    int y = top + l * lineH - sub;
    if (y < top - lineH / 2 || y > top + (visible - 1) * lineH + lineH / 2) continue;
    int li = first + l;
    int n = ln[li] < sizeof(buf) - 1 ? ln[li] : sizeof(buf) - 1;
    if (st[li] + n > typed) n = typed - st[li];
    if (n <= 0) break;
    memcpy(buf, act + st[li], n);
    buf[n] = 0;
    bool real = th || a.activity[0];
    if (th) textS(buf, CX - 80, y + lineH / 2, pal::WHITE, F_SMALL, lgfx::middle_left, safe);
    else textS(buf, CX, y + lineH / 2, real ? pal::TEXT : pal::TEXT_DIM, F_SMALL, lgfx::middle_center, safe && real);
  }

  // Task title.
  if (a.task[0]) {
    fillRect(CX - 76, 176, 3, 12, c(pal::GOLD, 9));
    textFitS(a.task, CX - 69, 182, 146, c(pal::GOLD, 12), F_SMALL, lgfx::middle_left, safe);
  } else {
    text("no active task", CX, 182, pal::TEXT_FAINT, F_SMALL);
  }

  // Last seen + unanswered.
  char ago[40];
  // The server's ETag ignores lastSeenSec, so after a 304 the value is aged
  // locally from the last 200 like every other clock.
  int32_t ls = a.lastSeenSec < 0 ? -1 : a.lastSeenSec + app_snapshotAgeSec();
  fmtAgo(ago, sizeof(ago), ls);
  char line[64];
  snprintf(line, sizeof(line), "seen %s  -  %s", ago, healthLabel(a.health));
  text(line, CX, 200, c(hr, 10), F_TINY);
  if (a.unanswered > 0) {
    snprintf(line, sizeof(line), "%u unanswered", a.unanswered);
    text(line, CX, 211, c(pal::RED, 12), F_TINY);
  }
  oy -= slide;

  // Page indicator.
  snprintf(line, sizeof(line), "%d/%d", idx + 1, m.nAgents);
  text(line, CX, 37, pal::TEXT_FAINT, F_TINY);
}
