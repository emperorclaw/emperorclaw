#include "moments.h"

#include "app.h"
#include "palette.h"
#include "ui_common.h"

using namespace ui;
using pal::c;

namespace {

constexpr int SEEN = 32;           // ring of recently played event ids
constexpr int QUEUE = 8;           // events waiting for their turn
constexpr int ACTIVE = 4;          // moments playing at once
constexpr int PLANES = 3;
constexpr uint32_t PLANE_MS = 1800;
constexpr uint32_t SPACING_MS = 1300;   // gap between two queued moments
constexpr uint32_t REKNOCK_MS = 45000;  // remind about a pending need this often
constexpr int32_t FIRST_MAX_AGE = 60;   // first snapshot: only events younger than this
constexpr int32_t MAX_AGE = 300;        // never replay anything older

uint32_t s_seen[SEEN];
uint8_t s_seenPos = 0;
bool s_primed = false;
bool s_lastDemo = false;

Event s_queue[QUEUE];
uint8_t s_qHead = 0, s_qCount = 0;
uint32_t s_nextStart = 0;

Moment s_active[ACTIVE];
uint32_t s_serial = 0;

struct Plane {
  uint32_t aHash, bHash, start;
  bool on;
};
Plane s_planes[PLANES];

uint32_t s_crownMs = 0;
uint32_t s_lastKnock = 0;
uint32_t s_emperorKnockMs = 0;  // a need with no agent: the Emperor knocks

struct Toast {
  uint8_t type;
  uint32_t start;
  uint32_t agentHash;
  char title[TITLE_TEXT];
};
Toast s_toast;

struct Card {
  bool open;
  int8_t need;  // index into model.needs, -1 = generic pending approvals
  uint32_t openedMs;
  uint32_t next;
};
Card s_card;

Bubble s_tb;  // throne room bubble
uint32_t s_nextBubble = 0;
uint8_t s_rr = 0;

bool seen(uint32_t h) {
  for (uint32_t v : s_seen)
    if (v == h) return true;
  return false;
}

void markSeen(uint32_t h) {
  s_seen[s_seenPos] = h;
  s_seenPos = (uint8_t)((s_seenPos + 1) % SEEN);
}

void resetAll() {
  memset(s_seen, 0, sizeof(s_seen));
  s_qCount = s_qHead = 0;
  memset(s_active, 0, sizeof(s_active));
  memset(s_planes, 0, sizeof(s_planes));
  s_card.open = false;
  s_toast.start = 0;
  s_tb.on = false;
  s_primed = false;
}

// Where agent i is drawn in the throne room, in world coordinates.
void anchor(int i, int& x, int& headY, int& footY) {
  int scale;
  actor_anchor(i, x, footY, scale);
  headY = footY - 18 * scale;
}

void startMoment(const Event& e) {
  int a = e.aHash ? app_agentByHash(e.aHash) : -1;
  if (a < 0 && e.type == EV_NEEDS_YOU && !e.aHash) {
    // No requesting agent: the Emperor knocks on the glass.
    Moment* mo = &s_active[0];
    for (auto& m : s_active)
      if (m.start < mo->start) mo = &m;
    memset(mo, 0, sizeof(*mo));
    mo->type = e.type;
    mo->start = app.now ? app.now : 1;
    mo->serial = ++s_serial;
    mo->dur = 4800;
    strlcpy(mo->title, e.title, sizeof(mo->title));
    s_emperorKnockMs = app.now;
    s_lastKnock = app.now;
    s_toast.type = e.type;
    s_toast.start = app.now;
    s_toast.agentHash = 0;
    strlcpy(s_toast.title, e.title, sizeof(s_toast.title));
    return;
  }
  if (a < 0) return;
  int b = e.bHash ? app_agentByHash(e.bHash) : -1;
  if (e.type == EV_HANDOFF && (b < 0 || b == a)) return;
  // Reuse the oldest slot.
  Moment* mo = &s_active[0];
  for (auto& m : s_active)
    if (m.start < mo->start) mo = &m;
  memset(mo, 0, sizeof(*mo));
  mo->type = e.type;
  mo->aHash = e.aHash;
  mo->bHash = e.bHash;
  mo->start = app.now ? app.now : 1;
  mo->serial = ++s_serial;
  strlcpy(mo->title, e.title, sizeof(mo->title));
  AgentAnim& an = app.anim[a];
  int x, headY, footY;
  anchor(a, x, headY, footY);
  bool toast = false;
  switch (e.type) {
    case EV_HANDOFF: {
      Plane* p = &s_planes[0];
      for (auto& q : s_planes)
        if (!q.on || q.start < p->start) p = &q;
      p->aHash = e.aHash;
      p->bHash = e.bHash;
      p->start = app.now;
      p->on = true;
      an.throwUntil = app.now + 450;
      mo->dur = PLANE_MS + 600;
      break;
    }
    case EV_TASK_DONE:
      spawnConfetti(x, headY, 28);
      an.celebrateUntil = app.now + 2800;
      s_crownMs = app.now;
      mo->dur = 3000;
      toast = true;
      break;
    case EV_NEEDS_YOU:
      an.knockUntil = app.now + 5600;
      s_lastKnock = app.now;
      mo->dur = 5600;
      toast = true;
      break;
    case EV_BLOCKED:
      an.blockedUntil = app.now + 4000;
      mo->dur = 3400;
      toast = true;
      break;
    default: return;
  }
  if (toast) {
    s_toast.type = e.type;
    s_toast.start = app.now;
    s_toast.agentHash = e.aHash;
    strlcpy(s_toast.title, e.title, sizeof(s_toast.title));
  }
}

// Quadratic Bezier arc from p0 to p2, bulging upward. t in 0..1024.
void arcPoint(int x0, int y0, int x2, int y2, int t, int& x, int& y) {
  int x1 = (x0 + x2) / 2;
  int y1 = (y0 < y2 ? y0 : y2) - 30 - abs(x2 - x0) / 4;
  int32_t u = 1024 - t;
  x = (int)((u * u * x0 + 2 * u * t * x1 + (int32_t)t * t * x2) >> 20);
  y = (int)((u * u * y0 + 2 * u * t * y1 + (int32_t)t * t * y2) >> 20);
}

void drawPlane(int x, int y, bool left, int tilt, int s) {
  // Paper plane pointing right: '#' paper, 'g' fold.
  static const char* const kPlane[5] = {"##......", ".####...", "..######", ".##g....", "#g......"};
  for (int r = 0; r < 5; r++)
    for (int col = 0; col < 8; col++) {
      char ch = kPlane[r][col];
      if (ch == '.') continue;
      int cx = left ? 7 - col : col;
      int dy = (col - 4) * tilt / 4;
      if (left) dy = -dy;
      uint8_t color = ch == '#' ? pal::WHITE : c(pal::NEUTRAL, 9);
      fillRect(x + (cx - 4) * s, y + (r - 2 + dy) * s, s, s, color);
    }
}

}  // namespace

