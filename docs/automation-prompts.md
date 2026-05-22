# Codex 자동화 프롬프트 모음

이 문서는 다른 컴퓨터나 다른 Codex 세션에서 Coinsoup 모의투자를 이어갈 때 그대로 붙여넣기 위한 프롬프트입니다.

## 기본 원칙

- 로컬 봇은 실행자입니다: 가격 수집, 차트 계산, 모의 주문, 손익 기록, 대시보드 업데이트를 맡습니다.
- Codex는 감독자입니다: 로그, 포지션, 손익, 신호 품질, 위험 상태를 해석하고 수정안을 제안합니다.
- 실제 주문, 실거래 API 호출, API 키 생성/수정, 출금, 레버리지 실주문은 금지입니다.
- 전략 설정 파일을 바꾸기 전에는 변경 내용을 요약하고 사용자 승인을 먼저 받아야 합니다.
- Binance 플러그인은 public read-only 차트 확인에만 사용합니다.

## 새 컴퓨터에서 시작 프롬프트

Codex를 clone 받은 저장소 폴더에서 열고 아래를 붙여넣습니다.

```text
이 프로젝트는 Coinsoup TEST MODE 모의투자 대시보드야.

프로젝트 위치는 현재 작업 폴더이고, 실거래는 절대 금지야.

먼저 아래를 확인해줘.
- git 상태
- README.md와 docs/automation-prompts.md
- dryrun_config.json의 paper/dry_run/live_trading 잠금
- data 폴더가 있으면 현재 paper 상태

그리고 로컬 실행 상태를 점검해줘.
- 대시보드 서버가 켜져 있는지
- 자동화 루프가 켜져 있는지
- http://127.0.0.1:8788 접속 가능한지

필요하면 대시보드와 자동화 루프 실행 명령을 알려줘.
실제 주문, API 키 변경, 출금, 실거래 레버리지 주문은 하지 마.
```

## 대시보드 실행 프롬프트

```text
Coinsoup 대시보드를 실행해줘.

조건:
- 작업 폴더에서 실행
- 포트는 8788
- 기존 프로세스가 있으면 상태를 확인하고, 필요할 때만 로컬 대시보드 프로세스를 재시작
- 실거래/API 키/출금 기능은 절대 건드리지 말 것

실행 후 http://127.0.0.1:8788 로 접속 가능한지 확인해줘.
```

직접 실행 명령:

```powershell
python .\paper_app.py --port 8788
```

또는:

```powershell
.\scripts\start_dashboard.ps1 -Port 8788
```

## 로컬 자동화 루프 실행 프롬프트

```text
Coinsoup 로컬 자동화 루프를 실행해줘.

역할:
- 로컬 봇이 가격/차트/모의주문/포트폴리오 스냅샷을 업데이트
- Codex는 실행 결과를 감독하고 해석

조건:
- --tasks due 기준
- TEST MODE / paper only 유지
- 실제 주문, 실거래 API 호출, API 키 변경, 출금, 레버리지 실주문 금지
- 실행 후 data/automation_status.json, data/codex_supervisor_status.json, data/paper_equity.csv 갱신 여부 확인
```

직접 실행 명령:

```powershell
python .\automation_runner.py --loop --tasks due
```

3시간만 실행:

```powershell
python .\automation_runner.py --loop --tasks due --duration-minutes 180
```

## Codex 관리감독 자동화 프롬프트

Codex 자동화나 heartbeat에 넣을 기본 프롬프트입니다.

