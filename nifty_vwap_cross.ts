import { KiteConnect } from "kiteconnect";
import type { Product } from "kiteconnect";
import dayjs from "dayjs";
import { writeFile } from "fs/promises";

// API Credentials
const apiKey = "gssli7u395tn5in8";
const apiSecret = "yeq4xu913i50u2d5j5b0wkgqp6cp0ufo";
const accessToken = "vnsjkQtYWqrzbkoJDzED3kHvBpKJiNfG";
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
    entryVwap: number;
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

// Global state
let isTradingActive = false;
let ceStrike = 0; // Spot - 300
let peStrike = 0; // Spot + 300
let ceToken = 0;
let peToken = 0;
let spotToken = 0;
let ceSymbol = "";
let peSymbol = "";
let lotSize = 300; // NIFTY lot size
let initialStopLossOffset = 10; // Initial stop loss offset (Entry price + 10)
let trailingDropStepPoints = 5; // Price drop (in points) needed to move the trailing stop
let trailingExitAdjustment = 2.5; // Amount (in points) to move the stop after each drop
const tickSize = 0.05; // NIFTY options tick size (5 paise)
let sessionStart: Date;
let sessionEnd: Date;
let entryCutoff: Date;

// Position tracking
const cePosition: Position = { isOpen: false, entryPrice: 0, entryTime: "", entryVwap: 0 };
const pePosition: Position = { isOpen: false, entryPrice: 0, entryTime: "", entryVwap: 0 };

// Pending operation flags to prevent race conditions
let ceEntryPending = false;
let peEntryPending = false;
let ceExitPending = false;
let peExitPending = false;

// VWAP cross tracking (to detect when price crosses VWAP)
let cePreviousPrice = 0;
let pePreviousPrice = 0;
let cePreviousVwap = 0;
let pePreviousVwap = 0;

// Trailing stop tracking
let ceExitThreshold = 0;
let peExitThreshold = 0;
let ceNextTrailTrigger = 0;
let peNextTrailTrigger = 0;
let ceTrailingSteps = 0; // Number of trailing steps activated (0 = not activated, 1 = first drop, 2 = second drop, etc.)
let peTrailingSteps = 0;
let ceIsCategory2 = false; // Track if current CE position is Category 2 entry
let peIsCategory2 = false; // Track if current PE position is Category 2 entry


// Track consecutive data points where price is above VWAP (for entry eligibility)
// Entry is only allowed after price has been above VWAP for 30 seconds (10 data points)
let ceConsecutiveAboveVwap = 0;
let peConsecutiveAboveVwap = 0;
const requiredConsecutiveAboveVwap = 10; // 10 data points = 30 seconds (3 seconds per data point)

// Track minimum low after VWAP cross (for second entry condition)
// Start tracking when price crosses VWAP from above to below
let ceMinLowAfterVwapCross = Number.MAX_VALUE;
let peMinLowAfterVwapCross = Number.MAX_VALUE;
let ceHasExitedOnce = false; // Track if at least one exit has happened for CE
let peHasExitedOnce = false; // Track if at least one exit has happened for PE
let ceLastExitPrice = 0; // Track last exit price for midpoint re-entry
let peLastExitPrice = 0;

// Stop loss order tracking
let ceStopLossOrderId: string | undefined;
let peStopLossOrderId: string | undefined;

// Trade log
const liveTrades: LiveTrade[] = [];

// Chart data history
let cePriceHistory: number[] = [];
let pePriceHistory: number[] = [];
let ceVwapHistory: number[] = [];
let peVwapHistory: number[] = [];
let spotPriceHistory: number[] = [];
let timeHistory: string[] = [];

async function init() {
    try {
        kc.setAccessToken(accessToken);
        console.log("✅ KiteConnect initialized");
        
        // Set session times
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        sessionStart = new Date(today.getTime() + 9 * 60 * 60 * 1000 + 15 * 60 * 1000); // 9:15 AM
        sessionEnd = new Date(today.getTime() + 15 * 60 * 60 * 1000 + 15 * 60 * 1000); // 3:15 PM
        entryCutoff = new Date(today.getTime() + 9 * 60 * 60 * 1000 + 20 * 60 * 1000); // 9:20 AM
        
        console.log(`Session: ${dayjs(sessionStart).format("HH:mm:ss")} - ${dayjs(sessionEnd).format("HH:mm:ss")}`);
        console.log(`Entry Cutoff: ${dayjs(entryCutoff).format("HH:mm:ss")}`);
        
        // Initialize instruments at 9:20 AM
        await initializeInstruments();
        
        // Start live tracking
        await startLiveTracking();
        
    } catch (err) {
        console.error("❌ Error in init:", err);
        process.exit(1);
    }
}

async function initializeInstruments() {
    try {
        // Wait until 9:20 AM
        const now = new Date();
        if (now < entryCutoff) {
            const waitTime = entryCutoff.getTime() - now.getTime();
            console.log(`⏳ Waiting until 9:20 AM (${Math.round(waitTime / 1000)} seconds)...`);
            await sleep(waitTime);
        }
        
        // Get spot token
        const token = await getNiftySpotToken();
        if (!token) {
            throw new Error("Could not find NIFTY spot token");
        }
        spotToken = token;
        
        // Get spot price at 9:20 AM with retry logic
        let spotPrice = 0;
        const maxRetries = 5;
        const retryDelay = 5000; // 5 seconds
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`📊 Attempting to get spot price (Attempt ${attempt}/${maxRetries})...`);
                
                // Try to get candles from 9:15 AM to 9:25 AM to have a wider window
                const fromTime = new Date(entryCutoff.getTime() - 5 * 60 * 1000); // 5 minutes before
                const toTime = new Date(entryCutoff.getTime() + 5 * 60 * 1000); // 5 minutes after
                const spotCandles = await getHistoricalCandles(spotToken, fromTime, toTime, "minute");
                
                if (spotCandles.length === 0) {
                    console.log(`⚠️ No candles returned, retrying in ${retryDelay / 1000} seconds...`);
                    if (attempt < maxRetries) {
                        await sleep(retryDelay);
                        continue;
                    }
                    throw new Error("No candles returned from API after multiple retries");
                }
                
                // First try to find exact 9:20 AM candle
                let spotCandle = spotCandles.find(c => {
                    const candleTime = new Date(c.date);
                    return candleTime.getTime() >= entryCutoff.getTime() && candleTime.getTime() < entryCutoff.getTime() + 60000;
                });
                
                // If exact candle not found, use the latest available candle before or at 9:20 AM
                if (!spotCandle) {
                    console.log(`⚠️ Exact 9:20 AM candle not found, looking for latest available candle...`);
                    const validCandles = spotCandles
                        .map(c => ({ ...c, time: new Date(c.date).getTime() }))
                        .filter(c => c.time <= entryCutoff.getTime() + 60000)
                        .sort((a, b) => b.time - a.time); // Sort descending (newest first)
                    
                    if (validCandles.length > 0 && validCandles[0]) {
                        const latestCandle = validCandles[0];
                        spotCandle = latestCandle;
                        const candleTime = dayjs(latestCandle.date).format("HH:mm:ss");
                        console.log(`✅ Using latest available candle at ${candleTime} (${latestCandle.close.toFixed(2)})`);
                    }
                }
                
                if (spotCandle) {
                    if (spotCandle.close > 0) {
                        spotPrice = spotCandle.close;
                        const candleTime = dayjs(spotCandle.date).format("HH:mm:ss");
                        console.log(`✅ Spot price obtained: ${spotPrice.toFixed(2)} (from candle at ${candleTime})`);
                        break;
                    } else {
                        if (attempt < maxRetries) {
                            console.log(`⚠️ Invalid candle close price, retrying in ${retryDelay / 1000} seconds...`);
                            await sleep(retryDelay);
                            continue;
                        }
                        throw new Error("Candle has invalid close price (0 or negative)");
                    }
                } else {
                    if (attempt < maxRetries) {
                        console.log(`⚠️ No valid candles found, retrying in ${retryDelay / 1000} seconds...`);
                        await sleep(retryDelay);
                        continue;
                    }
                    throw new Error("No valid candles available for spot price calculation");
                }
                
            } catch (err) {
                if (attempt === maxRetries) {
                    console.error(`❌ Failed to get spot price after ${maxRetries} attempts`);
                    throw new Error(`Failed to get spot price: ${err instanceof Error ? err.message : String(err)}`);
                }
                console.log(`⚠️ Error getting spot price (Attempt ${attempt}/${maxRetries}): ${err instanceof Error ? err.message : String(err)}`);
                console.log(`⏳ Retrying in ${retryDelay / 1000} seconds...`);
                await sleep(retryDelay);
            }
        }
        
        if (spotPrice === 0) {
            throw new Error("Could not obtain valid spot price after all retries");
        }
        
        // Calculate strikes: CE = spot - 300, PE = spot + 300
        // NIFTY strikes are in multiples of 50
        ceStrike = Math.round((spotPrice - 300) / 50) * 50;
        peStrike = Math.round((spotPrice + 300) / 50) * 50;
        
        console.log(`\n=== STRIKE SELECTION AT 9:20 AM ===`);
        console.log(`Spot Price: ${spotPrice.toFixed(2)}`);
        console.log(`CE Strike (Spot - 300): ${ceStrike}`);
        console.log(`PE Strike (Spot + 300): ${peStrike}`);
        
        // Get next expiry (date-wise - first expiry after today) from NFO
        const instruments = await kc.getInstruments("NFO");
        const expiry = getNextExpiry(instruments);
        
        if (!expiry) {
            throw new Error("No next expiry found for NIFTY");
        }
        
        // Find CE/PE instruments
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
            throw new Error(`Could not find NIFTY CE/PE for strikes CE:${ceStrike}, PE:${peStrike}`);
        }
        
        ceToken = Number(ce.instrument_token);
        peToken = Number(pe.instrument_token);
        ceSymbol = ce.tradingsymbol;
        peSymbol = pe.tradingsymbol;
        
        console.log(`\n=== INSTRUMENTS INITIALIZED ===`);
        console.log(`CE Token: ${ceToken}, Strike: ${ceStrike}, Symbol: ${ceSymbol}`);
        console.log(`PE Token: ${peToken}, Strike: ${peStrike}, Symbol: ${peSymbol}`);
        console.log(`Expiry: ${dayjs(expiry).format("YYYY-MM-DD")}`);
        
    } catch (err) {
        console.error("❌ Error initializing instruments:", err);
        throw err;
    }
}

