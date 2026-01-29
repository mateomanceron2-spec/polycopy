/**
 * Test Script - Monitor Polymarket Trades
 * 
 * This script polls the Polymarket Data API and displays trades
 * from the target wallet in real-time.
 */

const TARGET_WALLET = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
const POLL_INTERVAL_MS = 2000; // Poll every 2 seconds
const LOOKBACK_SECONDS = 300; // 5 minutes

let lastSeenTimestamp = 0; // Will be set after first poll
const processedTxHashes = new Set();

console.log('═'.repeat(80));
console.log('  POLYMARKET TRADE MONITOR - DEBUG MODE');
console.log('═'.repeat(80));
console.log(`  Target Wallet: ${TARGET_WALLET}`);
console.log(`  Poll Interval: ${POLL_INTERVAL_MS}ms`);
console.log(`  Lookback: ${LOOKBACK_SECONDS} seconds`);
console.log('═'.repeat(80));
console.log('');

async function pollForTrades() {
  try {
    // Build URL with 'after' parameter if we have a lastSeenTimestamp
    let url = `https://data-api.polymarket.com/activity?user=${TARGET_WALLET}&limit=20`;
    
    if (lastSeenTimestamp > 0) {
      // Add 'after' parameter to only get activities after our last check
      url += `&after=${lastSeenTimestamp}`;
    } else {
      // On first poll, get activities from the lookback period
      const lookbackTimestamp = Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;
      url += `&after=${lookbackTimestamp}`;
    }
    
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`❌ API Error: ${response.status} ${response.statusText}`);
      console.error(`   Response: ${text.slice(0, 200)}`);
      return;
    }

    const data = await response.json();
    
    // Activity endpoint returns array directly
    if (!data || data.length === 0) {
      console.log(`⏳ ${new Date().toLocaleTimeString()} - No activity found`);
      return;
    }

    console.log(`📡 ${new Date().toLocaleTimeString()} - Fetched ${data.length} activities from API`);
    
    // Show timestamp range of activities
    if (data.length > 0) {
      const newestActivity = data[0];
      const oldestActivity = data[data.length - 1];
      
      // Debug: show raw timestamp fields
      console.log(`   └─ Sample activity fields:`, Object.keys(newestActivity).join(', '));
      console.log(`   └─ Newest timestamp field:`, newestActivity.created_at || newestActivity.timestamp || newestActivity.time);
      
      const newestTime = new Date(newestActivity.timestamp * 1000);
      const oldestTime = new Date(oldestActivity.timestamp * 1000);
      console.log(`   └─ Range: ${oldestTime.toLocaleTimeString()} to ${newestTime.toLocaleTimeString()}`);
    }

    // Process activities in reverse order (oldest first)
    const activities = [...data].reverse();
    
    let newTradesFound = 0;
    let alreadyProcessed = 0;
    
    for (const activity of activities) {
      // Activity uses 'timestamp' field (Unix timestamp in seconds)
      const timestamp = activity.timestamp;
      
      // Skip if already processed (by transactionHash) - backup deduplication
      const activityId = activity.transactionHash;
      if (processedTxHashes.has(activityId)) {
        alreadyProcessed++;
        continue;
      }

      newTradesFound++;
      
      // Mark as processed
      processedTxHashes.add(activityId);
      
      // Update last seen timestamp to the newest activity we've processed
      lastSeenTimestamp = Math.max(lastSeenTimestamp, timestamp);

      // Display the activity
      displayActivity(activity);
    }
    
    if (newTradesFound === 0) {
      console.log(`   └─ No new activities (${activities.length} fetched, ${alreadyProcessed} already seen)`);
    } else {
      console.log(`   └─ ✅ ${newTradesFound} new activit(y/ies) detected! (Total tracked: ${processedTxHashes.size})`);
    }
    
    console.log('');
  } catch (error) {
    console.error(`❌ Error polling API: ${error.message}`);
  }
}

function displayActivity(activity) {
  const activityTime = new Date((activity.timestamp || 0) * 1000);
  const detectionLatency = Date.now() - activityTime.getTime();
  
  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────────────────┐');
  console.log('│  🎯 NEW ACTIVITY DETECTED                                                │');
  console.log('├─────────────────────────────────────────────────────────────────────────┤');
  console.log(`│  Type:      ${(activity.type || 'TRADE').padEnd(60)} │`);
  console.log(`│  Market:    ${(activity.title || 'Unknown').slice(0, 60).padEnd(60)} │`);
  console.log(`│  Side:      ${(activity.side || 'N/A').padEnd(60)} │`);
  console.log(`│  Outcome:   ${(activity.outcome || 'N/A').padEnd(60)} │`);
  console.log(`│  Size:      ${(activity.size || 'N/A').toString().padEnd(60)} │`);
  console.log(`│  Price:     ${(activity.price || 'N/A').toString().padEnd(60)} │`);
  console.log(`│  Time:      ${activityTime.toISOString().padEnd(60)} │`);
  console.log(`│  Latency:   ${Math.floor(detectionLatency / 1000)}s ago`.padEnd(74) + '│');
  console.log(`│  Tx Hash:   ${(activity.transactionHash || 'N/A').slice(0, 60).padEnd(60)} │`);
  console.log('└─────────────────────────────────────────────────────────────────────────┘');
}

// Start monitoring
console.log('🚀 Starting trade monitor...\n');
pollForTrades(); // Initial poll

const interval = setInterval(pollForTrades, POLL_INTERVAL_MS);

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n\n');
  console.log('═'.repeat(80));
  console.log('  MONITOR STOPPED');
  console.log('═'.repeat(80));
  console.log(`  Total trades processed: ${processedTxHashes.size}`);
  if (lastSeenTimestamp) {
    console.log(`  Last timestamp: ${new Date(lastSeenTimestamp).toISOString()}`);
  }
  console.log('═'.repeat(80));
  clearInterval(interval);
  process.exit(0);
});
