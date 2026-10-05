// Machine-readable setup commands used by the browser installer (Web Serial) and
// handy from any serial terminal. Every reply line starts with a fixed tag so the
// page can parse it; secrets are never echoed.
//
//   version              -> [version] <FW_VERSION>
//   scan                 -> [scan] start
//                           [scan] {"ssid":"...","rssi":-60,"secure":true,"ch":6}   (one per network, strongest first)
//                           [scan] done <count>      or   [scan] error <reason>
//   provision <base64>   -> [prov] ok + [prov] restarting   or   [prov] error <reason>
//
// provision takes base64 of UTF-8 JSON {"v":1,"ssid","pass","server","token"} and
// saves all four atomically, switches to live mode and restarts.
#pragma once
#include <Arduino.h>

void setup_startScan();
// Call every frame: finishes an asynchronous scan and prints the results.
void setup_pollScan();
bool setup_scanning();
void setup_provision(const char* b64);