async function startLiveTracking() {
    isTradingActive = true;
    console.log("\n🚀 Starting live tracking...");
    
    while (isTradingActive) {
        try {
            const now = new Date();
            
            // Check if session has ended
            if (now >= sessionEnd) {
                console.log("\n⏰ Session ended. Squaring off positions...");
                await squareOffPositions();
                break;
            }
            
            // Get live data
            const liveData = await getLiveData();
            // Get VWAP directly from API (faster than calculating manually)
            const { ceVwap, peVwap } = await getVWAPFromAPI();
            
            // Check exit conditions FIRST (if position is open, exit should take priority)
            await checkExitConditions(liveData, ceVwap, peVwap);
            
            // Check entry conditions (price crosses VWAP)
            // NOTE: Must check BEFORE tracking consecutive above VWAP, so we can use the counter value before it gets reset
            // NOTE: Must check BEFORE updating previous values, so we can detect cross from previous iteration
            await checkEntryConditions(liveData, ceVwap, peVwap);
            
            // Track consecutive data points where price is above VWAP (for entry eligibility)
            // NOTE: Called AFTER entry check so counter value is preserved for entry condition check
            trackConsecutiveAboveVwap(liveData, ceVwap, peVwap);
            
            // Track minimum low after VWAP cross (for second entry condition)
            // NOTE: Called AFTER entry check so we can detect VWAP cross and start tracking
            trackMinLowAfterVwapCross(liveData, ceVwap, peVwap);
            
            // Update previous prices and VWAPs for cross detection (AFTER checking conditions)
            cePreviousPrice = liveData.cePrice;
            pePreviousPrice = liveData.pePrice;
            cePreviousVwap = ceVwap;
            pePreviousVwap = peVwap;
            
            // Adjust trailing stops
            await adjustTrailingStops(liveData, ceVwap, peVwap);
            
            // Log current prices
            const timeStr = dayjs().format("HH:mm:ss");
            console.log(`[${timeStr}] CE(${ceStrike}): ${liveData.cePrice.toFixed(2)} (VWAP: ${ceVwap.toFixed(2)}), PE(${peStrike}): ${liveData.pePrice.toFixed(2)} (VWAP: ${peVwap.toFixed(2)}), Spot: ${liveData.spotPrice.toFixed(2)}`);
            
            // Update chart data history
            cePriceHistory.push(liveData.cePrice);
            pePriceHistory.push(liveData.pePrice);
            ceVwapHistory.push(ceVwap);
            peVwapHistory.push(peVwap);
            spotPriceHistory.push(liveData.spotPrice);
            timeHistory.push(timeStr);
            
            // Keep only last 100 data points
            if (cePriceHistory.length > 100) {
                cePriceHistory.shift();
                pePriceHistory.shift();
                ceVwapHistory.shift();
                peVwapHistory.shift();
                spotPriceHistory.shift();
                timeHistory.shift();
            }
            
            // Update live chart every minute (when seconds < 5)
            if (now.getSeconds() < 5) {
                await updateLiveChart();
            }
            
            // Wait 3 second before next data fetch
            await sleep(3000); // Fetch data every 3 second
            
        } catch (err) {
            console.error("❌ Error in live tracking:", err);
            await sleep(5000); // Wait 5 seconds before retrying
        }
    }
    
    console.log("Live tracking stopped.");
}

async function getLiveData(): Promise<LiveData> {
    try {
        const now = new Date();
        const from = new Date(now.getTime() - 5 * 60 * 1000); // Last 5 minutes
        
        // Get latest candles for CE, PE, and Spot
        const ceCandles = await getHistoricalCandles(ceToken, from, now, "minute");
        const peCandles = await getHistoricalCandles(peToken, from, now, "minute");
        const spotCandles = await getHistoricalCandles(spotToken, from, now, "minute");
        
        if (ceCandles.length === 0 || peCandles.length === 0 || spotCandles.length === 0) {
            throw new Error("No live candles available");
        }
        
        const latestCe = ceCandles[ceCandles.length - 1];
        const latestPe = peCandles[peCandles.length - 1];
        const latestSpot = spotCandles[spotCandles.length - 1];
        
        if (!latestCe || !latestPe || !latestSpot) {
            throw new Error("No latest candle data available");
        }
        
        return {
            timestamp: now.getTime(),
            cePrice: latestCe.close,
            pePrice: latestPe.close,
            spotPrice: latestSpot.close
        };
        
    } catch (err) {
        console.error("Error getting live data:", err);
        throw err;
    }
}

async function getVWAPFromAPI(): Promise<{ ceVwap: number; peVwap: number }> {
    try {
        // Get quotes from API - average_price is the VWAP
        const quotes = await kc.getQuote([`NFO:${ceSymbol}`, `NFO:${peSymbol}`]);
        
        const ceQuote = quotes[`NFO:${ceSymbol}`];
        const peQuote = quotes[`NFO:${peSymbol}`];
        
        const ceVwap = ceQuote?.average_price || 0;
        const peVwap = peQuote?.average_price || 0;
        
        // Note: API VWAP is from session start (9:15 AM), not from 9:20 AM
        // This is more standard and efficient than manual calculation
        
        return { ceVwap, peVwap };
        
    } catch (err) {
        console.error("Error getting VWAP from API, falling back to manual calculation:", err);
        // Fallback to manual calculation if API fails
        return {
            ceVwap: await calculateCEVWAPManual(),
            peVwap: await calculatePEVWAPManual()
        };
    }
}

// Keep manual calculation as fallback
async function calculateCEVWAPManual(): Promise<number> {
    try {
        // Get all candles from 9:20 AM (entryCutoff) to now
        const ceCandles = await getHistoricalCandles(ceToken, entryCutoff, new Date(), "minute");
        
        if (ceCandles.length === 0) {
            return 0;
        }
        
        let cumPv = 0;
        let cumVol = 0;
        
        for (const candle of ceCandles) {
            const typicalPrice = (candle.high + candle.low + candle.close) / 3;
            const volume = candle.volume;
            
            cumPv += typicalPrice * volume;
            cumVol += volume;
        }
        
        return cumVol > 0 ? cumPv / cumVol : 0;
        
    } catch (err) {
        console.error("Error calculating CE VWAP manually:", err);
        return 0;
    }
}

async function calculatePEVWAPManual(): Promise<number> {
    try {
        // Get all candles from 9:20 AM (entryCutoff) to now
        const peCandles = await getHistoricalCandles(peToken, entryCutoff, new Date(), "minute");
        
        if (peCandles.length === 0) {
            return 0;
        }
        
        let cumPv = 0;
        let cumVol = 0;
        
        for (const candle of peCandles) {
            const typicalPrice = (candle.high + candle.low + candle.close) / 3;
            const volume = candle.volume;
            
            cumPv += typicalPrice * volume;
            cumVol += volume;
        }
        
        return cumVol > 0 ? cumPv / cumVol : 0;
        
    } catch (err) {
        console.error("Error calculating PE VWAP manually:", err);
        return 0;
    }
}


function trackConsecutiveAboveVwap(liveData: LiveData, ceVwap: number, peVwap: number) {
    // CE: Track consecutive data points where price is above VWAP
    if (!cePosition.isOpen && ceVwap > 0) {
        if (liveData.cePrice > ceVwap) {
            // Increment counter when price is above VWAP
            ceConsecutiveAboveVwap++;
        } else {
            // Reset counter when price goes below or equal to VWAP
            // Note: Counter is checked in entry conditions BEFORE this reset happens
            ceConsecutiveAboveVwap = 0;
        }
    } else {
        // Reset counter when position is open
        ceConsecutiveAboveVwap = 0;
    }
    
    // PE: Track consecutive data points where price is above VWAP
    if (!pePosition.isOpen && peVwap > 0) {
        if (liveData.pePrice > peVwap) {
            // Increment counter when price is above VWAP
            peConsecutiveAboveVwap++;
        } else {
            // Reset counter when price goes below or equal to VWAP
            // Note: Counter is checked in entry conditions BEFORE this reset happens
            peConsecutiveAboveVwap = 0;
        }
    } else {
        // Reset counter when position is open
        peConsecutiveAboveVwap = 0;
    }
}

