const state = {
  dashboard: null,
  selected: { exchange: "upbit", instrument: "KRW-BTC", asset: "BTC" },
  venue: "upbit_spot",
  timeframe: "4h",
  chart: null,
  candleSeries: null,
  lineSeries: [],
  priceLines: [],
  chartPayload: null,
  showIndicators: false,
  scalpMode: false,
  measure: { start: null, end: null },
  measureReady: false,
  stream: {
    enabled: true,
    upbit: null,
    binance: null,
    upbitConnected: false,
    binanceConnected: false,
    reconnectTimers: [],
    renderTimer: null,
    lastTickAt: null,
    renderRequested: false,
  },
};

const numberFormat = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 8 });
const moneyFormat = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });

const assetMeta = {
  BTC: { icon: "₿", className: "btc", korean: "비트코인" },
  ETH: { icon: "Ξ", className: "eth", korean: "이더리움" },
  XRP: { icon: "X", className: "xrp", korean: "리플" },
  SOL: { icon: "S", className: "sol", korean: "솔라나" },
};

const signalLabels = {
  buy: "매수 후보",
  watch: "관망",
  skip: "진입 보류",
  data_error: "데이터 오류",
};

const roleLabels = {
  core: "Core",
  aggressive: "Aggressive",
  leveraged: "Leveraged",
};

const regimeLabels = {
  bull: "상승장",
  neutral: "중립장",
  bear: "약세장",
  crash: "급락장",
  overheated: "과열장",
};

const timeframeLabels = {
  "1m": "1분",
  "3m": "3분",
  "5m": "5분",
  "10m": "10분",
  "15m": "15분",
  "30m": "30분",
  "1h": "1시간",
  "4h": "4시간",
  "1d": "일봉",
  "1w": "주봉",
  "1M": "월봉",
};

const streamAssets = [
  { asset: "BTC", upbit: "KRW-BTC", binance: "BTCUSDT" },
  { asset: "ETH", upbit: "KRW-ETH", binance: "ETHUSDT" },
  { asset: "XRP", upbit: "KRW-XRP", binance: "XRPUSDT" },
  { asset: "SOL", upbit: "KRW-SOL", binance: "SOLUSDT" },
];

const timeframeSeconds = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "10m": 600,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
  "1M": 2592000,
};

const venueConfig = {
  upbit_spot: { exchange: "upbit", label: "Upbit Spot", quote: "KRW", priceKey: "current_price" },
  binance_spot: { exchange: "binance", label: "Binance Spot", quote: "USDT", priceKey: "binance_price" },
  binance_futures: { exchange: "binance_futures", label: "Binance Futures", quote: "USDT", priceKey: "futures_price" },
};

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("refreshBtn").addEventListener("click", loadDashboard);
  document.getElementById("decisionRefresh").addEventListener("click", loadDashboard);
  document.getElementById("runPlanBtn").addEventListener("click", runDailyPlan);
  document.getElementById("streamToggle").addEventListener("click", toggleStreaming);
  document.getElementById("scalpToggle").addEventListener("click", toggleScalpMode);
  document.querySelectorAll(".exchange-tabs .tab[data-venue]").forEach((button) => {
    button.addEventListener("click", () => switchVenue(button.dataset.venue));
  });
  document.getElementById("indicatorToggle").addEventListener("click", () => {
    state.showIndicators = !state.showIndicators;
    updateIndicatorToggle();
    if (state.chartPayload) renderChart(state.chartPayload);
  });
  document.querySelectorAll(".tool-btn[data-timeframe]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tool-btn[data-timeframe]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.timeframe = button.dataset.timeframe;
      loadChart();
    });
  });
  document.getElementById("paperOrderForm").addEventListener("submit", submitPaperOrder);
  setupNavLinks();
  updateIndicatorToggle();
  updateScalpToggle();
  updateStreamStatus();
  loadDashboard();
  window.setInterval(refreshDashboardOnly, 30000);
});

function setupNavLinks() {
  document.querySelectorAll(".nav a[href^='#']").forEach((link) => {
    link.addEventListener("click", (event) => {
      const target = document.querySelector(link.getAttribute("href"));
      if (!target) return;
      event.preventDefault();
      document.querySelectorAll(".nav a").forEach((item) => item.classList.remove("active"));
      link.classList.add("active");
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", link.getAttribute("href"));
    });
  });
}

function switchVenue(venue) {
  if (!venueConfig[venue]) return;
  state.venue = venue;
  document.querySelectorAll(".exchange-tabs .tab[data-venue]").forEach((button) => {
    button.classList.toggle("active", button.dataset.venue === venue);
  });
  const asset = selectedAsset() || state.dashboard?.assets?.[0];
  if (asset) {
    state.selected = {
      asset: asset.asset,
      exchange: exchangeForVenue(venue),
      instrument: instrumentForVenue(asset, venue),
    };
  }
  renderDashboard();
  loadChart();
}

async function loadDashboard() {
  const response = await fetch("/api/dashboard");
  state.dashboard = await response.json();
  renderDashboard();
  await loadChart();
  if (state.stream.enabled) startStreaming();
}

async function refreshDashboardOnly() {
  try {
    const response = await fetch("/api/dashboard");
    state.dashboard = await response.json();
    renderDashboard();
    if (state.stream.enabled) startStreaming();
  } catch (_error) {
    updateStreamStatus("오류");
  }
}

function renderDashboard() {
  const data = state.dashboard;
  const regime = data.market_regime;
  normalizeSelection();
  document.getElementById("updatedAt").textContent = shortTime(data.updated_at);
  renderFxRates(data);
  document.getElementById("sideRegime").textContent = regimeLabels[regime.name] || regime.label;
  document.getElementById("sideRegimeReason").textContent = regime.reason;
  document.getElementById("sideRegimeIcon").textContent = regime.name === "bull" ? "상" : regime.name === "bear" ? "약" : "중";
  renderAutomationPolicy(data.automation);
  renderBookPolicy(data.book_policy);
  renderStrategyProfile(data.strategy_profile, data.deployment, data.risk);
  renderRiskPolicy(data.risk);
  renderScalpLab(data.scalp_lab);
  renderSettingsSummary(data);

  renderAssetCards(data.assets);
  renderDecision(selectedAsset());
  renderPortfolioOverview(data.portfolio, data.updated_at, data.performance);
  renderEquity(data.portfolio.equity);
  renderPositions(data.portfolio.positions);
  renderPerformance(data.performance);
  renderTrades(data.trades);
}

function renderFxRates(data) {
  const usdtKrw = Number(data?.usdt_krw || 0);
  const usdKrw = Number(data?.usd_krw_reference || 0);
  const basis = Number(data?.fx_basis_pct || 0);
  const usdtEl = document.getElementById("usdtRate");
  const usdEl = document.getElementById("usdRate");
  const basisEl = document.getElementById("fxBasis");

  if (usdtEl) {
    usdtEl.textContent = `USDT/KRW(업비트) ${usdtKrw > 0 ? formatPrice(usdtKrw) : "--"}`;
  }
  if (usdEl) {
    const date = data?.usd_krw_reference_date ? ` · ${data.usd_krw_reference_date}` : "";
    usdEl.textContent = `USD/KRW(참고) ${usdKrw > 0 ? formatPrice(usdKrw) : "--"}`;
    usdEl.title = `ECB 기준 참고 환율${date}. 실시간 은행 고시환율이 아닐 수 있습니다.`;
  }
  if (basisEl) {
    basisEl.textContent = `차이 ${Number.isFinite(basis) ? formatPct(basis) : "--"}`;
    basisEl.className = `pill fx-basis ${basis >= 0 ? "positive" : "negative"}`;
  }
}

function renderAutomationPolicy(policy) {
  if (!policy) return;
  document.getElementById("autoPriceStream").textContent = policy.price_stream || "실시간 tick";
  document.getElementById("autoChartAnalysis").textContent = policy.chart_analysis || "15분마다";
  document.getElementById("autoLevels").textContent = policy.support_resistance || "봉 마감 후";
  document.getElementById("autoMajorLevels").textContent = policy.major_levels || "KST 01:05...";
  document.getElementById("autoDaily").textContent = policy.daily_analysis || "09:10";
  document.getElementById("autoPlan").textContent = policy.paper_plan || "09:12";
}

