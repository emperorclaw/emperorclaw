// Firmware version. The value comes from `custom_fw_version` in platformio.ini
// (passed as -DFW_VERSION); the web installer compares it with manifest.json.
#pragma once

#ifndef FW_VERSION
#define FW_VERSION "dev"
#endif
