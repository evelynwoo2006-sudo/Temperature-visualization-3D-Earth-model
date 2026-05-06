# Global Weather Project

## 目录结构

- `web/`：Flask 后端与页面模板
  - `web/main.py`：启动入口
  - `web/ui.py`：路由与 API（`/api/*`、`/chat`、`/history` 等）
  - `web/templates/`：`index.html`、`earth.html`、`history.html`
- `earth_module/`：3D 地球前端资源
  - `earth_module/frontend/`：`main.js`、`style.css`
  - `earth_module/assets/`：地理边界与贴图（GeoJSON/JPG）
- `scripts/`：离线脚本
  - `scripts/predict.py`：生成预测图表 HTML
- `forecasts/`：预测图表输出目录（由 `/history` 或脚本生成）

## 运行方式

1. 安装依赖：`pip install -r requirements.txt`
2. 启动服务：`python web/main.py`
3. 入口页面：`http://127.0.0.1:5000/`