function renderStrategyProfile(profile, deployment, risk) {
  if (!profile) return;
  document.getElementById("sideStrategyName").textContent = profile.name || "RGCA-L Neutral";
  document.getElementById("sideStage").textContent = translatePhase(deployment?.stage || "dry-run");
  document.getElementById("sideFuturesPolicy").textContent = `담보 ${profile.futures_collateral_pct}% / 명목 ${profile.futures_notional_cap_pct}%`;
  document.getElementById("riskFutures").textContent = risk?.futures_policy || "BTC/ETH만";
}

function renderBookPolicy(policy) {
  if (!policy) return;
  document.getElementById("bookUpbit").textContent = `${policy.upbit_pct}%`;
  document.getElementById("bookBinance").textContent = `${policy.binance_pct}%`;
  document.getElementById("bookRebalance").textContent = translateSchedule(policy.rebalancing?.schedule);
  document.getElementById("bookDrift").textContent = `${policy.rebalancing?.drift_threshold_pct_points ?? 5}%p`;
}

function renderRiskPolicy(risk) {
  if (!risk) return;
  document.getElementById("riskDailyLimit").textContent = `${Number(risk.daily_loss_limit_pct).toFixed(2)}%`;
  document.getElementById("riskWeeklyLimit").textContent = `${Number(risk.weekly_loss_limit_pct).toFixed(2)}%`;
  document.getElementById("riskAttackCap").textContent = `${Number(risk.attack_sleeve_abs_cap_pct || 30).toFixed(0)}%`;
  const lock = document.getElementById("riskLiveLock");
  lock.textContent = risk.live_trading_locked ? "ON" : "OFF";
  lock.className = risk.live_trading_locked ? "positive" : "negative";
}

function renderSettingsSummary(data) {
  const root = document.getElementById("settingsGrid");
  if (!root) return;
  const profile = data.strategy_profile || {};
  const book = data.book_policy || {};
  const rebalance = book.rebalancing || {};
  const execution = data.execution_policy || {};
  const futures = execution.futures || {};
  const risk = data.risk || {};
  const automation = data.automation || {};
  const performance = data.performance || {};
  const groups = [
    {
      title: "운용 프로필",
      rows: [
        ["전략", profile.name || "RGCA-L Neutral"],
        ["단계", translatePhase(execution.current_phase || "dry-run")],
        ["주문 라우터", risk.live_trading_locked ? "잠금" : "열림"],
        ["자동 출금", risk.auto_withdrawals ? "ON" : "OFF"],
      ],
    },
    {
      title: "자금 배분",
      rows: [
        ["Upbit-KRW", `${book.upbit_pct ?? 60}%`],
        ["Binance-USDT", `${book.binance_pct ?? 40}%`],
        ["현물/대기", `${profile.spot_weight_pct ?? 88}% / ${profile.reserve_pct ?? 8}%`],
        ["리밸런싱", `${translateSchedule(rebalance.schedule)} · ${rebalance.drift_threshold_pct_points ?? 5}%p`],
      ],
    },
    {
      title: "주문 실행",
      rows: [
        ["기본 주문", translateOrderType(execution.default_order_type)],
        ["비상 청산", translateOrderType(execution.emergency_exit_order_type)],
        ["최소주문 검증", execution.validate_min_order_before_submit ? "ON" : "OFF"],
        ["재시도 전 동기화", execution.state_reconcile_before_retry ? "ON" : "OFF"],
      ],
    },
    {
      title: "Futures",
      rows: [
        ["상태", futures.enabled ? "ON" : "OFF"],
        ["종목", (futures.symbols || ["BTCUSDT", "ETHUSDT"]).join(", ")],
        ["마진/모드", `${futures.margin_type || "isolated"} · ${futures.position_mode || "one-way"}`],
        ["최대", `${futures.max_leverage ?? 2}x · 명목 ${futures.gross_notional_cap_pct ?? 8}%`],
      ],
    },
    {
      title: "자동화/성과",
      rows: [
        ["차트 분석", automation.chart_analysis || "15분마다"],
        ["지지/저항", automation.support_resistance || "봉 마감 후"],
        ["주문 계획", automation.paper_plan || "09:12"],
        ["수익 스냅샷", `${performance.snapshot_count ?? 0}개`],
      ],
    },
  ];

  root.innerHTML = groups.map((group) => `
    <div class="settings-card">
      <h3>${group.title}</h3>
      ${group.rows.map(([label, value]) => `
        <div><span>${label}</span><b>${value}</b></div>
      `).join("")}
    </div>
  `).join("");
}

function renderScalpLab(scalp) {
  if (!scalp) return;
  document.getElementById("scalpStatus").textContent = scalp.enabled ? "준비됨" : "잠금";
  document.getElementById("scalpStatus").className = scalp.enabled ? "positive" : "caution";
  document.getElementById("scalpFeeGate").textContent = scalp.zero_fee_verified ? "무료 확인" : `${scalp.assumed_fee_bps} bps`;
  document.getElementById("scalpHold").textContent = `${scalp.max_hold_minutes}분`;
  document.getElementById("scalpDailyStop").textContent = `${scalp.daily_loss_stop_pct}%`;
}

function renderAssetCards(assets) {
  const root = document.getElementById("assets");
  root.innerHTML = assets.map((asset) => {
    const displayInstrument = instrumentForVenue(asset, state.venue);
    const displayExchange = exchangeForVenue(state.venue);
    const displayPrice = priceForVenue(asset, state.venue);
    const displayQuote = venueConfig[state.venue]?.quote || "KRW";
    const active = displayInstrument === state.selected.instrument && displayExchange === state.selected.exchange ? "active" : "";
    const flash = asset._flash ? `flash-${asset._flash}` : "";
    const meta = assetMeta[asset.asset] || { icon: asset.asset[0], className: "", korean: asset.asset };
    const changeClass = Number(asset.change_24h_pct) >= 0 ? "positive" : "negative";
    const kimchiClass = Number(asset.kimchi_premium_pct) >= 0 ? "positive" : "negative";
    return `
      <button class="asset-card ${active} ${flash}" data-instrument="${displayInstrument}" data-exchange="${displayExchange}" data-asset="${asset.asset}">
        <div class="asset-top">
          <div class="asset-title">
            <div class="coin ${meta.className}">${meta.icon}</div>
            <div>
              <h2>${asset.asset}</h2>
              <span class="muted-text">${meta.korean}</span>
            </div>
          </div>
          <span class="badge ${asset.asset_role}">${roleLabels[asset.asset_role] || asset.asset_role}</span>
          <span class="badge ${asset.signal}">${signalLabels[asset.signal] || asset.signal}</span>
        </div>
        <div class="price">${formatPrice(displayPrice)}<span>${displayQuote}</span></div>
        <div class="asset-metrics">
          <span>24h <strong class="${changeClass}">${formatPct(asset.change_24h_pct)}</strong></span>
          <span>김프 <strong class="${kimchiClass}">${formatPct(asset.kimchi_premium_pct)}</strong></span>
          <span>RSI(14) <strong>${asset.rsi}</strong></span>
          <span>ATR(14) <strong>${asset.atr_pct}%</strong></span>
          <span>지지 거리 <strong>${asset.support_distance_pct}%</strong></span>
          <span>저항 거리 <strong>${asset.resistance_distance_pct}%</strong></span>
          <span>거래량 <strong>${asset.volume_ratio}x</strong></span>
          <span>vs BTC <strong>${asset.relative_strength_vs_btc}</strong></span>
        </div>
      </button>
    `;
  }).join("");
  root.querySelectorAll(".asset-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.selected = {
        exchange: card.dataset.exchange,
        instrument: card.dataset.instrument,
        asset: card.dataset.asset,
      };
      renderAssetCards(state.dashboard.assets);
      renderDecision(selectedAsset());
      loadChart();
    });
  });
}

