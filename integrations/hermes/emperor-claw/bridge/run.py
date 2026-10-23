"""Launcher for hosts that start the bridge by file path instead of ``python -m emperor_bridge``.

    $HERMES_PYTHON /path/to/bridge/run.py run [--profiles a,b]

Puts this directory on ``sys.path`` and hands over to ``emperor_bridge.__main__``.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from emperor_bridge.__main__ import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
