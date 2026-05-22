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
  tradeFilter: "all",
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
  buy: "매수 가능",
  watch: "조금 더 보기",
  skip: "지금은 대기",
  data_error: "데이터 확인 필요",
};

const roleLabels = {
  core: "기본",
  aggressive: "기회",
  leveraged: "선물",
};

const regimeLabels = {
  bull: "매수하기 편한 흐름",
  neutral: "애매한 흐름",
  bear: "조심할 흐름",
  crash: "급락 주의",
  overheated: "과열 주의",
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
  upbit_spot: { exchange: "upbit", label: "업비트 현물", quote: "KRW", priceKey: "current_price" },
  binance_spot: { exchange: "binance", label: "바이낸스 현물", quote: "USDT", priceKey: "binance_price" },
  binance_futures: { exchange: "binance_futures", label: "바이낸스 선물", quote: "USDT", priceKey: "futures_price" },
};

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("refreshBtn").addEventListener("click", loadDashboard);
  document.getElementById("decisionRefresh").addEventListener("click", loadDashboard);
  document.getElementById("runPlanBtn").addEventListener("click", runDailyPlan);
  document.querySelectorAll("[data-trade-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tradeFilter = button.dataset.tradeFilter || "all";
      document.querySelectorAll("[data-trade-filter]").forEach((item) => {
        item.classList.toggle("active", item.dataset.tradeFilter === state.tradeFilter);
      });
      renderTrades(state.dashboard?.trades || []);
    });
  });
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
  document.getElementById("sideRegimeReason").textContent = compactRegimeText(regime);
  document.getElementById("sideRegimeIcon").textContent = regime.name === "bull" ? "상" : regime.name === "bear" ? "약" : "중";
  renderAutomationPolicy(data.automation);
  renderSupervisorStatus(data.supervisor);
  renderSessionStrip(data);
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
    const date = data?.usd_krw_reference_date ? ` ${data.usd_krw_reference_date}` : "";
    usdEl.textContent = `USD/KRW(참고) ${usdKrw > 0 ? formatPrice(usdKrw) : "--"}`;
    usdEl.title = `참고 환율${date}`;
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

function renderSupervisorStatus(supervisor) {
  const stateEl = document.getElementById("supervisorState");
  if (!stateEl || !supervisor) return;
  const running = Boolean(supervisor.running);
  const locked = Boolean(supervisor.lock_active);
  const severity = String(supervisor.severity || "UNKNOWN");
  stateEl.textContent = running ? (locked ? "감시 중 · 매수 잠금" : "감시 중") : "확인 필요";
  stateEl.className = running ? (severity === "CRIT" ? "negative" : locked ? "caution" : "positive") : "negative";
  setText("supervisorLast", supervisor.updated_at ? `${timeOnly(supervisor.updated_at)} · ${ageLabel(supervisor.age_seconds)} 전` : "--");
  setText("supervisorNext", supervisor.next_check_at ? timeOnly(supervisor.next_check_at) : "--");
  setText("supervisorEvents", `${supervisor.event_count ?? 0}건 · ${friendlySeverity(severity)}`);
}

function compactRegimeText(regime = {}) {
  const name = String(regime.name || "");
  const volume = Number(regime.volume_ratio || 0);
  const trend = name === "bull" ? "상승" : name === "bear" ? "약세" : name === "crash" ? "급락" : name === "overheated" ? "과열" : "중립";
  const volumeText = volume >= 1 ? "거래 강함" : volume >= 0.5 ? "거래 보통" : "거래 약함";
  return `${trend} · ${volumeText}`;
}

function renderSessionStrip(data) {
  const portfolio = data?.portfolio || {};
  const positions = portfolio.positions || [];
  const equity = (portfolio.equity || [])[0] || {};
  const performanceTotal = data?.performance?.total || {};
  const cash = Number(equity.cash || 0);
  const realizedPnl = portfolioRealizedPnl(portfolio);
  const positionValue = positions.reduce((sum, position) => sum + Number(position.value || 0), 0);
  const totalEquity = Number.isFinite(Number(performanceTotal.current_equity_krw))
    ? Number(performanceTotal.current_equity_krw)
    : Number(equity.total_equity || cash + positionValue);
  const pnl = Number.isFinite(Number(performanceTotal.pnl_krw))
    ? Number(performanceTotal.pnl_krw)
    : Number(equity.unrealized_pnl || 0);
  const returnPct = Number.isFinite(Number(performanceTotal.return_pct))
    ? Number(performanceTotal.return_pct)
    : totalEquity > 0 ? (pnl / totalEquity) * 100 : 0;
  const pnlTone = pnl >= 0 ? "positive" : "negative";
  const realizedTone = realizedPnl >= 0 ? "positive" : "negative";

  setText("sessionEquity", totalEquity > 0 ? `${moneyFormat.format(Math.round(totalEquity))} KRW` : "--");
  setText("sessionEquityDetail", positions.length ? `${positions.length}종목 · 현금 ${moneyFormat.format(Math.round(cash))}` : "무보유");
  setText("sessionPnl", formatSignedMoney(pnl, "KRW"));
  setText("sessionPnlDetail", `시드 대비 ${formatPct(returnPct)}`);
  setTone("sessionPnl", pnlTone);
  setTone("sessionPnlDetail", pnlTone);
  setText("sessionRealized", formatSignedMoney(realizedPnl, "KRW"));
  setText("sessionRealizedDetail", realizedPnl ? "매도 확정" : "매도 없음");
  setTone("sessionRealized", realizedTone);
  setTone("sessionRealizedDetail", realizedTone);

  const supervisor = data?.supervisor || {};
  const running = Boolean(supervisor.running);
  const locked = Boolean(supervisor.lock_active);
  const severity = String(supervisor.severity || "UNKNOWN");
  const supervisorTone = running ? (severity === "CRIT" ? "negative" : locked ? "caution" : "positive") : "negative";
  setText("sessionSupervisor", running ? (locked ? "감시 중 · 잠금" : "감시 중") : "확인 필요");
  setText("sessionSupervisorDetail", supervisor.next_check_at ? `다음 ${timeOnly(supervisor.next_check_at)} · Codex 15분` : "Codex 15분");
  setTone("sessionSupervisor", supervisorTone);

  const risk = data?.risk || {};
  const liveLocked = risk.live_trading_locked !== false;
  const withdrawalsOff = !risk.auto_withdrawals;
  setText("sessionSafety", liveLocked && withdrawalsOff ? "실거래 차단" : "확인 필요");
  setText("sessionSafetyDetail", liveLocked ? "주문 OFF · 출금 OFF" : "잠금 확인");
  setTone("sessionSafety", liveLocked && withdrawalsOff ? "positive" : "negative");
}

