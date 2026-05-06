# ui.py - 最终版
import os
import time
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import importlib.util
import requests
from flask import Flask, jsonify, make_response, redirect, render_template, request, send_from_directory, session




app = Flask(__name__)
app.secret_key = 'global_weather_secret_key_2024'

PROJECT_ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EARTH_MODULE_DIR = os.path.join(PROJECT_ROOT_DIR, "earth_module")
FORECASTS_DIR = os.path.join(PROJECT_ROOT_DIR, "forecasts")

# 统一使用相对路径，避免硬编码 Windows 路径
EARTH2_PROJECT_PATH = os.getenv("EARTH2_PROJECT_PATH", EARTH_MODULE_DIR)

OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY", "").strip()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
DOUBAO_API_KEY = os.getenv("DOUBAO_API_KEY", "").strip()
DOUBAO_BASE_URL = os.getenv("DOUBAO_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3").strip()
DOUBAO_MODEL = os.getenv("DOUBAO_MODEL", "doubao-lite-4k").strip()
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").strip()
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "").strip()
OPENWEATHER_BASE_URL = "https://api.openweathermap.org/data/2.5/weather"
CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "600"))

_cache: Dict[str, Any] = {"expires_at": 0.0, "data": None}
_weather_cache: Dict[str, Any] = {"by_coord": {}}
_chat_forecast_cache: Dict[str, Any] = {}
_image_cache: Dict[str, Any] = {}

def _load_root_predict_module():
    candidates = [
        os.path.join(PROJECT_ROOT_DIR, "scripts", "predict.py"),
        os.path.join(PROJECT_ROOT_DIR, "predict.py"),
    ]
    file_path = None
    for p in candidates:
        if os.path.exists(p):
            file_path = p
            break
    if not file_path:
        raise FileNotFoundError("predict.py not found")
    spec = importlib.util.spec_from_file_location("gw_predict", file_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Failed to load predict module spec")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _build_synthetic_forecast(*, city: str, days: int, location: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    import datetime
    import math
    import random

    days = max(1, min(int(days or 6), 14))
    city_raw = str(city or "").strip() or "Beijing"

    base_temp = 18.0
    try:
        predict = _load_root_predict_module()
        if hasattr(predict, "normalize_city_name"):
            try:
                city_raw = str(predict.normalize_city_name(city_raw) or city_raw).strip()
            except Exception:
                pass
        if hasattr(predict, "get_base_temperature"):
            try:
                base_temp = float(predict.get_base_temperature(city_raw))
            except Exception:
                base_temp = base_temp
    except Exception:
        base_temp = base_temp

    seed = 0
    for ch in city_raw:
        seed = (seed * 131 + ord(ch)) % 2147483647
    rng = random.Random(seed)

    today = datetime.date.today()
    daily: List[Dict[str, Any]] = []
    for i in range(days):
        swing = 4.5 * math.sin((i + 1) / 5.0)
        noise = rng.uniform(-1.6, 1.6)
        tmax = base_temp + swing + noise
        tmin = tmax - rng.uniform(6.0, 10.5)
        pop = int(max(0, min(100, rng.gauss(30, 22))))
        daily.append(
            {
                "date": str(today + datetime.timedelta(days=i + 1)),
                "tmax_c": float(max(-25, min(45, tmax))),
                "tmin_c": float(max(-30, min(40, tmin))),
                "pop_max": pop,
                "weather_code": None,
            }
        )

    if not isinstance(location, dict):
        location = {"name": city_raw, "country": "", "admin1": "", "latitude": None, "longitude": None}
    return {"location": location, "days": days, "daily": daily, "source": "local-simulated"}

def extract_city_and_days(user_text: str) -> Dict[str, Any]:
    text = str(user_text or "").strip()
    days = 6
    try:
        import re

        m = re.search(r"未来\s*(\d{1,2})\s*天", text)
        if m:
            days = int(m.group(1))
        else:
            m = re.search(r"(\d{1,2})\s*天", text)
            if m:
                days = int(m.group(1))
    except Exception:
        pass

    days = max(1, min(int(days or 6), 14))

    city = ""
    try:
        import re

        m = re.search(r"(?:想去|去)\s*([^\s，。,。.?!！]{1,30}?)\s*(?:旅游|旅行|出行|玩)", text)
        if m:
            city = m.group(1).strip()
        if not city:
            m = re.search(r"未来\s*\d{1,2}\s*天\s*([^\s，。,。.?!！]{1,30}?)\s*(?:适合|能)\s*(?:去)?\s*(?:旅游|旅行|出行|玩)", text)
            if m:
                city = m.group(1).strip()
        if not city:
            m = re.search(r"未来\s*\d{1,2}\s*天\s*([^\s，。,。.?!！]{1,30}?)\s*(?:的)?\s*(?:温度|天气|气温)", text)
            if m:
                city = m.group(1).strip()
            else:
                m = re.search(r"([^\s，。,。.?!！]{1,30}?)\s*(?:的)?\s*(?:温度|天气|气温)", text)
                if m:
                    city = m.group(1).strip()
        if not city:
            m = re.search(r"([^\s，。,。.?!！]{1,30}?)\s*(?:适合|能)\s*(?:去)?\s*(?:旅游|旅行|出行|玩)", text)
            if m:
                city = m.group(1).strip()
    except Exception:
        city = ""

    city = city.strip(" ,，。.!！？?;；")
    for suffix in ("的温度", "温度", "天气", "气温"):
        if city.endswith(suffix):
            city = city[: -len(suffix)].strip()

    bad_tokens = ["未来", "温度", "天气", "气温", "看看", "分析", "告诉", "建议", "帮我"]
    if any(t in city for t in bad_tokens):
        city = ""

    if not city:
        alias_keys = ["北京", "上海", "广州", "深圳", "成都", "重庆", "杭州", "南京", "武汉", "西安", "苏州", "天津"]
        for k in alias_keys:
            if k in text:
                city = k
                break
    if not city:
        city = "Beijing"

    return {"city": city, "days": days}


def geocode_city(*, city: str) -> Optional[Dict[str, Any]]:
    name = str(city or "").strip()
    if not name:
        return None
    city_alias = {
        "北京": "Beijing",
        "上海": "Shanghai",
        "广州": "Guangzhou",
        "深圳": "Shenzhen",
        "成都": "Chengdu",
        "重庆": "Chongqing",
        "杭州": "Hangzhou",
        "南京": "Nanjing",
        "武汉": "Wuhan",
        "西安": "Xi'an",
        "苏州": "Suzhou",
        "天津": "Tianjin",
    }
    query = city_alias.get(name, name)
    url = "https://geocoding-api.open-meteo.com/v1/search"
    params = {"name": query, "count": 5, "language": "zh", "format": "json"}
    try:
        resp = requests.get(url, params=params, timeout=8)
        if resp.status_code != 200:
            return None
        payload = resp.json() or {}
        results = payload.get("results") or []
        if not results:
            return None
        target = None
        for r in results:
            if not isinstance(r, dict):
                continue
            if str(r.get("feature_code") or "").upper() == "PPLC":
                target = r
                break
        if target is None:
            target = results[0] or {}
        r0 = target or {}
        lat = r0.get("latitude")
        lon = r0.get("longitude")
        if lat is None or lon is None:
            return None
        return {
            "name": r0.get("name") or name,
            "country": r0.get("country") or "",
            "admin1": r0.get("admin1") or "",
            "latitude": float(lat),
            "longitude": float(lon),
        }
    except Exception:
        return None


def fetch_city_forecast_daily(*, city: str, days: int) -> Optional[Dict[str, Any]]:
    days = max(1, min(int(days or 6), 14))
    cache_key = f"{str(city or '').strip()}|{days}"
    cached = _chat_forecast_cache.get(cache_key)
    now = time.time()
    if cached and now < float(cached.get("expires_at") or 0):
        return cached.get("data")

    geo = geocode_city(city=city)
    if not geo:
        return _build_synthetic_forecast(city=city, days=days, location=None)
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": geo["latitude"],
        "longitude": geo["longitude"],
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
        "forecast_days": days,
        "timezone": "auto",
    }
    try:
        resp = requests.get(url, params=params, timeout=10)
        if resp.status_code == 429:
            if cached and cached.get("data"):
                data = dict(cached["data"])
                data["source"] = "open-meteo-cache"
                return data
            return _build_synthetic_forecast(city=city, days=days, location=geo)
        if resp.status_code != 200:
            return _build_synthetic_forecast(city=city, days=days, location=geo)
        payload = resp.json() or {}
        daily = payload.get("daily") or {}
        times = daily.get("time") or []
        tmax = daily.get("temperature_2m_max") or []
        tmin = daily.get("temperature_2m_min") or []
        pop = daily.get("precipitation_probability_max") or []
        wcode = daily.get("weather_code") or []

        series = []
        n = min(len(times), len(tmax), len(tmin))
        for i in range(n):
            series.append(
                {
                    "date": times[i],
                    "tmax_c": float(tmax[i]),
                    "tmin_c": float(tmin[i]),
                    "pop_max": int(pop[i]) if i < len(pop) and pop[i] is not None else None,
                    "weather_code": int(wcode[i]) if i < len(wcode) and wcode[i] is not None else None,
                }
            )

        data = {"location": geo, "days": days, "daily": series, "source": "open-meteo"}
        _chat_forecast_cache[cache_key] = {"expires_at": now + 900, "data": data}
        return data
    except Exception:
        if cached and cached.get("data"):
            data = dict(cached["data"])
            data["source"] = "open-meteo-cache"
            return data
        return _build_synthetic_forecast(city=city, days=days, location=geo)


