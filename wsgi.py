import sys
import os

# 将 code/web 目录添加到系统路径，以便导入 ui
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "code", "web"))

from ui import app

if __name__ == "__main__":
    app.run()
