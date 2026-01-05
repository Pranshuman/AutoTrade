import { KiteConnect } from "kiteconnect";
import type { Product } from "kiteconnect";
import dayjs from "dayjs";
import { writeFile } from "fs/promises";
import { resolve } from "path";

// API Credentials - Read from environment variables (set by server when spawning)
const apiKey = process.env.KITE_API_KEY || "";
const apiSecret = process.env.KITE_API_SECRET || "";
const accessToken = process.env.KITE_ACCESS_TOKEN || "";

// Validate credentials
if (!apiKey || !apiSecret || !accessToken) {
    console.error("❌ Missing Kite credentials. Please ensure KITE_API_KEY, KITE_API_SECRET, and KITE_ACCESS_TOKEN are set.");
    process.exit(1);
}

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
    ceVwap: number;
    peVwap: number;
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
    ceVwap: number;
    peVwap: number;
    spotPrice: number;
};

// Constants
const lotSize = 195; 
const stopLossPoints = 30;
const profitTargetPoints = 25; // 25 points profit target
const tickSize = 0.05;

// Global state
let isTradingActive = false;
let ceStrike = 0;
let peStrike = 0;
let ceToken = 0;
let peToken = 0;
let spotToken = 0;
let ceSymbol = "";
let peSymbol = "";

let sessionStart: Date;
let sessionEnd: Date;
let entryCutoff: Date;
let tradeStartTime: Date;

// Position tracking
const cePosition: Position = { isOpen: false, entryPrice: 0, entryTime: "" };
const pePosition: Position = { isOpen: false, entryPrice: 0, entryTime: "" };

// Pending operation flags
let ceEntryPending = false;
let peEntryPending = false;
let ceExitPending = false;
let peExitPending = false;

// Stop loss tracking
let stopLossCount = 0;
const maxStopLossesPerDay = 4;

// Trade log
const liveTrades: LiveTrade[] = [];

// Chart data tracking
const chartPoints: ChartPoint[] = [];

// Track last 5-min candle processed to avoid multiple entries on the same candle
let lastProcessed5MinCandle_CE = "";
let lastProcessed5MinCandle_PE = "";

// Track previous price and VWAP from 3-second checks for new entry condition
let cePreviousPrice3s: number | null = null;
let pePreviousPrice3s: number | null = null;
let cePreviousVwap3s: number | null = null;
let pePreviousVwap3s: number | null = null;

// Latest data from 3-second fetcher (for monitoring/logging purposes)
let latestData: LiveData | null = null;

// Cached VWAP values (updated only at end of 5-minute candles)
let cachedCeVwap = 0;
let cachedPeVwap = 0;
let lastVwapUpdateTime: Date | null = null; // Track when VWAP was last updated

// Helper functions
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getTradingSymbol(instrumentToken: number): Promise<string> {
    const instruments = await kc.getInstruments("NFO");
    const instrument = instruments.find(inst => Number(inst.instrument_token) === instrumentToken);
    if (!instrument) throw new Error(`Instrument not found for token: ${instrumentToken}`);
    return instrument.tradingsymbol;
}

async function placeOrder(instrumentToken: number, transactionType: "BUY" | "SELL", quantity: number, product: Product) {
    const maxRetries = 3;
    const retryDelay = 2000;
    
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
            
            if (order && order.order_id) {
                await sleep(500);
                const orderHistory = await kc.getOrderHistory(order.order_id);
                if (orderHistory && orderHistory.length > 0) {
                    const firstOrder = orderHistory[0];
                    if (firstOrder && (firstOrder.status === "REJECTED" || firstOrder.status === "CANCELLED")) {
                        throw new Error(`Order rejected: ${firstOrder.status_message || "Unknown reason"}`);
                    }
                }
                return order;
            }
            throw new Error("Order placement failed - no order_id");
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            if (errorMsg.includes("TokenException") || errorMsg.includes("Order rejected")) throw err;
            if (attempt < maxRetries) {
                console.warn(`⚠️ Order retry ${attempt}/${maxRetries}: ${errorMsg}`);
                await sleep(retryDelay);
            } else throw err;
        }
    }
    throw new Error("Failed to place order after retries");
}

async function getHistoricalCandles(instrumentToken: number, interval: "minute" | "3minute" | "5minute" | "10minute" | "15minute" | "30minute" | "60minute" | "day", from: Date, to: Date): Promise<Candle[]> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const candles = await kc.getHistoricalData(instrumentToken, interval, from, to, false);
            return candles as unknown as Candle[];
        } catch (err: any) {
            if (attempt < maxRetries) {
                await sleep(1000);
                continue;
            }
            console.error(`Error fetching ${interval} candles for token ${instrumentToken}:`, err.message);
            return [];
        }
    }
    return [];
}

function calculateVWAP(candles: Candle[], excludeLastIfIncomplete: boolean = false, currentTime?: Date): { vwap: number; candlesUsed: number; timeRange?: string } {
    if (candles.length === 0) return { vwap: 0, candlesUsed: 0 };
    
    // If we need to exclude the last incomplete candle, check if the last candle is from the current incomplete period
    let candlesToUse = candles;
    let excludedIncomplete = false;
    if (excludeLastIfIncomplete && currentTime && candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        if (lastCandle) {
            const lastCandleTime = new Date(lastCandle.date);
            const currentMinute = currentTime.getMinutes();
            const currentSeconds = currentTime.getSeconds();
            const lastCandleMinute = lastCandleTime.getMinutes();
            
            // Determine the 5-minute period for the last candle and current time
            const lastCandlePeriod = Math.floor(lastCandleMinute / 5) * 5;
            const currentPeriod = Math.floor(currentMinute / 5) * 5;
            
            // Exclude the last candle if:
            // 1. It's from the current 5-minute period (same period)
            // 2. AND we're not at the end of that period (not at 4th minute with seconds >= 50)
            // This means the candle is still forming and incomplete
            const isIncompletePeriod = lastCandlePeriod === currentPeriod;
            const isNotAtEndOfPeriod = !(currentMinute % 5 === 4 && currentSeconds >= 50);
            
            if (isIncompletePeriod && isNotAtEndOfPeriod) {
                candlesToUse = candles.slice(0, -1);
                excludedIncomplete = true;
                if (candlesToUse.length === 0) return { vwap: 0, candlesUsed: 0 };
            }
        }
    }
    
    let cumulativePV = 0;
    let cumulativeVol = 0;
    for (const c of candlesToUse) {
        // Using hlc3 (high + low + close) / 3 for VWAP calculation (typical price)
        const price = (c.high + c.low + c.close) / 3;
        cumulativePV += price * c.volume;
        cumulativeVol += c.volume;
    }
    
    const vwap = cumulativeVol > 0 ? cumulativePV / cumulativeVol : 0;
    
    // Determine time range for logging
    let timeRange: string | undefined;
    if (candlesToUse.length > 0) {
        const firstCandle = candlesToUse[0];
        const lastCandle = candlesToUse[candlesToUse.length - 1];
        if (firstCandle && lastCandle) {
            const firstTime = new Date(firstCandle.date);
            const lastTime = new Date(lastCandle.date);
            
            // Calculate the end time of the last candle (5-minute period end)
            // Each 5-minute candle ends at minute:59 of the period
            // e.g., 9:15-9:20 candle ends at 9:19:59, 9:20-9:25 candle ends at 9:24:59
            const lastTimeMinute = lastTime.getMinutes();
            const lastTimePeriod = Math.floor(lastTimeMinute / 5) * 5;
            const lastTimeEndMinute = lastTimePeriod + 4; // End at 4th minute of the period (e.g., 19, 24, 29)
            
            const lastTimeEnd = new Date(lastTime);
            lastTimeEnd.setMinutes(lastTimeEndMinute);
            lastTimeEnd.setSeconds(59);
            
            timeRange = `${dayjs(firstTime).format("HH:mm")} - ${dayjs(lastTimeEnd).format("HH:mm")}`;
        }
    }
    
    return { 
        vwap, 
        candlesUsed: candlesToUse.length,
        timeRange
    };
}

