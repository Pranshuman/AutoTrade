import { KiteConnect } from "kiteconnect";
import type { Product } from "kiteconnect";
import dayjs from "dayjs";
import { writeFile } from "fs/promises";

// API Credentials (keep in sync with live script)
const apiKey = "gssli7u395tn5in8";
const apiSecret = "yeq4xu913i50u2d5j5b0wkgqp6cp0ufo";
const accessToken = "9yCO1xTawB42aFla6Lg5tipYXq2xzciL";
const kc = new KiteConnect({ api_key: apiKey });

// Types
type Candle = {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};

type LiveData = {
    timestamp: number;
    cePrice: number;
    pePrice: number;
    spotPrice: number;
};

type Position = {
    isOpen: boolean;
    entryPrice: number;
    entryTime: string;
    entryOrderId?: string;
    exitOrderId?: string;
};

type LiveTrade = {
    timestamp: string;
    instrument: "CE" | "PE";
    action: "ENTRY" | "EXIT" | "SQUARE_OFF";
    price: number;
    quantity: number;
    orderId?: string;
    pnl?: number;
    reason: string;
};

type ChartPoint = {
    time: string;
    cePrice: number;
    pePrice: number;
    ceRsi: number;
    peRsi: number;
    spotPrice: number;
};

// Global state
let isTradingActive = false; // Flag to control live trading loop
let ceStrike = 0; // ATM - 150
let peStrike = 0; // ATM + 150
let ceToken = 0;
let peToken = 0;
let spotToken = 0;
let ceSymbol = "";
let peSymbol = "";
let lotSize = 75; // NIFTY lot size
const rsiPeriod = 14; // RSI period for calculation
const profitTargetPoints = 30; // Exit if price moves 30 points above entry
const tickSize = 0.05; // NIFTY options tick size (5 paise)

let sessionStart: Date;
let sessionEnd: Date;
let entryCutoff: Date;
let rsiStartTime: Date; // Start RSI tracking from 3:20 PM of previous working day

// Position tracking
const cePosition: Position = { isOpen: false, entryPrice: 0, entryTime: "" };
const pePosition: Position = { isOpen: false, entryPrice: 0, entryTime: "" };

// Pending operation flags
let ceEntryPending = false;
let peEntryPending = false;
let ceExitPending = false;
let peExitPending = false;

// RSI tracking - we need to maintain history for minute-by-minute RSI
const ceRsiHistory: number[] = []; // RSI values from minute candles
const peRsiHistory: number[] = []; // RSI values from minute candles
const cePriceHistory: number[] = []; // Price history for 3-second checks
const pePriceHistory: number[] = []; // Price history for 3-second checks

// Previous RSI values for entry/exit conditions
let cePreviousRsi = 0;
let pePreviousRsi = 0;
let cePreviousPreviousRsi = 0;
let pePreviousPreviousRsi = 0;

// Trade log and chart data
const liveTrades: LiveTrade[] = [];
const chartPoints: ChartPoint[] = [];

// Minute candle history for RSI calculation
const ceMinuteCandles: Candle[] = [];
const peMinuteCandles: Candle[] = [];

// Track last minute when RSI was calculated and checked for entry/exit
let lastRsiCheckMinute: number = -1;

// Latest data from 3-second fetcher (for monitoring/logging purposes)
let latestData: LiveData | null = null;

// Helper functions for live trading
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function roundToTickSize(price: number): number {
    return Math.round(price / tickSize) * tickSize;
}

async function getTradingSymbol(instrumentToken: number): Promise<string> {
    const instruments = await kc.getInstruments("NFO");
    const instrument = instruments.find(inst => Number(inst.instrument_token) === instrumentToken);
    if (!instrument) {
        throw new Error(`Instrument not found for token: ${instrumentToken}`);
    }
    return instrument.tradingsymbol;
}

async function placeOrder(instrumentToken: number, transactionType: "BUY" | "SELL", quantity: number, product: Product) {
    const maxRetries = 3;
    const retryDelay = 2000; // 2 seconds
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const tradingsymbol = await getTradingSymbol(instrumentToken);
            const order = await kc.placeOrder("regular", {
                exchange: "NFO",
                tradingsymbol: tradingsymbol,
                transaction_type: transactionType,
                quantity: quantity,
                product: product,
                order_type: "MARKET"
            });
            
            // Order placed successfully - verify it was accepted (not rejected)
            if (order && order.order_id) {
                // Small delay to allow order to be processed
                await sleep(500);
                
                try {
                    // Check order status to ensure it wasn't rejected
                    const orderHistory = await kc.getOrderHistory(order.order_id);
                    if (orderHistory && orderHistory.length > 0) {
                        const firstOrder = orderHistory[0];
                        if (firstOrder) {
                            const orderStatus = firstOrder.status;
                            
                            // If order was rejected, don't retry - throw error immediately
                            if (orderStatus === "REJECTED" || orderStatus === "CANCELLED") {
                                const rejectReason = firstOrder.status_message || "Order rejected";
                                throw new Error(`Order rejected: ${rejectReason}`);
                            }
                            
                            // Order is accepted (OPEN, COMPLETE, etc.) - return successfully
                            // No retry needed since order was placed and accepted
                            return order;
                        }
                    }
                } catch (statusErr: any) {
                    // If we can't check status, assume order was placed successfully
                    // (order_id was returned, which means order was accepted by exchange)
                    console.warn(`⚠️ Could not verify order status, but order_id was returned: ${order.order_id}`);
                }
                
                // Order placed successfully with valid order_id - return immediately (no retry)
                return order;
            } else {
                // Order placement returned but no order_id - this shouldn't happen, but retry
                throw new Error("Order placement returned but no order_id received");
            }
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            
            // If it's an authentication error, don't retry
            if (errorMsg.includes("TokenException") || errorMsg.includes("access_token") || errorMsg.includes("api_key")) {
                throw new Error(`Authentication error: ${errorMsg}\n💡 Solution: Run login_access_token.ts to refresh your access token`);
            }
            
            // If it's a validation error (invalid quantity, etc.), don't retry
            if (errorMsg.includes("InputException") || errorMsg.includes("validation") || errorMsg.includes("Invalid")) {
                throw new Error(`Order validation error: ${errorMsg}`);
            }
            
            // If order was rejected, don't retry
            if (errorMsg.includes("Order rejected") || errorMsg.includes("REJECTED")) {
                throw new Error(errorMsg);
            }
            
            // Only retry for transient errors (network issues, timeouts, etc.)
            if (attempt < maxRetries) {
                console.warn(`⚠️ Error placing order (attempt ${attempt}/${maxRetries}):`, errorMsg);
                console.log(`Retrying in ${retryDelay / 1000} seconds...`);
                await sleep(retryDelay);
            } else {
                console.error("❌ Error placing order after retries:", err);
                throw new Error(`Failed to place order after ${maxRetries} attempts: ${errorMsg}`);
            }
        }
    }
    
    throw new Error("Failed to place order after all retries");
}

// Lightweight function to get current prices only (for stop loss checks)
// Fetches only last 1 minute of data - called every 3 seconds
async function getCurrentPrices(): Promise<LiveData> {
    const maxRetries = 3;
    const retryDelay = 2000; // 2 seconds
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const now = new Date();
            const from = new Date(now.getTime() - 2 * 60 * 1000); // Last 2 minutes (minimal data)
            
            // Get latest candles for CE, PE, and Spot (lightweight fetch)
            const ceCandles = await getHistoricalCandles(ceToken, from, now);
            const peCandles = await getHistoricalCandles(peToken, from, now);
            const spotCandles = await getHistoricalCandles(spotToken, from, now);
            
            if (ceCandles.length === 0 || peCandles.length === 0 || spotCandles.length === 0) {
                if (attempt < maxRetries) {
                    console.warn(`⚠️ No live candles available (attempt ${attempt}/${maxRetries}). Retrying...`);
                    await sleep(retryDelay);
                    continue;
                }
                throw new Error("No live candles available after retries");
            }
            
            const latestCe = ceCandles[ceCandles.length - 1];
            const latestPe = peCandles[peCandles.length - 1];
            const latestSpot = spotCandles[spotCandles.length - 1];
            
            if (!latestCe || !latestPe || !latestSpot) {
                if (attempt < maxRetries) {
                    console.warn(`⚠️ Incomplete candle data (attempt ${attempt}/${maxRetries}). Retrying...`);
                    await sleep(retryDelay);
                    continue;
                }
                throw new Error("No latest candle data available after retries");
            }
            
            return {
                timestamp: now.getTime(),
                cePrice: latestCe.close,
                pePrice: latestPe.close,
                spotPrice: latestSpot.close
            };
            
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            
            // If it's an authentication error, don't retry
            if (errorMsg.includes("TokenException") || errorMsg.includes("access_token") || errorMsg.includes("api_key")) {
                throw new Error(`Authentication error: ${errorMsg}\n💡 Solution: Run login_access_token.ts to refresh your access token`);
            }
            
            if (attempt < maxRetries) {
                console.warn(`⚠️ Error getting current prices (attempt ${attempt}/${maxRetries}):`, errorMsg);
                await sleep(retryDelay);
            } else {
                console.error("❌ Error getting current prices after retries:", err);
                throw err;
            }
        }
    }
    
    throw new Error("Failed to get current prices after all retries");
}

// Full data fetch for RSI calculation (called once per minute)
async function getLiveData(): Promise<LiveData> {
    // Use the lightweight function for consistency
    return await getCurrentPrices();
}

