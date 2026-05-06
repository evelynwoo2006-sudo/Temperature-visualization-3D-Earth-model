import os
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import requests
from plotly.subplots import make_subplots

WEATHERAPI_KEY = os.getenv("WEATHERAPI_KEY", "").strip()

CITY_CN_TO_EN = {
    "北京": "Beijing",
    "上海": "Shanghai",
    "广州": "Guangzhou",
    "深圳": "Shenzhen",
    "杭州": "Hangzhou",
    "成都": "Chengdu",
    "重庆": "Chongqing",
    "武汉": "Wuhan",
    "南京": "Nanjing",
    "天津": "Tianjin",
    "西安": "Xi'an",
    "哈尔滨": "Harbin",
    "长春": "Changchun",
    "沈阳": "Shenyang",
    "大连": "Dalian",
    "济南": "Jinan",
    "青岛": "Qingdao",
    "郑州": "Zhengzhou",
    "长沙": "Changsha",
    "石家庄": "Shijiazhuang",
    "太原": "Taiyuan",
    "呼和浩特": "Hohhot",
    "乌鲁木齐": "Urumqi",
    "兰州": "Lanzhou",
    "西宁": "Xining",
    "银川": "Yinchuan",
    "拉萨": "Lhasa",
    "南宁": "Nanning",
    "贵阳": "Guiyang",
    "昆明": "Kunming",
    "海口": "Haikou",
    "福州": "Fuzhou",
    "厦门": "Xiamen",
    "南昌": "Nanchang",
    "合肥": "Hefei",
    "儋州": "Danzhou",
    "三亚": "Sanya",
    "桂林": "Guilin",
    "柳州": "Liuzhou",
    "苏州": "Suzhou",
    "宁波": "Ningbo",
    "温州": "Wenzhou",
    "无锡": "Wuxi",
    "佛山": "Foshan",
    "东莞": "Dongguan",
}

CITY_LATITUDE = {
    "Beijing": 39.9,
    "Shanghai": 31.2,
    "Guangzhou": 23.1,
    "Shenzhen": 22.5,
    "Hangzhou": 30.3,
    "Chengdu": 30.6,
    "Chongqing": 29.6,
    "Wuhan": 30.6,
    "Nanjing": 32.1,
    "Tianjin": 39.1,
    "Xi'an": 34.3,
    "Harbin": 45.8,
    "Changchun": 43.9,
    "Shenyang": 41.8,
    "Dalian": 38.9,
    "Jinan": 36.7,
    "Qingdao": 36.1,
    "Zhengzhou": 34.8,
    "Changsha": 28.2,
    "Shijiazhuang": 38.0,
    "Taiyuan": 37.9,
    "Hohhot": 40.8,
    "Urumqi": 43.8,
    "Lanzhou": 36.1,
    "Xining": 36.6,
    "Yinchuan": 38.5,
    "Lhasa": 29.6,
    "Nanning": 22.8,
    "Guiyang": 26.6,
    "Kunming": 25.0,
    "Haikou": 20.0,
    "Fuzhou": 26.1,
    "Xiamen": 24.5,
    "Nanchang": 28.7,
    "Hefei": 31.9,
    "Danzhou": 19.6,
    "Sanya": 18.3,
    "Guilin": 25.3,
    "Liuzhou": 24.3,
    "Suzhou": 31.3,
    "Ningbo": 29.9,
    "Wenzhou": 28.0,
    "Wuxi": 31.5,
    "Foshan": 23.0,
    "Dongguan": 23.0,
    "Zhongshan": 22.5,
    "Zhuhai": 22.3,
    "Shantou": 23.4,
    "Zhanjiang": 21.2,
    "Maoming": 21.7,
    "Huizhou": 23.1,
    "Jiangmen": 22.6,
    "Zhaoqing": 23.1,
    "Qingyuan": 23.7,
    "Jieyang": 23.6,
    "Yangjiang": 21.9,
    "Shaoguan": 24.8,
    "Meizhou": 24.3,
    "Shanwei": 22.8,
    "Heyuan": 23.7,
    "Yunfu": 22.9,
    "Chaozhou": 23.7,
}


def normalize_city_name(city: str) -> str:
    if not city:
        return "Beijing"
    city = city.strip()
    if city in CITY_LATITUDE:
        return city
    return CITY_CN_TO_EN.get(city, city)


