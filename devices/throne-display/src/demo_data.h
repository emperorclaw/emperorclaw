// Built-in simulated company used before the device is configured (or when demo is toggled on).
// It exercises every visual: state changes, completed tasks (confetti), attention flags,
// agents going down and recovering, approvals and a stream of chat messages.
#pragma once
#include "data_model.h"

void demo_init(Model& m);
// Advance the simulation. Returns true when the model changed and should be published.
bool demo_tick(Model& m, uint32_t nowMs);
