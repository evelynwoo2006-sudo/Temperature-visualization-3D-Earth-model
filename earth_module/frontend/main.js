// 说明：
// - 该文件使用原生 HTML + CSS + JS，通过 CDN script 标签引入 Three.js（无构建工具）
// - 交互：Raycaster hover 数据点 -> tooltip + 国家边界高亮；click 数据点 -> 相机平滑聚焦 + 右侧信息卡片
// - 数据：优先请求 Flask API（/api/temperature），失败则使用前端示例数据
const CONFIG = {
  apiUrl: "earth_module/assets/temperature.json",
  apiWeatherUrl: "api/weather",
  refreshIntervalMs: 30000,
  earthRadius: 2.2,
  earthSegments: 64,
  pointsAltitude: 0.04,
  borderAltitude: 0.012,
  starsCount: 2500,
  cameraDistance: 7.5,
  focusDistance: 3.2,
  focusZoomDistance: 5.0,
  focusDurationMs: 950,
};

const ui = {
  statusText: document.getElementById("statusText"),
  backendBadge: document.getElementById("backendBadge"),
  tooltip: document.getElementById("tooltip"),
  searchInput: document.getElementById("searchInput"),
  searchClear: document.getElementById("searchClear"),
  searchResults: document.getElementById("searchResults"),
  moreDataLink: document.getElementById("moreDataLink"),
  panelCountry: document.getElementById("panelCountry"),
  panelCountryZh: document.getElementById("panelCountryZh"),
  panelTemp: document.getElementById("panelTemp"),
  panelHumidity: document.getElementById("panelHumidity"),
  panelWeather: document.getElementById("panelWeather"),
  panelSource: document.getElementById("panelSource"),
};

let autoRefreshTimer = null;

const CITY_EN_TO_ZH = {
  Beijing: "北京",
  Washington: "华盛顿",
  Brasilia: "巴西利亚",
  London: "伦敦",
  Paris: "巴黎",
  Moscow: "莫斯科",
  "New Delhi": "新德里",
  Tokyo: "东京",
  Canberra: "堪培拉",
  Singapore: "新加坡",
  Pretoria: "比勒陀利亚",
  Ottawa: "渥太华",
};

function formatCountryZhWithCity(countryZh, city, countryCode) {
  const base = String(countryZh || "—");
  const rawCity = String(city || "").trim();
  if (!rawCity) return base;
  const cc = String(countryCode || "").toUpperCase();
  const cityZh = CITY_EN_TO_ZH[rawCity] || rawCity;
  if (base === "—") return cityZh;
  if (cc && cc !== "-99") return `${base}${cityZh}`;
  return `${base}${cityZh}`;
}

let renderer;
let scene;
let camera;
let orbit;
let raycaster;
let mouseNdc;
let clock;

let earthGroup;
let earthMesh;
let atmosphereMesh;
let pointsGroup;
let bordersGroup;
let subBordersGroup;
let stars;
let backLight;

let hoverPoint = null;
let selectedPoint = null;
let lastPointerEvent = { clientX: 0, clientY: 0 };
let isFocusing = false;

const countryBorderIndex = new Map();
let currentHighlightedBorder = null;
let countryAreas = [];
let hoverCountryKeyFromSurface = null;
let activeCountryKey = null;
let subregionAreasByCountry = { CN: [], DE: [] };
const subregionBorderIndex = new Map();
let currentHighlightedSubBorder = null;
let hoverSubregionFromSurface = null;
let isSelectionLocked = false;
let lockedCountryKey = null;
let lockedSubregionKey = null;

let latestTemperaturePayload = [];
let searchIndex = [];
let activeSearchResults = [];
let subregionByKey = new Map();
let countryByCode = new Map();

const EARTH_AUTO_ROTATE_BASE = 0.0012;
const EARTH_AUTO_ROTATE_HOVER_FACTOR = 0.5; // 鼠标悬停时速度减小 50%
let earthAutoRotateSpeed = EARTH_AUTO_ROTATE_BASE;
let targetAutoRotateSpeed = EARTH_AUTO_ROTATE_BASE; // 目标速度，用于平滑过渡
const ROTATE_SPEED_DAMPING = 0.05; // 速度过渡阻尼系数

// 先完成异步初始化（纹理/GeoJSON/API 拉取），再开始渲染循环，避免初始化失败导致动画循环报错
init()
  .then(() => {
    animate();
  })
  .catch((e) => {
    ui.statusText.textContent = "Init failed";
    ui.backendBadge.textContent = "API: —";
    console.error(e);
  });

async function init() {
  const canvas = document.getElementById("threeCanvas");

  // 渲染器：开启 antialias 提升画面质量，同时限制 pixelRatio 避免高 DPI 设备过度消耗性能
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 0, CONFIG.cameraDistance);

  // 自研轻量 Orbit 控制（避免外部 OrbitControls 脚本在部分环境被浏览器拦截）
  orbit = createOrbitController(camera, renderer.domElement, {
    target: new THREE.Vector3(0, 0, 0),
    minDistance: 3.2,
    maxDistance: 12,
    rotateSpeed: 0.0058,
    zoomSpeed: 0.0028,
    damping: 0.12,
    minPolarAngle: 0.25,
    maxPolarAngle: Math.PI - 0.25,
  });
  orbit.syncFromCamera();

  raycaster = new THREE.Raycaster();
  raycaster.params.Points = { threshold: 0.08 };
  mouseNdc = new THREE.Vector2();
  clock = new THREE.Clock();

  // 组装场景
  buildGroups();
  buildLights();
  buildStars();
  buildEarth();
  buildAtmosphere();
  bindEvents();

  ui.statusText.textContent = "Loading borders…";
  ui.backendBadge.textContent = "API: connecting…";

  await loadBorders();
  await loadSubregionBorders();
  await loadTemperaturePoints();

  buildSearchIndex();
  bindSearchEvents();
  bindMoreDataLink();

  ui.statusText.textContent = "Ready";
  startAutoRefresh();
}

function buildNoCacheUrl(url) {
  try {
    const u = new URL(String(url || ""), window.location.href);
    u.searchParams.set("cache", "0");
    u.searchParams.set("t", String(Date.now()));
    return u.toString();
  } catch (e) {
    const s = String(url || "");
    const sep = s.includes("?") ? "&" : "?";
    return `${s}${sep}cache=0&t=${Date.now()}`;
  }
}

function startAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  const intervalMs = Math.max(8000, Number(CONFIG.refreshIntervalMs || 0) || 30000);
  refreshAllPoints().catch(() => {});
  autoRefreshTimer = setInterval(() => {
    refreshAllPoints().catch(() => {});
  }, intervalMs);
}

async function refreshAllPoints() {
  await syncRealtimeForAllPointsBulk();
  if (selectedPoint) refreshPanelFromSelectedPoint();
}

function refreshPanelFromSelectedPoint() {
  if (!selectedPoint?.userData) return;
  const ud = selectedPoint.userData;
  const cc = String(ud.countryCode || "").toUpperCase();
  const countryEn = ud.countryEn || "—";
  const countryZh = ud.countryZh || "—";
  const countryZhLabel = formatCountryZhWithCity(countryZh, ud.city, cc);
  applyWeatherPayloadToPanel(
    {
      temperature: ud.temperature,
      humidity: ud.humidity,
      weather: ud.weather,
      wind_speed: ud.windSpeed,
      wind_deg: ud.windDeg,
      source: ud.source,
    },
    { countryEn, countryZh: countryZhLabel }
  );
}

function bindMoreDataLink() {
  if (!ui.moreDataLink) return;
  const username = new URLSearchParams(window.location.search).get("username") || "Guest";
  ui.moreDataLink.href = `/history?username=${encodeURIComponent(username)}`;
}

function buildGroups() {
  // 所有地球相关对象放在同一组内：便于整体旋转
  earthGroup = new THREE.Group();
  scene.add(earthGroup);

  // 国家边界线与数据点分别用 Group 管理，便于后续单独控制与清理
  pointsGroup = new THREE.Group();
  bordersGroup = new THREE.Group();
  subBordersGroup = new THREE.Group();
  subBordersGroup.visible = false;
  earthGroup.add(bordersGroup);
  earthGroup.add(subBordersGroup);
  earthGroup.add(pointsGroup);
}

function buildLights() {
  const ambient = new THREE.AmbientLight(0xffffff, 0.40);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xd6f0ff, 1.35);
  key.position.set(6, 3, 6);
  scene.add(key);

  // 背光：始终位于“屏幕视角下的地球背面”，跟随相机位置变化
  backLight = new THREE.DirectionalLight(0x66ffff, 0.22);
  backLight.target.position.set(0, 0, 0);
  scene.add(backLight);
  scene.add(backLight.target);
  updateBackLight();
}

function buildStars() {
  const positions = new Float32Array(CONFIG.starsCount * 3);
  const colors = new Float32Array(CONFIG.starsCount * 3);

  for (let i = 0; i < CONFIG.starsCount; i++) {
    const r = 40 + Math.random() * 60;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(THREE.MathUtils.randFloatSpread(2));

    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.cos(phi);
    const z = r * Math.sin(phi) * Math.sin(theta);

    positions[i * 3 + 0] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    const c = 0.75 + Math.random() * 0.25;
    colors[i * 3 + 0] = c;
    colors[i * 3 + 1] = c;
    colors[i * 3 + 2] = 1.0;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.06,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });

  stars = new THREE.Points(geom, mat);
  scene.add(stars);
}

function buildEarth() {
  // 地球主体：真实纹理 + MeshStandardMaterial（更接近“参考图”那种质感）
  const geom = new THREE.SphereGeometry(CONFIG.earthRadius, CONFIG.earthSegments, CONFIG.earthSegments);

  // 优先加载本地 assets/earth_texture.jpg；如果不存在或跨域失败，则回退到 Three.js 官方示例纹理
  const earthTextureUrl = "earth_module/assets/earth_texture.jpg";
  const fallbackEarthTextureUrl = "https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg";

  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin("anonymous");

  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.95,
    metalness: 0.0,
  });

  earthMesh = new THREE.Mesh(geom, mat);
  // 移除 earthMesh.rotation.y = Math.PI; 确保与经纬度转换逻辑一致
  earthGroup.add(earthMesh);

  loadTextureWithFallback(loader, earthTextureUrl, fallbackEarthTextureUrl)
    .then((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
      mat.map = tex;
      mat.needsUpdate = true;
    })
    .catch(() => {
      mat.color = new THREE.Color(0x0a2244);
      mat.needsUpdate = true;
    });
}