// Lightweight function to get current prices and VWAP (for stop loss and exit checks)
// Called every 3 seconds by the data fetcher
// - Current prices: fetched from minute candles (for real-time updates)
// - VWAP: calculated from 5-minute candles from start of day (updated only at end of 5-min candles)
async function getCurrentPrices(): Promise<LiveData> {
    const maxRetries = 3;
    const retryDelay = 2000; // 2 seconds
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const now = new Date();
            const from = new Date(now.getTime() - 2 * 60 * 1000); // Last 2 minutes (minimal data)
            
            // Get latest minute candles for CE, PE, and Spot (for real-time current prices)
            const ceCandles = await getHistoricalCandles(ceToken, "minute", from, now);
            const peCandles = await getHistoricalCandles(peToken, "minute", from, now);
            const spotCandles = await getHistoricalCandles(spotToken, "minute", from, now);
            
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
            
            // Check if we're at the end of a 5-minute candle (update VWAP only then)
            // 5-minute candles end at: 9:20:00, 9:25:00, 9:30:00, 9:35:00, etc.
            // We detect this by checking if we're in a new 5-minute period compared to last update
            const currentMinute = now.getMinutes();
            const currentSeconds = now.getSeconds();
            
            // Determine the current 5-minute candle period (0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55)
            const current5MinPeriod = Math.floor(currentMinute / 5) * 5;
            const lastUpdate5MinPeriod = lastVwapUpdateTime ? 
                Math.floor(lastVwapUpdateTime.getMinutes() / 5) * 5 : -1;
            
            // Check if we're at the end of current 5-minute candle (last 10 seconds of the period)
            // OR if we've moved to a new 5-minute period (first 3 seconds of new period)
            const isEndOf5MinCandle = (currentMinute % 5 === 4 && currentSeconds >= 50) || 
                                      (currentMinute % 5 === 0 && currentSeconds < 3);
            
            // Update VWAP only if we're at the end of a 5-minute candle and it's a new period
            let ceVwap = cachedCeVwap;
            let peVwap = cachedPeVwap;
            
            if (isEndOf5MinCandle && current5MinPeriod !== lastUpdate5MinPeriod) {
                // Calculate VWAP from 5-minute candles from start of day
                // Include all completed candles up to the end of the current 5-minute period
                const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 15, 0);
                const ceCandles5Min = await getHistoricalCandles(ceToken, "5minute", startOfDay, now);
                const peCandles5Min = await getHistoricalCandles(peToken, "5minute", startOfDay, now);
                
                // At end of 5-minute candle, all candles are complete, so include all
                const ceVwapResult = calculateVWAP(ceCandles5Min, false, now);
                const peVwapResult = calculateVWAP(peCandles5Min, false, now);
                ceVwap = ceVwapResult.vwap;
                peVwap = peVwapResult.vwap;
                
                // Update cache
                cachedCeVwap = ceVwap;
                cachedPeVwap = peVwap;
                lastVwapUpdateTime = new Date(now);
                
                console.log(`📊 VWAP Updated (5-min candle end) at ${dayjs(now).format("HH:mm:ss")}:`);
                console.log(`   CE: ₹${ceVwap.toFixed(2)} (${ceVwapResult.candlesUsed} candles, ${ceVwapResult.timeRange || "N/A"})`);
                console.log(`   PE: ₹${peVwap.toFixed(2)} (${peVwapResult.candlesUsed} candles, ${peVwapResult.timeRange || "N/A"})`);
            } else if (cachedCeVwap === 0 || cachedPeVwap === 0) {
                // First time: calculate VWAP even if not at end of candle
                // Exclude the last candle if it's from the current incomplete 5-minute period
                const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 15, 0);
                const ceCandles5Min = await getHistoricalCandles(ceToken, "5minute", startOfDay, now);
                const peCandles5Min = await getHistoricalCandles(peToken, "5minute", startOfDay, now);
                
                const ceVwapResult = calculateVWAP(ceCandles5Min, true, now);
                const peVwapResult = calculateVWAP(peCandles5Min, true, now);
                ceVwap = ceVwapResult.vwap;
                peVwap = peVwapResult.vwap;
                
                // Update cache
                cachedCeVwap = ceVwap;
                cachedPeVwap = peVwap;
                lastVwapUpdateTime = new Date(now);
            }
            
            return {
                timestamp: now.getTime(),
                cePrice: latestCe.close,
                pePrice: latestPe.close,
                spotPrice: latestSpot.close,
                ceVwap,
                peVwap
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

async function getLiveData(): Promise<{ data: LiveData, ceCandles: Candle[], peCandles: Candle[] }> {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 15, 0);
    
    // Fetch 5-minute candles from start of day for entry condition checks
    const ceCandles = await getHistoricalCandles(ceToken, "5minute", startOfDay, now);
    const peCandles = await getHistoricalCandles(peToken, "5minute", startOfDay, now);
    const spotCandles = await getHistoricalCandles(spotToken, "minute", new Date(now.getTime() - 2 * 60000), now);

    // Use cached VWAP values (updated only at end of 5-minute candles)
    // This ensures consistency - VWAP doesn't change during the 5-minute period
    // Exclude last candle if incomplete when calculating fallback VWAP
    let ceVwap = cachedCeVwap;
    let peVwap = cachedPeVwap;
    if (cachedCeVwap === 0 || cachedPeVwap === 0) {
        const ceVwapResult = calculateVWAP(ceCandles, true, now);
        const peVwapResult = calculateVWAP(peCandles, true, now);
        ceVwap = ceVwapResult.vwap;
        peVwap = peVwapResult.vwap;
    }
    
    // If cache is empty, initialize it
    if (cachedCeVwap === 0 || cachedPeVwap === 0) {
        cachedCeVwap = ceVwap;
        cachedPeVwap = peVwap;
        lastVwapUpdateTime = new Date(now);
    }

    const latestCe = ceCandles[ceCandles.length - 1];
    const latestPe = peCandles[peCandles.length - 1];
    const latestSpot = spotCandles[spotCandles.length - 1];

    return {
        data: {
            timestamp: now.getTime(),
            cePrice: latestCe?.close || 0,
            pePrice: latestPe?.close || 0,
            spotPrice: latestSpot?.close || 0,
            ceVwap,
            peVwap
        },
        ceCandles,
        peCandles
    };
}

async function checkEntryConditions(data: LiveData, ceCandles: Candle[], peCandles: Candle[]) {
    const now = new Date();
    if (now < tradeStartTime || now >= sessionEnd) return;
    
    // Don't allow new entries if daily stop loss limit is reached
    if (stopLossCount >= maxStopLossesPerDay) {
        return;
    }

    if (ceCandles.length < 1 || peCandles.length < 1) return;

    const currentCeCandle = ceCandles[ceCandles.length - 1];
    const currentPeCandle = peCandles[peCandles.length - 1];

    // Validate candles exist
    if (!currentCeCandle || !currentPeCandle) return;

    // Check if we are near the end of the 5-minute candle (last 10 seconds)
    const currentMinute = now.getMinutes();
    const currentSeconds = now.getSeconds();
    const isEndOf5Min = (currentMinute + 1) % 5 === 0 && currentSeconds >= 50;
    const timeStr = dayjs().format("HH:mm:ss");

    // CE Entry
    // Entry condition: Price must be between VWAP - 10 and VWAP - 5
    // IMPORTANT: Both entry conditions check for open positions to prevent interference
    // Use the latest VWAP from getCurrentPrices() after it's been recalculated
    // Don't allow new entries if daily stop loss limit is reached
    if (!cePosition.isOpen && !ceEntryPending && isEndOf5Min && currentCeCandle.date !== lastProcessed5MinCandle_CE && stopLossCount < maxStopLossesPerDay) {
        // Fetch latest VWAP and prices to check entry condition with most current values
        try {
            const latestData = await getCurrentPrices();
            // Check entry condition using latest VWAP and latest price
            if (latestData.cePrice >= latestData.ceVwap - 10 && latestData.cePrice <= latestData.ceVwap - 5) {
                // Final safety check: Verify position is still closed before executing (prevents race condition)
                if (!cePosition.isOpen && !ceEntryPending) {
                    console.log(`[${timeStr}] ⚡ CE Entry Signal DETECTED (Price: ${latestData.cePrice.toFixed(2)} between VWAP-10: ${(latestData.ceVwap - 10).toFixed(2)} and VWAP-5: ${(latestData.ceVwap - 5).toFixed(2)}) - Executing immediately...`);
                    await executeEntry("CE", latestData.cePrice);
                    lastProcessed5MinCandle_CE = currentCeCandle.date;
                } else {
                    console.log(`[${timeStr}] ⚠️ CE Entry signal IGNORED - Position already open or entry pending`);
                }
            } else {
                console.log(`[${timeStr}] CE Entry condition NOT met: Price=${latestData.cePrice.toFixed(2)}, VWAP=${latestData.ceVwap.toFixed(2)}, Range=[${(latestData.ceVwap - 10).toFixed(2)}, ${(latestData.ceVwap - 5).toFixed(2)}]`);
            }
        } catch (err: any) {
            console.error(`❌ Error checking CE entry condition: ${err?.message || String(err)}`);
            // Fallback: check with candle data if getCurrentPrices fails
            if (currentCeCandle.close >= data.ceVwap - 10 && currentCeCandle.close <= data.ceVwap - 5) {
                // Final safety check: Verify position is still closed before executing (prevents race condition)
                if (!cePosition.isOpen && !ceEntryPending) {
                    console.log(`[${timeStr}] ⚡ CE Entry Signal DETECTED (Fallback - Price: ${currentCeCandle.close.toFixed(2)} between VWAP-10: ${(data.ceVwap - 10).toFixed(2)} and VWAP-5: ${(data.ceVwap - 5).toFixed(2)}) - Executing immediately...`);
                    await executeEntry("CE", currentCeCandle.close);
                    lastProcessed5MinCandle_CE = currentCeCandle.date;
                } else {
                    console.log(`[${timeStr}] ⚠️ CE Entry signal IGNORED (Fallback) - Position already open or entry pending`);
                }
            }
        }
    }

    // PE Entry
    // Entry condition: Price must be between VWAP - 10 and VWAP - 5
    // IMPORTANT: Both entry conditions check for open positions to prevent interference
    // Use the latest VWAP from getCurrentPrices() after it's been recalculated
    // Don't allow new entries if daily stop loss limit is reached
    if (!pePosition.isOpen && !peEntryPending && isEndOf5Min && currentPeCandle.date !== lastProcessed5MinCandle_PE && stopLossCount < maxStopLossesPerDay) {
        // Fetch latest VWAP and prices to check entry condition with most current values
        try {
            const latestData = await getCurrentPrices();
            // Check entry condition using latest VWAP and latest price
            if (latestData.pePrice >= latestData.peVwap - 10 && latestData.pePrice <= latestData.peVwap - 5) {
                // Final safety check: Verify position is still closed before executing (prevents race condition)
                if (!pePosition.isOpen && !peEntryPending) {
                    console.log(`[${timeStr}] ⚡ PE Entry Signal DETECTED (Price: ${latestData.pePrice.toFixed(2)} between VWAP-10: ${(latestData.peVwap - 10).toFixed(2)} and VWAP-5: ${(latestData.peVwap - 5).toFixed(2)}) - Executing immediately...`);
                    await executeEntry("PE", latestData.pePrice);
                    lastProcessed5MinCandle_PE = currentPeCandle.date;
                } else {
                    console.log(`[${timeStr}] ⚠️ PE Entry signal IGNORED - Position already open or entry pending`);
                }
            } else {
                console.log(`[${timeStr}] PE Entry condition NOT met: Price=${latestData.pePrice.toFixed(2)}, VWAP=${latestData.peVwap.toFixed(2)}, Range=[${(latestData.peVwap - 10).toFixed(2)}, ${(latestData.peVwap - 5).toFixed(2)}]`);
            }
        } catch (err: any) {
            console.error(`❌ Error checking PE entry condition: ${err?.message || String(err)}`);
            // Fallback: check with candle data if getCurrentPrices fails
            if (currentPeCandle.close >= data.peVwap - 10 && currentPeCandle.close <= data.peVwap - 5) {
                // Final safety check: Verify position is still closed before executing (prevents race condition)
                if (!pePosition.isOpen && !peEntryPending) {
                    console.log(`[${timeStr}] ⚡ PE Entry Signal DETECTED (Fallback - Price: ${currentPeCandle.close.toFixed(2)} between VWAP-10: ${(data.peVwap - 10).toFixed(2)} and VWAP-5: ${(data.peVwap - 5).toFixed(2)}) - Executing immediately...`);
                    await executeEntry("PE", currentPeCandle.close);
                    lastProcessed5MinCandle_PE = currentPeCandle.date;
                } else {
                    console.log(`[${timeStr}] ⚠️ PE Entry signal IGNORED (Fallback) - Position already open or entry pending`);
                }
            }
        }
    }

    // Note: Profit target is now checked continuously every 3 seconds in checkPriceBasedExitConditions()
    // for immediate execution, similar to stop loss and VWAP exit conditions
}