async function updateRSIFromLiveCandles(currentPrices?: LiveData) {
    try {
        const now = new Date();
        const todayMarketOpen = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 15, 0);
        const minCandlesNeeded = rsiPeriod + 1; // Need at least 15 candles for RSI period 14
        const todayDateStr = dayjs(todayMarketOpen).format("YYYY-MM-DD");
        
        // Get today's candles first
        let ceCandlesToday = await getHistoricalCandles(ceToken, todayMarketOpen, now);
        let peCandlesToday = await getHistoricalCandles(peToken, todayMarketOpen, now);
        
        // Filter out incomplete candles (current minute's candle) - only use closed candles
        // The API might return the current minute's candle which is still forming
        const currentMinuteForFilter = new Date(now);
        currentMinuteForFilter.setSeconds(0);
        currentMinuteForFilter.setMilliseconds(0);
        const currentMinuteStrForFilter = dayjs(currentMinuteForFilter).format("YYYY-MM-DD HH:mm:ss");
        
        // Remove any candles from the current minute (they're incomplete)
        ceCandlesToday = ceCandlesToday.filter(candle => {
            const candleTime = new Date(candle.date);
            candleTime.setSeconds(0);
            candleTime.setMilliseconds(0);
            const candleTimeStr = dayjs(candleTime).format("YYYY-MM-DD HH:mm:ss");
            return candleTimeStr !== currentMinuteStrForFilter;
        });
        peCandlesToday = peCandlesToday.filter(candle => {
            const candleTime = new Date(candle.date);
            candleTime.setSeconds(0);
            candleTime.setMilliseconds(0);
            const candleTimeStr = dayjs(candleTime).format("YYYY-MM-DD HH:mm:ss");
            return candleTimeStr !== currentMinuteStrForFilter;
        });
        
        console.log(`[RSI Debug] Today's market open - CE candles: ${ceCandlesToday.length} (after filtering incomplete), PE candles: ${peCandlesToday.length} (after filtering incomplete)`);
        
        // Always try to get historical data for continuous RSI calculation from 9:15
        // This ensures RSI is calculated using continuous data flow from previous trading day
        const needHistoricalData = ceCandlesToday.length < minCandlesNeeded || peCandlesToday.length < minCandlesNeeded;
        
        if (needHistoricalData) {
            console.log(`[RSI Debug] Need historical data. Today has ${ceCandlesToday.length} candles, need ${minCandlesNeeded}. Finding last trading day...`);
        } else {
            console.log(`[RSI Debug] Today has sufficient candles (${ceCandlesToday.length}), but will still try to get historical data for continuous RSI calculation from 9:15...`);
        }
        
        // Always try to get historical data for better RSI calculation (even if today has enough)
        // This ensures RSI calculation uses continuous data from previous trading day
        {
            
            // Find the last actual trading day (skip holidays and weekends)
            let lastTradingDay = new Date(now);
            lastTradingDay.setDate(lastTradingDay.getDate() - 1);
            let maxDaysBack = 10; // Don't go back more than 10 days
            let daysBack = 0;
            let ceCandlesHistorical: Candle[] = [];
            let peCandlesHistorical: Candle[] = [];
            let foundTradingDay = false;
            
            while (daysBack < maxDaysBack && !foundTradingDay) {
                // Skip weekends
                while (lastTradingDay.getDay() === 0 || lastTradingDay.getDay() === 6) {
                    lastTradingDay.setDate(lastTradingDay.getDate() - 1);
                    daysBack++;
                }
                
                if (daysBack >= maxDaysBack) break;
                
                const lastTradingDayMarketOpen = new Date(
                    lastTradingDay.getFullYear(),
                    lastTradingDay.getMonth(),
                    lastTradingDay.getDate(),
                    9, 15, 0
                );
                const lastTradingDayMarketClose = new Date(
                    lastTradingDay.getFullYear(),
                    lastTradingDay.getMonth(),
                    lastTradingDay.getDate(),
                    15, 20, 0 // 3:20 PM
                );
                const lastTradingDayDateStr = dayjs(lastTradingDayMarketOpen).format("YYYY-MM-DD");
                
                console.log(`[RSI Debug] Checking ${lastTradingDayDateStr} for historical data...`);
                
                // Fetch candles from this day
                const ceCandlesCheck = await getHistoricalCandles(ceToken, lastTradingDayMarketOpen, lastTradingDayMarketClose);
                const peCandlesCheck = await getHistoricalCandles(peToken, lastTradingDayMarketOpen, lastTradingDayMarketClose);
                
                // Check if we got valid data from this day (not today's data)
                if (ceCandlesCheck.length > 0 && peCandlesCheck.length > 0) {
                    const firstCeDate = ceCandlesCheck[0]?.date ? dayjs(ceCandlesCheck[0].date).format("YYYY-MM-DD") : null;
                    const firstPeDate = peCandlesCheck[0]?.date ? dayjs(peCandlesCheck[0].date).format("YYYY-MM-DD") : null;
                    
                    // If the data is from the trading day we queried (not today), it's valid
                    if (firstCeDate === lastTradingDayDateStr && firstPeDate === lastTradingDayDateStr) {
                        ceCandlesHistorical = ceCandlesCheck;
                        peCandlesHistorical = peCandlesCheck;
                        foundTradingDay = true;
                        console.log(`✅ [RSI Debug] Found valid trading day: ${lastTradingDayDateStr} with ${ceCandlesCheck.length} CE and ${peCandlesCheck.length} PE candles`);
                        break;
                    } else {
                        // This day was a holiday (API returned today's or other day's data)
                        console.log(`📅 [RSI Debug] ${lastTradingDayDateStr} was a holiday (got data from ${firstCeDate || firstPeDate}). Going back further...`);
                    }
                } else {
                    // No data from this day - likely a holiday
                    console.log(`📅 [RSI Debug] ${lastTradingDayDateStr} appears to be a holiday (no data). Going back further...`);
                }
                
                // Go back one more day
                lastTradingDay.setDate(lastTradingDay.getDate() - 1);
                daysBack++;
            }
            
            // Combine historical data with today's data ONLY if today has less than 15 candles
            // Once today has 15+ candles, use ONLY today's data (matches how trading platforms calculate RSI)
            if (foundTradingDay && (ceCandlesToday.length < minCandlesNeeded || peCandlesToday.length < minCandlesNeeded)) {
                // Use exactly the number of historical candles needed to reach 15 total when combined with today
                // This ensures RSI calculation matches how trading platforms calculate it:
                // - At 9:15: use last 14 from previous day + 9:15 today = 15 candles
                // - At 9:16: use last 13 from previous day + 9:15, 9:16 today = 15 candles
                // - At 9:20: use last 9 from previous day + 9:15 to 9:20 today = 15 candles
                // - Once we have 15+ candles from today, use ONLY today's data (no historical)
                const ceHistoricalNeeded = Math.max(0, minCandlesNeeded - ceCandlesToday.length);
                const peHistoricalNeeded = Math.max(0, minCandlesNeeded - peCandlesToday.length);
                
                // Take the last N candles from historical data (or all if less available)
                const ceHistoricalToUse = ceCandlesHistorical.length >= ceHistoricalNeeded 
                    ? ceCandlesHistorical.slice(-ceHistoricalNeeded)
                    : ceCandlesHistorical;
                const peHistoricalToUse = peCandlesHistorical.length >= peHistoricalNeeded
                    ? peCandlesHistorical.slice(-peHistoricalNeeded)
                    : peCandlesHistorical;
                
                const ceTodayCount = ceCandlesToday.length;
                const peTodayCount = peCandlesToday.length;
            
                // Log historical candles being used
                if (ceHistoricalToUse.length > 0) {
                    const firstHist = ceHistoricalToUse[0];
                    const lastHist = ceHistoricalToUse[ceHistoricalToUse.length - 1];
                    console.log(`[RSI Debug] Historical CE candles: ${ceHistoricalToUse.length} from ${firstHist?.date} to ${lastHist?.date}`);
                }
                if (peHistoricalToUse.length > 0) {
                    const firstHist = peHistoricalToUse[0];
                    const lastHist = peHistoricalToUse[peHistoricalToUse.length - 1];
                    console.log(`[RSI Debug] Historical PE candles: ${peHistoricalToUse.length} from ${firstHist?.date} to ${lastHist?.date}`);
                }
                
                // Historical data comes first (older), then today's data (newer)
                ceCandlesToday.unshift(...ceHistoricalToUse);
                peCandlesToday.unshift(...peHistoricalToUse);
                
                console.log(`[RSI Debug] Combined data - CE: ${ceCandlesToday.length} total (${ceHistoricalToUse.length} from history + ${ceTodayCount} today), PE: ${peCandlesToday.length} total (${peHistoricalToUse.length} from history + ${peTodayCount} today)`);
            } else if (ceCandlesToday.length >= minCandlesNeeded && peCandlesToday.length >= minCandlesNeeded) {
                console.log(`[RSI Debug] Today has sufficient candles (${ceCandlesToday.length} CE, ${peCandlesToday.length} PE). Using ONLY today's data (no historical combination).`);
            } else {
                console.warn(`⚠️ [RSI Debug] Could not find a valid trading day in the last ${maxDaysBack} days. Using only today's data.`);
            }
        }
        
        // Use the combined or today's candles
        const ceCandles = ceCandlesToday;
        const peCandles = peCandlesToday;
        
        if (ceCandles.length === 0 || peCandles.length === 0) {
            console.warn(`⚠️ [RSI Debug] No candles available after fallback - CE: ${ceCandles.length}, PE: ${peCandles.length}`);
            return { ceRsi: 0, peRsi: 0 };
        }
        
        // Check if we have enough candles for RSI calculation
        if (ceCandles.length < minCandlesNeeded) {
            console.warn(`⚠️ [RSI Debug] Not enough CE candles for RSI: ${ceCandles.length} < ${minCandlesNeeded} (need at least ${minCandlesNeeded} candles)`);
            console.warn(`   This is normal early in the trading session. RSI will be available after ${minCandlesNeeded} minutes.`);
        }
        if (peCandles.length < minCandlesNeeded) {
            console.warn(`⚠️ [RSI Debug] Not enough PE candles for RSI: ${peCandles.length} < ${minCandlesNeeded} (need at least ${minCandlesNeeded} candles)`);
            console.warn(`   This is normal early in the trading session. RSI will be available after ${minCandlesNeeded} minutes.`);
        }
        
        // Get current prices if not provided (for current minute's close)
        let currentCePrice: number;
        let currentPePrice: number;
        
        if (currentPrices) {
            currentCePrice = currentPrices.cePrice;
            currentPePrice = currentPrices.pePrice;
        } else {
            // Fetch current prices to get current minute's close
            const liveData = await getCurrentPrices();
            currentCePrice = liveData.cePrice;
            currentPePrice = liveData.pePrice;
        }
        
        // Get the current minute's timestamp (rounded down to minute)
        const currentMinute = new Date(now);
        currentMinute.setSeconds(0);
        currentMinute.setMilliseconds(0);
        const currentMinuteStr = dayjs(currentMinute).format("YYYY-MM-DD HH:mm:ss");
        
        // Check if the last candle is for the current minute
        const lastCeCandle = ceCandles[ceCandles.length - 1];
        const lastPeCandle = peCandles[peCandles.length - 1];
        
        if (!lastCeCandle || !lastPeCandle) {
            return { ceRsi: 0, peRsi: 0 };
        }
        
        const lastCeCandleTime = new Date(lastCeCandle.date);
        lastCeCandleTime.setSeconds(0);
        lastCeCandleTime.setMilliseconds(0);
        
        const lastPeCandleTime = new Date(lastPeCandle.date);
        lastPeCandleTime.setSeconds(0);
        lastPeCandleTime.setMilliseconds(0);
        
        // IMPORTANT: Past candles use their closing data from API (close price at 59th second of that minute)
        // Only the current minute's candle uses the price at the 59th second of the current minute
        // Since we filtered out the current minute's candle from API, lastCeCandle should always be from a past minute
        const lastCeCandleTimeMs = lastCeCandleTime.getTime();
        const currentMinuteMs = currentMinute.getTime();
        
        if (lastCeCandleTimeMs < currentMinuteMs) {
            // Last candle is from a previous minute - append current minute's candle with price at 59th second
            // Past candles keep their original close prices from API (already the close at 59th second of that minute)
            ceCandles.push({
                date: currentMinuteStr,
                open: lastCeCandle.close, // Use previous close as open (approximation)
                high: Math.max(lastCeCandle.close, currentCePrice),
                low: Math.min(lastCeCandle.close, currentCePrice),
                close: currentCePrice, // Current price at 59th second
                volume: 0 // Volume not available for current minute
            });
        } else if (lastCeCandleTimeMs === currentMinuteMs) {
            // This shouldn't happen since we filtered out current minute's candle, but handle it just in case
            // Update current minute's candle with price at 59th second
            const lastCe = ceCandles[ceCandles.length - 1];
            if (lastCe) {
                lastCe.close = currentCePrice; // Current price at 59th second
                lastCe.high = Math.max(lastCe.high, currentCePrice);
                lastCe.low = Math.min(lastCe.low, currentCePrice);
            }
        } else {
            // Edge case: last candle time is in the future (shouldn't happen, but handle it)
            console.warn(`⚠️ Unexpected: Last CE candle time (${lastCeCandle.date}) is after current minute (${currentMinuteStr})`);
            // Still update it to be safe
            const lastCe = ceCandles[ceCandles.length - 1];
            if (lastCe) {
                lastCe.close = currentCePrice;
            }
        }
        
        const lastPeCandleTimeMs = lastPeCandleTime.getTime();
        
        // IMPORTANT: Past candles use their closing data from API (close price at 59th second of that minute)
        // Only the current minute's candle uses the price at the 59th second of the current minute
        if (lastPeCandleTimeMs < currentMinuteMs) {
            // Last candle is from a previous minute - append current minute's candle with price at 59th second
            // Past candles keep their original close prices from API (already the close at 59th second of that minute)
            peCandles.push({
                date: currentMinuteStr,
                open: lastPeCandle.close, // Use previous close as open (approximation)
                high: Math.max(lastPeCandle.close, currentPePrice),
                low: Math.min(lastPeCandle.close, currentPePrice),
                close: currentPePrice, // Current price at 59th second
                volume: 0 // Volume not available for current minute
            });
        } else if (lastPeCandleTimeMs === currentMinuteMs) {
            // This shouldn't happen since we filtered out current minute's candle, but handle it just in case
            // Update current minute's candle with price at 59th second
            const lastPe = peCandles[peCandles.length - 1];
            if (lastPe) {
                lastPe.close = currentPePrice; // Current price at 59th second
                lastPe.high = Math.max(lastPe.high, currentPePrice);
                lastPe.low = Math.min(lastPe.low, currentPePrice);
            }
        } else {
            // Edge case: last candle time is in the future (shouldn't happen, but handle it)
            console.warn(`⚠️ Unexpected: Last PE candle time (${lastPeCandle.date}) is after current minute (${currentMinuteStr})`);
            // Still update it to be safe
            const lastPe = peCandles[peCandles.length - 1];
            if (lastPe) {
                lastPe.close = currentPePrice;
            }
        }
        
        // Update minute candle history
        ceMinuteCandles.length = 0;
        peMinuteCandles.length = 0;
        ceMinuteCandles.push(...ceCandles);
        peMinuteCandles.push(...peCandles);
        
        // Calculate RSI (now includes current minute's close)
        // For RSI(14), we need exactly the last 15 candles (rsiPeriod + 1)
        // Take only the last 15 candles for RSI calculation
        const ceClosePricesAll = ceCandles.map(c => c.close);
        const peClosePricesAll = peCandles.map(c => c.close);
        
        // Verify current minute's candle is included
        const lastCandleDate = ceCandles[ceCandles.length - 1]?.date;
        if (lastCandleDate !== currentMinuteStr) {
            console.warn(`⚠️ [RSI Debug] Last candle date (${lastCandleDate}) does not match current minute (${currentMinuteStr}). Current candle may not be included!`);
        } else {
            console.log(`✅ [RSI Debug] Current minute's candle (${currentMinuteStr}) is included in the candle array`);
        }
        
        // Use only the last 15 candles for RSI calculation
        const ceClosePrices = ceClosePricesAll.slice(-minCandlesNeeded);
        const peClosePrices = peClosePricesAll.slice(-minCandlesNeeded);
        
        // Verify current minute is in the RSI calculation
        const lastRsiCandleDate = ceCandles[ceCandles.length - ceClosePrices.length]?.date;
        const firstRsiCandleDate = ceCandles[ceCandles.length - 1]?.date;
        console.log(`[RSI Debug] RSI calculation uses candles from ${lastRsiCandleDate} to ${firstRsiCandleDate} (${ceClosePrices.length} candles)`);
        if (firstRsiCandleDate !== currentMinuteStr) {
            console.warn(`⚠️ [RSI Debug] WARNING: Current minute (${currentMinuteStr}) is NOT in the RSI calculation!`);
        }
        
        // Log detailed price data for debugging (show all candles, but note which ones are used for RSI)
        if (ceClosePricesAll.length > 0) {
            const firstCandle = ceCandles[0];
            const lastCandle = ceCandles[ceCandles.length - 1];
            const firstRsiCandle = ceCandles[ceCandles.length - ceClosePrices.length];
            console.log(`[RSI Debug] CE candles: ${ceCandles.length} total`);
            console.log(`   First: ${firstCandle?.date} @ ${ceClosePricesAll[0]?.toFixed(2)}`);
            console.log(`   Last: ${lastCandle?.date} @ ${ceClosePricesAll[ceClosePricesAll.length - 1]?.toFixed(2)}`);
            console.log(`   Using last ${ceClosePrices.length} candles for RSI (from ${firstRsiCandle?.date} to ${lastCandle?.date})`);
            console.log(`   Price range: ${Math.min(...ceClosePricesAll).toFixed(2)} - ${Math.max(...ceClosePricesAll).toFixed(2)}`);
        }
        if (peClosePricesAll.length > 0) {
            const firstCandle = peCandles[0];
            const lastCandle = peCandles[peCandles.length - 1];
            const firstRsiCandle = peCandles[peCandles.length - peClosePrices.length];
            console.log(`[RSI Debug] PE candles: ${peCandles.length} total`);
            console.log(`   First: ${firstCandle?.date} @ ${peClosePricesAll[0]?.toFixed(2)}`);
            console.log(`   Last: ${lastCandle?.date} @ ${peClosePricesAll[peClosePricesAll.length - 1]?.toFixed(2)}`);
            console.log(`   Using last ${peClosePrices.length} candles for RSI (from ${firstRsiCandle?.date} to ${lastCandle?.date})`);
            console.log(`   Price range: ${Math.min(...peClosePricesAll).toFixed(2)} - ${Math.max(...peClosePricesAll).toFixed(2)}`);
        }
        
        // Check if we have enough data - need at least rsiPeriod + 1 candles
        if (ceClosePrices.length < minCandlesNeeded) {
            console.warn(`⚠️ [RSI Debug] Insufficient CE data: ${ceClosePrices.length} < ${minCandlesNeeded} (need ${minCandlesNeeded} candles for RSI)`);
        }
        if (peClosePrices.length < minCandlesNeeded) {
            console.warn(`⚠️ [RSI Debug] Insufficient PE data: ${peClosePrices.length} < ${minCandlesNeeded} (need ${minCandlesNeeded} candles for RSI)`);
        }
        
        // Log ALL prices being used for RSI calculation to verify
        if (ceClosePrices.length > 0) {
            const rsiCandles = ceCandles.slice(-ceClosePrices.length);
            const rsiCandleDates = rsiCandles.map(c => dayjs(c.date).format("HH:mm"));
            const rsiCandleCloses = rsiCandles.map(c => c.close);
            console.log(`[RSI Debug] CE prices used for RSI (all ${ceClosePrices.length}):`);
            console.log(`   Dates: ${rsiCandleDates.join(", ")}`);
            console.log(`   Close prices from candles: ${rsiCandleCloses.map(p => p.toFixed(2)).join(", ")}`);
            console.log(`   Prices array used: ${ceClosePrices.map(p => p.toFixed(2)).join(", ")}`);
            // Verify they match
            const pricesMatch = rsiCandleCloses.every((price, idx) => {
                const arrayPrice = ceClosePrices[idx];
                return price !== undefined && arrayPrice !== undefined && Math.abs(price - arrayPrice) < 0.01;
            });
            if (!pricesMatch) {
                console.warn(`⚠️ [RSI Debug] WARNING: Close prices from candles don't match prices array!`);
            }
        }
        if (peClosePrices.length > 0) {
            const rsiCandles = peCandles.slice(-peClosePrices.length);
            const rsiCandleDates = rsiCandles.map(c => dayjs(c.date).format("HH:mm"));
            const rsiCandleCloses = rsiCandles.map(c => c.close);
            console.log(`[RSI Debug] PE prices used for RSI (all ${peClosePrices.length}):`);
            console.log(`   Dates: ${rsiCandleDates.join(", ")}`);
            console.log(`   Close prices from candles: ${rsiCandleCloses.map(p => p.toFixed(2)).join(", ")}`);
            console.log(`   Prices array used: ${peClosePrices.map(p => p.toFixed(2)).join(", ")}`);
            // Verify they match
            const pricesMatch = rsiCandleCloses.every((price, idx) => {
                const arrayPrice = peClosePrices[idx];
                return price !== undefined && arrayPrice !== undefined && Math.abs(price - arrayPrice) < 0.01;
            });
            if (!pricesMatch) {
                console.warn(`⚠️ [RSI Debug] WARNING: Close prices from candles don't match prices array!`);
            }
        }
        
        const ceRsi = calculateRSI(ceClosePrices, rsiPeriod);
        const peRsi = calculateRSI(peClosePrices, rsiPeriod);
        
        // Log calculated RSI values with context
        console.log(`[RSI Debug] Calculated RSI - CE: ${ceRsi.toFixed(2)}, PE: ${peRsi.toFixed(2)} (using ${ceClosePrices.length} candles)`);
        
        // Update RSI history (keep only last 100 values)
        ceRsiHistory.push(ceRsi);
        peRsiHistory.push(peRsi);
        if (ceRsiHistory.length > 100) ceRsiHistory.shift();
        if (peRsiHistory.length > 100) peRsiHistory.shift();
        
        return { ceRsi, peRsi };
    } catch (err) {
        console.error("❌ Error updating RSI from live candles:", err);
        if (err instanceof Error) {
            console.error(`   Error message: ${err.message}`);
            console.error(`   Stack: ${err.stack}`);
        }
        return { ceRsi: 0, peRsi: 0 };
    }
}