def build_offline_weather_travel_advice(*, user_question: str, forecast: Dict[str, Any], city: str) -> str:
    daily = forecast.get("daily") or []
    if not daily:
        return "暂无可用的未来天气数据。"

    temps_max = [d.get("tmax_c") for d in daily if isinstance(d.get("tmax_c"), (int, float))]
    temps_min = [d.get("tmin_c") for d in daily if isinstance(d.get("tmin_c"), (int, float))]
    if not temps_max or not temps_min:
        return "未来天气数据不完整，无法分析。"

    avg_max = sum(temps_max) / len(temps_max)
    avg_min = sum(temps_min) / len(temps_min)
    trend = "较为平稳"
    if len(temps_max) >= 3:
        if temps_max[-1] - temps_max[0] >= 4:
            trend = "升温趋势"
        elif temps_max[0] - temps_max[-1] >= 4:
            trend = "降温趋势"

    rainy_days = 0
    for d in daily:
        p = d.get("pop_max")
        if isinstance(p, int) and p >= 50:
            rainy_days += 1

    recommend = "推荐出行"
    if avg_max >= 32 or avg_min >= 26:
        recommend = "谨慎出行（偏热）"
    if avg_min <= -5:
        recommend = "谨慎出行（偏冷）"
    if rainy_days >= max(2, len(daily) // 2):
        recommend = "谨慎出行（降水概率偏高）"

    tips = []
    if avg_max >= 30:
        tips.append("防晒（帽子/墨镜/防晒霜），补水")
    if avg_min <= 5:
        tips.append("带外套/抓绒，注意早晚温差")
    if rainy_days:
        tips.append("带雨具（折叠伞/雨衣）")
    tips.append("穿舒适步行鞋")

    lines = []
    lines.append(f"城市：{city}")
    lines.append(f"温度趋势：{trend}（平均最高约 {avg_max:.1f}°C，平均最低约 {avg_min:.1f}°C）")
    lines.append("简要总结：")
    lines.append(f"- 未来 {len(daily)} 天整体温度区间约 {min(temps_min):.1f}–{max(temps_max):.1f}°C")
    if rainy_days:
        lines.append(f"- 有 {rainy_days} 天降水概率较高（≥50%）")
    lines.append(f"是否推荐出行：{recommend}")
    lines.append("出行温馨提示：")
    for t in tips:
        lines.append(f"- {t}")
    return "\n".join(lines)


def call_openai_weather_assistant(*, user_question: str, forecast: Dict[str, Any], city: str) -> str:
    system_prompt = (
        "你是一名气象分析专家 + 旅游建议助手。你必须严格基于我提供的未来天气数据进行分析，"
        "禁止凭空编造任何温度、降水、天气结论。输出必须包含："
        "1) 温度趋势分析；2) 简要总结；3) 是否推荐出行；4) 出行温馨提示（建议携带物品）。"
        "如果数据不足以回答，请明确说明需要哪些数据。"
    )

    user_payload = {
        "question": user_question,
        "city": city,
        "forecast_source": forecast.get("source"),
        "location": forecast.get("location"),
        "daily_forecast": forecast.get("daily"),
    }

    url = "https://api.openai.com/v1/chat/completions"
    headers = {"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"}
    body = {
        "model": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"基于以下JSON天气预报数据回答（只许使用其中数据）：\n{user_payload}"},
        ],
    }
    try:
        resp = requests.post(url, headers=headers, json=body, timeout=25)
        if resp.status_code != 200:
            return build_offline_weather_travel_advice(user_question=user_question, forecast=forecast, city=city)
        payload = resp.json() or {}
        choices = payload.get("choices") or []
        if not choices:
            return build_offline_weather_travel_advice(user_question=user_question, forecast=forecast, city=city)
        msg = choices[0].get("message") or {}
        content = str(msg.get("content") or "").strip()
        if not content:
            return build_offline_weather_travel_advice(user_question=user_question, forecast=forecast, city=city)
        return content
    except Exception:
        return build_offline_weather_travel_advice(user_question=user_question, forecast=forecast, city=city)


def call_doubao_weather_assistant(*, user_question: str, forecast: Dict[str, Any], city: str) -> Optional[str]:
    if not DOUBAO_API_KEY:
        return None

    system_prompt = (
        "你是一名气象分析专家 + 旅游建议助手。你必须严格基于我提供的未来天气数据进行分析，"
        "禁止凭空编造任何温度、降水、天气结论。输出必须包含："
        "1) 温度趋势分析；2) 简要总结；3) 是否推荐出行；4) 出行温馨提示（建议携带物品）。"
        "另外，请给出 4 个“景点推荐”的名称（尽量是维基百科词条名），并在最后追加一个 JSON："
        '{"places":["景点1","景点2","景点3","景点4"]}。只输出一个 JSON 对象。'
    )

    user_payload = {
        "question": user_question,
        "city": city,
        "forecast_source": forecast.get("source"),
        "location": forecast.get("location"),
        "daily_forecast": forecast.get("daily"),
    }

    url = f"{DOUBAO_BASE_URL.rstrip('/')}/chat/completions"
    headers = {"Authorization": f"Bearer {DOUBAO_API_KEY}", "Content-Type": "application/json"}
    body = {
        "model": DOUBAO_MODEL,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"基于以下JSON天气预报数据回答（只许使用其中数据）：\n{user_payload}"},
        ],
        "stream": False,
    }
    try:
        resp = requests.post(url, headers=headers, json=body, timeout=25)
        if resp.status_code != 200:
            return None
        payload = resp.json() or {}
        choices = payload.get("choices") or []
        if not choices:
            return None
        msg = choices[0].get("message") or {}
        content = str(msg.get("content") or "").strip()
        return content or None
    except Exception:
        return None


def _extract_places_from_text(text: str) -> List[str]:
    import json
    import re

    s = str(text or "")
    m = re.search(r"\{[\s\S]*?\}\s*$", s)
    if not m:
        return []
    tail = m.group(0)
    try:
        obj = json.loads(tail)
    except Exception:
        return []
    places = obj.get("places")
    if not isinstance(places, list):
        return []
    out = []
    for p in places:
        name = str(p or "").strip()
        if name:
            out.append(name[:80])
    return out[:6]


def _strip_trailing_json_object(text: str) -> str:
    import re

    s = str(text or "").rstrip()
    m = re.search(r"\n?\{[\s\S]*?\}\s*$", s)
    if not m:
        return s
    return s[: m.start()].rstrip()

def call_ollama_weather_assistant(*, user_question: str, forecast: Dict[str, Any], city: str) -> Optional[str]:
    if not OLLAMA_MODEL:
        return None

    system_prompt = (
        "你是一名气象分析专家 + 旅游建议助手。你必须严格基于我提供的未来天气数据进行分析，"
        "禁止凭空编造任何温度、降水、天气结论。输出必须包含："
        "1) 温度趋势分析；2) 简要总结；3) 是否推荐出行；4) 出行温馨提示（建议携带物品）。"
        "如果数据不足以回答，请明确说明需要哪些数据。"
    )

    user_payload = {
        "question": user_question,
        "city": city,
        "forecast_source": forecast.get("source"),
        "location": forecast.get("location"),
        "daily_forecast": forecast.get("daily"),
    }

    url = f"{OLLAMA_BASE_URL.rstrip('/')}/api/chat"
    body = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"基于以下JSON天气预报数据回答（只许使用其中数据）：\n{user_payload}"},
        ],
        "stream": False,
        "options": {"temperature": 0.2},
    }
    try:
        resp = requests.post(url, json=body, timeout=25)
        if resp.status_code != 200:
            return None
        payload = resp.json() or {}
        msg = payload.get("message") or {}
        content = str(msg.get("content") or "").strip()
        return content or None
    except Exception:
        return None