function trackMinLowAfterVwapCross(liveData: LiveData, ceVwap: number, peVwap: number) {
    const now = dayjs().format("HH:mm:ss");
    
    // CE: Track minimum low within the current cycle
    // Cycle starts with Category 1 entry (low tracking reset and started from entry price)
    // If position is open and tracking has started, continue tracking the minimum low
    if (cePosition.isOpen && ceMinLowAfterVwapCross < Number.MAX_VALUE) {
        // Continue tracking low while position is open (tracking started at cycle start with Category 1 entry)
        if (liveData.cePrice < ceMinLowAfterVwapCross) {
            const oldMin = ceMinLowAfterVwapCross.toFixed(2);
            ceMinLowAfterVwapCross = liveData.cePrice;
            console.log(`[${now}] CE Min Low Updated (Position Open): ${oldMin} -> ${ceMinLowAfterVwapCross.toFixed(2)} (Price: ${liveData.cePrice.toFixed(2)}, VWAP: ${ceVwap.toFixed(2)})`);
        }
    }
    // If position is not open, handle VWAP cross tracking for Category 2 (within current cycle)
    // NOTE: This only runs if Category 1 entry didn't happen in this iteration (position would be open if it did)
    else if (!cePosition.isOpen && ceHasExitedOnce && ceVwap > 0 && cePreviousPrice > 0 && cePreviousVwap > 0) {
        // Check if price just crossed VWAP from above to below
        if (cePreviousPrice > cePreviousVwap && liveData.cePrice <= ceVwap) {
            // Start tracking low from this point (only if at least one exit has happened)
            // This enables Category 2 entries when price makes new lows below this tracked minimum
            ceMinLowAfterVwapCross = liveData.cePrice;
            console.log(`[${now}] CE Min Low Tracking Started: Price crossed VWAP from above, starting to track low from ${ceMinLowAfterVwapCross.toFixed(2)} (Category 2 tracking active)`);
        }
        // If price is below VWAP, continue tracking the minimum low
        else if (liveData.cePrice < ceVwap && ceMinLowAfterVwapCross < Number.MAX_VALUE) {
            if (liveData.cePrice < ceMinLowAfterVwapCross) {
                const oldMin = ceMinLowAfterVwapCross.toFixed(2);
                ceMinLowAfterVwapCross = liveData.cePrice;
                console.log(`[${now}] CE Min Low Updated: ${oldMin} -> ${ceMinLowAfterVwapCross.toFixed(2)} (Price: ${liveData.cePrice.toFixed(2)}, VWAP: ${ceVwap.toFixed(2)})`);
            }
        }
        // If price goes above VWAP, reset the tracking
        else if (liveData.cePrice >= ceVwap && ceMinLowAfterVwapCross < Number.MAX_VALUE) {
            console.log(`[${now}] CE Min Low Reset: Price ${liveData.cePrice.toFixed(2)} >= VWAP ${ceVwap.toFixed(2)}, resetting minLow from ${ceMinLowAfterVwapCross.toFixed(2)}`);
            ceMinLowAfterVwapCross = Number.MAX_VALUE;
        }
    }
    
    // PE: Track minimum low within the current cycle
    // Cycle starts with Category 1 entry (low tracking reset and started from entry price)
    // If position is open and tracking has started, continue tracking the minimum low
    if (pePosition.isOpen && peMinLowAfterVwapCross < Number.MAX_VALUE) {
        // Continue tracking low while position is open (tracking started at cycle start with Category 1 entry)
        if (liveData.pePrice < peMinLowAfterVwapCross) {
            const oldMin = peMinLowAfterVwapCross.toFixed(2);
            peMinLowAfterVwapCross = liveData.pePrice;
            console.log(`[${now}] PE Min Low Updated (Position Open): ${oldMin} -> ${peMinLowAfterVwapCross.toFixed(2)} (Price: ${liveData.pePrice.toFixed(2)}, VWAP: ${peVwap.toFixed(2)})`);
        }
    }
    // If position is not open, handle VWAP cross tracking for Category 2 (within current cycle)
    // NOTE: This only runs if Category 1 entry didn't happen in this iteration (position would be open if it did)
    else if (!pePosition.isOpen && peHasExitedOnce && peVwap > 0 && pePreviousPrice > 0 && pePreviousVwap > 0) {
        // Check if price just crossed VWAP from above to below
        if (pePreviousPrice > pePreviousVwap && liveData.pePrice <= peVwap) {
            // Start tracking low from this point (only if at least one exit has happened)
            // This enables Category 2 entries when price makes new lows below this tracked minimum
            peMinLowAfterVwapCross = liveData.pePrice;
            console.log(`[${now}] PE Min Low Tracking Started: Price crossed VWAP from above, starting to track low from ${peMinLowAfterVwapCross.toFixed(2)} (Category 2 tracking active)`);
        }
        // If price is below VWAP, continue tracking the minimum low
        else if (liveData.pePrice < peVwap && peMinLowAfterVwapCross < Number.MAX_VALUE) {
            if (liveData.pePrice < peMinLowAfterVwapCross) {
                const oldMin = peMinLowAfterVwapCross.toFixed(2);
                peMinLowAfterVwapCross = liveData.pePrice;
                console.log(`[${now}] PE Min Low Updated: ${oldMin} -> ${peMinLowAfterVwapCross.toFixed(2)} (Price: ${liveData.pePrice.toFixed(2)}, VWAP: ${peVwap.toFixed(2)})`);
            }
        }
        // If price goes above VWAP, reset the tracking
        else if (liveData.pePrice >= peVwap && peMinLowAfterVwapCross < Number.MAX_VALUE) {
            console.log(`[${now}] PE Min Low Reset: Price ${liveData.pePrice.toFixed(2)} >= VWAP ${peVwap.toFixed(2)}, resetting minLow from ${peMinLowAfterVwapCross.toFixed(2)}`);
            peMinLowAfterVwapCross = Number.MAX_VALUE;
        }
    }
}

async function checkEntryConditions(liveData: LiveData, ceVwap: number, peVwap: number) {
    const now = dayjs().format("HH:mm:ss");
    
    // Track if Category 1 entry was executed to prevent Category 2 from executing in same iteration
    let ceCategory1Executed = false;
    let peCategory1Executed = false;
    
    // CE Entry Condition 1: Price crosses VWAP from above to below -> SELL (SHORT)
    // Only allow entry if price was above VWAP for at least 30 seconds (10 data points) before crossing
    if (!cePosition.isOpen && !ceEntryPending && ceVwap > 0 && cePreviousPrice > 0 && cePreviousVwap > 0) {
            // Check if price crossed VWAP from above (previous price > previous VWAP AND current price <= current VWAP)
            if (cePreviousPrice > cePreviousVwap && liveData.cePrice <= ceVwap) {
                // Check if price was above VWAP for required consecutive data points before crossing
                // Note: ceConsecutiveAboveVwap contains the count from previous iterations (before current price went below)
                const consecutiveCount = ceConsecutiveAboveVwap;
                if (consecutiveCount >= requiredConsecutiveAboveVwap) {
                    console.log(`[${now}] CE Entry Signal (SELL): Price crossed VWAP from above (${cePreviousPrice.toFixed(2)} > ${cePreviousVwap.toFixed(2)} -> ${liveData.cePrice.toFixed(2)} <= ${ceVwap.toFixed(2)}), Price was above VWAP for ${consecutiveCount} data points`);
                    await executeCEEntry(liveData, ceVwap);
                    ceConsecutiveAboveVwap = 0; // Reset counter after entry
                    // Note: Cycle reset (low tracking and exit counter) is handled in executeCEEntry for Category 1 entries
                    ceCategory1Executed = true; // Mark that Category 1 was executed (new cycle started)
                } else {
                    console.log(`[${now}] CE Entry Signal IGNORED: Price crossed VWAP but was only above VWAP for ${consecutiveCount}/${requiredConsecutiveAboveVwap} data points (need ${requiredConsecutiveAboveVwap} for entry)`);
                }
            }
    }
    
    // PE Entry Condition 1: Price crosses VWAP from above to below -> SELL (SHORT)
    // Only allow entry if price was above VWAP for at least 30 seconds (10 data points) before crossing
    if (!pePosition.isOpen && !peEntryPending && peVwap > 0 && pePreviousPrice > 0 && pePreviousVwap > 0) {
            // Check if price crossed VWAP from above (previous price > previous VWAP AND current price <= current VWAP)
            if (pePreviousPrice > pePreviousVwap && liveData.pePrice <= peVwap) {
                // Check if price was above VWAP for required consecutive data points before crossing
                // Note: peConsecutiveAboveVwap contains the count from previous iterations (before current price went below)
                const consecutiveCount = peConsecutiveAboveVwap;
                if (consecutiveCount >= requiredConsecutiveAboveVwap) {
                    console.log(`[${now}] PE Entry Signal (SELL): Price crossed VWAP from above (${pePreviousPrice.toFixed(2)} > ${pePreviousVwap.toFixed(2)} -> ${liveData.pePrice.toFixed(2)} <= ${peVwap.toFixed(2)}), Price was above VWAP for ${consecutiveCount} data points`);
                    await executePEEntry(liveData, peVwap);
                    peConsecutiveAboveVwap = 0; // Reset counter after entry
                    // Note: Cycle reset (low tracking and exit counter) is handled in executePEEntry for Category 1 entries
                    peCategory1Executed = true; // Mark that Category 1 was executed (new cycle started)
                } else {
                    console.log(`[${now}] PE Entry Signal IGNORED: Price crossed VWAP but was only above VWAP for ${consecutiveCount}/${requiredConsecutiveAboveVwap} data points (need ${requiredConsecutiveAboveVwap} for entry)`);
                }
            }
    }
    
    // CE Entry Condition 2: Re-entry when price makes new low below tracked minimum
    // Conditions: At least one exit happened, no ongoing CE trade, price below VWAP, price below midpoint (last exit vs low)
    // Note: Category 2 can happen multiple times - each entry has its own stop loss and trailing stop
    // Entry price for Category 2 is set to the midpoint between last exit and cycle low
    // IMPORTANT: Category 2 entries do NOT require the 30-second price above VWAP rule (only Category 1 needs it)
    // IMPORTANT: Skip if Category 1 was executed in this iteration to prevent overlap
    if (!ceCategory1Executed && !cePosition.isOpen && !ceEntryPending && ceHasExitedOnce && ceVwap > 0 && liveData.cePrice < ceVwap) {
        const ceMidpoint = (ceMinLowAfterVwapCross < Number.MAX_VALUE && ceLastExitPrice > 0)
            ? (ceMinLowAfterVwapCross + ceLastExitPrice) / 2
            : Number.MAX_VALUE;
        if (ceMidpoint < Number.MAX_VALUE && liveData.cePrice < ceMidpoint) {
            console.log(`[${now}] CE Entry Signal (SELL) - Midpoint Breach: Price ${liveData.cePrice.toFixed(2)} < Midpoint ${ceMidpoint.toFixed(2)} (Low: ${ceMinLowAfterVwapCross.toFixed(2)}, Last Exit: ${ceLastExitPrice.toFixed(2)}, VWAP: ${ceVwap.toFixed(2)})`);
            await executeCEEntry(
                liveData,
                ceVwap,
                `SELL: Re-entry - Price ${liveData.cePrice.toFixed(2)} < midpoint ${ceMidpoint.toFixed(2)} (Low ${ceMinLowAfterVwapCross.toFixed(2)}, Last Exit ${ceLastExitPrice.toFixed(2)})`,
                ceMidpoint
            );
            // Update min low to current price (allows for multiple Category 2 entries)
            // Stop loss and trailing stop are handled by executeCEEntry for each entry
            ceMinLowAfterVwapCross = liveData.cePrice;
        }
    }
    
    // PE Entry Condition 2: Re-entry when price makes new low below tracked minimum
    // Conditions: At least one exit happened, no ongoing PE trade, price below VWAP, price below midpoint (last exit vs low)
    // Note: Category 2 can happen multiple times - each entry has its own stop loss and trailing stop
    // Entry price for Category 2 is set to the midpoint between last exit and cycle low
    // IMPORTANT: Category 2 entries do NOT require the 30-second price above VWAP rule (only Category 1 needs it)
    // IMPORTANT: Skip if Category 1 was executed in this iteration to prevent overlap
    if (!peCategory1Executed && !pePosition.isOpen && !peEntryPending && peHasExitedOnce && peVwap > 0 && liveData.pePrice < peVwap) {
        const peMidpoint = (peMinLowAfterVwapCross < Number.MAX_VALUE && peLastExitPrice > 0)
            ? (peMinLowAfterVwapCross + peLastExitPrice) / 2
            : Number.MAX_VALUE;
        if (peMidpoint < Number.MAX_VALUE && liveData.pePrice < peMidpoint) {
            console.log(`[${now}] PE Entry Signal (SELL) - Midpoint Breach: Price ${liveData.pePrice.toFixed(2)} < Midpoint ${peMidpoint.toFixed(2)} (Low: ${peMinLowAfterVwapCross.toFixed(2)}, Last Exit: ${peLastExitPrice.toFixed(2)}, VWAP: ${peVwap.toFixed(2)})`);
            await executePEEntry(
                liveData,
                peVwap,
                `SELL: Re-entry - Price ${liveData.pePrice.toFixed(2)} < midpoint ${peMidpoint.toFixed(2)} (Low ${peMinLowAfterVwapCross.toFixed(2)}, Last Exit ${peLastExitPrice.toFixed(2)})`,
                peMidpoint
            );
            // Update min low to current price (allows for multiple Category 2 entries)
            // Stop loss and trailing stop are handled by executePEEntry for each entry
            peMinLowAfterVwapCross = liveData.pePrice;
        }
    }
}