// Separate data fetcher that runs every 3 seconds (for stop loss checks)
async function startDataFetcher() {
    console.log("📊 Starting 3-second data fetcher (for stop loss monitoring)...");
    
    while (isTradingActive) {
        try {
            const now = new Date();
            
            // Skip if before market open
            if (now < sessionStart) {
                console.log(`[Data Fetcher] Waiting for market open... (current: ${dayjs(now).format("HH:mm:ss")})`);
                await sleep(3000);
                continue;
            }
            
            // Skip if after session end
            if (now >= sessionEnd) {
                console.log(`[Data Fetcher] Session ended. Stopping data fetcher.`);
                break;
            }
            
            // Check if tokens are initialized before fetching
            if (ceToken === 0 || peToken === 0 || spotToken === 0) {
                console.log(`[Data Fetcher] Waiting for instrument initialization... (CE: ${ceToken}, PE: ${peToken}, Spot: ${spotToken})`);
                await sleep(3000);
                continue;
            }
            
            // Fetch current prices every 3 seconds
            try {
                const data = await getCurrentPrices();
                latestData = data;
                
                // Log price data at every 3-second interval to terminal
                const timeStr = dayjs().format("HH:mm:ss");
                
                // Always log price data to terminal (every 3 seconds)
                if (now >= entryCutoff && ceStrike > 0 && peStrike > 0) {
                    // After strikes are selected - show full details with position status
                    const ceStatus = cePosition.isOpen ? `[OPEN @ ${cePosition.entryPrice.toFixed(2)}]` : "[CLOSED]";
                    const peStatus = pePosition.isOpen ? `[OPEN @ ${pePosition.entryPrice.toFixed(2)}]` : "[CLOSED]";
                    console.log(`[${timeStr}] [3s] 💰 Price - CE(${ceStrike}): ₹${data.cePrice.toFixed(2)} ${ceStatus} | PE(${peStrike}): ₹${data.pePrice.toFixed(2)} ${peStatus} | Spot: ₹${data.spotPrice.toFixed(2)}`);
                } else if (ceStrike > 0 && peStrike > 0) {
                    // Strikes selected but before entry cutoff - show basic price data
                    console.log(`[${timeStr}] [3s] 💰 Price - CE(${ceStrike}): ₹${data.cePrice.toFixed(2)} | PE(${peStrike}): ₹${data.pePrice.toFixed(2)} | Spot: ₹${data.spotPrice.toFixed(2)}`);
                } else {
                    // Before strikes are selected - show spot price
                    console.log(`[${timeStr}] [3s] 💰 Price - Spot: ₹${data.spotPrice.toFixed(2)} (Waiting for strike selection at 9:20 AM)`);
                }
                
                // Check stop loss conditions every 3 seconds (immediate execution)
                // Only check if strikes are selected (after 9:20 AM)
                if (now >= entryCutoff) {
                    try {
                        // Stop loss check is being performed every 3 seconds
                        await checkPriceBasedExitConditions(data, dayjs().format("HH:mm:ss"));
                    } catch (err: any) {
                        console.error(`❌ Error checking stop loss conditions: ${err?.message || String(err)}`);
                        if (err instanceof Error) {
                            console.error(`   Stack: ${err.stack}`);
                        }
                    }
                }
            } catch (err: any) {
                const errorMsg = err?.message || String(err);
                
                // If it's an authentication error, stop fetching
                if (errorMsg.includes("Authentication error") || errorMsg.includes("TokenException")) {
                    console.error("❌ Authentication error in data fetcher. Stopping data fetcher.");
                    console.error(`   Error details: ${errorMsg}`);
                    break;
                }
                
                // For other errors, log and continue (don't stop the fetcher)
                console.warn(`⚠️ [Data Fetcher] Error fetching prices: ${errorMsg}`);
                console.warn(`   Will retry in 3 seconds...`);
            }
            
            // Wait 3 seconds before next fetch
            await sleep(3000);
            
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            console.error(`❌ [Data Fetcher] Unexpected error in outer loop: ${errorMsg}`);
            if (err instanceof Error) {
                console.error(`   Stack: ${err.stack}`);
            }
            // Continue running even on unexpected errors
            await sleep(3000);
        }
    }
    
    console.log("📊 Data fetcher stopped.");
}