def _has_cjk(text: str) -> bool:
    import re

    return bool(re.search(r"[\u4e00-\u9fff]", str(text or "")))

def _is_bad_place_title(title: str) -> bool:
    t = str(title or "").strip().lower()
    if not t:
        return True
    bad = [
        "地铁",
        "铁路",
        "机场",
        "公交",
        "地图",
        "大学",
        "中学",
        "小学",
        "医院",
        "政府",
        "公司",
        "集团",
        "协会",
        "協會",
        "协定",
        "協定",
        "条约",
        "條約",
        "战役",
        "戰役",
        "事件",
        "惨案",
        "協議",
        "协议",
        "足球俱乐部",
        "足球俱樂部",
        "metro",
        "bus",
        "map",
        "airport",
        "railway",
        "university",
        "agreement",
        "treaty",
        "battle",
        "incident",
        "massacre",
        "fc ",
    ]
    return any(k in t for k in bad)


def _wiki_images_for_query(*, query: str, lang: str, max_items: int = 4, must_include: Optional[str] = None) -> List[Dict[str, str]]:
    q = str(query or "").strip()
    if not q:
        return []

    max_items = max(1, min(int(max_items or 4), 6))
    cache_key = f"{lang}|{q}"
    now = time.time()
    cached = _image_cache.get(cache_key)
    if cached and now < float(cached.get("expires_at") or 0):
        data = cached.get("data") or []
        return list(data)[:max_items]

    api = f"https://{lang}.wikipedia.org/w/api.php"
    headers = {"User-Agent": "global-weather-project/1.0 (local demo)"}
    try:
        resp = requests.get(
            api,
            params={
                "action": "query",
                "format": "json",
                "generator": "search",
                "gsrsearch": q,
                "gsrlimit": 8,
                "prop": "pageimages|info",
                "piprop": "thumbnail|original",
                "pithumbsize": 640,
                "inprop": "url",
                "redirects": 1,
                "utf8": 1,
            },
            headers=headers,
            timeout=4,
        )
        if resp.status_code != 200:
            return []
        payload = resp.json() or {}
        pages = (payload.get("query") or {}).get("pages") or {}
        if not pages:
            return []

        token = str(must_include or "").strip().lower()
        page_list: List[Dict[str, Any]] = [p for p in pages.values() if isinstance(p, dict)]
        page_list.sort(key=lambda p: int(p.get("index") or 10_000_000))

        out: List[Dict[str, str]] = []
        seen = set()
        for p in page_list:
            title = str(p.get("title") or "").strip()
            if not title:
                continue
            if token and token not in title.lower():
                continue
            img = (p.get("thumbnail") or {}).get("source") or (p.get("original") or {}).get("source")
            if not img or img in seen:
                continue
            seen.add(img)
            out.append(
                {
                    "title": title,
                    "url": str(img),
                    "page": str(p.get("fullurl") or ""),
                    "source": f"Wikipedia({lang})",
                }
            )
            if len(out) >= max_items:
                break

        if out:
            _image_cache[cache_key] = {"expires_at": now + 86400, "data": out}
        return out
    except Exception:
        return []


def recommend_images_for_query(user_question: str, *, city: str, places: Optional[List[str]] = None) -> List[Dict[str, str]]:
    items: List[Dict[str, str]] = []
    seen = set()

    place_list = [str(p).strip() for p in (places or []) if str(p).strip()]
    base_city = str(city or "").strip()
    city_zh = base_city if _has_cjk(base_city) else ""
    city_en = base_city if base_city and not _has_cjk(base_city) else ""
    try:
        predict = _load_root_predict_module()
        if hasattr(predict, "normalize_city_name") and base_city:
            norm = str(predict.normalize_city_name(base_city) or "").strip()
            if norm and not city_en:
                city_en = norm
            if norm and not city_zh and _has_cjk(base_city):
                city_zh = base_city
    except Exception:
        city_zh = city_zh
        city_en = city_en

    queries: List[str] = []
    queries.extend(place_list)
    if base_city:
        queries.append(f"{base_city} 景点")
        queries.append(f"{base_city} 著名景点")
        queries.append(f"{base_city} 旅游景点")
        queries.append(f"{base_city} 地标")
        queries.append(f"{base_city} 博物馆")
        queries.append(f"{base_city} 公园")
        queries.append(f"{base_city} 旅游")
        queries.append(f"{base_city} tourist attractions")
        queries.append(f"{base_city} landmarks")
        queries.append(f"{base_city} museum")
        queries.append(f"{base_city} park")
        queries.append(f"{base_city} Sehenswürdigkeiten")
        queries.append(base_city)

    dedup_queries: List[str] = []
    q_seen = set()
    for q in queries:
        qq = str(q or "").strip()
        if not qq:
            continue
        k = qq.lower()
        if k in q_seen:
            continue
        q_seen.add(k)
        dedup_queries.append(qq)

    prefer_zh = _has_cjk(base_city) or _has_cjk(user_question or "")
    langs = ["zh", "en"] if prefer_zh else ["de", "en"]

    tries = 0
    max_tries = 5
    for q in dedup_queries:
        for lang in langs:
            if tries >= max_tries:
                break
            must = None
            if lang == "zh" and city_zh:
                must = city_zh
            if lang != "zh" and city_en:
                must = city_en
            hits = _wiki_images_for_query(query=q, lang=lang, max_items=4, must_include=must)
            tries += 1
            for h in hits:
                url = str(h.get("url") or "")
                if not url or url in seen:
                    continue
                if _is_bad_place_title(str(h.get("title") or "")):
                    continue
                seen.add(url)
                items.append(h)
                if len(items) >= 4:
                    return items
        if tries >= max_tries:
            break

    text = (user_question or "") + " " + (city or "")
    text = text.lower()
    beijing_hits = any(k in text for k in ["beijing", "北京"])
    if not beijing_hits:
        return items[:4]

    return items[:4] or [
        {
            "title": "北京·故宫（神武门）",
            "url": "https://upload.wikimedia.org/wikipedia/commons/3/3e/Forbidden_City_Beijing_Shenwumen_Gate.JPG",
            "source": "Wikimedia Commons",
        },
        {
            "title": "北京·慕田峪长城",
            "url": "https://upload.wikimedia.org/wikipedia/commons/7/73/Great_%282832273633%29.jpg",
            "source": "Wikimedia Commons",
        },
        {
            "title": "北京·天坛",
            "url": "https://upload.wikimedia.org/wikipedia/commons/0/0f/Tiantan.jpg",
            "source": "Wikimedia Commons",
        },
        {
            "title": "北京·颐和园",
            "url": "https://upload.wikimedia.org/wikipedia/commons/9/9f/Summer_Palace_at_Beijing_21.jpg",
            "source": "Wikimedia Commons",
        },
    ]


def _corsify(resp):
    origin = request.headers.get("Origin", "*")
    resp.headers["Access-Control-Allow-Origin"] = origin
    resp.headers["Vary"] = "Origin"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