// ---------------------------------------------------------------- sync / update

void moments_sync(bool firstSync) {
  (void)firstSync;
  const Model& m = app.model;
  if (m.demo != s_lastDemo) {
    resetAll();
    s_lastDemo = m.demo;
  }
  if (m.version < 2) return;
  int32_t snap = app_snapshotAgeSec();
  for (int i = m.nEvents - 1; i >= 0; i--) {  // oldest first
    const Event& e = m.events[i];
    if (!e.idHash || seen(e.idHash)) continue;
    markSeen(e.idHash);
    int32_t age = e.ageSec + snap;
    if (age > (s_primed ? MAX_AGE : FIRST_MAX_AGE)) continue;
    if (s_qCount >= QUEUE) {  // drop the oldest waiting one
      s_qHead = (uint8_t)((s_qHead + 1) % QUEUE);
      s_qCount--;
    }
    s_queue[(s_qHead + s_qCount) % QUEUE] = e;
    s_qCount++;
  }
  s_primed = true;
  // The card closes by itself once its need was answered.
  if (s_card.open && s_card.need >= 0 && s_card.need >= m.nNeeds) s_card.open = false;
}

void moments_update() {
  const Model& m = app.model;
  if (s_qCount && (int32_t)(app.now - s_nextStart) >= 0) {
    Event e = s_queue[s_qHead];
    s_qHead = (uint8_t)((s_qHead + 1) % QUEUE);
    s_qCount--;
    startMoment(e);
    s_nextStart = app.now + SPACING_MS;
  }
  // Planes land: the recipient lights up.
  for (auto& p : s_planes) {
    if (!p.on || app.now - p.start < PLANE_MS) continue;
    p.on = false;
    int b = app_agentByHash(p.bHash);
    if (b >= 0) {
      app.anim[b].receiveUntil = app.now + 1600;
      int x, headY, footY;
      anchor(b, x, headY, footY);
      spawnConfetti(x, headY - 4, 8);
    }
  }
  // A need that is still pending gets a reminder knock now and then.
  if (m.nNeeds > 0 && app.now - s_lastKnock > REKNOCK_MS) {
    s_lastKnock = app.now;
    int a = m.needs[0].agentHash ? app_agentByHash(m.needs[0].agentHash) : -1;
    if (a >= 0) app.anim[a].knockUntil = app.now + 5600;
    else s_emperorKnockMs = app.now;
  }
  if (s_card.open && app.now - s_card.openedMs > 6000) s_card.open = false;

  // Throne Room thought bubble: fresh thoughts first, then round-robin.
  if (app.mode == MODE_THRONE && !s_tb.on && (int32_t)(app.now - s_nextBubble) >= 0) {
    int pick = -1;
    for (int i = 0; i < m.nAgents && pick < 0; i++) {
      const Thought* t = model_thought(m, m.agents[i]);
      if (t && app.anim[i].act != ACT_OFFLINE && fnv1a(t->text) != app.anim[i].shownThought) pick = i;
    }
    for (int k = 0; k < m.nAgents && pick < 0; k++) {
      int i = (s_rr + k) % m.nAgents;
      if (model_thought(m, m.agents[i]) && app.anim[i].act != ACT_OFFLINE) pick = i;
    }
    if (pick >= 0) {
      const Thought* t = model_thought(m, m.agents[pick]);
      bubble_start(s_tb, m.agents[pick].idHash, t->text);
      app.anim[pick].shownThought = s_tb.textHash;
      s_rr = (uint8_t)(pick + 1);
    } else {
      s_nextBubble = app.now + 1000;
    }
  }
}