```text
Inspect the current Coinsoup project as the Codex management supervisor for the active TEST MODE Binance Futures paper leverage session.

Treat the local bot as the executor/data producer and Codex as the reviewer/interpreter.

Every check MUST use the Binance plugin's public read-only Futures kline tools for BTCUSDT, ETHUSDT, XRPUSDT, and SOLUSDT, at minimum on 15m and 1h. Use local files only as the bot's reported state.

Read these local files when present:
- data/codex_supervisor_status.json
- data/no_entry_lock.json
- data/trigger_events.jsonl
- data/automation_status.json
- data/paper_trades.csv
- data/paper_equity.csv
- data/snapshots/last_futures_paper_result.json
- data/snapshots/dashboard_snapshot.json

Summarize in Korean only the important changes since the last check:
- whether the local automation loop is alive
- supervisor severity
- no-entry lock status
- Binance Futures multi-timeframe signal quality for BTC/ETH/XRP/SOL
- disagreement between plugin analysis and local bot choice
- fresh trigger events
- paper futures opens/closes/holds
- current positions with side/leverage/margin
- equity/PnL/fees
- safety violations
- stale data
- recommended next action

If strategy settings such as leverage, symbol choice, margin %, take-profit, stop-loss, min score, or long/short permission should change, provide a concise proposed setting change and rationale, but do not edit strategy/config files until the user approves.

Do not execute real orders, do not call live-trading APIs, do not create or modify API keys, do not enable withdrawals, do not place leveraged live orders, and do not change strategy/config files without user approval.
```

## 시간별 자동화 요청 예시

Codex에 자동화를 새로 만들 때는 아래처럼 요청합니다.

```text
Codex 자동화를 만들어줘.

프로젝트 위치:
현재 Coinsoup 작업 폴더

자동화 주기:
- 매시간 정각: 로컬 봇 상태 점검과 요약
- 매일 오전 9시 10분 KST: 일봉 기준 수익률/리스크/전략 상태 상세 요약

Codex 역할:
- 로컬 봇이 정상 작동했는지 확인
- 최근 로그, 수익률, 포지션, 에러, 신호 품질 요약
- Binance 플러그인 public read-only Futures kline으로 BTCUSDT/ETHUSDT/XRPUSDT/SOLUSDT의 15m/1h를 직접 확인
- 로컬 봇 판단과 플러그인 차트 판단이 다르면 차이를 설명
- 시장 국면 변화와 리스크 상태 해석
- 전략 수정이 필요하면 수정안만 제안

중요 제한:
- 실제 주문 금지
- 실거래 API 호출 금지
- API 키 생성/수정 금지
- 출금 관련 기능 금지
- 레버리지 실주문 금지
- 설정 변경은 사용자 승인 전에는 적용하지 말 것
```

## 3시간 모의투자 시작 프롬프트

```text
지금부터 Coinsoup TEST MODE로 3시간 Binance Futures paper leverage 모의투자를 시작해줘.

조건:
- 시드 100만원 기준
- BTCUSDT, ETHUSDT, XRPUSDT, SOLUSDT 관찰
- 기본 레버리지는 paper 3x, 비교값은 5x
- 실거래는 절대 금지
- 로컬 봇은 모의 주문과 손익 기록만 수행
- Codex는 관리감독과 해석만 수행
- 대시보드에서 평단 확인선과 매매 마커가 보이게 유지

시작 전 확인:
- dry_run true
- paper_mode true
- live_trading false
- withdrawals false
- no real API keys required

시작 후 확인:
- data/paper_trades.csv
- data/paper_equity.csv
- data/automation_status.json
- data/snapshots/last_futures_paper_result.json
```

## 문제 점검 프롬프트

```text
Coinsoup 상태를 점검해줘.

확인할 것:
- 대시보드가 8788에서 열리는지
- 자동화 루프 pid가 살아있는지
- data/paper_equity.csv가 최근 5분 안에 갱신됐는지
- data/paper_trades.csv에 이상한 중복 주문이 있는지
- data/no_entry_lock.json이 켜져 있는지
- data/codex_supervisor_status.json severity가 WARN/CRIT인지
- Binance 플러그인 차트 확인과 로컬 봇 판단이 충돌하는지

결과는 한국어로 짧게 요약해줘.
수정이 필요하면 먼저 변경안을 말하고, 설정 파일은 승인 전까지 바꾸지 마.
```

## GitHub 공유 시 제외할 것

GitHub에는 보통 아래 파일을 올리지 않습니다.

- `data/`
- `.env`
- 로그 파일
- pid 파일
- 개인 API 키나 계정 정보

현재 `.gitignore`는 위 실행 산출물을 제외하도록 설정되어 있습니다.
