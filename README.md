<img src="https://github.com/tripolskypetr/backtest-kit/raw/refs/heads/master/assets/consciousness.svg" height="45px" align="right">

# 🧿 backtest-news-claims

> A self-enforcing runtime for a trading agent, built on [backtest-kit](https://github.com/tripolskypetr/backtest-kit): LLM agents read market articles, extract the author's price claims, check those claims against closed candles and decide on trades themselves. The runtime only feeds them data without look-ahead, executes their answers, holds the exchange stop and validates every response. The benchmark is simply holding BTC.

![screenshot](https://raw.githubusercontent.com/tripolskypetr/backtest-kit/HEAD/assets/screenshots/screenshot16.png)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/tripolskypetr/backtest-kit)
[![npm](https://img.shields.io/npm/v/backtest-kit.svg?style=flat-square)](https://npmjs.org/package/backtest-kit)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)]()
[![Build](https://github.com/tripolskypetr/backtest-kit/actions/workflows/webpack.yml/badge.svg)](https://github.com/tripolskypetr/backtest-kit/actions/workflows/webpack.yml)

Market commentary is full of statements like "if BTC closes above $78,250, the path opens toward $79,500". This repo trades exactly those statements: not the mood of an article, but the specific prices its author names.

- **Claims, not sentiment.** An agent extracts only statements where the author ties a named price to the next move, each with a verbatim quote. News, moods and forecasts without a price are dropped.
- **Candles, not indicators.** Agents look at what price actually did at the author's level, in closed candle files. Nothing is confirmed by a moving average or RSI.
- **No look-ahead by design.** Agents work with what the runtime gives them: the article published by that moment, and CSV files of candles already closed by then, read through `bash`.
- **The agent decides, the code executes.** Entry and exit are agent decisions. Code feeds data without look-ahead, executes answers, holds the exchange stop and validates every response.
- **Every run replays from cache.** Model answers are stored per month, so a finished run can be repeated without new requests.

Multi-month backtests are the next step, and results will be published here once they are complete. A result counts only when it beats holding BTC after costs.

📚 **[Architecture](ARCHITECTURE.md)** | 🤖 **[Agents](docs/AGENT.md)** | 🗂️ **[Dataset](docs/DATASET.md)** | ⚙️ **[Runtime](docs/RUNTIME.md)** | 📦 **[Run output](docs/DUMP.md)**


## 🚀 Quick Start

**1. Start the agent runtime.** Put your Ollama key in `.env`:

```bash
cd docker/agent
cp .env.example .env
docker compose up -d
cd ../..
```

**2. Download the articles** to `assets/wwwroot.jsonl`:

```bash
./scripts/linux/fetch_dataset.sh     # Windows: scripts\windows\fetch_dataset.bat
```

**3. Run a backtest.** Each month has its own folder under `content/`:

```bash
npm start -- --backtest --ui --entry ./content/sep_2026/main.strategy.ts

# all months from January 2025 to October 2026, in order
./scripts/linux/run_backtest.sh      # Windows: scripts\windows\run_backtest.bat
```

A run spends model requests through your key: about 230 per month, depending on how long a position stays open. A full run over 22 months is roughly 5,000 requests and 28 hours.


## 🎯 What Gets Traded

A **claim** is the author's own statement linking a price they name to the move that follows. It is not a take-profit order.

| Is a claim | Is not a claim |
|---|---|
| "A stronger bullish case opens if BTC can close and hold above $78,250" | Institutional buying supports the market |
| "Below $76,750, the short-term structure weakens" | The Fear & Greed index is at 69 |

A claim is confirmed by candles: the agent looks at what price did at the author's level. Agents do not compute moving averages, RSI, VWAP, ATR or other indicators to confirm a claim, and the author's overall sentiment is never traded.

An article stays valid for 7 days. A new BTC article replaces it and resets the clock, and with no article in the last 7 days there is nothing to trade.


## 🤖 Four Agents

| # | Agent | Runs | Input | Answer |
|---|---|---|---|---|
| 1 | Claims | Once per article | Article text | Claims with direction, price and verbatim quote |
| 2 | Entry | Daily with no position; every 4 hours with one, until a new article's claim is confirmed | Claims, candle files | Confirmed claim `id` and `long`, `short` or `wait` |
| 3 | Exit | Every 4 hours with a position | Position claims, position data, candle files | `hold` or `close` |
| 4 | Review | Once per new article with a position, after its claim is confirmed | Confirmed claim, position data, candle files | `hold` or `close` |

Every answer also carries `description`, shown in the backtest-kit UI, and `reasoning`, which says what data the agent lacked. Read `reasoning` before changing a prompt.

Code stays out of trading decisions. It feeds data, executes answers and sets a 7.5% exchange stop. It also checks each answer against its schema, drops any claim whose price is missing from a verbatim quote, and caches answers.


## 🗂️ Data

The articles come from the [investinglive-crypto](https://huggingface.co/datasets/tripolskypetr/investinglive-crypto) dataset: 202 articles from [investingLive](https://investinglive.com) with publication times, of which BTC-titled articles are used.

- **Coverage:** 2 to 9 BTC articles per month in 2025 and 4 to 14 in 2026. Thin months give weak conclusions.

Candles come from Binance spot through `ccxt`. Authors sometimes name CME futures levels, which can differ slightly from spot.


## 📜 Summary

| Aspect | This repo |
|---|---|
| **Subject** | Author price claims from market articles, checked against closed BTCUSDT candles |
| **Model** | `deepseek-v4.1-flash` via [agent-runtime](https://github.com/tripolskypetr/agent-runtime) on Ollama |
| **Execution** | Agent-driven entry and exit, 7.5% exchange stop, no position time limit |
| **Benchmark** | Holding BTC over the same period, after costs |
| **Status** | Months from January 2025 to October 2026 are set up; multi-month backtests are the next step |
| **Playbook** | [CLAUDE.md](CLAUDE.md): project rules, including no fitting to one month and no invented indicators |