def _ai_assistant_chat_ui() -> str:
    return r"""
<style id="aiAssistantStyles">
  .ai-assistant-btn {
    position: fixed;
    top: 62px;
    left: 14px;
    z-index: 9999;
    width: 44px;
    height: 44px;
    border-radius: 999px;
    border: 1px solid rgba(110, 170, 255, 0.22);
    background: rgba(0, 0, 0, 0.16);
    color: rgba(235, 245, 255, 0.92);
    display: grid;
    place-items: center;
    cursor: pointer;
    backdrop-filter: blur(10px);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
  }
  .ai-assistant-btn:hover {
    border-color: rgba(86, 240, 255, 0.35);
    background: rgba(86, 240, 255, 0.06);
  }
  .ai-chat {
    position: fixed;
    top: 114px;
    left: 14px;
    z-index: 9999;
    width: min(420px, calc(100vw - 28px));
    height: min(560px, calc(100vh - 120px));
    border-radius: 14px;
    border: 1px solid rgba(110, 170, 255, 0.18);
    background: linear-gradient(180deg, rgba(10, 18, 35, 0.65), rgba(10, 18, 35, 0.30));
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
    backdrop-filter: blur(14px);
    display: none;
    overflow: hidden;
  }
  .ai-chat__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid rgba(110, 170, 255, 0.18);
  }
  .ai-chat__title {
    font-size: 12px;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: rgba(235, 245, 255, 0.78);
  }
  .ai-chat__close {
    width: 32px;
    height: 28px;
    border-radius: 10px;
    border: 1px solid rgba(110, 170, 255, 0.20);
    background: rgba(0, 0, 0, 0.12);
    color: rgba(235, 245, 255, 0.75);
    cursor: pointer;
  }
  .ai-chat__close:hover {
    border-color: rgba(110, 170, 255, 0.32);
    color: rgba(235, 245, 255, 0.92);
  }
  .ai-chat__messages {
    padding: 12px;
    height: calc(100% - 52px - 64px);
    overflow: auto;
    display: grid;
    gap: 10px;
  }
  .ai-msg {
    display: grid;
    gap: 6px;
  }
  .ai-msg__role {
    font-size: 11px;
    color: rgba(235, 245, 255, 0.55);
  }
  .ai-msg__bubble {
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid rgba(110, 170, 255, 0.16);
    background: rgba(0, 0, 0, 0.14);
    color: rgba(235, 245, 255, 0.92);
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .ai-msg--user .ai-msg__bubble {
    border-color: rgba(86, 240, 255, 0.22);
    background: rgba(86, 240, 255, 0.08);
  }
  .ai-chat__composer {
    padding: 10px 12px;
    border-top: 1px solid rgba(110, 170, 255, 0.18);
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 10px;
    align-items: center;
  }
  .ai-chat__input {
    height: 38px;
    border-radius: 12px;
    border: 1px solid rgba(110, 170, 255, 0.20);
    background: rgba(0, 0, 0, 0.12);
    color: rgba(235, 245, 255, 0.92);
    padding: 0 12px;
    outline: none;
    font-size: 13px;
  }
  .ai-chat__send {
    height: 38px;
    padding: 0 12px;
    border-radius: 12px;
    border: 1px solid rgba(110, 170, 255, 0.22);
    background: rgba(0, 0, 0, 0.10);
    color: rgba(235, 245, 255, 0.88);
    cursor: pointer;
    font-size: 13px;
  }
  .ai-chat__send:hover {
    border-color: rgba(86, 240, 255, 0.35);
    background: rgba(86, 240, 255, 0.06);
    color: rgba(235, 245, 255, 0.96);
  }
</style>

<button id="aiAssistantBtn" class="ai-assistant-btn" type="button" aria-label="AI智能助手">
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
    <path d="M12 2.5c-3.9 0-7 3.1-7 7v3.2c0 .7-.3 1.4-.8 1.9l-.7.7c-.3.3-.2.8.2 1l1.3.6c.4.2.7.6.7 1.1V20c0 .8.7 1.5 1.5 1.5H9.5c.6 0 1.1-.4 1.3-1l.2-.6h2l.2.6c.2.6.7 1 1.3 1h2.3c.8 0 1.5-.7 1.5-1.5v-1.4c0-.5.3-.9.7-1.1l1.3-.6c.4-.2.5-.7.2-1l-.7-.7c-.5-.5-.8-1.2-.8-1.9V9.5c0-3.9-3.1-7-7-7Z" stroke="currentColor" stroke-width="1.4"/>
    <path d="M9.2 11.2h.1M14.7 11.2h.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M9 14.5c1 .9 2.2 1.4 3.5 1.4s2.5-.5 3.5-1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  </svg>
</button>

<div id="aiChat" class="ai-chat" role="dialog" aria-label="AI智能助手">
  <div class="ai-chat__header">
    <div class="ai-chat__title">AI Assistant · Weather & Travel</div>
    <button id="aiChatClose" class="ai-chat__close" type="button">×</button>
  </div>
  <div id="aiChatMessages" class="ai-chat__messages"></div>
  <div class="ai-chat__composer">
    <input id="aiChatInput" class="ai-chat__input" placeholder="例如：帮我分析未来6天北京的温度，并告诉我是否适合旅游" />
    <button id="aiChatSend" class="ai-chat__send" type="button">发送</button>
  </div>
</div>

<script id="aiAssistantScript">
  (function () {
    const btn = document.getElementById("aiAssistantBtn");
    const chat = document.getElementById("aiChat");
    const closeBtn = document.getElementById("aiChatClose");
    const list = document.getElementById("aiChatMessages");
    const input = document.getElementById("aiChatInput");
    const sendBtn = document.getElementById("aiChatSend");

    function addMessage(role, text, images) {
      const wrap = document.createElement("div");
      wrap.className = "ai-msg" + (role === "user" ? " ai-msg--user" : "");

      const roleEl = document.createElement("div");
      roleEl.className = "ai-msg__role";
      roleEl.textContent = role === "user" ? "你" : "AI";

      const bubble = document.createElement("div");
      bubble.className = "ai-msg__bubble";
      bubble.textContent = text;

      wrap.appendChild(roleEl);
      wrap.appendChild(bubble);

      if (Array.isArray(images) && images.length) {
        const grid = document.createElement("div");
        grid.style.cssText = "display:grid;gap:10px;margin-top:8px";
        images.slice(0, 4).forEach((img) => {
          const card = document.createElement("a");
          card.href = String(img.url || "#");
          card.target = "_blank";
          card.rel = "noreferrer";
          card.style.cssText = "display:grid;gap:8px;text-decoration:none;color:inherit;border:1px solid rgba(110,170,255,0.16);border-radius:12px;overflow:hidden;background:rgba(0,0,0,0.10)";

          const pic = document.createElement("img");
          pic.src = String(img.url || "");
          pic.alt = String(img.title || "image");
          pic.loading = "lazy";
          pic.style.cssText = "width:100%;height:140px;object-fit:cover;display:block";

          const cap = document.createElement("div");
          cap.style.cssText = "padding:0 10px 10px 10px;font-size:12px;color:rgba(235,245,255,0.86);line-height:1.35";
          cap.textContent = String(img.title || "");

          card.appendChild(pic);
          card.appendChild(cap);
          grid.appendChild(card);
        });
        wrap.appendChild(grid);
      }

      list.appendChild(wrap);
      list.scrollTop = list.scrollHeight;
    }

    function setOpen(next) {
      chat.style.display = next ? "block" : "none";
      if (next) setTimeout(() => input && input.focus(), 0);
    }

    btn && btn.addEventListener("click", () => setOpen(chat.style.display !== "block"));
    closeBtn && closeBtn.addEventListener("click", () => setOpen(false));

    async function send() {
      const text = String(input.value || "").trim();
      if (!text) return;
      input.value = "";
      addMessage("user", text);
      addMessage("assistant", "正在查询天气并分析，请稍候…");

      try {
        const res = await fetch("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const payload = await res.json();
        const reply = String(payload.reply || "（无回复）");
        const images = payload.images || [];
        list.lastChild && list.removeChild(list.lastChild);
        addMessage("assistant", reply, images);
      } catch (e) {
        list.lastChild && list.removeChild(list.lastChild);
        addMessage("assistant", "请求失败：" + String(e));
      }
    }

    sendBtn && sendBtn.addEventListener("click", send);
    input && input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        send();
      }
    });

    addMessage("assistant", "你好！我可以结合未来天气给出温度趋势分析和出行建议。");

    (function () {
      let panelToken = 0;
      const nextToken = () => {
        panelToken += 1;
        return panelToken;
      };

      const origFetchAndFill = window.fetchAndFillRealtimeWeather;
      if (typeof origFetchAndFill === "function" && !origFetchAndFill.__gw_patched) {
        window.fetchAndFillRealtimeWeather = async function (meta) {
          const myToken = nextToken();
          const lat = Number(meta && meta.lat);
          const lon = Number(meta && meta.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            try {
              if (ui && ui.panelSource) ui.panelSource.textContent = "Data source: —";
            } catch (e) {}
            return;
          }

          try {
            const url = `${CONFIG.apiWeatherUrl}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&name=${encodeURIComponent(
              (meta && meta.name) || ""
            )}&country=${encodeURIComponent((meta && meta.country) || "")}`;
            const res = await fetch(url, { cache: "no-store" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const payload = await res.json();
            if (myToken !== panelToken) return;
            applyWeatherPayloadToPanel(payload, { countryEn: meta && meta.countryEn, countryZh: meta && meta.countryZh });
            if (meta && meta.pointMesh) applyWeatherPayloadToPoint(meta.pointMesh, payload);
          } catch (e) {
            if (myToken !== panelToken) return;
            try {
              if (ui && ui.panelSource) ui.panelSource.textContent = "Data source: —";
            } catch (e2) {}
          }
        };
        window.fetchAndFillRealtimeWeather.__gw_patched = true;
      }

      const origFillCountry = window.fillPanelFromCountryWeather;
      if (typeof origFillCountry === "function" && !origFillCountry.__gw_patched) {
        window.fillPanelFromCountryWeather = async function (countryCode, lat, lon) {
          const myToken = nextToken();
          const cc = String(countryCode || "").toUpperCase();
          const overrides = cc === "CN" ? { en: "China", zh: "中国" } : cc === "DE" ? { en: "Germany", zh: "德国" } : { en: cc, zh: "—" };

          try {
            ui.panelCountry.textContent = overrides.en;
            ui.panelCountryZh.textContent = `${overrides.zh}`;
            ui.panelTemp.textContent = "Loading…";
            ui.panelHumidity.textContent = "Loading…";
            ui.panelWeather.textContent = "Loading…";
            ui.panelSource.textContent = "Loading…";
          } catch (e) {}

          const latN = Number(lat);
          const lonN = Number(lon);
          if (!Number.isFinite(latN) || !Number.isFinite(lonN)) {
            if (myToken !== panelToken) return;
            try {
              ui.panelSource.textContent = "Data source: —";
            } catch (e) {}
            return;
          }

          try {
            const url = `${CONFIG.apiWeatherUrl}?lat=${encodeURIComponent(latN)}&lon=${encodeURIComponent(lonN)}&name=${encodeURIComponent(
              overrides.en
            )}&country=${encodeURIComponent(overrides.en)}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const payload = await res.json();
            if (myToken !== panelToken) return;
            applyWeatherPayloadToPanel(payload, { countryEn: overrides.en, countryZh: overrides.zh });
          } catch (e) {
            if (myToken !== panelToken) return;
            try {
              ui.panelSource.textContent = "Data source: —";
            } catch (e2) {}
          }
        };
        window.fillPanelFromCountryWeather.__gw_patched = true;
      }
    })();
  })();
</script>
"""


