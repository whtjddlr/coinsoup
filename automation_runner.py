"""Local automation runner for the RGCA-L paper dashboard.

This script never sends live orders. It refreshes analysis snapshots, support /
resistance snapshots, and optionally runs the existing paper plan.
"""

from __future__ import annotations

import argparse
import json
import os
import traceback
from datetime import datetime, timedelta
from pathlib import Path
from time import sleep
from typing import Any
from zoneinfo import ZoneInfo

from paper_app import (
    ASSETS,
    ROOT,
    build_candle_payload,
    build_dashboard,
    handle_run_futures_paper_test,
    handle_run_chart_trade_test,
    handle_run_plan,
    handle_run_rebound_test,
)


DEFAULT_CONFIG = ROOT / "dryrun_config.json"
DEFAULT_AUTOMATION = {
    "dashboard_refresh_minutes": 15,
    "support_resistance_refresh_minutes": 15,
    "major_level_refresh_hours_kst": [1, 5, 9, 13, 17, 21],
    "major_level_delay_minutes": 5,
    "daily_analysis_time_kst": "09:10",
    "paper_plan_time_kst": "09:12",
    "paper_plan_enabled": True,
    "level_timeframes": ["15m", "1h", "4h", "1d"],
    "venues": ["upbit", "binance", "binance_futures"],
    "snapshot_dir": "data/snapshots",
    "loop_poll_seconds": 30,
    "supervisor_refresh_minutes": 5,
    "supervisor_timeframes": ["5m", "15m", "1h", "4h", "1d", "1w"],
    "supervisor_event_dedupe_minutes": 15,
    "supervisor_lock_minutes": 20,
    "supervisor_lock_on_risk_regimes": ["bear", "crash", "overheated"],
    "bear_rebound_check_minutes": 5,
    "chart_trade_check_minutes": 5,
    "futures_paper_check_minutes": 5,
}


def main() -> int:
    args = parse_args()
    config = load_json(Path(args.config))
    settings = automation_settings(config)

    if args.loop:
        run_loop(settings, args.tasks, args.duration_minutes)
        return 0

    tasks = parse_tasks(args.tasks)
    if "due" in tasks:
        tasks = ["dashboard", "levels", "supervisor", "status"]
    result = run_tasks(tasks, settings)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run local paper-trading automation tasks.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help="Path to dryrun_config.json")
    parser.add_argument(
        "--tasks",
        default="dashboard,levels,status",
        help="Comma-separated tasks: due,dashboard,levels,supervisor,rebound,chart,futures,plan,status",
    )
    parser.add_argument("--loop", action="store_true", help="Run scheduler loop until stopped.")
    parser.add_argument(
        "--duration-minutes",
        type=float,
        default=0,
        help="Stop the scheduler loop after this many minutes. 0 means run until stopped.",
    )
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def automation_settings(config: dict[str, Any]) -> dict[str, Any]:
    strategy = config.get("strategy", {})
    raw = {**DEFAULT_AUTOMATION, **strategy.get("automation", {})}
    timezone = ZoneInfo(strategy.get("timezone", "Asia/Seoul"))
    snapshot_dir = path_from_root(str(raw["snapshot_dir"]))
    return {
        **raw,
        "timezone": timezone,
        "snapshot_dir": snapshot_dir,
        "log_path": path_from_root(str(raw.get("log_path", "data/automation.log"))),
        "status_path": path_from_root(str(raw.get("status_path", "data/automation_status.json"))),
        "supervisor_status_path": path_from_root(
            str(raw.get("supervisor_status_path", "data/codex_supervisor_status.json"))
        ),
        "supervisor_log_path": path_from_root(str(raw.get("supervisor_log_path", "data/codex_supervisor.log"))),
        "trigger_events_path": path_from_root(str(raw.get("trigger_events_path", "data/trigger_events.jsonl"))),
        "trigger_state_path": path_from_root(str(raw.get("trigger_state_path", "data/trigger_state.json"))),
        "no_entry_lock_path": path_from_root(str(raw.get("no_entry_lock_path", "data/no_entry_lock.json"))),
        "loop_lock_path": path_from_root(str(raw.get("loop_lock_path", "data/automation_loop.lock"))),
    }


