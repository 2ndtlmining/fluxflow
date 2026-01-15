# Flux Flow Tracker

Real-time exchange flow analysis dashboard for the Flux blockchain network. Tracks buy/sell pressure by analyzing transactions between exchanges, node operators, foundation, and unknown wallets.

## 🎯 Features

- **Real-time Block Analysis**: Continuously monitors and analyzes Flux blockchain transactions
- **Wallet Classification**: Automatically classifies addresses as Exchanges, Node Operators, Foundation, or Unknown
- **Flow Direction Detection**: Identifies buying pressure (from exchanges) and selling pressure (to exchanges)
- **Multiple Time Periods**: View data for Today, This Week, This Month, This Quarter, and This Year
- **Top Movers**: See top 5 buyers and sellers for each period
- **Exchange Breakdown**: Per-exchange flow analysis
- **No Database**: In-memory analysis with configurable block buffer
- **Rate Limiting**: Respects API limits with batching and retry logic
- **Gap Prevention**: Ensures no blocks are missed during analysis

## 📊 What We Track

### Buying Pressure (From Exchanges)
- Total FLUX moving from exchanges
- Destinations: Node Operators, Unknown Wallets, Foundation, Exchange-to-Exchange
- Per-exchange source breakdown

### Selling Pressure (To Exchanges)  
- Total FLUX moving to exchanges
- Sources: Node Operators, Unknown Wallets, Foundation, Exchange-to-Exchange
- Per-exchange destination breakdown

### Classification
- **Exchanges**: Configurable list of exchange addresses (Binance, KuCoin, etc.)
- **Foundation**: Flux Foundation official addresses
- **Node Operators**: Dynamic list fetched from Flux API (includes node count and tiers)
- **Unknown**: All other addresses

## 🚀 Quick Start

### Development Mode

```bash
# Install dependencies
npm install

# Start backend server (Terminal 1)
npm run server

# Start frontend dev server (Terminal 2)
npm run dev

# Access at http://localhost:5173
```

### Docker Deployment

```bash
# Build image
docker build -t flux-flow-tracker .

# Run container
docker run -p 3000:3000 -p 4173:4173 flux-flow-tracker

# Access at http://localhost:4173
```

### Configuration

All configuration is in `src/lib/config.js`:

```javascript
FLUX_CONFIG = {
  BLOCK_TIME_SECONDS: 30,          // Flux block time
  MAX_BLOCKS_IN_MEMORY: 100000,    // ~34 days of blocks
  BLOCK_FETCH_INTERVAL: 30000,     // Fetch new blocks every 30s
  INITIAL_SYNC_BATCH_SIZE: 10,     // Batch size for initial sync
  BATCH_DELAY: 1000,               // Delay between batches (rate limiting)
  NODE_REFRESH_BLOCKS: 100,        // Refresh node operators every 100 blocks
  // ... more settings
}
```

## 📁 Project Structure

```
flux-flow-tracker/
├── src/
│   ├── lib/
│   │   ├── config.js                    # All configuration
│   │   ├── services/
│   │   │   ├── blockService.js          # Block fetching with rate limiting
│   │   │   ├── classificationService.js # Wallet classification
│   │   │   └── flowAnalysisService.js   # Buy/sell analysis
│   │   ├── data/
│   │   │   └── exchanges.json           # Exchange addresses config
│   │   └── components/
│   │       ├── BlockStatus.svelte       # Current block status display
│   │       ├── PeriodSelector.svelte    # Time period toggle
│   │       └── FlowCard.svelte          # Buy/sell cards
│   ├── routes/
│   │   ├── +layout.svelte               # Main layout
│   │   └── +page.svelte                 # Dashboard page
│   ├── app.css                          # Global styles
│   └── app.html                         # HTML template
├── server.js                            # Express backend
├── Dockerfile                           # Docker configuration
├── docker-entrypoint.sh                 # Container startup script
├── package.json
└── README.md
```

## 🔧 How It Works