function renderDecision(asset) {
  if (!asset) return;
  const displayPrice = priceForVenue(asset, state.venue);
  const displayQuote = venueConfig[state.venue]?.quote || "KRW";
  document.getElementById("chartTitle").textContent = state.selected.instrument;
  updateChartCaption(asset);
  document.getElementById("decisionMarket").textContent = `${state.selected.instrument} · ${assetMeta[asset.asset]?.korean || asset.asset}`;
  document.getElementById("decisionSignal").textContent = signalLabels[asset.signal] || asset.signal;
  document.getElementById("decisionSummary").textContent = asset.reason_summary;
  document.getElementById("planCurrent").textContent = `${formatPrice(displayPrice)} ${displayQuote}`;
  document.getElementById("planKimchi").textContent = formatPct(asset.kimchi_premium_pct);
  document.getElementById("planKimchi").className = Number(asset.kimchi_premium_pct) >= 0 ? "positive" : "negative";
  document.getElementById("planSupport").textContent = `${formatPrice(asset.nearest_support)} (${asset.support_distance_pct}%)`;
  document.getElementById("planResistance").textContent = `${formatPrice(asset.nearest_resistance)} (${asset.resistance_distance_pct}%)`;
  document.getElementById("planStop").textContent = formatPrice(asset.stop_loss);
  document.getElementById("planTp").textContent = (asset.take_profit || []).map(formatPrice).join(" / ");
  document.getElementById("riskRsi").textContent = asset.rsi;
  document.getElementById("riskAtr").textContent = `${asset.atr_pct}%`;
  document.getElementById("riskVolume").textContent = `${asset.volume_ratio}x`;
  document.getElementById("riskRs").textContent = asset.asset === "BTC" ? "기준 자산" : asset.relative_strength_vs_btc;
  updateOrderFormForVenue();

  const checks = buildChecks(asset);
  document.getElementById("checkList").innerHTML = checks.map((check) => `
    <div class="check ${check.state}">
      <span class="check-icon">${check.state === "pass" ? "✓" : check.state === "fail" ? "×" : "!"}</span>
      <span>${check.label}</span>
      <span class="status-tag">${check.tag}</span>
    </div>
  `).join("");
  renderScalpChecks(asset);
}

function updateIndicatorToggle() {
  const button = document.getElementById("indicatorToggle");
  button.textContent = state.showIndicators ? "보조선 숨김" : "보조선 보기";
  button.classList.toggle("active", state.showIndicators);
}

function toggleScalpMode() {
  state.scalpMode = !state.scalpMode;
  if (!state.scalpMode && ["1m", "3m", "5m", "10m"].includes(state.timeframe)) {
    state.timeframe = "15m";
    document.querySelectorAll(".tool-btn[data-timeframe]").forEach((button) => {
      button.classList.toggle("active", button.dataset.timeframe === state.timeframe);
    });
    loadChart();
  }
  updateScalpToggle();
}

function updateScalpToggle() {
  const button = document.getElementById("scalpToggle");
  const toolbar = document.querySelector(".chart-toolbar");
  if (!button || !toolbar) return;
  button.textContent = state.scalpMode ? "Scalp Lab ON" : "Scalp Lab OFF";
  button.classList.toggle("active", state.scalpMode);
  toolbar.classList.toggle("scalp-on", state.scalpMode);
}

function normalizeSelection() {
  const asset = selectedAsset() || state.dashboard?.assets?.[0];
  if (!asset) return;
  const exchange = exchangeForVenue(state.venue);
  const instrument = instrumentForVenue(asset, state.venue);
  if (state.selected.exchange !== exchange || state.selected.instrument !== instrument) {
    state.selected = { asset: asset.asset, exchange, instrument };
  }
}

function exchangeForVenue(venue) {
  return venueConfig[venue]?.exchange || "upbit";
}

function instrumentForVenue(asset, venue) {
  if (venue === "upbit_spot") return asset.upbit;
  return asset.binance;
}

function priceForVenue(asset, venue) {
  const key = venueConfig[venue]?.priceKey || "current_price";
  return Number(asset[key] || asset.binance_price || asset.current_price || 0);
}

function updateOrderFormForVenue() {
  const disabled = state.selected.exchange === "binance_futures";
  document.querySelectorAll("#paperOrderForm button").forEach((button) => {
    button.disabled = disabled;
  });
  const note = document.getElementById("orderNote");
  if (!note) return;
  note.textContent = disabled
    ? "Binance Futures는 공개 데이터 분석만 연결되어 있고, 주문 라우터는 잠겨 있습니다."
    : "TEST MODE: 주문 라우터가 잠겨 있어 거래소로 전송되지 않습니다.";
}

function buildChecks(asset) {
  const regime = state.dashboard.market_regime.name;
  const trendPass = Number(asset.current_price) > Number(asset.ema100) && Number(asset.ema20) > Number(asset.ema50);
  const rsPass = asset.asset === "BTC" || Number(asset.relative_strength_vs_btc) > 0;
  return [
    {
      label: "BTC 시장 국면",
      state: regime === "bull" ? "pass" : regime === "neutral" ? "caution" : "fail",
      tag: regimeLabels[regime] || regime,
    },
    {
      label: "전략 모드",
      state: asset.signal === "buy" ? "pass" : asset.signal === "watch" ? "caution" : "fail",
      tag: asset.strategy_mode || asset.signal,
    },
    {
      label: asset.asset_role === "core" ? "코어 DCA 배율" : "공격 추세 필터",
      state: asset.asset_role === "core" ? (asset.order_budget_multiplier > 0 ? "pass" : "fail") : (trendPass ? "pass" : "fail"),
      tag: asset.asset_role === "core" ? `${Math.round(Number(asset.order_budget_multiplier || 0) * 100)}%` : "EMA100/20/50",
    },
    {
      label: "BTC 대비 상대강도",
      state: rsPass ? "pass" : "fail",
      tag: asset.asset === "BTC" ? "기준" : asset.relative_strength_vs_btc,
    },
    {
      label: "지지선 근처 여부",
      state: asset.support_distance_pct <= 1.2 ? "pass" : asset.support_distance_pct <= 2.2 ? "caution" : "fail",
      tag: `${asset.support_distance_pct}%`,
    },
    {
      label: "저항선까지 여유",
      state: asset.resistance_distance_pct >= 1.5 ? "pass" : "caution",
      tag: `${asset.resistance_distance_pct}%`,
    },
    {
      label: "RSI 조건",
      state: asset.rsi >= 38 && asset.rsi <= 60 ? "pass" : asset.rsi <= 70 ? "caution" : "fail",
      tag: asset.rsi,
    },
    {
      label: "거래량 조건",
      state: asset.volume_ratio >= 1 ? "pass" : "caution",
      tag: `${asset.volume_ratio}x`,
    },
    {
      label: "김프 과열 여부",
      state: Math.abs(asset.kimchi_premium_pct) <= 2 ? "pass" : Math.abs(asset.kimchi_premium_pct) <= 4 ? "caution" : "fail",
      tag: formatPct(asset.kimchi_premium_pct),
    },
  ];
}

function buildScalpChecks(asset) {
  const scalp = state.dashboard?.scalp_lab;
  if (!scalp) return [];
  const tightRange = Number(asset.atr_pct) <= 0.8;
  const volumeOk = Number(asset.volume_ratio) >= 1.2;
  const trendOk = Number(asset.current_price) > Number(asset.ema20);
  return [
    {
      label: "수수료 무료 게이트",
      state: scalp.zero_fee_verified ? "pass" : "fail",
      tag: scalp.zero_fee_verified ? "확인" : `${scalp.assumed_fee_bps} bps`,
    },
    {
      label: "스캘프 차트 모드",
      state: state.scalpMode ? "pass" : "caution",
      tag: state.scalpMode ? "ON" : "OFF",
    },
    {
      label: "초단기 변동성",
      state: tightRange ? "pass" : "caution",
      tag: `${asset.atr_pct}%`,
    },
    {
      label: "거래량 가속",
      state: volumeOk ? "pass" : "caution",
      tag: `${asset.volume_ratio}x`,
    },
    {
      label: "현재가 > EMA20",
      state: trendOk ? "pass" : "fail",
      tag: trendOk ? "통과" : "대기",
    },
  ];
}

