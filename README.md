# Binance + Upbit Paper Trading Supervisor

Binance public market data와 Upbit KRW 가격 데이터를 사용해서 BTC, ETH, XRP, SOL을 가상으로 매매하는 로컬 TEST MODE 프로젝트입니다.

이 프로젝트는 **실거래 봇이 아닙니다.** API 키를 읽지 않고, 실제 주문/출금/레버리지 주문을 전송하는 코드도 없습니다. 현재 목적은 차트 기반 모의투자와 Codex 관리감독 로직을 검증하는 것입니다.

## 핵심 기능

- 로컬 대시보드: 포트폴리오, 손익, 신호, 지지/저항, 최근 가상 주문 확인
- Binance 기반 멀티타임프레임 감독: `5m`, `15m`, `1h`, `4h`, `1d`, `1w`
- Upbit KRW 기준 가상 포트폴리오: 시작 시드 1,000,000 KRW
- 차트 기반 공격형 TEST 매매: 지지선 반등, 돌파, 저항선 거리, RSI, 거래량 확인
- 가상 익절/손절 관리: 부분 익절, 수익 보호, 방어청산
- Codex 자동화 감독: 주기적으로 로그/손익/위험/신호 품질 요약

## 안전 제한

반드시 아래 상태를 유지해야 합니다.

- `dry_run`: `true`
- `execution.mode`: `paper`
- `execution.live_trading`: `false`
- API 키 생성/수정 금지
- 실제 주문 금지
- 출금 기능 금지
- 레버리지 실주문 금지

실거래를 붙일 경우에는 이 프로젝트에 바로 섞지 말고, 별도 executor와 명시적인 승인 플로우를 만들어야 합니다.

## 프로젝트 구조

```text
.
├─ paper_app.py              # 로컬 대시보드 서버와 차트 기반 가상매매 로직
├─ automation_runner.py      # 주기 실행, 감독 스냅샷, 자동화 루프
├─ dryrun_bot.py             # 가상 주문 체결, 포트폴리오 상태, 손익 기록
├─ dryrun_config.json        # 전략/리스크/자동화 설정
├─ web/
│  ├─ index.html
│  ├─ app.js
│  └─ styles.css
├─ scripts/
│  ├─ start_dashboard.ps1
│  ├─ run_automation_once.ps1
│  ├─ run_automation_loop.ps1
│  ├─ install_windows_tasks.ps1
│  └─ uninstall_windows_tasks.ps1
└─ data/                     # 실행 중 생성되는 로그/스냅샷/가상계좌 상태
```

`data/`는 실행 결과물이므로 GitHub에는 올리지 않는 것을 기본으로 합니다.

## 필요 환경

- Windows PowerShell
- Python 3.11 이상
- 인터넷 연결
- 별도 pip 패키지 없음. 현재 코드는 Python 표준 라이브러리 중심으로 동작합니다.

## 처음 실행

PowerShell에서 프로젝트 폴더로 이동합니다.

```powershell
cd C:\Users\SSAFY\Desktop\binace
```

대시보드를 실행합니다.

```powershell
python .\paper_app.py --port 8788
```

브라우저에서 엽니다.

```text
http://127.0.0.1:8788
```

## 자동화 루프 실행

한 번만 감독/대시보드/지지저항 스냅샷을 갱신하려면:

```powershell
python .\automation_runner.py --tasks dashboard,levels,supervisor,chart,status
```

3시간 TEST 세션을 루프로 돌리려면:

```powershell
python .\automation_runner.py --loop --tasks due --duration-minutes 180
```

PowerShell 스크립트로 실행하려면:

```powershell
.\scripts\start_dashboard.ps1 -Port 8788
.\scripts\run_automation_loop.ps1 -Tasks due
```

스크립트 실행이 막히면 한 번만 허용합니다.

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