const Moment* moments_current() {
  const Moment* best = nullptr;
  for (const auto& m : s_active) {
    if (!m.start || app.now - m.start >= m.dur) continue;
    if (!best || m.serial > best->serial) best = &m;
  }
  return best;
}

int moments_crownFlash() {
  if (!s_crownMs) return 0;
  uint32_t t = app.now - s_crownMs;
  if (t >= 1600) return 0;
  return 1024 - (int)(t * 1024 / 1600);
}

bool moments_emperorKnock(bool* hit) {
  if (!s_emperorKnockMs || app.now - s_emperorKnockMs >= 4800) return false;
  uint32_t t = (app.now - s_emperorKnockMs) % 1600;
  if (hit) *hit = t < 110 || (t >= 280 && t < 390) || (t >= 560 && t < 670);
  return true;
}

int moments_nudgeX() {
  bool hit = false;
  if (moments_emperorKnock(&hit) && hit) return ((app.now / 28) & 1) ? 2 : -2;
  for (int i = 0; i < app.model.nAgents; i++)
    if (app_knockHit(i)) return ((app.now / 28) & 1) ? 2 : -2;
  return 0;
}

// ---------------------------------------------------------------- drawing

void moments_drawWorld() {
  int s = app.charScale ? app.charScale : 2;
  for (auto& p : s_planes) {
    if (!p.on) continue;
    int a = app_agentByHash(p.aHash), b = app_agentByHash(p.bHash);
    if (a < 0 || b < 0) {
      p.on = false;
      continue;
    }
    int x0, h0, f0, x2, h2, f2;
    anchor(a, x0, h0, f0);
    anchor(b, x2, h2, f2);
    int t = easeInOutCubic((int)((app.now - p.start) * 1024 / PLANE_MS));
    // Dotted trail behind the plane.
    for (int k = 1; k <= 5; k++) {
      int tt = t - k * 55;
      if (tt <= 0) break;
      int tx, ty;
      arcPoint(x0, h0, x2, h2, tt, tx, ty);
      if (k & 1) fillRect(tx, ty, s, s, c(pal::NEUTRAL, (uint8_t)(12 - k * 2)));
    }
    int x, y, xn, yn;
    arcPoint(x0, h0, x2, h2, t, x, y);
    arcPoint(x0, h0, x2, h2, t + 40 > 1024 ? 1024 : t + 40, xn, yn);
    int vx = xn - x, vy = yn - y;
    int tilt = 0;
    if (vy < -abs(vx) / 2) tilt = -2;
    else if (vy > abs(vx) / 2) tilt = 2;
    else if (vy < 0) tilt = -1;
    else if (vy > 0) tilt = 1;
    glow(x, y, 6 * s, pal::AZURE, 5);
    drawPlane(x, y, x2 < x0, tilt, s);
  }
  // Ripples on the glass where an agent knocks.
  for (int i = 0; i < app.model.nAgents; i++) {
    if (!app_knockHit(i)) continue;
    Pose p = app_pose(i);
    int x, footY, scale;
    actor_anchor(i, x, footY, scale);
    int hx, hy;
    char_hand(p, x, footY, scale, hx, hy);
    int r = 3 + (int)((app.now / 30) % 5);
    circle(hx, hy, r, c(pal::NEUTRAL, 13));
    circle(hx, hy, r + 3, c(pal::NEUTRAL, 7));
  }
}

