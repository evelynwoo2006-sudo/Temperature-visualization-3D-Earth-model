# test_api.py
import requests
import json

# 测试温度接口
print("测试 /api/temperature...")
try:
    resp = requests.get("http://127.0.0.1:5000/api/temperature", timeout=5)
    print(f"状态码: {resp.status_code}")
    if resp.status_code == 200:
        data = resp.json()
        print(f"返回 {len(data)} 个城市数据")
        if len(data) > 0:
            print(f"示例: {data[0]['city']} - {data[0]['temperature']}°C")
    else:
        print(f"失败: {resp.text}")
except Exception as e:
    print(f"连接失败: {e}")

# 测试天气接口
print("\n测试 /api/weather...")
try:
    resp = requests.get("http://127.0.0.1:5000/api/weather?lat=39.9042&lon=116.4074", timeout=5)
    print(f"状态码: {resp.status_code}")
    if resp.status_code == 200:
        print(f"数据: {resp.json()}")
    else:
        print(f"失败: {resp.text}")
except Exception as e:
    print(f"连接失败: {e}")