또는 우회 실행:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run_automation_once.ps1
```

## Windows 작업 스케줄러 등록

로그온 시 대시보드와 자동화 루프를 자동 시작하려면:

```powershell
.\scripts\install_windows_tasks.ps1 -Port 8788
Start-ScheduledTask -TaskName "RGCA-L Dashboard"
Start-ScheduledTask -TaskName "RGCA-L Automation Loop"
```

삭제:

```powershell
.\scripts\uninstall_windows_tasks.ps1
```

## 현재 차트 기반 TEST 매매 설정

주요 설정 위치: `dryrun_config.json`의 `strategy.automation`

```json
{
  "chart_trade_test_enabled": true,
  "chart_trade_check_minutes": 5,
  "chart_trade_strategy_name": "chart_aggressive_test",
  "chart_trade_buy_budget_krw": "100000",
  "chart_trade_max_candidates": 4,
  "chart_trade_asset_cap_krw": "250000",
  "chart_trade_cash_reserve_krw": "200000",
  "chart_trade_reentry_cooldown_minutes": 15,
  "chart_trade_take_profit_pct": "1.2",
  "chart_trade_runner_take_profit_pct": "2.4",
  "chart_trade_stop_loss_pct": "-1.6",
  "chart_trade_hard_stop_loss_pct": "-3.0",
  "chart_trade_partial_sell_fraction": "0.5"
}
```

의미:

- 종목당 진입 단위: 100,000 KRW
- 종목당 최대 보유 한도: 250,000 KRW
- 최소 현금 보유: 200,000 KRW
- 같은 종목 재진입 쿨다운: 15분
- +1.2% 부근부터 부분 익절 검토
- +2.4% 이상이면 수익 보호성 부분청산
- -1.6% 부근에서 단기 차트가 무너지면 방어청산
- -3.0%는 강한 방어청산

차트의 목표선/손실 제한선은 고정 퍼센트만 쓰지 않고, 현재가와 ATR 기준 최소 폭을 둡니다. 가까운 저항선은 별도로 표시하고, 실제 목표선은 너무 붙지 않도록 한 번 더 넓혀 보여줍니다.

## Binance Futures 레버리지 TEST

실제 선물 주문은 잠겨 있고, 대시보드는 Binance Futures 차트 기준으로 가상 레버리지 폭만 보여줍니다.

```json
{
  "paper_leverage_test": {
    "enabled": true,
    "dry_run_only": true,
    "default_leverage": 3,
    "compare_leverage": 5,
    "max_leverage": 5
  }
}
```

- `3x`: 기본 비교값
- `5x`: 공격 비교값
- 화면의 목표폭/손절폭은 현재 Binance Futures 차트의 목표가와 손실 제한가를 레버리지 배수로 환산한 값입니다.
- 이 기능은 paper-only이며 실주문, 레버리지 설정 변경, API 키 변경을 하지 않습니다.

## 관리감독 로직

자동화 루프는 `automation_runner.py`에서 관리합니다.

1. 30초마다 루프가 깨어납니다.
2. 5분마다 Binance 기준 멀티타임프레임 감독 스냅샷을 만듭니다.
3. BTC, ETH, XRP, SOL 각각에 대해 EMA, RSI, 거래량, 지지/저항 거리, 시간봉 정렬을 계산합니다.
4. 실거래 잠금 위반, 출금 활성화, paper mode 위반, 급락/과열 위험이 있으면 `data/no_entry_lock.json`으로 신규 진입을 막습니다.
5. `paper_app.py`의 `handle_run_chart_trade_test()`가 차트 기반 가상 진입/청산 판단을 수행합니다.
6. 결과는 `data/paper_trades.csv`, `data/paper_equity.csv`, `data/snapshots/last_chart_trade_result.json`에 기록됩니다.

## 가상 주문 직접 실행

기본 계획 실행:

```powershell
python .\dryrun_bot.py
```

가상 매수:

```powershell
python .\dryrun_bot.py --buy upbit:KRW-BTC:5000
```

가상 매도:

```powershell
python .\dryrun_bot.py --sell upbit:KRW-BTC:0.25
```

같은 날 config 기반 주문을 강제로 한 번 더 실행:

```powershell
python .\dryrun_bot.py --force
```

## 주요 출력 파일

- `data/paper_trades.csv`: 가상 주문 로그
- `data/paper_equity.csv`: 평가금액/손익 스냅샷
- `data/dryrun_state.json`: 가상 현금, 포지션, 실현손익, 중복방지 상태
- `data/codex_supervisor_status.json`: 최신 관리감독 상태
- `data/no_entry_lock.json`: 신규 진입 잠금 상태
- `data/trigger_events.jsonl`: 감독 이벤트 로그
- `data/snapshots/last_chart_trade_result.json`: 최신 차트 매매 판단 결과
- `data/automation_status.json`: 최신 자동화 실행 결과

## 다른 컴퓨터에서 실행

1. Python 3.11 이상 설치
2. 이 저장소를 clone
3. PowerShell에서 저장소 폴더로 이동
4. 대시보드와 자동화 루프를 각각 실행

```powershell
git clone https://github.com/whtjddlr/coinsoup.git coinsoup
cd .\coinsoup
```

첫 번째 PowerShell:

```powershell
python .\paper_app.py --port 8788
```

두 번째 PowerShell:

```powershell
python .\automation_runner.py --loop --tasks due
```

대시보드:

```text
http://127.0.0.1:8788
```

기존 가상계좌 상태까지 옮기려면 `data/dryrun_state.json`, `data/paper_trades.csv`, `data/paper_equity.csv`를 별도로 복사합니다. 단, 일반적인 GitHub 공유에는 이 파일들을 올리지 않는 것을 권장합니다.

## 다른 장소에서 Codex로 이어서 하기

새 컴퓨터에서 Codex를 열 때 작업 폴더를 clone 받은 `coinsoup` 폴더로 선택합니다. 그런 다음 아래 순서로 진행합니다.

1. `python .\paper_app.py --port 8788`로 대시보드 실행
2. `python .\automation_runner.py --loop --tasks due`로 로컬 자동화 실행
3. 브라우저에서 `http://127.0.0.1:8788` 열기
4. Codex에 [docs/automation-prompts.md](docs/automation-prompts.md)의 프롬프트를 붙여넣기