async function checkExitConditions(liveData: LiveData, ceVwap: number, peVwap: number) {
    const now = dayjs().format("HH:mm:ss");
    
    // CE Exit Conditions
    if (cePosition.isOpen && !ceExitPending && ceExitThreshold > 0) {
        // Exit condition 1: Price moves above VWAP (only if at least one trailing step has happened)
        // This takes priority over trailing stop when trailing stop is below VWAP
        if (liveData.cePrice >= ceVwap && ceVwap > 0 && ceTrailingSteps >= 1) {
            const priceIncrease = liveData.cePrice - cePosition.entryPrice;
            console.log(`[${now}] CE Exit Signal: Price moved above VWAP (${liveData.cePrice.toFixed(2)} >= ${ceVwap.toFixed(2)}), Increase: ${priceIncrease.toFixed(2)} points from entry`);
            
            // Place MARKET order to exit
            await executeCEExit(liveData, `Price moved above VWAP (${liveData.cePrice.toFixed(2)} >= ${ceVwap.toFixed(2)})`);
        }
        // Exit condition 2: Price at or above trailing stop
        // This handles initial stop loss (Entry + 5) and cases where trailing stop is above VWAP
        else if (liveData.cePrice >= ceExitThreshold) {
            const priceIncrease = liveData.cePrice - cePosition.entryPrice;
            console.log(`[${now}] CE Exit Signal: Trailing stop hit (${liveData.cePrice.toFixed(2)} >= ${ceExitThreshold.toFixed(2)}), Increase: ${priceIncrease.toFixed(2)} points from entry`);
            
            // Place MARKET order to exit at trailing stop price
            await executeCEExit(liveData, `Price hit trailing stop (${liveData.cePrice.toFixed(2)} >= ${ceExitThreshold.toFixed(2)})`);
        }
    }
    
    // PE Exit Conditions
    if (pePosition.isOpen && !peExitPending && peExitThreshold > 0) {
        // Exit condition 1: Price moves above VWAP (only if at least one trailing step has happened)
        // This takes priority over trailing stop when trailing stop is below VWAP
        if (liveData.pePrice >= peVwap && peVwap > 0 && peTrailingSteps >= 1) {
            const priceIncrease = liveData.pePrice - pePosition.entryPrice;
            console.log(`[${now}] PE Exit Signal: Price moved above VWAP (${liveData.pePrice.toFixed(2)} >= ${peVwap.toFixed(2)}), Increase: ${priceIncrease.toFixed(2)} points from entry`);
            
            // Place MARKET order to exit
            await executePEExit(liveData, `Price moved above VWAP (${liveData.pePrice.toFixed(2)} >= ${peVwap.toFixed(2)})`);
        }
        // Exit condition 2: Price at or above trailing stop
        // This handles initial stop loss (Entry + 5) and cases where trailing stop is above VWAP
        else if (liveData.pePrice >= peExitThreshold) {
            const priceIncrease = liveData.pePrice - pePosition.entryPrice;
            console.log(`[${now}] PE Exit Signal: Trailing stop hit (${liveData.pePrice.toFixed(2)} >= ${peExitThreshold.toFixed(2)}), Increase: ${priceIncrease.toFixed(2)} points from entry`);
            
            // Place MARKET order to exit at trailing stop price
            await executePEExit(liveData, `Price hit trailing stop (${liveData.pePrice.toFixed(2)} >= ${peExitThreshold.toFixed(2)})`);
        }
    }
}

async function adjustTrailingStops(liveData: LiveData, ceVwap: number, peVwap: number) {
    if (trailingDropStepPoints <= 0 || trailingExitAdjustment <= 0) {
        return;
    }
    
    const timestamp = dayjs().format("HH:mm:ss");
    
    // CE Trailing Stop: 
    // Category 1: After first 5-point drop, move from (Entry + 10) to (Entry - 2.5)
    // Category 2: After first 5-point drop, move from (Entry + 5) to (Entry - 2.5)
    // Then with every further 5-point drop, reduce stop by another 2.5 points
    if (cePosition.isOpen && ceExitThreshold > 0 && ceNextTrailTrigger > 0) {
        if (liveData.cePrice <= ceNextTrailTrigger) {
            const oldStopLoss = ceExitThreshold;
            ceTrailingSteps++;
            
            if (ceTrailingSteps === 1) {
                // First drop: Both categories move stop to Entry - 2.5
                // Category 1: Move from (Entry + 10) to (Entry - 2.5)
                // Category 2: Move from (Entry + 5) to (Entry - 2.5)
                ceExitThreshold = cePosition.entryPrice - trailingExitAdjustment;
                
                const categoryType = ceIsCategory2 ? "Category 2" : "Category 1";
                const previousStopLossDesc = ceIsCategory2 ? "Entry + 5" : `Entry + ${initialStopLossOffset}`;
                
                console.log(`\n${"-".repeat(80)}`);
                console.log(`📉 CE TRAILING STOP UPDATE - STEP ${ceTrailingSteps} (${categoryType})`);
                console.log(`${"-".repeat(80)}`);
                console.log(`Time: ${timestamp}`);
                console.log(`Current Price: ${liveData.cePrice.toFixed(2)} (triggered at <= ${ceNextTrailTrigger.toFixed(2)})`);
                console.log(`Current VWAP: ${ceVwap.toFixed(2)}`);
                console.log(`Entry Price: ${cePosition.entryPrice.toFixed(2)}`);
                console.log(`Entry VWAP: ${cePosition.entryVwap.toFixed(2)}`);
                console.log(`Previous Stop Loss: ${oldStopLoss.toFixed(2)} (${previousStopLossDesc})`);
                console.log(`New Stop Loss: ${ceExitThreshold.toFixed(2)} (Entry - ${trailingExitAdjustment})`);
                console.log(`Stop Loss Change: ${(oldStopLoss - ceExitThreshold).toFixed(2)} points`);
                console.log(`Price Drop from Entry: ${(cePosition.entryPrice - liveData.cePrice).toFixed(2)} points`);
                console.log(`${"-".repeat(80)}\n`);
            } else {
                // Subsequent drops: Reduce stop by another 2.5 points
                ceExitThreshold = ceExitThreshold - trailingExitAdjustment;
                
                console.log(`\n${"-".repeat(80)}`);
                console.log(`📉 CE TRAILING STOP UPDATE - STEP ${ceTrailingSteps}`);
                console.log(`${"-".repeat(80)}`);
                console.log(`Time: ${timestamp}`);
                console.log(`Current Price: ${liveData.cePrice.toFixed(2)} (triggered at <= ${ceNextTrailTrigger.toFixed(2)})`);
                console.log(`Current VWAP: ${ceVwap.toFixed(2)}`);
                console.log(`Entry Price: ${cePosition.entryPrice.toFixed(2)}`);
                console.log(`Previous Stop Loss: ${oldStopLoss.toFixed(2)}`);
                console.log(`New Stop Loss: ${ceExitThreshold.toFixed(2)} (reduced by ${trailingExitAdjustment} points)`);
                console.log(`Stop Loss Change: ${(oldStopLoss - ceExitThreshold).toFixed(2)} points`);
                console.log(`Total Trailing Steps: ${ceTrailingSteps}`);
                console.log(`Price Drop from Entry: ${(cePosition.entryPrice - liveData.cePrice).toFixed(2)} points`);
                console.log(`Unrealized P&L: ${((cePosition.entryPrice - liveData.cePrice) * lotSize).toFixed(2)}`);
                console.log(`${"-".repeat(80)}\n`);
            }
            
            // Update next trail trigger: previous trigger - 5 points (not current price - 5)
            ceNextTrailTrigger = Math.max(ceNextTrailTrigger - trailingDropStepPoints, 0);
            console.log(`[${timestamp}] CE Next trail trigger updated to: ${ceNextTrailTrigger.toFixed(2)} (will trail again when price <= ${ceNextTrailTrigger.toFixed(2)})`);
        }
    }
    
    // PE Trailing Stop: 
    // Category 1: After first 5-point drop, move from (Entry + 10) to (Entry + 2.5)
    // Category 2: After first 5-point drop, move from (Entry + 5) to (Entry + 2.5)
    // Then with every further 5-point drop, reduce stop by another 2.5 points
    if (pePosition.isOpen && peExitThreshold > 0 && peNextTrailTrigger > 0) {
        if (liveData.pePrice <= peNextTrailTrigger) {
            const oldStopLoss = peExitThreshold;
            peTrailingSteps++;
            
            if (peTrailingSteps === 1) {
                // First drop: Both categories move stop to Entry - 2.5
                // Category 1: Move from (Entry + 10) to (Entry - 2.5)
                // Category 2: Move from (Entry + 5) to (Entry - 2.5)
                peExitThreshold = pePosition.entryPrice - trailingExitAdjustment;
                
                const categoryType = peIsCategory2 ? "Category 2" : "Category 1";
                const previousStopLossDesc = peIsCategory2 ? "Entry + 5" : `Entry + ${initialStopLossOffset}`;
                
                console.log(`\n${"-".repeat(80)}`);
                console.log(`📉 PE TRAILING STOP UPDATE - STEP ${peTrailingSteps} (${categoryType})`);
                console.log(`${"-".repeat(80)}`);
                console.log(`Time: ${timestamp}`);
                console.log(`Current Price: ${liveData.pePrice.toFixed(2)} (triggered at <= ${peNextTrailTrigger.toFixed(2)})`);
                console.log(`Current VWAP: ${peVwap.toFixed(2)}`);
                console.log(`Entry Price: ${pePosition.entryPrice.toFixed(2)}`);
                console.log(`Entry VWAP: ${pePosition.entryVwap.toFixed(2)}`);
                console.log(`Previous Stop Loss: ${oldStopLoss.toFixed(2)} (${previousStopLossDesc})`);
                console.log(`New Stop Loss: ${peExitThreshold.toFixed(2)} (Entry - ${trailingExitAdjustment})`);
                console.log(`Stop Loss Change: ${(oldStopLoss - peExitThreshold).toFixed(2)} points`);
                console.log(`Price Drop from Entry: ${(pePosition.entryPrice - liveData.pePrice).toFixed(2)} points`);
                console.log(`${"-".repeat(80)}\n`);
            } else {
                // Subsequent drops: Reduce stop by another 2.5 points
                peExitThreshold = peExitThreshold - trailingExitAdjustment;
                
                console.log(`\n${"-".repeat(80)}`);
                console.log(`📉 PE TRAILING STOP UPDATE - STEP ${peTrailingSteps}`);
                console.log(`${"-".repeat(80)}`);
                console.log(`Time: ${timestamp}`);
                console.log(`Current Price: ${liveData.pePrice.toFixed(2)} (triggered at <= ${peNextTrailTrigger.toFixed(2)})`);
                console.log(`Current VWAP: ${peVwap.toFixed(2)}`);
                console.log(`Entry Price: ${pePosition.entryPrice.toFixed(2)}`);
                console.log(`Previous Stop Loss: ${oldStopLoss.toFixed(2)}`);
                console.log(`New Stop Loss: ${peExitThreshold.toFixed(2)} (reduced by ${trailingExitAdjustment} points)`);
                console.log(`Stop Loss Change: ${(oldStopLoss - peExitThreshold).toFixed(2)} points`);
                console.log(`Total Trailing Steps: ${peTrailingSteps}`);
                console.log(`Price Drop from Entry: ${(pePosition.entryPrice - liveData.pePrice).toFixed(2)} points`);
                console.log(`Unrealized P&L: ${((pePosition.entryPrice - liveData.pePrice) * lotSize).toFixed(2)}`);
                console.log(`${"-".repeat(80)}\n`);
            }
            
            // Update next trail trigger: previous trigger - 5 points (not current price - 5)
            peNextTrailTrigger = Math.max(peNextTrailTrigger - trailingDropStepPoints, 0);
            console.log(`[${timestamp}] PE Next trail trigger updated to: ${peNextTrailTrigger.toFixed(2)} (will trail again when price <= ${peNextTrailTrigger.toFixed(2)})`);
        }
    }
}

