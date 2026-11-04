// TODAY: the day's cost of the agents on this screen, as a donut. Each slice is one
// agent (in its own color), the five biggest plus "Others", around the day's total.
// When no run reported a cost the chart is by runs and says so ("runs today"), never
// an invented $; with no work at all the ring is empty: "No work yet today".
// Runs, tokens and tasks done sit underneath. Every number comes from feed `today`
// (since local midnight, only work this screen may see).
#include "../app.h"
#include "../palette.h"
#include "../ui_common.h"

using namespace ui;
using pal::c;

namespace {

constexpr int RING_Y = 96, R0 = 47, R1 = 66;
constexpr uint32_t GROW_MS = 700;
uint32_t s_enterMs = 0, s_lastDrawMs = 0;

// "$12.34", or "$1,234" from a thousand dollars up.
void fmtMoney(char* out, size_t cap, int32_t cents) {
  if (cents < 0) {
    strlcpy(out, "-", cap);
    return;
  }
  long dollars = (long)(cents / 100);
  if (dollars < 1000) snprintf(out, cap, "$%ld.%02ld", dollars, (long)(cents % 100));
  else if (dollars < 1000000) snprintf(out, cap, "$%ld,%03ld", dollars / 1000, dollars % 1000);
  else snprintf(out, cap, "$%ldM", dollars / 1000000);
}

// "860k", "1.2M" from a count in thousands.
void fmtTokensK(char* out, size_t cap, int32_t k) {
  if (k < 1000) snprintf(out, cap, "%ldk", (long)k);
  else snprintf(out, cap, "%ld.%ldM", (long)(k / 1000), (long)((k % 1000) / 100));
}

struct Slice {
  int32_t value;
  uint8_t color;
  int agent;  // index in the model, -1 = Others
};

// One legend entry: color dot, name, amount (right-aligned in a 88 px column).
void legendEntry(int x, int y, const Slice& s, bool byCost, int32_t othersN) {
  char name[28], amount[16];
  if (s.agent >= 0) app_nameFit(app.model.agents[s.agent], name, sizeof(name), 50, F_TINY);
  else snprintf(name, sizeof(name), "Others (%ld)", (long)othersN);
  if (byCost) fmtMoney(amount, sizeof(amount), s.value);
  else snprintf(amount, sizeof(amount), "%ld", (long)s.value);
  fillCircle(x + 3, y, 2, s.color);
  int aw = textWidth(amount, F_TINY);
  textFit(name, x + 9, y, 80 - aw - 12, pal::TEXT, F_TINY, lgfx::middle_left);
  text(amount, x + 88, y, c(pal::GOLD, 12), F_TINY, lgfx::middle_right);
}

}  // namespace

void today_draw() {
  const Model& m = app.model;
  const Today& t = m.today;
  if (!s_lastDrawMs || app.now - s_lastDrawMs > 500) s_enterMs = app.now;  // grow the ring on entry
  s_lastDrawMs = app.now;
  clear(pal::BLACK);
  fillCircle(CX, CY, 119, pal::BG);
  arcText("TODAY", 101, ANG_TOP, c(pal::GOLD, 13), F_MED, true);

  if (!t.has) {
    ring(CX, RING_Y, R0, R1, c(pal::NEUTRAL, 2));
    text("No usage data", CX, RING_Y - 6, pal::TEXT_DIM, F_SMALL);
    text("update the server", CX, RING_Y + 10, pal::TEXT_FAINT, F_TINY);
    return;
  }

  bool byCost = t.cost >= 0;
  Slice slices[6];
  int n = 0;
  int32_t total = 0;
  for (int k = 0; k < t.nTop; k++) {
    int i = app_agentByHash(t.top[k].agentHash);
    int32_t v = byCost ? t.top[k].cost : t.top[k].runs;
    if (v <= 0) continue;
    // An agent no longer on the screen still counts toward the ring, in neutral.
    slices[n++] = {v, i >= 0 ? c(app.anim[i].ramp, 11) : c(pal::NEUTRAL, 8), i};
    total += v;
  }
  int32_t others = byCost ? t.othersCost : t.othersRuns;
  if (others > 0) {
    slices[n++] = {others, c(pal::NEUTRAL, 7), -1};
    total += others;
  }

  // The ring: slices clockwise from 12 o'clock, growing in when the screen opens.
  int grow = (int)(app.now - s_enterMs >= GROW_MS ? 1024 : (app.now - s_enterMs) * 1024 / GROW_MS);
  int sweep = easeOutCubic(grow) * ANG_FULL / 1024;
  ring(CX, RING_Y, R0, R1, c(pal::NEUTRAL, 2));
  if (total > 0) {
    int a = ANG_TOP, gap = n > 1 ? 4 : 0;
    for (int k = 0; k < n; k++) {
      int span = k == n - 1 ? ANG_TOP + ANG_FULL - a : (int)((int64_t)slices[k].value * ANG_FULL / total);
      int a0 = a, a1 = a + span - gap;
      if (a0 - ANG_TOP >= sweep) break;
      if (a1 - ANG_TOP > sweep) a1 = ANG_TOP + sweep;
      if (a1 > a0) arc(CX, RING_Y, R0, R1, a0, a1, slices[k].color);
      a += span;
    }
  }

  // The total in the middle.
  char big[24];
  const char* caption;
  if (byCost) {
    fmtMoney(big, sizeof(big), t.cost);
    caption = "spent today";
  } else if (t.runs > 0) {
    snprintf(big, sizeof(big), "%ld", (long)t.runs);
    caption = t.runs == 1 ? "run today" : "runs today";
  } else {
    big[0] = 0;
    caption = nullptr;
  }
  if (big[0]) {
    Font f = textWidth(big, F_BIG) <= 2 * R0 - 10 ? F_BIG : F_MED;
    text(big, CX, RING_Y - 5, byCost ? c(pal::GOLD, 15) : pal::WHITE, f);
    text(caption, CX, RING_Y + 15, pal::TEXT_FAINT, F_TINY);
  } else {
    text("No work", CX, RING_Y - 6, pal::TEXT_DIM, F_SMALL);
    text("yet today", CX, RING_Y + 9, pal::TEXT_DIM, F_SMALL);
  }
  if (m.demo) text("DEMO SAMPLE", CX, RING_Y + 28, c(pal::VIOLET, 12), F_TINY);

  // Legend: two columns of three, biggest first.
  for (int k = 0; k < n; k++) {
    int col = k / 3, row = k % 3;
    legendEntry(col ? CX + 3 : CX - 92, 174 + row * 12, slices[k], byCost, t.othersN);
  }

  // Runs, tokens, tasks done.
  char stats[64], tok[12];
  fmtTokensK(tok, sizeof(tok), t.tokensK);
  snprintf(stats, sizeof(stats), "%ld runs - %s tokens - %ld done", (long)t.runs, tok, (long)t.done);
  textFit(stats, CX, 213, 2 * chordHalf(213, 14), pal::TEXT_DIM, F_TINY);
}