### Initial Sync
1. Backend fetches current blockchain height
2. Loads exchange and foundation addresses from config
3. Fetches node operator data from Flux API
4. Performs initial sync of last 30 days of blocks (configurable)
5. Processes blocks in batches with rate limiting
6. Verifies no gaps in block sequence
7. Starts continuous sync every 30 seconds

### Continuous Operation
- Every 30 seconds, checks for new blocks
- Fetches and processes new blocks since last sync
- Classifies all transactions
- Updates in-memory buffer (circular buffer, oldest blocks dropped)
- Refreshes node operator data every 100 blocks
- Frontend auto-refreshes every 5 minutes

### Transaction Classification
```javascript
// For each transaction:
1. Extract all "from" addresses (inputs)
2. Extract all "to" addresses (outputs)
3. Classify each address:
   - Check if exchange (static list)
   - Check if foundation (static list)
   - Check if node operator (dynamic API)
   - Otherwise mark as unknown
4. Determine flow direction:
   - If to exchange (not from) = SELLING
   - If from exchange (not to) = BUYING
   - If both = TRANSFER
```

## 📡 API Endpoints

### Status
- `GET /api/health` - System health
- `GET /api/blocks/status` - Current block status

### Flow Analysis
- `GET /api/flow/:period` - Flow analysis for period (24H, 7D, 30D, 90D, 1Y)
- `GET /api/top/buyers/:period` - Top 5 buyers
- `GET /api/top/sellers/:period` - Top 5 sellers

### Classification
- `GET /api/classification/stats` - Classification statistics

### Admin
- `POST /api/admin/sync` - Trigger manual sync

## ⚙️ Configuration Files

### Exchange Configuration (`src/lib/data/exchanges.json`)

```json
{
  "exchanges": [
    {
      "name": "Binance",
      "addresses": ["t1abc...", "t1def..."],
      "logo": "/logos/binance.svg"
    }
  ],
  "foundation": {
    "name": "Flux Foundation",
    "addresses": ["t1xyz..."],
    "logo": "/logos/flux-foundation.svg"
  }
}
```

## 🔄 Rate Limiting & Gap Prevention

The system implements robust rate limiting and gap prevention:

- **Batch Processing**: Fetches blocks in configurable batch sizes
- **Delays Between Batches**: 1-second delay to avoid rate limits
- **Retry Logic**: 3 automatic retries with exponential backoff
- **Sequence Verification**: Checks for gaps after each batch
- **Individual Fallback**: If batch fails, tries fetching blocks individually
- **Error Tracking**: Pauses sync after 5 consecutive errors

## 🎨 Theming

The app uses a terminal-style dark theme inspired by Fluxtracker:
- Flux purple primary color (#8247e5)
- Cyan accents (#00d4ff)
- Dark background (#0a0e27)
- Monospace font (Courier New)

## 🐛 Troubleshooting

### Insufficient Data
If you see "Insufficient data" messages, the system is still syncing blocks. Wait for the progress bar to reach 100%.

### Sync Errors
Check backend logs for API errors. Common issues:
- Blockbook API rate limiting (reduce batch size)
- Network connectivity issues
- Invalid block data

### High Memory Usage
Adjust `MAX_BLOCKS_IN_MEMORY` in config to reduce memory footprint. Each block with ~50 transactions uses approximately 50KB.

## 📝 TODO / Future Enhancements

- [ ] Add historical charts showing flow over time
- [ ] Implement top node operator whale tracking
- [ ] Add exchange logo display
- [ ] Export data to CSV
- [ ] WebSocket for real-time updates
- [ ] Mobile-responsive improvements
- [ ] Advanced filtering (by exchange, node tier, etc.)

## 🙏 Credits

Built on the Flux blockchain ecosystem:
- Blockbook API: https://blockbook.runonflux.io
- Flux Nodes API: https://explorer.runonflux.io
- Inspired by: Fluxtracker (https://fluxtracker.app.runonflux.io)

## 📄 License

MIT License - See LICENSE file for details