// Price-based exit conditions (checked continuously every 3 seconds for immediate execution)
// This function is called from the 3-second data fetcher
// VWAP is calculated from 5-minute candles, current price from minute candles
async function checkPriceBasedExitConditions(liveData: LiveData, now: string) {
    // Exit Condition 1: Price moved 25 points below entry price (profit target) - checked FIRST
    // Exit Condition 2: Option price moved 30 points above entry price (stop loss)
    // Exit Condition 3: Price > VWAP (VWAP reclaim)
    // Note: All exit conditions checked continuously every 3 seconds for immediate execution
    // Note: Profit target is checked first to prioritize profit exits over loss exits
    // Note: VWAP uses 5-minute candles, current price uses minute candles for real-time updates
    
    // Log exit check status (only when positions are open to avoid spam)
    if (cePosition.isOpen || pePosition.isOpen) {
        const ceStatus = cePosition.isOpen ? `CE: Entry=${cePosition.entryPrice.toFixed(2)}, Current=${liveData.cePrice.toFixed(2)}, Diff=${(liveData.cePrice - cePosition.entryPrice).toFixed(2)}, VWAP=${liveData.ceVwap.toFixed(2)}` : "CE: CLOSED";
        const peStatus = pePosition.isOpen ? `PE: Entry=${pePosition.entryPrice.toFixed(2)}, Current=${liveData.pePrice.toFixed(2)}, Diff=${(liveData.pePrice - pePosition.entryPrice).toFixed(2)}, VWAP=${liveData.peVwap.toFixed(2)}` : "PE: CLOSED";
        console.log(`[${now}] [Exit Check] ${ceStatus} | ${peStatus} | Stop Loss: ${stopLossPoints} pts | Profit Target: ${profitTargetPoints} pts`);
    }
    
    // CE Exit: Price moved 30 points above entry price OR price > VWAP
    if (cePosition.isOpen && !ceExitPending && cePosition.entryPrice > 0) {
        // Validate entry price is valid
        if (liveData.cePrice <= 0 || cePosition.entryPrice <= 0) {
            console.warn(`⚠️ Invalid price data: CE Price=${liveData.cePrice}, Entry Price=${cePosition.entryPrice}`);
            return;
        }
        const priceDiff = liveData.cePrice - cePosition.entryPrice;
        const isStopLoss = priceDiff >= stopLossPoints;
        const isVwapExit = liveData.cePrice > liveData.ceVwap;
        const profitDiff = cePosition.entryPrice - liveData.cePrice; // Since we're selling, profit when price goes down
        const isProfitTarget = profitDiff >= profitTargetPoints;
        
        // Log current status before checking threshold
        if (priceDiff > 0 || isVwapExit || profitDiff > 0) {
            console.log(`[${now}] [Exit Check] CE: Current=${liveData.cePrice.toFixed(2)}, Entry=${cePosition.entryPrice.toFixed(2)}, Diff=${priceDiff.toFixed(2)}/${stopLossPoints} points, Profit=${profitDiff.toFixed(2)}/${profitTargetPoints} points, VWAP=${liveData.ceVwap.toFixed(2)}`);
        }
        
        if (isProfitTarget) {
            console.log(`[${now}] ⚡⚡⚡ CE PROFIT TARGET TRIGGERED ⚡⚡⚡ - Price ${liveData.cePrice.toFixed(2)} is ${profitDiff.toFixed(2)} points below entry ${cePosition.entryPrice.toFixed(2)} (target: ${profitTargetPoints}) - Executing immediately...`);
            // Fetch latest prices immediately before executing to ensure we use the most current price
            try {
                const latestData = await getCurrentPrices();
                await executeExit("CE", latestData.cePrice, `Profit Target hit (25 pts): Price ${latestData.cePrice.toFixed(2)} is ${(cePosition.entryPrice - latestData.cePrice).toFixed(2)} points below entry ${cePosition.entryPrice.toFixed(2)}`);
            } catch (err: any) {
                console.error(`❌ Error executing CE profit target exit: ${err?.message || String(err)}`);
                // Fallback to using the original liveData if fetching fails
                await executeExit("CE", liveData.cePrice, `Profit Target hit (25 pts): Price ${liveData.cePrice.toFixed(2)} is ${profitDiff.toFixed(2)} points below entry ${cePosition.entryPrice.toFixed(2)}`);
            }
            return;
        }
        
        if (isStopLoss) {
            stopLossCount++;
            console.log(`[${now}] ⚡⚡⚡ CE STOP LOSS TRIGGERED ⚡⚡⚡ - Price ${liveData.cePrice.toFixed(2)} is ${priceDiff.toFixed(2)} points above entry ${cePosition.entryPrice.toFixed(2)} (threshold: ${stopLossPoints}) - Executing immediately...`);
            console.log(`[${now}] 📊 Stop Loss Count: ${stopLossCount}/${maxStopLossesPerDay}`);
            
            // Check if we've hit the daily stop loss limit
            if (stopLossCount >= maxStopLossesPerDay) {
                console.log(`\n${"=".repeat(80)}`);
                console.log(`🛑 DAILY STOP LOSS LIMIT REACHED (${stopLossCount}/${maxStopLossesPerDay})`);
                console.log(`🛑 Trading will stop for the day after this exit`);
                console.log(`${"=".repeat(80)}\n`);
            }
            
            // Fetch latest prices immediately before executing to ensure we use the most current price
            try {
                const latestData = await getCurrentPrices();
                await executeExit("CE", latestData.cePrice, `Price Exit (Stop Loss): Price ${latestData.cePrice.toFixed(2)} is ${(latestData.cePrice - cePosition.entryPrice).toFixed(2)} points above entry ${cePosition.entryPrice.toFixed(2)}`);
            } catch (err: any) {
                console.error(`❌ Error executing CE stop loss exit: ${err?.message || String(err)}`);
                // Fallback to using the original liveData if fetching fails
                await executeExit("CE", liveData.cePrice, `Price Exit (Stop Loss): Price ${liveData.cePrice.toFixed(2)} is ${priceDiff.toFixed(2)} points above entry ${cePosition.entryPrice.toFixed(2)}`);
            }
            
            // Stop trading if limit reached
            if (stopLossCount >= maxStopLossesPerDay) {
                isTradingActive = false;
                console.log(`\n${"=".repeat(80)}`);
                console.log(`🛑 TRADING STOPPED FOR THE DAY`);
                console.log(`🛑 Reason: ${stopLossCount} stop losses hit (limit: ${maxStopLossesPerDay})`);
                console.log(`${"=".repeat(80)}\n`);
            }
            
            return;
        }
        
        if (isVwapExit) {
            console.log(`[${now}] ⚡ CE VWAP EXIT TRIGGERED ⚡ - Price ${liveData.cePrice.toFixed(2)} > VWAP ${liveData.ceVwap.toFixed(2)} - Executing immediately...`);
            // Fetch latest prices immediately before executing to ensure we use the most current price
            try {
                const latestData = await getCurrentPrices();
                await executeExit("CE", latestData.cePrice, `Price > VWAP reclaim: Price ${latestData.cePrice.toFixed(2)} > VWAP ${latestData.ceVwap.toFixed(2)}`);
            } catch (err: any) {
                console.error(`❌ Error executing CE VWAP exit: ${err?.message || String(err)}`);
                // Fallback to using the original liveData if fetching fails
                await executeExit("CE", liveData.cePrice, `Price > VWAP reclaim: Price ${liveData.cePrice.toFixed(2)} > VWAP ${liveData.ceVwap.toFixed(2)}`);
            }
            return;
        }
    }

    // PE Exit: Price moved 30 points above entry price OR price > VWAP
    if (pePosition.isOpen && !peExitPending && pePosition.entryPrice > 0) {
        // Validate entry price is valid
        if (liveData.pePrice <= 0 || pePosition.entryPrice <= 0) {
            console.warn(`⚠️ Invalid price data: PE Price=${liveData.pePrice}, Entry Price=${pePosition.entryPrice}`);
            return;
        }
        const priceDiff = liveData.pePrice - pePosition.entryPrice;
        const isStopLoss = priceDiff >= stopLossPoints;
        const isVwapExit = liveData.pePrice > liveData.peVwap;
        const profitDiff = pePosition.entryPrice - liveData.pePrice; // Since we're selling, profit when price goes down
        const isProfitTarget = profitDiff >= profitTargetPoints;
        
        // Log current status before checking threshold
        if (priceDiff > 0 || isVwapExit || profitDiff > 0) {
            console.log(`[${now}] [Exit Check] PE: Current=${liveData.pePrice.toFixed(2)}, Entry=${pePosition.entryPrice.toFixed(2)}, Diff=${priceDiff.toFixed(2)}/${stopLossPoints} points, Profit=${profitDiff.toFixed(2)}/${profitTargetPoints} points, VWAP=${liveData.peVwap.toFixed(2)}`);
        }
        
        if (isProfitTarget) {
            console.log(`[${now}] ⚡⚡⚡ PE PROFIT TARGET TRIGGERED ⚡⚡⚡ - Price ${liveData.pePrice.toFixed(2)} is ${profitDiff.toFixed(2)} points below entry ${pePosition.entryPrice.toFixed(2)} (target: ${profitTargetPoints}) - Executing immediately...`);
            // Fetch latest prices immediately before executing to ensure we use the most current price
            try {
                const latestData = await getCurrentPrices();
                await executeExit("PE", latestData.pePrice, `Profit Target hit (25 pts): Price ${latestData.pePrice.toFixed(2)} is ${(pePosition.entryPrice - latestData.pePrice).toFixed(2)} points below entry ${pePosition.entryPrice.toFixed(2)}`);
            } catch (err: any) {
                console.error(`❌ Error executing PE profit target exit: ${err?.message || String(err)}`);
                // Fallback to using the original liveData if fetching fails
                await executeExit("PE", liveData.pePrice, `Profit Target hit (25 pts): Price ${liveData.pePrice.toFixed(2)} is ${profitDiff.toFixed(2)} points below entry ${pePosition.entryPrice.toFixed(2)}`);
            }
            return;
        }
        
        if (isStopLoss) {
            stopLossCount++;
            console.log(`[${now}] ⚡⚡⚡ PE STOP LOSS TRIGGERED ⚡⚡⚡ - Price ${liveData.pePrice.toFixed(2)} is ${priceDiff.toFixed(2)} points above entry ${pePosition.entryPrice.toFixed(2)} (threshold: ${stopLossPoints}) - Executing immediately...`);
            console.log(`[${now}] 📊 Stop Loss Count: ${stopLossCount}/${maxStopLossesPerDay}`);
            
            // Check if we've hit the daily stop loss limit
            if (stopLossCount >= maxStopLossesPerDay) {
                console.log(`\n${"=".repeat(80)}`);
                console.log(`🛑 DAILY STOP LOSS LIMIT REACHED (${stopLossCount}/${maxStopLossesPerDay})`);
                console.log(`🛑 Trading will stop for the day after this exit`);
                console.log(`${"=".repeat(80)}\n`);
            }
            
            // Fetch latest prices immediately before executing to ensure we use the most current price
            try {
                const latestData = await getCurrentPrices();
                await executeExit("PE", latestData.pePrice, `Price Exit (Stop Loss): Price ${latestData.pePrice.toFixed(2)} is ${(latestData.pePrice - pePosition.entryPrice).toFixed(2)} points above entry ${pePosition.entryPrice.toFixed(2)}`);
            } catch (err: any) {
                console.error(`❌ Error executing PE stop loss exit: ${err?.message || String(err)}`);
                // Fallback to using the original liveData if fetching fails
                await executeExit("PE", liveData.pePrice, `Price Exit (Stop Loss): Price ${liveData.pePrice.toFixed(2)} is ${priceDiff.toFixed(2)} points above entry ${pePosition.entryPrice.toFixed(2)}`);
            }
            
            // Stop trading if limit reached
            if (stopLossCount >= maxStopLossesPerDay) {
                isTradingActive = false;
                console.log(`\n${"=".repeat(80)}`);
                console.log(`🛑 TRADING STOPPED FOR THE DAY`);
                console.log(`🛑 Reason: ${stopLossCount} stop losses hit (limit: ${maxStopLossesPerDay})`);
                console.log(`${"=".repeat(80)}\n`);
            }
            
            return;
        }
        
        if (isVwapExit) {
            console.log(`[${now}] ⚡ PE VWAP EXIT TRIGGERED ⚡ - Price ${liveData.pePrice.toFixed(2)} > VWAP ${liveData.peVwap.toFixed(2)} - Executing immediately...`);
            // Fetch latest prices immediately before executing to ensure we use the most current price
            try {
                const latestData = await getCurrentPrices();
                await executeExit("PE", latestData.pePrice, `Price > VWAP reclaim: Price ${latestData.pePrice.toFixed(2)} > VWAP ${latestData.peVwap.toFixed(2)}`);
            } catch (err: any) {
                console.error(`❌ Error executing PE VWAP exit: ${err?.message || String(err)}`);
                // Fallback to using the original liveData if fetching fails
                await executeExit("PE", liveData.pePrice, `Price > VWAP reclaim: Price ${liveData.pePrice.toFixed(2)} > VWAP ${liveData.peVwap.toFixed(2)}`);
            }
            return;
        }
    }
}