function renderScalpChecks(asset) {
  const scalp = state.dashboard?.scalp_lab;
  const list = document.getElementById("scalpChecklist");
  const note = document.getElementById("scalpNote");
  if (!list || !note || !scalp) return;
  const checks = buildScalpChecks(asset);
  list.innerHTML = checks.map((check) => `
    <div class="check ${check.state}">
      <span class="check-icon">${check.state === "pass" ? "✓" : check.state === "fail" ? "×" : "!"}</span>
      <span>${check.label}</span>
      <span class="status-tag">${check.tag}</span>
    </div>
  `).join("");
  note.textContent = scalp.enabled
    ? `최대 ${scalp.max_hold_minutes}분 보유, 포지션 ${scalp.position_cap_pct}% 상한으로 테스트합니다.`
    : scalp.lock_reason;
}

function renderEquity(rows) {
  document.getElementById("equityRows").innerHTML = rows.map((row) => `
    <div class="equity-row">
      <span>${row.exchange.toUpperCase()} ${row.quote_currency}</span>
      <strong>${moneyFormat.format(Number(row.total_equity))}</strong>
      <span>현금 ${moneyFormat.format(Number(row.cash))} · 손익 ${moneyFormat.format(Number(row.unrealized_pnl))}</span>
    </div>
  `).join("");
}

function renderPortfolioOverview(portfolio, updatedAt = "", performance = null) {
  if (!portfolio) return;
  const positions = portfolio.positions || [];
  const equity = (portfolio.equity || [])[0] || {};
  const cash = Number(equity.cash || 0);
  const positionValue = positions.reduce((sum, position) => sum + Number(position.value || 0), 0);
  const totalEquity = cash + positionValue;
  const costBasis = positions.reduce((sum, position) => {
    const quantity = Number(position.quantity || 0);
    const average = Number(position.average_price || 0);
    return sum + Number(position.cost_basis || quantity * average || 0);
  }, 0);
  const positionPnl = positionValue - costBasis;
  const total = performance?.total || {};
  const totalPnl = Number.isFinite(Number(total.pnl_krw))
    ? Number(total.pnl_krw)
    : Number(equity.unrealized_pnl || positionPnl);
  const returnPct = Number.isFinite(Number(total.return_pct))
    ? Number(total.return_pct)
    : costBasis > 0 ? (positionPnl / costBasis) * 100 : 0;
  const pnlClass = totalPnl >= 0 ? "positive" : "negative";
  const pnlTone = totalPnl > 0 ? "수익 중" : totalPnl < 0 ? "손실 중" : "손익 없음";
  const lastTick = state.stream.lastTickAt ? formatClock(state.stream.lastTickAt) : shortTime(updatedAt).slice(11, 19);

  const pnlBox = document.getElementById("overviewPnlBox");
  if (pnlBox) {
    pnlBox.className = `summary-main pnl-focus ${pnlClass}`;
  }
  const pnlAmountEl = document.getElementById("overviewPnlAmount");
  if (pnlAmountEl) {
    pnlAmountEl.className = pnlClass;
    pnlAmountEl.textContent = formatSignedMoney(totalPnl, "KRW");
  }
  const pnlDetailEl = document.getElementById("overviewPnlDetail");
  if (pnlDetailEl) {
    pnlDetailEl.className = `summary-return ${pnlClass}`;
    pnlDetailEl.textContent = `${pnlTone} · ${formatPct(returnPct)}`;
  }
  setText("overviewEquity", `${moneyFormat.format(Math.round(totalEquity))} KRW`);
  const returnEl = document.getElementById("overviewReturn");
  if (returnEl) {
    returnEl.className = "summary-return";
    returnEl.textContent = `시드 대비 ${formatPct(returnPct)}`;
  }
  setText("overviewCash", `${moneyFormat.format(Math.round(cash))} KRW`);
  setText("overviewInvested", `${moneyFormat.format(Math.round(positionValue))} KRW`);
  setText("overviewCount", `${positions.length}개`);
  setText("overviewFreshness", state.stream.enabled ? `실시간 ${lastTick}` : `스냅샷 ${shortTime(updatedAt).slice(11, 19)}`);
  renderActualAllocation(positions, cash, totalEquity);

  const cards = document.getElementById("holdingCards");
  if (!cards) return;
  if (!positions.length) {
    cards.innerHTML = `
      <div class="holding-empty">
        <strong>아직 보유 포지션이 없습니다.</strong>
        <span>차트 조건이 맞으면 TEST MODE 가상 주문이 여기에 표시됩니다.</span>
      </div>
    `;
    return;
  }
  cards.innerHTML = positions.map((position) => holdingCard(position, totalEquity)).join("");
}

function renderActualAllocation(positions, cash, totalEquity) {
  const stack = document.getElementById("allocationStack");
  const list = document.getElementById("allocationList");
  if (!stack || !list) return;

  const positionBySymbol = new Map();
  positions.forEach((position) => {
    const symbol = position.instrument.replace("KRW-", "").replace("USDT", "");
    positionBySymbol.set(symbol, position);
  });

  const items = [
    { symbol: "KRW", label: "현금", value: cash, className: "cash" },
    ...streamAssets.map((asset) => {
      const position = positionBySymbol.get(asset.asset);
      return {
        symbol: asset.asset,
        label: asset.asset,
        value: Number(position?.value || 0),
        className: asset.asset.toLowerCase(),
      };
    }),
  ].map((item) => ({
    ...item,
    pct: totalEquity > 0 ? (Number(item.value || 0) / totalEquity) * 100 : 0,
  }));

  const activeItems = items.filter((item) => item.value > 0);
  stack.innerHTML = activeItems.length
    ? activeItems.map((item) => `
      <span
        class="allocation-segment ${item.className}"
        style="width: ${Math.max(item.pct, 1.5)}%"
        title="${item.label} ${formatWeightPct(item.pct)}"
      ></span>
    `).join("")
    : `<span class="allocation-segment empty" style="width: 100%"></span>`;

  list.innerHTML = items.map((item) => `
    <div class="allocation-row ${item.value > 0 ? "" : "is-empty"}">
      <span><i class="coin-dot ${item.className}"></i>${item.label}</span>
      <strong>${formatWeightPct(item.pct)}</strong>
      <b>${moneyFormat.format(Math.round(item.value))} KRW</b>
    </div>
  `).join("");
}

function holdingCard(position, totalEquity) {
  const quantity = Number(position.quantity || 0);
  const average = Number(position.average_price || 0);
  const costBasis = Number(position.cost_basis || quantity * average || 0);
  const value = Number(position.value || 0);
  const pnl = Number(position.unrealized_pnl || value - costBasis);
  const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
  const weight = totalEquity > 0 ? (value / totalEquity) * 100 : 0;
  const pnlClass = pnl >= 0 ? "positive" : "negative";
  const pnlTone = pnl > 0 ? "수익" : pnl < 0 ? "손실" : "보합";
  const displaySymbol = position.instrument.replace("KRW-", "");
  return `
    <article class="holding-card">
      <div class="holding-head">
        <div>
          <span>${position.exchange.toUpperCase()}</span>
          <strong>${displaySymbol}</strong>
        </div>
        <b class="${pnlClass}">${formatPct(pnlPct)}</b>
      </div>
      <div class="holding-value">
        <strong>${moneyFormat.format(Math.round(value))} KRW</strong>
        <span class="${pnlClass}">${pnlTone} ${formatSignedMoney(pnl, "KRW")}</span>
      </div>
      <div class="holding-bars">
        <span style="width: ${Math.min(Math.max(weight, 0), 100)}%"></span>
      </div>
      <div class="holding-meta">
        <span>비중 <b>${weight.toFixed(1)}%</b></span>
        <span>수량 <b>${formatQuantity(quantity)}</b></span>
        <span>평균 <b>${formatPrice(average)}</b></span>
        <span>현재 <b>${formatPrice(position.current_price)}</b></span>
      </div>
    </article>
  `;
}