async function startLiveTrading() {
    isTradingActive = true;
    console.log("\n🚀 Starting live RSI trading...");
    
    // Calculate previous working day for RSI start time
    const today = new Date();
    let previousDay = new Date(today);
    previousDay.setDate(previousDay.getDate() - 1);
    while (previousDay.getDay() === 0 || previousDay.getDay() === 6) {
        previousDay.setDate(previousDay.getDate() - 1);
    }
    // For options, we should fetch from market open (9:15 AM) of previous day to get maximum data
    // This ensures we have enough historical data for RSI calculation
    const previousDayMarketOpen = new Date(
        previousDay.getFullYear(),
        previousDay.getMonth(),
        previousDay.getDate(),
        9,  // 9 AM
        15, // 15 minutes
        0,  // 0 seconds
        0   // 0 milliseconds
    );
    // Also set 2:30 PM time for reference (but we'll use market open for more data)
    const previousDayStartTime = new Date(
        previousDay.getFullYear(),
        previousDay.getMonth(),
        previousDay.getDate(),
        14, // 2 PM
        30, // 30 minutes
        0,  // 0 seconds
        0   // 0 milliseconds
    );
    
    // For options, we might not have data from previous day (expiry might have changed)
    // So we'll start with today's market open, but try previous day first for more data
    const todayMarketOpen = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 15, 0);
    
    // Start with today's market open for options (contracts may have changed from previous day)
    // The updateRSIFromLiveCandles function will try previous day first, then fallback to today
    rsiStartTime = todayMarketOpen;
    
    console.log(`RSI tracking starts from: ${dayjs(todayMarketOpen).format("YYYY-MM-DD HH:mm")} (today's market open)`);
    console.log(`   Will try previous day (${dayjs(previousDayMarketOpen).format("YYYY-MM-DD HH:mm")}) first for more data if available`);
    console.log(`   Note: RSI requires ${rsiPeriod + 1} candles (${rsiPeriod + 1} minutes) - will be available after ${rsiPeriod + 1} minutes from market open`);
    
    while (isTradingActive) {
        try {
            const now = new Date();
            
            // Check if session has ended
            if (now >= sessionEnd) {
                console.log("\n⏰ Session ended. Squaring off positions...");
                try {
                    const liveData = await getCurrentPrices();
                    await squareOffPositions(liveData, dayjs().format("HH:mm:ss"), "Session end - Square off");
                } catch (err: any) {
                    console.error(`❌ Error during session end square off: ${err?.message || String(err)}`);
                    console.error("⚠️ Please check and close positions manually in your broker account.");
                }
                
                try {
                    await saveTradeLog("live");
                } catch (err: any) {
                    console.error(`❌ Error saving trade log: ${err?.message || String(err)}`);
                }
                
                break;
            }
            
            // Skip if before 9:15 AM (market open)
            if (now < sessionStart) {
                console.log(`Waiting for market open... (${dayjs(now).format("HH:mm:ss")})`);
                await sleep(15000);
                continue;
            }
            
            const timeStr = dayjs().format("HH:mm:ss");
            const currentMinute = now.getMinutes();
            const currentSeconds = now.getSeconds();
            
            // Fetch data and calculate RSI at the 59th second of each minute
            // This ensures we use the most complete minute candle data (just before minute closes)
            const shouldCalculateRSI = currentSeconds >= 59 && currentMinute !== lastRsiCheckMinute;
            
            // If not at 59th second yet, wait until we reach it
            if (!shouldCalculateRSI) {
                // Calculate how long to wait until the 59th second of current or next minute
                let waitTime: number;
                if (currentSeconds < 59) {
                    // Wait until 59th second of current minute
                    waitTime = (59 - currentSeconds) * 1000;
                } else {
                    // We're past 59 seconds, wait until 59th second of next minute
                    const secondsUntilNextMinute = 60 - currentSeconds;
                    waitTime = (secondsUntilNextMinute + 59) * 1000;
                }
                if (waitTime > 0) {
                    await sleep(waitTime);
                }
                continue; // Skip to next iteration
            }
            
            // At 59th second of minute - fetch data and calculate RSI
            let liveData: LiveData;
            let ceRsi = 0;
            let peRsi = 0;
            
            // Fetch current prices (for stop loss checks and RSI calculation)
            try {
                liveData = await getCurrentPrices();
            } catch (err: any) {
                const errorMsg = err?.message || String(err);
                
                // If it's an authentication error, stop trading
                if (errorMsg.includes("Authentication error") || errorMsg.includes("TokenException")) {
                    console.error("❌ Authentication error detected. Stopping live trading.");
                    console.error("💡 Solution: Run login_access_token.ts to refresh your access token");
                    isTradingActive = false;
                    break;
                }
                
                // For other errors, log and continue
                console.warn(`⚠️ Error getting current prices: ${errorMsg}`);
                console.log("Retrying in 5 seconds...");
                await sleep(5000);
                continue;
            }
            
            // Calculate RSI using complete minute candle data
            // This fetches full historical data from previous day and includes current minute's close
            try {
                const rsiResult = await updateRSIFromLiveCandles(liveData);
                ceRsi = rsiResult.ceRsi;
                peRsi = rsiResult.peRsi;
                lastRsiCheckMinute = currentMinute;
                
                // Log RSI update at 59th second
                console.log(`[${timeStr}] RSI Updated (59th second) - CE: ${ceRsi.toFixed(2)}, PE: ${peRsi.toFixed(2)}`);
            } catch (err: any) {
                console.warn(`⚠️ Error updating RSI: ${err?.message || String(err)}`);
                // Continue with previous RSI values if available
                if (ceRsiHistory.length > 0) {
                    ceRsi = ceRsiHistory[ceRsiHistory.length - 1] || 0;
                }
                if (peRsiHistory.length > 0) {
                    peRsi = peRsiHistory[peRsiHistory.length - 1] || 0;
                }
            }
            
            // Only check entry/exit conditions after 9:20 AM (when strikes are selected)
            if (now >= entryCutoff) {
                // Note: Stop loss is checked every 3 seconds in the data fetcher (not here)
                // Only RSI-based entry/exit conditions are checked here (at 59th second)
                
                // Check RSI-based entry/exit conditions (at 59th second)
                // Check RSI exit conditions FIRST (if position is open, exit should take priority)
                try {
                    await checkRSIExitConditions(liveData, ceRsi, peRsi, timeStr);
                } catch (err: any) {
                    console.error(`❌ Error checking RSI exit conditions: ${err?.message || String(err)}`);
                }
                
                // Check RSI entry conditions
                try {
                    await checkRSIEntryConditions(liveData, ceRsi, peRsi, timeStr);
                } catch (err: any) {
                    console.error(`❌ Error checking RSI entry conditions: ${err?.message || String(err)}`);
                }
            } else {
                // Before 9:20 AM, just log that we're waiting
                console.log(`[${timeStr}] Waiting for strike selection at 9:20 AM... CE(${ceStrike}): ${liveData.cePrice.toFixed(2)} (RSI: ${ceRsi.toFixed(2)}), PE(${peStrike}): ${liveData.pePrice.toFixed(2)} (RSI: ${peRsi.toFixed(2)}), Spot: ${liveData.spotPrice.toFixed(2)}`);
            }
            
            // Update chart data history (at end of minute)
            chartPoints.push({
                time: timeStr,
                cePrice: liveData.cePrice,
                pePrice: liveData.pePrice,
                ceRsi,
                peRsi,
                spotPrice: liveData.spotPrice
            });
            
            // Keep only last 100 data points
            if (chartPoints.length > 100) {
                chartPoints.shift();
            }
            
            // Generate and save chart (at 59th second when RSI is calculated)
            if (chartPoints.length >= 2 && now >= entryCutoff) {
                try {
                    await generatePriceRSIChart();
                } catch (err: any) {
                    console.warn(`⚠️ Error generating chart: ${err?.message || String(err)}`);
                }
            }
            
            // Wait until next minute's 59th second
            // Calculate time until next minute's 59th second
            const nextMinute = new Date(now);
            nextMinute.setMinutes(currentMinute + 1);
            nextMinute.setSeconds(59);
            nextMinute.setMilliseconds(0);
            const waitTime = nextMinute.getTime() - now.getTime();
            if (waitTime > 0) {
                await sleep(waitTime);
            } else {
                // If we're already past the target time, wait a short time
                await sleep(1000);
            }
            
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            console.error(`❌ Unexpected error in live trading loop: ${errorMsg}`);
            
            // If it's a critical error (authentication), stop trading
            if (errorMsg.includes("Authentication error") || errorMsg.includes("TokenException")) {
                console.error("❌ Critical authentication error. Stopping live trading.");
                isTradingActive = false;
                break;
            }
            
            // For other errors, wait and continue
            console.log("Retrying in 5 seconds...");
            await sleep(5000);
        }
    }
    
    console.log("Live trading stopped.");
}