void moments_drawThroneBubble() {
  if (!s_tb.on) return;
  int i = app_agentByHash(s_tb.agentHash);
  if (i < 0) {
    s_tb.on = false;
    return;
  }
  int x, headY, footY;
  anchor(i, x, headY, footY);
  if (!bubble_draw(s_tb, x, headY, footY)) s_nextBubble = app.now + 2200;
}

void moments_drawOverlay() {
  if (!s_toast.start) return;
  uint32_t t = app.now - s_toast.start;
  const uint32_t DUR = 3000;
  if (t >= DUR) return;
  int k = t < 260 ? easeOutCubic((int)(t * 1024 / 260)) : (t > DUR - 260 ? easeInOutCubic((int)((DUR - t) * 1024 / 260)) : 1024);
  int y = 186 + (1024 - k) * 30 / 1024;
  const char* head;
  uint8_t ramp;
  switch (s_toast.type) {
    case EV_TASK_DONE: head = "Done"; ramp = pal::GREEN; break;
    case EV_NEEDS_YOU: head = "Needs you"; ramp = pal::GOLD; break;
    default: head = "Blocked"; ramp = pal::RED; break;
  }
  bool safe = app_camSafe();
  char who[16] = "Emperor";
  int a = s_toast.agentHash ? app_agentByHash(s_toast.agentHash) : -1;
  if (a >= 0) app_label(app.model.agents[a], who, sizeof(who), true);
  int hw = textWidth(head, F_TINY);
  int titleW = s_toast.title[0] ? textWidth(s_toast.title, F_TINY) : textWidth(who, F_TINY);
  if (titleW > 118) titleW = 118;
  int w = 22 + hw + 6 + titleW + 10;
  int x0 = CX - w / 2;
  fillRoundRect(x0, y - 9, w, 18, 9, c(ramp, 2));
  fillRoundRect(x0 + 1, y - 8, w - 2, 16, 8, c(pal::NEUTRAL, 2));
  fillCircle(x0 + 10, y, 5, c(ramp, 10));
  if (s_toast.type == EV_TASK_DONE) {  // check mark
    line(x0 + 7, y, x0 + 9, y + 2, pal::WHITE);
    line(x0 + 9, y + 2, x0 + 13, y - 2, pal::WHITE);
  } else {
    fillRect(x0 + 10, y - 3, 1, 4, pal::WHITE);
    px(x0 + 10, y + 2, pal::WHITE);
  }
  text(head, x0 + 19, y, c(ramp, 13), F_TINY, lgfx::middle_left);
  int tx = x0 + 19 + hw + 6;
  if (s_toast.title[0]) textFitS(s_toast.title, tx, y, titleW, pal::TEXT, F_TINY, lgfx::middle_left, safe);
  else text(who, tx, y, pal::TEXT, F_TINY, lgfx::middle_left);
}

bool moments_cardOpen() { return s_card.open; }