async function executeEntry(type: "CE" | "PE", price: number, reason?: string) {
    const token = type === "CE" ? ceToken : peToken;
    const pos = type === "CE" ? cePosition : pePosition;
    const isPending = type === "CE" ? ceEntryPending : peEntryPending;
    const setPending = (val: boolean) => type === "CE" ? ceEntryPending = val : peEntryPending = val;

    // Prevent duplicate orders: check if position is already open or entry is pending
    if (isPending) {
        console.log(`⚠️ ${type} Entry already pending. Skipping duplicate order.`);
        return;
    }
    
    if (pos.isOpen) {
        console.log(`⚠️ ${type} Position already open at ${pos.entryPrice.toFixed(2)}. Skipping duplicate entry order.`);
        return;
    }
    
    setPending(true);
    
    try {
        // Double-check position is still closed before placing order (race condition protection)
        if (pos.isOpen) {
            console.log(`⚠️ ${type} Position became open during execution. Skipping order placement.`);
            return;
        }
        
        const now = dayjs().format("HH:mm:ss");
        let entryPrice = price;
        let orderId: string = ""; // Initialize to empty string, will be set by placeOrder
        
        try {
            const order = await placeOrder(token, "SELL", lotSize, "NRML");
            if (!order || !order.order_id) {
                throw new Error("Order placement failed - no order_id returned");
            }
            orderId = order.order_id;
            console.log(`✅ ${type} Entry order placed: ${orderId}`);
            
            // Get filled price from order book (or use current price as estimate)
            entryPrice = price;
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            console.error(`❌ Error placing ${type} entry order: ${errorMsg}`);
            
            // If it's an authentication error, don't mark position as open
            if (errorMsg.includes("Authentication error") || errorMsg.includes("TokenException")) {
                throw new Error(`Authentication error - cannot place order: ${errorMsg}`);
            }
            
            // For other errors, still throw but with more context
            throw new Error(`Failed to place ${type} entry order: ${errorMsg}`);
        }
        
        // Validate orderId was set before proceeding
        if (!orderId) {
            throw new Error("Order ID not set after order placement");
        }
        
        pos.isOpen = true;
        pos.entryPrice = entryPrice;
        pos.entryTime = dayjs().format("YYYY-MM-DD HH:mm:ss");
        pos.entryOrderId = orderId;

        // Reset previous 3-second values to prevent immediate re-entry
        if (type === "CE") {
            cePreviousPrice3s = null;
            cePreviousVwap3s = null;
        } else {
            pePreviousPrice3s = null;
            pePreviousVwap3s = null;
        }

        const trade: LiveTrade = {
            timestamp: pos.entryTime,
            instrument: type,
            action: "ENTRY",
            price: entryPrice,
            quantity: lotSize,
            orderId: orderId,
            reason: reason || "Price between VWAP - 10 and VWAP - 5"
        };
        liveTrades.push(trade);

        console.log(`\n${"=".repeat(80)}`);
        console.log(`📈 ${type} ENTRY EXECUTED @ ${trade.price.toFixed(2)} (${trade.reason})`);
        console.log(`${"=".repeat(80)}\n`);
    } catch (err: any) {
        console.error(`❌ Error executing ${type} entry: ${err?.message || String(err)}`);
    } finally {
        setPending(false);
    }
}

