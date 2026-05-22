#!/usr/bin/env python3
"""Local paper-trading dashboard server.

The server uses public market data only. Buy and sell actions update the virtual
portfolio state used by dryrun_bot.py; no real exchange orders are possible here.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import mimetypes
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from dryrun_bot import (
    PlannedOrder,
    build_equity_rows,
    ensure_portfolio,
    enforce_paper_mode,
    fetch_prices,
    format_decimal,
    load_json,
    load_state,
    parse_decimal,
    save_state,
    simulate_orders,
    write_equity,
    write_orders,
)


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
CONFIG_PATH = ROOT / "dryrun_config.json"
KST = ZoneInfo("Asia/Seoul")
HTTP_TIMEOUT = 8.0

TIMEFRAMES = {
    "1m": {"upbit_kind": "minutes", "upbit_unit": "1", "binance": "1m"},
    "3m": {"upbit_kind": "minutes", "upbit_unit": "3", "binance": "3m"},
    "5m": {"upbit_kind": "minutes", "upbit_unit": "5", "binance": "5m"},
    "10m": {"upbit_kind": "minutes", "upbit_unit": "10", "binance": "10m"},
    "15m": {"upbit_kind": "minutes", "upbit_unit": "15", "binance": "15m"},
    "30m": {"upbit_kind": "minutes", "upbit_unit": "30", "binance": "30m"},
    "1h": {"upbit_kind": "minutes", "upbit_unit": "60", "binance": "1h"},
    "4h": {"upbit_kind": "minutes", "upbit_unit": "240", "binance": "4h"},
    "1d": {"upbit_kind": "days", "binance": "1d"},
    "1w": {"upbit_kind": "weeks", "binance": "1w"},
    "1M": {"upbit_kind": "months", "binance": "1M"},
}

STRATEGY_PROFILE = {
    "name": "RGCA-L Neutral",
    "stage": "dry-run",
    "spot_weight_pct": 88,
    "reserve_pct": 8,
    "futures_collateral_pct": 4,
    "futures_notional_cap_pct": 8,
    "core_attack_split": "80/20",
    "spot_targets": {"BTC": 50, "ETH": 30, "XRP": 10, "SOL": 10},
    "rules": {
        "core": "BTC/ETH slow DCA with daily SMA50/SMA200 regime filter",
        "attack": "XRP/SOL only when 4h trend and BTC-relative strength are both positive",
        "futures": "BTC/ETH only, isolated, max 2x, order router locked",
    },
    "scalp_lab": {
        "enabled": False,
        "requires_zero_fee": True,
        "timeframes": ["1m", "3m", "5m", "15m"],
        "max_hold_minutes": 20,
        "position_cap_pct": 2,
        "daily_loss_stop_pct": 0.5,
        "stop_range_pct": [0.25, 0.45],
    },
}

DEFAULT_RISK_LIMITS = {
    "daily_loss_limit_pct": 2,
    "rolling_7d_loss_limit_pct": 6,
    "attack_sleeve_abs_cap_pct": 30,
    "risk_budget_core_add_pct": 0.25,
    "risk_budget_attack_entry_pct": 0.5,
    "auto_withdrawals": False,
    "live_trading_locked": True,
}

DEFAULT_FUTURES_OVERLAY = {
    "enabled": False,
    "dry_run_only": True,
    "symbols": ["BTCUSDT", "ETHUSDT"],
    "margin_type": "isolated",
    "position_mode": "one-way",
    "max_leverage": 2,
    "collateral_cap_pct": 4,
    "gross_notional_cap_pct": 8,
}

ASSETS = [
    {
        "asset": "BTC",
        "role": "core",
        "upbit": "KRW-BTC",
        "binance": "BTCUSDT",
        "exchange": "upbit",
        "rule": "btc_trend_dca",
    },
    {
        "asset": "ETH",
        "role": "core",
        "upbit": "KRW-ETH",
        "binance": "ETHUSDT",
        "exchange": "upbit",
        "rule": "eth_relative_strength",
    },
    {
        "asset": "XRP",
        "role": "aggressive",
        "upbit": "KRW-XRP",
        "binance": "XRPUSDT",
        "exchange": "upbit",
        "rule": "xrp_support_breakout",
    },
    {
        "asset": "SOL",
        "role": "aggressive",
        "upbit": "KRW-SOL",
        "binance": "SOLUSDT",
        "exchange": "upbit",
        "rule": "sol_trend_breakout",
    },
]


@dataclass(frozen=True)
class Candle:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float

    def to_chart(self) -> dict[str, float | int]:
        return {
            "time": self.time,
            "open": round(self.open, 8),
            "high": round(self.high, 8),
            "low": round(self.low, 8),
            "close": round(self.close, 8),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the local paper dashboard.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    server = ThreadingHTTPServer((args.host, args.port), PaperHandler)
    print(f"Paper dashboard running at http://{args.host}:{args.port}")
    server.serve_forever()
    return 0


class PaperHandler(BaseHTTPRequestHandler):
    server_version = "PaperTradingDashboard/0.1"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/dashboard":
            self.send_json(build_dashboard())
            return
        if parsed.path == "/api/candles":
            query = parse_qs(parsed.query)
            exchange = first(query, "exchange", "upbit")
            instrument = first(query, "instrument", "KRW-BTC")
            timeframe = first(query, "timeframe", "4h")
            self.send_json(build_candle_payload(exchange, instrument, timeframe))
            return
        if parsed.path == "/api/multi-timeframe":
            query = parse_qs(parsed.query)
            exchange = first(query, "exchange", "binance")
            instrument = first(query, "instrument", "BTCUSDT")
            timeframes = first(query, "timeframes", "1m,3m,5m,15m")
            self.send_json(build_multi_timeframe_payload(exchange, instrument, timeframes))
            return
        self.serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        body = self.read_json_body()
        if parsed.path == "/api/order":
            self.send_json(handle_paper_order(body))
            return
        if parsed.path == "/api/run-plan":
            self.send_json(handle_run_plan())
            return
        self.send_error(404, "Not found")

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, path: str) -> None:
        if path in ("", "/"):
            file_path = WEB_ROOT / "index.html"
        else:
            safe_path = path.lstrip("/").replace("/", "\\")
            file_path = (WEB_ROOT / safe_path).resolve()
            if not str(file_path).startswith(str(WEB_ROOT.resolve())):
                self.send_error(403, "Forbidden")
                return
        if not file_path.exists() or not file_path.is_file():
            self.send_error(404, "Not found")
            return
        body = file_path.read_bytes()
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        sys.stdout.write("%s - %s\n" % (self.log_date_time_string(), format % args))


def first(query: dict[str, list[str]], key: str, default: str) -> str:
    values = query.get(key)
    return values[0] if values else default


def build_dashboard() -> dict[str, Any]:
    config, state = load_runtime()
    now = datetime.now(KST)
    analyses: list[dict[str, Any]] = []
    btc_daily = safe_fetch_candles("upbit", "KRW-BTC", "1d", 220)
    btc_regime = detect_market_regime(btc_daily)
    usdt_krw = fetch_usdt_krw_rate()
    usd_krw_reference = fetch_usd_krw_reference_rate()
    usd_krw_rate = float(usd_krw_reference.get("rate") or 0)
    fx_basis_pct = ((usdt_krw / usd_krw_rate - 1) * 100) if usdt_krw > 0 and usd_krw_rate > 0 else 0.0

    for item in ASSETS:
        analysis = analyze_asset(item, btc_regime, usdt_krw, config)
        analyses.append(analysis)

    prices = prices_for_portfolio(config, state)
    equity_rows = build_equity_rows(state, config, prices, now)
    maybe_write_equity_snapshot(config, equity_rows, now)
    portfolio = portfolio_payload(state, prices, equity_rows)
    risk = risk_payload(config, equity_rows)
    return {
        "dry_run": True,
        "paper_mode": True,
        "live_trading": False,
        "updated_at": now.isoformat(timespec="seconds"),
        "status": "ok",
        "usdt_krw": round(usdt_krw, 2),
        "usdt_krw_source": "upbit_krw_usdt",
        "usd_krw_reference": round(usd_krw_rate, 2),
        "usd_krw_reference_date": usd_krw_reference.get("date", ""),
        "usd_krw_source": usd_krw_reference.get("source", "frankfurter_ecb_reference"),
        "fx_basis_pct": round(fx_basis_pct, 2),
        "market_regime": btc_regime,
        "strategy_profile": strategy_profile_payload(config),
        "automation": automation_policy_payload(config),
        "supervisor": supervisor_payload(config, now),
        "book_policy": book_policy_payload(config),
        "execution_policy": execution_policy_payload(config),
        "deployment": {
            "stage": config.get("strategy", {}).get("deployment_stage", "dry-run"),
            "sequence": config.get("strategy", {}).get("execution_policy", {}).get(
                "phase_sequence", ["shadow", "order-intent", "dry-run", "test/demo", "micro-live"]
            ),
            "live_trading_locked": risk["live_trading_locked"],
            "auto_withdrawals": risk["auto_withdrawals"],
        },
        "scalp_lab": scalp_lab_payload(config),
        "assets": analyses,
        "portfolio": portfolio,
        "performance": performance_payload(config, equity_rows, usdt_krw, now),
        "risk": risk,
        "trades": read_recent_trades(config, limit=80),
    }


def strategy_profile_payload(config: dict[str, Any]) -> dict[str, Any]:
    strategy = config.get("strategy", {})
    allocations = strategy.get("allocations", {})
    futures = {**DEFAULT_FUTURES_OVERLAY, **strategy.get("futures_overlay", {})}
    spot_targets = allocations.get("spot_targets_pct", STRATEGY_PROFILE["spot_targets"])
    return {
        "name": "RGCA-L Neutral",
        "stage": strategy.get("deployment_stage", "dry-run"),
        "profile": strategy.get("profile", "neutral"),
        "spot_weight_pct": allocations.get("spot_pct", STRATEGY_PROFILE["spot_weight_pct"]),
        "reserve_pct": allocations.get("reserve_pct", STRATEGY_PROFILE["reserve_pct"]),
        "futures_collateral_pct": futures.get("collateral_cap_pct", allocations.get("futures_collateral_cap_pct", 4)),
        "futures_notional_cap_pct": futures.get("gross_notional_cap_pct", allocations.get("futures_notional_cap_pct", 8)),
        "core_attack_split": allocations.get("core_attack_split", STRATEGY_PROFILE["core_attack_split"]),
        "spot_targets": spot_targets,
        "asset_max_weight_pct": allocations.get("asset_max_weight_pct", {"BTC": 50, "ETH": 30, "XRP": 15, "SOL": 15}),
        "rules": {
            "core": "BTC/ETH slow DCA with daily SMA50/SMA200 regime filter",
            "attack": "XRP/SOL only when 4h trend and BTC-relative strength are both positive",
        "futures": f"{', '.join(futures.get('symbols', ['BTCUSDT', 'ETHUSDT']))}, {futures.get('margin_type', 'isolated')}, max {futures.get('max_leverage', 2)}x, order router locked",
        },
        "scalp_lab": {**STRATEGY_PROFILE["scalp_lab"], **strategy.get("scalp_lab", {})},
    }


def supervisor_payload(config: dict[str, Any], now: datetime) -> dict[str, Any]:
    settings = config.get("strategy", {}).get("automation", {})
    interval = int(settings.get("supervisor_refresh_minutes", 5))
    status = read_supervisor_status()
    updated_raw = str(status.get("updated_at", ""))
    updated_at: datetime | None = None
    age_seconds: float | None = None
    if updated_raw:
        try:
            parsed = datetime.fromisoformat(updated_raw)
            updated_at = parsed if parsed.tzinfo else parsed.replace(tzinfo=KST)
            age_seconds = max((now - updated_at).total_seconds(), 0)
        except ValueError:
            updated_at = None

    healthy = bool(status.get("ok")) and age_seconds is not None and age_seconds <= max(interval * 2 * 60, 180)
    next_at = updated_at + timedelta(minutes=interval) if updated_at else None
    events = status.get("events") if isinstance(status.get("events"), list) else []
    return {
        "ok": bool(status.get("ok")),
        "running": healthy,
        "state": "running" if healthy else "stale",
        "severity": status.get("severity", "UNKNOWN") if status else "UNKNOWN",
        "updated_at": updated_raw,
        "age_seconds": round(age_seconds or 0),
        "refresh_minutes": interval,
        "next_check_at": next_at.isoformat(timespec="minutes") if next_at else "",
        "event_count": len(events),
        "lock_active": bool(status.get("no_entry_lock", {}).get("active")) if status else False,
    }


def scalp_lab_payload(config: dict[str, Any]) -> dict[str, Any]:
    settings = config.get("strategy", {}).get("scalp_lab", {})
    fee_bps = float(settings.get("assumed_fee_bps", 5))
    zero_fee_verified = bool(settings.get("zero_fee_verified", False)) and fee_bps <= 0.01
    enabled = bool(settings.get("enabled", False)) and zero_fee_verified
    profile = {**STRATEGY_PROFILE["scalp_lab"], **settings}
    return {
        **profile,
        "enabled": enabled,
        "zero_fee_verified": zero_fee_verified,
        "assumed_fee_bps": fee_bps,
        "lock_reason": "" if enabled else "수수료 무료 확인 전에는 초단타 자동 주문을 잠급니다.",
        "status": "ready" if enabled else "locked",
        "checklist": [
            {"label": "수수료 무료 확인", "ok": zero_fee_verified, "value": f"{fee_bps:g} bps"},
            {"label": "실거래 잠금", "ok": True, "value": "DRY-RUN"},
            {"label": "1~5분봉 준비", "ok": True, "value": "지원"},
            {"label": "일일 손실 제한", "ok": True, "value": f"{profile['daily_loss_stop_pct']}%"},
        ],
    }


def automation_policy_payload(config: dict[str, Any]) -> dict[str, Any]:
    settings = config.get("strategy", {}).get("automation", {})
    major_hours = settings.get("major_level_refresh_hours_kst", [1, 5, 9, 13, 17, 21])
    major_text = ", ".join(f"{int(hour):02d}:05" for hour in major_hours)
    return {
        "price_stream": "실시간 tick",
        "chart_analysis": f"{settings.get('dashboard_refresh_minutes', 15)}분마다",
        "support_resistance": f"{settings.get('support_resistance_refresh_minutes', 15)}분봉 마감 후",
        "major_levels": f"KST {major_text}",
        "daily_analysis": settings.get("daily_analysis_time_kst", "09:10"),
        "paper_plan": settings.get("paper_plan_time_kst", "09:12"),
        "snapshot_dir": settings.get("snapshot_dir", "data/snapshots"),
    }


def book_policy_payload(config: dict[str, Any]) -> dict[str, Any]:
    strategy = config.get("strategy", {})
    books = strategy.get("books", {})
    rebalancing = strategy.get("rebalancing", {})
    venue_allocation = books.get("venue_allocation_pct", {"upbit_krw": 60, "binance_usdt": 40})
    return {
        "mode": books.get("mode", "separated"),
        "description": books.get("description", "Upbit-KRW spot book + Binance-USDT spot/futures book"),
        "upbit_pct": venue_allocation.get("upbit_krw", 60),
        "binance_pct": venue_allocation.get("binance_usdt", 40),
        "auto_transfer_between_exchanges": bool(books.get("auto_transfer_between_exchanges", False)),
        "rebalance_with_new_cash_first": bool(books.get("rebalance_with_new_cash_first", True)),
        "rebalancing": {
            "schedule": rebalancing.get("schedule", "biweekly"),
            "drift_threshold_pct_points": rebalancing.get("drift_threshold_pct_points", 5),
            "run_time_kst": rebalancing.get("run_time_kst", "09:15"),
            "monthly_cross_exchange_review": bool(rebalancing.get("monthly_cross_exchange_review", True)),
            "cross_exchange_drift_threshold_pct_points": rebalancing.get("cross_exchange_drift_threshold_pct_points", 10),
        },
    }


def execution_policy_payload(config: dict[str, Any]) -> dict[str, Any]:
    policy = config.get("strategy", {}).get("execution_policy", {})
    futures = {**DEFAULT_FUTURES_OVERLAY, **config.get("strategy", {}).get("futures_overlay", {})}
    return {
        "current_phase": policy.get("current_phase", "dry-run"),
        "phase_sequence": policy.get("phase_sequence", ["shadow", "order-intent", "test/demo", "micro-live"]),
        "default_order_type": policy.get("default_order_type", "limit_split"),
        "emergency_exit_order_type": policy.get("emergency_exit_order_type", "marketable_limit"),
        "validate_symbol_filters_on_start": bool(policy.get("validate_symbol_filters_on_start", True)),
        "validate_min_order_before_submit": bool(policy.get("validate_min_order_before_submit", True)),
        "state_reconcile_before_retry": bool(policy.get("state_reconcile_before_retry", True)),
        "client_order_id_required": bool(policy.get("client_order_id_required", True)),
        "secret_logging": bool(policy.get("secret_logging", False)),
        "futures": {
            "enabled": bool(futures.get("enabled", False)),
            "dry_run_only": bool(futures.get("dry_run_only", True)),
            "symbols": futures.get("symbols", ["BTCUSDT", "ETHUSDT"]),
            "margin_type": futures.get("margin_type", "isolated"),
            "position_mode": futures.get("position_mode", "one-way"),
            "max_leverage": futures.get("max_leverage", 2),
            "gross_notional_cap_pct": futures.get("gross_notional_cap_pct", 8),
            "liquidation_warn_distance_pct": futures.get("liquidation_warn_distance_pct", 15),
            "liquidation_flat_distance_pct": futures.get("liquidation_flat_distance_pct", 10),
        },
    }


def load_runtime() -> tuple[dict[str, Any], dict[str, Any]]:
    config = load_json(CONFIG_PATH)
    enforce_paper_mode(config)
    state_path = ROOT / config["output"]["state_json"]
    state = load_state(state_path)
    ensure_portfolio(state, config)
    save_state(state_path, state)
    return config, state


def analyze_asset(
    item: dict[str, str], btc_regime: dict[str, Any], usdt_krw: float, config: dict[str, Any]
) -> dict[str, Any]:
    exchange = item["exchange"]
    instrument = item[exchange]
    h4 = safe_fetch_candles(exchange, instrument, "4h", 180)
    d1 = safe_fetch_candles(exchange, instrument, "1d", 220)
    candles = h4 or d1
    if len(candles) < 40:
        return {
            **item,
            "instrument": instrument,
            "current_price": 0,
            "signal": "data_error",
            "reason_summary": "시장 데이터를 충분히 가져오지 못했습니다.",
        }

    indicators = compute_indicators(candles)
    daily_indicators = compute_indicators(d1) if d1 else empty_indicators()
    levels = support_resistance(candles, indicators["atr"])
    rs20 = 0 if item["asset"] == "BTC" else round(relative_strength(item), 2)
    event_risk_flag = False
    signal = decide_signal(item, btc_regime, indicators, daily_indicators, d1, levels, rs20, event_risk_flag)
    position = current_position(item["exchange"], instrument)
    binance_price = fetch_binance_ticker_price(item["binance"])
    futures_price = fetch_binance_futures_ticker_price(item["binance"])
    kimchi = kimchi_premium(indicators["close"], binance_price, usdt_krw)
    profile = strategy_profile_payload(config)
    futures_policy = execution_policy_payload(config)["futures"]
    return {
        **item,
        "instrument": instrument,
        "market": instrument,
        "current_price": round(indicators["close"], 8),
        "binance_price": round(binance_price, 8),
        "futures_price": round(futures_price, 8),
        "usdt_krw": round(usdt_krw, 2),
        "kimchi_premium_pct": round(kimchi, 2),
        "change_24h_pct": round(change_pct(d1[-2].close, d1[-1].close) if len(d1) > 2 else 0, 2),
        "signal": signal["signal"],
        "score": signal["score"],
        "action": signal["action"],
        "reason_summary": signal["summary"],
        "reasons": signal["reasons"],
        "nearest_support": round(levels["support"], 8),
        "nearest_resistance": round(levels["resistance"], 8),
        "support_distance_pct": round(levels["support_distance_pct"], 2),
        "resistance_distance_pct": round(levels["resistance_distance_pct"], 2),
        "rsi": round(indicators["rsi"], 2),
        "atr": round(indicators["atr"], 8),
        "atr_pct": round(indicators["atr_pct"], 2),
        "ema20": round(indicators["ema20"], 8),
        "ema50": round(indicators["ema50"], 8),
        "ema100": round(indicators["ema100"], 8),
        "ma200": round(indicators["ma200"], 8),
        "volume_ratio": round(indicators["volume_ratio"], 2),
        "relative_strength_vs_btc": rs20,
        "event_risk_flag": event_risk_flag,
        "asset_role": item["role"],
        "asset_specific_rule": item["rule"],
        "profile_target_pct": profile["spot_targets"].get(item["asset"], 0),
        "order_budget_multiplier": signal["budget_multiplier"],
        "strategy_mode": signal["mode"],
        "futures_overlay_allowed": item["binance"] in futures_policy["symbols"] and btc_regime["name"] == "bull",
        "stop_loss": round(signal["stop_loss"], 8),
        "take_profit": [round(v, 8) for v in signal["take_profit"]],
        "position": position,
    }


def current_position(exchange: str, instrument: str) -> dict[str, float]:
    config, state = load_runtime()
    key = f"{exchange}:{instrument}"
    position = state.get("portfolio", {}).get("positions", {}).get(key, {})
    quantity = float(position.get("quantity", "0") or 0)
    cost_basis = float(position.get("cost_basis", "0") or 0)
    average_price = cost_basis / quantity if quantity > 0 else 0
    realized = float(position.get("realized_pnl", "0") or 0)
    return {
        "quantity": quantity,
        "cost_basis": cost_basis,
        "average_price": average_price,
        "realized_pnl": realized,
    }


def build_candle_payload(exchange: str, instrument: str, timeframe: str) -> dict[str, Any]:
    timeframe = normalize_timeframe(timeframe)
    candles = safe_fetch_candles(exchange, instrument, timeframe, 220)
    indicators = compute_indicators(candles) if candles else empty_indicators()
    levels = support_resistance(candles, indicators["atr"]) if candles else empty_levels()
    return {
        "exchange": exchange,
        "instrument": instrument,
        "timeframe": timeframe,
        "candles": [c.to_chart() for c in candles],
        "volume": [{"time": c.time, "value": round(c.volume, 8)} for c in candles],
        "lines": {
            "support": levels["support"],
            "resistance": levels["resistance"],
            "ema20": ema_series([c.close for c in candles], 20),
            "ema50": ema_series([c.close for c in candles], 50),
            "ma200": sma_series([c.close for c in candles], 200),
            "stop_loss": max(levels["support"] - indicators["atr"] * 0.5, 0),
            "take_profit": [levels["resistance"], levels["resistance"] + indicators["atr"]],
        },
        "indicators": indicators,
        "levels": levels,
    }


def build_multi_timeframe_payload(exchange: str, instrument: str, timeframes: str) -> dict[str, Any]:
    wanted = [normalize_timeframe(value.strip()) for value in timeframes.split(",") if value.strip()]
    rows = []
    for timeframe in wanted:
        candles = safe_fetch_candles(exchange, instrument, timeframe, 120)
        indicators = compute_indicators(candles) if candles else empty_indicators()
        levels = support_resistance(candles, indicators["atr"]) if candles else empty_levels()
        previous_close = candles[-2].close if len(candles) >= 2 else indicators["close"]
        change = change_pct(previous_close, indicators["close"]) if previous_close else 0
        rows.append(
            {
                "timeframe": timeframe,
                "label": timeframe_label(timeframe),
                "close": round(indicators["close"], 8),
                "change_pct": round(change, 2),
                "rsi": round(indicators["rsi"], 2),
                "volume_ratio": round(indicators["volume_ratio"], 2),
                "atr_pct": round(indicators["atr_pct"], 2),
                "ema20": round(indicators["ema20"], 8),
                "ema50": round(indicators["ema50"], 8),
                "support": round(levels["support"], 8),
                "resistance": round(levels["resistance"], 8),
                "support_distance_pct": round(levels["support_distance_pct"], 2),
                "resistance_distance_pct": round(levels["resistance_distance_pct"], 2),
                **scalp_timeframe_signal(indicators, levels, change),
            }
        )
    alignment_score = sum(row["score"] for row in rows) / max(len(rows), 1)
    return {
        "exchange": exchange,
        "instrument": instrument,
        "timeframes": rows,
        "alignment_score": round(alignment_score, 1),
        "mode": "scalp-watch",
        "note": "1/3/5/15분봉이 동시에 추세 정렬될 때만 단타 후보로 봅니다. 현재는 테스트 보조판입니다.",
    }


def scalp_timeframe_signal(indicators: dict[str, float], levels: dict[str, float], change: float) -> dict[str, Any]:
    close = indicators["close"]
    ema20_value = indicators["ema20"]
    ema50_value = indicators["ema50"]
    rsi_value = indicators["rsi"]
    volume_ratio = indicators["volume_ratio"]
    support_distance = levels["support_distance_pct"]
    resistance_distance = levels["resistance_distance_pct"]
    score = 0
    reasons = []

    if close > ema20_value > ema50_value:
        score += 35
        reasons.append("EMA 정배열")
    elif close > ema20_value:
        score += 18
        reasons.append("단기 반등")
    else:
        reasons.append("추세 미확인")

    if 45 <= rsi_value <= 68:
        score += 20
        reasons.append("RSI 정상")
    elif rsi_value > 72:
        score -= 15
        reasons.append("RSI 과열")
    elif rsi_value < 35:
        score -= 10
        reasons.append("RSI 약세")

    if volume_ratio >= 1.2:
        score += 20
        reasons.append("거래량 증가")
    elif volume_ratio >= 0.8:
        score += 8
        reasons.append("거래량 보통")
    else:
        reasons.append("거래량 부족")

    if support_distance <= 0.45:
        score += 12
        reasons.append("지지 근처")
    if resistance_distance >= 0.45:
        score += 10
        reasons.append("저항 여유")
    if change > 0:
        score += 3

    score = max(0, min(score, 100))
    if score >= 75:
        signal = "long-watch"
        label = "단타 후보"
    elif score >= 55:
        signal = "wait"
        label = "관찰"
    else:
        signal = "avoid"
        label = "대기"

    return {"score": score, "signal": signal, "signal_label": label, "reason": " · ".join(reasons)}


def normalize_timeframe(timeframe: str) -> str:
    return timeframe if timeframe in TIMEFRAMES else "4h"


def timeframe_label(timeframe: str) -> str:
    return {
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
    }.get(timeframe, timeframe)


def handle_paper_order(body: dict[str, Any]) -> dict[str, Any]:
    config, state = load_runtime()
    exchange = str(body.get("exchange", "upbit"))
    instrument = str(body.get("instrument", "KRW-BTC"))
    side = str(body.get("side", "buy")).lower()
    quote_currency = config["exchanges"][exchange]["quote_currency"]
    min_budget = Decimal(str(config["exchanges"][exchange].get("default_min_quote_budget", "0.00000001")))

    if side == "buy":
        order = PlannedOrder(
            exchange=exchange,
            instrument=instrument,
            side="buy",
            quote_currency=quote_currency,
            quote_budget=parse_decimal(body.get("amount", "0"), "amount"),
            base_quantity=None,
            sell_fraction=None,
            min_quote_budget=min_budget,
            source="manual",
        )
    elif side == "sell":
        order = PlannedOrder(
            exchange=exchange,
            instrument=instrument,
            side="sell",
            quote_currency=quote_currency,
            quote_budget=None,
            base_quantity=None,
            sell_fraction=parse_decimal(body.get("fraction", "1"), "fraction"),
            min_quote_budget=min_budget,
            source="manual",
        )
    else:
        return {"ok": False, "error": "side must be buy or sell"}

    now = datetime.now(KST)
    prices = fetch_prices(config, [order], state, HTTP_TIMEOUT)
    simulated = simulate_orders(
        planned_orders=[order],
        prices=prices,
        config=config,
        strategy_name="manual_paper",
        now=now,
        state=state,
        dedupe_per_day=False,
        force=True,
    )
    equity_rows = build_equity_rows(state, config, prices, now)
    output = config["output"]
    write_orders(ROOT / output["trades_csv"], simulated)
    write_equity(ROOT / output["equity_csv"], equity_rows)
    save_state(ROOT / output["state_json"], state)
    return {"ok": True, "orders": [order_row(o) for o in simulated], "equity": equity_rows}


def handle_run_plan() -> dict[str, Any]:
    config, state = load_runtime()
    now = datetime.now(KST)
    lock = read_no_entry_lock(now)
    if lock.get("active"):
        prices = prices_for_portfolio(config, state)
        equity_rows = build_equity_rows(state, config, prices, now)
        output = config["output"]
        write_equity(ROOT / output["equity_csv"], equity_rows)
        save_state(ROOT / output["state_json"], state)
        return {"ok": True, "locked": True, "lock": lock, "orders": [], "equity": equity_rows}

    orders = []
    analyses = strategy_analysis_map()
    for exchange, exchange_config in config.get("exchanges", {}).items():
        if not exchange_config.get("enabled", False):
            continue
        quote_currency = exchange_config["quote_currency"]
        for raw in exchange_config.get("orders", []):
            instrument = raw.get("market") or raw.get("symbol")
            analysis = analyses.get(instrument, {})
            multiplier = Decimal(str(analysis.get("order_budget_multiplier", 1)))
            quote_budget = (Decimal(str(raw["quote_budget"])) * multiplier).quantize(Decimal("0.00000001"))
            orders.append(
                PlannedOrder(
                    exchange=exchange,
                    instrument=instrument,
                    side=raw.get("side", "buy"),
                    quote_currency=quote_currency,
                    quote_budget=quote_budget,
                    base_quantity=None,
                    sell_fraction=None,
                    min_quote_budget=Decimal(str(raw.get("min_quote_budget", "0.00000001"))),
                    source="config",
                )
            )
    prices = fetch_prices(config, orders, state, HTTP_TIMEOUT)
    simulated = simulate_orders(orders, prices, config, "daily_dca", now, state, True, False)
    equity_rows = build_equity_rows(state, config, prices, now)
    output = config["output"]
    write_orders(ROOT / output["trades_csv"], simulated)
    write_equity(ROOT / output["equity_csv"], equity_rows)
    save_state(ROOT / output["state_json"], state)
    return {"ok": True, "orders": [order_row(o) for o in simulated], "equity": equity_rows}


def handle_run_rebound_test() -> dict[str, Any]:
    config, state = load_runtime()
    now = datetime.now(KST)
    settings = config.get("strategy", {}).get("automation", {})
    if not bool(settings.get("bear_rebound_test_enabled", False)):
        return {"ok": True, "enabled": False, "orders": [], "simulated_count": 0, "skipped_count": 0}

    lock = read_no_entry_lock(now)
    lock_reasons = set(lock.get("reasons", []))
    if lock.get("active") and not lock_reasons.issubset({"market_regime_bear"}):
        prices = prices_for_portfolio(config, state)
        equity_rows = build_equity_rows(state, config, prices, now)
        output = config["output"]
        write_equity(ROOT / output["equity_csv"], equity_rows)
        save_state(ROOT / output["state_json"], state)
        return {"ok": True, "locked": True, "lock": lock, "orders": [], "equity": equity_rows}

    supervisor = read_supervisor_status()
    orders, candidates = bear_rebound_orders(config, supervisor)
    if not orders:
        prices = prices_for_portfolio(config, state)
        equity_rows = build_equity_rows(state, config, prices, now)
        output = config["output"]
        write_equity(ROOT / output["equity_csv"], equity_rows)
        save_state(ROOT / output["state_json"], state)
        return {
            "ok": True,
            "locked": False,
            "orders": [],
            "candidates": candidates,
            "simulated_count": 0,
            "skipped_count": 0,
            "equity": equity_rows,
        }

    prices = fetch_prices(config, orders, state, HTTP_TIMEOUT)
    simulated = simulate_orders(
        planned_orders=orders,
        prices=prices,
        config=config,
        strategy_name=str(settings.get("bear_rebound_strategy_name", "bear_rebound_test")),
        now=now,
        state=state,
        dedupe_per_day=True,
        force=False,
    )
    equity_rows = build_equity_rows(state, config, prices, now)
    output = config["output"]
    write_orders(ROOT / output["trades_csv"], simulated)
    write_equity(ROOT / output["equity_csv"], equity_rows)
    save_state(ROOT / output["state_json"], state)
    return {
        "ok": True,
        "locked": False,
        "orders": [order_row(o) for o in simulated],
        "candidates": candidates,
        "simulated_count": len([order for order in simulated if order.status == "simulated"]),
        "skipped_count": len([order for order in simulated if order.status == "skipped"]),
        "equity": equity_rows,
    }


def handle_run_chart_trade_test() -> dict[str, Any]:
    config, state = load_runtime()
    now = datetime.now(KST)
    settings = config.get("strategy", {}).get("automation", {})
    if not bool(settings.get("chart_trade_test_enabled", False)):
        return {"ok": True, "enabled": False, "orders": [], "simulated_count": 0, "skipped_count": 0}

    supervisor = read_supervisor_status()
    lock = read_no_entry_lock(now)
    lock_reasons = list(lock.get("reasons", [])) if lock.get("active") else []
    block_new_entries = bool(lock_reasons) or supervisor.get("severity") == "CRIT"

    prices = prices_for_portfolio(config, state)
    sell_orders, exit_decisions = chart_exit_orders(config, state, supervisor, prices)
    buy_orders, entry_candidates = chart_entry_orders(
        config=config,
        state=state,
        supervisor=supervisor,
        prices=prices,
        now=now,
        block_new_entries=block_new_entries,
        block_reason=";".join(lock_reasons) if lock_reasons else str(supervisor.get("severity", "")),
    )
    orders = sell_orders + buy_orders

    if not orders:
        equity_rows = build_equity_rows(state, config, prices, now)
        output = config["output"]
        write_equity(ROOT / output["equity_csv"], equity_rows)
        save_state(ROOT / output["state_json"], state)
        return {
            "ok": True,
            "enabled": True,
            "locked": block_new_entries,
            "lock": lock if block_new_entries else {"active": False},
            "orders": [],
            "entry_candidates": entry_candidates,
            "exit_decisions": exit_decisions,
            "simulated_count": 0,
            "buy_simulated_count": 0,
            "sell_simulated_count": 0,
            "skipped_count": 0,
            "equity": equity_rows,
        }

    simulated = simulate_orders(
        planned_orders=orders,
        prices=prices,
        config=config,
        strategy_name=str(settings.get("chart_trade_strategy_name", "chart_aggressive_test")),
        now=now,
        state=state,
        dedupe_per_day=False,
        force=True,
    )
    remember_chart_buys(state, simulated, now)
    equity_rows = build_equity_rows(state, config, prices, now)
    output = config["output"]
    write_orders(ROOT / output["trades_csv"], simulated)
    write_equity(ROOT / output["equity_csv"], equity_rows)
    save_state(ROOT / output["state_json"], state)
    return {
        "ok": True,
        "enabled": True,
        "locked": block_new_entries,
        "lock": lock if block_new_entries else {"active": False},
        "orders": [order_row(order) for order in simulated],
        "entry_candidates": entry_candidates,
        "exit_decisions": exit_decisions,
        "simulated_count": len([order for order in simulated if order.status == "simulated"]),
        "buy_simulated_count": len(
            [order for order in simulated if order.status == "simulated" and order.side == "buy"]
        ),
        "sell_simulated_count": len(
            [order for order in simulated if order.status == "simulated" and order.side == "sell"]
        ),
        "skipped_count": len([order for order in simulated if order.status == "skipped"]),
        "equity": equity_rows,
    }


def chart_entry_orders(
    config: dict[str, Any],
    state: dict[str, Any],
    supervisor: dict[str, Any],
    prices: dict[tuple[str, str], Decimal],
    now: datetime,
    block_new_entries: bool,
    block_reason: str,
) -> tuple[list[PlannedOrder], list[dict[str, Any]]]:
    settings = config.get("strategy", {}).get("automation", {})
    upbit_config = config.get("exchanges", {}).get("upbit", {})
    if not upbit_config.get("enabled", False):
        return [], [{"asset": "SYSTEM", "ok": False, "reason": "upbit_disabled"}]

    quote_currency = str(upbit_config.get("quote_currency", "KRW"))
    min_budget = Decimal(str(upbit_config.get("default_min_quote_budget", "5000")))
    raw_budget = Decimal(str(settings.get("chart_trade_buy_budget_krw", "100000")))
    max_candidates = int(settings.get("chart_trade_max_candidates", 4))
    asset_cap = Decimal(str(settings.get("chart_trade_asset_cap_krw", "250000")))
    cash_reserve = Decimal(str(settings.get("chart_trade_cash_reserve_krw", "200000")))
    reentry_cooldown = int(settings.get("chart_trade_reentry_cooldown_minutes", 15))
    support_threshold = as_number(settings.get("chart_trade_entry_support_distance_pct", 1.2))
    min_score = as_number(settings.get("chart_trade_entry_min_score", 45))
    min_room = as_number(settings.get("chart_trade_entry_min_resistance_room_pct", 0.2))
    fee_rate = Decimal(str(config.get("portfolio", {}).get("fee_rate", {}).get("upbit", "0")))

    cash = Decimal(str(state.get("portfolio", {}).get("cash", {}).get("upbit:KRW", "0")))
    remaining_cash = max(cash - cash_reserve, Decimal("0"))
    asset_index = {asset["asset"]: asset for asset in ASSETS}
    candidates: list[dict[str, Any]] = []

    if block_new_entries:
        return [], [{"asset": "SYSTEM", "ok": False, "reason": f"entry_blocked:{block_reason}"}]

    for payload in supervisor.get("assets", []):
        asset_name = str(payload.get("asset", ""))
        asset = asset_index.get(asset_name)
        if not asset:
            continue
        rows = list(payload.get("timeframes", []))
        short_rows = [row for row in rows if row.get("timeframe") in {"5m", "15m"}]
        mid_rows = [row for row in rows if row.get("timeframe") in {"1h", "4h"}]
        short_mid_rows = short_rows + mid_rows
        support_touch = any(
            -1.0 <= as_number(row.get("support_distance_pct")) <= support_threshold for row in short_mid_rows
        )
        rebound = any(
            row.get("trend") == "up" and as_number(row.get("score")) >= min_score for row in short_rows + mid_rows[:1]
        )
        breakout = any(
            row.get("trend") == "up"
            and as_number(row.get("score")) >= min_score + 15
            and as_number(row.get("resistance_distance_pct")) >= min_room
            for row in short_mid_rows
        )
        overheated = any(as_number(row.get("rsi")) >= 80 for row in short_rows + mid_rows[:1])
        resistance_room = max((as_number(row.get("resistance_distance_pct")) for row in short_mid_rows), default=0)
        position_key = f"upbit:{asset['upbit']}"
        position = state.get("portfolio", {}).get("positions", {}).get(position_key, {})
        quantity = Decimal(str(position.get("quantity", "0")))
        price = prices.get(("upbit", asset["upbit"]), Decimal("0"))
        position_value = quantity * price
        cap_room = max(asset_cap - position_value, Decimal("0"))
        cooldown_active = chart_buy_cooldown_active(state, str(asset["upbit"]), now, reentry_cooldown)
        ok = (support_touch and rebound or breakout) and not overheated and resistance_room >= min_room
        reason = "support_rebound" if support_touch and rebound else "breakout" if breakout else "no_edge"
        if cooldown_active:
            ok = False
            reason = "cooldown"
        if cap_room < min_budget:
            ok = False
            reason = "asset_cap_reached"
        candidates.append(
            {
                "asset": asset_name,
                "instrument": asset["upbit"],
                "ok": ok,
                "reason": reason,
                "support_touch": support_touch,
                "rebound": rebound,
                "breakout": breakout,
                "overheated": overheated,
                "resistance_room_pct": round(resistance_room, 2),
                "position_value": float(position_value),
                "cap_room": float(cap_room),
                "alignment_score": payload.get("alignment_score", 0),
            }
        )

    selected = [candidate for candidate in candidates if candidate["ok"]]
    selected.sort(key=lambda candidate: (-as_number(candidate["alignment_score"]), -as_number(candidate["resistance_room_pct"])))
    orders: list[PlannedOrder] = []
    for candidate in selected[:max_candidates]:
        if remaining_cash < min_budget:
            break
        budget = min(raw_budget, Decimal(str(candidate["cap_room"])), remaining_cash)
        if budget < min_budget:
            continue
        orders.append(
            PlannedOrder(
                exchange="upbit",
                instrument=str(candidate["instrument"]),
                side="buy",
                quote_currency=quote_currency,
                quote_budget=budget.quantize(Decimal("0.00000001")),
                base_quantity=None,
                sell_fraction=None,
                min_quote_budget=min_budget,
                source="config",
            )
        )
        remaining_cash -= budget * (Decimal("1") + fee_rate)
    return orders, candidates


def chart_exit_orders(
    config: dict[str, Any],
    state: dict[str, Any],
    supervisor: dict[str, Any],
    prices: dict[tuple[str, str], Decimal],
) -> tuple[list[PlannedOrder], list[dict[str, Any]]]:
    settings = config.get("strategy", {}).get("automation", {})
    upbit_config = config.get("exchanges", {}).get("upbit", {})
    quote_currency = str(upbit_config.get("quote_currency", "KRW"))
    min_budget = Decimal(str(upbit_config.get("default_min_quote_budget", "5000")))
    fee_rate = Decimal(str(config.get("portfolio", {}).get("fee_rate", {}).get("upbit", "0")))
    slippage = Decimal(str(config.get("portfolio", {}).get("slippage_pct", {}).get("upbit", "0")))
    take_profit_pct = Decimal(str(settings.get("chart_trade_take_profit_pct", "0.45")))
    runner_take_profit_pct = Decimal(str(settings.get("chart_trade_runner_take_profit_pct", "1.2")))
    stop_loss_pct = Decimal(str(settings.get("chart_trade_stop_loss_pct", "-1.0")))
    hard_stop_loss_pct = Decimal(str(settings.get("chart_trade_hard_stop_loss_pct", "-2.0")))
    partial_fraction = Decimal(str(settings.get("chart_trade_partial_sell_fraction", "0.5")))
    asset_rows = {str(payload.get("asset", "")): list(payload.get("timeframes", [])) for payload in supervisor.get("assets", [])}
    asset_index = {asset["upbit"]: asset for asset in ASSETS}
    orders: list[PlannedOrder] = []
    decisions: list[dict[str, Any]] = []

    for position_key, raw_position in state.get("portfolio", {}).get("positions", {}).items():
        exchange, instrument = position_key.split(":", 1)
        if exchange != "upbit":
            continue
        asset = asset_index.get(instrument)
        if not asset:
            continue
        quantity = Decimal(str(raw_position.get("quantity", "0")))
        cost_basis = Decimal(str(raw_position.get("cost_basis", "0")))
        price = prices.get((exchange, instrument), Decimal("0"))
        if quantity <= 0 or cost_basis <= 0 or price <= 0:
            continue
        average_cost = cost_basis / quantity
        net_exit_price = price * (Decimal("1") - slippage) * (Decimal("1") - fee_rate)
        pnl_pct = ((net_exit_price - average_cost) / average_cost * Decimal("100")).quantize(Decimal("0.01"))
        rows = asset_rows.get(asset["asset"], [])
        short_rows = [row for row in rows if row.get("timeframe") in {"5m", "15m"}]
        mid_rows = [row for row in rows if row.get("timeframe") in {"1h", "4h"}]
        near_resistance = any(as_number(row.get("resistance_distance_pct")) <= 0.35 for row in short_rows + mid_rows[:1])
        short_down = bool(short_rows) and all(row.get("trend") == "down" or as_number(row.get("score")) <= 25 for row in short_rows)
        support_lost = any(
            as_number(row.get("support_distance_pct")) < -0.4 and row.get("trend") == "down"
            for row in short_rows + mid_rows[:1]
        )

        fraction: Decimal | None = None
        reason = "hold"
        if pnl_pct >= runner_take_profit_pct:
            fraction = partial_fraction
            reason = "runner_take_profit"
        elif pnl_pct >= take_profit_pct and (near_resistance or short_down):
            fraction = partial_fraction
            reason = "take_profit_into_resistance"
        elif pnl_pct >= take_profit_pct:
            fraction = min(partial_fraction, Decimal("0.33"))
            reason = "partial_take_profit"
        elif pnl_pct <= hard_stop_loss_pct:
            fraction = Decimal("1")
            reason = "hard_stop"
        elif pnl_pct <= stop_loss_pct and (short_down or support_lost):
            fraction = partial_fraction
            reason = "risk_cut"
        elif support_lost and pnl_pct < 0:
            fraction = partial_fraction
            reason = "support_lost"

        sell_value = price * quantity * (fraction or Decimal("0"))
        ok = fraction is not None and sell_value >= min_budget
        decisions.append(
            {
                "asset": asset["asset"],
                "instrument": instrument,
                "ok": ok,
                "reason": reason,
                "pnl_pct": float(pnl_pct),
                "near_resistance": near_resistance,
                "short_down": short_down,
                "support_lost": support_lost,
                "sell_fraction": float(fraction or Decimal("0")),
                "estimated_sell_value": float(sell_value),
            }
        )
        if not ok:
            continue
        orders.append(
            PlannedOrder(
                exchange="upbit",
                instrument=instrument,
                side="sell",
                quote_currency=quote_currency,
                quote_budget=None,
                base_quantity=None,
                sell_fraction=fraction,
                min_quote_budget=min_budget,
                source="config",
            )
        )
    return orders, decisions


def chart_buy_cooldown_active(state: dict[str, Any], instrument: str, now: datetime, minutes: int) -> bool:
    raw = state.get("chart_trade", {}).get("last_buy_at", {}).get(instrument, "")
    if not raw:
        return False
    try:
        last_buy = datetime.fromisoformat(raw)
    except ValueError:
        return False
    return now - last_buy < timedelta(minutes=minutes)


def remember_chart_buys(state: dict[str, Any], simulated: list[Any], now: datetime) -> None:
    chart_state = state.setdefault("chart_trade", {})
    last_buy = chart_state.setdefault("last_buy_at", {})
    for order in simulated:
        if order.status == "simulated" and order.side == "buy":
            last_buy[order.instrument] = now.isoformat(timespec="seconds")


def read_supervisor_status() -> dict[str, Any]:
    path = ROOT / "data" / "codex_supervisor_status.json"
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}


def bear_rebound_orders(config: dict[str, Any], supervisor: dict[str, Any]) -> tuple[list[PlannedOrder], list[dict[str, Any]]]:
    settings = config.get("strategy", {}).get("automation", {})
    if supervisor.get("severity") == "CRIT":
        return [], [{"asset": "SYSTEM", "ok": False, "reason": "supervisor_critical"}]

    regime = str(supervisor.get("market_regime", {}).get("name", "unknown"))
    if regime not in {"bear", "neutral"}:
        return [], [{"asset": "SYSTEM", "ok": False, "reason": f"unsupported_regime_{regime}"}]

    upbit_config = config.get("exchanges", {}).get("upbit", {})
    if not upbit_config.get("enabled", False):
        return [], [{"asset": "SYSTEM", "ok": False, "reason": "upbit_disabled"}]

    quote_currency = str(upbit_config.get("quote_currency", "KRW"))
    min_budget = Decimal(str(upbit_config.get("default_min_quote_budget", "5000")))
    raw_budget = Decimal(str(settings.get("bear_rebound_budget_krw", "5000")))
    quote_budget = max(raw_budget, min_budget)
    max_candidates = int(settings.get("bear_rebound_max_candidates", 4))
    asset_index = {asset["asset"]: asset for asset in ASSETS}
    candidates: list[dict[str, Any]] = []

    for payload in supervisor.get("assets", []):
        asset_name = str(payload.get("asset", ""))
        asset = asset_index.get(asset_name)
        if not asset:
            continue
        rows = list(payload.get("timeframes", []))
        short_rows = [row for row in rows if row.get("timeframe") in {"5m", "15m"}]
        rebound_rows = [row for row in rows if row.get("timeframe") in {"15m", "1h"}]
        mid_rows = [row for row in rows if row.get("timeframe") in {"1h", "4h"}]
        support_touch = any(as_number(row.get("support_distance_pct")) <= 0.8 for row in short_rows + mid_rows)
        rebound = any(row.get("trend") == "up" and as_number(row.get("score")) >= 55 for row in rebound_rows)
        overheated = any(bool(row.get("overheated")) for row in short_rows + rebound_rows)
        resistance_room = max((as_number(row.get("resistance_distance_pct")) for row in short_rows + rebound_rows), default=0)
        ok = support_touch and rebound and not overheated and resistance_room >= 0.2
        candidates.append(
            {
                "asset": asset_name,
                "instrument": asset["upbit"],
                "ok": ok,
                "support_touch": support_touch,
                "rebound": rebound,
                "overheated": overheated,
                "resistance_room_pct": round(resistance_room, 2),
                "alignment_score": payload.get("alignment_score", 0),
            }
        )

    selected = [candidate for candidate in candidates if candidate["ok"]]
    selected.sort(key=lambda candidate: (-as_number(candidate["alignment_score"]), -as_number(candidate["resistance_room_pct"])))
    orders = [
        PlannedOrder(
            exchange="upbit",
            instrument=str(candidate["instrument"]),
            side="buy",
            quote_currency=quote_currency,
            quote_budget=quote_budget,
            base_quantity=None,
            sell_fraction=None,
            min_quote_budget=min_budget,
            source="config",
        )
        for candidate in selected[:max_candidates]
    ]
    return orders, candidates


def as_number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def read_no_entry_lock(now: datetime) -> dict[str, Any]:
    path = ROOT / "data" / "no_entry_lock.json"
    if not path.exists():
        return {"active": False}
    try:
        with path.open("r", encoding="utf-8") as handle:
            lock = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {"active": False}

    if not bool(lock.get("active")):
        return {"active": False}
    expires_at = str(lock.get("expires_at", ""))
    if expires_at:
        try:
            expires = datetime.fromisoformat(expires_at)
        except ValueError:
            return {"active": False}
        if expires <= now:
            return {"active": False}
    return lock


def strategy_analysis_map() -> dict[str, dict[str, Any]]:
    config, _state = load_runtime()
    btc_daily = safe_fetch_candles("upbit", "KRW-BTC", "1d", 220)
    btc_regime = detect_market_regime(btc_daily)
    usdt_krw = fetch_usdt_krw_rate()
    analyses: dict[str, dict[str, Any]] = {}
    for item in ASSETS:
        analysis = analyze_asset(item, btc_regime, usdt_krw, config)
        analyses[item["upbit"]] = analysis
        analyses[item["binance"]] = analysis
    return analyses


def order_row(order: Any) -> dict[str, Any]:
    return {
        "timestamp": order.timestamp,
        "exchange": order.exchange,
        "instrument": order.instrument,
        "side": order.side,
        "value": float(order.executed_quote_value),
        "price": float(order.effective_price),
        "quantity": float(order.base_quantity),
        "status": order.status,
        "note": order.note,
    }


def prices_for_portfolio(config: dict[str, Any], state: dict[str, Any]) -> dict[tuple[str, str], Decimal]:
    pseudo_orders = []
    for item in ASSETS:
        for exchange in ("upbit", "binance"):
            pseudo_orders.append(
                PlannedOrder(
                    exchange=exchange,
                    instrument=item[exchange],
                    side="buy",
                    quote_currency=config["exchanges"][exchange]["quote_currency"],
                    quote_budget=Decimal("1"),
                    base_quantity=None,
                    sell_fraction=None,
                    min_quote_budget=Decimal("0.00000001"),
                    source="manual",
                )
            )
    for key in state.get("portfolio", {}).get("positions", {}):
        exchange, instrument = key.split(":", 1)
        if exchange not in config.get("exchanges", {}):
            continue
        pseudo_orders.append(
            PlannedOrder(
                exchange=exchange,
                instrument=instrument,
                side="buy",
                quote_currency=config["exchanges"][exchange]["quote_currency"],
                quote_budget=Decimal("1"),
                base_quantity=None,
                sell_fraction=None,
                min_quote_budget=Decimal("0.00000001"),
                source="manual",
            )
        )
    return fetch_prices(config, pseudo_orders, state, HTTP_TIMEOUT)


def portfolio_payload(
    state: dict[str, Any],
    prices: dict[tuple[str, str], Decimal],
    equity_rows: list[dict[str, str]],
) -> dict[str, Any]:
    positions = []
    for key, raw in state.get("portfolio", {}).get("positions", {}).items():
        exchange, instrument = key.split(":", 1)
        quantity = float(raw.get("quantity", 0))
        if quantity <= 0:
            continue
        price = float(prices.get((exchange, instrument), Decimal("0")))
        cost = float(raw.get("cost_basis", 0))
        value = quantity * price
        positions.append(
            {
                "exchange": exchange,
                "instrument": instrument,
                "quantity": quantity,
                "cost_basis": cost,
                "average_price": cost / quantity if quantity else 0,
                "current_price": price,
                "value": value,
                "unrealized_pnl": value - cost,
                "realized_pnl": float(raw.get("realized_pnl", 0)),
            }
        )
    return {
        "cash": state.get("portfolio", {}).get("cash", {}),
        "positions": positions,
        "equity": equity_rows,
    }


def performance_payload(
    config: dict[str, Any],
    current_equity_rows: list[dict[str, str]],
    usdt_krw: float,
    now: datetime,
) -> dict[str, Any]:
    settings = config.get("strategy", {}).get("performance", {})
    history = read_equity_points(config, usdt_krw)
    current_point = equity_point_from_rows(now, current_equity_rows, usdt_krw)
    if not history or history[-1]["timestamp"] != current_point["timestamp"]:
        history.append(current_point)
    history.sort(key=lambda point: point["dt"])

    starting = starting_equity_point(config, usdt_krw, history[0]["dt"] if history else now)
    current = current_point
    total_pnl = current["total_krw"] - starting["total_krw"]
    total_return = (total_pnl / starting["total_krw"] * 100) if starting["total_krw"] else 0
    periods = build_period_returns(history, current, starting, settings.get("periods", ["1h", "4h", "24h", "7d", "all"]))
    hourly = build_hourly_returns(history, current, starting, int(settings.get("hourly_window_hours", 24)))
    return {
        "updated_at": now.isoformat(timespec="seconds"),
        "currency": "KRW",
        "conversion_note": "Binance book은 현재 USDT/KRW(업비트) 기준 KRW 추정값으로 합산합니다.",
        "usdt_krw": round(usdt_krw, 2),
        "snapshot_count": len(history),
        "total": {
            "starting_equity_krw": round(starting["total_krw"], 2),
            "current_equity_krw": round(current["total_krw"], 2),
            "pnl_krw": round(total_pnl, 2),
            "return_pct": round(total_return, 2),
        },
        "books": book_performance_rows(config, current_equity_rows, usdt_krw),
        "periods": periods,
        "hourly": hourly,
    }


def maybe_write_equity_snapshot(config: dict[str, Any], equity_rows: list[dict[str, str]], now: datetime) -> None:
    settings = config.get("strategy", {}).get("performance", {})
    interval = int(settings.get("snapshot_interval_minutes", 15))
    if interval <= 0:
        return
    path = ROOT / config["output"]["equity_csv"]
    last_time = last_equity_timestamp(path)
    if last_time is None or now - last_time >= timedelta(minutes=interval):
        write_equity(path, equity_rows)


def last_equity_timestamp(path: Path) -> datetime | None:
    if not path.exists():
        return None
    last_value = ""
    with path.open("r", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if row.get("timestamp"):
                last_value = row["timestamp"]
    return parse_timestamp(last_value) if last_value else None


def read_equity_points(config: dict[str, Any], usdt_krw: float) -> list[dict[str, Any]]:
    path = ROOT / config["output"]["equity_csv"]
    if not path.exists():
        return []
    grouped: dict[str, dict[str, Any]] = {}
    with path.open("r", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            timestamp = row.get("timestamp", "")
            if not timestamp:
                continue
            point = grouped.setdefault(
                timestamp,
                {
                    "timestamp": timestamp,
                    "dt": parse_timestamp(timestamp),
                    "total_krw": 0.0,
                    "books": {},
                },
            )
            exchange = row.get("exchange", "")
            quote = row.get("quote_currency", "")
            total = safe_float(row.get("total_equity"))
            point["books"][exchange] = {"quote_currency": quote, "total_equity": total}
            point["total_krw"] += native_to_krw(total, quote, usdt_krw)
    return sorted(grouped.values(), key=lambda point: point["dt"])


def equity_point_from_rows(now: datetime, rows: list[dict[str, str]], usdt_krw: float) -> dict[str, Any]:
    point = {"timestamp": now.isoformat(timespec="seconds"), "dt": now, "total_krw": 0.0, "books": {}}
    for row in rows:
        exchange = row["exchange"]
        quote = row["quote_currency"]
        total = safe_float(row["total_equity"])
        point["books"][exchange] = {"quote_currency": quote, "total_equity": total}
        point["total_krw"] += native_to_krw(total, quote, usdt_krw)
    return point


def starting_equity_point(config: dict[str, Any], usdt_krw: float, timestamp: datetime) -> dict[str, Any]:
    starting_cash = config.get("portfolio", {}).get("starting_cash", {})
    point = {"timestamp": timestamp.isoformat(timespec="seconds"), "dt": timestamp, "total_krw": 0.0, "books": {}}
    for key, value in starting_cash.items():
        exchange, quote = key.split(":", 1)
        total = safe_float(value)
        point["books"][exchange] = {"quote_currency": quote, "total_equity": total}
        point["total_krw"] += native_to_krw(total, quote, usdt_krw)
    return point


def build_period_returns(
    history: list[dict[str, Any]],
    current: dict[str, Any],
    starting: dict[str, Any],
    periods: list[str],
) -> list[dict[str, Any]]:
    definitions = {
        "1h": ("1시간", timedelta(hours=1)),
        "4h": ("4시간", timedelta(hours=4)),
        "24h": ("24시간", timedelta(hours=24)),
        "7d": ("7일", timedelta(days=7)),
        "all": ("전체", None),
    }
    rows = []
    for period in periods:
        label, delta = definitions.get(period, (period, None))
        if delta is None:
            base = starting
            basis = "시작 잔고"
        else:
            base = latest_point_at_or_before(history, current["dt"] - delta) or (history[0] if history else starting)
            basis = "스냅샷"
        pnl = current["total_krw"] - base["total_krw"]
        return_pct = (pnl / base["total_krw"] * 100) if base["total_krw"] else 0
        rows.append(
            {
                "period": period,
                "label": label,
                "base_time": base["timestamp"],
                "basis": basis,
                "pnl_krw": round(pnl, 2),
                "return_pct": round(return_pct, 2),
            }
        )
    return rows


def build_hourly_returns(
    history: list[dict[str, Any]],
    current: dict[str, Any],
    starting: dict[str, Any],
    hours: int,
) -> list[dict[str, Any]]:
    if hours <= 0:
        return []
    points = sorted(history, key=lambda point: point["dt"])
    rows = []
    current_hour = current["dt"].replace(minute=0, second=0, microsecond=0)
    start_hour = current_hour - timedelta(hours=hours - 1)
    for index in range(hours):
        hour_start = start_hour + timedelta(hours=index)
        hour_end = hour_start + timedelta(hours=1)
        before = latest_point_at_or_before(points, hour_start) or starting
        after = latest_point_at_or_before(points, min(hour_end, current["dt"])) or before
        count = sum(1 for point in points if hour_start <= point["dt"] < hour_end)
        pnl = after["total_krw"] - before["total_krw"]
        return_pct = (pnl / before["total_krw"] * 100) if before["total_krw"] else 0
        rows.append(
            {
                "hour": hour_start.strftime("%m-%d %H:00"),
                "pnl_krw": round(pnl, 2),
                "return_pct": round(return_pct, 3),
                "snapshot_count": count,
            }
        )
    return rows[::-1]


def book_performance_rows(config: dict[str, Any], rows: list[dict[str, str]], usdt_krw: float) -> list[dict[str, Any]]:
    starting_cash = config.get("portfolio", {}).get("starting_cash", {})
    output = []
    for row in rows:
        exchange = row["exchange"]
        quote = row["quote_currency"]
        start = safe_float(starting_cash.get(f"{exchange}:{quote}", "0"))
        current = safe_float(row["total_equity"])
        pnl = current - start
        return_pct = (pnl / start * 100) if start else 0
        output.append(
            {
                "exchange": exchange,
                "quote_currency": quote,
                "starting_equity": round(start, 8),
                "current_equity": round(current, 8),
                "pnl": round(pnl, 8),
                "return_pct": round(return_pct, 3),
                "current_equity_krw": round(native_to_krw(current, quote, usdt_krw), 2),
            }
        )
    return output


def latest_point_at_or_before(points: list[dict[str, Any]], target: datetime) -> dict[str, Any] | None:
    candidate = None
    for point in points:
        if point["dt"] <= target:
            candidate = point
        else:
            break
    return candidate


def native_to_krw(value: float, quote_currency: str, usdt_krw: float) -> float:
    if quote_currency == "KRW":
        return value
    if quote_currency in ("USDT", "USD"):
        return value * usdt_krw
    return value


def parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=KST)


def safe_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def risk_payload(config: dict[str, Any], equity_rows: list[dict[str, str]]) -> dict[str, Any]:
    strategy = config.get("strategy", {})
    risk_limits = {**DEFAULT_RISK_LIMITS, **strategy.get("risk_limits", {})}
    futures = {**DEFAULT_FUTURES_OVERLAY, **strategy.get("futures_overlay", {})}
    return {
        "daily_loss_limit_pct": risk_limits["daily_loss_limit_pct"],
        "weekly_loss_limit_pct": risk_limits["rolling_7d_loss_limit_pct"],
        "attack_sleeve_abs_cap_pct": risk_limits["attack_sleeve_abs_cap_pct"],
        "risk_budget_core_add_pct": risk_limits["risk_budget_core_add_pct"],
        "risk_budget_attack_entry_pct": risk_limits["risk_budget_attack_entry_pct"],
        "futures_enabled": bool(futures["enabled"]),
        "futures_policy": f"{', '.join(futures['symbols'])} only, {futures['margin_type']}, max {futures['max_leverage']}x after test/demo",
        "futures_collateral_cap_pct": futures["collateral_cap_pct"],
        "futures_collateral_abs_cap_pct": futures.get("collateral_abs_cap_pct", 8),
        "futures_notional_cap_pct": futures["gross_notional_cap_pct"],
        "futures_notional_abs_cap_pct": futures.get("gross_notional_abs_cap_pct", 12),
        "liquidation_warn_distance_pct": futures.get("liquidation_warn_distance_pct", 15),
        "liquidation_flat_distance_pct": futures.get("liquidation_flat_distance_pct", 10),
        "live_trading_locked": risk_limits["live_trading_locked"],
        "auto_withdrawals": risk_limits["auto_withdrawals"],
        "data_status": "fresh",
        "kill_switch": "locked",
        "equity_rows": equity_rows,
    }


def read_recent_trades(config: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    path = ROOT / config["output"]["trades_csv"]
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    return rows[-limit:][::-1]


def safe_fetch_candles(exchange: str, instrument: str, timeframe: str, limit: int) -> list[Candle]:
    try:
        if exchange == "upbit":
            return fetch_upbit_candles(instrument, timeframe, limit)
        if exchange == "binance":
            return fetch_binance_candles(instrument, timeframe, limit)
        if exchange == "binance_futures":
            return fetch_binance_futures_candles(instrument, timeframe, limit)
    except (HTTPError, URLError, TimeoutError, ValueError, KeyError, json.JSONDecodeError):
        return []
    return []


def fetch_upbit_candles(market: str, timeframe: str, limit: int) -> list[Candle]:
    config = TIMEFRAMES[normalize_timeframe(timeframe)]
    kind = config["upbit_kind"]
    if kind == "minutes":
        url = f"https://api.upbit.com/v1/candles/minutes/{config['upbit_unit']}"
    else:
        url = f"https://api.upbit.com/v1/candles/{kind}"
    params = {"market": market, "count": str(min(limit, 200))}
    payload = http_get_json(url, params)
    candles = []
    for row in reversed(payload):
        dt = datetime.fromisoformat(row["candle_date_time_utc"]).replace(tzinfo=ZoneInfo("UTC"))
        candles.append(
            Candle(
                time=int(dt.timestamp()),
                open=float(row["opening_price"]),
                high=float(row["high_price"]),
                low=float(row["low_price"]),
                close=float(row["trade_price"]),
                volume=float(row["candle_acc_trade_volume"]),
            )
        )
    return candles


def fetch_binance_candles(symbol: str, timeframe: str, limit: int) -> list[Candle]:
    interval = TIMEFRAMES[normalize_timeframe(timeframe)]["binance"]
    url = "https://data-api.binance.vision/api/v3/klines"
    payload = http_get_json(url, {"symbol": symbol, "interval": interval, "limit": str(min(limit, 1000))})
    return parse_binance_klines(payload)


def fetch_binance_futures_candles(symbol: str, timeframe: str, limit: int) -> list[Candle]:
    interval = TIMEFRAMES[normalize_timeframe(timeframe)]["binance"]
    url = "https://fapi.binance.com/fapi/v1/klines"
    payload = http_get_json(url, {"symbol": symbol, "interval": interval, "limit": str(min(limit, 1000))})
    return parse_binance_klines(payload)


def parse_binance_klines(payload: Any) -> list[Candle]:
    candles = []
    now_ms = int(datetime.now().timestamp() * 1000)
    for row in payload:
        if int(row[6]) > now_ms:
            continue
        candles.append(
            Candle(
                time=int(int(row[0]) / 1000),
                open=float(row[1]),
                high=float(row[2]),
                low=float(row[3]),
                close=float(row[4]),
                volume=float(row[5]),
            )
        )
    return candles


def http_get_json(url: str, params: dict[str, str]) -> Any:
    request = Request(
        f"{url}?{urlencode(params)}",
        headers={"accept": "application/json", "user-agent": "paper-dashboard/0.1"},
    )
    with urlopen(request, timeout=HTTP_TIMEOUT) as response:
        return json.loads(response.read().decode(response.headers.get_content_charset() or "utf-8"))


def fetch_usdt_krw_rate() -> float:
    try:
        payload = http_get_json("https://api.upbit.com/v1/ticker", {"markets": "KRW-USDT"})
        if isinstance(payload, list) and payload:
            return float(payload[0]["trade_price"])
    except (HTTPError, URLError, TimeoutError, ValueError, KeyError, json.JSONDecodeError):
        pass
    return 0.0


def fetch_usd_krw_reference_rate() -> dict[str, Any]:
    try:
        payload = http_get_json(
            "https://api.frankfurter.dev/v2/rate/USD/KRW",
            {"providers": "ECB"},
        )
        if isinstance(payload, dict):
            return {
                "rate": float(payload["rate"]),
                "date": str(payload.get("date", "")),
                "source": "frankfurter_ecb_reference",
            }
    except (HTTPError, URLError, TimeoutError, ValueError, KeyError, json.JSONDecodeError):
        pass
    return {"rate": 0.0, "date": "", "source": "unavailable"}


def fetch_binance_ticker_price(symbol: str) -> float:
    try:
        payload = http_get_json(
            "https://data-api.binance.vision/api/v3/ticker/price",
            {"symbol": symbol},
        )
        return float(payload["price"])
    except (HTTPError, URLError, TimeoutError, ValueError, KeyError, json.JSONDecodeError):
        candles = safe_fetch_candles("binance", symbol, "4h", 2)
        return candles[-1].close if candles else 0.0


def fetch_binance_futures_ticker_price(symbol: str) -> float:
    try:
        payload = http_get_json(
            "https://fapi.binance.com/fapi/v1/ticker/price",
            {"symbol": symbol},
        )
        return float(payload["price"])
    except (HTTPError, URLError, TimeoutError, ValueError, KeyError, json.JSONDecodeError):
        candles = safe_fetch_candles("binance_futures", symbol, "4h", 2)
        return candles[-1].close if candles else 0.0


def kimchi_premium(upbit_krw_price: float, binance_usdt_price: float, usdt_krw: float) -> float:
    overseas_krw = binance_usdt_price * usdt_krw
    if overseas_krw <= 0:
        return 0.0
    return (upbit_krw_price / overseas_krw - 1) * 100


def compute_indicators(candles: list[Candle]) -> dict[str, float]:
    closes = [c.close for c in candles]
    highs = [c.high for c in candles]
    lows = [c.low for c in candles]
    volumes = [c.volume for c in candles]
    close = closes[-1]
    atr_value = atr(highs, lows, closes, 14)
    volume_average = sum(volumes[-21:-1]) / max(len(volumes[-21:-1]), 1)
    return {
        "close": close,
        "ema20": ema(closes, 20),
        "ema50": ema(closes, 50),
        "ema100": ema(closes, 100),
        "sma50": sma(closes, 50),
        "sma200": sma(closes, 200),
        "ma200": sma(closes, 200),
        "rsi": rsi(closes, 14),
        "atr": atr_value,
        "atr_pct": atr_value / close * 100 if close else 0,
        "volume_ratio": volumes[-1] / volume_average if volume_average else 0,
    }


def empty_indicators() -> dict[str, float]:
    return {
        "close": 0,
        "ema20": 0,
        "ema50": 0,
        "ema100": 0,
        "sma50": 0,
        "sma200": 0,
        "ma200": 0,
        "rsi": 0,
        "atr": 0,
        "atr_pct": 0,
        "volume_ratio": 0,
    }


def sma(values: list[float], period: int) -> float:
    if not values:
        return 0
    sample = values[-period:] if len(values) >= period else values
    return sum(sample) / len(sample)


def ema(values: list[float], period: int) -> float:
    if not values:
        return 0
    alpha = 2 / (period + 1)
    result = values[0]
    for value in values[1:]:
        result = value * alpha + result * (1 - alpha)
    return result


def rsi(values: list[float], period: int) -> float:
    if len(values) <= period:
        return 50
    gains = []
    losses = []
    for idx in range(1, len(values)):
        change = values[idx] - values[idx - 1]
        gains.append(max(change, 0))
        losses.append(abs(min(change, 0)))
    avg_gain = sum(gains[-period:]) / period
    avg_loss = sum(losses[-period:]) / period
    if avg_loss == 0:
        return 100
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def atr(highs: list[float], lows: list[float], closes: list[float], period: int) -> float:
    if len(closes) < 2:
        return 0
    trs = []
    for idx in range(1, len(closes)):
        trs.append(
            max(
                highs[idx] - lows[idx],
                abs(highs[idx] - closes[idx - 1]),
                abs(lows[idx] - closes[idx - 1]),
            )
        )
    sample = trs[-period:] if len(trs) >= period else trs
    return sum(sample) / len(sample) if sample else 0


def ema_series(values: list[float], period: int) -> list[dict[str, float | int]]:
    if not values:
        return []
    alpha = 2 / (period + 1)
    result = values[0]
    out = []
    for idx, value in enumerate(values):
        result = value * alpha + result * (1 - alpha)
        out.append({"index": idx, "value": round(result, 8)})
    return out


def sma_series(values: list[float], period: int) -> list[dict[str, float | int]]:
    out = []
    for idx in range(len(values)):
        sample = values[max(0, idx - period + 1) : idx + 1]
        out.append({"index": idx, "value": round(sum(sample) / len(sample), 8)})
    return out


def support_resistance(candles: list[Candle], atr_value: float) -> dict[str, float]:
    current = candles[-1].close if candles else 0
    if not candles or current == 0:
        return empty_levels()
    points = []
    width = 3
    for idx in range(width, len(candles) - width):
        window = candles[idx - width : idx + width + 1]
        if candles[idx].low == min(c.low for c in window):
            points.append(("support", candles[idx].low, candles[idx].volume, idx))
        if candles[idx].high == max(c.high for c in window):
            points.append(("resistance", candles[idx].high, candles[idx].volume, idx))
    points.extend(
        [
            ("support", min(c.low for c in candles[-60:]), candles[-1].volume, len(candles) - 1),
            ("resistance", max(c.high for c in candles[-60:]), candles[-1].volume, len(candles) - 1),
            ("support", ema([c.close for c in candles], 20), candles[-1].volume, len(candles) - 1),
            ("support", ema([c.close for c in candles], 50), candles[-1].volume, len(candles) - 1),
        ]
    )
    supports = cluster_levels(points, current, "support", atr_value)
    resistances = cluster_levels(points, current, "resistance", atr_value)
    support = supports[0]["level"] if supports else min(c.low for c in candles[-20:])
    resistance = resistances[0]["level"] if resistances else max(c.high for c in candles[-20:])
    return {
        "support": support,
        "resistance": resistance,
        "support_distance_pct": abs(current - support) / current * 100,
        "resistance_distance_pct": abs(resistance - current) / current * 100,
        "support_score": supports[0]["score"] if supports else 0,
        "resistance_score": resistances[0]["score"] if resistances else 0,
    }


def empty_levels() -> dict[str, float]:
    return {"support": 0, "resistance": 0, "support_distance_pct": 0, "resistance_distance_pct": 0, "support_score": 0, "resistance_score": 0}


def cluster_levels(points: list[tuple[str, float, float, int]], current: float, side: str, atr_value: float) -> list[dict[str, float]]:
    tolerance = max(0.005, (atr_value / current * 0.5) if current else 0.005)
    relevant = []
    for kind, price, volume, idx in points:
        if side == "support" and price < current:
            relevant.append((price, volume, idx))
        if side == "resistance" and price > current:
            relevant.append((price, volume, idx))
    relevant.sort(key=lambda row: row[0])
    clusters: list[dict[str, Any]] = []
    for price, volume, idx in relevant:
        matched = False
        for cluster in clusters:
            center = cluster["weighted_sum"] / cluster["volume_sum"]
            if abs(price - center) / center <= tolerance:
                cluster["touches"] += 1
                cluster["volume_sum"] += max(volume, 1)
                cluster["weighted_sum"] += price * max(volume, 1)
                cluster["latest_idx"] = max(cluster["latest_idx"], idx)
                matched = True
                break
        if not matched:
            clusters.append(
                {
                    "touches": 1,
                    "volume_sum": max(volume, 1),
                    "weighted_sum": price * max(volume, 1),
                    "latest_idx": idx,
                }
            )
    scored = []
    for cluster in clusters:
        level = cluster["weighted_sum"] / cluster["volume_sum"]
        distance = abs(level - current) / current * 100
        score = cluster["touches"] * 2 + cluster["latest_idx"] / max(len(points), 1) - distance * 0.3
        scored.append({"level": level, "score": score, "distance": distance})
    scored.sort(key=lambda row: (-row["score"], row["distance"]))
    return scored


def decide_signal(
    item: dict[str, str],
    btc_regime: dict[str, Any],
    indicators: dict[str, float],
    daily_indicators: dict[str, float],
    daily_candles: list[Candle],
    levels: dict[str, float],
    relative_strength_20: float,
    event_risk_flag: bool,
) -> dict[str, Any]:
    score = 0
    reasons = []
    regime = btc_regime["name"]
    role = item["role"]
    core_multiplier = core_regime_multiplier(daily_indicators, daily_candles)
    trend_ok = indicators["close"] > indicators["ema100"] and indicators["ema20"] > indicators["ema50"]

    if regime == "bull":
        score += 25
        reasons.append("BTC 시장 국면이 상승장이라 공격 허용 조건을 통과했습니다.")
    elif regime == "neutral":
        score += 12
        reasons.append("BTC 시장 국면이 중립이라 소액 관찰 조건입니다.")
    else:
        reasons.append("BTC 시장 국면이 약해서 공격 진입을 제한합니다.")

    if role == "core":
        if core_multiplier >= 1:
            score += 30
            reasons.append("일봉 기준 종가>SMA200, SMA50>SMA200으로 코어 DCA 정상 집행 구간입니다.")
        elif core_multiplier >= 0.5:
            score += 15
            reasons.append("일봉 종가는 SMA200 위지만 SMA50/SMA200 배열이 약해 코어 DCA를 절반만 허용합니다.")
        else:
            reasons.append("일봉 약세 필터가 켜져 코어 신규 매수는 reserve로 이월합니다.")
            return signal_payload("skip", score, "코어 약세 필터로 신규 DCA를 보류합니다.", reasons, indicators, levels, 0, "core-paused")

        if item["asset"] == "ETH" and relative_strength_20 < -2:
            score -= 8
            reasons.append("ETH가 BTC 대비 20봉 상대강도가 약해 매수 강도를 낮춥니다.")

        if indicators["ema20"] > indicators["ema50"]:
            score += 10
            reasons.append("4시간 20EMA가 50EMA 위에 있어 단기 추세가 살아 있습니다.")
        if levels["support_distance_pct"] <= 1.8:
            score += 10
            reasons.append("현재가가 지지 구간에서 크게 멀지 않습니다.")
        if indicators["rsi"] <= 72:
            score += 8
            reasons.append("RSI가 코어 DCA 금지 수준의 과열은 아닙니다.")

        if score >= 65:
            return signal_payload("buy", score, "중립 세트 기준 코어 DCA 매수 후보입니다.", reasons, indicators, levels, core_multiplier, "core-dca")
        return signal_payload("watch", score, "코어는 유지하되 이번 집행은 작게 보거나 관망합니다.", reasons, indicators, levels, core_multiplier * 0.5, "core-watch")

    if role == "aggressive":
        if regime in ("bear", "crash", "overheated"):
            return signal_payload("skip", score, "BTC 약세/급락/과열 구간에서는 XRP/SOL 공격 슬롯을 끕니다.", reasons, indicators, levels, 0, "attack-off")
        if event_risk_flag:
            return signal_payload("skip", score, "이벤트 리스크 플래그가 켜져 공격 슬롯 신규 진입을 막습니다.", reasons, indicators, levels, 0, "event-risk")
        if not trend_ok:
            reasons.append("공격 슬롯 필수 조건인 close>EMA100 및 EMA20>EMA50을 아직 충족하지 못했습니다.")
            return signal_payload("skip", score, "공격 슬롯 추세 필터 미통과로 대기합니다.", reasons, indicators, levels, 0, "attack-trend-blocked")
        if relative_strength_20 <= 0:
            reasons.append("BTC 대비 20봉 상대강도가 양수가 아니라 공격 슬롯을 열지 않습니다.")
            return signal_payload("skip", score, "BTC 대비 상대강도 미통과로 대기합니다.", reasons, indicators, levels, 0, "attack-rs-blocked")

        score += 35
        reasons.append("공격 슬롯 필수 추세 필터와 BTC 대비 상대강도를 통과했습니다.")

    if indicators["ema20"] > indicators["ema50"]:
        score += 15
        reasons.append("20EMA가 50EMA 위에 있어 단기 추세가 살아 있습니다.")
    if levels["support_distance_pct"] <= 1.2:
        score += 20
        reasons.append("현재가가 주요 지지선 근처에 있습니다.")
    if 38 <= indicators["rsi"] <= 60:
        score += 10
        reasons.append("RSI가 과열이 아닌 매수 검토 구간입니다.")
    if indicators["volume_ratio"] >= 1.0:
        score += 10
        reasons.append("거래량이 평균 이상입니다.")
    if levels["resistance_distance_pct"] >= 1.5:
        score += 10
        reasons.append("가까운 저항선까지 최소 여유가 있습니다.")

    if score >= 80:
        return signal_payload("buy", score, "조건 점수가 높아 매수 후보입니다.", reasons, indicators, levels, 1, "attack-on")
    if score >= 60:
        return signal_payload("watch", score, "조건은 일부 충족했지만 추가 확인이 필요합니다.", reasons, indicators, levels, 0.4, "attack-watch")
    return signal_payload("skip", score, "매수 근거가 부족해서 대기합니다.", reasons, indicators, levels, 0, "no-edge")


def core_regime_multiplier(indicators: dict[str, float], candles: list[Candle]) -> float:
    close = indicators["close"]
    sma50_value = indicators["sma50"]
    sma200_value = indicators["sma200"]
    if close <= 0 or sma200_value <= 0:
        return 0
    recent_below = len(candles) >= 3 and all(candle.close <= sma200_value for candle in candles[-3:])
    if recent_below:
        return 0
    if close > sma200_value and sma50_value > sma200_value:
        return 1
    if close > sma200_value:
        return 0.5
    return 0


def signal_payload(
    signal: str,
    score: int,
    summary: str,
    reasons: list[str],
    indicators: dict[str, float],
    levels: dict[str, float],
    budget_multiplier: float,
    mode: str,
) -> dict[str, Any]:
    close = indicators["close"]
    stop_loss = max(levels["support"] - indicators["atr"] * 0.5, close * 0.97)
    take_profit = [levels["resistance"], levels["resistance"] + indicators["atr"]]
    return {
        "signal": signal,
        "score": score,
        "summary": summary,
        "reasons": reasons,
        "action": "simulate_entry" if signal == "buy" else "no_trade",
        "budget_multiplier": round(budget_multiplier, 2),
        "mode": mode,
        "stop_loss": stop_loss,
        "take_profit": take_profit,
    }


def detect_market_regime(candles: list[Candle]) -> dict[str, Any]:
    if len(candles) < 60:
        return {"name": "neutral", "label": "Neutral", "reason": "BTC 데이터가 부족합니다."}
    indicators = compute_indicators(candles)
    close = indicators["close"]
    prev = candles[-2].close
    day_change = change_pct(prev, close)
    if day_change <= -7 or indicators["atr_pct"] >= 7:
        name = "crash"
    elif close > indicators["ema50"] > indicators["ma200"] and 45 <= indicators["rsi"] <= 72:
        name = "bull"
    elif close < indicators["ma200"] or indicators["ema50"] < indicators["ma200"]:
        name = "bear"
    elif indicators["rsi"] > 72:
        name = "overheated"
    else:
        name = "neutral"
    return {
        "name": name,
        "label": name.capitalize(),
        "close": round(close, 8),
        "ema50": round(indicators["ema50"], 8),
        "ma200": round(indicators["ma200"], 8),
        "rsi": round(indicators["rsi"], 2),
        "atr_pct": round(indicators["atr_pct"], 2),
        "volume_ratio": round(indicators["volume_ratio"], 2),
        "reason": regime_reason(name),
    }


def regime_reason(name: str) -> str:
    return {
        "bull": "BTC가 주요 평균선 위에 있어 공격 슬롯을 열 수 있습니다.",
        "neutral": "BTC가 명확한 상승/하락장을 확정하지 못해 보수적으로 봅니다.",
        "bear": "BTC가 장기 평균선 아래라 공격 슬롯을 제한합니다.",
        "crash": "급락장 조건이 감지되어 신규 진입을 멈춥니다.",
        "overheated": "RSI 과열로 추격 매수를 제한합니다.",
    }.get(name, "중립 상태입니다.")


def relative_strength(item: dict[str, str]) -> float:
    asset = safe_fetch_candles("binance", item["binance"], "4h", 60)
    btc = safe_fetch_candles("binance", "BTCUSDT", "4h", 60)
    if len(asset) < 20 or len(btc) < 20:
        return 0
    asset_change = change_pct(asset[-20].close, asset[-1].close)
    btc_change = change_pct(btc[-20].close, btc[-1].close)
    return asset_change - btc_change


def change_pct(start: float, end: float) -> float:
    return ((end - start) / start * 100) if start else 0


if __name__ == "__main__":
    raise SystemExit(main())
