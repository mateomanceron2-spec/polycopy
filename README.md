# 🤖 Polymarket Copytrading Bot

**Production-ready automated copytrading bot for Polymarket**

## ⚡ Quick Start

### 1. Install
```bash
npm install
```

### 2. Setup
```bash
npm run setup
```

### 3. Build & Run
```bash
npm run build
npm start
```

---

## 📋 Features

✅ Real-time Trade Detection (8-15ms latency)  
✅ Automatic Position Copying  
✅ Dry-run Mode for Testing  
✅ Risk Management & Safety Limits  
✅ Smart Gas Optimization  
✅ Live Terminal Dashboard  

---

## 🔧 Configuration

Run `npm run setup` for interactive configuration, or edit `.env`:

```bash
# Your wallet private key (no 0x prefix)
PRIVATE_KEY=your_64_char_hex_key

# Wallet to copy trades from
TARGET_WALLET_ADDRESS=0x...

# Position limits (USDC)
MIN_POSITION_SIZE=0.01
MAX_POSITION_SIZE=1000

# Copy ratio (1.0 = 100% of target size)
COPY_RATIO=1.0

# Dry-run mode (true = simulated, false = real)
DRY_RUN_MODE=true
```

---

## 📊 Trading Modes

### Dry-Run (Default)
- Simulates trades with $1000 virtual balance
- No real transactions
- Perfect for testing

### Live Trading
- Executes real trades
- Requires USDC in wallet
- **⚠️ Use at your own risk**

---

## 📈 Dashboard

```
╔════════════════════════════════════════╗
║  POLYMARKET COPY TRADE BOT 💰         ║
╠════════════════════════════════════════╣
║  Status: 🟢 RUNNING  │ Mode: DRY-RUN  ║
║  Detected: 124  │ Executed: 67      ║
║  USDC: $1000.00 │ Win Rate: 64%     ║
╚════════════════════════════════════════╝
```

---

## 🚨 Important

### Geographic Restrictions
Polymarket blocks certain regions (403 errors). Use VPN if needed.

### Security
- Never share your private key
- Use dedicated trading wallet
- Keep `.env` file secure

### Risks
- Crypto trading involves loss risk
- No performance guarantees
- Trade only what you can afford to lose

---

## 🐛 Troubleshooting

**"Order submission failed: 403"**  
→ Geographic restriction. Use VPN or proxy.

**"Insufficient balance"**  
→ Add USDC to your wallet on Polygon network.

**"No healthy RPC providers"**  
→ Network issue or rate limit. Wait 10 seconds.

---

## 📄 License

MIT License

---

## ⚠️ Disclaimer

This software is provided "as is" without warranty. Use at your own risk. Authors not responsible for financial losses.

---

**Happy Trading! 📈**