def _inject_ai_assistant_into_html(html: str) -> str:
    s = str(html or "")
    if "id=\"aiAssistantBtn\"" in s:
        return s
    insert = _ai_assistant_chat_ui()
    if "</body>" in s:
        return s.replace("</body>", insert + "\n</body>")
    return s + insert


@app.after_request
def after_request(resp):
    if str(request.path or "").startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return _corsify(resp)


# ==================== 页面路由 ====================

@app.route('/')
def index():
    """注册页面"""
    return render_template('index.html')


@app.route('/register', methods=['POST'])
def register():
    """处理注册"""
    username = request.form.get('username', '访客')
    session['username'] = username
    return redirect('/earth')


@app.route('/earth')
def earth():
    username = session.get('username', '访客')
    return redirect(f"/earth_module_demo?username={quote(username)}")


@app.route("/earth_module_demo")
def earth_module_demo():
    username = session.get("username", "访客")
    html = render_template("earth.html", username=username)
    html = _inject_ai_assistant_into_html(html)
    resp = make_response(html)
    resp.headers["Content-Type"] = "text/html; charset=utf-8"
    return resp


@app.route("/earth3d/frontend/<path:filename>")
def earth3d_frontend(filename: str):
    frontend_dir = os.path.join(EARTH2_PROJECT_PATH, "frontend")
    if filename == "main.js":
        file_path = os.path.join(frontend_dir, filename)
        if not os.path.exists(file_path):
            return "", 404
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        if "function formatCountryZhWithCity(" not in content:
            inject = (
                '\nconst REGION_ZH_NAMES = typeof Intl !== "undefined" && Intl.DisplayNames ? new Intl.DisplayNames(["zh-CN"], { type: "region" }) : null;\n'
                'function normalizeCountryZh(countryCode, countryZh, countryEn) {\n'
                '  const cc = String(countryCode || "").toUpperCase();\n'
                '  const zh = String(countryZh || "—");\n'
                '  const en = String(countryEn || "");\n'
                '  const hasCjk = /[\\u4e00-\\u9fff]/.test(zh);\n'
                '  if (hasCjk) return zh;\n'
                '  if (!REGION_ZH_NAMES) return zh;\n'
                '  if (!cc || cc.length !== 2) return zh;\n'
                '  const translated = REGION_ZH_NAMES.of(cc);\n'
                '  if (!translated) return zh;\n'
                '  if (zh === "—" || zh === en) return translated;\n'
                '  return translated;\n'
                '}\n'
                '\nconst CITY_EN_TO_ZH = {\n'
                '  Beijing: "北京",\n'
                '  Washington: "华盛顿",\n'
                '  Brasilia: "巴西利亚",\n'
                '  London: "伦敦",\n'
                '  Paris: "巴黎",\n'
                '  Moscow: "莫斯科",\n'
                '  "New Delhi": "新德里",\n'
                '  Tokyo: "东京",\n'
                '  Canberra: "堪培拉",\n'
                '  Singapore: "新加坡",\n'
                '  Pretoria: "比勒陀利亚",\n'
                '  Ottawa: "渥太华",\n'
                '  Berlin: "柏林",\n'
                '  Bielefeld: "比勒费尔德",\n'
                '};\n\n'
                'function formatCountryZhWithCity(countryZh, city, countryCode) {\n'
                '  const base = String(countryZh || "—");\n'
                '  const rawCity = String(city || "").trim();\n'
                '  if (!rawCity) return base;\n'
                '  const cc = String(countryCode || "").toUpperCase();\n'
                '  const cityZh = CITY_EN_TO_ZH[rawCity] || rawCity;\n'
                '  if (base === "—") return cityZh;\n'
                '  if (cc && cc !== "-99") return `${base}${cityZh}`;\n'
                '  return `${base}${cityZh}`;\n'
                '}\n'
            )

            needle = "const ui = {"
            idx = content.find(needle)
            if idx >= 0:
                end_idx = content.find("};", idx)
                if end_idx >= 0:
                    end_idx = content.find("\n", end_idx)
                    if end_idx >= 0:
                        content = content[:end_idx] + inject + content[end_idx:]

        if "function normalizeCountryZh(" not in content:
            inject = (
                '\nconst REGION_ZH_NAMES = typeof Intl !== "undefined" && Intl.DisplayNames ? new Intl.DisplayNames(["zh-CN"], { type: "region" }) : null;\n'
                'function normalizeCountryZh(countryCode, countryZh, countryEn) {\n'
                '  const cc = String(countryCode || "").toUpperCase();\n'
                '  const zh = String(countryZh || "—");\n'
                '  const en = String(countryEn || "");\n'
                '  const hasCjk = /[\\u4e00-\\u9fff]/.test(zh);\n'
                '  if (hasCjk) return zh;\n'
                '  if (!REGION_ZH_NAMES) return zh;\n'
                '  if (!cc || cc.length !== 2) return zh;\n'
                '  const translated = REGION_ZH_NAMES.of(cc);\n'
                '  if (!translated) return zh;\n'
                '  if (zh === "—" || zh === en) return translated;\n'
                '  return translated;\n'
                '}\n'
            )
            needle = "const ui = {"
            idx = content.find(needle)
            if idx >= 0:
                end_idx = content.find("};", idx)
                if end_idx >= 0:
                    end_idx = content.find("\n", end_idx)
                    if end_idx >= 0:
                        content = content[:end_idx] + inject + content[end_idx:]

        content = content.replace(
            "      country_zh: String(api?.country_zh || area.countryName || code),",
            "      country_zh: normalizeCountryZh(code, String(api?.country_zh || area.countryName || code), String(api?.country || area.countryName || code)),",
        )
        content = content.replace(
            "    const countryZh = String(item.country_zh || \"—\");",
            "    const countryZh = normalizeCountryZh(String(item.country_code || \"\").toUpperCase(), String(item.country_zh || \"—\"), countryEn);",
        )
        content = content.replace(
            "    const zh = String(item?.country_zh || countryNameOverrides[code]?.zh || \"—\");",
            "    const zh = normalizeCountryZh(code, String(item?.country_zh || countryNameOverrides[code]?.zh || \"—\"), en);",
        )
        content = content.replace(
            "    const zh = String(item.country_zh || \"—\");",
            "    const zh = normalizeCountryZh(cc, String(item.country_zh || \"—\"), en);",
        )
        content = content.replace(
            "  const countryZh = item.country_zh || (cc === \"CN\" ? \"中国\" : cc === \"DE\" ? \"德国\" : \"—\");",
            "  const countryZh = normalizeCountryZh(cc, item.country_zh || (cc === \"CN\" ? \"中国\" : cc === \"DE\" ? \"德国\" : \"—\"), countryEn);",
        )
        content = content.replace(
            "  const countryZh = ud.countryZh || \"—\";",
            "  const countryZh = normalizeCountryZh(cc, ud.countryZh || \"—\", countryEn);",
        )
        content = content.replace(
            "  const overrides = cc === \"CN\" ? { en: \"China\", zh: \"中国\" } : cc === \"DE\" ? { en: \"Germany\", zh: \"德国\" } : { en: cc, zh: \"—\" };",
            "  const overrides = cc === \"CN\" ? { en: \"China\", zh: \"中国\" } : cc === \"DE\" ? { en: \"Germany\", zh: \"德国\" } : { en: cc, zh: \"—\" };\n  overrides.zh = normalizeCountryZh(cc, overrides.zh, overrides.en);",
        )

        content = content.replace(
            "ui.panelCountryZh.textContent = `${countryZh}`;",
            "ui.panelCountryZh.textContent = `${countryZhLabel}`;",
        )
        content = content.replace(
            "ui.panelCountryZh.textContent = `${countryZh}` || \"—\";",
            "ui.panelCountryZh.textContent = `${countryZhLabel}` || \"—\";",
        )
        content = content.replace(
            "applyWeatherPayloadToPanel(payload, { countryEn, countryZh });",
            "applyWeatherPayloadToPanel(payload, { countryEn, countryZh: countryZhLabel });",
        )
        content = content.replace("\n    countryZh,\n", "\n    countryZh: countryZhLabel,\n")
        content = content.replace("\n  countryZh,\n", "\n  countryZh: countryZhLabel,\n")

        if "const countryZhLabel = formatCountryZhWithCity(countryZh, ud.city, cc);" not in content:
            content = content.replace(
                "  const countryZh = ud.countryZh || \"—\";\n",
                "  const countryZh = ud.countryZh || \"—\";\n  const countryZhLabel = formatCountryZhWithCity(countryZh, ud.city, cc);\n",
            )
        if "const countryZhLabel = formatCountryZhWithCity(countryZh, area.name, cc);" not in content:
            content = content.replace(
                "  const countryZh = cc === \"CN\" ? \"中国\" : cc === \"DE\" ? \"德国\" : \"—\";\n",
                "  const countryZh = cc === \"CN\" ? \"中国\" : cc === \"DE\" ? \"德国\" : \"—\";\n  const countryZhLabel = formatCountryZhWithCity(countryZh, area.name, cc);\n",
            )
        if "const countryZhLabel = formatCountryZhWithCity(countryZh, item.city, cc);" not in content:
            content = content.replace(
                "  const countryZh = item.country_zh || (cc === \"CN\" ? \"中国\" : cc === \"DE\" ? \"德国\" : \"—\");\n",
                "  const countryZh = item.country_zh || (cc === \"CN\" ? \"中国\" : cc === \"DE\" ? \"德国\" : \"—\");\n  const countryZhLabel = formatCountryZhWithCity(countryZh, item.city, cc);\n",
            )

        resp = make_response(content)
        resp.headers["Content-Type"] = "application/javascript"
        return resp

    if filename.endswith(".html"):
        file_path = os.path.join(frontend_dir, filename)
        if not os.path.exists(file_path):
            return "", 404
        with open(file_path, "r", encoding="utf-8") as f:
            html = f.read()

        if "id=\"aiAssistantBtn\"" not in html:
            html = _inject_ai_assistant_into_html(html)

        resp = make_response(html)
        resp.headers["Content-Type"] = "text/html; charset=utf-8"
        return resp

    return send_from_directory(frontend_dir, filename)