function renderPositions(positions) {
  const body = document.getElementById("positionsBody");
  if (!positions.length) {
    body.innerHTML = `<tr><td colspan="8">아직 보유 포지션이 없습니다.</td></tr>`;
    return;
  }
  body.innerHTML = positions.map((position) => {
    const pnlClass = Number(position.unrealized_pnl) >= 0 ? "positive" : "negative";
    const quantity = Number(position.quantity || 0);
    const average = Number(position.average_price || 0);
    const costBasis = Number(position.cost_basis || quantity * average || 0);
    const pnlPct = costBasis > 0 ? (Number(position.unrealized_pnl || 0) / costBasis) * 100 : 0;
    return `
      <tr>
        <td>${position.exchange}:${position.instrument}</td>
        <td>${formatQuantity(quantity)}</td>
        <td>${formatPrice(position.average_price)}</td>
        <td>${formatPrice(position.current_price)}</td>
        <td>${moneyFormat.format(position.value)}</td>
        <td class="${pnlClass} pnl-cell">${formatSignedMoney(position.unrealized_pnl, "KRW")}</td>
        <td class="${pnlClass}">${formatPct(pnlPct)}</td>
        <td>${moneyFormat.format(costBasis)}</td>
      </tr>
    `;
  }).join("");
}

function renderPerformance(performance) {
  if (!performance) return;
  const total = performance.total || {};
  const totalClass = Number(total.pnl_krw || 0) >= 0 ? "positive" : "negative";
  const totalEl = document.getElementById("performanceTotal");
  totalEl.className = `performance-total ${totalClass}`;
  totalEl.innerHTML = `
    <span>총 수익</span>
    <strong>${formatSignedMoney(total.pnl_krw, "KRW")}</strong>
    <em>${formatPct(total.return_pct)}</em>
  `;
  document.getElementById("performanceNote").textContent = `${performance.conversion_note} · 스냅샷 ${performance.snapshot_count}개`;

  document.getElementById("bookReturns").innerHTML = (performance.books || []).map((book) => {
    const pnlClass = Number(book.pnl || 0) >= 0 ? "positive" : "negative";
    return `
      <div class="book-return">
        <span>${book.exchange.toUpperCase()} ${book.quote_currency}</span>
        <strong>${formatCurrencyAmount(book.current_equity, book.quote_currency)}</strong>
        <b class="${pnlClass}">${formatSignedMoney(book.pnl, book.quote_currency)} (${formatPct(book.return_pct)})</b>
        <small>KRW 환산 ${moneyFormat.format(Number(book.current_equity_krw || 0))}</small>
      </div>
    `;
  }).join("");

  document.getElementById("periodReturns").innerHTML = (performance.periods || []).map((period) => {
    const pnlClass = Number(period.pnl_krw || 0) >= 0 ? "positive" : "negative";
    return `
      <div class="period-return">
        <span>${period.label}</span>
        <strong class="${pnlClass}">${formatSignedMoney(period.pnl_krw, "KRW")}</strong>
        <b class="${pnlClass}">${formatPct(period.return_pct)}</b>
        <small>${shortTime(period.base_time).slice(5)}</small>
      </div>
    `;
  }).join("");

  const hourly = performance.hourly || [];
  document.getElementById("hourlyReturnsBody").innerHTML = hourly.length
    ? hourly.map((row) => {
        const pnlClass = Number(row.pnl_krw || 0) >= 0 ? "positive" : "negative";
        return `
          <tr>
            <td>${row.hour}</td>
            <td class="${pnlClass}">${formatSignedMoney(row.pnl_krw, "KRW")}</td>
            <td class="${pnlClass}">${formatPct(row.return_pct)}</td>
            <td>${row.snapshot_count}</td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="4">아직 시간별 수익을 계산할 스냅샷이 부족합니다.</td></tr>`;
}

function renderTrades(trades) {
  const body = document.getElementById("tradesBody");
  if (!trades.length) {
    body.innerHTML = `<tr><td colspan="8">아직 거래 로그가 없습니다.</td></tr>`;
    return;
  }
  body.innerHTML = trades.slice(0, 12).map((trade) => `
    <tr>
      <td>${shortTime(trade.timestamp).slice(5)}</td>
      <td>${trade.exchange}</td>
      <td>${trade.instrument}</td>
      <td class="${trade.side === "buy" ? "positive" : "negative"}">${translateSide(trade.side)}</td>
      <td>${formatPrice(trade.effective_price || trade.price)}</td>
      <td>${trade.base_quantity || "--"}</td>
      <td>${translateStatus(trade.status)}</td>
      <td>${translateNote(trade.note)}</td>
    </tr>
  `).join("");
}

async function loadChart() {
  updateChartCaption(selectedAsset());
  const params = new URLSearchParams({
    exchange: state.selected.exchange,
    instrument: state.selected.instrument,
    timeframe: state.timeframe,
  });
  const response = await fetch(`/api/candles?${params}`);
  const payload = await response.json();
  renderChart(payload);
  await loadMultiTimeframe();
}

function updateChartCaption(asset) {
  if (!asset) return;
  document.getElementById("chartTitle").textContent = state.selected.instrument;
  document.getElementById("chartSubtitle").textContent = `${timeframeLabels[state.timeframe] || state.timeframe} · ${exchangeLabel(state.selected.exchange)}`;
}

function exchangeLabel(exchange) {
  if (exchange === "upbit") return "Upbit Spot";
  if (exchange === "binance") return "Binance Spot";
  if (exchange === "binance_futures") return "Binance Futures";
  return exchange;
}

function renderChart(payload) {
  state.chartPayload = payload;
  clearMeasurement();
  const container = document.getElementById("chart");
  if (!state.chart) {
    state.chart = LightweightCharts.createChart(container, {
      layout: { background: { color: "transparent" }, textColor: "#94a3b8" },
      grid: { vertLines: { color: "rgba(148,163,184,.08)" }, horzLines: { color: "rgba(148,163,184,.08)" } },
      rightPriceScale: { borderColor: "rgba(148,163,184,.2)" },
      timeScale: { borderColor: "rgba(148,163,184,.2)", timeVisible: true },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });
    state.candleSeries = state.chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    window.addEventListener("resize", () => {
      state.chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
      renderMeasurement();
    });
    setupChartMeasurement(container);
  }
  state.lineSeries.forEach((series) => state.chart.removeSeries(series));
  state.lineSeries = [];
  state.priceLines.forEach((line) => state.candleSeries.removePriceLine(line));
  state.priceLines = [];
  state.chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  state.candleSeries.setData(payload.candles);

  const colors = { ema20: "#3b82f6", ema50: "#f59e0b", ma200: "#8b5cf6" };
  if (state.showIndicators) {
    ["ema20", "ema50", "ma200"].forEach((key) => {
      const series = state.chart.addLineSeries({ color: colors[key], lineWidth: key === "ma200" ? 1 : 2 });
      series.setData(payload.lines[key].map((point, index) => ({ time: payload.candles[index]?.time, value: point.value })).filter((point) => point.time));
      state.lineSeries.push(series);
    });
  }
  addPriceLine(payload.lines.support, "#22c55e", "지지선");
  addPriceLine(payload.lines.resistance, "#ef4444", "저항선");
  addPriceLine(payload.lines.stop_loss, "#ef4444", "손절");
  payload.lines.take_profit
    .slice(0, state.showIndicators ? 2 : 1)
    .forEach((price, index) => addPriceLine(price, "#86efac", `익절${index + 1}`));
  state.chart.timeScale().fitContent();
  document.getElementById("priceTag").textContent = formatPrice(payload.indicators.close);
  renderLineLegend(payload);
}

async function loadMultiTimeframe() {
  const asset = selectedAsset();
  if (!asset) return;
  const exchange = state.venue === "binance_futures" ? "binance_futures" : "binance";
  const instrument = asset.binance;
  const params = new URLSearchParams({
    exchange,
    instrument,
    timeframes: "1m,3m,5m,15m",
  });
  try {
    const response = await fetch(`/api/multi-timeframe?${params}`);
    const payload = await response.json();
    renderMultiTimeframe(payload);
  } catch {
    renderMultiTimeframe(null);
  }
}

function renderMultiTimeframe(payload) {
  const grid = document.getElementById("mtfGrid");
  const subtitle = document.getElementById("mtfSubtitle");
  const score = document.getElementById("mtfScore");
  if (!grid || !subtitle || !score) return;
  if (!payload || !payload.timeframes?.length) {
    subtitle.textContent = "Binance 데이터 대기";
    score.textContent = "--";
    grid.innerHTML = `<div class="mtf-empty">분봉 데이터를 불러오지 못했습니다.</div>`;
    return;
  }

  subtitle.textContent = `${payload.instrument} · ${exchangeLabel(payload.exchange)} · 1/3/5/15분`;
  score.textContent = `정렬 ${Number(payload.alignment_score || 0).toFixed(1)}`;
  score.className = `mtf-score ${payload.alignment_score >= 75 ? "positive" : payload.alignment_score >= 55 ? "caution" : "negative"}`;
  grid.innerHTML = payload.timeframes.map((row) => {
    const changeClass = Number(row.change_pct) >= 0 ? "positive" : "negative";
    const signalClass = row.signal === "long-watch" ? "positive" : row.signal === "wait" ? "caution" : "negative";
    return `
      <div class="mtf-card ${row.signal}">
        <div class="mtf-card-head">
          <strong>${row.label}</strong>
          <span class="${signalClass}">${row.signal_label}</span>
        </div>
        <div class="mtf-price">${formatPrice(row.close)} <span class="${changeClass}">${formatPct(row.change_pct)}</span></div>
        <div class="mtf-stats">
          <span>RSI <b>${Number(row.rsi).toFixed(1)}</b></span>
          <span>거래량 <b>${Number(row.volume_ratio).toFixed(2)}x</b></span>
          <span>ATR <b>${Number(row.atr_pct).toFixed(2)}%</b></span>
          <span>지지 <b>${Number(row.support_distance_pct).toFixed(2)}%</b></span>
          <span>저항 <b>${Number(row.resistance_distance_pct).toFixed(2)}%</b></span>
          <span>점수 <b>${row.score}</b></span>
        </div>
        <p>${row.reason || "조건 계산 중"}</p>
      </div>
    `;
  }).join("");
}

function addPriceLine(price, color, title) {
  if (!price || price <= 0) return;
  const line = state.candleSeries.createPriceLine({
    price,
    color,
    lineWidth: 1,
    lineStyle: title === "지지선" || title === "저항선" ? 0 : 2,
    axisLabelVisible: true,
    title,
  });
  state.priceLines.push(line);
}

function startStreaming() {
  if (!("WebSocket" in window)) {
    state.stream.enabled = false;
    updateStreamStatus("미지원");
    return;
  }
  connectUpbitStream();
  connectBinanceStream();
  updateStreamStatus();
}

function toggleStreaming() {
  state.stream.enabled = !state.stream.enabled;
  if (state.stream.enabled) {
    startStreaming();
    return;
  }
  stopStreaming();
}

function stopStreaming() {
  clearReconnectTimers();
  [state.stream.upbit, state.stream.binance].forEach((socket) => {
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, "user disabled");
  });
  state.stream.upbit = null;
  state.stream.binance = null;
  state.stream.upbitConnected = false;
  state.stream.binanceConnected = false;
  updateStreamStatus();
}

function connectUpbitStream() {
  if (!state.stream.enabled || socketIsActive(state.stream.upbit)) return;
  const socket = new WebSocket("wss://api.upbit.com/websocket/v1");
  socket.binaryType = "blob";
  state.stream.upbit = socket;
  updateStreamStatus();

  socket.addEventListener("open", () => {
    state.stream.upbitConnected = true;
    socket.send(JSON.stringify([
      { ticket: "rgca-l-dashboard" },
      {
        type: "ticker",
        codes: [...streamAssets.map((item) => item.upbit), "KRW-USDT"],
        is_only_realtime: true,
      },
      { format: "DEFAULT" },
    ]));
    updateStreamStatus();
  });

  socket.addEventListener("message", async (event) => {
    const payload = await readWebSocketJson(event.data);
    if (payload) handleUpbitTicker(payload);
  });

  socket.addEventListener("close", () => {
    state.stream.upbitConnected = false;
    updateStreamStatus();
    scheduleReconnect(connectUpbitStream);
  });

  socket.addEventListener("error", () => {
    state.stream.upbitConnected = false;
    updateStreamStatus("오류");
  });
}

function connectBinanceStream() {
  if (!state.stream.enabled || socketIsActive(state.stream.binance)) return;
  const streams = streamAssets.map((item) => `${item.binance.toLowerCase()}@ticker`).join("/");
  const socket = new WebSocket(`wss://stream.binance.com:443/stream?streams=${streams}`);
  state.stream.binance = socket;
  updateStreamStatus();

  socket.addEventListener("open", () => {
    state.stream.binanceConnected = true;
    updateStreamStatus();
  });

  socket.addEventListener("message", async (event) => {
    const payload = await readWebSocketJson(event.data);
    if (payload) handleBinanceTicker(payload.data || payload);
  });

  socket.addEventListener("close", () => {
    state.stream.binanceConnected = false;
    updateStreamStatus();
    scheduleReconnect(connectBinanceStream);
  });

  socket.addEventListener("error", () => {
    state.stream.binanceConnected = false;
    updateStreamStatus("오류");
  });
}

function socketIsActive(socket) {
  return socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN);
}

