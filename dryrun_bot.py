#!/usr/bin/env python3
"""Paper-trading crypto bot.

This script simulates buys and sells against a virtual portfolio. It has no
API-key handling and no real order submission code by design.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


DEFAULT_CONFIG = "dryrun_config.json"
DECIMAL_PLACES = Decimal("0.00000001")
CSV_COLUMNS = [
    "timestamp",
    "strategy",
    "exchange",
    "instrument",
    "side",
    "quote_currency",
    "requested_quote_budget",
    "executed_quote_value",
    "fee",
    "slippage_pct",
    "price",
    "effective_price",
    "base_quantity",
    "cash_after",
    "position_after",
    "realized_pnl",
    "dry_run",
    "status",
    "note",
]
EQUITY_COLUMNS = [
    "timestamp",
    "exchange",
    "quote_currency",
    "cash",
    "position_value",
    "total_equity",
    "unrealized_pnl",
]


@dataclass(frozen=True)
class PlannedOrder:
    exchange: str
    instrument: str
    side: str
    quote_currency: str
    quote_budget: Decimal | None
    base_quantity: Decimal | None
    sell_fraction: Decimal | None
    min_quote_budget: Decimal
    source: str


@dataclass(frozen=True)
class SimulatedOrder:
    timestamp: str
    strategy: str
    exchange: str
    instrument: str
    side: str
    quote_currency: str
    requested_quote_budget: Decimal
    executed_quote_value: Decimal
    fee: Decimal
    slippage_pct: Decimal
    price: Decimal
    effective_price: Decimal
    base_quantity: Decimal
    cash_after: Decimal
    position_after: Decimal
    realized_pnl: Decimal
    dry_run: bool
    status: str
    note: str

    def as_csv_row(self) -> dict[str, str]:
        return {
            "timestamp": self.timestamp,
            "strategy": self.strategy,
            "exchange": self.exchange,
            "instrument": self.instrument,
            "side": self.side,
            "quote_currency": self.quote_currency,
            "requested_quote_budget": format_decimal(self.requested_quote_budget),
            "executed_quote_value": format_decimal(self.executed_quote_value),
            "fee": format_decimal(self.fee),
            "slippage_pct": format_decimal(self.slippage_pct),
            "price": format_decimal(self.price),
            "effective_price": format_decimal(self.effective_price),
            "base_quantity": format_decimal(self.base_quantity),
            "cash_after": format_decimal(self.cash_after),
            "position_after": format_decimal(self.position_after),
            "realized_pnl": format_decimal(self.realized_pnl),
            "dry_run": str(self.dry_run).lower(),
            "status": self.status,
            "note": self.note,
        }


def main() -> int:
    args = parse_args()
    config_path = Path(args.config).resolve()
    config = load_json(config_path)
    enforce_paper_mode(config)

    strategy = config.get("strategy", {})
    timezone = ZoneInfo(strategy.get("timezone", "Asia/Seoul"))
    now = datetime.now(timezone)

    output = config["output"]
    state_path = resolve_output_path(config_path, output["state_json"])
    trades_path = resolve_output_path(config_path, output["trades_csv"])
    equity_path = resolve_output_path(config_path, output["equity_csv"])

    state = load_state(state_path)
    ensure_portfolio(state, config)

    manual_orders = load_cli_orders(config, args)
    planned = []
    if args.include_plan or not manual_orders:
        planned.extend(load_planned_orders(config))
    planned.extend(manual_orders)

    prices = fetch_prices(config, planned, state, timeout=args.timeout)
    simulated = simulate_orders(
        planned_orders=planned,
        prices=prices,
        config=config,
        strategy_name=strategy.get("name", "daily_dca"),
        now=now,
        state=state,
        dedupe_per_day=bool(strategy.get("dedupe_per_day", True)),
        force=args.force,
    )

    equity_rows = build_equity_rows(state, config, prices, now)
    write_orders(trades_path, simulated)
    write_equity(equity_path, equity_rows)
    save_state(state_path, state)
    print_summary(simulated, equity_rows, trades_path, equity_path, state_path)
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Simulate crypto buys and sells without sending real exchange orders."
    )
    parser.add_argument(
        "--config",
        default=DEFAULT_CONFIG,
        help=f"Path to config JSON. Default: {DEFAULT_CONFIG}",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Allow another config-plan simulation for the same exchange/instrument today.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=8.0,
        help="HTTP timeout in seconds. Default: 8",
    )
    parser.add_argument(
        "--buy",
        action="append",
        default=[],
        metavar="EXCHANGE:INSTRUMENT:QUOTE_BUDGET",
        help="Add a one-off paper buy, e.g. upbit:KRW-BTC:5000",
    )
    parser.add_argument(
        "--sell",
        action="append",
        default=[],
        metavar="EXCHANGE:INSTRUMENT:FRACTION",
        help="Add a one-off paper sell fraction, e.g. upbit:KRW-BTC:0.25",
    )
    parser.add_argument(
        "--include-plan",
        action="store_true",
        help="Run configured daily orders together with one-off --buy/--sell orders.",
    )
    return parser.parse_args()


def enforce_paper_mode(config: dict[str, Any]) -> None:
    execution = config.get("execution", {})
    if config.get("dry_run") is not True:
        raise SystemExit("Refusing to run: config dry_run must be true.")
    if execution.get("mode", "paper") != "paper":
        raise SystemExit("Refusing to run: only paper mode is implemented.")
    if execution.get("live_trading", False) is True:
        raise SystemExit("Refusing to run: live_trading must be false.")


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Config not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"simulated_keys": []}
    with path.open("r", encoding="utf-8") as handle:
        state = json.load(handle)
    state.setdefault("simulated_keys", [])
    return state


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, ensure_ascii=True)
        handle.write("\n")


def resolve_output_path(config_path: Path, configured_path: str) -> Path:
    path = Path(configured_path)
    if path.is_absolute():
        return path
    return config_path.parent / path


def parse_decimal(
    value: Any,
    field_name: str,
    allow_zero: bool = False,
    allow_negative: bool = False,
) -> Decimal:
    try:
        decimal_value = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise SystemExit(f"Invalid decimal for {field_name}: {value}") from exc
    if allow_negative:
        return decimal_value
    if allow_zero:
        if decimal_value < 0:
            raise SystemExit(f"{field_name} must be zero or greater: {value}")
    elif decimal_value <= 0:
        raise SystemExit(f"{field_name} must be greater than zero: {value}")
    return decimal_value


def ensure_portfolio(state: dict[str, Any], config: dict[str, Any]) -> None:
    portfolio = state.setdefault("portfolio", {})
    cash = portfolio.setdefault("cash", {})
    positions = portfolio.setdefault("positions", {})
    starting_cash = config.get("portfolio", {}).get("starting_cash", {})
    starting_positions = config.get("portfolio", {}).get("starting_positions", {})

    for exchange_name, exchange_config in config.get("exchanges", {}).items():
        if not exchange_config.get("enabled", False):
            continue
        quote_currency = str(exchange_config["quote_currency"])
        cash_key = cash_state_key(exchange_name, quote_currency)
        cash.setdefault(cash_key, str(starting_cash.get(cash_key, "0")))
        for raw_order in exchange_config.get("orders", []):
            instrument = str(raw_order.get("market") or raw_order.get("symbol"))
            position_key = position_state_key(exchange_name, instrument)
            positions.setdefault(
                position_key,
                starting_positions.get(
                    position_key,
                    {"quantity": "0", "cost_basis": "0", "realized_pnl": "0"},
                ),
            )


def load_planned_orders(config: dict[str, Any]) -> list[PlannedOrder]:
    planned: list[PlannedOrder] = []
    exchanges = config.get("exchanges", {})
    for exchange_name, exchange_config in exchanges.items():
        if not exchange_config.get("enabled", False):
            continue

        quote_currency = str(exchange_config["quote_currency"])
        total_buy_budget = Decimal("0")
        orders = exchange_config.get("orders", [])

        for raw_order in orders:
            order = parse_order_config(exchange_name, quote_currency, raw_order, "config")
            if order.side == "buy" and order.quote_budget is not None:
                total_buy_budget += order.quote_budget
            planned.append(order)

        max_budget = parse_decimal(
            exchange_config.get("max_quote_budget_per_run", total_buy_budget),
            f"{exchange_name}.max_quote_budget_per_run",
            allow_zero=True,
        )
        if total_buy_budget > max_budget:
            raise SystemExit(
                f"{exchange_name} planned buy budget {total_buy_budget} exceeds max {max_budget}."
            )

    return planned


def parse_order_config(
    exchange: str, quote_currency: str, raw_order: dict[str, Any], source: str
) -> PlannedOrder:
    instrument = str(raw_order.get("market") or raw_order.get("symbol"))
    side = str(raw_order.get("side", "buy")).lower()
    min_quote_budget = parse_decimal(
        raw_order.get("min_quote_budget", "0.00000001"),
        "min_quote_budget",
    )

    if side == "buy":
        return PlannedOrder(
            exchange=exchange,
            instrument=instrument,
            side=side,
            quote_currency=quote_currency,
            quote_budget=parse_decimal(raw_order["quote_budget"], "quote_budget"),
            base_quantity=None,
            sell_fraction=None,
            min_quote_budget=min_quote_budget,
            source=source,
        )

    if side == "sell":
        base_quantity = None
        sell_fraction = None
        if "base_quantity" in raw_order:
            base_quantity = parse_decimal(raw_order["base_quantity"], "base_quantity")
        if "sell_fraction" in raw_order:
            sell_fraction = parse_fraction(raw_order["sell_fraction"], "sell_fraction")
        if base_quantity is None and sell_fraction is None:
            raise SystemExit(f"Sell order needs base_quantity or sell_fraction: {instrument}")
        return PlannedOrder(
            exchange=exchange,
            instrument=instrument,
            side=side,
            quote_currency=quote_currency,
            quote_budget=None,
            base_quantity=base_quantity,
            sell_fraction=sell_fraction,
            min_quote_budget=min_quote_budget,
            source=source,
        )

    raise SystemExit(f"Unsupported side: {side}")


def parse_fraction(value: Any, field_name: str) -> Decimal:
    fraction = parse_decimal(value, field_name)
    if fraction > Decimal("1"):
        raise SystemExit(f"{field_name} must be <= 1: {value}")
    return fraction


def load_cli_orders(config: dict[str, Any], args: argparse.Namespace) -> list[PlannedOrder]:
    orders: list[PlannedOrder] = []
    for raw in args.buy:
        exchange, instrument, amount = split_cli_order(raw, "--buy")
        quote_currency = quote_currency_for_exchange(config, exchange)
        orders.append(
            PlannedOrder(
                exchange=exchange,
                instrument=instrument,
                side="buy",
                quote_currency=quote_currency,
                quote_budget=parse_decimal(amount, "cli_buy_quote_budget"),
                base_quantity=None,
                sell_fraction=None,
                min_quote_budget=exchange_min_quote_budget(config, exchange),
                source="manual",
            )
        )
    for raw in args.sell:
        exchange, instrument, fraction = split_cli_order(raw, "--sell")
        quote_currency = quote_currency_for_exchange(config, exchange)
        orders.append(
            PlannedOrder(
                exchange=exchange,
                instrument=instrument,
                side="sell",
                quote_currency=quote_currency,
                quote_budget=None,
                base_quantity=None,
                sell_fraction=parse_fraction(fraction, "cli_sell_fraction"),
                min_quote_budget=exchange_min_quote_budget(config, exchange),
                source="manual",
            )
        )
    return orders


def split_cli_order(raw: str, flag_name: str) -> tuple[str, str, str]:
    parts = raw.split(":")
    if len(parts) != 3:
        raise SystemExit(f"{flag_name} must look like EXCHANGE:INSTRUMENT:VALUE")
    return parts[0], parts[1], parts[2]


def quote_currency_for_exchange(config: dict[str, Any], exchange: str) -> str:
    exchange_config = config.get("exchanges", {}).get(exchange)
    if not exchange_config or not exchange_config.get("enabled", False):
        raise SystemExit(f"Exchange is not enabled in config: {exchange}")
    return str(exchange_config["quote_currency"])


def exchange_min_quote_budget(config: dict[str, Any], exchange: str) -> Decimal:
    exchange_config = config.get("exchanges", {}).get(exchange)
    if not exchange_config:
        raise SystemExit(f"Exchange is not enabled in config: {exchange}")
    return parse_decimal(
        exchange_config.get("default_min_quote_budget", "0.00000001"),
        f"{exchange}.default_min_quote_budget",
    )


def fetch_prices(
    config: dict[str, Any],
    planned: list[PlannedOrder],
    state: dict[str, Any],
    timeout: float,
) -> dict[tuple[str, str], Decimal]:
    prices: dict[tuple[str, str], Decimal] = {}
    instruments_by_exchange: dict[str, list[str]] = {}
    for order in planned:
        instruments_by_exchange.setdefault(order.exchange, []).append(order.instrument)
    for position_key, position in state.get("portfolio", {}).get("positions", {}).items():
        exchange, instrument = position_key.split(":", 1)
        if decimal_from_mapping(position, "quantity") > 0:
            instruments_by_exchange.setdefault(exchange, []).append(instrument)

    for exchange, instruments in instruments_by_exchange.items():
        unique_instruments = sorted(set(instruments))
        exchange_config = config["exchanges"][exchange]
        if exchange == "upbit":
            prices.update(fetch_upbit_prices(exchange_config["base_url"], unique_instruments, timeout))
        elif exchange == "binance":
            prices.update(fetch_binance_prices(exchange_config["base_url"], unique_instruments, timeout))
        else:
            raise SystemExit(f"Unsupported exchange: {exchange}")
    return prices


def fetch_upbit_prices(
    base_url: str, markets: list[str], timeout: float
) -> dict[tuple[str, str], Decimal]:
    if not markets:
        return {}
    url = f"{base_url.rstrip('/')}/v1/ticker"
    payload = http_get_json(url, {"markets": ",".join(markets)}, timeout)
    if not isinstance(payload, list):
        raise SystemExit("Unexpected Upbit ticker response.")
    prices: dict[tuple[str, str], Decimal] = {}
    for item in payload:
        market = str(item["market"])
        prices[("upbit", market)] = parse_decimal(item["trade_price"], f"upbit.{market}.price")
    return prices


def fetch_binance_prices(
    base_url: str, symbols: list[str], timeout: float
) -> dict[tuple[str, str], Decimal]:
    prices: dict[tuple[str, str], Decimal] = {}
    url = f"{base_url.rstrip('/')}/api/v3/ticker/price"
    for symbol in symbols:
        payload = http_get_json(url, {"symbol": symbol}, timeout)
        if not isinstance(payload, dict):
            raise SystemExit(f"Unexpected Binance ticker response for {symbol}.")
        prices[("binance", str(payload["symbol"]))] = parse_decimal(
            payload["price"], f"binance.{symbol}.price"
        )
        time.sleep(0.05)
    return prices


def http_get_json(url: str, params: dict[str, str], timeout: float) -> Any:
    full_url = f"{url}?{urlencode(params)}"
    request = Request(
        full_url,
        headers={"accept": "application/json", "user-agent": "codex-paper-bot/0.2"},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return json.loads(response.read().decode(charset))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {exc.code} from {url}: {detail}") from exc
    except URLError as exc:
        raise SystemExit(f"Network error from {url}: {exc.reason}") from exc


def simulate_orders(
    planned_orders: list[PlannedOrder],
    prices: dict[tuple[str, str], Decimal],
    config: dict[str, Any],
    strategy_name: str,
    now: datetime,
    state: dict[str, Any],
    dedupe_per_day: bool,
    force: bool,
) -> list[SimulatedOrder]:
    simulated: list[SimulatedOrder] = []
    simulated_keys = set(state.get("simulated_keys", []))
    today = now.date().isoformat()
    timestamp = now.isoformat(timespec="seconds")

    for order in planned_orders:
        state_key = f"{today}:{strategy_name}:{order.exchange}:{order.instrument}:{order.side}"
        if order.source == "config" and dedupe_per_day and not force and state_key in simulated_keys:
            simulated.append(skipped_order(timestamp, strategy_name, order, "already simulated today; use --force to repeat"))
            continue

        price = prices.get((order.exchange, order.instrument))
        if price is None:
            simulated.append(skipped_order(timestamp, strategy_name, order, "price unavailable"))
            continue

        if order.side == "buy":
            result = simulate_buy(timestamp, strategy_name, order, price, config, state)
        else:
            result = simulate_sell(timestamp, strategy_name, order, price, config, state)

        simulated.append(result)
        if result.status == "simulated" and order.source == "config":
            simulated_keys.add(state_key)

    state["simulated_keys"] = sorted(simulated_keys)
    return simulated


def simulate_buy(
    timestamp: str,
    strategy_name: str,
    order: PlannedOrder,
    price: Decimal,
    config: dict[str, Any],
    state: dict[str, Any],
) -> SimulatedOrder:
    fee_rate = exchange_decimal(config, "fee_rate", order.exchange)
    slippage_pct = exchange_decimal(config, "slippage_pct", order.exchange)
    quote_budget = order.quote_budget or Decimal("0")
    fee = (quote_budget * fee_rate).quantize(DECIMAL_PLACES, rounding=ROUND_DOWN)
    cash_required = quote_budget + fee
    cash_key = cash_state_key(order.exchange, order.quote_currency)
    cash_before = state_decimal(state, ["portfolio", "cash", cash_key])

    if quote_budget < order.min_quote_budget:
        return skipped_order(timestamp, strategy_name, order, "buy amount below minimum")
    if cash_before < cash_required:
        return skipped_order(timestamp, strategy_name, order, "insufficient virtual cash")

    effective_price = price * (Decimal("1") + slippage_pct)
    quantity = (quote_budget / effective_price).quantize(DECIMAL_PLACES, rounding=ROUND_DOWN)
    position_key = position_state_key(order.exchange, order.instrument)
    position = ensure_position(state, position_key)

    cash_after = cash_before - cash_required
    position_quantity = decimal_from_mapping(position, "quantity")
    cost_basis = decimal_from_mapping(position, "cost_basis")
    position_after = position_quantity + quantity
    position["quantity"] = format_decimal(position_after)
    position["cost_basis"] = format_decimal(cost_basis + cash_required)
    set_state_decimal(state, ["portfolio", "cash", cash_key], cash_after)

    return SimulatedOrder(
        timestamp=timestamp,
        strategy=strategy_name,
        exchange=order.exchange,
        instrument=order.instrument,
        side=order.side,
        quote_currency=order.quote_currency,
        requested_quote_budget=quote_budget,
        executed_quote_value=quote_budget,
        fee=fee,
        slippage_pct=slippage_pct,
        price=price,
        effective_price=effective_price,
        base_quantity=quantity,
        cash_after=cash_after,
        position_after=position_after,
        realized_pnl=Decimal("0"),
        dry_run=True,
        status="simulated",
        note="paper buy; no real order sent",
    )


def simulate_sell(
    timestamp: str,
    strategy_name: str,
    order: PlannedOrder,
    price: Decimal,
    config: dict[str, Any],
    state: dict[str, Any],
) -> SimulatedOrder:
    fee_rate = exchange_decimal(config, "fee_rate", order.exchange)
    slippage_pct = exchange_decimal(config, "slippage_pct", order.exchange)
    position_key = position_state_key(order.exchange, order.instrument)
    position = ensure_position(state, position_key)
    available = decimal_from_mapping(position, "quantity")

    if available <= 0:
        return skipped_order(timestamp, strategy_name, order, "no virtual position to sell")

    quantity = order.base_quantity
    if quantity is None and order.sell_fraction is not None:
        quantity = (available * order.sell_fraction).quantize(DECIMAL_PLACES, rounding=ROUND_DOWN)
    if quantity is None or quantity <= 0:
        return skipped_order(timestamp, strategy_name, order, "sell quantity is zero")
    if quantity > available:
        return skipped_order(timestamp, strategy_name, order, "insufficient virtual position")

    effective_price = price * (Decimal("1") - slippage_pct)
    quote_value = (quantity * effective_price).quantize(DECIMAL_PLACES, rounding=ROUND_DOWN)
    if quote_value < order.min_quote_budget:
        return skipped_order(timestamp, strategy_name, order, "sell amount below minimum")

    fee = (quote_value * fee_rate).quantize(DECIMAL_PLACES, rounding=ROUND_DOWN)
    cash_received = quote_value - fee
    cost_basis = decimal_from_mapping(position, "cost_basis")
    average_cost = cost_basis / available if available > 0 else Decimal("0")
    removed_cost = (average_cost * quantity).quantize(DECIMAL_PLACES, rounding=ROUND_DOWN)
    realized_pnl = cash_received - removed_cost

    cash_key = cash_state_key(order.exchange, order.quote_currency)
    cash_after = state_decimal(state, ["portfolio", "cash", cash_key]) + cash_received
    position_after = available - quantity
    position["quantity"] = format_decimal(position_after)
    position["cost_basis"] = format_decimal(max(cost_basis - removed_cost, Decimal("0")))
    previous_realized = decimal_from_mapping(position, "realized_pnl")
    position["realized_pnl"] = format_decimal(previous_realized + realized_pnl)
    set_state_decimal(state, ["portfolio", "cash", cash_key], cash_after)

    return SimulatedOrder(
        timestamp=timestamp,
        strategy=strategy_name,
        exchange=order.exchange,
        instrument=order.instrument,
        side=order.side,
        quote_currency=order.quote_currency,
        requested_quote_budget=quote_value,
        executed_quote_value=quote_value,
        fee=fee,
        slippage_pct=slippage_pct,
        price=price,
        effective_price=effective_price,
        base_quantity=quantity,
        cash_after=cash_after,
        position_after=position_after,
        realized_pnl=realized_pnl,
        dry_run=True,
        status="simulated",
        note="paper sell; no real order sent",
    )


def skipped_order(
    timestamp: str, strategy_name: str, order: PlannedOrder, note: str
) -> SimulatedOrder:
    return SimulatedOrder(
        timestamp=timestamp,
        strategy=strategy_name,
        exchange=order.exchange,
        instrument=order.instrument,
        side=order.side,
        quote_currency=order.quote_currency,
        requested_quote_budget=order.quote_budget or Decimal("0"),
        executed_quote_value=Decimal("0"),
        fee=Decimal("0"),
        slippage_pct=Decimal("0"),
        price=Decimal("0"),
        effective_price=Decimal("0"),
        base_quantity=Decimal("0"),
        cash_after=Decimal("0"),
        position_after=Decimal("0"),
        realized_pnl=Decimal("0"),
        dry_run=True,
        status="skipped",
        note=note,
    )


def build_equity_rows(
    state: dict[str, Any],
    config: dict[str, Any],
    prices: dict[tuple[str, str], Decimal],
    now: datetime,
) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    timestamp = now.isoformat(timespec="seconds")
    portfolio = state.get("portfolio", {})
    positions = portfolio.get("positions", {})
    cash = portfolio.get("cash", {})

    for exchange_name, exchange_config in config.get("exchanges", {}).items():
        if not exchange_config.get("enabled", False):
            continue
        quote_currency = str(exchange_config["quote_currency"])
        cash_key = cash_state_key(exchange_name, quote_currency)
        cash_balance = parse_decimal(cash.get(cash_key, "0"), cash_key, allow_zero=True)
        position_value = Decimal("0")
        cost_basis = Decimal("0")

        for position_key, position in positions.items():
            exchange, instrument = position_key.split(":", 1)
            if exchange != exchange_name:
                continue
            quantity = decimal_from_mapping(position, "quantity")
            price = prices.get((exchange_name, instrument))
            if price is None:
                continue
            position_value += quantity * price
            cost_basis += decimal_from_mapping(position, "cost_basis")

        total_equity = cash_balance + position_value
        unrealized_pnl = position_value - cost_basis
        rows.append(
            {
                "timestamp": timestamp,
                "exchange": exchange_name,
                "quote_currency": quote_currency,
                "cash": format_decimal(cash_balance),
                "position_value": format_decimal(position_value),
                "total_equity": format_decimal(total_equity),
                "unrealized_pnl": format_decimal(unrealized_pnl),
            }
        )

    state["last_equity"] = rows
    return rows


def write_orders(path: Path, orders: list[SimulatedOrder]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    file_exists = path.exists()
    with path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
        if not file_exists:
            writer.writeheader()
        for order in orders:
            writer.writerow(order.as_csv_row())


def write_equity(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    file_exists = path.exists()
    with path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=EQUITY_COLUMNS)
        if not file_exists:
            writer.writeheader()
        for row in rows:
            writer.writerow(row)


def print_summary(
    orders: list[SimulatedOrder],
    equity_rows: list[dict[str, str]],
    trades_path: Path,
    equity_path: Path,
    state_path: Path,
) -> None:
    simulated = [order for order in orders if order.status == "simulated"]
    skipped = [order for order in orders if order.status == "skipped"]
    print("PAPER-TRADING SUMMARY")
    print(f"- simulated: {len(simulated)}")
    print(f"- skipped: {len(skipped)}")
    for order in orders:
        if order.status == "simulated":
            print(
                "- {exchange} {instrument} {side} value={value} {currency} "
                "price={price} qty={quantity} cash_after={cash}".format(
                    exchange=order.exchange,
                    instrument=order.instrument,
                    side=order.side.upper(),
                    value=format_decimal(order.executed_quote_value),
                    currency=order.quote_currency,
                    price=format_decimal(order.effective_price),
                    quantity=format_decimal(order.base_quantity),
                    cash=format_decimal(order.cash_after),
                )
            )
        else:
            print(f"- {order.exchange} {order.instrument} skipped: {order.note}")
    for row in equity_rows:
        print(
            "- equity {exchange}: cash={cash} positions={positions} total={total} {currency}".format(
                exchange=row["exchange"],
                cash=row["cash"],
                positions=row["position_value"],
                total=row["total_equity"],
                currency=row["quote_currency"],
            )
        )
    print(f"- trades: {trades_path}")
    print(f"- equity: {equity_path}")
    print(f"- state: {state_path}")


def exchange_decimal(config: dict[str, Any], field: str, exchange: str) -> Decimal:
    value = config.get("portfolio", {}).get(field, {}).get(exchange, "0")
    return parse_decimal(value, f"{field}.{exchange}", allow_zero=True)


def ensure_position(state: dict[str, Any], position_key: str) -> dict[str, str]:
    positions = state.setdefault("portfolio", {}).setdefault("positions", {})
    return positions.setdefault(
        position_key,
        {"quantity": "0", "cost_basis": "0", "realized_pnl": "0"},
    )


def state_decimal(state: dict[str, Any], path: list[str]) -> Decimal:
    current: Any = state
    for part in path:
        current = current[part]
    return parse_decimal(current, ".".join(path), allow_zero=True)


def set_state_decimal(state: dict[str, Any], path: list[str], value: Decimal) -> None:
    current: Any = state
    for part in path[:-1]:
        current = current[part]
    current[path[-1]] = format_decimal(value)


def decimal_from_mapping(mapping: dict[str, Any], key: str) -> Decimal:
    return parse_decimal(
        mapping.get(key, "0"),
        key,
        allow_zero=True,
        allow_negative=(key == "realized_pnl"),
    )


def cash_state_key(exchange: str, quote_currency: str) -> str:
    return f"{exchange}:{quote_currency}"


def position_state_key(exchange: str, instrument: str) -> str:
    return f"{exchange}:{instrument}"


def format_decimal(value: Decimal) -> str:
    return format(value.normalize(), "f")


if __name__ == "__main__":
    sys.exit(main())