@app.route("/earth3d/assets/<path:filename>")
def earth3d_assets(filename: str):
    assets_dir = os.path.join(EARTH2_PROJECT_PATH, "assets")
    return send_from_directory(assets_dir, filename)


@app.route('/earth_module/<path:filename>')
def earth_module_static(filename):
    """提供 earth_module 的静态文件"""
    frontend_dir = os.path.join(EARTH_MODULE_DIR, "frontend")
    return send_from_directory(frontend_dir, filename)


@app.route("/earth_module/assets/<path:filename>")
def earth_module_assets(filename: str):
    assets_dir = os.path.join(EARTH_MODULE_DIR, "assets")
    return send_from_directory(assets_dir, filename)


@app.route('/history')
def history():
    """历史预测页面"""
    username_arg = request.args.get('username')
    if username_arg:
        session['username'] = username_arg
    username = session.get('username', '访客')
    city = request.args.get('city', 'Beijing')
    
    chart_html = ""
    error_msg = ""
    try:
        predict = _load_root_predict_module()
        city_key = str(city or "").strip()
        if hasattr(predict, "normalize_city_name"):
            try:
                city_key = str(predict.normalize_city_name(city_key) or city_key).strip()
            except Exception:
                pass

        os.makedirs(FORECASTS_DIR, exist_ok=True)
        forecast_file = os.path.join(FORECASTS_DIR, f"{city_key}_forecast.html")
        if city_key and os.path.exists(forecast_file):
            with open(forecast_file, "r", encoding="utf-8") as f:
                chart_html = f.read()
        elif hasattr(predict, 'plot_combined_forecast'):
            chart_html = predict.plot_combined_forecast(city)
            if city_key and chart_html and "<div" in chart_html:
                try:
                    with open(forecast_file, "w", encoding="utf-8") as f:
                        f.write(chart_html)
                except Exception:
                    pass
        else:
            chart_html = '<div class="error-box">⚠️ 预测函数未实现</div>'
    except Exception as e:
        chart_html = f'<div class="error-box">❌ 加载失败: {str(e)}</div>'
        error_msg = str(e)
    
    return render_template('history.html',
                           username=username,
                           city=city,
                           chart_html=chart_html,
                           error_msg=error_msg)

@app.route('/assets/<path:filename>')
def assets_files(filename):
    """提供 earth_module/assets 中的文件"""
    assets_dir = os.path.join(EARTH_MODULE_DIR, "assets")
    return send_from_directory(assets_dir, filename)


# ==================== API 路由（保持不变） ====================

@app.route("/chat", methods=["POST", "OPTIONS"])
def chat():
    if request.method == "OPTIONS":
        return _corsify(make_response("", 204))

    body = request.get_json(silent=True) or {}
    message = (body.get("message") if isinstance(body, dict) else "") or ""
    message = str(message).strip()
    if not message:
        return jsonify({"error": "Missing message"}), 400

    meta = extract_city_and_days(message)
    city = meta["city"]
    days = meta["days"]

    forecast = fetch_city_forecast_daily(city=city, days=days)
    if not city:
        return jsonify({"reply": "请在问题里带上城市名（例如：北京/上海/广州），我才能生成预测分析。", "images": []}), 200

    doubao_reply = call_doubao_weather_assistant(user_question=message, forecast=forecast, city=city)
    if doubao_reply:
        places = _extract_places_from_text(doubao_reply)
        images = recommend_images_for_query(message, city=city, places=places)
        return jsonify({"reply": _strip_trailing_json_object(doubao_reply), "source": "doubao", "images": images}), 200

    images = recommend_images_for_query(message, city=city)
    reply = build_offline_weather_travel_advice(user_question=message, forecast=forecast, city=city)
    if str(forecast.get("source") or "").startswith("open-meteo-cache"):
        reply = "提示：外部天气接口当前限流，本次使用缓存数据生成分析。\n\n" + reply
    if str(forecast.get("source") or "") == "local-simulated":
        reply = "提示：外部天气接口当前不可用或限流，本次使用本地模拟预测生成趋势分析（非实时观测）。\n\n" + reply
    return jsonify({"reply": reply, "source": "offline", "images": images}), 200

@app.route("/api/temperature", methods=["GET", "OPTIONS"])
def api_temperature():
    if request.method == "OPTIONS":
        return _corsify(make_response("", 204))

    allow_cache = str(request.args.get("allow_cache") or request.args.get("cache") or "").strip() == "1"
    now = time.time()
    if allow_cache and _cache["data"] is not None and now < float(_cache["expires_at"]):
        return jsonify(_cache["data"])

    data = get_temperature_data()
    if allow_cache:
        _cache["data"] = data
        _cache["expires_at"] = now + CACHE_TTL_SECONDS
    return jsonify(data)