function scheduleReconnect(callback) {
  if (!state.stream.enabled) return;
  const timer = window.setTimeout(callback, 3000);
  state.stream.reconnectTimers.push(timer);
}

function clearReconnectTimers() {
  state.stream.reconnectTimers.forEach((timer) => window.clearTimeout(timer));
  state.stream.reconnectTimers = [];
}

async function readWebSocketJson(data) {
  try {
    if (typeof data === "string") return JSON.parse(data);
    if (data instanceof Blob) return JSON.parse(await data.text());
    if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }
  return null;
}

function handleUpbitTicker(ticker) {
  if (!state.dashboard) return;
  const code = ticker.code || ticker.cd;
  const price = Number(ticker.trade_price ?? ticker.tp);
  if (!code || !Number.isFinite(price) || price <= 0) return;

  const eventTime = Number(ticker.timestamp || ticker.trade_timestamp || Date.now());
  state.stream.lastTickAt = eventTime;
  document.getElementById("updatedAt").textContent = formatClock(eventTime);

  if (code === "KRW-USDT") {
    state.dashboard.usdt_krw = price;
    const usdKrw = Number(state.dashboard.usd_krw_reference || 0);
    state.dashboard.fx_basis_pct = usdKrw > 0 ? Number(((price / usdKrw - 1) * 100).toFixed(2)) : 0;
    renderFxRates(state.dashboard);
    recalcAllKimchi();
    scheduleRealtimeRender();
    return;
  }

  const asset = state.dashboard.assets.find((item) => item.instrument === code);
  if (!asset) return;
  const previous = Number(asset.current_price || 0);
  asset.current_price = price;
  asset.change_24h_pct = Number(((ticker.signed_change_rate ?? ticker.change_rate ?? asset.change_24h_pct / 100) * 100).toFixed(2));
  asset._flash = previous && price < previous ? "down" : "up";
  asset._flashUntil = Date.now() + 650;
  recalcKimchi(asset);
  updatePositionPrice(asset.exchange, asset.instrument, price);
  updateRealtimeCandle(asset.instrument, price, eventTime);
  scheduleRealtimeRender();
}

function handleBinanceTicker(ticker) {
  if (!state.dashboard) return;
  const symbol = ticker.s;
  const price = Number(ticker.c);
  if (!symbol || !Number.isFinite(price) || price <= 0) return;
  const mapping = streamAssets.find((item) => item.binance === symbol);
  if (!mapping) return;
  const asset = state.dashboard.assets.find((item) => item.asset === mapping.asset);
  if (!asset) return;
  asset.binance_price = price;
  recalcKimchi(asset);
  state.stream.lastTickAt = Number(ticker.E || Date.now());
  if (state.selected.exchange === "binance" && state.selected.instrument === symbol) {
    updateRealtimeCandle(symbol, price, state.stream.lastTickAt);
  }
  scheduleRealtimeRender();
}

