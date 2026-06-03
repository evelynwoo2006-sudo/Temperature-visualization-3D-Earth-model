import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "web"))

from ui import app  # noqa: E402

if __name__ == "__main__":
    app.run()