@app.route("/api/weather", methods=["GET", "OPTIONS"])
def api_weather():
    if request.method == "OPTIONS":
        return _corsify(make_response("", 204))

    allow_cache = str(request.args.get("allow_cache") or request.args.get("cache") or "").strip() == "1"
    lat = request.args.get("lat", type=float)
    lon = request.args.get("lon", type=float)
    name = request.args.get("name", default="", type=str)
    country = request.args.get("country", default="", type=str)

    if lat is None or lon is None:
        return jsonify({"error": "Missing lat/lon"}), 400

    cache_key = f"{lat:.4f},{lon:.4f}"
    cached = _weather_cache["by_coord"].get(cache_key)
    now = time.time()
    if allow_cache and cached and now < float(cached["expires_at"]):
        return jsonify(cached["data"])

    session_req = requests.Session()
    uvi = fetch_open_meteo_uvi(session_req=session_req, lat=lat, lon=lon)

    if OPENWEATHER_API_KEY:
        weather = fetch_weather_by_coord(session_req=session_req, lat=lat, lon=lon, api_key=OPENWEATHER_API_KEY)
        if weather is None:
            weather = fetch_open_meteo_current(session_req=session_req, lat=lat, lon=lon)
            source = "open-meteo"
        else:
            source = "openweather"
    else:
        weather = fetch_open_meteo_current(session_req=session_req, lat=lat, lon=lon)
        source = "open-meteo"

    if weather is None:
        weather = _synthetic_current_weather(lat=lat, lon=lon)
        source = "local-simulated"

    payload = {
        "name": name,
        "country": country,
        "lat": float(weather["lat"]),
        "lon": float(weather["lon"]),
        "temperature": float(weather["temperature"]),
        "humidity": int(weather["humidity"]),
        "weather": str(weather["weather"]),
        "wind_speed": float(weather["wind_speed"]),
        "wind_deg": int(weather["wind_deg"]),
        "uvi": float(uvi) if uvi is not None else None,
        "source": source,
    }
    if allow_cache:
        _weather_cache["by_coord"][cache_key] = {"expires_at": now + CACHE_TTL_SECONDS, "data": payload}
    return jsonify(payload)


@app.route("/api/weather_bulk", methods=["POST", "OPTIONS"])
def api_weather_bulk():
    if request.method == "OPTIONS":
        return _corsify(make_response("", 204))

    body = request.get_json(silent=True) or {}
    locations = body.get("locations") if isinstance(body, dict) else body
    if not isinstance(locations, list) or len(locations) == 0:
        return jsonify({"error": "Missing locations"}), 400

    cleaned = []
    for loc in locations:
        if not isinstance(loc, dict):
            continue
        lat = loc.get("lat")
        lon = loc.get("lon")
        if lat is None or lon is None:
            continue
        try:
            lat_f = float(lat)
            lon_f = float(lon)
        except Exception:
            continue
        cleaned.append(
            {
                "id": str(loc.get("id") or ""),
                "lat": lat_f,
                "lon": lon_f,
            }
        )

    if len(cleaned) == 0:
        return jsonify({"error": "No valid locations"}), 400

    out: List[Dict[str, Any]] = []
    for c in cleaned:
        row = _synthetic_current_weather(lat=c["lat"], lon=c["lon"])
        out.append(
            {
                "id": c["id"],
                "lat": float(row["lat"]),
                "lon": float(row["lon"]),
                "temperature": float(row["temperature"]),
                "humidity": int(row["humidity"]),
                "weather": str(row["weather"]),
                "wind_speed": float(row["wind_speed"]),
                "wind_deg": int(row["wind_deg"]),
                "source": "local-simulated",
            }
        )

    return jsonify({"results": out})


# ==================== 数据获取函数 ====================

def get_temperature_data() -> List[Dict[str, Any]]:
    cities = get_capital_city_list()
    results: List[Dict[str, Any]] = []
    session_req = requests.Session()

    for item in cities:
        city_name = item["city_en"]
        country_code = item.get("country_code", "")

        weather: Optional[Dict[str, Any]] = None
        source = "open-meteo"

        if OPENWEATHER_API_KEY:
            weather = fetch_city_weather(
                session_req=session_req,
                city=city_name,
                country_code=country_code,
                api_key=OPENWEATHER_API_KEY,
            )
            source = "openweather"

        if weather is None:
            weather = fetch_open_meteo_current(session_req=session_req, lat=item["lat"], lon=item["lon"])
            source = "open-meteo"

        if weather is None:
            weather = _synthetic_current_weather(lat=item["lat"], lon=item["lon"])
            source = "local-simulated"

        results.append(
            {
                "country": item["country_en"],
                "country_zh": item["country_zh"],
                "country_code": item.get("country_code", ""),
                "city": item["city_en"],
                "lat": float(weather["lat"]),
                "lon": float(weather["lon"]),
                "temperature": float(weather["temperature"]),
                "humidity": int(weather["humidity"]),
                "weather": str(weather["weather"]),
                "wind_speed": float(weather["wind_speed"]),
                "wind_deg": int(weather["wind_deg"]),
                "source": source,
            }
        )

    return results


def fetch_city_weather(
    *,
    session_req: requests.Session,
    city: str,
    country_code: str,
    api_key: str,
) -> Optional[Dict[str, Any]]:
    q = city if not country_code else f"{city},{country_code}"
    params = {"q": q, "appid": api_key, "units": "metric"}
    try:
        resp = session_req.get(OPENWEATHER_BASE_URL, params=params, timeout=8)
        if resp.status_code != 200:
            return None
        payload = resp.json()
        return {
            "lat": payload["coord"]["lat"],
            "lon": payload["coord"]["lon"],
            "temperature": payload["main"]["temp"],
            "humidity": payload["main"]["humidity"],
            "weather": payload["weather"][0]["main"] if payload.get("weather") else "Unknown",
            "wind_speed": payload.get("wind", {}).get("speed", 0.0),
            "wind_deg": payload.get("wind", {}).get("deg", 0),
        }
    except Exception:
        return None


def fetch_weather_by_coord(
    *,
    session_req: requests.Session,
    lat: float,
    lon: float,
    api_key: str,
) -> Optional[Dict[str, Any]]:
    params = {"lat": lat, "lon": lon, "appid": api_key, "units": "metric"}
    try:
        resp = session_req.get(OPENWEATHER_BASE_URL, params=params, timeout=8)
        if resp.status_code != 200:
            return None
        payload = resp.json()
        return {
            "lat": payload["coord"]["lat"],
            "lon": payload["coord"]["lon"],
            "temperature": payload["main"]["temp"],
            "humidity": payload["main"]["humidity"],
            "weather": payload["weather"][0]["main"] if payload.get("weather") else "Unknown",
            "wind_speed": payload.get("wind", {}).get("speed", 0.0),
            "wind_deg": payload.get("wind", {}).get("deg", 0),
        }
    except Exception:
        return None


def fetch_open_meteo_current(*, session_req: requests.Session, lat: float, lon: float) -> Optional[Dict[str, Any]]:
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m",
        "timezone": "auto",
    }
    try:
        resp = session_req.get(url, params=params, timeout=4)
        if resp.status_code != 200:
            return None
        payload = resp.json()
        cur = payload.get("current") or {}
        if not cur:
            return fetch_open_meteo_current_from_hourly(session_req=session_req, lat=lat, lon=lon)
        code = int(cur.get("weather_code", 0))
        return {
            "lat": float(payload.get("latitude", lat)),
            "lon": float(payload.get("longitude", lon)),
            "temperature": float(cur.get("temperature_2m")),
            "humidity": float(cur.get("relative_humidity_2m")),
            "weather": weather_code_to_openweather_main(code),
            "wind_speed": float(cur.get("wind_speed_10m", 0.0)),
            "wind_deg": float(cur.get("wind_direction_10m", 0.0)),
        }
    except Exception:
        return None


def fetch_open_meteo_current_from_hourly(*, session_req: requests.Session, lat: float, lon: float) -> Optional[Dict[str, Any]]:
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m",
        "timezone": "auto",
    }
    try:
        resp = session_req.get(url, params=params, timeout=4)
        if resp.status_code != 200:
            return None
        payload = resp.json()
        hourly = payload.get("hourly") or {}
        temps = hourly.get("temperature_2m") or []
        hums = hourly.get("relative_humidity_2m") or []
        codes = hourly.get("weather_code") or []
        ws = hourly.get("wind_speed_10m") or []
        wd = hourly.get("wind_direction_10m") or []
        if not temps:
            return None
        idx = 0
        code = int(codes[idx]) if idx < len(codes) else 0
        return {
            "lat": float(payload.get("latitude", lat)),
            "lon": float(payload.get("longitude", lon)),
            "temperature": float(temps[idx]),
            "humidity": float(hums[idx]) if idx < len(hums) else 0.0,
            "weather": weather_code_to_openweather_main(code),
            "wind_speed": float(ws[idx]) if idx < len(ws) else 0.0,
            "wind_deg": float(wd[idx]) if idx < len(wd) else 0.0,
        }
    except Exception:
        return None