async function init() {
    try {
        kc.setAccessToken(accessToken);
        console.log("✅ KiteConnect initialized for RSI live trading");
        
        // Set session times
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        sessionStart = new Date(today.getTime() + 9 * 60 * 60 * 1000 + 15 * 60 * 1000); // 9:15 AM
        sessionEnd = new Date(today.getTime() + 15 * 60 * 60 * 1000 + 20 * 60 * 1000); // 3:20 PM
        entryCutoff = new Date(today.getTime() + 9 * 60 * 60 * 1000 + 20 * 60 * 1000); // 9:20 AM
        
        console.log(`Session: ${dayjs(sessionStart).format("HH:mm:ss")} - ${dayjs(sessionEnd).format("HH:mm:ss")}`);
        console.log(`Entry Cutoff: ${dayjs(entryCutoff).format("HH:mm:ss")}`);
        
        // Wait for market to open and initialize instruments at 9:20 AM
        const waitTime = entryCutoff.getTime() - now.getTime();
        if (waitTime > 0) {
            console.log(`Waiting ${Math.round(waitTime / 1000 / 60)} minutes until 9:20 AM for strike selection...`);
            await sleep(waitTime);
        }
        
        // Initialize instruments at 9:20 AM
        await initializeInstruments();
        
        // Set trading active flag BEFORE starting data fetcher
        // This ensures the data fetcher's while loop will run
        isTradingActive = true;
        
        // Start 3-second data fetcher in parallel (doesn't affect RSI logic)
        // Only start after instruments are initialized (tokens are available)
        console.log("📊 Starting 3-second price monitoring after instrument initialization...");
        startDataFetcher().catch(err => {
            console.error("❌ Fatal error in data fetcher:", err);
            if (err instanceof Error) {
                console.error(`   Message: ${err.message}`);
                console.error(`   Stack: ${err.stack}`);
            }
        });
        
        // Start live trading (RSI calculation loop)
        await startLiveTrading();
        
    } catch (err: any) {
        const errorMsg = err?.message || String(err);
        console.error("❌ Fatal error in init:", errorMsg);
        
        // If positions are open, try to square them off before exiting
        if (cePosition.isOpen || pePosition.isOpen) {
            console.log("\n⚠️ Attempting to square off open positions before exit...");
            try {
                const liveData = await getLiveData().catch(() => null);
                if (liveData) {
                    await squareOffPositions(liveData, dayjs().format("HH:mm:ss"), "Emergency square off - init error");
                } else {
                    console.error("❌ Could not get live data for square off. Please check positions manually.");
                }
            } catch (squareOffErr) {
                console.error("❌ Error during emergency square off:", squareOffErr);
                console.error("⚠️ Please check and close positions manually in your broker account.");
            }
        }
        
        // Save trade log before exiting
        try {
            await saveTradeLog("live");
        } catch (logErr) {
            console.error("❌ Error saving trade log:", logErr);
        }
        
        process.exit(1);
    }
}

async function initializeInstruments() {
    const maxRetries = 10;
    const retryDelay = 30000; // 30 seconds
    
    // Get spot token
    let token: number | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            token = await getNiftySpotToken();
            if (token) break;
        } catch (err) {
            console.warn(`⚠️ Attempt ${attempt}/${maxRetries}: Error getting NIFTY spot token:`, err);
            if (attempt < maxRetries) {
                console.log(`Retrying in ${retryDelay / 1000} seconds...`);
                await sleep(retryDelay);
            }
        }
    }
    
    if (!token) {
        throw new Error("Could not find NIFTY spot token after multiple attempts. Please check your API credentials.");
    }
    spotToken = token;

    // Get spot price around 9:20 AM with retry logic
    const fromTime = new Date(entryCutoff.getTime() - 10 * 60 * 1000); // 10 minutes before
    const toTime = new Date(entryCutoff.getTime() + 30 * 60 * 1000); // 30 minutes after
    
    let spotCandles: Candle[] = [];
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Fetching spot candles (attempt ${attempt}/${maxRetries}) from ${dayjs(fromTime).format("HH:mm:ss")} to ${dayjs(toTime).format("HH:mm:ss")}...`);
            spotCandles = await getHistoricalCandles(spotToken, fromTime, toTime);
            
            if (spotCandles.length > 0) {
                break; // Success
            }
            
            // If no candles but we haven't reached max retries, wait and retry
            if (attempt < maxRetries) {
                const now = new Date();
                const timeUntilCutoff = entryCutoff.getTime() - now.getTime();
                
                // If we're before 9:20 AM, data might not be available yet
                if (timeUntilCutoff > 0) {
                    console.log(`No candles yet. Waiting for market data... (${Math.round(timeUntilCutoff / 1000 / 60)} minutes until 9:20 AM)`);
                    await sleep(Math.min(retryDelay, timeUntilCutoff + 5000));
                } else {
                    // We're past 9:20 AM, retry with delay
                    console.log(`No candles found. Retrying in ${retryDelay / 1000} seconds...`);
                    await sleep(retryDelay);
                }
            }
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            console.warn(`⚠️ Attempt ${attempt}/${maxRetries}: Error fetching candles:`, errorMsg);
            
            // If it's an authentication error, don't retry
            if (errorMsg.includes("TokenException") || errorMsg.includes("access_token") || errorMsg.includes("api_key")) {
                throw new Error(`Authentication error: ${errorMsg}\n💡 Solution: Run login_access_token.ts to refresh your access token`);
            }
            
            if (attempt < maxRetries) {
                console.log(`Retrying in ${retryDelay / 1000} seconds...`);
                await sleep(retryDelay);
            }
        }
    }
    
    if (spotCandles.length === 0) {
        const errorMsg = `No spot candles available for strike selection after ${maxRetries} attempts.\n` +
            `Requested time: ${dayjs(entryCutoff).format("YYYY-MM-DD HH:mm:ss")}\n` +
            `Current time: ${dayjs().format("YYYY-MM-DD HH:mm:ss")}\n` +
            `Possible reasons:\n` +
            `1. Market was closed on this date (weekend/holiday)\n` +
            `2. Access token expired - run login_access_token.ts to refresh\n` +
            `3. Data not available yet for this date\n` +
            `4. API connection issue\n` +
            `5. Market hasn't opened yet`;
        throw new Error(errorMsg);
    }
    
    console.log(`Found ${spotCandles.length} spot candles`);
    
    const cutoffCandle = spotCandles.find(candle => {
        const ts = new Date(candle.date).getTime();
        return ts >= entryCutoff.getTime() && ts < entryCutoff.getTime() + 60000;
    }) || spotCandles[spotCandles.length - 1];

    if (!cutoffCandle) {
        throw new Error("Could not find a valid candle for strike selection");
    }

    const spotPrice = cutoffCandle.close;
    const atmStrike = Math.round(spotPrice / 50) * 50;
    
    // Strike selection: 
    // PE is 150 points above ATM
    // CE is 150 points below ATM
    peStrike = atmStrike + 150; // PE: 150 points above ATM
    ceStrike = atmStrike - 150; // CE: 150 points below ATM
    
    // Verify relationship: PE should be 300 points above CE
    const strikeDiff = peStrike - ceStrike;
    if (strikeDiff !== 300) {
        console.warn(`⚠️ Warning: PE-CE difference is ${strikeDiff}, expected 300`);
    }

    console.log(`Spot: ${spotPrice.toFixed(2)} | ATM: ${atmStrike}`);
    console.log(`PE Strike: ${peStrike} (150 points above ATM)`);
    console.log(`CE Strike: ${ceStrike} (150 points below ATM)`);
    console.log(`Relationship: PE (${peStrike}) is ${strikeDiff} points above CE (${ceStrike})`);

    const instruments = await kc.getInstruments("NFO");
    const expiry = getNextExpiry(instruments);
    if (!expiry) {
        throw new Error("No next expiry found for NIFTY");
    }
    const expiryTs = expiry.getTime();

    const ce = instruments.find(inst =>
        inst.name === "NIFTY" &&
        inst.strike === ceStrike &&
        new Date(inst.expiry).getTime() === expiryTs &&
        inst.instrument_type === "CE"
    );
    const pe = instruments.find(inst =>
        inst.name === "NIFTY" &&
        inst.strike === peStrike &&
        new Date(inst.expiry).getTime() === expiryTs &&
        inst.instrument_type === "PE"
    );

    if (!ce || !pe) {
        throw new Error(`Unable to find CE/PE instruments for strikes ${ceStrike}/${peStrike}`);
    }

    ceToken = Number(ce.instrument_token);
    peToken = Number(pe.instrument_token);
    ceSymbol = ce.tradingsymbol;
    peSymbol = pe.tradingsymbol;

    console.log(`CE: ${ceSymbol} (${ceToken}) | PE: ${peSymbol} (${peToken}) | Expiry: ${dayjs(expiry).format("YYYY-MM-DD")}`);
}

function calculateRSI(prices: number[], period: number): number {
    if (prices.length < period + 1) {
        return 0; // Not enough data
    }

    const changes: number[] = [];
    for (let i = 1; i < prices.length; i++) {
        const currentPrice = prices[i];
        const previousPrice = prices[i - 1];
        if (currentPrice !== undefined && previousPrice !== undefined) {
            changes.push(currentPrice - previousPrice);
        }
    }

    const gains: number[] = changes.map(change => change > 0 ? change : 0);
    const losses: number[] = changes.map(change => change < 0 ? -change : 0);

    // Calculate initial average gain and loss
    let avgGain = gains.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

    // Use Wilder's smoothing method for remaining periods (standard RSI calculation)
    for (let i = period; i < gains.length; i++) {
        const gain = gains[i];
        const loss = losses[i];
        if (gain !== undefined && loss !== undefined) {
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
        }
    }

    if (avgLoss === 0) {
        return 100; // Avoid division by zero
    }

    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    return rsi;
}

// RSI-based entry conditions (checked only at minute boundaries)
async function checkRSIEntryConditions(liveData: LiveData, ceRsi: number, peRsi: number, now: string) {
    // Entry Condition: Last RSI data point >= 70 AND current RSI < 70
    // Note: ceRsiHistory already contains the current RSI (pushed before this function)
    // So: history[length-1] = current, history[length-2] = last
    
    // CE Entry: Last RSI >= 70 AND current RSI < 70
    if (!cePosition.isOpen && !ceEntryPending && ceRsiHistory.length >= 2) {
        const lastRsi = ceRsiHistory[ceRsiHistory.length - 2]; // Previous RSI (last data point)
        const currentRsi = ceRsi; // Current RSI (current data point, same as history[length-1])
        
        if (lastRsi !== undefined && lastRsi >= 70 && currentRsi < 70) {
            console.log(`[${now}] ⚡ CE Entry Signal DETECTED (RSI: ${lastRsi.toFixed(2)} -> ${currentRsi.toFixed(2)}) - Executing immediately...`);
            // Fetch latest prices immediately before executing to ensure we use the most current price
            try {
                const latestData = await getCurrentPrices();
                await executeCEEntry(latestData, now);
            } catch (err: any) {
                console.error(`❌ Error executing CE entry: ${err?.message || String(err)}`);
                // Fallback to using the original liveData if fetching fails
                await executeCEEntry(liveData, now);
            }
        }
    }

    // PE Entry: Last RSI >= 70 AND current RSI < 70
    if (!pePosition.isOpen && !peEntryPending && peRsiHistory.length >= 2) {
        const lastRsi = peRsiHistory[peRsiHistory.length - 2]; // Previous RSI (last data point)
        const currentRsi = peRsi; // Current RSI (current data point, same as history[length-1])
        
        if (lastRsi !== undefined && lastRsi >= 70 && currentRsi < 70) {
            console.log(`[${now}] ⚡ PE Entry Signal DETECTED (RSI: ${lastRsi.toFixed(2)} -> ${currentRsi.toFixed(2)}) - Executing immediately...`);
            // Fetch latest prices immediately before executing to ensure we use the most current price
            try {
                const latestData = await getCurrentPrices();
                await executePEEntry(latestData, now);
            } catch (err: any) {
                console.error(`❌ Error executing PE entry: ${err?.message || String(err)}`);
                // Fallback to using the original liveData if fetching fails
                await executePEEntry(liveData, now);
            }
        }
    }
}