async function executeCEEntry(liveData: LiveData, ceVwap: number, reason?: string, entryPrice?: number) {
    // Set pending flag immediately to prevent concurrent entry attempts
    if (ceEntryPending) {
        console.log(`⚠️ CE Entry already in progress, skipping duplicate entry`);
        return;
    }
    ceEntryPending = true;
    
    try {
        console.log(`🎯 Executing CE Entry...`);
        const order = await placeOrder(ceToken, "SELL", lotSize, "MIS");
        
        cePosition.isOpen = true;
        // Use provided entry price (for Category 2) or current price (for Category 1)
        cePosition.entryPrice = entryPrice !== undefined ? entryPrice : liveData.cePrice;
        cePosition.entryTime = dayjs().format("HH:mm:ss");
        cePosition.entryVwap = ceVwap;
        cePosition.entryOrderId = order.order_id;
        
        // Category 1 entry starts a new cycle - reset cycle variables
        if (entryPrice === undefined) {
            // NEW CYCLE START: Category 1 entry
            // Reset and start tracking low from entry price
            ceMinLowAfterVwapCross = cePosition.entryPrice;
            // Reset exit counter for new cycle
            ceHasExitedOnce = false;
            ceIsCategory2 = false; // Category 1 entry
            const now = dayjs().format("HH:mm:ss");
            console.log(`[${now}] 🔄 CE NEW CYCLE STARTED: Category 1 entry made`);
            console.log(`[${now}] CE Min Low Tracking Reset & Started: Starting to track low from ${ceMinLowAfterVwapCross.toFixed(2)}`);
            console.log(`[${now}] CE Exit Counter Reset: ceHasExitedOnce = false`);
        } else {
            // Category 2 entry
            ceIsCategory2 = true;
        }
        
        // Initial trailing stop: Different stop loss for Category 1 vs Category 2
        // Category 1: Entry + 10, Category 2: Entry + 5
        const stopLossOffset = entryPrice === undefined ? initialStopLossOffset : 5;
        ceExitThreshold = cePosition.entryPrice + stopLossOffset;
        ceNextTrailTrigger = trailingDropStepPoints > 0 ? Math.max(cePosition.entryPrice - trailingDropStepPoints, 0) : 0;
        ceTrailingSteps = 0;
        
        const categoryType = entryPrice === undefined ? "Category 1" : "Category 2";
        console.log(`✅ CE Trailing Stop Initialized (${categoryType}): Exit threshold @ ${ceExitThreshold.toFixed(2)} (Entry + ${stopLossOffset}, will place MARKET order when price >= threshold)`);
        
        const trade: LiveTrade = {
            timestamp: dayjs().format("YYYY-MM-DD HH:mm:ss"),
            instrument: "CE",
            action: "ENTRY",
            price: cePosition.entryPrice,
            quantity: lotSize,
            orderId: order.order_id,
            reason: reason || `SELL: Price crossed VWAP from above (${cePreviousPrice.toFixed(2)} > ${cePreviousVwap.toFixed(2)} -> ${liveData.cePrice.toFixed(2)} <= ${ceVwap.toFixed(2)})`
        };
        
        liveTrades.push(trade);
        
        const entryTime = dayjs().format("YYYY-MM-DD HH:mm:ss");
        console.log(`\n${"=".repeat(80)}`);
        console.log(`📈 CE ENTRY TRADE EXECUTED`);
        console.log(`${"=".repeat(80)}`);
        console.log(`Time: ${entryTime}`);
        console.log(`Strike: ${ceStrike}`);
        console.log(`Action: SELL (SHORT)`);
        console.log(`Entry Price: ${cePosition.entryPrice.toFixed(2)}`);
        console.log(`Entry VWAP: ${ceVwap.toFixed(2)}`);
        console.log(`Previous Price: ${cePreviousPrice.toFixed(2)}`);
        console.log(`Previous VWAP: ${cePreviousVwap.toFixed(2)}`);
        console.log(`Quantity: ${lotSize}`);
        console.log(`Initial Stop Loss: ${ceExitThreshold.toFixed(2)} (Entry + ${initialStopLossOffset})`);
        console.log(`Next Trail Trigger: ${ceNextTrailTrigger.toFixed(2)}`);
        console.log(`Spot Price: ${liveData.spotPrice.toFixed(2)}`);
        console.log(`Order ID: ${order.order_id}`);
        console.log(`Reason: ${trade.reason}`);
        console.log(`${"=".repeat(80)}\n`);
        
    } catch (err) {
        console.error("❌ Error executing CE entry:", err);
        // Reset isOpen if entry failed
        cePosition.isOpen = false;
    } finally {
        // Always reset pending flag
        ceEntryPending = false;
    }
}

async function executePEEntry(liveData: LiveData, peVwap: number, reason?: string, entryPrice?: number) {
    // Set pending flag immediately to prevent concurrent entry attempts
    if (peEntryPending) {
        console.log(`⚠️ PE Entry already in progress, skipping duplicate entry`);
        return;
    }
    peEntryPending = true;
    
    try {
        console.log(`🎯 Executing PE Entry...`);
        const order = await placeOrder(peToken, "SELL", lotSize, "MIS");
        
        pePosition.isOpen = true;
        // Use provided entry price (for Category 2) or current price (for Category 1)
        pePosition.entryPrice = entryPrice !== undefined ? entryPrice : liveData.pePrice;
        pePosition.entryTime = dayjs().format("HH:mm:ss");
        pePosition.entryVwap = peVwap;
        pePosition.entryOrderId = order.order_id;
        
        // Category 1 entry starts a new cycle - reset cycle variables
        if (entryPrice === undefined) {
            // NEW CYCLE START: Category 1 entry
            // Reset and start tracking low from entry price
            peMinLowAfterVwapCross = pePosition.entryPrice;
            // Reset exit counter for new cycle
            peHasExitedOnce = false;
            peIsCategory2 = false; // Category 1 entry
            const now = dayjs().format("HH:mm:ss");
            console.log(`[${now}] 🔄 PE NEW CYCLE STARTED: Category 1 entry made`);
            console.log(`[${now}] PE Min Low Tracking Reset & Started: Starting to track low from ${peMinLowAfterVwapCross.toFixed(2)}`);
            console.log(`[${now}] PE Exit Counter Reset: peHasExitedOnce = false`);
        } else {
            // Category 2 entry
            peIsCategory2 = true;
        }
        
        // Initial trailing stop: Different stop loss for Category 1 vs Category 2
        // Category 1: Entry + 10, Category 2: Entry + 5
        const stopLossOffset = entryPrice === undefined ? initialStopLossOffset : 5;
        peExitThreshold = pePosition.entryPrice + stopLossOffset;
        peNextTrailTrigger = trailingDropStepPoints > 0 ? Math.max(pePosition.entryPrice - trailingDropStepPoints, 0) : 0;
        peTrailingSteps = 0;
        
        const categoryType = entryPrice === undefined ? "Category 1" : "Category 2";
        console.log(`✅ PE Trailing Stop Initialized (${categoryType}): Exit threshold @ ${peExitThreshold.toFixed(2)} (Entry + ${stopLossOffset}, will place MARKET order when price >= threshold)`);
        
        const trade: LiveTrade = {
            timestamp: dayjs().format("YYYY-MM-DD HH:mm:ss"),
            instrument: "PE",
            action: "ENTRY",
            price: pePosition.entryPrice,
            quantity: lotSize,
            orderId: order.order_id,
            reason: reason || `SELL: Price crossed VWAP from above (${pePreviousPrice.toFixed(2)} > ${pePreviousVwap.toFixed(2)} -> ${liveData.pePrice.toFixed(2)} <= ${peVwap.toFixed(2)})`
        };
        
        liveTrades.push(trade);
        
        const entryTime = dayjs().format("YYYY-MM-DD HH:mm:ss");
        console.log(`\n${"=".repeat(80)}`);
        console.log(`📈 PE ENTRY TRADE EXECUTED`);
        console.log(`${"=".repeat(80)}`);
        console.log(`Time: ${entryTime}`);
        console.log(`Strike: ${peStrike}`);
        console.log(`Action: SELL (SHORT)`);
        console.log(`Entry Price: ${pePosition.entryPrice.toFixed(2)}`);
        console.log(`Entry VWAP: ${peVwap.toFixed(2)}`);
        console.log(`Previous Price: ${pePreviousPrice.toFixed(2)}`);
        console.log(`Previous VWAP: ${pePreviousVwap.toFixed(2)}`);
        console.log(`Quantity: ${lotSize}`);
        console.log(`Initial Stop Loss: ${peExitThreshold.toFixed(2)} (Entry + ${initialStopLossOffset})`);
        console.log(`Next Trail Trigger: ${peNextTrailTrigger.toFixed(2)}`);
        console.log(`Spot Price: ${liveData.spotPrice.toFixed(2)}`);
        console.log(`Order ID: ${order.order_id}`);
        console.log(`Reason: ${trade.reason}`);
        console.log(`${"=".repeat(80)}\n`);
        
    } catch (err) {
        console.error("❌ Error executing PE entry:", err);
        // Reset isOpen if entry failed
        pePosition.isOpen = false;
    } finally {
        // Always reset pending flag
        peEntryPending = false;
    }
}