async function executeExit(type: "CE" | "PE", price: number, reason: string) {
    const token = type === "CE" ? ceToken : peToken;
    const pos = type === "CE" ? cePosition : pePosition;
    const isPending = type === "CE" ? ceExitPending : peExitPending;
    const setPending = (val: boolean) => type === "CE" ? ceExitPending = val : peExitPending = val;

    // Prevent duplicate orders: check if position is already closed or exit is pending
    if (isPending) {
        console.log(`⚠️ ${type} Exit already pending. Skipping duplicate order.`);
        return;
    }
    
    if (!pos.isOpen) {
        console.log(`⚠️ ${type} Position already closed. Skipping duplicate exit order.`);
        return;
    }
    
    setPending(true);
    
    try {
        // Double-check position is still open before placing order (race condition protection)
        if (!pos.isOpen) {
            console.log(`⚠️ ${type} Position became closed during execution. Skipping order placement.`);
            return;
        }
        
        const now = dayjs().format("HH:mm:ss");
        let exitPrice = price;
        let orderId: string = `${type}-EXIT-${liveTrades.length + 1}`;
        
        try {
            const order = await placeOrder(token, "BUY", lotSize, "NRML");
            orderId = order.order_id;
            console.log(`✅ ${type} Exit order placed: ${orderId}`);
            
            // Get filled price from order book (or use current price as estimate)
            exitPrice = price;
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            console.error(`❌ Error placing ${type} exit order: ${errorMsg}`);
            
            // If it's an authentication error, still try to close position locally
            if (errorMsg.includes("Authentication error") || errorMsg.includes("TokenException")) {
                console.error("⚠️ Authentication error - position may still be open in broker. Please check manually.");
                // Still close position locally to prevent further trading attempts
                // Use fallback orderId
            } else {
                throw new Error(`Failed to place ${type} exit order: ${errorMsg}`);
            }
        }
        
        const pnl = (pos.entryPrice - exitPrice) * lotSize;
        const trade: LiveTrade = {
            timestamp: dayjs().format("YYYY-MM-DD HH:mm:ss"),
            instrument: type,
            action: "EXIT",
            price: exitPrice,
            quantity: lotSize,
            orderId: orderId,
            pnl: pnl,
            reason: reason
        };
        liveTrades.push(trade);

        pos.isOpen = false;
        pos.entryPrice = 0;
        pos.entryTime = "";
        pos.entryOrderId = undefined;

        // Reset previous 3-second values to allow condition to trigger again after exit
        if (type === "CE") {
            cePreviousPrice3s = null;
            cePreviousVwap3s = null;
        } else {
            pePreviousPrice3s = null;
            pePreviousVwap3s = null;
        }

        console.log(`\n${"=".repeat(80)}`);
        console.log(`📉 ${type} EXIT EXECUTED @ ${trade.price.toFixed(2)} | PnL: ${trade.pnl?.toFixed(2)} | ${reason}`);
        console.log(`${"=".repeat(80)}\n`);
    } catch (err: any) {
        console.error(`❌ Error executing ${type} exit: ${err?.message || String(err)}`);
    } finally {
        setPending(false);
    }
}

async function squareOffAll(reason: string) {
    try {
        const liveData = await getLiveData();
        const now = dayjs().format("HH:mm:ss");
        if (cePosition.isOpen) {
            try {
                await executeExit("CE", liveData.data.cePrice, reason);
            } catch (err: any) {
                console.error(`❌ Error squaring off CE position: ${err?.message || String(err)}`);
                // Mark position as closed locally even if order failed
                cePosition.isOpen = false;
            }
        }
        if (pePosition.isOpen) {
            try {
                await executeExit("PE", liveData.data.pePrice, reason);
            } catch (err: any) {
                console.error(`❌ Error squaring off PE position: ${err?.message || String(err)}`);
                // Mark position as closed locally even if order failed
                pePosition.isOpen = false;
            }
        }
    } catch (err: any) {
        console.error(`❌ Error in squareOffAll: ${err?.message || String(err)}`);
        // Ensure positions are marked as closed locally
        cePosition.isOpen = false;
        pePosition.isOpen = false;
    }
}