// RSI-based exit conditions (checked only at minute boundaries)
async function checkRSIExitConditions(liveData: LiveData, ceRsi: number, peRsi: number, now: string) {
    // Exit Condition: Last RSI >= 30 AND current RSI < 30
    // Note: Checked only at minute boundaries
    
    // CE Exit Condition: Last RSI >= 30 AND current RSI < 30
    if (cePosition.isOpen && !ceExitPending && ceRsiHistory.length >= 2 && cePosition.entryPrice > 0) {
        const lastRsi = ceRsiHistory[ceRsiHistory.length - 2]; // Previous RSI
        const currentRsi = ceRsi; // Current RSI
        // Validate RSI values
        if (lastRsi !== undefined && isFinite(lastRsi) && isFinite(currentRsi) && 
            lastRsi >= 30 && currentRsi < 30 && lastRsi <= 100 && currentRsi >= 0) {
            console.log(`[${now}] ⚡ CE Exit Signal DETECTED (RSI: ${lastRsi.toFixed(2)} -> ${currentRsi.toFixed(2)}) - Executing immediately...`);
            // Fetch latest prices immediately before executing to ensure we use the most current price
            try {
                const latestData = await getCurrentPrices();
                await executeCEExit(latestData, now, `RSI Exit: ${lastRsi.toFixed(2)} -> ${currentRsi.toFixed(2)}`);
            } catch (err: any) {
                console.error(`❌ Error executing CE exit: ${err?.message || String(err)}`);
                // Fallback to using the original liveData if fetching fails
                await executeCEExit(liveData, now, `RSI Exit: ${lastRsi.toFixed(2)} -> ${currentRsi.toFixed(2)}`);
            }
            return;
        }
    }

    // PE Exit Condition: Last RSI >= 30 AND current RSI < 30
    if (pePosition.isOpen && !peExitPending && peRsiHistory.length >= 2 && pePosition.entryPrice > 0) {
        const lastRsi = peRsiHistory[peRsiHistory.length - 2]; // Previous RSI
        const currentRsi = peRsi; // Current RSI
        // Validate RSI values
        if (lastRsi !== undefined && isFinite(lastRsi) && isFinite(currentRsi) && 
            lastRsi >= 30 && currentRsi < 30 && lastRsi <= 100 && currentRsi >= 0) {
            console.log(`[${now}] ⚡ PE Exit Signal DETECTED (RSI: ${lastRsi.toFixed(2)} -> ${currentRsi.toFixed(2)}) - Executing immediately...`);
            // Fetch latest prices immediately before executing to ensure we use the most current price
            try {
                const latestData = await getCurrentPrices();
                await executePEExit(latestData, now, `RSI Exit: ${lastRsi.toFixed(2)} -> ${currentRsi.toFixed(2)}`);
            } catch (err: any) {
                console.error(`❌ Error executing PE exit: ${err?.message || String(err)}`);
                // Fallback to using the original liveData if fetching fails
                await executePEExit(liveData, now, `RSI Exit: ${lastRsi.toFixed(2)} -> ${currentRsi.toFixed(2)}`);
            }
            return;
        }
    }
}

// Price-based exit conditions (checked continuously every 3 seconds for immediate stop loss)
// This function is called from the 3-second data fetcher
async function checkPriceBasedExitConditions(liveData: LiveData, now: string) {
    // Exit Condition: Option price moved 30 points above entry price (stop loss)
    // Note: Checked continuously every 3 seconds for immediate execution
    
    // Log stop loss check (only when positions are open to avoid spam)
    if (cePosition.isOpen || pePosition.isOpen) {
        const ceStatus = cePosition.isOpen ? `CE: Entry=${cePosition.entryPrice.toFixed(2)}, Current=${liveData.cePrice.toFixed(2)}, Diff=${(liveData.cePrice - cePosition.entryPrice).toFixed(2)}` : "CE: CLOSED";
        const peStatus = pePosition.isOpen ? `PE: Entry=${pePosition.entryPrice.toFixed(2)}, Current=${liveData.pePrice.toFixed(2)}, Diff=${(liveData.pePrice - pePosition.entryPrice).toFixed(2)}` : "PE: CLOSED";
        console.log(`[${now}] [Stop Loss Check] ${ceStatus} | ${peStatus} | Threshold: ${profitTargetPoints} points`);
    }
    
    // CE Exit: Price moved 30 points above entry price
    if (cePosition.isOpen && !ceExitPending && cePosition.entryPrice > 0) {
        // Validate entry price is valid
        if (liveData.cePrice <= 0 || cePosition.entryPrice <= 0) {
            console.warn(`⚠️ Invalid price data: CE Price=${liveData.cePrice}, Entry Price=${cePosition.entryPrice}`);
            return;
        }
        const priceDiff = liveData.cePrice - cePosition.entryPrice;
        
        // Log current status before checking threshold
        if (priceDiff > 0) {
            console.log(`[${now}] [Stop Loss] CE: Current=${liveData.cePrice.toFixed(2)}, Entry=${cePosition.entryPrice.toFixed(2)}, Diff=${priceDiff.toFixed(2)}/${profitTargetPoints} points`);
        }
        
        if (priceDiff >= profitTargetPoints) {
            console.log(`[${now}] ⚡⚡⚡ CE STOP LOSS TRIGGERED ⚡⚡⚡ - Price ${liveData.cePrice.toFixed(2)} is ${priceDiff.toFixed(2)} points above entry ${cePosition.entryPrice.toFixed(2)} (threshold: ${profitTargetPoints}) - Executing immediately...`);
            // Fetch latest prices immediately before executing to ensure we use the most current price
            try {
                const latestData = await getCurrentPrices();
                await executeCEExit(latestData, now, `Price Exit (Stop Loss): Price ${latestData.cePrice.toFixed(2)} is ${(latestData.cePrice - cePosition.entryPrice).toFixed(2)} points above entry ${cePosition.entryPrice.toFixed(2)}`);
            } catch (err: any) {
                console.error(`❌ Error executing CE stop loss exit: ${err?.message || String(err)}`);
                // Fallback to using the original liveData if fetching fails
                await executeCEExit(liveData, now, `Price Exit (Stop Loss): Price ${liveData.cePrice.toFixed(2)} is ${priceDiff.toFixed(2)} points above entry ${cePosition.entryPrice.toFixed(2)}`);
            }
            return;
        }
    }

    // PE Exit: Price moved 20 points above entry price
    if (pePosition.isOpen && !peExitPending && pePosition.entryPrice > 0) {
        // Validate entry price is valid
        if (liveData.pePrice <= 0 || pePosition.entryPrice <= 0) {
            console.warn(`⚠️ Invalid price data: PE Price=${liveData.pePrice}, Entry Price=${pePosition.entryPrice}`);
            return;
        }
        const priceDiff = liveData.pePrice - pePosition.entryPrice; // Price moved up
        
        // Log current status before checking threshold
        if (priceDiff > 0) {
            console.log(`[${now}] [Stop Loss] PE: Current=${liveData.pePrice.toFixed(2)}, Entry=${pePosition.entryPrice.toFixed(2)}, Diff=${priceDiff.toFixed(2)}/${profitTargetPoints} points`);
        }
        
        if (priceDiff >= profitTargetPoints) {
            console.log(`[${now}] ⚡⚡⚡ PE STOP LOSS TRIGGERED ⚡⚡⚡ - Price ${liveData.pePrice.toFixed(2)} is ${priceDiff.toFixed(2)} points above entry ${pePosition.entryPrice.toFixed(2)} (threshold: ${profitTargetPoints}) - Executing immediately...`);
            // Fetch latest prices immediately before executing to ensure we use the most current price
            try {
                const latestData = await getCurrentPrices();
                await executePEExit(latestData, now, `Price Exit (Stop Loss): Price ${latestData.pePrice.toFixed(2)} is ${(latestData.pePrice - pePosition.entryPrice).toFixed(2)} points above entry ${pePosition.entryPrice.toFixed(2)}`);
            } catch (err: any) {
                console.error(`❌ Error executing PE stop loss exit: ${err?.message || String(err)}`);
                // Fallback to using the original liveData if fetching fails
                await executePEExit(liveData, now, `Price Exit (Stop Loss): Price ${liveData.pePrice.toFixed(2)} is ${priceDiff.toFixed(2)} points above entry ${pePosition.entryPrice.toFixed(2)}`);
            }
            return;
        }
    }
}

async function executeCEEntry(liveData: LiveData, now: string) {
    if (ceEntryPending) return;
    ceEntryPending = true;

    try {
        // Live trading: Place actual SELL order (short position)
        let entryPrice = liveData.cePrice;
        let orderId: string;
        
        try {
            const order = await placeOrder(ceToken, "SELL", lotSize, "MIS");
            orderId = order.order_id;
            console.log(`✅ CE Entry order placed: ${orderId}`);
            
            // Get filled price from order book (or use current price as estimate)
            // Note: In live trading, you may want to check order status and get actual fill price
            entryPrice = liveData.cePrice;
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            console.error(`❌ Error placing CE entry order: ${errorMsg}`);
            
            // If it's an authentication error, don't mark position as open
            if (errorMsg.includes("Authentication error") || errorMsg.includes("TokenException")) {
                throw new Error(`Authentication error - cannot place order: ${errorMsg}`);
            }
            
            // For other errors, still throw but with more context
            throw new Error(`Failed to place CE entry order: ${errorMsg}`);
        }
        
        cePosition.isOpen = true;
        cePosition.entryPrice = entryPrice;
        cePosition.entryTime = now;
        cePosition.entryOrderId = orderId;

        const trade: LiveTrade = {
            timestamp: dayjs(liveData.timestamp).format("YYYY-MM-DD HH:mm:ss"),
            instrument: "CE",
            action: "ENTRY",
            price: entryPrice,
            quantity: lotSize,
            orderId: orderId,
            reason: `RSI Entry: Last RSI >= 70, current RSI < 70`
        };
        liveTrades.push(trade);

        console.log(`\n${"=".repeat(80)}`);
        console.log(`📈 CE ENTRY EXECUTED @ ${trade.price.toFixed(2)} (${trade.reason})`);
        console.log(`${"=".repeat(80)}\n`);
    } finally {
        ceEntryPending = false;
    }
}