async function executeCEExit(liveData: LiveData, reason: string, skipOrder: boolean = false) {
    // Set pending flag immediately to prevent concurrent exit attempts
    if (ceExitPending) {
        console.log(`⚠️ CE Exit already in progress, skipping duplicate exit`);
        return;
    }
    ceExitPending = true;
    
    try {
        let orderId: string | undefined;
        
        if (!skipOrder) {
            console.log(`🎯 Executing CE Exit with MARKET order...`);
            const order = await placeOrder(ceToken, "BUY", lotSize, "MIS");
            orderId = order.order_id;
        } else {
            console.log(`🎯 CE Exit already executed, updating internal state...`);
        }
        
        const pnl = (cePosition.entryPrice - liveData.cePrice) * lotSize;
        const priceChange = liveData.cePrice - cePosition.entryPrice;
        const holdingDuration = cePosition.entryTime ? `${dayjs().format("HH:mm:ss")} - ${cePosition.entryTime}` : "N/A";
        
        const trade: LiveTrade = {
            timestamp: dayjs().format("YYYY-MM-DD HH:mm:ss"),
            instrument: "CE",
            action: "EXIT",
            price: liveData.cePrice,
            quantity: lotSize,
            orderId: orderId,
            pnl: pnl,
            reason: reason
        };
        
        liveTrades.push(trade);
        ceLastExitPrice = liveData.cePrice;
        
        const exitTime = dayjs().format("YYYY-MM-DD HH:mm:ss");
        console.log(`\n${"=".repeat(80)}`);
        console.log(`📉 CE EXIT TRADE EXECUTED`);
        console.log(`${"=".repeat(80)}`);
        console.log(`Time: ${exitTime}`);
        console.log(`Strike: ${ceStrike}`);
        console.log(`Action: BUY (Cover SHORT)`);
        console.log(`Entry Price: ${cePosition.entryPrice.toFixed(2)}`);
        console.log(`Entry Time: ${cePosition.entryTime}`);
        console.log(`Entry VWAP: ${cePosition.entryVwap.toFixed(2)}`);
        console.log(`Exit Price: ${liveData.cePrice.toFixed(2)}`);
        console.log(`Price Change: ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)} points`);
        console.log(`Holding Duration: ${holdingDuration}`);
        console.log(`Quantity: ${lotSize}`);
        console.log(`P&L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}`);
        console.log(`Trailing Steps Completed: ${ceTrailingSteps}`);
        console.log(`Final Stop Loss: ${ceExitThreshold.toFixed(2)}`);
        console.log(`Initial Stop Loss: ${(cePosition.entryPrice + initialStopLossOffset).toFixed(2)}`);
        if (ceTrailingSteps > 0) {
            console.log(`Stop Loss Trail History:`);
            console.log(`  Step 0: ${(cePosition.entryPrice + initialStopLossOffset).toFixed(2)} (Initial - Entry + ${initialStopLossOffset})`);
            if (ceTrailingSteps >= 1) {
                console.log(`  Step 1: ${(cePosition.entryVwap - trailingExitAdjustment).toFixed(2)} (VWAP - ${trailingExitAdjustment})`);
                for (let i = 2; i <= ceTrailingSteps; i++) {
                    const stepStop = (cePosition.entryVwap - trailingExitAdjustment) - ((i - 1) * trailingExitAdjustment);
                    console.log(`  Step ${i}: ${stepStop.toFixed(2)} (Reduced by ${trailingExitAdjustment} points)`);
                }
            }
        }
        console.log(`Order ID: ${orderId || 'N/A'}`);
        console.log(`Order Type: MARKET`);
        console.log(`Reason: ${reason}`);
        console.log(`${"=".repeat(80)}\n`);
        
        // Reset position
        cePosition.isOpen = false;
        cePosition.entryPrice = 0;
        cePosition.entryTime = "";
        cePosition.entryVwap = 0;
        cePosition.entryOrderId = undefined;
        ceExitThreshold = 0;
        ceNextTrailTrigger = 0;
        ceTrailingSteps = 0;
        ceIsCategory2 = false; // Reset category flag
        
        // Mark that at least one exit has happened (for second entry condition)
        ceHasExitedOnce = true;
        
        // Reset consecutive above VWAP counter
        ceConsecutiveAboveVwap = 0;
        
        if (skipOrder) {
            console.log(`✅ CE Exit State Updated: Price ${liveData.cePrice.toFixed(2)}, PnL: ${pnl.toFixed(2)}`);
        } else {
            console.log(`✅ CE Exit Executed: Price ${liveData.cePrice.toFixed(2)}, PnL: ${pnl.toFixed(2)}, Order Type: MARKET, Order ID: ${orderId}`);
        }
        
    } catch (err) {
        console.error("❌ Error executing CE exit:", err);
        // Don't reset isOpen on error - position might still be open
    } finally {
        // Always reset pending flag
        ceExitPending = false;
    }
}

async function executePEExit(liveData: LiveData, reason: string, skipOrder: boolean = false) {
    // Set pending flag immediately to prevent concurrent exit attempts
    if (peExitPending) {
        console.log(`⚠️ PE Exit already in progress, skipping duplicate exit`);
        return;
    }
    peExitPending = true;
    
    try {
        let orderId: string | undefined;
        
        if (!skipOrder) {
            console.log(`🎯 Executing PE Exit with MARKET order...`);
            const order = await placeOrder(peToken, "BUY", lotSize, "MIS");
            orderId = order.order_id;
        } else {
            console.log(`🎯 PE Exit already executed, updating internal state...`);
        }
        
        const pnl = (pePosition.entryPrice - liveData.pePrice) * lotSize;
        const priceChange = liveData.pePrice - pePosition.entryPrice;
        const holdingDuration = pePosition.entryTime ? `${dayjs().format("HH:mm:ss")} - ${pePosition.entryTime}` : "N/A";
        
        const trade: LiveTrade = {
            timestamp: dayjs().format("YYYY-MM-DD HH:mm:ss"),
            instrument: "PE",
            action: "EXIT",
            price: liveData.pePrice,
            quantity: lotSize,
            orderId: orderId,
            pnl: pnl,
            reason: reason
        };
        
        liveTrades.push(trade);
        peLastExitPrice = liveData.pePrice;
        
        const exitTime = dayjs().format("YYYY-MM-DD HH:mm:ss");
        console.log(`\n${"=".repeat(80)}`);
        console.log(`📉 PE EXIT TRADE EXECUTED`);
        console.log(`${"=".repeat(80)}`);
        console.log(`Time: ${exitTime}`);
        console.log(`Strike: ${peStrike}`);
        console.log(`Action: BUY (Cover SHORT)`);
        console.log(`Entry Price: ${pePosition.entryPrice.toFixed(2)}`);
        console.log(`Entry Time: ${pePosition.entryTime}`);
        console.log(`Entry VWAP: ${pePosition.entryVwap.toFixed(2)}`);
        console.log(`Exit Price: ${liveData.pePrice.toFixed(2)}`);
        console.log(`Price Change: ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)} points`);
        console.log(`Holding Duration: ${holdingDuration}`);
        console.log(`Quantity: ${lotSize}`);
        console.log(`P&L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}`);
        console.log(`Trailing Steps Completed: ${peTrailingSteps}`);
        console.log(`Final Stop Loss: ${peExitThreshold.toFixed(2)}`);
        console.log(`Initial Stop Loss: ${(pePosition.entryPrice + initialStopLossOffset).toFixed(2)}`);
        if (peTrailingSteps > 0) {
            console.log(`Stop Loss Trail History:`);
            console.log(`  Step 0: ${(pePosition.entryPrice + initialStopLossOffset).toFixed(2)} (Initial - Entry + ${initialStopLossOffset})`);
            if (peTrailingSteps >= 1) {
                console.log(`  Step 1: ${(pePosition.entryVwap - trailingExitAdjustment).toFixed(2)} (VWAP - ${trailingExitAdjustment})`);
                for (let i = 2; i <= peTrailingSteps; i++) {
                    const stepStop = (pePosition.entryVwap - trailingExitAdjustment) - ((i - 1) * trailingExitAdjustment);
                    console.log(`  Step ${i}: ${stepStop.toFixed(2)} (Reduced by ${trailingExitAdjustment} points)`);
                }
            }
        }
        console.log(`Order ID: ${orderId || 'N/A'}`);
        console.log(`Order Type: MARKET`);
        console.log(`Reason: ${reason}`);
        console.log(`${"=".repeat(80)}\n`);
        
        // Reset position
        pePosition.isOpen = false;
        pePosition.entryPrice = 0;
        pePosition.entryTime = "";
        pePosition.entryVwap = 0;
        pePosition.entryOrderId = undefined;
        peExitThreshold = 0;
        peNextTrailTrigger = 0;
        peTrailingSteps = 0;
        peIsCategory2 = false; // Reset category flag
        
        // Mark that at least one exit has happened (for second entry condition)
        peHasExitedOnce = true;
        
        // Reset consecutive above VWAP counter
        peConsecutiveAboveVwap = 0;
        
        if (skipOrder) {
            console.log(`✅ PE Exit State Updated: Price ${liveData.pePrice.toFixed(2)}, PnL: ${pnl.toFixed(2)}`);
        } else {
            console.log(`✅ PE Exit Executed: Price ${liveData.pePrice.toFixed(2)}, PnL: ${pnl.toFixed(2)}, Order Type: MARKET, Order ID: ${orderId}`);
        }
        
    } catch (err) {
        console.error("❌ Error executing PE exit:", err);
        // Don't reset isOpen on error - position might still be open
    } finally {
        // Always reset pending flag
        peExitPending = false;
    }
}