function recalcAllKimchi() {
  state.dashboard.assets.forEach(recalcKimchi);
}

function recalcKimchi(asset) {
  const usdtKrw = Number(state.dashboard?.usdt_krw || 0);
  const overseas = Number(asset.binance_price || 0) * usdtKrw;
  if (overseas > 0) {
    asset.kimchi_premium_pct = Number(((Number(asset.current_price) / overseas - 1) * 100).toFixed(2));
  }
}

function updateRealtimeCandle(instrument, price, eventTime) {
  if (!state.chartPayload || !state.candleSeries || state.selected.instrument !== instrument) return;
  const seconds = timeframeSeconds[state.timeframe] || 14400;
  const timestamp = Math.floor(Number(eventTime || Date.now()) / 1000);
  const bucket = Math.floor(timestamp / seconds) * seconds;
  const candles = state.chartPayload.candles;
  const last = candles[candles.length - 1];
  if (!last) return;

  let next;
  if (bucket > last.time) {
    next = { time: bucket, open: price, high: price, low: price, close: price };
    candles.push(next);
    if (candles.length > 220) candles.shift();
  } else if (bucket === last.time || timestamp >= last.time) {
    next = {
      ...last,
      high: Math.max(Number(last.high), price),
      low: Math.min(Number(last.low), price),
      close: price,
    };
    candles[candles.length - 1] = next;
  } else {
    return;
  }

  state.chartPayload.indicators.close = price;
  state.candleSeries.update(next);
  document.getElementById("priceTag").textContent = formatPrice(price);
}

function updatePositionPrice(exchange, instrument, price) {
  const positions = state.dashboard?.portfolio?.positions || [];
  positions.forEach((position) => {
    if (position.exchange !== exchange || position.instrument !== instrument) return;
    const quantity = Number(position.quantity || 0);
    const costBasis = Number(position.cost_basis || quantity * Number(position.average_price || 0));
    position.current_price = price;
    position.value = quantity * price;
    position.unrealized_pnl = position.value - costBasis;
  });
  recalcRealtimeEquity();
}

function recalcRealtimeEquity() {
  const portfolio = state.dashboard?.portfolio;
  if (!portfolio || !portfolio.equity?.length) return;
  const row = portfolio.equity[0];
  const cash = Number(row.cash || 0);
  const positionValue = (portfolio.positions || []).reduce((sum, position) => sum + Number(position.value || 0), 0);
  const costBasis = (portfolio.positions || []).reduce((sum, position) => {
    const quantity = Number(position.quantity || 0);
    const average = Number(position.average_price || 0);
    return sum + Number(position.cost_basis || quantity * average || 0);
  }, 0);
  row.position_value = positionValue;
  row.total_equity = cash + positionValue;
  row.unrealized_pnl = positionValue - costBasis;
  const total = state.dashboard?.performance?.total;
  if (total && Number.isFinite(Number(total.starting_equity_krw))) {
    total.current_equity_krw = row.total_equity;
    total.pnl_krw = row.total_equity - Number(total.starting_equity_krw);
    total.return_pct = Number(total.starting_equity_krw) > 0
      ? (total.pnl_krw / Number(total.starting_equity_krw)) * 100
      : 0;
  }
}

function scheduleRealtimeRender() {
  if (state.stream.renderRequested) return;
  state.stream.renderRequested = true;
  window.requestAnimationFrame(() => {
    state.stream.renderRequested = false;
    if (!state.dashboard) return;
    const now = Date.now();
    state.dashboard.assets.forEach((asset) => {
      if (asset._flashUntil && asset._flashUntil < now) asset._flash = "";
    });
    renderAssetCards(state.dashboard.assets);
    renderDecision(selectedAsset());
    renderPortfolioOverview(state.dashboard.portfolio, state.dashboard.updated_at, state.dashboard.performance);
    renderEquity(state.dashboard.portfolio.equity || []);
    renderPositions(state.dashboard.portfolio.positions || []);
    updateStreamStatus();
  });
}

function updateStreamStatus(forcedLabel = "") {
  const button = document.getElementById("streamToggle");
  const label = document.getElementById("streamStatus");
  if (!button || !label) return;
  button.classList.remove("on", "connecting", "off", "error");
  if (!state.stream.enabled) {
    button.classList.add("off");
    label.textContent = "OFF";
    return;
  }
  if (forcedLabel === "오류" || forcedLabel === "미지원") {
    button.classList.add("error");
    label.textContent = forcedLabel;
    return;
  }
  if (state.stream.upbitConnected && state.stream.binanceConnected) {
    button.classList.add("on");
    label.textContent = "ON";
    return;
  }
  if (state.stream.upbitConnected || state.stream.binanceConnected) {
    button.classList.add("connecting");
    label.textContent = "부분";
    return;
  }
  button.classList.add("connecting");
  label.textContent = "연결중";
}

function renderLineLegend(payload) {
  const takeProfit = payload.lines.take_profit || [];
  const indicatorLegend = state.showIndicators
    ? `
      <span class="legend-chip ema20" title="20봉 지수이동평균선">EMA20</span>
      <span class="legend-chip ema50" title="50봉 지수이동평균선">EMA50</span>
      <span class="legend-chip ma200" title="200봉 단순이동평균선">MA200</span>
    `
    : "";
  document.getElementById("lineLegend").innerHTML = `
    <span class="legend-chip support" title="가격 아래의 주요 지지 구간">지지선 ${formatPrice(payload.levels.support)} (${Number(payload.levels.support_distance_pct).toFixed(2)}%)</span>
    <span class="legend-chip resistance" title="가격 위의 주요 저항 구간">저항선 ${formatPrice(payload.levels.resistance)} (${Number(payload.levels.resistance_distance_pct).toFixed(2)}%)</span>
    <span class="legend-chip stop" title="전략상 손절 기준가">손절 ${formatPrice(payload.lines.stop_loss)}</span>
    <span class="legend-chip target" title="TP, Take Profit: 계획상 일부 익절 목표가">익절1 ${formatPrice(takeProfit[0])}</span>
    ${state.showIndicators && takeProfit[1] ? `<span class="legend-chip target" title="두 번째 익절 목표가">익절2 ${formatPrice(takeProfit[1])}</span>` : ""}
    ${indicatorLegend}
    <span class="legend-chip muted-chip">RSI ${Number(payload.indicators.rsi).toFixed(1)}</span>
    <span class="legend-chip muted-chip">ATR ${Number(payload.indicators.atr_pct).toFixed(2)}%</span>
    <span class="legend-chip muted-chip">거래량 ${Number(payload.indicators.volume_ratio).toFixed(2)}x</span>
  `;
}

function setupChartMeasurement(container) {
  if (state.measureReady) return;
  state.measureReady = true;
  container.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const point = chartPointFromEvent(event, container);
    if (!point) return;
    if (!state.measure.start || state.measure.end) {
      state.measure = { start: point, end: null };
    } else {
      state.measure.end = point;
    }
    renderMeasurement();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") clearMeasurement();
  });
}

function chartPointFromEvent(event, container) {
  if (!state.chart || !state.candleSeries) return null;
  const rect = container.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
  const price = state.candleSeries.coordinateToPrice(y);
  const time = state.chart.timeScale().coordinateToTime(x);
  if (!Number.isFinite(price) || time == null) return null;
  return snapPointToCandle(x, y, Number(price), normalizeChartTime(time));
}

function normalizeChartTime(time) {
  if (typeof time === "number") return time;
  return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
}