async function executePEEntry(liveData: LiveData, now: string) {
    if (peEntryPending) return;
    peEntryPending = true;

    try {
        // Live trading: Place actual SELL order (short position)
        let entryPrice = liveData.pePrice;
        let orderId: string;
        
        try {
            const order = await placeOrder(peToken, "SELL", lotSize, "MIS");
            orderId = order.order_id;
            console.log(`✅ PE Entry order placed: ${orderId}`);
            
            // Get filled price from order book (or use current price as estimate)
            entryPrice = liveData.pePrice;
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            console.error(`❌ Error placing PE entry order: ${errorMsg}`);
            
            // If it's an authentication error, don't mark position as open
            if (errorMsg.includes("Authentication error") || errorMsg.includes("TokenException")) {
                throw new Error(`Authentication error - cannot place order: ${errorMsg}`);
            }
            
            // For other errors, still throw but with more context
            throw new Error(`Failed to place PE entry order: ${errorMsg}`);
        }
        
        pePosition.isOpen = true;
        pePosition.entryPrice = entryPrice;
        pePosition.entryTime = now;
        pePosition.entryOrderId = orderId;

        const trade: LiveTrade = {
            timestamp: dayjs(liveData.timestamp).format("YYYY-MM-DD HH:mm:ss"),
            instrument: "PE",
            action: "ENTRY",
            price: entryPrice,
            quantity: lotSize,
            orderId: orderId,
            reason: `RSI Entry: Last RSI >= 70, current RSI < 70`
        };
        liveTrades.push(trade);

        console.log(`\n${"=".repeat(80)}`);
        console.log(`📈 PE ENTRY EXECUTED @ ${trade.price.toFixed(2)} (${trade.reason})`);
        console.log(`${"=".repeat(80)}\n`);
    } finally {
        peEntryPending = false;
    }
}

async function executeCEExit(liveData: LiveData, now: string, reason: string) {
    if (ceExitPending) return;
    ceExitPending = true;

    try {
        // Live trading: Place actual BUY order (cover short position)
        let exitPrice = liveData.cePrice;
        let orderId: string = `CE-EXIT-${liveTrades.length + 1}`;
        
        try {
            const order = await placeOrder(ceToken, "BUY", lotSize, "MIS");
            orderId = order.order_id;
            console.log(`✅ CE Exit order placed: ${orderId}`);
            
            // Get filled price from order book (or use current price as estimate)
            exitPrice = liveData.cePrice;
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            console.error(`❌ Error placing CE exit order: ${errorMsg}`);
            
            // If it's an authentication error, still try to close position locally
            if (errorMsg.includes("Authentication error") || errorMsg.includes("TokenException")) {
                console.error("⚠️ Authentication error - position may still be open in broker. Please check manually.");
                // Still close position locally to prevent further trading attempts
                // Use fallback orderId
            } else {
                throw new Error(`Failed to place CE exit order: ${errorMsg}`);
            }
        }
        
        const pnl = (cePosition.entryPrice - exitPrice) * lotSize;
        const trade: LiveTrade = {
            timestamp: dayjs(liveData.timestamp).format("YYYY-MM-DD HH:mm:ss"),
            instrument: "CE",
            action: "EXIT",
            price: exitPrice,
            quantity: lotSize,
            orderId: orderId,
            pnl,
            reason
        };
        liveTrades.push(trade);

        cePosition.isOpen = false;
        cePosition.entryPrice = 0;
        cePosition.entryTime = "";
        cePosition.entryOrderId = undefined;

        console.log(`\n${"=".repeat(80)}`);
        console.log(`📉 CE EXIT EXECUTED @ ${trade.price.toFixed(2)} | PnL: ${trade.pnl?.toFixed(2)} | ${reason}`);
        console.log(`${"=".repeat(80)}\n`);
    } finally {
        ceExitPending = false;
    }
}

async function executePEExit(liveData: LiveData, now: string, reason: string) {
    if (peExitPending) return;
    peExitPending = true;

    try {
        // Live trading: Place actual BUY order (cover short position)
        let exitPrice = liveData.pePrice;
        let orderId: string = `PE-EXIT-${liveTrades.length + 1}`;
        
        try {
            const order = await placeOrder(peToken, "BUY", lotSize, "MIS");
            orderId = order.order_id;
            console.log(`✅ PE Exit order placed: ${orderId}`);
            
            // Get filled price from order book (or use current price as estimate)
            exitPrice = liveData.pePrice;
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            console.error(`❌ Error placing PE exit order: ${errorMsg}`);
            
            // If it's an authentication error, still try to close position locally
            if (errorMsg.includes("Authentication error") || errorMsg.includes("TokenException")) {
                console.error("⚠️ Authentication error - position may still be open in broker. Please check manually.");
                // Still close position locally to prevent further trading attempts
                // Use fallback orderId
            } else {
                throw new Error(`Failed to place PE exit order: ${errorMsg}`);
            }
        }
        
        const pnl = (pePosition.entryPrice - exitPrice) * lotSize;
        const trade: LiveTrade = {
            timestamp: dayjs(liveData.timestamp).format("YYYY-MM-DD HH:mm:ss"),
            instrument: "PE",
            action: "EXIT",
            price: exitPrice,
            quantity: lotSize,
            orderId: orderId,
            pnl,
            reason
        };
        liveTrades.push(trade);

        pePosition.isOpen = false;
        pePosition.entryPrice = 0;
        pePosition.entryTime = "";
        pePosition.entryOrderId = undefined;

        console.log(`\n${"=".repeat(80)}`);
        console.log(`📉 PE EXIT EXECUTED @ ${trade.price.toFixed(2)} | PnL: ${trade.pnl?.toFixed(2)} | ${reason}`);
        console.log(`${"=".repeat(80)}\n`);
    } finally {
        peExitPending = false;
    }
}

async function squareOffPositions(liveData: LiveData, now: string, reason: string) {
    try {
        if (cePosition.isOpen) {
            try {
                await executeCEExit(liveData, now, reason);
            } catch (err: any) {
                console.error(`❌ Error squaring off CE position: ${err?.message || String(err)}`);
                // Mark position as closed locally even if order failed
                cePosition.isOpen = false;
            }
        }
        if (pePosition.isOpen) {
            try {
                await executePEExit(liveData, now, reason);
            } catch (err: any) {
                console.error(`❌ Error squaring off PE position: ${err?.message || String(err)}`);
                // Mark position as closed locally even if order failed
                pePosition.isOpen = false;
            }
        }
    } catch (err: any) {
        console.error(`❌ Error in squareOffPositions: ${err?.message || String(err)}`);
        // Ensure positions are marked as closed locally
        cePosition.isOpen = false;
        pePosition.isOpen = false;
    }
}