def _synthetic_current_weather(*, lat: float, lon: float) -> Dict[str, Any]:
    import math
    import random

    lat_f = float(lat)
    lon_f = float(lon)
    now = time.time()
    day_of_year = int((now // 86400) % 365)
    hour = int((now % 86400) // 3600)
    seed = int((lat_f * 1000) // 1) * 1000003 + int((lon_f * 1000) // 1) * 1009 + day_of_year * 37
    rng = random.Random(seed)

    lat_rad = lat_f * math.pi / 180.0
    base = 28.0 - abs(lat_f) * 0.35
    seasonal = 7.5 * math.sin((day_of_year / 365.0) * 2.0 * math.pi) * math.cos(lat_rad)
    diurnal = 3.5 * math.sin(((hour - 14) / 24.0) * 2.0 * math.pi)
    noise = rng.uniform(-1.2, 1.2)
    temp = base + seasonal + diurnal + noise

    hum = 55.0 + 20.0 * math.cos(lat_rad) + rng.uniform(-8.0, 8.0)
    hum = max(15.0, min(95.0, hum))

    wind_speed = max(0.2, rng.gauss(3.2, 1.2))
    wind_deg = float((rng.random() * 360.0) // 1)

    weather = "Clear"
    if hum >= 80:
        weather = "Rain"
    elif hum >= 65:
        weather = "Clouds"

    return {
        "lat": lat_f,
        "lon": lon_f,
        "temperature": float(max(-25.0, min(45.0, temp))),
        "humidity": float(hum),
        "weather": weather,
        "wind_speed": float(wind_speed),
        "wind_deg": float(wind_deg),
    }


def fetch_open_meteo_uvi(*, session_req: requests.Session, lat: float, lon: float) -> Optional[float]:
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": "uv_index",
        "timezone": "auto",
    }
    try:
        resp = session_req.get(url, params=params, timeout=4)
        if resp.status_code != 200:
            return None
        payload = resp.json()
        hourly = payload.get("hourly") or {}
        uvs = hourly.get("uv_index") or []
        if not uvs:
            return None
        return float(uvs[0])
    except Exception:
        return None


def weather_code_to_openweather_main(code: int) -> str:
    if code == 0:
        return "Clear"
    if code in (1, 2, 3):
        return "Clouds"
    if code in (45, 48):
        return "Fog"
    if 51 <= code <= 67:
        return "Rain"
    if 71 <= code <= 77:
        return "Snow"
    if 80 <= code <= 82:
        return "Rain"
    if 85 <= code <= 86:
        return "Snow"
    if 95 <= code <= 99:
        return "Rain"
    return "Clouds"


def fetch_open_meteo_current_multi(
    *,
    session_req: requests.Session,
    lat_list: List[float],
    lon_list: List[float],
) -> List[Dict[str, Any]]:
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": ",".join([str(x) for x in lat_list]),
        "longitude": ",".join([str(x) for x in lon_list]),
        "current": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m",
        "timezone": "auto",
    }

    resp = session_req.get(url, params=params, timeout=6)
    if resp.status_code != 200:
        raise RuntimeError("Open-Meteo request failed")
    payload = resp.json()
    items = payload if isinstance(payload, list) else [payload]

    out = []
    for i in range(min(len(items), len(lat_list))):
        it = items[i] if isinstance(items[i], dict) else {}
        cur = it.get("current") or {}
        code = int(cur.get("weather_code", 0) or 0)
        out.append(
            {
                "lat": float(it.get("latitude", lat_list[i])),
                "lon": float(it.get("longitude", lon_list[i])),
                "temperature": float(cur.get("temperature_2m")),
                "humidity": float(cur.get("relative_humidity_2m")),
                "weather": weather_code_to_openweather_main(code),
                "wind_speed": float(cur.get("wind_speed_10m", 0.0) or 0.0),
                "wind_deg": float(cur.get("wind_direction_10m", 0.0) or 0.0),
            }
        )
    return out


def get_capital_city_list() -> List[Dict[str, Any]]:
    return [
        {"country_en": "China", "country_zh": "中国", "country_code": "CN", "city_en": "Beijing", "lat": 39.9042, "lon": 116.4074,
         "sample_temperature": 18.0, "sample_humidity": 35, "sample_weather": "Clear", "sample_wind_speed": 2.8, "sample_wind_deg": 40},
        {"country_en": "United States", "country_zh": "美国", "country_code": "US", "city_en": "Washington", "lat": 38.9072, "lon": -77.0369,
         "sample_temperature": 22.0, "sample_humidity": 50, "sample_weather": "Clouds", "sample_wind_speed": 3.6, "sample_wind_deg": 210},
        {"country_en": "Brazil", "country_zh": "巴西", "country_code": "BR", "city_en": "Brasilia", "lat": -15.7939, "lon": -47.8828,
         "sample_temperature": 29.0, "sample_humidity": 62, "sample_weather": "Rain", "sample_wind_speed": 4.2, "sample_wind_deg": 160},
        {"country_en": "United Kingdom", "country_zh": "英国", "country_code": "GB", "city_en": "London", "lat": 51.5072, "lon": -0.1276,
         "sample_temperature": 12.0, "sample_humidity": 70, "sample_weather": "Clouds", "sample_wind_speed": 5.1, "sample_wind_deg": 260},
        {"country_en": "France", "country_zh": "法国", "country_code": "FR", "city_en": "Paris", "lat": 48.8566, "lon": 2.3522,
         "sample_temperature": 14.0, "sample_humidity": 60, "sample_weather": "Clouds", "sample_wind_speed": 4.8, "sample_wind_deg": 240},
        {"country_en": "Russia", "country_zh": "俄罗斯", "country_code": "RU", "city_en": "Moscow", "lat": 55.7558, "lon": 37.6173,
         "sample_temperature": 3.0, "sample_humidity": 65, "sample_weather": "Snow", "sample_wind_speed": 6.2, "sample_wind_deg": 300},
        {"country_en": "India", "country_zh": "印度", "country_code": "IN", "city_en": "New Delhi", "lat": 28.6139, "lon": 77.2090,
         "sample_temperature": 33.0, "sample_humidity": 40, "sample_weather": "Haze", "sample_wind_speed": 2.2, "sample_wind_deg": 120},
        {"country_en": "Japan", "country_zh": "日本", "country_code": "JP", "city_en": "Tokyo", "lat": 35.6762, "lon": 139.6503,
         "sample_temperature": 19.0, "sample_humidity": 55, "sample_weather": "Clear", "sample_wind_speed": 3.0, "sample_wind_deg": 80},
        {"country_en": "Australia", "country_zh": "澳大利亚", "country_code": "AU", "city_en": "Canberra", "lat": -35.2809, "lon": 149.1300,
         "sample_temperature": 24.0, "sample_humidity": 45, "sample_weather": "Clear", "sample_wind_speed": 4.0, "sample_wind_deg": 200},
        {"country_en": "Singapore", "country_zh": "新加坡", "country_code": "SG", "city_en": "Singapore", "lat": 1.3521, "lon": 103.8198,
         "sample_temperature": 31.0, "sample_humidity": 70, "sample_weather": "Clouds", "sample_wind_speed": 3.5, "sample_wind_deg": 160},
        {"country_en": "South Africa", "country_zh": "南非", "country_code": "ZA", "city_en": "Pretoria", "lat": -25.7479, "lon": 28.2293,
         "sample_temperature": 27.0, "sample_humidity": 35, "sample_weather": "Clear", "sample_wind_speed": 4.6, "sample_wind_deg": 140},
        {"country_en": "Canada", "country_zh": "加拿大", "country_code": "CA", "city_en": "Ottawa", "lat": 45.4215, "lon": -75.6972,
         "sample_temperature": -2.0, "sample_humidity": 75, "sample_weather": "Snow", "sample_wind_speed": 5.4, "sample_wind_deg": 330},
        {"country_en": "Germany", "country_zh": "德国", "country_code": "DE", "city_en": "Berlin", "lat": 52.5200, "lon": 13.4050,
         "sample_temperature": 12.0, "sample_humidity": 65, "sample_weather": "Clouds", "sample_wind_speed": 4.2, "sample_wind_deg": 240},
        {"country_en": "Germany", "country_zh": "德国", "country_code": "DE", "city_en": "Bielefeld", "lat": 52.0302, "lon": 8.5325,
         "sample_temperature": 11.0, "sample_humidity": 70, "sample_weather": "Clouds", "sample_wind_speed": 4.8, "sample_wind_deg": 260},
    ]


if __name__ == '__main__':
    app.run(debug=True, port=5000)