function snapPointToCandle(rawX, rawY, rawPrice, rawTime) {
  const candles = state.chartPayload?.candles || [];
  if (!candles.length) return { x: rawX, y: rawY, price: rawPrice, time: rawTime, snapLabel: "가격" };

  let nearest = null;
  let nearestDistance = Infinity;
  candles.forEach((candle, index) => {
    const candleX = state.chart.timeScale().timeToCoordinate(candle.time);
    if (candleX == null || !Number.isFinite(candleX)) return;
    const distance = Math.abs(candleX - rawX);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = { candle, index, x: candleX };
    }
  });

  if (!nearest) return { x: rawX, y: rawY, price: rawPrice, time: rawTime, snapLabel: "가격" };

  const candidates = [
    { label: "시가", price: Number(nearest.candle.open) },
    { label: "고가", price: Number(nearest.candle.high) },
    { label: "저가", price: Number(nearest.candle.low) },
    { label: "종가", price: Number(nearest.candle.close) },
  ].filter((item) => Number.isFinite(item.price) && item.price > 0);

  let selected = candidates[0];
  let selectedDistance = Infinity;
  candidates.forEach((candidate) => {
    const candidateY = state.candleSeries.priceToCoordinate(candidate.price);
    const distance = candidateY == null || !Number.isFinite(candidateY)
      ? Math.abs(candidate.price - rawPrice)
      : Math.abs(candidateY - rawY);
    if (distance < selectedDistance) {
      selectedDistance = distance;
      selected = candidate;
    }
  });

  const snappedY = state.candleSeries.priceToCoordinate(selected.price);
  return {
    x: nearest.x,
    y: snappedY == null || !Number.isFinite(snappedY) ? rawY : snappedY,
    price: selected.price,
    time: nearest.candle.time,
    candleIndex: nearest.index,
    snapLabel: selected.label,
  };
}

function renderMeasurement() {
  const layer = document.getElementById("measureLayer");
  if (!layer) return;
  const { start, end } = state.measure;
  layer.innerHTML = "";
  layer.classList.toggle("hidden", !start);
  if (!start) return;

  layer.appendChild(measurePoint(start, "start"));
  if (!end) {
    layer.appendChild(measureCard(start.x + 12, start.y - 42, "시작점 고정", `${formatPointLabel(start)} · 다시 우클릭`, "neutral"));
    return;
  }

  layer.appendChild(measurePoint(end, "end"));
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const line = document.createElement("div");
  line.className = "measure-line";
  line.style.left = `${start.x}px`;
  line.style.top = `${start.y}px`;
  line.style.width = `${length}px`;
  line.style.transform = `rotate(${angle}deg)`;
  layer.appendChild(line);

  const delta = end.price - start.price;
  const pct = start.price ? delta / start.price * 100 : 0;
  const bars = countCandlesBetween(start.time, end.time);
  const tone = pct >= 0 ? "positive" : "negative";
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const labelX = clamp(midX + 12, 8, Math.max(8, layer.clientWidth - 220));
  const labelY = clamp(midY - 48, 8, Math.max(8, layer.clientHeight - 76));
  layer.appendChild(measureCard(
    labelX,
    labelY,
    `등락폭 ${formatPct(pct)}`,
    `${formatSignedPrice(delta)} · ${bars}봉 · ${start.snapLabel}→${end.snapLabel}`,
    tone,
  ));
}

function measurePoint(point, type) {
  const dot = document.createElement("span");
  dot.className = `measure-point ${type}`;
  dot.style.left = `${point.x}px`;
  dot.style.top = `${point.y}px`;
  return dot;
}

function measureCard(x, y, title, detail, tone) {
  const card = document.createElement("div");
  card.className = `measure-card ${tone}`;
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.innerHTML = `<strong>${title}</strong><span>${detail}</span>`;
  return card;
}

function clearMeasurement() {
  state.measure = { start: null, end: null };
  const layer = document.getElementById("measureLayer");
  if (layer) {
    layer.innerHTML = "";
    layer.classList.add("hidden");
  }
}

function countCandlesBetween(startTime, endTime) {
  const candles = state.chartPayload?.candles || [];
  const minTime = Math.min(startTime, endTime);
  const maxTime = Math.max(startTime, endTime);
  return candles.filter((candle) => candle.time >= minTime && candle.time <= maxTime).length;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatSignedPrice(value) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatPrice(Math.abs(value))}`;
}

function formatPointLabel(point) {
  return `${formatCandleTime(point.time)} ${point.snapLabel}`;
}

function formatCandleTime(timestamp) {
  const date = new Date(timestamp * 1000);
  const options = {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
  };
  if (state.timeframe !== "1d" && state.timeframe !== "1w") {
    options.hour = "2-digit";
    options.minute = "2-digit";
    options.hourCycle = "h23";
  }
  return new Intl.DateTimeFormat("ko-KR", options).format(date);
}

async function submitPaperOrder(event) {
  event.preventDefault();
  if (state.selected.exchange === "binance_futures") {
    updateOrderFormForVenue();
    return;
  }
  const submitter = event.submitter;
  const side = submitter.dataset.side;
  await fetch("/api/order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      exchange: state.selected.exchange,
      instrument: state.selected.instrument,
      side,
      amount: document.getElementById("orderAmount").value,
      fraction: "0.25",
    }),
  });
  await loadDashboard();
}

async function runDailyPlan() {
  await fetch("/api/run-plan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await loadDashboard();
}

function selectedAsset() {
  return state.dashboard?.assets?.find((asset) => asset.asset === state.selected.asset)
    || state.dashboard?.assets?.find((asset) => instrumentForVenue(asset, state.venue) === state.selected.instrument)
    || state.dashboard?.assets?.[0];
}

function formatPrice(value) {
  const number = Number(value || 0);
  if (number >= 1000) return numberFormat.format(Math.round(number));
  if (number >= 1) return numberFormat.format(Number(number.toFixed(4)));
  return numberFormat.format(Number(number.toFixed(8)));
}

function formatPct(value) {
  const number = Number(value || 0);
  const sign = number > 0 ? "+" : "";
  return `${sign}${number.toFixed(2)}%`;
}

function formatWeightPct(value) {
  const number = Number(value || 0);
  if (number >= 10) return `${number.toFixed(1)}%`;
  return `${number.toFixed(2)}%`;
}

function formatSignedMoney(value, currency = "KRW") {
  const number = Number(value || 0);
  const sign = number > 0 ? "+" : number < 0 ? "-" : "";
  return `${sign}${formatCurrencyAmount(Math.abs(number), currency)}`;
}

function formatCurrencyAmount(value, currency = "KRW") {
  const number = Number(value || 0);
  if (currency === "KRW") return `${moneyFormat.format(Math.round(number))} KRW`;
  if (currency === "USDT") return `${moneyFormat.format(number)} USDT`;
  return `${moneyFormat.format(number)} ${currency}`;
}

function formatQuantity(value) {
  const number = Number(value || 0);
  if (number === 0) return "0";
  if (number >= 1) return numberFormat.format(Number(number.toFixed(6)));
  if (number >= 0.0001) return numberFormat.format(Number(number.toFixed(8)));
  return number.toExponential(4);
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function shortTime(value) {
  if (!value) return "--";
  return String(value).replace("T", " ").slice(0, 19);
}

function formatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function translateSide(side) {
  return side === "buy" ? "매수" : side === "sell" ? "매도" : side;
}

function translateStatus(status) {
  return status === "simulated" ? "체결" : status === "skipped" ? "스킵" : status;
}

function translatePhase(phase) {
  return {
    shadow: "섀도",
    "order-intent": "주문 후보",
    "dry-run": "테스트",
    "test/demo": "데모",
    "micro-live": "초소액 실전",
    live: "실전",
  }[phase] || phase || "테스트";
}

function translateSchedule(schedule) {
  return {
    biweekly: "격주",
    weekly: "주간",
    monthly: "월간",
    daily: "일간",
  }[schedule] || schedule || "격주";
}

function translateOrderType(type) {
  return {
    limit_split: "분할 지정가",
    marketable_limit: "공격적 지정가",
    market: "시장가",
  }[type] || type || "--";
}

function translateNote(note = "") {
  if (note.includes("no real order")) return "주문 전송 없음";
  if (note.includes("already simulated")) return "오늘 이미 실행됨";
  if (note.includes("below minimum")) return "최소금액 미만";
  if (note.includes("insufficient")) return "잔고 부족";
  return note;
}