async function generatePriceRSIChart() {
    try {
        if (chartPoints.length < 2) return; // Need minimum data points
        
        const currentTime = dayjs().format("YYYY-MM-DD HH:mm:ss");
        const chartData = chartPoints.slice(-50); // Last 50 data points
        
        const width = 1600;
        const height = 900;
        const padding = 100;
        const chartWidth = width - 2 * padding;
        const chartHeight = height - 2 * padding;
        
        // Split into 4 sections: CE Price, CE RSI, PE Price, PE RSI
        const sectionWidth = chartWidth / 2;
        const sectionHeight = chartHeight / 2;
        
        // Extract data
        const cePrices = chartData.map(p => p.cePrice);
        const ceRsis = chartData.map(p => p.ceRsi);
        const pePrices = chartData.map(p => p.pePrice);
        const peRsis = chartData.map(p => p.peRsi);
        const timeLabels = chartData.map(p => p.time);
        
        // Calculate ranges with validation
        const validCePrices = cePrices.filter(p => p > 0 && isFinite(p));
        const validPePrices = pePrices.filter(p => p > 0 && isFinite(p));
        const validCeRsis = ceRsis.filter(r => r >= 0 && r <= 100 && isFinite(r));
        const validPeRsis = peRsis.filter(r => r >= 0 && r <= 100 && isFinite(r));
        
        if (validCePrices.length === 0 || validPePrices.length === 0 || validCeRsis.length === 0 || validPeRsis.length === 0) {
            console.warn("⚠️ Insufficient valid data for chart generation");
            return;
        }
        
        const cePriceMax = Math.max(...validCePrices);
        const cePriceMin = Math.min(...validCePrices);
        const cePriceRange = cePriceMax - cePriceMin || 1;
        const cePricePadding = cePriceRange * 0.1 || 1;
        const cePriceYMin = Math.max(0, cePriceMin - cePricePadding);
        const cePriceYMax = cePriceMax + cePricePadding;
        const cePriceYRange = cePriceYMax - cePriceYMin || 1;
        
        const pePriceMax = Math.max(...validPePrices);
        const pePriceMin = Math.min(...validPePrices);
        const pePriceRange = pePriceMax - pePriceMin || 1;
        const pePricePadding = pePriceRange * 0.1 || 1;
        const pePriceYMin = Math.max(0, pePriceMin - pePricePadding);
        const pePriceYMax = pePriceMax + pePricePadding;
        const pePriceYRange = pePriceYMax - pePriceYMin || 1;
        
        // RSI range is always 0-100
        const rsiYMin = 0;
        const rsiYMax = 100;
        const rsiYRange = 100;
        
        // Create SVG
        let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        svg += `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">\n`;
        svg += `<rect width="${width}" height="${height}" fill="#000000"/>\n`;
        
        // Title
        svg += `<text x="${width/2}" y="30" text-anchor="middle" fill="#ffffff" font-family="Arial" font-size="20" font-weight="bold">NIFTY RSI Strategy - Price &amp; RSI Chart - ${currentTime}</text>\n`;
        
        // Section titles
        svg += `<text x="${padding + sectionWidth/2}" y="70" text-anchor="middle" fill="#00ff00" font-family="Arial" font-size="16" font-weight="bold">CE (${ceStrike}) Price</text>\n`;
        svg += `<text x="${padding + sectionWidth + sectionWidth/2}" y="70" text-anchor="middle" fill="#ff00ff" font-family="Arial" font-size="16" font-weight="bold">PE (${peStrike}) Price</text>\n`;
        svg += `<text x="${padding + sectionWidth/2}" y="${padding + sectionHeight + 30}" text-anchor="middle" fill="#00ff00" font-family="Arial" font-size="16" font-weight="bold">CE (${ceStrike}) RSI</text>\n`;
        svg += `<text x="${padding + sectionWidth + sectionWidth/2}" y="${padding + sectionHeight + 30}" text-anchor="middle" fill="#ff00ff" font-family="Arial" font-size="16" font-weight="bold">PE (${peStrike}) RSI</text>\n`;
        
        // Helper function to draw a chart section
        const drawSection = (
            data: number[],
            yMin: number,
            yMax: number,
            yRange: number,
            x: number,
            y: number,
            sectionW: number,
            sectionH: number,
            color: string,
            labelPrefix: string
        ) => {
            let sectionSvg = '';
            
            // Grid lines
            for (let i = 0; i <= 10; i++) {
                const gridY = y + (sectionH * i / 10);
                sectionSvg += `<line x1="${x}" y1="${gridY}" x2="${x + sectionW}" y2="${gridY}" stroke="#333333" stroke-width="1"/>\n`;
                
                const value = yMax - (yRange * i / 10);
                if (!isNaN(value) && isFinite(value)) {
                    sectionSvg += `<text x="${x - 10}" y="${gridY + 4}" text-anchor="end" fill="#ffffff" font-family="Arial" font-size="10">${value.toFixed(2)}</text>\n`;
                }
            }
            
            // Data line
            if (data.length > 1) {
                let pathData = '';
                for (let i = 0; i < data.length; i++) {
                    const value = data[i];
                    if (value === undefined || isNaN(value) || !isFinite(value)) continue;
                    const pathX = x + (sectionW * i / (data.length - 1));
                    const pathY = y + sectionH - ((value - yMin) / yRange) * sectionH;
                    if (!isNaN(pathX) && !isNaN(pathY) && isFinite(pathX) && isFinite(pathY)) {
                        pathData += (i === 0 ? 'M' : 'L') + `${pathX},${pathY} `;
                    }
                }
                if (pathData.trim()) {
                    sectionSvg += `<path d="${pathData.trim()}" stroke="${color}" stroke-width="2" fill="none"/>\n`;
                }
            }
            
            // RSI reference lines (for RSI charts)
            if (labelPrefix.includes("RSI")) {
                // 70 line (overbought)
                const rsi70Y = y + sectionH - ((70 - yMin) / yRange) * sectionH;
                sectionSvg += `<line x1="${x}" y1="${rsi70Y}" x2="${x + sectionW}" y2="${rsi70Y}" stroke="#ff0000" stroke-width="1" stroke-dasharray="5,5" opacity="0.7"/>\n`;
                sectionSvg += `<text x="${x + sectionW - 5}" y="${rsi70Y - 5}" text-anchor="end" fill="#ff0000" font-family="Arial" font-size="10">70</text>\n`;
                
                // 30 line (oversold)
                const rsi30Y = y + sectionH - ((30 - yMin) / yRange) * sectionH;
                sectionSvg += `<line x1="${x}" y1="${rsi30Y}" x2="${x + sectionW}" y2="${rsi30Y}" stroke="#00ff00" stroke-width="1" stroke-dasharray="5,5" opacity="0.7"/>\n`;
                sectionSvg += `<text x="${x + sectionW - 5}" y="${rsi30Y - 5}" text-anchor="end" fill="#00ff00" font-family="Arial" font-size="10">30</text>\n`;
            }
            
            return sectionSvg;
        };
        
        // Draw CE Price (top left)
        svg += drawSection(
            cePrices,
            cePriceYMin,
            cePriceYMax,
            cePriceYRange,
            padding,
            padding + 20,
            sectionWidth,
            sectionHeight - 20,
            "#00ff00",
            "CE Price"
        );
        
        // Draw PE Price (top right)
        svg += drawSection(
            pePrices,
            pePriceYMin,
            pePriceYMax,
            pePriceYRange,
            padding + sectionWidth,
            padding + 20,
            sectionWidth,
            sectionHeight - 20,
            "#ff00ff",
            "PE Price"
        );
        
        // Draw CE RSI (bottom left)
        svg += drawSection(
            ceRsis,
            rsiYMin,
            rsiYMax,
            rsiYRange,
            padding,
            padding + sectionHeight + 20,
            sectionWidth,
            sectionHeight - 20,
            "#00ff00",
            "CE RSI"
        );
        
        // Draw PE RSI (bottom right)
        svg += drawSection(
            peRsis,
            rsiYMin,
            rsiYMax,
            rsiYRange,
            padding + sectionWidth,
            padding + sectionHeight + 20,
            sectionWidth,
            sectionHeight - 20,
            "#ff00ff",
            "PE RSI"
        );
        
        // Add entry/exit markers
        const addTradeMarkers = (instrument: "CE" | "PE", color: string, xOffset: number) => {
            let markers = '';
            for (const trade of liveTrades) {
                if (trade.instrument !== instrument) continue;
                
                // Find the closest chart point by matching time
                const tradeTime = dayjs(trade.timestamp).format("HH:mm:ss");
                let pointIndex = chartData.findIndex(p => p.time === tradeTime);
                
                // If exact match not found, find closest time
                if (pointIndex === -1) {
                    const tradeTimeMs = dayjs(trade.timestamp).valueOf();
                    let minDiff = Infinity;
                    chartData.forEach((p, idx) => {
                        const pointTimeMs = dayjs(`${dayjs(sessionStart).format("YYYY-MM-DD")} ${p.time}`).valueOf();
                        const diff = Math.abs(tradeTimeMs - pointTimeMs);
                        if (diff < minDiff) {
                            minDiff = diff;
                            pointIndex = idx;
                        }
                    });
                }
                
                if (pointIndex === -1 || pointIndex < 0) continue;
                
                const sectionX = padding + xOffset;
                const sectionY = trade.action === "ENTRY" ? (padding + 20) : (padding + sectionHeight + 20);
                const sectionH = sectionHeight - 20;
                
                let markerY: number;
                if (trade.action === "ENTRY") {
                    // Price chart
                    if (instrument === "CE") {
                        const priceRatio = cePriceYRange > 0 ? ((trade.price - cePriceYMin) / cePriceYRange) : 0.5;
                        markerY = padding + 20 + sectionH - (priceRatio * sectionH);
                    } else {
                        const priceRatio = pePriceYRange > 0 ? ((trade.price - pePriceYMin) / pePriceYRange) : 0.5;
                        markerY = padding + 20 + sectionH - (priceRatio * sectionH);
                    }
                } else {
                    // RSI chart (we'll use a fixed position for RSI markers)
                    markerY = sectionY + sectionH / 2;
                }
                
                // Validate trade price
                if (trade.price <= 0 || !isFinite(trade.price)) {
                    continue; // Skip invalid trade markers
                }
                
                // Prevent division by zero
                const divisor = Math.max(1, chartData.length - 1);
                const markerX = sectionX + (sectionWidth * pointIndex / divisor);
                
                // Validate marker coordinates
                if (!isFinite(markerX) || !isFinite(markerY) || markerX < 0 || markerY < 0) {
                    continue; // Skip invalid markers
                }
                
                const markerColor = trade.action === "ENTRY" ? "#00ff00" : "#ff0000";
                const markerShape = trade.action === "ENTRY" ? "▲" : "▼";
                
                markers += `<circle cx="${markerX}" cy="${markerY}" r="6" fill="${markerColor}" stroke="#ffffff" stroke-width="1"/>\n`;
                markers += `<text x="${markerX}" y="${markerY - 10}" text-anchor="middle" fill="${markerColor}" font-family="Arial" font-size="12" font-weight="bold">${markerShape}</text>\n`;
            }
            return markers;
        };
        
        svg += addTradeMarkers("CE", "#00ff00", 0);
        svg += addTradeMarkers("PE", "#ff00ff", sectionWidth);
        
        // Legend
        const legendY = height - 30;
        svg += `<text x="${padding}" y="${legendY}" fill="#ffffff" font-family="Arial" font-size="12">Legend: </text>\n`;
        svg += `<circle cx="${padding + 80}" cy="${legendY - 5}" r="4" fill="#00ff00"/>\n`;
        svg += `<text x="${padding + 95}" y="${legendY}" fill="#00ff00" font-family="Arial" font-size="12">Entry</text>\n`;
        svg += `<circle cx="${padding + 150}" cy="${legendY - 5}" r="4" fill="#ff0000"/>\n`;
        svg += `<text x="${padding + 165}" y="${legendY}" fill="#ff0000" font-family="Arial" font-size="12">Exit</text>\n`;
        svg += `<line x1="${padding + 250}" y1="${legendY - 5}" x2="${padding + 280}" y2="${legendY - 5}" stroke="#ff0000" stroke-dasharray="5,5" opacity="0.7"/>\n`;
        svg += `<text x="${padding + 290}" y="${legendY}" fill="#ff0000" font-family="Arial" font-size="12">RSI 70 (Overbought)</text>\n`;
        svg += `<line x1="${padding + 450}" y1="${legendY - 5}" x2="${padding + 480}" y2="${legendY - 5}" stroke="#00ff00" stroke-dasharray="5,5" opacity="0.7"/>\n`;
        svg += `<text x="${padding + 490}" y="${legendY}" fill="#00ff00" font-family="Arial" font-size="12">RSI 30 (Oversold)</text>\n`;
        
        svg += `</svg>`;
        
        // Save chart
        const filename = `nifty_rsi_chart.svg`;
        await writeFile(filename, svg, "utf-8");
        console.log(`📊 Chart updated: ${filename} (${currentTime})`);
        
    } catch (err) {
        console.error("Error generating chart:", err);
    }
}

async function saveTradeLog(prefix: string) {
    try {
        const header = "timestamp,instrument,action,price,quantity,orderId,pnl,reason\n";
        const rows = liveTrades.map(t => [
            t.timestamp,
            t.instrument,
            t.action,
            t.price.toFixed(2),
            t.quantity,
            t.orderId || "",
            t.pnl !== undefined ? t.pnl.toFixed(2) : "",
            `"${t.reason}"`
        ].join(",")).join("\n");

        const filename = `nifty_rsi_strategy_${prefix}_trades_${dayjs(sessionStart).format("YYYY-MM-DD")}.csv`;
        await writeFile(filename, header + rows + (rows ? "\n" : ""), "utf-8");
        console.log(`📁 Trade log saved: ${filename}`);
    } catch (err) {
        console.error("Error saving trade log:", err);
    }
}

async function getHistoricalCandles(instrumentToken: number, from: Date, to: Date): Promise<Candle[]> {
    try {
        const candles = await kc.getHistoricalData(instrumentToken, "minute", from, to, false);
        return candles as unknown as Candle[];
    } catch (err: any) {
        const errorMsg = err?.message || String(err);
        if (errorMsg.includes("TokenException") || errorMsg.includes("access_token") || errorMsg.includes("api_key")) {
            console.error(`❌ Authentication error: ${errorMsg}`);
            console.error(`💡 Solution: Run login_access_token.ts to refresh your access token`);
        } else {
            console.error(`Error fetching candles for token ${instrumentToken}:`, err);
        }
        return [];
    }
}

async function getNiftySpotToken(): Promise<number | null> {
    try {
        const instruments = await kc.getInstruments("NSE");
        const nifty = instruments.find(inst => inst.tradingsymbol === "NIFTY 50");
        return nifty ? Number(nifty.instrument_token) : null;
    } catch (err) {
        console.error("Error getting NIFTY spot token:", err);
        return null;
    }
}

function getNextExpiry(instruments: any[]): Date | null {
    const now = new Date();
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + 24 * 60 * 60 * 1000 - 1;

    const allExpiries = instruments
        .filter(inst => inst.name === "NIFTY" && inst.instrument_type === "CE")
        .map(inst => new Date(inst.expiry).getTime())
        .filter((ts, index, self) => self.indexOf(ts) === index)
        .sort((a, b) => a - b);

    const nextExpiry = allExpiries.find(ts => ts > todayEnd);
    return nextExpiry ? new Date(nextExpiry) : null;
}

// Entry point: Start live trading
init().catch(err => {
    console.error("Fatal live trading error:", err);
    process.exit(1);
});