def path_from_root(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def run_loop(settings: dict[str, Any], task_spec: str, duration_minutes: float = 0) -> None:
    acquire_loop_lock(settings["loop_lock_path"])
    last_dashboard_slot: datetime | None = None
    last_levels_slot: datetime | None = None
    last_supervisor_slot: datetime | None = None
    last_rebound_slot: datetime | None = None
    last_chart_slot: datetime | None = None
    last_futures_slot: datetime | None = None
    last_plan_date = ""
    requested = parse_tasks(task_spec)
    poll_seconds = int(settings["loop_poll_seconds"])
    end_at = None
    if duration_minutes and duration_minutes > 0:
        end_at = datetime.now(settings["timezone"]) + timedelta(minutes=duration_minutes)
    try:
        write_status(
            settings,
            {
                "ok": True,
                "mode": "loop",
                "message": "automation loop started",
                "session_until": end_at.isoformat(timespec="seconds") if end_at else "",
            },
        )

        while True:
            now = datetime.now(settings["timezone"])
            if end_at and now >= end_at:
                result = {
                    "ok": True,
                    "mode": "loop",
                    "timestamp": now.isoformat(timespec="seconds"),
                    "message": "automation loop completed",
                }
                write_status(settings, result)
                append_jsonl(settings["log_path"], result)
                return

            tasks: list[str] = []
            if "due" in requested or "dashboard" in requested:
                slot = current_slot(now, int(settings["dashboard_refresh_minutes"]))
                if slot != last_dashboard_slot:
                    tasks.append("dashboard")
                    last_dashboard_slot = slot
            if "due" in requested or "levels" in requested:
                interval = int(settings["support_resistance_refresh_minutes"])
                slot = current_slot(now, interval)
                if slot != last_levels_slot:
                    tasks.append("levels")
                    last_levels_slot = slot
            if "due" in requested or "supervisor" in requested:
                interval = int(settings["supervisor_refresh_minutes"])
                slot = current_slot(now, interval)
                if slot != last_supervisor_slot:
                    tasks.append("supervisor")
                    last_supervisor_slot = slot
            if "due" in requested or "rebound" in requested:
                interval = int(settings.get("bear_rebound_check_minutes", 5))
                slot = current_slot(now, interval)
                if slot != last_rebound_slot:
                    tasks.append("rebound")
                    last_rebound_slot = slot
            if "due" in requested or "chart" in requested:
                interval = int(settings.get("chart_trade_check_minutes", 5))
                slot = current_slot(now, interval)
                if slot != last_chart_slot:
                    tasks.append("chart")
                    last_chart_slot = slot
            if "due" in requested or "futures" in requested:
                interval = int(settings.get("futures_paper_check_minutes", 5))
                slot = current_slot(now, interval)
                if slot != last_futures_slot:
                    tasks.append("futures")
                    last_futures_slot = slot
            if ("due" in requested or "plan" in requested) and should_run_plan(now, settings, last_plan_date):
                tasks.append("plan")
                last_plan_date = now.strftime("%Y-%m-%d")

            if tasks:
                run_tasks(tasks + ["status"], settings)
            sleep_seconds = max(poll_seconds, 5)
            if end_at:
                remaining = (end_at - datetime.now(settings["timezone"])).total_seconds()
                if remaining <= 0:
                    continue
                sleep_seconds = min(sleep_seconds, remaining)
            sleep(sleep_seconds)
    finally:
        release_loop_lock(settings["loop_lock_path"])


def current_slot(now: datetime, interval_minutes: int) -> datetime:
    """Return the current wall-clock slot for a polling interval."""
    if interval_minutes <= 0:
        return now.replace(second=0, microsecond=0)
    minute = (now.minute // interval_minutes) * interval_minutes
    return now.replace(minute=minute, second=0, microsecond=0)


def next_slot(now: datetime, interval_minutes: int) -> datetime:
    if interval_minutes <= 0:
        return now.replace(second=0, microsecond=0)
    slot_start = current_slot(now, interval_minutes)
    if slot_start == now.replace(second=0, microsecond=0) and now.second == 0 and now.microsecond == 0:
        return slot_start
    return slot_start + timedelta(minutes=interval_minutes)


def acquire_loop_lock(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"pid": os.getpid(), "created_at": datetime.now().isoformat(timespec="seconds")}
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            existing = {}
        existing_pid = int(existing.get("pid", 0) or 0)
        if existing_pid and process_alive(existing_pid):
            raise RuntimeError(f"automation loop already running with pid={existing_pid}")
        try:
            path.unlink()
        except OSError:
            pass
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def release_loop_lock(path: Path) -> None:
    try:
        if not path.exists():
            return
        existing = json.loads(path.read_text(encoding="utf-8"))
        if int(existing.get("pid", 0) or 0) == os.getpid():
            path.unlink()
    except (OSError, json.JSONDecodeError, ValueError):
        return


def process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes

            process_query_limited_information = 0x1000
            handle = ctypes.windll.kernel32.OpenProcess(process_query_limited_information, False, pid)
            if not handle:
                return False
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        except (AttributeError, OSError, ValueError):
            return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def should_run_plan(now: datetime, settings: dict[str, Any], last_plan_date: str) -> bool:
    if not bool(settings["paper_plan_enabled"]):
        return False
    if last_plan_date == now.strftime("%Y-%m-%d"):
        return False
    target_hour, target_minute = parse_hhmm(str(settings["paper_plan_time_kst"]))
    return (now.hour, now.minute) >= (target_hour, target_minute)


def parse_hhmm(value: str) -> tuple[int, int]:
    hour, minute = value.split(":", 1)
    return int(hour), int(minute)


def parse_tasks(value: str) -> list[str]:
    tasks = [part.strip().lower() for part in value.split(",") if part.strip()]
    return tasks or ["dashboard", "levels", "status"]


def run_tasks(tasks: list[str], settings: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(settings["timezone"])
    result: dict[str, Any] = {"ok": True, "timestamp": now.isoformat(timespec="seconds"), "tasks": []}

    for task in tasks:
        try:
            if task == "dashboard":
                payload = build_dashboard()
                write_json(settings["snapshot_dir"] / "dashboard_snapshot.json", payload)
                result["tasks"].append({"task": task, "ok": True, "summary": "dashboard snapshot updated"})
            elif task == "levels":
                payload = build_levels_snapshot(settings)
                write_json(settings["snapshot_dir"] / "levels_snapshot.json", payload)
                result["tasks"].append({"task": task, "ok": True, "summary": f"{len(payload['levels'])} level rows updated"})
            elif task == "plan":
                payload = handle_run_plan()
                write_json(settings["snapshot_dir"] / "last_plan_result.json", payload)
                summary = "paper plan locked by supervisor" if payload.get("locked") else "paper plan executed"
                result["tasks"].append({"task": task, "ok": bool(payload.get("ok")), "summary": summary})
            elif task == "supervisor":
                payload = build_supervisor_snapshot(settings)
                write_json(settings["supervisor_status_path"], payload)
                append_jsonl(settings["supervisor_log_path"], payload)
                append_supervisor_events(settings, payload.get("events", []), now)
                write_no_entry_lock(settings, payload)
                lock_text = "locked" if payload.get("no_entry_lock", {}).get("active") else "open"
                result["tasks"].append(
                    {
                        "task": task,
                        "ok": bool(payload.get("ok")),
                        "summary": f"supervisor {payload.get('severity', 'UNKNOWN')} / {lock_text}",
                    }
                )
            elif task == "rebound":
                payload = handle_run_rebound_test()
                write_json(settings["snapshot_dir"] / "last_rebound_test_result.json", payload)
                if payload.get("locked"):
                    summary = "bear rebound test locked"
                else:
                    summary = f"bear rebound test simulated={payload.get('simulated_count', 0)} skipped={payload.get('skipped_count', 0)}"
                result["tasks"].append({"task": task, "ok": bool(payload.get("ok")), "summary": summary})
            elif task == "chart":
                payload = handle_run_chart_trade_test()
                write_json(settings["snapshot_dir"] / "last_chart_trade_result.json", payload)
                if not payload.get("enabled", True):
                    summary = "chart trade test disabled"
                elif payload.get("locked"):
                    summary = "chart trade test locked"
                else:
                    summary = (
                        "chart trade test "
                        f"buy={payload.get('buy_simulated_count', 0)} "
                        f"sell={payload.get('sell_simulated_count', 0)} "
                        f"skipped={payload.get('skipped_count', 0)}"
                    )
                result["tasks"].append({"task": task, "ok": bool(payload.get("ok")), "summary": summary})
            elif task == "futures":
                payload = handle_run_futures_paper_test()
                write_json(settings["snapshot_dir"] / "last_futures_paper_result.json", payload)
                if not payload.get("enabled", True):
                    summary = "futures paper disabled"
                else:
                    summary = (
                        "futures paper "
                        f"simulated={payload.get('simulated_count', 0)} "
                        f"skipped={payload.get('skipped_count', 0)}"
                    )
                result["tasks"].append({"task": task, "ok": bool(payload.get("ok")), "summary": summary})
            elif task == "status":
                result["tasks"].append({"task": task, "ok": True, "summary": "status refreshed"})
            else:
                result["tasks"].append({"task": task, "ok": False, "summary": "unknown task"})
                result["ok"] = False
        except Exception as exc:  # Keep the loop alive and preserve the reason.
            result["ok"] = False
            result["tasks"].append(
                {
                    "task": task,
                    "ok": False,
                    "error": str(exc),
                    "traceback": traceback.format_exc(limit=4),
                }
            )

    result["next"] = next_schedule(settings)
    write_status(settings, result)
    append_jsonl(settings["log_path"], result)
    return result


def build_supervisor_snapshot(settings: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(settings["timezone"])
    events: list[dict[str, Any]] = []
    lock_reasons: list[str] = []
    dashboard = build_dashboard()
    market_regime = dashboard.get("market_regime", {})
    regime_name = str(market_regime.get("name", "unknown"))
    dashboard_assets = {asset.get("asset"): asset for asset in dashboard.get("assets", [])}

    safety = {
        "dry_run": dashboard.get("dry_run") is True,
        "paper_mode": dashboard.get("paper_mode") is True,
        "live_trading": dashboard.get("live_trading") is True,
        "live_trading_locked": dashboard.get("deployment", {}).get("live_trading_locked") is True,
        "auto_withdrawals": dashboard.get("deployment", {}).get("auto_withdrawals") is True,
        "futures_enabled": dashboard.get("execution_policy", {}).get("futures", {}).get("enabled") is True,
    }
    if not safety["dry_run"] or not safety["paper_mode"]:
        events.append(supervisor_event(now, "CRIT", "paper_mode_violation", "SYSTEM", "", "", "Paper mode safeguard is not clean."))
        lock_reasons.append("paper_mode_violation")
    if safety["live_trading"] or not safety["live_trading_locked"]:
        events.append(supervisor_event(now, "CRIT", "live_trading_unlocked", "SYSTEM", "", "", "Live trading is not locked."))
        lock_reasons.append("live_trading_unlocked")
    if safety["auto_withdrawals"]:
        events.append(supervisor_event(now, "CRIT", "withdrawal_enabled", "SYSTEM", "", "", "Auto withdrawals appear enabled."))
        lock_reasons.append("withdrawal_enabled")
    if safety["futures_enabled"]:
        events.append(supervisor_event(now, "WARN", "futures_overlay_enabled", "SYSTEM", "", "", "Futures overlay is enabled."))

    if regime_name in set(settings.get("supervisor_lock_on_risk_regimes", [])):
        events.append(
            supervisor_event(
                now,
                "WARN",
                "risk_regime_lock",
                "BTC",
                "binance",
                "1d",
                f"Market regime is {regime_name}; supervisor keeps new paper entries locked.",
            )
        )
        lock_reasons.append(f"market_regime_{regime_name}")

    asset_rows: list[dict[str, Any]] = []
    for asset in ASSETS:
        rows = build_supervisor_timeframes(asset, settings)
        dashboard_asset = dashboard_assets.get(asset["asset"], {})
        asset_events = evaluate_supervisor_asset(now, asset, rows, dashboard_asset)
        events.extend(asset_events)
        asset_rows.append(
            {
                "asset": asset["asset"],
                "symbol": asset["binance"],
                "dashboard_signal": dashboard_asset.get("signal", "unknown"),
                "dashboard_score": dashboard_asset.get("score", 0),
                "dashboard_action": dashboard_asset.get("action", "unknown"),
                "order_budget_multiplier": dashboard_asset.get("order_budget_multiplier", 0),
                "alignment_score": round(sum(row["score"] for row in rows) / max(len(rows), 1), 1),
                "timeframes": rows,
            }
        )

    severity = highest_severity(events)
    active_lock = bool(lock_reasons)
    lock_expires_at = now + timedelta(minutes=int(settings.get("supervisor_lock_minutes", 20)))
    return {
        "ok": severity != "CRIT",
        "updated_at": now.isoformat(timespec="seconds"),
        "mode": "codex_supervisor",
        "severity": severity,
        "market_regime": {
            "name": regime_name,
            "label": market_regime.get("label", regime_name),
            "reason": market_regime.get("reason", ""),
        },
        "safety": safety,
        "no_entry_lock": {
            "active": active_lock,
            "reasons": lock_reasons,
            "expires_at": lock_expires_at.isoformat(timespec="seconds") if active_lock else "",
        },
        "assets": asset_rows,
        "events": events,
        "files": {
            "status": str(settings["supervisor_status_path"]),
            "events": str(settings["trigger_events_path"]),
            "lock": str(settings["no_entry_lock_path"]),
        },
    }


def build_supervisor_timeframes(asset: dict[str, str], settings: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for timeframe in settings.get("supervisor_timeframes", ["5m", "15m", "1h", "4h", "1d", "1w"]):
        payload = build_candle_payload("binance", asset["binance"], str(timeframe))
        indicators = payload.get("indicators", {})
        levels = payload.get("levels", {})
        close = as_float(indicators.get("close"))
        ema20_value = as_float(indicators.get("ema20"))
        ema50_value = as_float(indicators.get("ema50"))
        rsi_value = as_float(indicators.get("rsi"))
        volume_ratio = as_float(indicators.get("volume_ratio"))
        support_distance = as_float(levels.get("support_distance_pct"))
        resistance_distance = as_float(levels.get("resistance_distance_pct"))
        trend_up = close > 0 and close > ema20_value > ema50_value
        trend_down = close > 0 and close < ema20_value < ema50_value
        score = 0
        if trend_up:
            score += 35
        elif close > ema20_value:
            score += 15
        if 45 <= rsi_value <= 68:
            score += 20
        elif rsi_value >= 72:
            score -= 15
        if volume_ratio >= 1.2:
            score += 20
        elif volume_ratio >= 0.8:
            score += 8
        if support_distance <= 0.7:
            score += 12
        if resistance_distance >= 0.8:
            score += 10
        rows.append(
            {
                "timeframe": timeframe,
                "close": close,
                "score": max(0, min(score, 100)),
                "trend": "up" if trend_up else "down" if trend_down else "mixed",
                "rsi": round(rsi_value, 2),
                "volume_ratio": round(volume_ratio, 2),
                "atr_pct": round(as_float(indicators.get("atr_pct")), 2),
                "support": as_float(levels.get("support")),
                "resistance": as_float(levels.get("resistance")),
                "support_distance_pct": round(support_distance, 2),
                "resistance_distance_pct": round(resistance_distance, 2),
                "near_support": support_distance <= 0.7,
                "near_resistance": resistance_distance <= 0.7,
                "overheated": rsi_value >= 72,
            }
        )
    return rows


def evaluate_supervisor_asset(
    now: datetime,
    asset: dict[str, str],
    rows: list[dict[str, Any]],
    dashboard_asset: dict[str, Any],
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    short_rows = [row for row in rows if row["timeframe"] in {"5m", "15m"}]
    mid_rows = [row for row in rows if row["timeframe"] in {"1h", "4h"}]
    long_rows = [row for row in rows if row["timeframe"] in {"1d", "1w"}]

    if dashboard_asset.get("signal") == "buy" or dashboard_asset.get("action") == "simulate_entry":
        events.append(
            supervisor_event(
                now,
                "INFO",
                "paper_entry_candidate",
                asset["asset"],
                "binance",
                "dashboard",
                "Dashboard strategy produced a paper-entry candidate.",
                {"score": dashboard_asset.get("score", 0), "budget_multiplier": dashboard_asset.get("order_budget_multiplier", 0)},
            )
        )

    for row in rows:
        if row["overheated"]:
            events.append(
                supervisor_event(
                    now,
                    "WARN",
                    "overheated_timeframe",
                    asset["asset"],
                    "binance",
                    str(row["timeframe"]),
                    f"{asset['asset']} {row['timeframe']} RSI is overheated.",
                    {"rsi": row["rsi"]},
                )
            )
        if row["near_support"] and row["timeframe"] in {"5m", "15m", "1h"}:
            events.append(
                supervisor_event(
                    now,
                    "INFO",
                    "support_watch",
                    asset["asset"],
                    "binance",
                    str(row["timeframe"]),
                    f"{asset['asset']} is near support on {row['timeframe']}.",
                    {"support_distance_pct": row["support_distance_pct"]},
                )
            )
        if row["near_resistance"] and row["timeframe"] in {"5m", "15m", "1h"}:
            events.append(
                supervisor_event(
                    now,
                    "INFO",
                    "resistance_watch",
                    asset["asset"],
                    "binance",
                    str(row["timeframe"]),
                    f"{asset['asset']} is near resistance on {row['timeframe']}.",
                    {"resistance_distance_pct": row["resistance_distance_pct"]},
                )
            )

    short_aligned = short_rows and all(row["trend"] == "up" and row["score"] >= 55 for row in short_rows)
    mid_not_down = not any(row["trend"] == "down" for row in mid_rows)
    long_not_down = not any(row["trend"] == "down" for row in long_rows)
    volume_ok = any(row["volume_ratio"] >= 1.0 for row in short_rows)
    if short_aligned and mid_not_down and long_not_down and volume_ok:
        events.append(
            supervisor_event(
                now,
                "INFO",
                "multi_timeframe_long_watch",
                asset["asset"],
                "binance",
                "5m/15m/1h/4h/1d/1w",
                f"{asset['asset']} short timeframes aligned upward without higher-timeframe downtrend.",
            )
        )
    return events


def supervisor_event(
    now: datetime,
    severity: str,
    event_type: str,
    asset: str,
    venue: str,
    timeframe: str,
    message: str,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "ts": now.isoformat(timespec="seconds"),
        "severity": severity,
        "type": event_type,
        "asset": asset,
        "venue": venue,
        "timeframe": timeframe,
        "message": message,
        "detail": detail or {},
    }


def highest_severity(events: list[dict[str, Any]]) -> str:
    order = {"INFO": 1, "WARN": 2, "CRIT": 3}
    if not events:
        return "OK"
    return max((str(event.get("severity", "INFO")) for event in events), key=lambda value: order.get(value, 0))


def append_supervisor_events(settings: dict[str, Any], events: list[dict[str, Any]], now: datetime) -> None:
    if not events:
        return
    state_path = settings["trigger_state_path"]
    state = load_json(state_path) if state_path.exists() else {"seen": {}}
    seen = state.setdefault("seen", {})
    dedupe_minutes = int(settings.get("supervisor_event_dedupe_minutes", 15))
    fresh: list[dict[str, Any]] = []
    for event in events:
        key = ":".join(
            [
                str(event.get("type", "")),
                str(event.get("asset", "")),
                str(event.get("venue", "")),
                str(event.get("timeframe", "")),
            ]
        )
        last_seen = parse_iso(seen.get(key, ""))
        if last_seen is not None and now - last_seen < timedelta(minutes=dedupe_minutes):
            continue
        seen[key] = now.isoformat(timespec="seconds")
        fresh.append(event)
    if fresh:
        for event in fresh:
            append_jsonl(settings["trigger_events_path"], event)
        write_json(state_path, state)


def write_no_entry_lock(settings: dict[str, Any], payload: dict[str, Any]) -> None:
    lock = payload.get("no_entry_lock", {})
    output = {
        "active": bool(lock.get("active")),
        "updated_at": payload.get("updated_at", ""),
        "expires_at": lock.get("expires_at", ""),
        "reasons": lock.get("reasons", []),
        "source": "codex_supervisor",
        "mode": "paper_only",
    }
    write_json(settings["no_entry_lock_path"], output)


def parse_iso(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def as_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def build_levels_snapshot(settings: dict[str, Any]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    venues = list(settings["venues"])
    timeframes = list(settings["level_timeframes"])
    for asset in ASSETS:
        for venue in venues:
            exchange, instrument = instrument_for_venue(asset, venue)
            for timeframe in timeframes:
                payload = build_candle_payload(exchange, instrument, timeframe)
                indicators = payload.get("indicators", {})
                levels = payload.get("levels", {})
                rows.append(
                    {
                        "asset": asset["asset"],
                        "venue": venue,
                        "exchange": exchange,
                        "instrument": instrument,
                        "timeframe": timeframe,
                        "close": indicators.get("close", 0),
                        "support": levels.get("support", 0),
                        "resistance": levels.get("resistance", 0),
                        "support_distance_pct": levels.get("support_distance_pct", 0),
                        "resistance_distance_pct": levels.get("resistance_distance_pct", 0),
                        "rsi": indicators.get("rsi", 0),
                        "atr_pct": indicators.get("atr_pct", 0),
                        "volume_ratio": indicators.get("volume_ratio", 0),
                    }
                )
    return {
        "updated_at": datetime.now(settings["timezone"]).isoformat(timespec="seconds"),
        "policy": level_policy(settings),
        "levels": rows,
    }


def instrument_for_venue(asset: dict[str, str], venue: str) -> tuple[str, str]:
    if venue == "upbit":
        return "upbit", asset["upbit"]
    if venue == "binance_futures":
        return "binance_futures", asset["binance"]
    return "binance", asset["binance"]


def level_policy(settings: dict[str, Any]) -> dict[str, Any]:
    hours = ", ".join(f"{int(hour):02d}:05" for hour in settings["major_level_refresh_hours_kst"])
    return {
        "price_stream": "tick/websocket",
        "minor_levels": f"{settings['support_resistance_refresh_minutes']}분봉 마감 후",
        "major_levels": f"KST {hours} 4시간봉 마감 확인",
        "daily_levels": str(settings["daily_analysis_time_kst"]),
        "timeframes": settings["level_timeframes"],
    }


def next_schedule(settings: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(settings["timezone"])
    dashboard = next_slot(now, int(settings["dashboard_refresh_minutes"]))
    levels = next_slot(now, int(settings["support_resistance_refresh_minutes"]))
    futures = next_slot(now, int(settings.get("futures_paper_check_minutes", 5)))
    target_hour, target_minute = parse_hhmm(str(settings["paper_plan_time_kst"]))
    plan = now.replace(hour=target_hour, minute=target_minute, second=0, microsecond=0)
    if plan <= now:
        plan += timedelta(days=1)
    return {
        "dashboard_after": dashboard.isoformat(timespec="minutes"),
        "levels_after": levels.isoformat(timespec="minutes"),
        "futures_paper_after": futures.isoformat(timespec="minutes"),
        "paper_plan_at": plan.isoformat(timespec="minutes"),
    }


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    temp.replace(path)


def write_status(settings: dict[str, Any], payload: dict[str, Any]) -> None:
    write_json(settings["status_path"], payload)


def append_jsonl(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