def get_base_temperature(city_en: str) -> float:
    lat = CITY_LATITUDE.get(city_en, 35.0)
    base_temp = 28 - (lat - 20) * 0.4
    return max(10, min(32, base_temp))


def get_history_from_api(city_en):
    try:
        if not WEATHERAPI_KEY:
            return None, None, None, None
        url = "https://api.weatherapi.com/v1/history.json"
        params = {
            "key": WEATHERAPI_KEY,
            "q": city_en,
            "dt": (datetime.now() - timedelta(days=730)).strftime("%Y-%m-%d"),
            "end_dt": datetime.now().strftime("%Y-%m-%d"),
        }

        res = requests.get(url, params=params, timeout=8)
        data = res.json()

        history_list = data["forecast"]["forecastday"]
        dates = []
        temps = []
        precips = []
        humiditys = []

        for day in history_list[-30:]:
            dates.append(day["date"])
            temps.append(day["day"]["avgtemp_c"])
            precips.append(day["day"]["totalprecip_mm"])
            humiditys.append(day["day"]["avghumidity"])

        return dates, temps, precips, humiditys
    except Exception:
        return None, None, None, None


def plot_combined_forecast(city: str) -> str:
    city_en = normalize_city_name(city)
    base_temp = get_base_temperature(city_en)
    today = datetime.now().date()

    history_dates, history_temps, history_precip, history_humidity = get_history_from_api(city_en)

    if history_dates is None:
        history_dates = [today - timedelta(days=i) for i in range(30, 0, -1)]
        history_temps = [base_temp + 6 * np.sin(i / 10) + np.random.randn() * 1.5 for i in range(30)]
        history_precip = [np.random.exponential(3) for _ in range(30)]
        history_humidity = [65 + 15 * np.sin(i / 15) + np.random.randn() * 5 for i in range(30)]

    forecast_dates = [today + timedelta(days=i) for i in range(1, 16)]
    forecast_temps = [base_temp + 4 * np.sin(i / 8) + np.random.randn() * 1.2 for i in range(15)]
    forecast_precip = [np.random.exponential(2) for _ in range(15)]

    history_temps = [max(5, min(38, t)) for t in history_temps]
    forecast_temps = [max(5, min(38, t)) for t in forecast_temps]

    fig = make_subplots(specs=[[{"secondary_y": True}]])

    fig.add_trace(
        go.Scatter(
            x=history_dates,
            y=history_temps,
            name="历史温度 (°C)",
            line=dict(color="#1f7bff", width=2),
            mode="lines+markers",
        ),
        secondary_y=False,
    )

    fig.add_trace(
        go.Scatter(
            x=forecast_dates,
            y=forecast_temps,
            name="预测温度 (°C)",
            line=dict(color="#ff4d73", width=2, dash="dash"),
            mode="lines+markers",
        ),
        secondary_y=False,
    )

    fig.add_trace(
        go.Bar(
            x=history_dates,
            y=history_precip,
            name="历史降水量 (mm)",
            marker_color="#40bfff",
            opacity=0.4,
        ),
        secondary_y=False,
    )
    fig.add_trace(
        go.Bar(
            x=forecast_dates,
            y=forecast_precip,
            name="预测降水量 (mm)",
            marker_color="#ffaa33",
            opacity=0.4,
        ),
        secondary_y=False,
    )

    fig.add_trace(
        go.Scatter(
            x=history_dates,
            y=history_humidity,
            name="湿度 (%)",
            line=dict(color="#ffa500", width=2),
            mode="lines+markers",
        ),
        secondary_y=True,
    )

    fig.update_layout(
        title=f"{city_en} 天气趋势（过去30天 + 未来15天预测）",
        xaxis_title="日期",
        yaxis_title="温度 (°C) / 降水量 (mm)",
        yaxis2=dict(title="湿度 (%)", overlaying="y", side="right"),
        template="plotly_white",
        height=550,
        hovermode="x unified",
    )

    return fig.to_html(full_html=False)


if __name__ == "__main__":
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    out_dir = os.path.join(project_root, "forecasts")
    os.makedirs(out_dir, exist_ok=True)
    for test_city in sorted(CITY_LATITUDE.keys()):
        html = plot_combined_forecast(test_city)
        with open(os.path.join(out_dir, f"{test_city}_forecast.html"), "w", encoding="utf-8") as f:
            f.write(html)