bool moments_tap(int x, int y, bool anywhere) {
  if (s_card.open) {
    s_card.open = false;
    return true;
  }
  const Model& m = app.model;
  int dx = x - CX, dy = y - CY;
  bool ring = anywhere || dx * dx + dy * dy > 92 * 92;
  int idx = -1;
  if (m.nNeeds > 0) {
    if (ring) {
      idx = (int)(s_card.next++ % m.nNeeds);
    } else {
      int hit = throne_hit(x, y);
      if (hit >= 0)
        for (int k = 0; k < m.nNeeds; k++)
          if (m.needs[k].agentHash == m.agents[hit].idHash) idx = k;
    }
    if (idx < 0) return false;
  } else if (!(ring && m.s.pendingApprovals > 0)) {
    return false;
  }
  s_card.open = true;
  s_card.need = (int8_t)idx;
  s_card.openedMs = app.now;
  return true;
}

void moments_drawNeedsCard() {
  if (!s_card.open) return;
  const Model& m = app.model;
  bool safe = app_camSafe();
  int k = app.now - s_card.openedMs < 220 ? easeOutBack((int)((app.now - s_card.openedMs) * 1024 / 220)) : 1024;
  int w = 176 * k / 1024, h = 88 * k / 1024;
  if (w < 20 || h < 12) return;
  int x0 = CX - w / 2, y0 = CY - h / 2;
  fillRoundRect(x0 - 2, y0 - 2, w + 4, h + 4, 14, c(pal::GOLD, 8));
  fillRoundRect(x0, y0, w, h, 12, c(pal::NEUTRAL, 2));
  if (k < 1000) return;
  text("NEEDS YOU", CX, y0 + 13, c(pal::GOLD, 13), F_SMALL);
  if (s_card.need < 0 || s_card.need >= m.nNeeds) {
    char buf[40];
    snprintf(buf, sizeof(buf), "%d approval%s pending", m.s.pendingApprovals, m.s.pendingApprovals == 1 ? "" : "s");
    text(buf, CX, y0 + 42, pal::TEXT, F_SMALL);
    text("Open Emperor Claw to review", CX, y0 + 64, pal::TEXT_DIM, F_TINY);
    return;
  }
  const Need& n = m.needs[s_card.need];
  int a = n.agentHash ? app_agentByHash(n.agentHash) : -1;
  char who[32] = "from the Emperor";  // approval with no requesting agent
  if (a >= 0) {
    char label[28];
    app_label(m.agents[a], label, sizeof(label), false);
    snprintf(who, sizeof(who), "from %s", label);
  }
  text(who, CX, y0 + 28, c(pal::GOLD, 10), F_TINY);
  uint16_t st[3];
  uint8_t ln[3];
  int lines = wrapText(n.title, w - 24, F_SMALL, st, ln, 3);
  char buf[TITLE_TEXT];
  for (int l = 0; l < lines; l++) {
    int cnt = ln[l] < sizeof(buf) - 1 ? ln[l] : sizeof(buf) - 1;
    memcpy(buf, n.title + st[l], cnt);
    buf[cnt] = 0;
    textS(buf, CX, y0 + 46 + l * 15, pal::WHITE, F_SMALL, lgfx::middle_center, safe);
  }
  if (m.nNeeds > 1) {
    char more[16];
    snprintf(more, sizeof(more), "%d/%d", s_card.need + 1, m.nNeeds);
    text(more, CX, y0 + h - 7, pal::TEXT_FAINT, F_TINY);
  }
}

// ---------------------------------------------------------------- thought bubble

static constexpr int B_POP = 240, B_CPS = 30, B_HOLD = 3600, B_OUT = 320;
static constexpr int B_MAXW = 136, B_LINES = 4, B_LH = 10;

void bubble_start(Bubble& b, uint32_t agentHash, const char* text) {
  memset(&b, 0, sizeof(b));
  b.on = true;
  b.agentHash = agentHash;
  b.start = app.now;
  strlcpy(b.text, text, sizeof(b.text));
  b.textHash = fnv1a(b.text);
  b.n = (uint8_t)strlen(b.text);
  b.nLines = (uint8_t)wrapText(b.text, B_MAXW, F_TINY, b.st, b.ln, 8);
  char buf[THOUGHT_TEXT];
  for (int l = 0; l < b.nLines; l++) {
    memcpy(buf, b.text + b.st[l], b.ln[l]);
    buf[b.ln[l]] = 0;
    int w = textWidth(buf, F_TINY);
    if (w > b.w) b.w = (int16_t)w;
  }
}

