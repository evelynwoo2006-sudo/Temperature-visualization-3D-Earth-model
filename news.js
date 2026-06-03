(() => {
  const COUNTRY_CODE_BY_NAME = {
    China: "CN",
    中国: "CN",
    "United States": "US",
    美国: "US",
    "United Kingdom": "GB",
    英国: "GB",
    UK: "GB",
    Germany: "DE",
    德国: "DE",
    France: "FR",
    法国: "FR",
    Japan: "JP",
    日本: "JP",
    Russia: "RU",
    俄罗斯: "RU",
    India: "IN",
    印度: "IN",
    Brazil: "BR",
    巴西: "BR",
    Canada: "CA",
    加拿大: "CA",
    Australia: "AU",
    澳大利亚: "AU",
    Italy: "IT",
    意大利: "IT",
    Spain: "ES",
    西班牙: "ES",
    Mexico: "MX",
    墨西哥: "MX",
    "South Korea": "KR",
    韩国: "KR",
    Korea: "KR",
    "Saudi Arabia": "SA",
    沙特阿拉伯: "SA",
    Turkey: "TR",
    土耳其: "TR",
    Ukraine: "UA",
    乌克兰: "UA",
    Israel: "IL",
    以色列: "IL",
    "South Africa": "ZA",
    南非: "ZA",
    Indonesia: "ID"
  };

  const COUNTRY_EN_BY_ZH = {
    中国: "China",
    美国: "United States",
    英国: "United Kingdom",
    德国: "Germany",
    法国: "France",
    日本: "Japan",
    俄罗斯: "Russia",
    印度: "India",
    巴西: "Brazil",
    加拿大: "Canada",
    澳大利亚: "Australia",
    意大利: "Italy",
    西班牙: "Spain",
    墨西哥: "Mexico",
    韩国: "South Korea",
    沙特阿拉伯: "Saudi Arabia",
    土耳其: "Turkey",
    乌克兰: "Ukraine",
    以色列: "Israel",
    南非: "South Africa",
    印度尼西亚: "Indonesia"
  };

  const COUNTRY_MENTION_BY_CODE = {
    CN: "(China OR Chinese OR Beijing OR Shanghai)",
    US: "(\"United States\" OR U.S. OR American OR Washington)",
    GB: "(\"United Kingdom\" OR Britain OR British OR London)",
    DE: "(Germany OR German OR Berlin)",
    FR: "(France OR French OR Paris)",
    JP: "(Japan OR Japanese OR Tokyo)",
    RU: "(Russia OR Russian OR Moscow)",
    IN: "(India OR Indian OR \"New Delhi\")",
    BR: "(Brazil OR Brazilian OR Brasilia)",
    CA: "(Canada OR Canadian OR Ottawa)",
    AU: "(Australia OR Australian OR Canberra)",
    IT: "(Italy OR Italian OR Rome)",
    ES: "(Spain OR Spanish OR Madrid)",
    MX: "(Mexico OR Mexican OR \"Mexico City\")",
    KR: "(\"South Korea\" OR Korean OR Seoul)",
    SA: "(\"Saudi Arabia\" OR Saudi OR Riyadh)",
    TR: "(Turkey OR Turkish OR Ankara)",
    UA: "(Ukraine OR Ukrainian OR Kyiv)",
    IL: "(Israel OR Israeli OR Jerusalem)",
    ZA: "(\"South Africa\" OR South African OR Pretoria)",
    ID: "(Indonesia OR Indonesian OR Jakarta)"
  };

  const CATEGORIES = [
    {
      tag: "国际外交",
      query: "(diplomacy OR diplomatic OR summit OR minister OR embassy OR sanctions OR nato OR un OR treaty OR ceasefire OR talks)"
    },
    {
      tag: "金融要事",
      query: "(market OR stocks OR bonds OR inflation OR central bank OR interest rate OR earnings OR gdp OR trade OR tariff OR oil)"
    },
    {
      tag: "AI科技",
      query: "(ai OR \"artificial intelligence\" OR openai OR model OR chip OR semiconductor OR nvidia OR robotics OR automation)"
    }
  ];

  const PREFERRED_SOURCES = [
    { label: "BBC", domains: ["bbc.co.uk", "bbc.com"] },
    { label: "CNN", domains: ["cnn.com"] },
    { label: "新华网", domains: ["xinhuanet.com"] },
    { label: "人民网", domains: ["people.com.cn"] }
  ];

  const STATE = {
    lastCountryKey: null,
    lastCountryName: null,
    currentAbort: null,
    activeRequestId: 0,
    requestSeq: 0,
    cache: new Map(),
    fetchMode: "auto"
  };

  const CACHE_TTL_MS = 2 * 60 * 1000;
  const CACHE_STALE_MS = 45 * 1000;
  const FETCH_TIMEOUT_MS = 6500;
  const HEDGE_DELAY_MS = 650;

  function byId(id) {
    return document.getElementById(id);
  }

  function safeText(el) {
    if (!el) return "";
    return (el.textContent || "").trim();
  }

  function setDisplay(el, value) {
    if (!el) return;
    el.style.display = value;
  }

  function formatUtcYmd(date) {
    const y = String(date.getUTCFullYear());
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }

  function formatYmdHisUtc(date, endOfDay) {
    const ymd = formatUtcYmd(date);
    return endOfDay ? `${ymd}235959` : `${ymd}000000`;
  }

  function buildGdeltUrl(query, startDateTime, endDateTime, maxRecords) {
    const base = "https://api.gdeltproject.org/api/v2/doc/doc";
    const params = new URLSearchParams();
    params.set("query", query);
    params.set("mode", "ArtList");
    params.set("format", "json");
    params.set("maxrecords", String(maxRecords));
    params.set("sort", "HybridRel");
    if (startDateTime) params.set("startdatetime", startDateTime);
    if (endDateTime) params.set("enddatetime", endDateTime);
    return `${base}?${params.toString()}`;
  }

  function buildPreferredDomainFilter() {
    const domains = [];
    for (let i = 0; i < PREFERRED_SOURCES.length; i += 1) {
      const entry = PREFERRED_SOURCES[i];
      for (let j = 0; j < entry.domains.length; j += 1) {
        domains.push(entry.domains[j]);
      }
    }
    const unique = Array.from(new Set(domains));
    if (unique.length === 0) return "";
    return `(${unique.map((d) => `domain:${d}`).join(" OR ")})`;
  }

  function getSourceLabel(domain) {
    if (typeof domain !== "string" || !domain) return "";
    const lower = domain.toLowerCase();
    for (let i = 0; i < PREFERRED_SOURCES.length; i += 1) {
      const entry = PREFERRED_SOURCES[i];
      for (let j = 0; j < entry.domains.length; j += 1) {
        const d = entry.domains[j];
        if (lower === d || lower.endsWith(`.${d}`)) return entry.label;
      }
    }
    return domain;
  }

  function buildSearchUrl(title) {
    const q = typeof title === "string" ? title.trim() : "";
    return `https://www.bing.com/search?q=${encodeURIComponent(q || "news")}`;
  }

  function isChinaCountry(countryName, countryCode) {
    const cc = String(countryCode || "").toUpperCase();
    if (cc === "CN") return true;
    const n = String(countryName || "").trim();
    if (!n) return false;
    if (n.includes("中国")) return true;
    return n.toLowerCase() === "china";
  }

  function isChineseOnlyTitle(title) {
    const s = String(title || "").trim();
    if (!s) return false;
    if (!/[\u3400-\u9FFF]/.test(s)) return false;
    if (/[A-Za-z]/.test(s)) return false;
    if (/[ぁ-んァ-ン]/.test(s)) return false;
    if (/[가-힣]/.test(s)) return false;
    if (/[А-Яа-яЁё]/.test(s)) return false;
    return true;
  }

  function buildPreferredDomainFilterForCountry(countryName, countryCode) {
    if (isChinaCountry(countryName, countryCode)) {
      return "(domain:xinhuanet.com OR domain:people.com.cn)";
    }
    return buildPreferredDomainFilter();
  }

  const CORS_FALLBACKS = [
    (targetUrl) => `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`
  ];

  function createLinkedAbortController(outerSignal) {
    const c = new AbortController();
    if (outerSignal) {
      if (outerSignal.aborted) c.abort();
      else outerSignal.addEventListener("abort", () => c.abort(), { once: true });
    }
    return c;
  }

  function firstFulfilled(promises) {
    return new Promise((resolve, reject) => {
      let pending = promises.length;
      const errors = [];
      if (pending === 0) reject(new Error("No promises"));
      for (let i = 0; i < promises.length; i += 1) {
        Promise.resolve(promises[i])
          .then(resolve)
          .catch((e) => {
            errors.push(e);
            pending -= 1;
            if (pending <= 0) reject(errors[0] || e);
          });
      }
    });
  }

  function buildCacheKey(countryName, countryCode, date) {
    return `${countryName || ""}|${countryCode || ""}|${formatUtcYmd(date)}|v2`;
  }

  function getCacheEntry(cacheKey) {
    const entry = STATE.cache.get(cacheKey);
    if (!entry || !entry.items || !entry.ts) return null;
    return entry;
  }

  function setCacheEntry(cacheKey, items) {
    STATE.cache.set(cacheKey, { ts: Date.now(), items });
  }

  async function fetchJson(url, signal) {
    async function tryFetchJson(targetUrl, controller) {
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(targetUrl, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(timeout);
      }
    }

    const directCtrl = createLinkedAbortController(signal);
    const proxyCtrl = createLinkedAbortController(signal);
    let proxyTimer = null;

    function clearProxyTimer() {
      if (proxyTimer) {
        clearTimeout(proxyTimer);
        proxyTimer = null;
      }
    }

    function makeProxyPromise() {
      return new Promise((resolve, reject) => {
        proxyTimer = setTimeout(() => {
          const proxyUrl = CORS_FALLBACKS[0] ? CORS_FALLBACKS[0](url) : url;
          tryFetchJson(proxyUrl, proxyCtrl)
            .then((json) => resolve({ mode: "proxy", json }))
            .catch(reject);
        }, HEDGE_DELAY_MS);
      });
    }

    const directPromise =
      STATE.fetchMode === "proxy"
        ? Promise.reject(new Error("skip direct"))
        : tryFetchJson(url, directCtrl).then((json) => ({ mode: "direct", json }));

    const proxyPromise = STATE.fetchMode === "direct" ? Promise.reject(new Error("skip proxy")) : makeProxyPromise();

    try {
      const result = await firstFulfilled([directPromise, proxyPromise]);
      clearProxyTimer();
      if (result.mode === "direct") proxyCtrl.abort();
      else directCtrl.abort();
      STATE.fetchMode = result.mode;
      return result.json;
    } catch (e) {
      clearProxyTimer();
      try {
        directCtrl.abort();
        proxyCtrl.abort();
      } catch (_) {
        return null;
      }
      for (let i = 0; i < CORS_FALLBACKS.length; i += 1) {
        const ctrl = createLinkedAbortController(signal);
        try {
          const json = await tryFetchJson(CORS_FALLBACKS[i](url), ctrl);
          STATE.fetchMode = "proxy";
          return json;
        } catch (inner) {
          if (signal?.aborted) throw inner;
        }
      }
      throw e;
    }
  }

  function formatGdeltSeenDate(seendate) {
    if (typeof seendate !== "string") return "";
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(seendate);
    if (!m) return seendate;
    const hh = m[4];
    const mm = m[5];
    return `${hh}:${mm}`;
  }

  function normalizeGdeltArticle(article, tag) {
    const title = typeof article.title === "string" ? article.title : "";
    const rawUrl = typeof article.url === "string" ? article.url : "";
    const url = rawUrl || buildSearchUrl(title);
    const domain = typeof article.domain === "string" ? article.domain : "";
    const seendate = typeof article.seendate === "string" ? article.seendate : "";
    const summary =
      (typeof article.summary === "string" && article.summary) ||
      (typeof article.snippet === "string" && article.snippet) ||
      (typeof article.excerpt === "string" && article.excerpt) ||
      "";

    return {
      id: url || `${tag}-${seendate}-${title}`.slice(0, 120),
      title: title || "（无标题）",
      url,
      source: getSourceLabel(domain) || "GDELT",
      time: seendate || "",
      timeDisplay: formatGdeltSeenDate(seendate),
      tag,
      summary
    };
  }

  function buildCountryMention(countryName, countryCode) {
    const cc = String(countryCode || "").toUpperCase();
    if (cc && COUNTRY_MENTION_BY_CODE[cc]) return COUNTRY_MENTION_BY_CODE[cc];
    const raw = typeof countryName === "string" ? countryName.trim() : "";
    if (!raw) return "";
    const mapped = COUNTRY_EN_BY_ZH[raw];
    const finalName = mapped || raw;
    return `"${finalName}"`;
  }

  function getFallbackNews(countryName) {
    const name = countryName || "该国家";
    const dipTitle = `${name}：今日外交动态与国际会谈进展`;
    const finTitle = `${name}：市场波动与重要经济数据发布`;
    const aiTitle = `${name}：AI 与科技产业最新动态`;
    return [
      {
        id: `fallback-dip-${name}`,
        title: dipTitle,
        url: buildSearchUrl(dipTitle),
        source: "搜索",
        time: "今天",
        tag: "国际外交",
        summary: "未能获取到可直接打开的实时新闻链接，已提供搜索入口。"
      },
      {
        id: `fallback-fin-${name}`,
        title: finTitle,
        url: buildSearchUrl(finTitle),
        source: "搜索",
        time: "今天",
        tag: "金融要事",
        summary: "未能获取到可直接打开的实时新闻链接，已提供搜索入口。"
      },
      {
        id: `fallback-ai-${name}`,
        title: aiTitle,
        url: buildSearchUrl(aiTitle),
        source: "搜索",
        time: "今天",
        tag: "AI科技",
        summary: "未能获取到可直接打开的实时新闻链接，已提供搜索入口。"
      }
    ];
  }

  async function loadCountryNews(countryName, countryCode, opts) {
    const options = opts || {};
    const today = new Date();
    const todayStart = formatYmdHisUtc(today, false);
    const todayEnd = formatYmdHisUtc(today, true);
    const wideDate = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000);
    const wideStart = formatYmdHisUtc(wideDate, false);

    const baseFilter = buildCountryMention(countryName, countryCode);
    const preferredDomains = buildPreferredDomainFilterForCountry(countryName, countryCode);
    const requireChineseTitle = isChinaCountry(countryName, countryCode);

    const controller = new AbortController();
    if (STATE.currentAbort) STATE.currentAbort.abort();
    STATE.currentAbort = controller;

    const cacheKey = buildCacheKey(countryName, countryCode, today);
    const cached = getCacheEntry(cacheKey);
    if (cached && !options.forceRefresh && Date.now() - cached.ts < CACHE_TTL_MS) return cached.items;

    if (!baseFilter) {
      const fallbacks = getFallbackNews(countryName);
      setCacheEntry(cacheKey, fallbacks);
      return fallbacks;
    }

    const picked = [];
    const usedKeys = new Set();

    function pushUniqueNormalized(normalized) {
      const key = normalized.url || normalized.id;
      if (!key) return false;
      if (usedKeys.has(key)) return false;
      usedKeys.add(key);
      picked.push(normalized);
      return true;
    }

    async function pickFirstFromQuery(query, tag, maxRecords, startDateTime, endDateTime) {
      const url = buildGdeltUrl(query, startDateTime, endDateTime, maxRecords);
      const json = await fetchJson(url, controller.signal);
      const articles = json && json.articles && Array.isArray(json.articles) ? json.articles : [];
      for (let i = 0; i < articles.length; i += 1) {
        const normalized = normalizeGdeltArticle(articles[i], tag);
        if (requireChineseTitle) {
          if (!isChineseOnlyTitle(normalized.title)) continue;
          if (normalized.summary && !isChineseOnlyTitle(normalized.summary)) continue;
        }
        return normalized;
      }
      return null;
    }

    async function pickOnePerCategory(category, startDateTime, endDateTime, maxRecords) {
      const q = [];
      if (baseFilter) {
        if (preferredDomains) q.push(`${baseFilter} ${preferredDomains} ${category.query}`.trim());
        q.push(`${baseFilter} ${category.query}`.trim());
      }
      const queries = q.filter(Boolean);
      for (let i = 0; i < queries.length; i += 1) {
        try {
          const found = await pickFirstFromQuery(queries[i], category.tag, maxRecords, startDateTime, endDateTime);
          if (found) return found;
        } catch (e) {
          if (controller.signal.aborted) throw e;
        }
      }
      return null;
    }

    async function runRange(startDateTime, endDateTime, maxRecords) {
      const tasks = [];
      for (let i = 0; i < CATEGORIES.length; i += 1) {
        const category = CATEGORIES[i];
        const task = pickOnePerCategory(category, startDateTime, endDateTime, maxRecords)
          .then((found) => ({ idx: i, found }))
          .catch((e) => {
            if (controller.signal.aborted) throw e;
            return { idx: i, found: null };
          });
        tasks.push(task);
      }

      const settled = tasks.map((p) =>
        p.then((r) => {
          if (!r || !r.found) return null;
          const pushed = pushUniqueNormalized(r.found);
          if (pushed && typeof options.onProgress === "function") options.onProgress(picked.slice(0, 3));
          return r;
        })
      );

      await Promise.allSettled(settled);

      if (picked.length < 3) {
        const hotspot = (baseFilter || "").trim();
        if (hotspot) {
          try {
            const hotspotPreferred = preferredDomains ? `${hotspot} ${preferredDomains}`.trim() : "";
            if (hotspotPreferred) {
              const r1 = await pickFirstFromQuery(hotspotPreferred, "今日热点", 20, startDateTime, endDateTime);
              if (r1) {
                pushUniqueNormalized(r1);
                if (typeof options.onProgress === "function") options.onProgress(picked.slice(0, 3));
              }
            }
            if (picked.length < 3) {
              const r2 = await pickFirstFromQuery(hotspot, "今日热点", 20, startDateTime, endDateTime);
              if (r2) {
                pushUniqueNormalized(r2);
                if (typeof options.onProgress === "function") options.onProgress(picked.slice(0, 3));
              }
            }
          } catch (e) {
            if (controller.signal.aborted) throw e;
          }
        }
      }
    }

    await runRange(todayStart, todayEnd, 12);
    if (picked.length < 3) await runRange(wideStart, todayEnd, 18);

    if (picked.length < 3) {
      const fallbacks = getFallbackNews(countryName);
      for (let i = 0; i < fallbacks.length && picked.length < 3; i += 1) {
        pushUniqueNormalized(fallbacks[i]);
      }
    }

    const finalResults = picked.length >= 3 ? picked.slice(0, 3) : getFallbackNews(countryName);
    setCacheEntry(cacheKey, finalResults);
    return finalResults;
  }

  function renderNewsList(items) {
    const panel = byId("newsPanel");
    const hint = byId("newsHint");
    const list = byId("newsList");
    if (!panel || !list) return;

    setDisplay(panel, "block");
    if (hint) hint.textContent = "";
    while (list.firstChild) list.removeChild(list.firstChild);

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const entry = document.createElement("div");
      entry.className = "newsItem";
      entry.tabIndex = 0;
      entry.setAttribute("role", "button");
      entry.dataset.newsId = item.id;

      const title = document.createElement("div");
      title.className = "newsItem__title";
      title.textContent = item.title;

      const meta = document.createElement("div");
      meta.className = "newsItem__meta";

      const tag = document.createElement("span");
      tag.className = "newsItem__tag";
      tag.textContent = item.tag;

      const right = document.createElement("span");
      const metaText = [item.source, item.timeDisplay].filter(Boolean).join(" · ");
      right.textContent = metaText || item.time || "";

      meta.appendChild(tag);
      meta.appendChild(right);

      entry.appendChild(title);
      entry.appendChild(meta);

      entry.addEventListener("click", () => openModal(item));
      entry.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openModal(item);
        }
      });

      list.appendChild(entry);
    }
  }

  function openModal(item) {
    const modal = byId("newsModal");
    const titleEl = byId("newsModalTitle");
    const contentEl = byId("newsModalContent");
    if (!modal || !titleEl || !contentEl) return;

    titleEl.textContent = item.title || "";
    while (contentEl.firstChild) contentEl.removeChild(contentEl.firstChild);

    const meta = document.createElement("div");
    meta.style.marginBottom = "10px";
    meta.style.color = "rgba(235, 245, 255, 0.62)";
    meta.style.fontSize = "11px";
    meta.textContent = [item.tag, item.source, item.timeDisplay || item.time].filter(Boolean).join(" · ");
    contentEl.appendChild(meta);

    const p = document.createElement("div");
    p.textContent = item.summary || "未获取到摘要，可点击下方链接打开原文。";
    contentEl.appendChild(p);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "10px";
    actions.style.flexWrap = "wrap";
    actions.style.marginTop = "10px";

    const isSearch = typeof item.url === "string" && item.url.includes("bing.com/search?");
    const link = document.createElement("a");
    link.className = "newsModal__link";
    link.href = item.url || buildSearchUrl(item.title);
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = isSearch ? "打开搜索结果" : "打开原文";
    actions.appendChild(link);

    const search = document.createElement("a");
    search.className = "newsModal__link";
    search.href = buildSearchUrl(item.title);
    search.target = "_blank";
    search.rel = "noreferrer";
    search.textContent = "搜索同标题";
    if (!isSearch) actions.appendChild(search);

    contentEl.appendChild(actions);

    setDisplay(modal, "flex");
  }

  function closeModal() {
    const modal = byId("newsModal");
    if (!modal) return;
    setDisplay(modal, "none");
  }

  function wireModal() {
    const modal = byId("newsModal");
    const closeBtn = byId("newsModalClose");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeModal();
      });
    }
  }

  function getCountrySelection() {
    const enName = safeText(byId("panelCountry"));
    const zhName = safeText(byId("panelCountryZh"));
    const displayName = enName && enName !== "—" ? enName : zhName && zhName !== "—" ? zhName : "";
    const code = COUNTRY_CODE_BY_NAME[enName] || COUNTRY_CODE_BY_NAME[zhName] || "";
    const queryName = enName && enName !== "—" ? enName : (COUNTRY_EN_BY_ZH[zhName] || displayName || "");
    return { displayName, queryName, code };
  }

  function isAbortError(e) {
    if (!e) return false;
    if (e.name === "AbortError") return true;
    const msg = typeof e.message === "string" ? e.message : "";
    return /aborted/i.test(msg);
  }

  async function refreshIfChanged() {
    const { displayName, queryName, code } = getCountrySelection();
    if (!displayName) return;
    const key = `${queryName || displayName}|${code}`;
    if (STATE.lastCountryKey === key) return;
    STATE.lastCountryKey = key;
    STATE.lastCountryName = displayName;
    const requestId = (STATE.requestSeq += 1);
    STATE.activeRequestId = requestId;

    const hint = byId("newsHint");
    const panel = byId("newsPanel");
    const list = byId("newsList");
    if (panel) setDisplay(panel, "block");
    if (list) while (list.firstChild) list.removeChild(list.firstChild);

    const now = new Date();
    const cacheKey = buildCacheKey(queryName || displayName, code, now);
    const cached = getCacheEntry(cacheKey);
    const cachedItems = cached && Array.isArray(cached.items) ? cached.items : null;
    const age = cached ? Date.now() - cached.ts : Number.POSITIVE_INFINITY;
    const shouldRefresh = !cachedItems || age > CACHE_STALE_MS;

    if (cachedItems) {
      renderNewsList(cachedItems.slice(0, 3));
      if (hint) hint.textContent = shouldRefresh ? "更新中…" : "";
      if (!shouldRefresh) return;
    } else {
      if (hint) hint.textContent = "加载中…";
    }

    try {
      const items = await loadCountryNews(queryName || displayName, code, {
        forceRefresh: true,
        onProgress: (partial) => {
          if (STATE.activeRequestId !== requestId) return;
          if (Array.isArray(partial) && partial.length > 0) renderNewsList(partial.slice(0, 3));
        }
      });
      if (STATE.activeRequestId !== requestId) return;
      renderNewsList(items.slice(0, 3));
    } catch (e) {
      if (STATE.activeRequestId !== requestId) return;
      if (isAbortError(e)) return;
      if (hint) hint.textContent = "加载失败，已显示示例数据";
      renderNewsList(getFallbackNews(displayName));
    }
  }

  function startPolling() {
    wireModal();
    setInterval(() => {
      try {
        refreshIfChanged();
      } catch (e) {
        return;
      }
    }, 300);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startPolling);
  } else {
    startPolling();
  }
})();
