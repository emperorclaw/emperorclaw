// TODAY: the company's day at a glance, from feed 2.2 `today` (the agents on this
// screen, since local midnight): what it cost, how many runs and tokens, how many
// tasks got done, and who spent the most. Every number comes from the server; a
// cost no run reported shows as "-", never as $0.00.
#include "../app.h"
#include "../palette.h"
#include "../ui_common.h"

using namespace ui;
using pal::c;

namespace {

// "$12.34", or "$1,234" from a thousand dollars up.
void fmtMoney(char* out, size_t cap, int32_t cents) {
  if (cents < 0) {
    strlcpy(out, "-", cap);
    return;
  }
  long dollars = (long)(cents / 100);
  if (dollars < 1000) {
    snprintf(out, cap, "$%ld.%02ld", dollars, (long)(cents % 100));
  } else if (dollars < 1000000) {
    snprintf(out, cap, "$%ld,%03ld", dollars / 1000, dollars % 1000);
  } else {
    snprintf(out, cap, "$%ldM", dollars / 1000000);
  }
}

// "860k", "1.2M" from a count in thousands.
void fmtTokensK(char* out, size_t cap, int32_t k) {
  if (k < 1000) snprintf(out, cap, "%ldk", (long)k);
  else snprintf(out, cap, "%ld.%ldM", (long)(k / 1000), (long)((k % 1000) / 100));
}

void stat(int x, const char* value, const char* label) {
  text(value, x, 130, pal::WHITE, F_MED);
  text(label, x, 146, pal::TEXT_FAINT, F_TINY);
}

}  // namespace

void today_draw() {
  const Model& m = app.model;
  const Today& t = m.today;
  clear(pal::BLACK);
  fillCircle(CX, CY, 119, pal::BG);
  ring(CX, CY, 113, 118, c(pal::GOLD, 3));
  arcText("TODAY", 101, ANG_TOP, c(pal::GOLD, 13), F_MED, true);

  if (!t.has) {
    text("No usage yet", CX, 112, pal::TEXT_DIM, F_SMALL);
    text("This server does not send", CX, 136, pal::TEXT_FAINT, F_TINY);
    text("today's usage", CX, 147, pal::TEXT_FAINT, F_TINY);
    return;
  }

  // The day's spend, big.
  char buf[24];
  fmtMoney(buf, sizeof(buf), t.cost);
  int p = pulse(app.now, 4000);
  glow(CX, 76, 46, pal::GOLD, 2 + p / 512);
  text(buf, CX, 78, t.cost >= 0 ? c(pal::GOLD, 15) : pal::TEXT_DIM, F_HUGE);
  text(t.cost >= 0 ? "spent today" : "no cost reported", CX, 104, pal::TEXT_FAINT, F_TINY);

  // Runs, tokens, tasks done.
  char runs[12], tokens[12], done[12];
  snprintf(runs, sizeof(runs), "%ld", (long)t.runs);
  fmtTokensK(tokens, sizeof(tokens), t.tokensK);
  snprintf(done, sizeof(done), "%d", (int)t.done);
  stat(CX - 58, runs, "runs");
  stat(CX, tokens, "tokens");
  stat(CX + 58, done, "done");

  // Who spent the most: proper names, in their own colors.
  int hw = chordHalf(158, 34);
  hline(CX - hw, CX + hw, 158, c(pal::NEUTRAL, 4));
  int shown = 0;
  for (int k = 0; k < t.nTop && shown < 3; k++) {
    int i = app_agentByHash(t.top[k].agentHash);
    if (i < 0) continue;
    int y = 170 + shown * 13;
    char name[28], cost[16];
    app_nameFit(m.agents[i], name, sizeof(name), 96, F_SMALL);
    fmtMoney(cost, sizeof(cost), t.top[k].cost);
    fillCircle(CX - 66, y, 3, c(app.anim[i].ramp, 11));
    textFit(name, CX - 58, y, 100, pal::TEXT, F_SMALL, lgfx::middle_left);
    text(cost, CX + 70, y, c(pal::GOLD, 12), F_SMALL, lgfx::middle_right);
    shown++;
  }
  if (!shown) text(t.runs ? "no cost by agent yet" : "no runs yet today", CX, 176, pal::TEXT_FAINT, F_TINY);

  // Anything waiting on a human.
  if (m.s.pendingApprovals > 0) {
    char wait[32];
    snprintf(wait, sizeof(wait), m.s.pendingApprovals == 1 ? "%d approval waiting" : "%d approvals waiting",
             (int)m.s.pendingApprovals);
    text(wait, CX, 214, c(pal::GOLD, 13), F_TINY);
  }
}