async function generateVWAPChart() {
    try {
        if (chartPoints.length < 2) {
            console.log(`📊 Chart generation skipped: Not enough data points (${chartPoints.length}/2)`);
            return; // Need minimum data points
        }
        
        console.log(`📊 Generating VWAP chart with ${chartPoints.length} data points...`);
        const currentTime = dayjs().format("YYYY-MM-DD HH:mm:ss");
        const chartData = chartPoints.slice(-50); // Last 50 data points
        
        const width = 1600;
        const height = 900;
        const padding = 100;
        const chartWidth = width - 2 * padding;
        const chartHeight = height - 2 * padding;
        
        // Split into 4 sections: CE Price, CE VWAP, PE Price, PE VWAP
        const sectionWidth = chartWidth / 2;
        const sectionHeight = chartHeight / 2;
        
        // Extract data
        const cePrices = chartData.map(p => p.cePrice);
        const ceVwaps = chartData.map(p => p.ceVwap);
        const pePrices = chartData.map(p => p.pePrice);
        const peVwaps = chartData.map(p => p.peVwap);
        const timeLabels = chartData.map(p => p.time);
        
        // Calculate ranges with validation
        const validCePrices = cePrices.filter(p => p > 0 && isFinite(p));
        const validPePrices = pePrices.filter(p => p > 0 && isFinite(p));
        const validCeVwaps = ceVwaps.filter(v => v > 0 && isFinite(v));
        const validPeVwaps = peVwaps.filter(v => v > 0 && isFinite(v));
        
        if (validCePrices.length === 0 || validPePrices.length === 0 || validCeVwaps.length === 0 || validPeVwaps.length === 0) {
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
        
        const ceVwapMax = Math.max(...validCeVwaps);
        const ceVwapMin = Math.min(...validCeVwaps);
        const ceVwapRange = ceVwapMax - ceVwapMin || 1;
        const ceVwapPadding = ceVwapRange * 0.1 || 1;
        const ceVwapYMin = Math.max(0, ceVwapMin - ceVwapPadding);
        const ceVwapYMax = ceVwapMax + ceVwapPadding;
        const ceVwapYRange = ceVwapYMax - ceVwapYMin || 1;
        
        const peVwapMax = Math.max(...validPeVwaps);
        const peVwapMin = Math.min(...validPeVwaps);
        const peVwapRange = peVwapMax - peVwapMin || 1;
        const peVwapPadding = peVwapRange * 0.1 || 1;
        const peVwapYMin = Math.max(0, peVwapMin - peVwapPadding);
        const peVwapYMax = peVwapMax + peVwapPadding;
        const peVwapYRange = peVwapYMax - peVwapYMin || 1;
        
        // Create SVG
        let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        svg += `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">\n`;
        svg += `<rect width="${width}" height="${height}" fill="#000000"/>\n`;
        
        // Title
        svg += `<text x="${width/2}" y="30" text-anchor="middle" fill="#ffffff" font-family="Arial" font-size="20" font-weight="bold">NIFTY VWAP Strategy - Price &amp; VWAP Chart - ${currentTime}</text>\n`;
        
        // Section titles
        svg += `<text x="${padding + sectionWidth/2}" y="70" text-anchor="middle" fill="#00ff00" font-family="Arial" font-size="16" font-weight="bold">CE (${ceStrike}) Price</text>\n`;
        svg += `<text x="${padding + sectionWidth + sectionWidth/2}" y="70" text-anchor="middle" fill="#ff00ff" font-family="Arial" font-size="16" font-weight="bold">PE (${peStrike}) Price</text>\n`;
        svg += `<text x="${padding + sectionWidth/2}" y="${padding + sectionHeight + 30}" text-anchor="middle" fill="#00ff00" font-family="Arial" font-size="16" font-weight="bold">CE (${ceStrike}) VWAP</text>\n`;
        svg += `<text x="${padding + sectionWidth + sectionWidth/2}" y="${padding + sectionHeight + 30}" text-anchor="middle" fill="#ff00ff" font-family="Arial" font-size="16" font-weight="bold">PE (${peStrike}) VWAP</text>\n`;
        
        // Helper function to draw a chart section
        const drawSection = (
            priceData: number[],
            vwapData: number[],
            yMin: number,
            yMax: number,
            yRange: number,
            vwapYMin: number,
            vwapYMax: number,
            vwapYRange: number,
            x: number,
            y: number,
            sectionW: number,
            sectionH: number,
            priceColor: string,
            vwapColor: string,
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
            
            // Price data line
            if (priceData.length > 1) {
                let pathData = '';
                for (let i = 0; i < priceData.length; i++) {
                    const value = priceData[i];
                    if (value === undefined || isNaN(value) || !isFinite(value)) continue;
                    const pathX = x + (sectionW * i / (priceData.length - 1));
                    const pathY = y + sectionH - ((value - yMin) / yRange) * sectionH;
                    if (!isNaN(pathX) && !isNaN(pathY) && isFinite(pathX) && isFinite(pathY)) {
                        pathData += (i === 0 ? 'M' : 'L') + `${pathX},${pathY} `;
                    }
                }
                if (pathData.trim()) {
                    sectionSvg += `<path d="${pathData.trim()}" stroke="${priceColor}" stroke-width="2" fill="none"/>\n`;
                }
            }
            
            // VWAP data line
            if (vwapData.length > 1) {
                let pathData = '';
                for (let i = 0; i < vwapData.length; i++) {
                    const value = vwapData[i];
                    if (value === undefined || isNaN(value) || !isFinite(value)) continue;
                    const pathX = x + (sectionW * i / (vwapData.length - 1));
                    const pathY = y + sectionH - ((value - vwapYMin) / vwapYRange) * sectionH;
                    if (!isNaN(pathX) && !isNaN(pathY) && isFinite(pathX) && isFinite(pathY)) {
                        pathData += (i === 0 ? 'M' : 'L') + `${pathX},${pathY} `;
                    }
                }
                if (pathData.trim()) {
                    sectionSvg += `<path d="${pathData.trim()}" stroke="${vwapColor}" stroke-width="2" fill="none" stroke-dasharray="5,5" opacity="0.7"/>\n`;
                }
            }
            
            return sectionSvg;
        };
        
        // Draw CE Price & VWAP (top left)
        svg += drawSection(
            cePrices,
            ceVwaps,
            cePriceYMin,
            cePriceYMax,
            cePriceYRange,
            ceVwapYMin,
            ceVwapYMax,
            ceVwapYRange,
            padding,
            padding + 20,
            sectionWidth,
            sectionHeight - 20,
            "#00ff00",
            "#ffff00",
            "CE"
        );
        
        // Draw PE Price & VWAP (top right)
        svg += drawSection(
            pePrices,
            peVwaps,
            pePriceYMin,
            pePriceYMax,
            pePriceYRange,
            peVwapYMin,
            peVwapYMax,
            peVwapYRange,
            padding + sectionWidth,
            padding + 20,
            sectionWidth,
            sectionHeight - 20,
            "#ff00ff",
            "#ffff00",
            "PE"
        );
        
        // Draw CE VWAP only (bottom left)
        svg += drawSection(
            [],
            ceVwaps,
            ceVwapYMin,
            ceVwapYMax,
            ceVwapYRange,
            ceVwapYMin,
            ceVwapYMax,
            ceVwapYRange,
            padding,
            padding + sectionHeight + 20,
            sectionWidth,
            sectionHeight - 20,
            "#00ff00",
            "#ffff00",
            "CE VWAP"
        );
        
        // Draw PE VWAP only (bottom right)
        svg += drawSection(
            [],
            peVwaps,
            peVwapYMin,
            peVwapYMax,
            peVwapYRange,
            peVwapYMin,
            peVwapYMax,
            peVwapYRange,
            padding + sectionWidth,
            padding + sectionHeight + 20,
            sectionWidth,
            sectionHeight - 20,
            "#ff00ff",
            "#ffff00",
            "PE VWAP"
        );
        
        // Add entry/exit markers
        const addTradeMarkers = (instrument: "CE" | "PE", color: string, xOffset: number, isPriceChart: boolean) => {
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
                const sectionY = isPriceChart ? (padding + 20) : (padding + sectionHeight + 20);
                const sectionH = sectionHeight - 20;
                
                let markerY: number;
                if (isPriceChart) {
                    // Price chart
                    if (instrument === "CE") {
                        const priceRatio = cePriceYRange > 0 ? ((trade.price - cePriceYMin) / cePriceYRange) : 0.5;
                        markerY = padding + 20 + sectionH - (priceRatio * sectionH);
                    } else {
                        const priceRatio = pePriceYRange > 0 ? ((trade.price - pePriceYMin) / pePriceYRange) : 0.5;
                        markerY = padding + 20 + sectionH - (priceRatio * sectionH);
                    }
                } else {
                    // VWAP chart - use middle position
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
        
        svg += addTradeMarkers("CE", "#00ff00", 0, true);
        svg += addTradeMarkers("PE", "#ff00ff", sectionWidth, true);
        
        // Legend
        const legendY = height - 30;
        svg += `<text x="${padding}" y="${legendY}" fill="#ffffff" font-family="Arial" font-size="12">Legend: </text>\n`;
        svg += `<circle cx="${padding + 80}" cy="${legendY - 5}" r="4" fill="#00ff00"/>\n`;
        svg += `<text x="${padding + 95}" y="${legendY}" fill="#00ff00" font-family="Arial" font-size="12">Entry</text>\n`;
        svg += `<circle cx="${padding + 150}" cy="${legendY - 5}" r="4" fill="#ff0000"/>\n`;
        svg += `<text x="${padding + 165}" y="${legendY}" fill="#ff0000" font-family="Arial" font-size="12">Exit</text>\n`;
        svg += `<line x1="${padding + 250}" y1="${legendY - 5}" x2="${padding + 280}" y2="${legendY - 5}" stroke="#ffff00" stroke-dasharray="5,5" opacity="0.7"/>\n`;
        svg += `<text x="${padding + 290}" y="${legendY}" fill="#ffff00" font-family="Arial" font-size="12">VWAP</text>\n`;
        
        svg += `</svg>`;
        
        // Save chart
        const filename = `nifty_vwap_chart.svg`;
        const filePath = resolve(filename);
        await writeFile(filename, svg, "utf-8");
        console.log(`📊 ✅ Chart saved successfully: ${filename}`);
        console.log(`   Full path: ${filePath}`);
        console.log(`   Data points: ${chartData.length}, Total collected: ${chartPoints.length}`);
        console.log(`   Time: ${currentTime}`);
        
    } catch (err) {
        console.error("❌ Error generating chart:", err);
        if (err instanceof Error) {
            console.error(`   Error message: ${err.message}`);
            console.error(`   Stack: ${err.stack}`);
        }
    }
}

async function saveTradeLog() {
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

        const filename = `vwap_rsi_strategy_live_trades_${dayjs(sessionStart).format("YYYY-MM-DD")}.csv`;
        await writeFile(filename, header + rows + (rows ? "\n" : ""), "utf-8");
        console.log(`📁 Trade log saved: ${filename}`);
    } catch (err) {
        console.error("Error saving trade log:", err);
    }
}

// Separate data fetcher that runs every 3 seconds
// - Fetches current prices (minute candles) and VWAP (5-minute candles)
// - Checks exit conditions (stop loss and VWAP reclaim) every 3 seconds for immediate execution
async function startDataFetcher() {
    console.log("📊 Starting 3-second data fetcher (for price monitoring and exit checks)...");
    
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
                // Chart data collection starts at 9:20 AM (entryCutoff) when strikes are finalized
                if (now >= entryCutoff && ceStrike > 0 && peStrike > 0) {
                    // After strikes are selected - show full details with position status
                    const ceStatus = cePosition.isOpen ? `[OPEN @ ${cePosition.entryPrice.toFixed(2)}]` : "[CLOSED]";
                    const peStatus = pePosition.isOpen ? `[OPEN @ ${pePosition.entryPrice.toFixed(2)}]` : "[CLOSED]";
                    console.log(`[${timeStr}] [3s] 💰 Price - CE(${ceStrike}): ₹${data.cePrice.toFixed(2)} ${ceStatus} | PE(${peStrike}): ₹${data.pePrice.toFixed(2)} ${peStatus} | Spot: ₹${data.spotPrice.toFixed(2)} | CE VWAP: ₹${data.ceVwap.toFixed(2)} | PE VWAP: ₹${data.peVwap.toFixed(2)}`);
                    
                    // Collect chart data once per minute (at the start of each minute)
                    // Starts collecting at 9:20 AM (entryCutoff) when strikes are finalized
                    const currentMinute = now.getMinutes();
                    const currentSeconds = now.getSeconds();
                    const lastChartPoint = chartPoints.length > 0 ? chartPoints[chartPoints.length - 1] : null;
                    const lastChartTime = lastChartPoint ? dayjs(`${dayjs(sessionStart).format("YYYY-MM-DD")} ${lastChartPoint.time}`) : null;
                    const lastChartMinute = lastChartTime ? lastChartTime.minute() : -1;
                    
                    // Collect data once per minute (in first 5 seconds of each minute)
                    if (currentSeconds < 5 && currentMinute !== lastChartMinute) {
                        chartPoints.push({
                            time: timeStr,
                            cePrice: data.cePrice,
                            pePrice: data.pePrice,
                            ceVwap: data.ceVwap,
                            peVwap: data.peVwap,
                            spotPrice: data.spotPrice
                        });
                        console.log(`📊 Chart data collected: ${timeStr} (CE: ${data.cePrice.toFixed(2)}, PE: ${data.pePrice.toFixed(2)})`);
                        
                        // Keep only last 200 data points
                        if (chartPoints.length > 200) {
                            chartPoints.shift();
                        }
                        
                        // Generate chart every minute (if we have enough data)
                        // Chart generation starts at 9:20 AM (entryCutoff) - no need to wait for tradeStartTime
                        if (chartPoints.length >= 2) {
                            try {
                                await generateVWAPChart();
                            } catch (err: any) {
                                console.error(`❌ Error generating chart: ${err?.message || String(err)}`);
                                if (err instanceof Error) {
                                    console.error(`   Stack: ${err.stack}`);
                                }
                            }
                        } else {
                            console.log(`📊 Waiting for more chart data (${chartPoints.length}/2 points collected)...`);
                        }
                    }
                } else if (ceStrike > 0 && peStrike > 0) {
                    // Strikes selected but before entry cutoff - show basic price data
                    console.log(`[${timeStr}] [3s] 💰 Price - CE(${ceStrike}): ₹${data.cePrice.toFixed(2)} | PE(${peStrike}): ₹${data.pePrice.toFixed(2)} | Spot: ₹${data.spotPrice.toFixed(2)} | CE VWAP: ₹${data.ceVwap.toFixed(2)} | PE VWAP: ₹${data.peVwap.toFixed(2)}`);
                } else {
                    // Before strikes are selected - show spot price
                    console.log(`[${timeStr}] [3s] 💰 Price - Spot: ₹${data.spotPrice.toFixed(2)} (Waiting for strike selection at 9:20 AM)`);
                }
                
                // Check entry and exit conditions every 3 seconds (immediate execution)
                // Only check if strikes are selected (after 9:20 AM) and trading has started (after 10:00 AM)
                if (now >= tradeStartTime) {
                    try {
                        // Check new instant entry condition: Price crosses below VWAP - 10
                        // Condition: No open position AND previous price >= VWAP - 10 AND current price < VWAP - 10
                        // IMPORTANT: Both entry conditions check for open positions to prevent interference
                        // CE Entry: Price crosses below VWAP - 10
                        // Don't allow new entries if daily stop loss limit is reached
                        if (!cePosition.isOpen && !ceEntryPending && cePreviousPrice3s !== null && cePreviousVwap3s !== null && stopLossCount < maxStopLossesPerDay) {
                            const previousLowerBound = cePreviousVwap3s - 10;
                            const currentLowerBound = data.ceVwap - 10;
                            
                            // Check if price crossed below the lower bound (VWAP - 10)
                            if (cePreviousPrice3s >= previousLowerBound && data.cePrice < currentLowerBound) {
                                // Final safety check: Verify position is still closed before executing (prevents race condition)
                                if (!cePosition.isOpen && !ceEntryPending) {
                                    console.log(`[${timeStr}] ⚡⚡⚡ CE INSTANT ENTRY SIGNAL ⚡⚡⚡ - Price crossed below VWAP-10 (${cePreviousPrice3s.toFixed(2)} >= ${previousLowerBound.toFixed(2)} -> ${data.cePrice.toFixed(2)} < ${currentLowerBound.toFixed(2)}) - Executing immediately...`);
                                    await executeEntry("CE", data.cePrice, `Instant entry: Price crossed below VWAP-10 (${cePreviousPrice3s.toFixed(2)} >= ${previousLowerBound.toFixed(2)} -> ${data.cePrice.toFixed(2)} < ${currentLowerBound.toFixed(2)})`);
                                } else {
                                    console.log(`[${timeStr}] ⚠️ CE Instant entry signal IGNORED - Position already open or entry pending`);
                                }
                            }
                        } else if (stopLossCount >= maxStopLossesPerDay) {
                            // Silently skip entry if stop loss limit reached (to avoid log spam)
                        }
                        
                        // PE Entry: Price crosses below VWAP - 10
                        // IMPORTANT: Both entry conditions check for open positions to prevent interference
                        // Don't allow new entries if daily stop loss limit is reached
                        if (!pePosition.isOpen && !peEntryPending && pePreviousPrice3s !== null && pePreviousVwap3s !== null && stopLossCount < maxStopLossesPerDay) {
                            const previousLowerBound = pePreviousVwap3s - 10;
                            const currentLowerBound = data.peVwap - 10;
                            
                            // Check if price crossed below the lower bound (VWAP - 10)
                            if (pePreviousPrice3s >= previousLowerBound && data.pePrice < currentLowerBound) {
                                // Final safety check: Verify position is still closed before executing (prevents race condition)
                                if (!pePosition.isOpen && !peEntryPending) {
                                    console.log(`[${timeStr}] ⚡⚡⚡ PE INSTANT ENTRY SIGNAL ⚡⚡⚡ - Price crossed below VWAP-10 (${pePreviousPrice3s.toFixed(2)} >= ${previousLowerBound.toFixed(2)} -> ${data.pePrice.toFixed(2)} < ${currentLowerBound.toFixed(2)}) - Executing immediately...`);
                                    await executeEntry("PE", data.pePrice, `Instant entry: Price crossed below VWAP-10 (${pePreviousPrice3s.toFixed(2)} >= ${previousLowerBound.toFixed(2)} -> ${data.pePrice.toFixed(2)} < ${currentLowerBound.toFixed(2)})`);
                                } else {
                                    console.log(`[${timeStr}] ⚠️ PE Instant entry signal IGNORED - Position already open or entry pending`);
                                }
                            }
                        } else if (stopLossCount >= maxStopLossesPerDay) {
                            // Silently skip entry if stop loss limit reached (to avoid log spam)
                        }
                        
                        // Check exit conditions (stop loss and VWAP reclaim) - performed every 3 seconds
                        await checkPriceBasedExitConditions(data, timeStr);
                        
                        // Update previous values for next 3-second check (after all checks are done)
                        cePreviousPrice3s = data.cePrice;
                        pePreviousPrice3s = data.pePrice;
                        cePreviousVwap3s = data.ceVwap;
                        pePreviousVwap3s = data.peVwap;
                    } catch (err: any) {
                        console.error(`❌ Error checking entry/exit conditions: ${err?.message || String(err)}`);
                        if (err instanceof Error) {
                            console.error(`   Stack: ${err.stack}`);
                        }
                    }
                } else {
                    // Update previous values even if trading hasn't started (to initialize them)
                    cePreviousPrice3s = data.cePrice;
                    pePreviousPrice3s = data.pePrice;
                    cePreviousVwap3s = data.ceVwap;
                    pePreviousVwap3s = data.peVwap;
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

async function startTradingLoop() {
    isTradingActive = true;
    console.log("\n🚀 Starting live VWAP trading...");
    
    while (isTradingActive) {
        try {
        const now = new Date();
            
            // Check if session has ended
        if (now >= sessionEnd) {
                console.log("\n⏰ Session ended. Squaring off positions...");
                try {
                    const liveData = await getLiveData();
                    await squareOffAll("Session end - Square off");
                } catch (err: any) {
                    console.error(`❌ Error during session end square off: ${err?.message || String(err)}`);
                    console.error("⚠️ Please check and close positions manually in your broker account.");
                }
                
                try {
            await saveTradeLog();
                } catch (err: any) {
                    console.error(`❌ Error saving trade log: ${err?.message || String(err)}`);
                }
                
            break;
        }

            // Skip if before market open
            if (now < sessionStart) {
                console.log(`Waiting for market open... (${dayjs(now).format("HH:mm:ss")})`);
                await sleep(15000);
                continue;
            }
            
            // Check entry conditions (only at end of 5-minute candles)
            // Exit conditions are checked in the 3-second data fetcher
            try {
                const liveData = await getLiveData();
                await checkEntryConditions(liveData.data, liveData.ceCandles, liveData.peCandles);
            } catch (err: any) {
                const errorMsg = err?.message || String(err);
                console.error(`❌ Error in trading loop: ${errorMsg}`);
                
                // If it's an authentication error, stop trading
                if (errorMsg.includes("Authentication error") || errorMsg.includes("TokenException")) {
                    console.error("❌ Authentication error detected. Stopping live trading.");
                    console.error("💡 Solution: Run login_access_token.ts to refresh your access token");
                    isTradingActive = false;
                    break;
                }
            }
            
            // Wait 5 seconds before next check (entry conditions only checked at end of 5-min candles)
            await sleep(5000);
            
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
        const now = new Date();
        // Get today's date in IST (YYYY-MM-DD format)
        const istOffset = 5.5 * 60 * 60 * 1000;
        const istTimestamp = now.getTime() + istOffset;
        const istDate = new Date(istTimestamp);
        const todayStr = `${istDate.getUTCFullYear()}-${String(istDate.getUTCMonth() + 1).padStart(2, '0')}-${String(istDate.getUTCDate()).padStart(2, '0')}`;
        
        // Create session times in IST (09:15, 09:20, 10:00, 15:20 IST)
        // Use ISO string with IST timezone offset (+05:30)
        const createISTDate = (hour: number, minute: number) => {
            const hourStr = String(hour).padStart(2, '0');
            const minStr = String(minute).padStart(2, '0');
            const istTimeString = `${todayStr}T${hourStr}:${minStr}:00+05:30`;
            return new Date(istTimeString);
        };
        
        sessionStart = createISTDate(9, 15);   // 09:15 IST
        entryCutoff = createISTDate(9, 20);    // 09:20 IST
        tradeStartTime = createISTDate(10, 0); // 10:00 IST
        sessionEnd = createISTDate(15, 20);    // 15:20 IST

        console.log(`Session: ${dayjs(sessionStart).format("HH:mm:ss")} - ${dayjs(sessionEnd).format("HH:mm:ss")}`);
        console.log(`Entry Cutoff: ${dayjs(entryCutoff).format("HH:mm:ss")}`);
        console.log(`Trade Start Time: ${dayjs(tradeStartTime).format("HH:mm:ss")}`);

        // Get Nifty Spot Token
        const nseInstruments = await kc.getInstruments("NSE");
        const nifty = nseInstruments.find(inst => inst.tradingsymbol === "NIFTY 50");
        if (!nifty) throw new Error("Nifty 50 spot not found");
        spotToken = Number(nifty.instrument_token);

        // Wait for 9:20 for strike selection
        if (now < entryCutoff) {
            const waitMs = entryCutoff.getTime() - now.getTime();
            console.log(`Waiting ${Math.round(waitMs / 1000 / 60)} minutes until 9:20 AM for strike selection...`);
            await sleep(waitMs);
        }

        // Strike Selection
        const spotCandles = await getHistoricalCandles(spotToken, "minute", new Date(Date.now() - 5 * 60000), new Date());
        if (spotCandles.length === 0) {
            throw new Error("No spot candles available for strike selection");
        }
        const lastSpotCandle = spotCandles[spotCandles.length - 1];
        if (!lastSpotCandle) {
            throw new Error("Invalid spot candle data");
        }
        const spotPrice = lastSpotCandle.close;
        const atmStrike = Math.round(spotPrice / 50) * 50;
        ceStrike = atmStrike - 150;
        peStrike = atmStrike + 150;

        console.log(`Spot: ${spotPrice.toFixed(2)} | ATM: ${atmStrike}`);
        console.log(`PE Strike: ${peStrike} (150 points above ATM)`);
        console.log(`CE Strike: ${ceStrike} (150 points below ATM)`);
        const strikeDiff = peStrike - ceStrike;
        console.log(`Relationship: PE (${peStrike}) is ${strikeDiff} points above CE (${ceStrike})`);

        const nfoInstruments = await kc.getInstruments("NFO");
        // Get next expiry (first expiry after today, excluding today if it's an expiry)
        const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + 24 * 60 * 60 * 1000 - 1;
        
        const expiries = nfoInstruments
            .filter(inst => inst.name === "NIFTY" && inst.instrument_type === "CE" && inst.expiry)
            .map(inst => new Date(inst.expiry).getTime())
            .filter((ts, idx, self) => self.indexOf(ts) === idx && ts > todayEnd)
            .sort((a, b) => a - b);
        if (expiries.length === 0 || expiries[0] === undefined) {
            throw new Error("No valid expiry found for NIFTY");
        }
        const nextExpiry = new Date(expiries[0]);
        
        console.log(`📅 Selected Expiry: ${dayjs(nextExpiry).format("YYYY-MM-DD")} (Next available expiry after today)`);
        
        const ce = nfoInstruments.find(inst => inst.name === "NIFTY" && inst.strike === ceStrike && inst.instrument_type === "CE" && new Date(inst.expiry).getTime() === nextExpiry.getTime());
        const pe = nfoInstruments.find(inst => inst.name === "NIFTY" && inst.strike === peStrike && inst.instrument_type === "PE" && new Date(inst.expiry).getTime() === nextExpiry.getTime());

        if (!ce || !pe) throw new Error("Could not find CE/PE instruments");
        ceToken = Number(ce.instrument_token);
        peToken = Number(pe.instrument_token);
        ceSymbol = ce.tradingsymbol;
        peSymbol = pe.tradingsymbol;

        console.log(`CE: ${ceSymbol} (${ceToken}) | PE: ${peSymbol} (${peToken}) | Expiry: ${dayjs(nextExpiry).format("YYYY-MM-DD")}`);

        // Initialize VWAP immediately from 9:15 AM (market open) now that tokens are available
        // Exclude the last candle if it's from the current incomplete 5-minute period
        try {
            const now = new Date();
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 15, 0);
            const ceCandles5Min = await getHistoricalCandles(ceToken, "5minute", startOfDay, now);
            const peCandles5Min = await getHistoricalCandles(peToken, "5minute", startOfDay, now);
            
            const ceVwapResult = calculateVWAP(ceCandles5Min, true, now);
            const peVwapResult = calculateVWAP(peCandles5Min, true, now);
            cachedCeVwap = ceVwapResult.vwap;
            cachedPeVwap = peVwapResult.vwap;
            lastVwapUpdateTime = new Date(now);
            
            console.log(`📊 VWAP Initialized from 9:15 AM at ${dayjs(now).format("HH:mm:ss")}:`);
            console.log(`   CE: ₹${cachedCeVwap.toFixed(2)} (${ceVwapResult.candlesUsed} candles, ${ceVwapResult.timeRange || "N/A"})`);
            console.log(`   PE: ₹${cachedPeVwap.toFixed(2)} (${peVwapResult.candlesUsed} candles, ${peVwapResult.timeRange || "N/A"})`);
        } catch (err: any) {
            console.warn(`⚠️ Could not initialize VWAP: ${err?.message || String(err)}`);
            // Continue anyway - VWAP will be calculated on first getCurrentPrices call
        }

        // Set trading active flag BEFORE starting data fetcher
        // This ensures the data fetcher's while loop will run
        isTradingActive = true;
        
        // Start 3-second data fetcher in parallel (doesn't affect entry logic)
        // Only start after instruments are initialized (tokens are available)
        console.log("📊 Starting 3-second price monitoring after instrument initialization...");
        startDataFetcher().catch(err => {
            console.error("❌ Fatal error in data fetcher:", err);
            if (err instanceof Error) {
                console.error(`   Message: ${err.message}`);
                console.error(`   Stack: ${err.stack}`);
            }
        });
        
        // Start live trading (entry condition check loop)
        await startTradingLoop();

    } catch (err: any) {
        const errorMsg = err?.message || String(err);
        console.error("❌ Fatal error in init:", errorMsg);
        
        // If positions are open, try to square them off before exiting
        if (cePosition.isOpen || pePosition.isOpen) {
            console.log("\n⚠️ Attempting to square off open positions before exit...");
            try {
                const liveData = await getLiveData().catch(() => null);
                if (liveData) {
                    await squareOffAll("Emergency square off - init error");
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
            await saveTradeLog();
        } catch (logErr) {
            console.error("❌ Error saving trade log:", logErr);
        }
        
        process.exit(1);
    }
}

init();