역할 분리는 계속 유지합니다.

- 로컬 봇: 가격 수집, 차트 계산, 가상 주문, 손익/포지션 기록, 대시보드 업데이트
- Codex: 관리감독, 로그/손익/포지션 해석, Binance 플러그인 기반 차트 재검토, 설정 변경 제안

Codex는 실제 주문, API 키 변경, 출금, 레버리지 실주문을 하면 안 됩니다. 전략 설정 파일을 바꿀 때도 먼저 변경안을 요약하고 사용자 승인을 받아야 합니다.

## 차트 화면 사용법

차트 상단의 라인 버튼으로 화면 복잡도를 줄일 수 있습니다.

- `평단`: 보유 포지션의 평균 진입가 확인선
- `지지저항`: 현재 차트 기준 주요 지지선/저항선
- `손절목표`: 모의 포지션의 손실 제한선과 수익 목표선
- `매매`: 차트에 찍힌 가상 매수/매도/청산 마커
- `이평`: EMA20, EMA50, MA200
- `자석`: 지지/저항 주변 완충 구간
- `보조선`: 추가 지지/저항 후보

선물 모의투자에서는 `평단`과 `매매`를 켜두는 것이 가장 보기 쉽습니다. 숏 진입은 캔들 위 빨간 아래화살표, 롱/현물 매수는 캔들 아래 초록 위화살표, 청산은 노란 원형 마커로 표시됩니다.

## GitHub 업로드 예시

이미 GitHub 저장소가 있고 `gh`가 설치/로그인되어 있다면:

```powershell
git init
git add README.md .gitignore *.py dryrun_config.json web scripts
git commit -m "document paper trading supervisor"
git branch -M main
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

GitHub CLI 설치 확인:

```powershell
gh --version
gh auth status
```

현재 폴더를 바로 공개 저장소로 올리기 전에는 `data/`, `__pycache__/`, 로그, pid 파일이 포함되지 않았는지 반드시 확인하세요.