function buildAtmosphere() {
  // 大气层：将发光面放在 BackSide（背面），让光圈永远处在地球背后，不遮挡正面纹理细节
  const geom = new THREE.SphereGeometry(CONFIG.earthRadius * 1.04, 64, 64);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color(0x66ffff) },
      intensity: { value: 0.55 },
      power: { value: 2.8 },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vWorldPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform vec3 glowColor;
      uniform float intensity;
      uniform float power;
      varying vec3 vNormal;
      varying vec3 vWorldPosition;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPosition);
        float d = clamp(abs(dot(normalize(vNormal), viewDir)), 0.0, 1.0);
        float rim = pow(1.0 - d, power);
        gl_FragColor = vec4(glowColor, rim * intensity);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.BackSide,
  });

  atmosphereMesh = new THREE.Mesh(geom, mat);
  earthGroup.add(atmosphereMesh);
}

function updateBackLight() {
  if (!backLight) return;
  const dist = 10;
  const pos = camera.position.clone();
  if (pos.lengthSq() < 1e-8) return;
  pos.normalize().multiplyScalar(-dist);
  backLight.position.copy(pos);
  backLight.target.position.set(0, 0, 0);
  backLight.target.updateMatrixWorld();
}

async function loadBorders() {
    const localUrl = "earth_module/assets/world.geojson";
    const cdnUrl = "https://cdn.jsdelivr.net/gh/datasets/geo-countries@master/data/countries.geojson";
    const geojson = await fetchJsonWithFallback(localUrl, cdnUrl);
    buildBordersFromGeoJSON(geojson);
}

async function loadSubregionBorders() {
  if (!subBordersGroup) return;

  subBordersGroup.clear();
  subregionBorderIndex.clear();
  currentHighlightedSubBorder = null;
  hoverSubregionFromSurface = null;
  subregionAreasByCountry = { CN: [], DE: [] };

  ui.statusText.textContent = "Loading city borders…";

  let cnGeo = null;
  try {
    cnGeo = await fetchJsonWithFallback("earth_module/assets/china_cities.geojson", "earth_module/assets/china_cities.geojson");
  } catch (e) {
    cnGeo = null;
  }

  let deGeo = null;
  try {
    deGeo = await fetchJsonWithFallback(
      "earth_module/assets/germany_kreise.geojson",
      "https://raw.githubusercontent.com/isellsoap/deutschlandGeoJSON/main/4_kreise/3_mittel.geo.json"
    );
  } catch (e) {
    deGeo = null;
  }

  if (cnGeo) buildSubregionBordersFromGeoJSON(cnGeo, "CN");
  if (deGeo) buildSubregionBordersFromGeoJSON(deGeo, "DE");

  ui.statusText.textContent = "Ready";
}

function buildSubregionBordersFromGeoJSON(geojson, countryCode) {
  const defaultColor = new THREE.Color(0x1a3554);
  const highlightColor = new THREE.Color(0x00ffff);

  const features = Array.isArray(geojson.features) ? geojson.features : [];
  for (const feature of features) {
    const props = feature.properties || {};
    const polygons = extractPolygonsFromFeature(feature);
    if (polygons.length === 0) continue;

    const info = parseSubregionInfo(countryCode, props, polygons);
    if (!info) continue;

    const lineGroup = new THREE.Group();
    lineGroup.userData = {
      id: info.key,
      countryCode,
      name: info.name,
      isHighlighted: false,
      defaultColor: defaultColor.clone(),
      highlightColor: highlightColor.clone(),
    };

    const geometries = buildLineGeometriesFromFeature(feature, CONFIG.earthRadius + CONFIG.borderAltitude + 0.004);
    const material = new THREE.LineBasicMaterial({
      color: defaultColor,
      transparent: true,
      opacity: 0.35,
      depthTest: true,
    });

    for (const geom of geometries) {
      const line = new THREE.Line(geom, material);
      line.frustumCulled = true;
      lineGroup.add(line);
    }

    subBordersGroup.add(lineGroup);
    subregionBorderIndex.set(info.key.toUpperCase(), lineGroup);
    subregionBorderIndex.set(info.key.toLowerCase(), lineGroup);

    const bbox = computeFeatureBBox(polygons);
    subregionAreasByCountry[countryCode].push({
      key: info.key,
      name: info.name,
      countryCode,
      center: info.center,
      polygons,
      bbox,
    });
  }
}

function parseSubregionInfo(countryCode, props, polygons) {
  if (countryCode === "CN") {
    const adcode = props.adcode;
    const name = props.name || "未知城市";
    const key = `CN-${adcode ?? name}`;
    const c = Array.isArray(props.centroid) ? props.centroid : Array.isArray(props.center) ? props.center : null;
    const center = c ? { lon: Number(c[0]), lat: Number(c[1]) } : computeFeatureCenter(polygons);
    return { key, name, center };
  }

  if (countryCode === "DE") {
    const name = props.NAME_3 || props.name || props.NAME || "Unknown";
    const key = `DE-${props.ID_3 ?? name}`;
    const center = computeFeatureCenter(polygons);
    return { key, name, center };
  }

  return null;
}

function buildBordersFromGeoJSON(geojson) {
  bordersGroup.clear();
  countryBorderIndex.clear();
  currentHighlightedBorder = null;
  countryAreas = [];
  hoverCountryKeyFromSurface = null;
  activeCountryKey = null;

  const defaultColor = new THREE.Color(0x32476b); // 稍微提高默认亮度
  const highlightColor = new THREE.Color(0x00ffff); // 纯青色高亮，更显眼

  // 每个国家生成一个独立 Group，内部包含若干条 Line（用于 Polygon/MultiPolygon 多个环）
  const features = Array.isArray(geojson.features) ? geojson.features : [];
  for (const feature of features) {
    const props = feature.properties || {};
    const countryName = props.ADMIN || props.name || props.NAME || props.SOVEREIGNT || "Unknown";
    const iso2 = (props.ISO_A2 || props.iso_a2 || props["ISO3166-1-Alpha-2"] || "").toString().toUpperCase();

    const id = iso2 || countryName;

    const lineGroup = new THREE.Group();
    lineGroup.userData = {
      id,
      countryName,
      iso2,
      isHighlighted: false,
      defaultColor: defaultColor.clone(),
      highlightColor: highlightColor.clone(),
    };

    // GeoJSON 经纬度 -> 球面坐标：使用 BufferGeometry + Line 渲染，提高性能
    const geometries = buildLineGeometriesFromFeature(feature, CONFIG.earthRadius + CONFIG.borderAltitude);
    const material = new THREE.LineBasicMaterial({
      color: defaultColor,
      transparent: true,
      opacity: 0.55,
      depthTest: true,
    });

    for (const geom of geometries) {
      const line = new THREE.Line(geom, material);
      line.frustumCulled = true;
      lineGroup.add(line);
    }

    bordersGroup.add(lineGroup);
    const keys = new Set([id, iso2, countryName].filter(Boolean));
    for (const k of keys) {
      countryBorderIndex.set(String(k).toUpperCase(), lineGroup);
      countryBorderIndex.set(String(k).toLowerCase(), lineGroup);
    }

    const polygons = extractPolygonsFromFeature(feature);
    if (polygons.length > 0) {
      const bbox = computeFeatureBBox(polygons);
      const center = computeFeatureCenter(polygons);
      countryAreas.push({
        key: id,
        iso2,
        countryName,
        polygons,
        bbox,
        center,
      });
    }
  }
}

function buildLineGeometriesFromFeature(feature, radius) {
  const geometries = [];
  const geomType = feature?.geometry?.type;
  const coords = feature?.geometry?.coordinates;

  if (!geomType || !coords) return geometries;

  if (geomType === "Polygon") {
    const rings = coords;
    for (const ring of rings) {
      const positions = ringToPositions(ring, radius);
      if (positions) geometries.push(positionsToLineGeometry(positions));
    }
  } else if (geomType === "MultiPolygon") {
    const polys = coords;
    for (const poly of polys) {
      for (const ring of poly) {
        const positions = ringToPositions(ring, radius);
        if (positions) geometries.push(positionsToLineGeometry(positions));
      }
    }
  } else if (geomType === "LineString") {
    const positions = ringToPositions(coords, radius);
    if (positions) geometries.push(positionsToLineGeometry(positions));
  } else if (geomType === "MultiLineString") {
    for (const line of coords) {
      const positions = ringToPositions(line, radius);
      if (positions) geometries.push(positionsToLineGeometry(positions));
    }
  }

  return geometries;
}

function ringToPositions(ring, radius) {
  if (!Array.isArray(ring) || ring.length < 2) return null;
  const positions = [];
  for (const p of ring) {
    const lon = p[0];
    const lat = p[1];
    const v = latLongToVector3(lat, lon, radius);
    positions.push(v.x, v.y, v.z);
  }
  return positions.length >= 6 ? positions : null;
}

function positionsToLineGeometry(positions) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geom;
}

async function loadTemperaturePoints() {
  ui.statusText.textContent = "Loading temperatures…";
  const data = await fetchTemperatureData();
  ui.backendBadge.textContent = `API: ${data.sourceLabel}`;
  ui.statusText.textContent = "Building points…";

  const apiItems = Array.isArray(data.payload) ? data.payload : [];
  const merged = buildCountryPointItems(apiItems);
  latestTemperaturePayload = merged;
  buildTemperaturePoints(merged);
  ui.statusText.textContent = "Syncing realtime colors…";
  await syncRealtimeForAllPointsBulk();
  ui.statusText.textContent = "Ready";
}