uint32_t bubble_duration(const Bubble& b) { return B_POP + (uint32_t)b.n * 1000 / B_CPS + B_HOLD + B_OUT; }

bool bubble_draw(Bubble& b, int ax, int headY, int footY) {
  if (!b.on) return false;
  uint32_t t = app.now - b.start;
  uint32_t dur = bubble_duration(b);
  if (t >= dur) {
    b.on = false;
    return false;
  }
  int k = 1024;
  if (t < (uint32_t)B_POP) k = easeOutBack((int)(t * 1024 / B_POP));
  else if (t > dur - B_OUT) k = 1024 - easeInOutCubic((int)((t - (dur - B_OUT)) * 1024 / B_OUT));
  int typed = t < (uint32_t)B_POP ? 0 : (int)((t - B_POP) * B_CPS / 1000);
  if (typed > b.n) typed = b.n;

  // Size for the final text so the bubble does not grow while typing.
  int vis = b.nLines < B_LINES ? b.nLines : B_LINES;
  if (vis < 1) vis = 1;
  int bw = b.w + 16, bh = vis * B_LH + 10;
  int top = headY - 16 - bh;
  bool above = true;
  if (top < 34) {
    top = footY + 10;
    above = false;
    if (top + bh > 204) {
      top = 34;
      above = true;
    }
  }
  int ha = chordHalf(top, 8), hb = chordHalf(top + bh, 8);
  int half = ha < hb ? ha : hb;
  if (bw > half * 2) bw = half * 2;
  int bx = ax - bw / 2;
  if (bx < CX - half) bx = CX - half;
  if (bx + bw > CX + half) bx = CX + half - bw;
  int cx = bx + bw / 2, cy = top + bh / 2;

  // Thought-cloud tail: two puffs between the head and the bubble.
  if (k > 400) {
    int ex = cx, ey = above ? top + bh : top;
    int sx = ax, sy = above ? headY - 3 : footY + 3;
    int p1x = sx + (ex - sx) / 3, p1y = sy + (ey - sy) / 3;
    int p2x = sx + (ex - sx) * 2 / 3, p2y = sy + (ey - sy) * 2 / 3;
    fillCircle(p1x, p1y, 2, pal::WHITE);
    fillCircle(p2x, p2y, 3, pal::WHITE);
  }
  int cw = bw * k / 1024, ch = bh * k / 1024;
  if (cw < 6 || ch < 4) return true;
  // Shadow, cloud body and a few puffs along the edges.
  fillRoundRect(cx - cw / 2 + 2, cy - ch / 2 + 3, cw, ch, 7, c(pal::NEUTRAL, 1));
  fillRoundRect(cx - cw / 2, cy - ch / 2, cw, ch, 7, pal::WHITE);
  int pr = 5 * k / 1024;
  for (int x = cx - cw / 2 + 10; x < cx + cw / 2 - 6; x += 17) {
    fillCircle(x, cy - ch / 2 + 1, pr, pal::WHITE);
    fillCircle(x + 8, cy + ch / 2 - 1, pr - 1, pal::WHITE);
  }
  if (k < 980) return true;

  // Typewriter: the lines holding typed text, at most B_LINES, scrolled to the newest.
  int last = 0;
  for (int l = 0; l < b.nLines; l++)
    if (b.st[l] < typed) last = l;
  int first = last - (B_LINES - 1);
  if (first < 0) first = 0;
  bool safe = app_camSafe();
  uint8_t ink = c(pal::NEUTRAL, 2);
  char buf[THOUGHT_TEXT];
  int caretX = bx + 8, caretY = top + 9;
  for (int l = first; l < b.nLines && l < first + B_LINES; l++) {
    int cnt = typed - b.st[l];
    if (cnt <= 0) break;
    if (cnt > b.ln[l]) cnt = b.ln[l];
    memcpy(buf, b.text + b.st[l], cnt);
    buf[cnt] = 0;
    int ly = top + 9 + (l - first) * B_LH;
    textS(buf, bx + 8, ly, ink, F_TINY, lgfx::middle_left, safe);
    caretX = bx + 8 + textWidth(buf, F_TINY) + 1;
    caretY = ly;
  }
  if (typed < b.n && ((app.now / 200) & 1)) fillRect(caretX, caretY - 3, 2, 7, c(pal::VIOLET, 9));
  return true;
}