async function squareOffPositions() {
    try {
        isTradingActive = false;
        
        const liveData = await getLiveData();
        
        if (cePosition.isOpen) {
            await executeCEExit(liveData, "Session end - Square off");
        }
        
        if (pePosition.isOpen) {
            await executePEExit(liveData, "Session end - Square off");
        }
        
        // Save trade log
        await saveTradeLog();
        
    } catch (err) {
        console.error("Error squaring off positions:", err);
    }
}

// Round price to tick size (0.05 for NIFTY options) and drop all decimals
function roundToTickSize(price: number): number {
    const tickRounded = Math.round(price / tickSize) * tickSize;
    return Math.max(Math.floor(tickRounded), 0);
}


async function placeOrder(instrumentToken: number, transactionType: "BUY" | "SELL", quantity: number, product: Product) {
    try {
        const order = await kc.placeOrder("regular", {
            exchange: "NFO",
            tradingsymbol: await getTradingSymbol(instrumentToken),
            transaction_type: transactionType,
            quantity: quantity,
            product: product,
            order_type: "MARKET",
            validity: "DAY"
        });
        return order;
    } catch (err) {
        console.error("Error placing order:", err);
        throw err;
    }
}

async function placeLimitOrder(instrumentToken: number, transactionType: "BUY" | "SELL", quantity: number, price: number, product: Product) {
    try {
        // Round price to tick size
        const roundedPrice = roundToTickSize(price);
        if (Math.abs(roundedPrice - price) > 0.001) {
            console.log(`⚠️ Price rounded from ${price.toFixed(2)} to ${roundedPrice.toFixed(2)} (tick size: ${tickSize})`);
        }
        
        const order = await kc.placeOrder("regular", {
            exchange: "NFO",
            tradingsymbol: await getTradingSymbol(instrumentToken),
            transaction_type: transactionType,
            quantity: quantity,
            price: roundedPrice,
            product: product,
            order_type: "LIMIT",
            validity: "DAY"
        });
        return order;
    } catch (err) {
        console.error("Error placing limit order:", err);
        throw err;
    }
}

async function placeStopLossOrder(instrumentToken: number, quantity: number, triggerPrice: number, product: Product) {
    try {
        // Use SL (Stop Loss Limit) instead of SL-M as SL-M is blocked for F&O contracts
        // For buy stop loss (covering short), limit price should be slightly above trigger to ensure execution
        const limitPrice = triggerPrice + 1; // 1 point buffer above trigger
        
        // Round both trigger price and limit price to tick size
        const roundedTriggerPrice = roundToTickSize(triggerPrice);
        const roundedLimitPrice = roundToTickSize(limitPrice);
        
        if (Math.abs(roundedTriggerPrice - triggerPrice) > 0.001 || Math.abs(roundedLimitPrice - limitPrice) > 0.001) {
            console.log(`⚠️ Stop loss prices rounded: Trigger ${triggerPrice.toFixed(2)} -> ${roundedTriggerPrice.toFixed(2)}, Limit ${limitPrice.toFixed(2)} -> ${roundedLimitPrice.toFixed(2)}`);
        }
        
        const order = await kc.placeOrder("regular", {
            exchange: "NFO",
            tradingsymbol: await getTradingSymbol(instrumentToken),
            transaction_type: "BUY",
            quantity: quantity,
            price: roundedLimitPrice,
            product: product,
            order_type: "SL",
            validity: "DAY",
            trigger_price: roundedTriggerPrice
        });
        return order;
    } catch (err) {
        console.error("Error placing stop loss order:", err);
        throw err;
    }
}

async function modifyStopLossOrder(orderId: string, instrumentToken: number, quantity: number, triggerPrice: number) {
    try {
        // For buy stop loss (covering short), limit price should be slightly above trigger to ensure execution
        const limitPrice = triggerPrice + 0.5; // 0.5 point buffer above trigger
        
        // Round both trigger price and limit price to tick size
        const roundedTriggerPrice = roundToTickSize(triggerPrice);
        const roundedLimitPrice = roundToTickSize(limitPrice);
        
        if (Math.abs(roundedTriggerPrice - triggerPrice) > 0.001 || Math.abs(roundedLimitPrice - limitPrice) > 0.001) {
            console.log(`⚠️ Stop loss modification prices rounded: Trigger ${triggerPrice.toFixed(2)} -> ${roundedTriggerPrice.toFixed(2)}, Limit ${limitPrice.toFixed(2)} -> ${roundedLimitPrice.toFixed(2)}`);
        }
        
        const order = await kc.modifyOrder("regular", orderId, {
            quantity: quantity,
            price: roundedLimitPrice,
            trigger_price: roundedTriggerPrice
        });
        return order;
    } catch (err) {
        console.error("Error modifying stop loss order:", err);
        throw err;
    }
}

async function cancelOrder(orderId: string) {
    try {
        const order = await kc.cancelOrder("regular", orderId);
        return order;
    } catch (err) {
        console.error("Error cancelling order:", err);
        throw err;
    }
}

async function getTradingSymbol(instrumentToken: number): Promise<string> {
    const instruments = await kc.getInstruments("NFO");
    const instrument = instruments.find(inst => Number(inst.instrument_token) === instrumentToken);
    if (!instrument) {
        throw new Error(`Instrument not found for token: ${instrumentToken}`);
    }
    return instrument.tradingsymbol;
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
    // Get the first expiry strictly after today (date-wise next)
    const now = new Date();
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + 24 * 60 * 60 * 1000 - 1;
    
    // Get all unique expiries
    const allExpiries = instruments
        .filter(inst => inst.name === "NIFTY" && inst.instrument_type === "CE")
        .map(inst => new Date(inst.expiry).getTime())
        .filter((ts, index, self) => self.indexOf(ts) === index) // Get unique values
        .sort((a, b) => a - b); // Sort ascending
    
    // Find the first expiry strictly after today (date-wise next)
    const nextExpiry = allExpiries.find(ts => ts > todayEnd);
    if (nextExpiry) {
        return new Date(nextExpiry);
    }
    
    // Fallback: if no expiry after today, return null
    return null;
}

async function getHistoricalCandles(instrumentToken: number, from: Date, to: Date, interval: "minute" | "5minute") {
    try {
        const candles = await kc.getHistoricalData(instrumentToken, interval, from, to, false);
        return candles as unknown as Candle[];
    } catch (err) {
        console.error(`Error getting historical candles for token ${instrumentToken}:`, err);
        return [];
    }
}

async function updateLiveChart() {
    try {
        if (cePriceHistory.length < 10) return; // Need minimum data points
        
        // Generate SVG chart
        await generateLiveSVGChart();
        
    } catch (err) {
        console.error("Error updating live chart:", err);
    }
}