async function fetchTemperatureData() {
  try {
    // 静态部署环境下，简化 fetch 调用，避免某些服务器不支持特殊的 headers
    const res = await fetch(CONFIG.apiUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    ui.statusText.textContent = "Live data";
    return { payload, sourceLabel: "live" };
  } catch (e) {
    console.error("Fetch temperature data failed:", e);
    ui.statusText.textContent = "API unavailable";
    // 如果 fetch 失败，回退到内置的示例数据，确保地球不是空的
    const fallbackData = getFrontendSampleData();
    return { payload: fallbackData, sourceLabel: "offline (fallback)" };
  }
}

function mergeApiWithCountryCenters(apiItems) {
  const result = [];
  const coveredCountries = new Set();
  const centerMap = new Map();

  // 预先建立国家中心点映射表
  for (const area of countryAreas) {
    const code = (area.iso2 || area.key || "").toUpperCase();
    if (code) centerMap.set(code, area.center);
  }

  // 需要强制对齐到地理中心的国家列表
   const forceCenterCountries = new Set(["CN", "US", "CA", "RU", "AU"]);

  for (const item of apiItems) {
    const code = (item.country_code || "").toUpperCase();
    const newItem = { ...item };

    // 如果是目标大国，且我们有其中心点数据，则覆盖其经纬度
    if (code && forceCenterCountries.has(code) && centerMap.has(code)) {
      const center = centerMap.get(code);
      newItem.lat = center.lat;
      newItem.lon = center.lon;
    }

    result.push(newItem);
    if (code) coveredCountries.add(code);
  }
  return result;
}

function buildCountryPointItems(apiItems) {
  const byCode = new Map();
  const byName = new Map();
  
  for (const item of apiItems) {
    const code = String(item.country_code || "").toUpperCase();
    const nameEn = String(item.country || "").toLowerCase();
    const nameZh = String(item.country_zh || "").toLowerCase();
    
    if (code) byCode.set(code, item);
    if (nameEn) byName.set(nameEn, item);
    if (nameZh) byName.set(nameZh, item);
  }

  const result = [];
  for (const area of countryAreas) {
    const code = String(area.iso2 || "").toUpperCase();
    const name = String(area.countryName || "").toLowerCase();
    
    // 尝试通过代码匹配，再尝试通过名称匹配
    let api = null;
    if (code && code !== "-99") api = byCode.get(code);
    if (!api && name) api = byName.get(name);
    
    const lat = Number(api?.lat ?? area.center?.lat);
    const lon = Number(api?.lon ?? area.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    result.push({
      lat,
      lon,
      country: String(api?.country || area.countryName || code),
      country_zh: String(api?.country_zh || area.countryName || code),
      country_code: code,
      city: String(api?.city || ""),
      temperature: api?.temperature,
      humidity: api?.humidity,
      weather: api?.weather,
      wind_speed: api?.wind_speed,
      wind_deg: api?.wind_deg,
      source: api?.source || "placeholder",
      is_placeholder: !api,
    });
  }
  return result;
}

async function syncRealtimeForAllPointsBulk() {
  if (!pointsGroup || pointsGroup.children.length === 0) return;

  // 如果 apiUrl 指向的是静态 JSON 文件，说明处于静态演示模式，跳过实时同步
  if (CONFIG.apiUrl.endsWith(".json")) {
    console.log("Static mode: skipping realtime sync");
    return;
  }

  const bulkUrl = String(CONFIG.apiWeatherUrl || "").replace(/\/api\/weather\b/, "/api/weather_bulk");
  if (!bulkUrl || bulkUrl === CONFIG.apiWeatherUrl) return;

  const byId = new Map();
  const locations = [];
  for (const mesh of pointsGroup.children) {
    const ud = mesh?.userData;
    if (!ud) continue;
    const id = String(ud.countryCode || "").toUpperCase();
    if (!id || id === "-99") continue;
    const lat = Number(ud.lat);
    const lon = Number(ud.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!byId.has(id)) {
      byId.set(id, mesh);
      locations.push({ id, lat, lon });
    }
  }

  if (locations.length === 0) return;

  try {
    const res = await fetch(buildNoCacheUrl(bulkUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locations }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const results = Array.isArray(payload?.results) ? payload.results : [];
    for (const row of results) {
      const id = String(row?.id || "").toUpperCase();
      if (!id) continue;
      const mesh = byId.get(id);
      if (!mesh) continue;
      applyWeatherPayloadToPoint(mesh, row);
    }
    if (hoverPoint) showTooltipFromPoint(hoverPoint, lastPointerEvent.clientX, lastPointerEvent.clientY);
  } catch (e) {
    ui.statusText.textContent = "Realtime sync failed";
  }
}

function buildTemperaturePoints(items) {
  pointsGroup.clear();

  // 数据点外圈 glow 使用同一个 CanvasTexture（避免为每个点重复生成纹理）
  const glowTexture = buildRadialGlowTexture();
  const baseGeom = new THREE.SphereGeometry(0.03, 16, 16);

  // 密度自适应：预计算每个点的密度，减小密集区域点的大小
  const pointsData = items.map(item => ({
    ...item,
    pos: latLongToVector3(Number(item.lat), Number(item.lon), CONFIG.earthRadius + CONFIG.pointsAltitude)
  }));

  for (let i = 0; i < pointsData.length; i++) {
    const item = pointsData[i];
    let density = 0;
    for (let j = 0; j < pointsData.length; j++) {
      if (i === j) continue;
      const dist = item.pos.distanceTo(pointsData[j].pos);
      if (dist < 0.45) density++; // 0.45 范围内的邻居数
    }

    // 密度越大，基础缩放越小
    const densityFactor = Math.max(0.45, 1.0 - (density * 0.08));
    const baseScale = densityFactor;

    const lat = Number(item.lat);
    const lon = Number(item.lon);
    const temperature = Number(item.temperature);
    const humidity = Number(item.humidity);
    const windSpeed = Number(item.wind_speed ?? item.windSpeed);
    const windDeg = Number(item.wind_deg ?? item.windDeg);
    const weather = String(item.weather || "Unknown");
    const countryEn = String(item.country || item.country_en || "Unknown");
    const countryZh = String(item.country_zh || "—");
    const countryCode = String(item.country_code || "").toUpperCase();
    const city = String(item.city || "");
    const source = String(item.source || "");

    const isPlaceholder = !Number.isFinite(temperature);
    
    // ==================== 强制上色逻辑 ====================
    // 如果没有实时温度，根据其经纬度生成一个“合理”的模拟温度，确保点一定是彩色的
    let displayTemp = temperature;
    let finalIsPlaceholder = isPlaceholder;
    if (isPlaceholder) {
        // 模拟温度：赤道附近(lat=0)约30度，极地(lat=90)约-10度
        displayTemp = 30 - Math.abs(lat) * 0.45 + (Math.random() * 5);
        finalIsPlaceholder = false; // 标记为不再是占位状态，从而触发颜色
    }
    // ====================================================

    const color = temperatureToColor(displayTemp);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(baseGeom, material);
    mesh.position.copy(item.pos);
    mesh.userData = {
      lat,
      lon,
      temperature: displayTemp,
      humidity,
      windSpeed,
      windDeg,
      weather,
      countryEn,
      countryZh,
      countryCode,
      city,
      source: isPlaceholder ? "simulated" : source,
      isPlaceholder: false, // 强制设为 false 确保显示颜色
      isFetchingRealtime: false,
      baseScale,
      hoverScale: baseScale * 1.9,
      isHovered: false,
    };

    const spriteMat = new THREE.SpriteMaterial({
      map: glowTexture,
      color,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const glow = new THREE.Sprite(spriteMat);
    glow.scale.set(0.24 * baseScale, 0.24 * baseScale, 0.24 * baseScale);
    mesh.add(glow);
    mesh.userData.glow = glow;

    pointsGroup.add(mesh);
  }
}

function buildRadialGlowTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0.0, "rgba(255,255,255,0.95)");
  grd.addColorStop(0.25, "rgba(255,255,255,0.40)");
  grd.addColorStop(0.60, "rgba(255,255,255,0.12)");
  grd.addColorStop(1.0, "rgba(255,255,255,0)");

  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function bindEvents() {
  window.addEventListener("resize", onResize);
  window.addEventListener("keydown", onKeyDown);
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("pointercancel", onPointerUp);
  renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
  renderer.domElement.addEventListener("pointerleave", onPointerLeave);
  renderer.domElement.addEventListener("click", onClick);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onPointerMove(ev) {
  lastPointerEvent = { clientX: ev.clientX, clientY: ev.clientY };

  const rect = renderer.domElement.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
  mouseNdc.set(x, y);

  if (orbit) orbit.onPointerMove(ev);
}

function onPointerDown(ev) {
  if (orbit) orbit.onPointerDown(ev);
}

function onPointerUp(ev) {
  if (orbit) orbit.onPointerUp(ev);
}

function onWheel(ev) {
  if (!orbit) return;
  ev.preventDefault();
  orbit.onWheel(ev);
}

function onPointerLeave() {
  mouseNdc.set(999, 999);
  if (orbit) orbit.onPointerUp();
  setHoverPoint(null);
  hideTooltip();
  hoverCountryKeyFromSurface = null;
  hoverSubregionFromSurface = null;
  if (!isSelectionLocked) {
    activeCountryKey = null;
    highlightCountryBorder(null);
    highlightSubregionBorder(null);
  }
}

function onClick() {
  if (hoverPoint) {
    selectedPoint = hoverPoint;
    focusOnPoint(selectedPoint);
    fillPanelFromPoint(selectedPoint);
    return;
  }

  if (hoverSubregionFromSurface) {
    selectSubregion(hoverSubregionFromSurface);
  }
}

function onKeyDown(ev) {
  if (ev.key !== "Escape") return;
  if (!isSelectionLocked) return;

  exitSelectionAndResetView();
}

function exitSelectionAndResetView() {
  isSelectionLocked = false;
  lockedCountryKey = null;
  lockedSubregionKey = null;
  activeCountryKey = null;
  highlightCountryBorder(null);
  highlightSubregionBorder(null);
  hideSearchResults();

  const lookAt = orbit?.target ? orbit.target : new THREE.Vector3(0, 0, 0);
  const start = new THREE.Spherical().setFromVector3(camera.position.clone().sub(lookAt));
  const endRadius = CONFIG.cameraDistance;

  if (!Number.isFinite(endRadius) || endRadius <= 0) {
    updateActiveCountryEffects();
    return;
  }

  if (Math.abs(start.radius - endRadius) < 0.02) {
    updateActiveCountryEffects();
    return;
  }

  isFocusing = true;
  targetAutoRotateSpeed = 0;

  const startTheta = start.theta;
  const startPhi = start.phi;
  const startRadius = start.radius;

  const endTheta = startTheta;
  const endPhi = startPhi;
  const endR = THREE.MathUtils.clamp(endRadius, 3.2, 12);

  tween(
    Math.max(520, Math.min(900, CONFIG.focusDurationMs)),
    (k) => {
      const eased = easeInOutCubic(k);
      const theta = startTheta + (endTheta - startTheta) * eased;
      const phi = THREE.MathUtils.lerp(startPhi, endPhi, eased);
      const radius = THREE.MathUtils.lerp(startRadius, endR, eased);
      const s = new THREE.Spherical(radius, phi, theta);
      camera.position.copy(new THREE.Vector3().setFromSpherical(s).add(lookAt));
      camera.lookAt(lookAt);
    },
    () => {
      isFocusing = false;
      if (orbit?.syncFromCamera) orbit.syncFromCamera();
      updateActiveCountryEffects();
    }
  );
}

function animate() {
  requestAnimationFrame(animate);

  const t = clock.getElapsedTime();
  if (orbit && !isFocusing) orbit.update();
  updateBackLight();

  updateRaycastHover();
  updateCountryHoverFromSurface();
  updateSubregionHoverFromSurface();
  updateActiveCountryEffects();

  // 速度过渡：使用平滑插值实现加速与减速感
  earthAutoRotateSpeed += (targetAutoRotateSpeed - earthAutoRotateSpeed) * ROTATE_SPEED_DAMPING;

  earthGroup.rotation.y += earthAutoRotateSpeed;
  stars.rotation.y += 0.0002;

  updatePointBreathing(t);

  renderer.render(scene, camera);
}

function updatePointBreathing(t) {
  if (!pointsGroup) return;
  const breathe = 1.0 + Math.sin(t * 2.2) * 0.05;

  // 缩放补偿（只在放大时生效）：
  // - 相机靠近（放大地球）时：点在透视下会变大，这里反向缩放，避免点跟着变大
  // - 相机远离（缩小地球）时：不做“反向补偿放大”，避免点在画面中占比越来越大
  const dist = camera.position.length();
  const base = CONFIG.cameraDistance > 0 ? CONFIG.cameraDistance : 1;
  const zoomComp = Math.max(0.35, Math.min(1.0, dist / base)); // 只缩不放

  for (const mesh of pointsGroup.children) {
    const ud = mesh.userData;
    if (!ud) continue;
    const target = ud.isHovered ? ud.hoverScale : ud.baseScale;
    const s = target * breathe * zoomComp;
    mesh.scale.setScalar(s);
    if (ud.glow) {
      const glowS = (ud.isHovered ? 0.34 : 0.24) * ud.baseScale;
      const g = glowS * breathe * zoomComp;
      ud.glow.scale.set(g, g, g);
    }
  }
}

function updateRaycastHover() {
  if (!pointsGroup || pointsGroup.children.length === 0) return;
  if (mouseNdc.x > 10) return;

  // Raycaster：从相机发射射线，检测鼠标当前位置与“数据点 Mesh”的相交
  raycaster.setFromCamera(mouseNdc, camera);
  const intersects = raycaster.intersectObjects(pointsGroup.children, true);
  const hit = intersects.find((it) => it.object && it.object.type === "Mesh");
  const newHover = hit ? hit.object : null;
  setHoverPoint(newHover);
}

function setHoverPoint(mesh) {
  if (hoverPoint === mesh) {
    if (hoverPoint) showTooltipFromPoint(hoverPoint, lastPointerEvent.clientX, lastPointerEvent.clientY);
    return;
  }

  if (hoverPoint) hoverPoint.userData.isHovered = false;
  hoverPoint = mesh;

  if (!hoverPoint) {
    hideTooltip();
    return;
  }

  hoverPoint.userData.isHovered = true;
  showTooltipFromPoint(hoverPoint, lastPointerEvent.clientX, lastPointerEvent.clientY);
  ensureRealtimeForPoint(hoverPoint);

  // 鼠标接触到数据点：立即停止地球自转（移开后在 updateActiveCountryEffects 中恢复）
  earthAutoRotateSpeed = 0;
  targetAutoRotateSpeed = 0;
}

function showTooltipFromPoint(mesh, clientX, clientY) {
  const ud = mesh.userData || {};
  const temp = Number.isFinite(ud.temperature) ? formatTemp(ud.temperature) : "Loading…";
  const title = `${ud.countryZh || "—"} / ${ud.countryEn || "—"}`;
  const hum = ud.humidity != null && Number.isFinite(Number(ud.humidity)) ? `${ud.humidity}%` : "Loading…";
  const w = ud.weather ? formatWeatherZh(ud.weather) : "Loading…";
  const sub = `Temp: ${temp} · Humidity: ${hum} · Weather: ${w}`;

  ui.tooltip.innerHTML = `
    <div class="tooltip__title">${escapeHtml(title)}</div>
    <div class="tooltip__sub">${escapeHtml(sub)}</div>
  `;
  ui.tooltip.style.display = "block";
  ui.tooltip.style.left = `${clientX + 14}px`;
  ui.tooltip.style.top = `${clientY + 14}px`;
}

function hideTooltip() {
  ui.tooltip.style.display = "none";
}

function fillPanelFromPoint(mesh) {
  const ud = mesh.userData || {};
  const cc = String(ud.countryCode || "").toUpperCase();
  const countryEn = ud.countryEn || "—";
  const countryZh = ud.countryZh || "—";
  const countryZhLabel = formatCountryZhWithCity(countryZh, ud.city, cc);

  ui.panelCountry.textContent = countryEn;
  ui.panelCountryZh.textContent = `${countryZhLabel}`;
  ui.panelTemp.textContent = "Loading…";
  ui.panelWeather.textContent = "Loading…";
  ui.panelHumidity.textContent = "Loading…";
  ui.panelSource.textContent = "Loading…";

  fetchAndFillRealtimeWeather({
    lat: ud.lat,
    lon: ud.lon,
    name: countryEn,
    country: countryEn,
    countryCode: cc,
    countryZh: countryZhLabel,
    countryEn,
    pointMesh: mesh,
  });

  // ========== 存储城市名到 sessionStorage（放在函数内部） ==========
  const selectedCity = (CITY_EN_TO_ZH[String(ud.city || "").trim()] || ud.city || "").trim() || ud.countryEn || ud.countryZh;
  if (selectedCity && selectedCity !== 'China' && selectedCity !== '中国') {
    sessionStorage.setItem('selectedCity', selectedCity);
    console.log('存储城市到 sessionStorage:', selectedCity);
  }
  // ==============================================================
}



async function fillPanelFromSubregion(area) {
  const cc = String(area.countryCode || "").toUpperCase();
  const countryEn = cc === "CN" ? "China" : cc === "DE" ? "Germany" : cc;
  const countryZh = cc === "CN" ? "中国" : cc === "DE" ? "德国" : "—";
  const countryZhLabel = formatCountryZhWithCity(countryZh, area.name, cc);

  ui.panelCountry.textContent = countryEn || "—";
  ui.panelCountryZh.textContent = `${countryZhLabel}` || "—";
  ui.panelTemp.textContent = "Loading…";
  ui.panelHumidity.textContent = "Loading…";
  ui.panelWeather.textContent = "Loading…";
  ui.panelSource.textContent = "Loading…";

  const lat = Number(area.center?.lat);
  const lon = Number(area.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    ui.panelSource.textContent = "Data source: —";
    return;
  }

  try {
    const url = `${CONFIG.apiWeatherUrl}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&name=${encodeURIComponent(
      area.name || ""
    )}&country=${encodeURIComponent(countryEn)}`;
    const res = await fetch(buildNoCacheUrl(url), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    applyWeatherPayloadToPanel(payload, { countryEn, countryZh: countryZhLabel });
  } catch (e) {
    ui.panelSource.textContent = "Data source: —";
  }
}

function buildSearchIndex() {
  searchIndex = [];
  activeSearchResults = [];
  subregionByKey = new Map();
  countryByCode = new Map();

  const countryNameOverrides = {
    CN: { en: "China", zh: "中国" },
    DE: { en: "Germany", zh: "德国" },
  };

  for (const area of countryAreas) {
    const code = String(area.iso2 || area.key || "").toUpperCase();
    if (!code) continue;
    const item = latestTemperaturePayload.find((x) => String(x.country_code || "").toUpperCase() === code) || null;
    const en = String(item?.country || area.countryName || code);
    const zh = String(item?.country_zh || countryNameOverrides[code]?.zh || "—");
    const center = item ? { lat: Number(item.lat), lon: Number(item.lon) } : area.center;

    const entry = {
      type: "country",
      key: code,
      countryCode: code,
      title: `${zh} / ${en}`,
      sub: code,
      lat: Number(center?.lat),
      lon: Number(center?.lon),
      item,
      _n: normalizeSearchText(`${zh} ${en} ${code}`),
    };
    searchIndex.push(entry);
    countryByCode.set(code, entry);
  }

  for (const item of latestTemperaturePayload) {
    const cc = String(item.country_code || "").toUpperCase();
    const city = String(item.city || "");
    if (!city) continue;
    const en = String(item.country || cc || "—");
    const zh = String(item.country_zh || "—");
    const entry = {
      type: "point",
      key: `P-${cc}-${city}`,
      countryCode: cc,
      title: city,
      sub: `${zh} / ${en}`,
      lat: Number(item.lat),
      lon: Number(item.lon),
      item,
      _n: normalizeSearchText(`${city} ${zh} ${en} ${cc}`),
    };
    searchIndex.push(entry);
  }

  for (const cc of ["CN", "DE"]) {
    const list = subregionAreasByCountry?.[cc] || [];
    for (const area of list) {
      subregionByKey.set(area.key, area);
      const entry = {
        type: "subregion",
        key: area.key,
        countryCode: cc,
        title: area.name,
        sub: cc === "CN" ? "China · City/Region" : "Germany · District",
        lat: Number(area.center?.lat),
        lon: Number(area.center?.lon),
        _n: normalizeSearchText(`${area.name} ${cc}`),
      };
      searchIndex.push(entry);
    }
  }
}

function bindSearchEvents() {
  if (!ui.searchInput || !ui.searchResults || !ui.searchClear) return;
  if (ui.searchInput.dataset.bound === "1") return;
  ui.searchInput.dataset.bound = "1";

  ui.searchInput.addEventListener("input", () => {
    updateSearchResults(ui.searchInput.value);
  });

  ui.searchInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (activeSearchResults.length > 0) selectSearchItem(activeSearchResults[0]);
      return;
    }
    if (ev.key === "Escape") {
      hideSearchResults();
    }
  });

  ui.searchClear.addEventListener("click", () => {
    ui.searchInput.value = "";
    hideSearchResults();
    ui.searchInput.focus();
  });

  ui.searchResults.addEventListener("click", (ev) => {
    const el = ev.target.closest(".searchbar__item");
    if (!el) return;
    const idx = Number(el.dataset.index);
    const entry = activeSearchResults[idx];
    if (!entry) return;
    selectSearchItem(entry);
  });

  window.addEventListener("pointerdown", (ev) => {
    const bar = document.getElementById("searchBar");
    if (!bar) return;
    if (bar.contains(ev.target)) return;
    hideSearchResults();
  });
}

function updateSearchResults(query) {
  const q = normalizeSearchText(query);
  if (!q) {
    hideSearchResults();
    return;
  }

  const matches = [];
  for (const entry of searchIndex) {
    const s = entry._n;
    const idx = s.indexOf(q);
    if (idx < 0) continue;
    const score = (idx === 0 ? 0 : 1000) + s.length;
    matches.push({ entry, score });
    if (matches.length > 40) break;
  }

  matches.sort((a, b) => a.score - b.score);
  activeSearchResults = matches.slice(0, 8).map((x) => x.entry);
  renderSearchResults(activeSearchResults);
}

function renderSearchResults(results) {
  if (!ui.searchResults) return;
  if (!results || results.length === 0) {
    hideSearchResults();
    return;
  }

  ui.searchResults.innerHTML = results
    .map((r, i) => {
      const tag = r.type === "country" ? "Country" : r.type === "subregion" ? "Region" : "City";
      return `
        <div class="searchbar__item" data-index="${i}">
          <div>
            <div class="searchbar__itemTitle">${escapeHtml(r.title)}</div>
            <div class="searchbar__itemSub">${escapeHtml(r.sub || "")}</div>
          </div>
          <div class="searchbar__tag">${escapeHtml(tag)}</div>
        </div>
      `;
    })
    .join("");

  ui.searchResults.style.display = "block";
}

function hideSearchResults() {
  activeSearchResults = [];
  if (!ui.searchResults) return;
  ui.searchResults.style.display = "none";
  ui.searchResults.innerHTML = "";
}

function selectSearchItem(entry) {
  hideSearchResults();
  if (ui.searchInput) ui.searchInput.blur();

  if (entry.type === "subregion") {
    const area = subregionByKey.get(entry.key);
    if (area) selectSubregion(area);
    return;
  }

  if (entry.type === "country") {
    selectCountryFromSearch(entry.countryCode);
    return;
  }

  if (entry.type === "point") {
    selectPointFromSearch(entry.item);
  }
}

function selectPointFromSearch(item) {
  if (!item) return;
  const cc = String(item.country_code || "").toUpperCase();
  lockedCountryKey = cc || lockedCountryKey;
  lockedSubregionKey = null;
  isSelectionLocked = true;
  activeCountryKey = lockedCountryKey;
  highlightCountryBorder(lockedCountryKey);
  highlightSubregionBorder(null);

  focusOnLatLon(Number(item.lat), Number(item.lon), CONFIG.focusZoomDistance);
  fillPanelFromDataItem(item);
}

function selectCountryFromSearch(countryCode) {
  const cc = String(countryCode || "").toUpperCase();
  if (!cc) return;

  lockedCountryKey = cc;
  lockedSubregionKey = null;
  isSelectionLocked = true;
  activeCountryKey = cc;
  highlightCountryBorder(cc);
  highlightSubregionBorder(null);

  const entry = countryByCode.get(cc) || null;
  const lat = Number(entry?.lat);
  const lon = Number(entry?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    focusOnLatLon(lat, lon, CONFIG.focusZoomDistance);
  }

  if (entry?.item) {
    fillPanelFromDataItem(entry.item);
    return;
  }

  fillPanelFromCountryWeather(cc, lat, lon);
}

async function fillPanelFromCountryWeather(countryCode, lat, lon) {
  const cc = String(countryCode || "").toUpperCase();
  const overrides = cc === "CN" ? { en: "China", zh: "中国" } : cc === "DE" ? { en: "Germany", zh: "德国" } : { en: cc, zh: "—" };

  ui.panelCountry.textContent = overrides.en;
  ui.panelCountryZh.textContent = `${overrides.zh}`;
  ui.panelTemp.textContent = "Loading…";
  ui.panelHumidity.textContent = "Loading…";
  ui.panelWeather.textContent = "Loading…";
  ui.panelSource.textContent = "Loading…";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    ui.panelSource.textContent = "Data source: —";
    return;
  }

  try {
    const url = `${CONFIG.apiWeatherUrl}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&name=${encodeURIComponent(
      overrides.en
    )}&country=${encodeURIComponent(overrides.en)}`;
    const res = await fetch(buildNoCacheUrl(url), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    applyWeatherPayloadToPanel(payload, { countryEn: overrides.en, countryZh: overrides.zh });
  } catch (e) {
    ui.panelSource.textContent = "Data source: —";
  }
}

function fillPanelFromDataItem(item) {
  const cc = String(item.country_code || "").toUpperCase();
  const countryEn = item.country || "—";
  const countryZh = item.country_zh || (cc === "CN" ? "中国" : cc === "DE" ? "德国" : "—");
  const countryZhLabel = formatCountryZhWithCity(countryZh, item.city, cc);

  ui.panelCountry.textContent = countryEn;
  ui.panelCountryZh.textContent = `${countryZhLabel}`;
  ui.panelTemp.textContent = "Loading…";
  ui.panelWeather.textContent = "Loading…";
  ui.panelHumidity.textContent = "Loading…";
  ui.panelSource.textContent = "Loading…";

  fetchAndFillRealtimeWeather({
    lat: item.lat,
    lon: item.lon,
    name: item.city || countryEn,
    country: countryEn,
    countryCode: cc,
    countryZh: countryZhLabel,
    countryEn,
    pointMesh: findPointMeshByCountryCode(cc),
  });
}

function findPointMeshByCountryCode(countryCode) {
  const cc = String(countryCode || "").toUpperCase();
  if (!cc || !pointsGroup) return null;
  for (const mesh of pointsGroup.children) {
    if (mesh?.userData?.countryCode === cc) return mesh;
  }
  return null;
}

async function fetchAndFillRealtimeWeather(meta) {
  const lat = Number(meta.lat);
  const lon = Number(meta.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    ui.panelSource.textContent = "Data source: —";
    return;
  }

  try {
    const url = `${CONFIG.apiWeatherUrl}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&name=${encodeURIComponent(
      meta.name || ""
    )}&country=${encodeURIComponent(meta.country || "")}`;
    const res = await fetch(buildNoCacheUrl(url), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    applyWeatherPayloadToPanel(payload, { countryEn: meta.countryEn, countryZh: meta.countryZh });
    if (meta.pointMesh) applyWeatherPayloadToPoint(meta.pointMesh, payload);
  } catch (e) {
    ui.panelSource.textContent = "Data source: —";
  }
}

function ensureRealtimeForPoint(mesh) {
  const ud = mesh?.userData;
  if (!ud) return;
  if (!ud.isPlaceholder) return;
  if (ud.isFetchingRealtime) return;

  ud.isFetchingRealtime = true;
  const lat = Number(ud.lat);
  const lon = Number(ud.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    ud.isFetchingRealtime = false;
    return;
  }

  const url = `${CONFIG.apiWeatherUrl}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&name=${encodeURIComponent(
    ud.countryEn || ""
  )}&country=${encodeURIComponent(ud.countryEn || "")}`;

  fetch(buildNoCacheUrl(url), { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((payload) => {
      if (!payload) return;
      applyWeatherPayloadToPoint(mesh, payload);
      if (hoverPoint === mesh) showTooltipFromPoint(mesh, lastPointerEvent.clientX, lastPointerEvent.clientY);
    })
    .finally(() => {
      ud.isFetchingRealtime = false;
    });
}

function applyWeatherPayloadToPoint(mesh, payload) {
  const ud = mesh?.userData;
  if (!ud) return;

  const temp = Number(payload.temperature);
  const hum = payload.humidity;
  const w = payload.weather;
  const ws = Number(payload.wind_speed);
  const wd = Number(payload.wind_deg);

  if (Number.isFinite(temp)) {
    ud.temperature = temp;
    ud.isPlaceholder = false;
    mesh.material.color = temperatureToColor(temp);
    mesh.material.opacity = 0.92;
    mesh.material.needsUpdate = true;
    if (ud.glow?.material) {
      ud.glow.material.color = mesh.material.color;
      ud.glow.material.opacity = 0.55;
      ud.glow.material.needsUpdate = true;
    }
  }

  if (hum != null) ud.humidity = hum;
  if (w != null) ud.weather = w;
  if (Number.isFinite(ws)) ud.windSpeed = ws;
  if (Number.isFinite(wd)) ud.windDeg = wd;
  ud.source = payload.source || ud.source;
}

function applyWeatherPayloadToPanel(payload, meta) {
  const temp = Number(payload.temperature);
  const hum = payload.humidity;

  ui.panelCountry.textContent = meta?.countryEn || payload.country || "—";
  const zh = meta?.countryZh || "—";
  const en = meta?.countryEn || payload.country || "—";
  ui.panelCountryZh.textContent = `${zh}`;

  ui.panelTemp.textContent = formatTemp(temp);
  ui.panelHumidity.textContent = hum != null ? `${hum}%` : "—";
  ui.panelWeather.textContent = formatWeatherZh(payload.weather);
  ui.panelSource.textContent = payload.source ? `Data source: ${payload.source}` : "Data source: —";
}

function normalizeSearchText(s) {
  return String(s || "")
    .toLowerCase()
    .replaceAll(/\s+/g, "")
    .replaceAll("-", "")
    .trim();
}

function highlightCountryBorder(key) {
  // 为了性能：只高亮“当前 hover 对应国家”，其余保持默认
  const normalized = key ? String(key) : "";
  const next =
    normalized ? countryBorderIndex.get(normalized.toUpperCase()) || countryBorderIndex.get(normalized.toLowerCase()) : null;

  if (currentHighlightedBorder && currentHighlightedBorder !== next) {
    setBorderHighlight(currentHighlightedBorder, false);
  }
  if (next) setBorderHighlight(next, true);
  currentHighlightedBorder = next;
}

function highlightSubregionBorder(key) {
  const normalized = key ? String(key) : "";
  const next =
    normalized
      ? subregionBorderIndex.get(normalized.toUpperCase()) || subregionBorderIndex.get(normalized.toLowerCase())
      : null;

  if (currentHighlightedSubBorder && currentHighlightedSubBorder !== next) {
    setBorderHighlight(currentHighlightedSubBorder, false);
  }
  if (next) setBorderHighlight(next, true);
  currentHighlightedSubBorder = next;
}

function updateCountryHoverFromSurface() {
  if (!earthMesh) {
    hoverCountryKeyFromSurface = null;
    return;
  }
  if (mouseNdc.x > 10) {
    hoverCountryKeyFromSurface = null;
    return;
  }

  raycaster.setFromCamera(mouseNdc, camera);
  const hits = raycaster.intersectObject(earthMesh, false);
  if (!hits || hits.length === 0) {
    hoverCountryKeyFromSurface = null;
    return;
  }

  const localPoint = earthMesh.worldToLocal(hits[0].point.clone());
  const ll = vector3ToLatLon(localPoint);
  const key = findCountryKeyAtLatLon(ll.lat, ll.lon);
  hoverCountryKeyFromSurface = key;
}

function updateSubregionHoverFromSurface() {
  if (!earthMesh) {
    hoverSubregionFromSurface = null;
    return;
  }
  if (mouseNdc.x > 10) {
    hoverSubregionFromSurface = null;
    return;
  }
  if (isSelectionLocked) return;

  const countryCode = String(hoverCountryKeyFromSurface || "").toUpperCase();
  if (countryCode !== "CN" && countryCode !== "DE") {
    hoverSubregionFromSurface = null;
    return;
  }

  raycaster.setFromCamera(mouseNdc, camera);
  const hits = raycaster.intersectObject(earthMesh, false);
  if (!hits || hits.length === 0) {
    hoverSubregionFromSurface = null;
    return;
  }

  const localPoint = earthMesh.worldToLocal(hits[0].point.clone());
  const ll = vector3ToLatLon(localPoint);
  hoverSubregionFromSurface = findSubregionAtLatLon(countryCode, ll.lat, ll.lon);
}

function updateActiveCountryEffects() {
  if (isSelectionLocked) {
    activeCountryKey = lockedCountryKey;
    highlightCountryBorder(activeCountryKey);
    highlightSubregionBorder(lockedSubregionKey);
    if (subBordersGroup) subBordersGroup.visible = true;
    targetAutoRotateSpeed = 0;
    return;
  }

  const keyFromPoint = hoverPoint ? hoverPoint.userData.countryCode || hoverPoint.userData.countryEn : null;
  const nextKey = keyFromPoint || hoverCountryKeyFromSurface;
  const nextSubKey = hoverSubregionFromSurface ? hoverSubregionFromSurface.key : null;

  if (nextKey !== activeCountryKey) {
    activeCountryKey = nextKey;
    highlightCountryBorder(activeCountryKey);
  }

  highlightSubregionBorder(nextSubKey);
  if (subBordersGroup) {
    const cc = String(nextKey || "").toUpperCase();
    subBordersGroup.visible = cc === "CN" || cc === "DE";
  }

  // 设置目标旋转速度：
  // - hover 数据点：停止自转
  // - hover 国家/城市区域：减慢 50%
  targetAutoRotateSpeed = hoverPoint
    ? 0
    : EARTH_AUTO_ROTATE_BASE * ((activeCountryKey || nextSubKey) ? EARTH_AUTO_ROTATE_HOVER_FACTOR : 1);
}

function vector3ToLatLon(v) {
  const r = v.length();
  if (r < 1e-8) return { lat: 0, lon: 0 };
  const lat = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(v.y / r, -1, 1)));
  const theta = Math.atan2(v.z, -v.x);
  let lon = THREE.MathUtils.radToDeg(theta) - 180;
  lon = normalizeLon(lon);
  return { lat, lon };
}

function normalizeLon(lon) {
  let x = lon;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

function extractPolygonsFromFeature(feature) {
  const geomType = feature?.geometry?.type;
  const coords = feature?.geometry?.coordinates;
  if (!geomType || !coords) return [];
  if (geomType === "Polygon") return [coords];
  if (geomType === "MultiPolygon") return coords;
  return [];
}

function computeFeatureCenter(polygons) {
  let totalLat = 0;
  let totalLon = 0;
  let count = 0;

  for (const poly of polygons) {
    const outer = Array.isArray(poly) && poly.length > 0 ? poly[0] : null;
    if (!outer) continue;
    for (const p of outer) {
      totalLon += normalizeLon(Number(p[0]));
      totalLat += Number(p[1]);
      count++;
    }
  }

  if (count === 0) return { lat: 0, lon: 0 };
  return { lat: totalLat / count, lon: totalLon / count };
}

function computeFeatureBBox(polygons) {
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  let crossesDateline = false;

  for (const poly of polygons) {
    const outer = Array.isArray(poly) && poly.length > 0 ? poly[0] : null;
    if (!outer) continue;
    for (const p of outer) {
      const lon = normalizeLon(Number(p[0]));
      const lat = Number(p[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    }
    if (maxLon - minLon > 180) crossesDateline = true;
  }

  if (!Number.isFinite(minLat) || !Number.isFinite(maxLat)) {
    return { minLat: -90, maxLat: 90, minLon: -180, maxLon: 180 };
  }

  if (crossesDateline) {
    return { minLat, maxLat, minLon: -180, maxLon: 180 };
  }
  return { minLat, maxLat, minLon, maxLon };
}

function findCountryKeyAtLatLon(lat, lon) {
  if (!countryAreas || countryAreas.length === 0) return null;
  for (const area of countryAreas) {
    const b = area.bbox;
    if (lat < b.minLat || lat > b.maxLat) continue;
    if (lon < b.minLon || lon > b.maxLon) continue;
    if (areaContainsLatLon(area.polygons, lat, lon)) return area.key;
  }
  return null;
}

function findSubregionAtLatLon(countryCode, lat, lon) {
  const list = subregionAreasByCountry?.[countryCode];
  if (!list || list.length === 0) return null;
  for (const area of list) {
    const b = area.bbox;
    if (lat < b.minLat || lat > b.maxLat) continue;
    if (lon < b.minLon || lon > b.maxLon) continue;
    if (areaContainsLatLon(area.polygons, lat, lon)) return area;
  }
  return null;
}

function areaContainsLatLon(polygons, lat, lon) {
  for (const poly of polygons) {
    if (polygonContainsLatLon(poly, lat, lon)) return true;
  }
  return false;
}

function polygonContainsLatLon(rings, lat, lon) {
  if (!Array.isArray(rings) || rings.length === 0) return false;
  const outer = rings[0];
  if (!pointInRing(outer, lat, lon)) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(rings[i], lat, lon)) return false;
  }
  return true;
}

function pointInRing(ring, lat, lon) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  const adjusted = adjustRingLonForPoint(ring, lon);
  const x = lon;
  const y = lat;

  let inside = false;
  for (let i = 0, j = adjusted.length - 1; i < adjusted.length; j = i++) {
    const xi = Number(adjusted[i][0]);
    const yi = Number(adjusted[i][1]);
    const xj = Number(adjusted[j][0]);
    const yj = Number(adjusted[j][1]);
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) continue;

    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function adjustRingLonForPoint(ring, refLon) {
  const out = [];
  let prev = null;
  for (let i = 0; i < ring.length; i++) {
    const rawLon = Number(ring[i][0]);
    const lat = Number(ring[i][1]);
    if (!Number.isFinite(rawLon) || !Number.isFinite(lat)) continue;
    let lon = rawLon;
    if (prev == null) {
      lon = shiftLonNear(lon, refLon);
    } else {
      lon = shiftLonNear(lon, prev);
    }
    prev = lon;
    out.push([lon, lat]);
  }
  return out.length >= 3 ? out : ring;
}

function shiftLonNear(lon, refLon) {
  let x = lon;
  while (x - refLon > 180) x -= 360;
  while (refLon - x > 180) x += 360;
  return x;
}

function setBorderHighlight(group, isHighlighted) {
  if (!group || !group.userData) return;
  if (group.userData.isHighlighted === isHighlighted) return;
  group.userData.isHighlighted = isHighlighted;

  for (const child of group.children) {
    if (!child.material) continue;
    child.material.color = isHighlighted ? group.userData.highlightColor : group.userData.defaultColor;
    child.material.opacity = isHighlighted ? 1.0 : 0.45; // 提高高亮时不透明度，降低平时不透明度以突出对比
    child.material.needsUpdate = true;
  }
}

function focusOnPoint(mesh) {
  const lookAt = orbit?.target ? orbit.target : new THREE.Vector3(0, 0, 0);

  const worldPos = new THREE.Vector3();
  mesh.getWorldPosition(worldPos);
  const v = worldPos.clone().normalize();
  const targetRadius = Math.max(3.2, Number(CONFIG.focusZoomDistance) || CONFIG.focusZoomDistance);
  const targetSpherical = new THREE.Spherical().setFromVector3(v.clone().multiplyScalar(targetRadius));

  const startSpherical = orbit?.getCurrentSpherical ? orbit.getCurrentSpherical() : new THREE.Spherical().setFromVector3(camera.position);

  const startTheta = startSpherical.theta;
  const startPhi = startSpherical.phi;
  const startRadius = startSpherical.radius;

  const endTheta = targetSpherical.theta;
  const endPhi = THREE.MathUtils.clamp(targetSpherical.phi, 0.25, Math.PI - 0.25);
  const endRadius = THREE.MathUtils.clamp(targetSpherical.radius, 3.2, 12);

  lockedCountryKey = mesh.userData?.countryCode || mesh.userData?.countryEn || lockedCountryKey;
  lockedSubregionKey = null;
  isSelectionLocked = true;
  activeCountryKey = lockedCountryKey;
  highlightCountryBorder(lockedCountryKey);
  highlightSubregionBorder(null);

  isFocusing = true;
  targetAutoRotateSpeed = 0;

  tween(
    CONFIG.focusDurationMs,
    (k) => {
      const eased = easeInOutCubic(k);
      const theta = lerpAngle(startTheta, endTheta, eased);
      const phi = THREE.MathUtils.lerp(startPhi, endPhi, eased);
      const radius = THREE.MathUtils.lerp(startRadius, endRadius, eased);
      const s = new THREE.Spherical(radius, phi, theta);
      camera.position.copy(new THREE.Vector3().setFromSpherical(s));
      camera.lookAt(lookAt);
    },
    () => {
      isFocusing = false;
      if (orbit?.syncFromCamera) orbit.syncFromCamera();
      updateActiveCountryEffects();
    }
  );
}

function selectSubregion(area) {
  if (!area) return;
  const countryCode = String(area.countryCode || "").toUpperCase();
  lockedCountryKey = countryCode;
  lockedSubregionKey = area.key;
  isSelectionLocked = true;
  activeCountryKey = lockedCountryKey;
  highlightCountryBorder(lockedCountryKey);
  highlightSubregionBorder(lockedSubregionKey);

  focusOnLatLon(area.center.lat, area.center.lon, CONFIG.focusZoomDistance);
  fillPanelFromSubregion(area);
}

function focusOnLatLon(lat, lon, zoomDistance) {
  const lookAt = orbit?.target ? orbit.target : new THREE.Vector3(0, 0, 0);

  const localDir = latLongToVector3(Number(lat), Number(lon), 1).normalize();
  const worldDir = earthGroup ? localDir.clone().applyQuaternion(earthGroup.quaternion).normalize() : localDir;

  const targetRadius = Math.max(3.2, Number(zoomDistance) || CONFIG.focusZoomDistance);
  const targetSpherical = new THREE.Spherical().setFromVector3(worldDir.clone().multiplyScalar(targetRadius));

  const startSpherical = orbit?.getCurrentSpherical ? orbit.getCurrentSpherical() : new THREE.Spherical().setFromVector3(camera.position);

  const startTheta = startSpherical.theta;
  const startPhi = startSpherical.phi;
  const startRadius = startSpherical.radius;

  const endTheta = targetSpherical.theta;
  const endPhi = THREE.MathUtils.clamp(targetSpherical.phi, 0.25, Math.PI - 0.25);
  const endRadius = THREE.MathUtils.clamp(targetSpherical.radius, 3.2, 12);

  isFocusing = true;
  targetAutoRotateSpeed = 0;

  tween(
    CONFIG.focusDurationMs,
    (k) => {
      const eased = easeInOutCubic(k);
      const theta = lerpAngle(startTheta, endTheta, eased);
      const phi = THREE.MathUtils.lerp(startPhi, endPhi, eased);
      const radius = THREE.MathUtils.lerp(startRadius, endRadius, eased);
      const s = new THREE.Spherical(radius, phi, theta);
      camera.position.copy(new THREE.Vector3().setFromSpherical(s).add(lookAt));
      camera.lookAt(lookAt);
    },
    () => {
      isFocusing = false;
      if (orbit?.syncFromCamera) orbit.syncFromCamera();
      updateActiveCountryEffects();
    }
  );
}

function tween(durationMs, onUpdate, onComplete) {
  const start = performance.now();
  const tick = () => {
    const now = performance.now();
    const k = Math.min(1, (now - start) / durationMs);
    onUpdate(k);
    if (k < 1) {
      requestAnimationFrame(tick);
      return;
    }
    if (typeof onComplete === "function") onComplete();
  };
  requestAnimationFrame(tick);
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerpAngle(a, b, t) {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

function createOrbitController(camera, domElement, options) {
  // 一个最小可用的 Orbit 控制器：
  // - 左键拖拽：绕 target 旋转相机
  // - 滚轮：缩放（改变半径）
  // - damping：让旋转与缩放更“高级感”与顺滑
  const target = options?.target || new THREE.Vector3(0, 0, 0);

  const state = {
    target,
    minDistance: options?.minDistance ?? 3.2,
    maxDistance: options?.maxDistance ?? 12,
    rotateSpeed: options?.rotateSpeed ?? 0.006,
    zoomSpeed: options?.zoomSpeed ?? 0.0028,
    damping: options?.damping ?? 0.12,
    minPolarAngle: options?.minPolarAngle ?? 0.25,
    maxPolarAngle: options?.maxPolarAngle ?? Math.PI - 0.25,
    isDragging: false,
    lastX: 0,
    lastY: 0,
  };

  const current = new THREE.Spherical();
  const desired = new THREE.Spherical();
  const v = new THREE.Vector3();

  function syncFromCamera() {
    current.setFromVector3(camera.position.clone().sub(state.target));
    desired.copy(current);
  }

  function applyCameraFromSpherical(spherical) {
    v.setFromSpherical(spherical).add(state.target);
    camera.position.copy(v);
    camera.lookAt(state.target);
  }

  function onPointerDown(ev) {
    state.isDragging = true;
    state.lastX = ev.clientX;
    state.lastY = ev.clientY;
    domElement.setPointerCapture?.(ev.pointerId);
  }

  function onPointerMove(ev) {
    if (!state.isDragging) return;
    const dx = ev.clientX - state.lastX;
    const dy = ev.clientY - state.lastY;
    state.lastX = ev.clientX;
    state.lastY = ev.clientY;

    desired.theta -= dx * state.rotateSpeed;
    desired.phi -= dy * state.rotateSpeed;
    desired.phi = THREE.MathUtils.clamp(desired.phi, state.minPolarAngle, state.maxPolarAngle);
  }

  function onPointerUp() {
    state.isDragging = false;
  }

  function onWheel(ev) {
    const delta = ev.deltaY;
    desired.radius *= 1 + delta * state.zoomSpeed;
    desired.radius = THREE.MathUtils.clamp(desired.radius, state.minDistance, state.maxDistance);
  }

  function update() {
    current.theta += (desired.theta - current.theta) * state.damping;
    current.phi += (desired.phi - current.phi) * state.damping;
    current.radius += (desired.radius - current.radius) * state.damping;
    applyCameraFromSpherical(current);
  }

  return {
    target,
    syncFromCamera,
    getCurrentSpherical: () => current.clone(),
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheel,
    update,
  };
}

async function fetchJsonWithFallback(localUrl, fallbackUrl) {
  try {
    const res = await fetch(localUrl);
    if (!res.ok) throw new Error("local fetch failed");
    return await res.json();
  } catch (e) {
    const res = await fetch(fallbackUrl);
    if (!res.ok) throw new Error("fallback fetch failed");
    return await res.json();
  }
}

async function loadTextureWithFallback(loader, localUrl, fallbackUrl) {
  try {
    return await loadTexture(loader, localUrl);
  } catch (e) {
    return await loadTexture(loader, fallbackUrl);
  }
}

function loadTexture(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (tex) => resolve(tex),
      undefined,
      () => reject(new Error("texture load failed"))
    );
  });
}

function formatTemp(value) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}°C`;
}

function formatWeatherZh(weather) {
  const w = String(weather || "").toLowerCase();
  if (!w) return "—";
  if (w.includes("clear")) return "晴";
  if (w.includes("cloud")) return "阴";
  if (w.includes("rain") || w.includes("drizzle") || w.includes("thunder")) return "雨";
  if (w.includes("snow")) return "雪";
  if (w.includes("fog") || w.includes("mist") || w.includes("haze") || w.includes("smoke")) return "雾";
  return "阴";
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function temperatureToColor(tempC) {
  // 温度 -> 颜色映射（平滑插值）
  // - < 0°C → 白色（靠近 0°C 会渐变到蓝色，避免“硬断层”）
  // - 0~20°C → 蓝色（0 到 20 做轻微蓝色渐变，仍保持“蓝色区间”）
  // - 20~40°C → 金色（蓝 -> 金 平滑过渡）
  // - > 40°C → 红色（金 -> 红 平滑过渡）
  const t = Number(tempC);
  const white = new THREE.Color(0xffffff);
  const blueCold = new THREE.Color(0x1f7bff);
  const blueWarm = new THREE.Color(0x4aa7ff);
  const gold = new THREE.Color(0xf5c35c);
  const red = new THREE.Color(0xff4b4b);

  if (!Number.isFinite(t)) return blueCold.clone();

  if (t <= -5) {
    return white.clone();
  }
  if (t < 0) {
    const k = clamp01((t + 5) / 5);
    return lerpColor(white, blueCold, k);
  }

  if (t <= 20) {
    const k = clamp01(t / 20);
    return lerpColor(blueCold, blueWarm, k);
  }
  if (t <= 40) {
    const k = clamp01((t - 20) / 20);
    return lerpColor(blueWarm, gold, k);
  }
  if (t >= 55) {
    return red.clone();
  }
  const k = clamp01((t - 40) / 15);
  return lerpColor(gold, red, k);
}

function lerpColor(a, b, t) {
  const c = a.clone();
  c.lerp(b, clamp01(t));
  return c;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function latLongToVector3(lat, lon, radius) {
  // 经纬度 -> Three.js 球面坐标
  // - lat: [-90, 90]（北纬为正）
  // - lon: [-180, 180]（东经为正）
  // - radius: 球半径
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);
  return new THREE.Vector3(x, y, z);
}

function getFrontendSampleData() {
  return [
    {"country": "China", "country_zh": "中国", "country_code": "CN", "city": "Beijing", "lat": 39.9042, "lon": 116.4074, "temperature": 18, "humidity": 35, "wind_speed": 2.8, "wind_deg": 40, "weather": "Clear", "source": "sample"},
    {"country": "United States", "country_zh": "美国", "country_code": "US", "city": "Washington", "lat": 38.9072, "lon": -77.0369, "temperature": 22, "humidity": 50, "wind_speed": 3.6, "wind_deg": 210, "weather": "Clouds", "source": "sample"},
    {"country": "Brazil", "country_zh": "巴西", "country_code": "BR", "city": "Brasilia", "lat": -15.7939, "lon": -47.8828, "temperature": 29, "humidity": 62, "wind_speed": 4.2, "wind_deg": 160, "weather": "Rain", "source": "sample"},
    {"country": "United Kingdom", "country_zh": "英国", "country_code": "GB", "city": "London", "lat": 51.5072, "lon": -0.1276, "temperature": 12, "humidity": 70, "wind_speed": 5.1, "wind_deg": 260, "weather": "Clouds", "source": "sample"},
    {"country": "France", "country_zh": "法国", "country_code": "FR", "city": "Paris", "lat": 48.8566, "lon": 2.3522, "temperature": 14, "humidity": 60, "wind_speed": 4.8, "wind_deg": 240, "weather": "Clouds", "source": "sample"},
    {"country": "Russia", "country_zh": "俄罗斯", "country_code": "RU", "city": "Moscow", "lat": 55.7558, "lon": 37.6173, "temperature": 3, "humidity": 65, "wind_speed": 6.2, "wind_deg": 300, "weather": "Snow", "source": "sample"},
    {"country": "India", "country_zh": "印度", "country_code": "IN", "city": "New Delhi", "lat": 28.6139, "lon": 77.209, "temperature": 33, "humidity": 40, "wind_speed": 2.2, "wind_deg": 120, "weather": "Haze", "source": "sample"},
    {"country": "Japan", "country_zh": "日本", "country_code": "JP", "city": "Tokyo", "lat": 35.6762, "lon": 139.6503, "temperature": 19, "humidity": 55, "wind_speed": 3.0, "wind_deg": 80, "weather": "Clear", "source": "sample"},
    {"country": "Australia", "country_zh": "澳大利亚", "country_code": "AU", "city": "Canberra", "lat": -35.2809, "lon": 149.1300, "temperature": 24, "humidity": 45, "wind_speed": 4.0, "wind_deg": 200, "weather": "Clear", "source": "sample"},
    {"country": "Singapore", "country_zh": "新加坡", "country_code": "SG", "city": "Singapore", "lat": 1.3521, "lon": 103.8198, "temperature": 31, "humidity": 70, "wind_speed": 3.5, "wind_deg": 160, "weather": "Clouds", "source": "sample"},
    {"country": "South Africa", "country_zh": "南非", "country_code": "ZA", "city": "Pretoria", "lat": -25.7479, "lon": 28.2293, "temperature": 27, "humidity": 35, "wind_speed": 4.6, "wind_deg": 140, "weather": "Clear", "source": "sample"},
    {"country": "Canada", "country_zh": "加拿大", "country_code": "CA", "city": "Ottawa", "lat": 45.4215, "lon": -75.6972, "temperature": -2, "humidity": 75, "wind_speed": 5.4, "wind_deg": 330, "weather": "Snow", "source": "sample"},
    {"country": "Germany", "country_zh": "德国", "country_code": "DE", "city": "Berlin", "lat": 52.5200, "lon": 13.4050, "temperature": 12, "humidity": 65, "wind_speed": 4.2, "wind_deg": 240, "weather": "Clouds", "source": "sample"},
    {"country": "Argentina", "country_zh": "阿根廷", "country_code": "AR", "city": "Buenos Aires", "lat": -34.6037, "lon": -58.3816, "temperature": 15, "humidity": 70, "wind_speed": 3.1, "wind_deg": 180, "weather": "Clear", "source": "sample"},
    {"country": "Egypt", "country_zh": "埃及", "country_code": "EG", "city": "Cairo", "lat": 30.0444, "lon": 31.2357, "temperature": 28, "humidity": 40, "wind_speed": 4.5, "wind_deg": 350, "weather": "Clear", "source": "sample"},
    {"country": "Italy", "country_zh": "意大利", "country_code": "IT", "city": "Rome", "lat": 41.9028, "lon": 12.4964, "temperature": 20, "humidity": 55, "wind_speed": 2.5, "wind_deg": 210, "weather": "Clear", "source": "sample"},
    {"country": "Mexico", "country_zh": "墨西哥", "country_code": "MX", "city": "Mexico City", "lat": 19.4326, "lon": -99.1332, "temperature": 24, "humidity": 45, "wind_speed": 3.8, "wind_deg": 90, "weather": "Clouds", "source": "sample"},
    {"country": "Thailand", "country_zh": "泰国", "country_code": "TH", "city": "Bangkok", "lat": 13.7563, "lon": 100.5018, "temperature": 34, "humidity": 65, "wind_speed": 2.2, "wind_deg": 180, "weather": "Haze", "source": "sample"},
    {"country": "Turkey", "country_zh": "土耳其", "country_code": "TR", "city": "Ankara", "lat": 39.9334, "lon": 32.8597, "temperature": 18, "humidity": 45, "wind_speed": 3.4, "wind_deg": 120, "weather": "Clear", "source": "sample"},
    {"country": "Saudi Arabia", "country_zh": "沙特阿拉伯", "country_code": "SA", "city": "Riyadh", "lat": 24.7136, "lon": 46.6753, "temperature": 38, "humidity": 15, "wind_speed": 5.2, "wind_deg": 330, "weather": "Clear", "source": "sample"},
    {"country": "Indonesia", "country_zh": "印度尼西亚", "country_code": "ID", "city": "Jakarta", "lat": -6.2088, "lon": 106.8456, "temperature": 32, "humidity": 75, "wind_speed": 2.8, "wind_deg": 270, "weather": "Rain", "source": "sample"},
    {"country": "Spain", "country_zh": "西班牙", "country_code": "ES", "city": "Madrid", "lat": 40.4168, "lon": -3.7038, "temperature": 22, "humidity": 40, "wind_speed": 3.2, "wind_deg": 240, "weather": "Clear", "source": "sample"},
    {"country": "Norway", "country_zh": "挪威", "country_code": "NO", "city": "Oslo", "lat": 59.9139, "lon": 10.7522, "temperature": 8, "humidity": 60, "wind_speed": 4.1, "wind_deg": 300, "weather": "Clouds", "source": "sample"},
    {"country": "New Zealand", "country_zh": "新西兰", "country_code": "NZ", "city": "Wellington", "lat": -41.2865, "lon": 174.7762, "temperature": 14, "humidity": 75, "wind_speed": 8.5, "wind_deg": 160, "weather": "Rain", "source": "sample"},
    {"country": "South Korea", "country_zh": "韩国", "country_code": "KR", "city": "Seoul", "lat": 37.5665, "lon": 126.9780, "temperature": 18, "humidity": 50, "wind_speed": 3.0, "wind_deg": 90, "weather": "Clear", "source": "sample"}
  ];
}

// 添加 flyToCity 函数供父页面调用
window.flyToCity = function(cityName) {
    console.log('flyToCity called:', cityName);
    
    // 查找搜索框并触发搜索
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = cityName;
        searchInput.dispatchEvent(new Event('input'));
        
        // 等待搜索结果出现后自动点击第一个
        setTimeout(() => {
            const firstResult = document.querySelector('.searchbar__item');
            if (firstResult) {
                firstResult.click();
            } else {
                // 如果没有搜索结果，尝试直接通过坐标查找并聚焦
                // 这里可以添加经纬度查找逻辑
            }
        }, 500);
    }
};

// ==================== 添加接收父页面消息的功能 ====================
window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'flyTo') {
        const cityName = event.data.city;
        console.log('收到跳转指令:', cityName);
        
        // 尝试通过搜索框跳转
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.value = cityName;
            searchInput.dispatchEvent(new Event('input'));
            
            // 等待搜索结果出现后自动点击第一个
            setTimeout(() => {
                const firstResult = document.querySelector('.searchbar__item');
                if (firstResult) {
                    firstResult.click();
                } else {
                    // 如果没有搜索结果，尝试通过坐标查找
                    console.log('未找到搜索结果，尝试其他方式');
                }
            }, 500);
        }
    }
});

// 暴露函数供外部调用
window.flyToCity = function(cityName) {
    console.log('flyToCity called:', cityName);
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = cityName;
        searchInput.dispatchEvent(new Event('input'));
        setTimeout(() => {
            const firstResult = document.querySelector('.searchbar__item');
            if (firstResult) firstResult.click();
        }, 500);
    }
};
