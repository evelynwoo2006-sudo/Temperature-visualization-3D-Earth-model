
# main.py 成员1：项目整合入口
from ui import app

if __name__ == '__main__':
    app.run(host="127.0.0.1", port=5000, debug=False, use_reloader=False, threaded=True)