async function generateLiveSVGChart() {
    try {
        const currentTime = dayjs().format("YYYY-MM-DD HH:mm:ss");
        const chartData = cePriceHistory.slice(-50); // Last 50 data points
        const peChartData = pePriceHistory.slice(-50);
        const ceVwapData = ceVwapHistory.slice(-50);
        const peVwapData = peVwapHistory.slice(-50);
        const spotData = spotPriceHistory.slice(-50);
        const timeLabels = timeHistory.slice(-50);
        
        if (chartData.length === 0) return;
        
        const width = 1400;
        const height = 800;
        const padding = 80;
        const chartWidth = width - 2 * padding;
        const chartHeight = height - 2 * padding;
        
        // Calculate price ranges for CE and PE (separate scales)
        const allCEValues = [...chartData, ...ceVwapData];
        const allPEValues = [...peChartData, ...peVwapData];
        const maxCE = Math.max(...allCEValues);
        const minCE = Math.min(...allCEValues);
        const maxPE = Math.max(...allPEValues);
        const minPE = Math.min(...allPEValues);
        
        const ceRange = maxCE - minCE;
        const peRange = maxPE - minPE;
        const cePadding = ceRange * 0.1;
        const pePadding = peRange * 0.1;
        
        const ceYMin = minCE - cePadding;
        const ceYMax = maxCE + cePadding;
        const ceYRange = ceYMax - ceYMin;
        
        const peYMin = minPE - pePadding;
        const peYMax = maxPE + pePadding;
        const peYRange = peYMax - peYMin;
        
        // Split chart into two sections: CE (left) and PE (right)
        const leftChartWidth = chartWidth / 2 - 20;
        const rightChartWidth = chartWidth / 2 - 20;
        const leftChartX = padding;
        const rightChartX = padding + chartWidth / 2 + 20;
        
        // Create SVG
        let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
        svg += `<rect width="${width}" height="${height}" fill="#000000"/>`;
        
        // Title
        svg += `<text x="${width/2}" y="30" text-anchor="middle" fill="#ffffff" font-family="Arial" font-size="18" font-weight="bold">NIFTY VWAP Cross Trading - ${currentTime}</text>`;
        
        // CE Chart Title
        svg += `<text x="${leftChartX + leftChartWidth/2}" y="60" text-anchor="middle" fill="#00ff00" font-family="Arial" font-size="14" font-weight="bold">CE (${ceStrike})</text>`;
        
        // PE Chart Title
        svg += `<text x="${rightChartX + rightChartWidth/2}" y="60" text-anchor="middle" fill="#ff00ff" font-family="Arial" font-size="14" font-weight="bold">PE (${peStrike})</text>`;
        
        // Grid lines and Y-axis labels for CE chart
        for (let i = 0; i <= 10; i++) {
            const y = padding + 30 + (chartHeight * i / 10);
            svg += `<line x1="${leftChartX}" y1="${y}" x2="${leftChartX + leftChartWidth}" y2="${y}" stroke="#333333" stroke-width="1"/>`;
            
            // Y-axis price label for CE (on the left side)
            const priceValue = ceYMax - (ceYRange * i / 10);
            svg += `<text x="${leftChartX - 10}" y="${y + 4}" text-anchor="end" fill="#ffffff" font-family="Arial" font-size="10">${priceValue.toFixed(2)}</text>`;
        }
        
        // Grid lines and Y-axis labels for PE chart
        for (let i = 0; i <= 10; i++) {
            const y = padding + 30 + (chartHeight * i / 10);
            svg += `<line x1="${rightChartX}" y1="${y}" x2="${rightChartX + rightChartWidth}" y2="${y}" stroke="#333333" stroke-width="1"/>`;
            
            // Y-axis price label for PE (on the left side of PE chart)
            const priceValue = peYMax - (peYRange * i / 10);
            svg += `<text x="${rightChartX - 10}" y="${y + 4}" text-anchor="end" fill="#ffffff" font-family="Arial" font-size="10">${priceValue.toFixed(2)}</text>`;
        }
        
        // CE Price line (green)
        if (chartData.length > 1) {
            let pathData = '';
            for (let i = 0; i < chartData.length; i++) {
                const price = chartData[i];
                if (price === undefined) continue;
                const x = leftChartX + (leftChartWidth * i / (chartData.length - 1));
                const y = padding + 30 + chartHeight - ((price - ceYMin) / ceYRange) * chartHeight;
                pathData += (i === 0 ? 'M' : 'L') + `${x},${y}`;
            }
            svg += `<path d="${pathData}" stroke="#00ff00" stroke-width="2" fill="none"/>`;
        }
        
        // CE VWAP line (red)
        if (ceVwapData.length > 1) {
            let pathData = '';
            for (let i = 0; i < ceVwapData.length; i++) {
                const vwap = ceVwapData[i];
                if (vwap === undefined) continue;
                const x = leftChartX + (leftChartWidth * i / (ceVwapData.length - 1));
                const y = padding + 30 + chartHeight - ((vwap - ceYMin) / ceYRange) * chartHeight;
                pathData += (i === 0 ? 'M' : 'L') + `${x},${y}`;
            }
            svg += `<path d="${pathData}" stroke="#ff0000" stroke-width="2" fill="none"/>`;
        }
        
        // PE Price line (magenta)
        if (peChartData.length > 1) {
            let pathData = '';
            for (let i = 0; i < peChartData.length; i++) {
                const price = peChartData[i];
                if (price === undefined) continue;
                const x = rightChartX + (rightChartWidth * i / (peChartData.length - 1));
                const y = padding + 30 + chartHeight - ((price - peYMin) / peYRange) * chartHeight;
                pathData += (i === 0 ? 'M' : 'L') + `${x},${y}`;
            }
            svg += `<path d="${pathData}" stroke="#ff00ff" stroke-width="2" fill="none"/>`;
        }
        
        // PE VWAP line (orange)
        if (peVwapData.length > 1) {
            let pathData = '';
            for (let i = 0; i < peVwapData.length; i++) {
                const vwap = peVwapData[i];
                if (vwap === undefined) continue;
                const x = rightChartX + (rightChartWidth * i / (peVwapData.length - 1));
                const y = padding + 30 + chartHeight - ((vwap - peYMin) / peYRange) * chartHeight;
                pathData += (i === 0 ? 'M' : 'L') + `${x},${y}`;
            }
            svg += `<path d="${pathData}" stroke="#ff8800" stroke-width="2" fill="none"/>`;
        }
        
        // Entry/Exit markers for CE
        if (cePosition.isOpen) {
            const entryIndex = timeHistory.findIndex(t => t === cePosition.entryTime);
            if (entryIndex >= 0 && entryIndex < chartData.length) {
                const x = leftChartX + (leftChartWidth * entryIndex / (chartData.length - 1));
                const y = padding + 30 + chartHeight - ((cePosition.entryPrice - ceYMin) / ceYRange) * chartHeight;
                svg += `<circle cx="${x}" cy="${y}" r="5" fill="#00ff00" stroke="#ffffff" stroke-width="1"/>`;
                svg += `<text x="${x + 8}" y="${y - 8}" fill="#00ff00" font-family="Arial" font-size="10">ENTRY</text>`;
            }
        }
        
        // Entry/Exit markers for PE
        if (pePosition.isOpen) {
            const entryIndex = timeHistory.findIndex(t => pePosition.entryTime);
            if (entryIndex >= 0 && entryIndex < peChartData.length) {
                const x = rightChartX + (rightChartWidth * entryIndex / (peChartData.length - 1));
                const y = padding + 30 + chartHeight - ((pePosition.entryPrice - peYMin) / peYRange) * chartHeight;
                svg += `<circle cx="${x}" cy="${y}" r="5" fill="#ff00ff" stroke="#ffffff" stroke-width="1"/>`;
                svg += `<text x="${x + 8}" y="${y - 8}" fill="#ff00ff" font-family="Arial" font-size="10">ENTRY</text>`;
            }
        }
        
        // Legend and status (bottom section)
        const statusY = height - 200;
        svg += `<text x="${width - 300}" y="${statusY}" fill="#ffffff" font-family="Arial" font-size="12" font-weight="bold">Status</text>`;
        
        // CE Status
        const latestCEPrice = chartData[chartData.length - 1];
        const latestCEVwap = ceVwapData[ceVwapData.length - 1];
        svg += `<text x="${width - 300}" y="${statusY + 25}" fill="#00ff00" font-family="Arial" font-size="11">CE Price: ${latestCEPrice?.toFixed(2) || 'N/A'}</text>`;
        svg += `<text x="${width - 300}" y="${statusY + 45}" fill="#ff0000" font-family="Arial" font-size="11">CE VWAP: ${latestCEVwap?.toFixed(2) || 'N/A'}</text>`;
        svg += `<text x="${width - 300}" y="${statusY + 65}" fill="#ffffff" font-family="Arial" font-size="11">CE Position: ${cePosition.isOpen ? 'OPEN' : 'CLOSED'}</text>`;
        if (cePosition.isOpen) {
            svg += `<text x="${width - 300}" y="${statusY + 85}" fill="#ffffff" font-family="Arial" font-size="11">CE Entry: ${cePosition.entryPrice.toFixed(2)} @ ${cePosition.entryTime}</text>`;
            svg += `<text x="${width - 300}" y="${statusY + 105}" fill="#ffffff" font-family="Arial" font-size="11">CE Stop Loss: ${ceExitThreshold.toFixed(2)}</text>`;
            svg += `<text x="${width - 300}" y="${statusY + 125}" fill="#ffffff" font-family="Arial" font-size="11">CE Trailing Steps: ${ceTrailingSteps}</text>`;
        }
        
        // PE Status
        const latestPEPrice = peChartData[peChartData.length - 1];
        const latestPEVwap = peVwapData[peVwapData.length - 1];
        svg += `<text x="${width - 300}" y="${statusY + 155}" fill="#ff00ff" font-family="Arial" font-size="11">PE Price: ${latestPEPrice?.toFixed(2) || 'N/A'}</text>`;
        svg += `<text x="${width - 300}" y="${statusY + 175}" fill="#ff8800" font-family="Arial" font-size="11">PE VWAP: ${latestPEVwap?.toFixed(2) || 'N/A'}</text>`;
        svg += `<text x="${width - 300}" y="${statusY + 195}" fill="#ffffff" font-family="Arial" font-size="11">PE Position: ${pePosition.isOpen ? 'OPEN' : 'CLOSED'}</text>`;
        if (pePosition.isOpen) {
            svg += `<text x="${width - 300}" y="${statusY + 215}" fill="#ffffff" font-family="Arial" font-size="11">PE Entry: ${pePosition.entryPrice.toFixed(2)} @ ${pePosition.entryTime}</text>`;
            svg += `<text x="${width - 300}" y="${statusY + 235}" fill="#ffffff" font-family="Arial" font-size="11">PE Stop Loss: ${peExitThreshold.toFixed(2)}</text>`;
            svg += `<text x="${width - 300}" y="${statusY + 255}" fill="#ffffff" font-family="Arial" font-size="11">PE Trailing Steps: ${peTrailingSteps}</text>`;
        }
        
        // Trade count
        const totalTrades = liveTrades.filter(t => t.action === "EXIT").length;
        svg += `<text x="${width - 300}" y="${statusY + 285}" fill="#ffffff" font-family="Arial" font-size="11">Total Trades: ${totalTrades}</text>`;
        
        // Legend
        svg += `<text x="50" y="${height - 150}" fill="#00ff00" font-family="Arial" font-size="11">CE Price</text>`;
        svg += `<text x="50" y="${height - 130}" fill="#ff0000" font-family="Arial" font-size="11">CE VWAP</text>`;
        svg += `<text x="50" y="${height - 110}" fill="#ff00ff" font-family="Arial" font-size="11">PE Price</text>`;
        svg += `<text x="50" y="${height - 90}" fill="#ff8800" font-family="Arial" font-size="11">PE VWAP</text>`;
        
        svg += `</svg>`;
        
        // Save SVG file
        const svgFilename = `nifty_vwap_cross_chart.svg`;
        await writeFile(svgFilename, svg, "utf-8");
        console.log(`📊 Live SVG chart updated: ${svgFilename} (${currentTime})`);
        
    } catch (err) {
        console.error("Error generating live SVG chart:", err);
    }
}

async function saveTradeLog() {
    try {
        const header = "timestamp,instrument,action,price,quantity,orderId,pnl,reason\n";
        const rows = liveTrades.map(t => [
            t.timestamp, t.instrument, t.action, t.price, t.quantity, t.orderId || "", t.pnl || "", t.reason
        ].join(",")).join("\n");
        
        const filename = `nifty_vwap_cross_trades_${dayjs().format("YYYY-MM-DD")}.csv`;
        await writeFile(filename, header + rows + (rows ? "\n" : ""), "utf-8");
        console.log(`Trade log saved: ${filename}`);
        
    } catch (err) {
        console.error("Error saving trade log:", err);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Start the trading system
init().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});



