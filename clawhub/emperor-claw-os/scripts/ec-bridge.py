#!/usr/bin/env python3
import os
import sys

# Change to the examples directory to find bridge.py
sys.path.append(os.path.join(os.path.dirname(__file__), "..", "examples"))

import bridge
import asyncio

if __name__ == "__main__":
    asyncio.run(bridge.EmperorBridge().start())