function renderStrategyProfile(profile, deployment, risk) {
  if (!profile) return;
  document.getElementById("sideStrategyName").textContent = friendlyStrategyName(profile.name);
  document.getElementById("sideStage").textContent = translatePhase(deployment?.stage || "dry-run");
  document.getElementById("sideFuturesPolicy").textContent = "보기 전용 · 실주문 없음";
  document.getElementById("riskFutures").textContent = risk?.live_trading_locked ? "선물 실주문 없음" : "선물 주의";
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
      title: "운용",
      rows: [
        ["방식", friendlyStrategyName(profile.name)],
        ["상태", translatePhase(execution.current_phase || "dry-run")],
        ["실거래", risk.live_trading_locked ? "차단" : "열림"],
        ["출금", risk.auto_withdrawals ? "ON" : "OFF"],
      ],
    },
    {
      title: "배분",
      rows: [
        ["Upbit-KRW", `${book.upbit_pct ?? 60}%`],
        ["Binance-USDT", `${book.binance_pct ?? 40}%`],
        ["투자/대기", `${profile.spot_weight_pct ?? 88}% / ${profile.reserve_pct ?? 8}%`],
        ["조정", `${translateSchedule(rebalance.schedule)} · ${rebalance.drift_threshold_pct_points ?? 5}%p`],
      ],
    },
    {
      title: "주문",
      rows: [
        ["기본", translateOrderType(execution.default_order_type)],
        ["위험", translateOrderType(execution.emergency_exit_order_type)],
        ["최소금액", execution.validate_min_order_before_submit ? "ON" : "OFF"],
        ["재시도", execution.state_reconcile_before_retry ? "ON" : "OFF"],
      ],
    },
    {
      title: "선물",
      rows: [
        ["상태", futures.enabled ? "ON" : "OFF"],
        ["종목", (futures.symbols || ["BTCUSDT", "ETHUSDT"]).join(", ")],
        ["방식", `${translateMarginType(futures.margin_type)} · ${translatePositionMode(futures.position_mode)}`],
        ["한도", `${futures.max_leverage ?? 2}배 · ${futures.gross_notional_cap_pct ?? 8}%`],
      ],
    },
    {
      title: "레버리지 테스트",
      rows: [
        ["상태", data.paper_leverage_test?.enabled ? "ON" : "OFF"],
        ["기본", formatLeverage(data.paper_leverage_test?.default_leverage ?? 3)],
        ["비교", formatLeverage(data.paper_leverage_test?.compare_leverage ?? 5)],
        ["주문", "실주문 없음"],
      ],
    },
    {
      title: "자동화",
      rows: [
        ["차트", automation.chart_analysis || "15분"],
        ["구간", automation.support_resistance || "봉마감"],
        ["주문", automation.paper_plan || "09:12"],
        ["기록", `${performance.snapshot_count ?? 0}개`],
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
    const usdtKimchi = Number(asset.kimchi_premium_pct || 0);
    const usdKimchi = kimchiUsdReferencePct(asset);
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
          <span class="badge ${asset.signal}">${friendlySignalLabel(asset)}</span>
        </div>
        <div class="price">${formatPrice(displayPrice)}<span>${displayQuote}</span></div>
        <div class="asset-metrics">
          <span>하루 변동 <strong class="${changeClass}">${formatPct(asset.change_24h_pct)}</strong></span>
          <span>USDT 기준 <strong class="${pctToneClass(usdtKimchi)}">${formatPct(usdtKimchi)}</strong></span>
          <span>환율 기준 <strong class="${pctToneClass(usdKimchi)}">${formatNullablePct(usdKimchi)}</strong></span>
          <span>과열도 <strong>${asset.rsi}</strong></span>
          <span>흔들림 <strong>${asset.atr_pct}%</strong></span>
          <span>지지까지 <strong>${asset.support_distance_pct}%</strong></span>
          <span>저항까지 <strong>${asset.resistance_distance_pct}%</strong></span>
          <span>거래 힘 <strong>${asset.volume_ratio}x</strong></span>
          <span>BTC 대비 <strong>${asset.relative_strength_vs_btc}</strong></span>
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

function renderDecision(asset, chartPayload = null) {
  if (!asset) return;
  const displayQuote = venueConfig[state.venue]?.quote || "KRW";
  const venueLevels = decisionLevelSource(asset, chartPayload);
  const displayPrice = venueLevels.current;
  document.getElementById("chartTitle").textContent = state.selected.instrument;
  updateChartCaption(asset);
  document.getElementById("decisionMarket").textContent = `${state.selected.instrument} · ${assetMeta[asset.asset]?.korean || asset.asset}`;
  document.getElementById("decisionSignal").textContent = friendlySignalLabel(asset);
  document.getElementById("decisionSummary").textContent = friendlyDecisionSummary(asset, venueLevels);
  document.getElementById("planCurrent").textContent = `${formatPrice(displayPrice)} ${displayQuote}`;
  const usdtKimchi = Number(asset.kimchi_premium_pct || 0);
  const usdKimchi = kimchiUsdReferencePct(asset);
  const kimchiEl = document.getElementById("planKimchi");
  kimchiEl.className = "kimchi-pair";
  kimchiEl.innerHTML = `
    <span class="${pctToneClass(usdtKimchi)}">USDT ${formatPct(usdtKimchi)}</span>
    <span class="${pctToneClass(usdKimchi)}">환율 ${formatNullablePct(usdKimchi)}</span>
  `;
  document.getElementById("planSupport").textContent = `${formatPrice(venueLevels.support)} (${formatPctPlain(venueLevels.supportDistance)}%)`;
  document.getElementById("planResistance").textContent = `${formatPrice(venueLevels.resistance)} (${formatPctPlain(venueLevels.resistanceDistance)}%)`;
  document.getElementById("planStop").textContent = formatPrice(venueLevels.stopLoss);
  document.getElementById("planTp").textContent = (venueLevels.takeProfit || []).map(formatPrice).join(" / ");
  document.getElementById("riskRsi").textContent = asset.rsi;
  document.getElementById("riskAtr").textContent = `${asset.atr_pct}%`;
  document.getElementById("riskVolume").textContent = `${asset.volume_ratio}x`;
  document.getElementById("riskRs").textContent = asset.asset === "BTC" ? "기준 자산" : asset.relative_strength_vs_btc;
  renderPaperLeverageTest(venueLevels);
  updateOrderFormForVenue();

  const checks = buildChecks(asset, venueLevels);
  document.getElementById("checkList").innerHTML = checks.map((check) => `
    <div class="check ${check.state}">
      <span class="check-icon">${check.state === "pass" ? "✓" : check.state === "fail" ? "×" : "!"}</span>
      <span class="check-copy">
        <b>${check.label}</b>
      </span>
      <span class="status-tag">${check.tag}</span>
    </div>
  `).join("");
  renderScalpChecks(asset);
}

function decisionLevelSource(asset, chartPayload = null) {
  const matchesChart = chartPayload
    && chartPayload.exchange === state.selected.exchange
    && chartPayload.instrument === state.selected.instrument
    && chartPayload.levels
    && chartPayload.indicators;
  if (matchesChart) {
    const current = Number(chartPayload.indicators.close || priceForVenue(asset, state.venue));
    const support = Number(chartPayload.levels.support || 0);
    const resistance = Number(chartPayload.levels.resistance || 0);
    return {
      current,
      support,
      resistance,
      supportDistance: Number(chartPayload.levels.support_distance_pct || 0),
      resistanceDistance: Number(chartPayload.levels.resistance_distance_pct || 0),
      stopLoss: Number(chartPayload.lines?.stop_loss || 0),
      takeProfit: chartPayload.lines?.take_profit || [],
      source: state.selected.exchange,
    };
  }
  return {
    current: priceForVenue(asset, state.venue),
    support: Number(asset.nearest_support || 0),
    resistance: Number(asset.nearest_resistance || 0),
    supportDistance: Number(asset.support_distance_pct || 0),
    resistanceDistance: Number(asset.resistance_distance_pct || 0),
    stopLoss: Number(asset.stop_loss || 0),
    takeProfit: asset.take_profit || [],
    source: asset.exchange,
  };
}

function renderPaperLeverageTest(levels) {
  const policy = state.dashboard?.paper_leverage_test || {};
  const isFutures = state.selected.exchange === "binance_futures";
  const enabled = Boolean(policy.enabled);
  const leverage = Number(policy.default_leverage || 3);
  const compare = Number(policy.compare_leverage || 5);
  if (!enabled || !isFutures) {
    setText("riskLeverage", "1x");
    setText("riskLevTarget", "--");
    setText("riskLevStop", "--");
    setTone("riskLevTarget", "");
    setTone("riskLevStop", "");
    return;
  }
  const current = Number(levels.current || 0);
  const target = Number((levels.takeProfit || [])[0] || levels.resistance || 0);
  const stop = Number(levels.stopLoss || 0);
  const targetPct = current > 0 && target > 0 ? ((target / current) - 1) * 100 : 0;
  const stopPct = current > 0 && stop > 0 ? ((stop / current) - 1) * 100 : 0;
  setText("riskLeverage", `${formatLeverage(leverage)} / ${formatLeverage(compare)} TEST`);
  setText("riskLevTarget", `${formatLeverage(leverage)} ${formatPct(targetPct * leverage)} · ${formatLeverage(compare)} ${formatPct(targetPct * compare)}`);
  setText("riskLevStop", `${formatLeverage(leverage)} ${formatPct(stopPct * leverage)} · ${formatLeverage(compare)} ${formatPct(stopPct * compare)}`);
  setTone("riskLevTarget", targetPct >= 0 ? "positive" : "negative");
  setTone("riskLevStop", stopPct >= 0 ? "positive" : "negative");
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
  button.textContent = state.scalpMode ? "초단기 ON" : "초단기 OFF";
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
    ? "보기 전용"
    : "실주문 없음";
}

function friendlyDecisionSummary(asset, levels = {}) {
  const name = assetMeta[asset.asset]?.korean || asset.asset;
  const holding = hasAssetPosition(asset);
  const support = Number(levels.supportDistance ?? asset.support_distance_pct ?? 0).toFixed(2);
  const resistance = Number(levels.resistanceDistance ?? asset.resistance_distance_pct ?? 0).toFixed(2);
  const prefix = holding ? "보유" : "미보유";
  if (asset.signal === "buy") {
    return `${prefix} · 매수 가능 · 지지 ${support}% · 저항 ${resistance}%`;
  }
  if (asset.signal === "watch") {
    return `${prefix} · 관찰 · 지지 ${support}% · 저항 ${resistance}%`;
  }
  if (asset.signal === "skip") {
    return `${prefix} · 대기 · 지지 ${support}% · 저항 ${resistance}%`;
  }
  if (asset.signal === "data_error") {
    return `${name} · 데이터 확인`;
  }
  return "대기";
}

function hasAssetPosition(asset) {
  const position = asset?.position || {};
  return Number(position.quantity || 0) > 0 || Number(position.cost_basis || 0) > 0;
}

function friendlySignalLabel(asset) {
  const holding = hasAssetPosition(asset);
  if (asset.signal === "buy") return holding ? "보유 · 추가매수 가능" : "매수 가능";
  if (asset.signal === "watch") return holding ? "보유 · 지켜보기" : "조금 더 보기";
  if (asset.signal === "skip") return holding ? "보유 · 추가매수 대기" : "매수 대기";
  if (asset.signal === "data_error") return "데이터 확인 필요";
  return signalLabels[asset.signal] || asset.signal || "--";
}

function buildChecks(asset, levels = {}) {
  const regime = state.dashboard.market_regime.name;
  const supportDistance = Number(levels.supportDistance ?? asset.support_distance_pct ?? 0);
  const resistanceDistance = Number(levels.resistanceDistance ?? asset.resistance_distance_pct ?? 0);
  const volumeRatio = Number(asset.volume_ratio || 0);
  const rsi = Number(asset.rsi || 0);
  const kimchi = Number(asset.kimchi_premium_pct || 0);
  const marketState = regime === "bull" ? "pass" : regime === "neutral" ? "caution" : "fail";
  const marketTag = regime === "bull" ? "좋음" : regime === "neutral" ? "보통" : "불리";
  const signalState = asset.signal === "buy" ? "pass" : asset.signal === "watch" ? "caution" : "fail";
  const signalTag = friendlySignalLabel(asset).replace("보유 · ", "");
  const priceState = supportDistance <= 1.2 && resistanceDistance >= 0.5
    ? "pass"
    : supportDistance <= 2.2 && resistanceDistance >= 0.2 ? "caution" : "fail";
  const priceTag = priceState === "pass" ? "괜찮음" : priceState === "caution" ? "애매" : "불리";
  const volumeState = volumeRatio >= 1 ? "pass" : volumeRatio >= 0.5 ? "caution" : "fail";
  const overheatState = rsi >= 72 || Math.abs(kimchi) >= 4
    ? "fail"
    : rsi >= 65 || Math.abs(kimchi) >= 2 ? "caution" : "pass";
  return [
    {
      label: "시장",
      state: marketState,
      tag: marketTag,
    },
    {
      label: "판단",
      state: signalState,
      tag: signalTag,
    },
    {
      label: "위치",
      state: priceState,
      tag: `${priceTag} · ${supportDistance.toFixed(2)}%`,
    },
    {
      label: "거래량",
      state: volumeState,
      tag: `${volumeRatio.toFixed(2)}x`,
    },
    {
      label: "과열",
      state: overheatState,
      tag: overheatState === "pass" ? "낮음" : overheatState === "caution" ? "주의" : "높음",
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
      label: "수수료 확인",
      state: scalp.zero_fee_verified ? "pass" : "fail",
      tag: scalp.zero_fee_verified ? "확인" : `${scalp.assumed_fee_bps} bps`,
    },
    {
      label: "초단기 차트",
      state: state.scalpMode ? "pass" : "caution",
      tag: state.scalpMode ? "켜짐" : "꺼짐",
    },
    {
      label: "가격 흔들림",
      state: tightRange ? "pass" : "caution",
      tag: `${asset.atr_pct}%`,
    },
    {
      label: "거래 힘",
      state: volumeOk ? "pass" : "caution",
      tag: `${asset.volume_ratio}x`,
    },
    {
      label: "짧은 추세",
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
    ? `${scalp.max_hold_minutes}분 · ${scalp.position_cap_pct}%`
    : "잠금";
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

function portfolioRealizedPnl(portfolio) {
  const summaryValue = Number(portfolio?.summary?.realized_pnl);
  if (Number.isFinite(summaryValue)) return summaryValue;
  return (portfolio?.positions || []).reduce((sum, position) => sum + Number(position.realized_pnl || 0), 0);
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
  const realizedPnl = portfolioRealizedPnl(portfolio);
  const tradePnl = positionPnl + realizedPnl;
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
  const realizedClass = realizedPnl >= 0 ? "positive" : "negative";
  const realizedBox = document.getElementById("overviewRealizedBox");
  if (realizedBox) {
    realizedBox.className = `summary-main realized-focus ${realizedClass}`;
  }
  const realizedAmountEl = document.getElementById("overviewRealizedAmount");
  if (realizedAmountEl) {
    realizedAmountEl.className = realizedClass;
    realizedAmountEl.textContent = formatSignedMoney(realizedPnl, "KRW");
  }
  const realizedDetailEl = document.getElementById("overviewRealizedDetail");
  if (realizedDetailEl) {
    realizedDetailEl.className = `summary-return ${realizedClass}`;
    realizedDetailEl.textContent = `${realizedPnl ? "매도 확정" : "매도 없음"} · 합산 ${formatSignedMoney(tradePnl, "KRW")}`;
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
  setText("overviewFreshness", state.stream.enabled ? `실시간 ${lastTick}` : `기록 시점 ${shortTime(updatedAt).slice(11, 19)}`);
  renderActualAllocation(positions, cash, totalEquity);

  const cards = document.getElementById("holdingCards");
  if (!cards) return;
  if (!positions.length) {
    cards.innerHTML = `
      <div class="holding-empty">
        <strong>보유 없음</strong>
        <span>조건 대기</span>
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
  const realizedPnl = Number(position.realized_pnl || 0);
  const weight = totalEquity > 0 ? (value / totalEquity) * 100 : 0;
  const pnlClass = pnl >= 0 ? "positive" : "negative";
  const realizedClass = realizedPnl >= 0 ? "positive" : "negative";
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
        <span>실현 <b class="${realizedClass}">${formatSignedMoney(realizedPnl, "KRW")}</b></span>
      </div>
    </article>
  `;
}

function renderPositions(positions) {
  const body = document.getElementById("positionsBody");
  if (!positions.length) {
    body.innerHTML = `<tr><td colspan="9">아직 보유 포지션이 없습니다.</td></tr>`;
    return;
  }
  body.innerHTML = positions.map((position) => {
    const pnlClass = Number(position.unrealized_pnl) >= 0 ? "positive" : "negative";
    const realizedClass = Number(position.realized_pnl || 0) >= 0 ? "positive" : "negative";
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
        <td class="${realizedClass} pnl-cell">${formatSignedMoney(position.realized_pnl, "KRW")}</td>
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
  document.getElementById("performanceNote").textContent = `KRW · 기록 ${performance.snapshot_count}개`;

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
    : `<tr><td colspan="4">기록 부족</td></tr>`;
}

function renderTrades(trades) {
  const body = document.getElementById("tradesBody");
  const summaryRoot = document.getElementById("tradeSummary");
  const cardsRoot = document.getElementById("tradeCards");
  const allTrades = trades || [];
  const filtered = allTrades.filter((trade) => {
    if (state.tradeFilter === "all") return trade.status === "simulated";
    return trade.status === "simulated" && trade.side === state.tradeFilter;
  });
  renderTradeSummary(allTrades, summaryRoot);

  if (!allTrades.length) {
    if (cardsRoot) {
      cardsRoot.innerHTML = `
        <div class="trade-empty">
          <strong>기록 없음</strong>
          <span>가상 주문 대기</span>
        </div>
      `;
    }
    body.innerHTML = `<tr><td colspan="8">기록 없음</td></tr>`;
    return;
  }

  if (cardsRoot) {
    cardsRoot.innerHTML = filtered.length
      ? filtered.slice(0, 8).map(renderTradeCard).join("")
      : `
        <div class="trade-empty">
          <strong>기록 없음</strong>
          <span>${state.tradeFilter === "all" ? "체결 없음" : "필터 없음"}</span>
        </div>
      `;
  }

  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="8">${state.tradeFilter === "all" ? "체결된 가상 주문 없음" : "기록 없음"}</td></tr>`;
    return;
  }

  body.innerHTML = filtered.slice(0, 20).map((trade) => `
    <tr>
      <td>${shortTime(trade.timestamp).slice(5)}</td>
      <td>${trade.instrument}</td>
      <td><span class="trade-side ${tradeSideClass(trade)}">${translateTradeSide(trade)}</span></td>
      <td>${tradeExecutedAmount(trade)}</td>
      <td>${formatPrice(trade.effective_price || trade.price)}</td>
      <td>${formatQuantity(trade.base_quantity)}</td>
      <td><span class="trade-status ${tradeStatusClass(trade.status)}">${translateStatus(trade.status)}</span></td>
      <td>${translateNote(trade.note)}</td>
    </tr>
  `).join("");
}

function renderTradeSummary(trades, root) {
  if (!root) return;
  const simulated = trades.filter((trade) => trade.status === "simulated");
  const buys = simulated.filter((trade) => trade.side === "buy");
  const sells = simulated.filter((trade) => trade.side === "sell");
  const buyTotal = buys.reduce((sum, trade) => sum + Number(trade.executed_quote_value || 0), 0);
  const sellTotal = sells.reduce((sum, trade) => sum + Number(trade.executed_quote_value || 0), 0);
  const realized = sells.reduce((sum, trade) => sum + Number(trade.realized_pnl || 0), 0);
  root.innerHTML = `
    <div class="trade-summary-card buy">
      <span>가상 매수</span>
      <strong>${moneyFormat.format(Math.round(buyTotal))} KRW</strong>
      <b>${buys.length}건</b>
    </div>
    <div class="trade-summary-card sell">
      <span>가상 매도</span>
      <strong>${moneyFormat.format(Math.round(sellTotal))} KRW</strong>
      <b>${sells.length}건</b>
    </div>
    <div class="trade-summary-card ${realized >= 0 ? "positive-card" : "negative-card"}">
      <span>확정 손익</span>
      <strong>${formatSignedMoney(realized, "KRW")}</strong>
      <b>${sells.length ? "실현손익" : "매도 없음"}</b>
    </div>
    <div class="trade-summary-card muted-card">
      <span>최근 체결</span>
      <strong>${simulated.length}건</strong>
      <b>가상 주문만 표시</b>
    </div>
  `;
}

function renderTradeCard(trade) {
  const sideClass = tradeSideClass(trade);
  const statusClass = tradeStatusClass(trade.status);
  const isSkipped = trade.status === "skipped";
  return `
    <article class="trade-card ${sideClass} ${isSkipped ? "is-skipped" : ""}">
      <div class="trade-card-head">
        <div>
          <span>${shortTime(trade.timestamp).slice(5)}</span>
          <strong>${trade.instrument}</strong>
        </div>
        <span class="trade-side ${sideClass}">${translateTradeSide(trade)}</span>
      </div>
      <div class="trade-card-main">
        <strong>${tradeExecutedAmount(trade)}</strong>
        <span>${formatPrice(trade.effective_price || trade.price)} · ${formatQuantity(trade.base_quantity)}</span>
      </div>
      <div class="trade-card-foot">
        <span class="trade-status ${statusClass}">${translateStatus(trade.status)}</span>
        <span>${translateNote(trade.note)}</span>
      </div>
    </article>
  `;
}

function tradeExecutedAmount(trade) {
  if (trade.status === "skipped") return "체결 없음";
  const value = Number(trade.executed_quote_value || trade.requested_quote_budget || 0);
  if (!value) return "--";
  return `${moneyFormat.format(Math.round(value))} ${trade.quote_currency || "KRW"}`;
}

function tradeSideClass(trade) {
  if (trade.status === "skipped") return "muted";
  return trade.side === "sell" ? "sell" : "buy";
}

function tradeStatusClass(status) {
  if (status === "simulated") return "filled";
  if (status === "skipped") return "skipped";
  return "pending";
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
  if (exchange === "upbit") return "업비트 현물";
  if (exchange === "binance") return "바이낸스 현물";
  if (exchange === "binance_futures") return "바이낸스 선물";
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
  addMagnetLines(payload);
  addExtraLevelLines(payload);
  addPriceLine(payload.lines.support, "#22c55e", "지지선", { lineWidth: 2 });
  addPriceLine(payload.lines.resistance, "#ef4444", "저항선", { lineWidth: 2 });
  addPriceLine(payload.lines.stop_loss, "#ef4444", "손실 제한");
  payload.lines.take_profit
    .slice(0, state.showIndicators ? 2 : 1)
    .forEach((price, index) => addPriceLine(price, "#86efac", `수익 목표${index + 1}`));
  const averagePrice = averagePriceForChart(selectedAsset(), payload);
  addPriceLine(averagePrice, "#facc15", "평단가", { lineWidth: 2, lineStyle: 1 });
  state.chart.timeScale().fitContent();
  document.getElementById("priceTag").textContent = formatPrice(payload.indicators.close);
  renderLineLegend(payload);
  if (payload.exchange === state.selected.exchange && payload.instrument === state.selected.instrument) {
    renderDecision(selectedAsset(), payload);
  }
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
    grid.innerHTML = `<div class="mtf-empty">분봉 없음</div>`;
    return;
  }

  subtitle.textContent = `${payload.instrument} · 분봉`;
  score.textContent = mtfScoreLabel(payload.alignment_score);
  score.className = `mtf-score ${payload.alignment_score >= 75 ? "positive" : payload.alignment_score >= 55 ? "caution" : "negative"}`;
  grid.innerHTML = payload.timeframes.map((row) => {
    const changeClass = Number(row.change_pct) >= 0 ? "positive" : "negative";
    const signalClass = row.signal === "long-watch" ? "positive" : row.signal === "wait" ? "caution" : "negative";
    return `
      <div class="mtf-card ${row.signal}">
        <div class="mtf-card-head">
          <strong>${row.label}</strong>
          <span class="${signalClass}">${friendlyMtfSignal(row)}</span>
        </div>
        <div class="mtf-price">${formatPrice(row.close)} <span class="${changeClass}">${formatPct(row.change_pct)}</span></div>
        <div class="mtf-stats">
          <span>흐름 <b>${mtfTrendLabel(row)}</b></span>
          <span>거래 힘 <b>${volumeStrengthLabel(row.volume_ratio)}</b></span>
          <span>가격 위치 <b>${mtfLocationLabel(row)}</b></span>
          <span>변동 <b>${volatilityLabel(row.atr_pct)}</b></span>
        </div>
        <p>${friendlyMtfReason(row)}</p>
      </div>
    `;
  }).join("");
}

function mtfScoreLabel(score) {
  const value = Number(score || 0);
  if (value >= 75) return "좋음";
  if (value >= 55) return "관찰";
  return "대기";
}

function friendlyMtfSignal(row) {
  if (row.signal === "long-watch") return "매수 후보";
  if (row.signal === "wait") return "조금 보기";
  return "대기";
}

function mtfTrendLabel(row) {
  const close = Number(row.close || 0);
  const ema20 = Number(row.ema20 || 0);
  const ema50 = Number(row.ema50 || 0);
  if (close > ema20 && close > ema50) return "상승";
  if (close > ema20) return "반등";
  return "약함";
}

function volumeStrengthLabel(value) {
  const ratio = Number(value || 0);
  if (ratio >= 1.2) return "활발";
  if (ratio >= 0.7) return "보통";
  return "약함";
}

function mtfLocationLabel(row) {
  const support = Number(row.support_distance_pct || 0);
  const resistance = Number(row.resistance_distance_pct || 0);
  if (resistance <= 0.25) return "저항";
  if (support <= 0.25) return "지지";
  return "중간";
}

function volatilityLabel(value) {
  const pct = Number(value || 0);
  if (pct >= 0.25) return "큼";
  if (pct >= 0.08) return "보통";
  return "작음";
}

function friendlyMtfReason(row) {
  const trend = mtfTrendLabel(row);
  const volume = volumeStrengthLabel(row.volume_ratio);
  const location = mtfLocationLabel(row);
  return `${trend} · ${volume} · ${location}`;
}

function addMagnetLines(payload) {
  const lines = payload.lines || {};
  addPriceLine(lines.support_zone_low, "#16a34a", "지지 자석 하단", { lineStyle: 2, axisLabelVisible: false });
  addPriceLine(lines.support_zone_high, "#16a34a", "지지 자석 상단", { lineStyle: 2, axisLabelVisible: false });
  addPriceLine(lines.resistance_zone_low, "#f97316", "저항 자석 하단", { lineStyle: 2, axisLabelVisible: false });
  addPriceLine(lines.resistance_zone_high, "#f97316", "저항 자석 상단", { lineStyle: 2, axisLabelVisible: false });
}

function addExtraLevelLines(payload) {
  const lines = payload.lines || {};
  (lines.support_levels || [])
    .filter((price) => price && !samePrice(price, lines.support))
    .slice(0, 2)
    .forEach((price, index) => addPriceLine(price, "#4ade80", `지지 ${index + 2}`, { lineStyle: 2, axisLabelVisible: false }));
  (lines.resistance_levels || [])
    .filter((price) => price && !samePrice(price, lines.resistance))
    .slice(0, 2)
    .forEach((price, index) => addPriceLine(price, "#fb7185", `저항 ${index + 2}`, { lineStyle: 2, axisLabelVisible: false }));
}

function samePrice(a, b) {
  const first = Number(a || 0);
  const second = Number(b || 0);
  if (!first || !second) return false;
  return Math.abs(first - second) / second < 0.0002;
}

function averagePriceForChart(asset, payload) {
  if (!asset || !payload) return 0;
  const position = positionForAsset(asset);
  const quantity = Number(position?.quantity || asset.position?.quantity || 0);
  const average = Number(position?.average_price || asset.position?.average_price || 0);
  if (quantity <= 0 || average <= 0) return 0;
  if (payload.exchange === "upbit") return average;
  const usdtKrw = Number(asset.usdt_krw || state.dashboard?.usdt_krw || 0);
  return usdtKrw > 0 ? average / usdtKrw : 0;
}

function positionForAsset(asset) {
  return (state.dashboard?.portfolio?.positions || []).find((position) => (
    position.exchange === "upbit" && position.instrument === asset.upbit
  ));
}

function addPriceLine(price, color, title, options = {}) {
  if (!price || price <= 0) return;
  const line = state.candleSeries.createPriceLine({
    price,
    color,
    lineWidth: options.lineWidth || 1,
    lineStyle: options.lineStyle ?? (title === "지지선" || title === "저항선" ? 0 : 2),
    axisLabelVisible: options.axisLabelVisible ?? true,
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
  const realizedPnl = portfolioRealizedPnl(portfolio);
  row.position_value = positionValue;
  row.total_equity = cash + positionValue;
  row.unrealized_pnl = positionValue - costBasis;
  portfolio.summary = {
    ...(portfolio.summary || {}),
    cost_basis: costBasis,
    position_value: positionValue,
    unrealized_pnl: row.unrealized_pnl,
    realized_pnl: realizedPnl,
    trade_pnl: row.unrealized_pnl + realizedPnl,
  };
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
    renderSessionStrip(state.dashboard);
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
  const averagePrice = averagePriceForChart(selectedAsset(), payload);
  const magnetPct = Number(payload.levels?.magnet_zone_pct || 0);
  const indicatorLegend = state.showIndicators
    ? `
      <span class="legend-chip ema20" title="20봉 지수이동평균선">EMA20</span>
      <span class="legend-chip ema50" title="50봉 지수이동평균선">EMA50</span>
      <span class="legend-chip ma200" title="200봉 단순이동평균선">MA200</span>
    `
    : "";
  document.getElementById("lineLegend").innerHTML = `
    <span class="legend-chip support" title="가격 아래의 주요 지지 구간">지지선 ${formatPrice(payload.levels.support)} (${Number(payload.levels.support_distance_pct).toFixed(2)}%)</span>
    <span class="legend-chip magnet" title="지지/저항 주변에서 가격이 머뭇거리기 쉬운 구간">자석 ${formatPctPlain(magnetPct)}%</span>
    <span class="legend-chip resistance" title="가격 위의 주요 저항 구간">저항선 ${formatPrice(payload.levels.resistance)} (${Number(payload.levels.resistance_distance_pct).toFixed(2)}%)</span>
    <span class="legend-chip stop" title="손실이 커지기 전에 정리하는 기준가">손실 제한 ${formatPrice(payload.lines.stop_loss)}</span>
    <span class="legend-chip target" title="일부 수익을 챙길 수 있는 목표가">목표1 ${formatPrice(takeProfit[0])}</span>
    ${state.showIndicators && takeProfit[1] ? `<span class="legend-chip target" title="두 번째 수익 목표가">목표2 ${formatPrice(takeProfit[1])}</span>` : ""}
    ${averagePrice ? `<span class="legend-chip average" title="현재 모의 보유 평균 매수가">평단 ${formatPrice(averagePrice)}</span>` : ""}
    ${indicatorLegend}
    <span class="legend-chip muted-chip">과열도 ${Number(payload.indicators.rsi).toFixed(1)}</span>
    <span class="legend-chip muted-chip">흔들림 ${Number(payload.indicators.atr_pct).toFixed(2)}%</span>
    <span class="legend-chip muted-chip">거래 힘 ${Number(payload.indicators.volume_ratio).toFixed(2)}x</span>
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
  const button = document.getElementById("runPlanBtn");
  const confirmed = window.confirm("모의 계획 실행? 실주문 없음.");
  if (!confirmed) return;
  const originalText = button?.textContent || "모의 계획 수동 실행";
  if (button) {
    button.disabled = true;
    button.textContent = "실행 중...";
  }
  try {
    await fetch("/api/run-plan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await loadDashboard();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
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

function formatPctPlain(value) {
  return Number(value || 0).toFixed(2);
}

function formatLeverage(value) {
  const number = Number(value || 0);
  return `${Number.isInteger(number) ? number.toFixed(0) : number.toFixed(1)}x`;
}

function formatNullablePct(value) {
  if (value == null || !Number.isFinite(Number(value))) return "--";
  return formatPct(value);
}

function pctToneClass(value) {
  return Number(value || 0) >= 0 ? "positive" : "negative";
}

function kimchiUsdReferencePct(asset) {
  const price = Number(asset?.current_price || 0);
  const binance = Number(asset?.binance_price || 0);
  const usdKrw = Number(state.dashboard?.usd_krw_reference || 0);
  const overseas = binance * usdKrw;
  if (!Number.isFinite(price) || !Number.isFinite(overseas) || price <= 0 || overseas <= 0) return null;
  return (price / overseas - 1) * 100;
}

function friendlyKimchiText(asset) {
  const usdt = Number(asset?.kimchi_premium_pct || 0);
  const usd = kimchiUsdReferencePct(asset);
  return `USDT 기준 ${formatPct(usdt)}, 환율 기준 ${formatNullablePct(usd)}`;
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

function setTone(id, tone = "") {
  const element = document.getElementById(id);
  if (!element) return;
  element.classList.remove("positive", "negative", "caution", "info");
  if (tone) element.classList.add(tone);
}

function shortTime(value) {
  if (!value) return "--";
  return String(value).replace("T", " ").slice(0, 19);
}

function timeOnly(value) {
  const text = shortTime(value);
  return text.length >= 16 ? text.slice(11, 16) : text;
}

function ageLabel(seconds) {
  const value = Number(seconds || 0);
  if (value < 60) return `${Math.round(value)}초`;
  return `${Math.round(value / 60)}분`;
}

function friendlySeverity(severity = "") {
  if (severity === "CRIT") return "위험";
  if (severity === "WARN") return "주의";
  if (severity === "INFO") return "정상";
  return "상태 확인";
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

function translateTradeSide(trade) {
  if (trade?.status === "skipped") {
    return trade.side === "sell" ? "매도 안함" : "매수 안함";
  }
  return translateSide(trade?.side);
}

function translateStatus(status) {
  return status === "simulated" ? "가상 체결" : status === "skipped" ? "주문 안함" : status;
}

function friendlyStrategyName(name = "") {
  if (String(name).toLowerCase().includes("neutral")) return "보통 모드";
  if (String(name).toLowerCase().includes("aggressive")) return "공격 모드";
  if (String(name).toLowerCase().includes("conservative")) return "보수 모드";
  return name || "보통 모드";
}

function translatePhase(phase) {
  return {
    shadow: "관찰",
    "order-intent": "주문 후보",
    "dry-run": "모의투자",
    "test/demo": "데모",
    "micro-live": "소액 실험",
    live: "실전",
  }[phase] || phase || "모의투자";
}

function translateSchedule(schedule) {
  return {
    biweekly: "2주마다",
    weekly: "매주",
    monthly: "매월",
    daily: "매일",
  }[schedule] || schedule || "2주마다";
}

function translateOrderType(type) {
  return {
    limit_split: "나눠서 천천히",
    marketable_limit: "빠르게 정리",
    market: "시장가",
  }[type] || type || "--";
}

function translateMarginType(type = "") {
  return String(type).toLowerCase() === "isolated" ? "종목별로 분리" : type || "분리";
}

function translatePositionMode(mode = "") {
  return String(mode).toLowerCase() === "one-way" ? "한 방향만" : mode || "한 방향만";
}

function translateNote(note = "") {
  if (note.includes("paper buy")) return "가상 매수";
  if (note.includes("paper sell")) return "가상 매도";
  if (note.includes("no real order")) return "실주문 없음";
  if (note.includes("already simulated")) return "중복으로 실행 안함";
  if (note.includes("below minimum")) return "최소금액 미만";
  if (note.includes("insufficient virtual cash")) return "현금 부족";
  if (note.includes("insufficient virtual position")) return "보유 부족";
  if (note.includes("no virtual position")) return "무보유";
  if (note.includes("price unavailable")) return "가격 없음";
  if (note.includes("insufficient")) return "잔고 부족";
  return note;
}
