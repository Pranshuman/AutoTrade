import { KiteConnect } from "kiteconnect";
import dayjs from "dayjs";
import { writeFile } from "fs/promises";

// API Credentials
const apiKey = "gssli7u395tn5in8";
const apiSecret = "yeq4xu913i50u2d5j5b0wkgqp6cp0ufo";
const accessToken = "YFgvWwTQS651T2fz9bHaYMxXPZYI3xaG";
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

type Position = {
    isOpen: boolean;
    entryPrice: number;
    entryTime: string;
};

type Trade = {
    timestamp: string;
    instrument: "CE" | "PE";
    action: "ENTRY" | "EXIT";
    price: number;
    quantity: number;
    pnl?: number;
    reason: string;
};

// Constants
const lotSize = 75; // NIFTY lot size
const rsiPeriod = 14;
const stopLossPoints = 30; // 30 points risk
const profitTargetPoints = 25; // 25 points profit target

// Helper function to get dates for backtest (Jan 1, 2026)
function getBacktestDates(): Date[] {
    const dates: Date[] = [];
    const date = new Date(2026, 0, 1); // January 1, 2026 (month 0 = January)
    const dayOfWeek = date.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        dates.push(date);
    }
    return dates;
}

// Get next expiry after the backtest date
function getNextExpiry(instruments: any[], backtestDate: Date): Date | null {
    const todayEnd = new Date(backtestDate.getFullYear(), backtestDate.getMonth(), backtestDate.getDate()).getTime() + 24 * 60 * 60 * 1000 - 1;
    
    const expiries = instruments
        .filter(inst => inst.name === "NIFTY" && inst.instrument_type === "CE" && inst.expiry)
        .map(inst => new Date(inst.expiry).getTime())
        .filter((ts, idx, self) => self.indexOf(ts) === idx && ts > todayEnd)
        .sort((a, b) => a - b);
    
    return expiries.length > 0 ? new Date(expiries[0]) : null;
}

async function getHistoricalCandles(instrumentToken: number, interval: string, from: Date, to: Date): Promise<Candle[]> {
    try {
        const candles = await kc.getHistoricalData(instrumentToken, interval, from, to, false);
        return candles as unknown as Candle[];
    } catch (err: any) {
        console.error(`Error fetching candles for token ${instrumentToken}:`, err.message);
        return [];
    }
}

let spotTokenCache: number | null = null;
async function getNiftySpotToken(): Promise<number | null> {
    if (spotTokenCache) return spotTokenCache;
    try {
        const instruments = await kc.getInstruments("NSE");
        const nifty = instruments.find(inst => inst.tradingsymbol === "NIFTY 50");
        spotTokenCache = nifty ? Number(nifty.instrument_token) : null;
        return spotTokenCache;
    } catch (err) {
        console.error("Error getting NIFTY spot token:", err);
        return null;
    }
}

function calculateRSI(prices: number[], period: number): number {
    if (prices.length < period + 1) return 0;
    let gains: number[] = [];
    let losses: number[] = [];
    for (let i = 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        gains.push(change > 0 ? change : 0);
        losses.push(change < 0 ? Math.abs(change) : 0);
    }
    let avgGain = gains.slice(0, period).reduce((sum, g) => sum + g, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((sum, l) => sum + l, 0) / period;
    for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// Calculate VWAP for a set of candles using closing price
function calculateVWAPHistory(candles: Candle[]): number[] {
    let cumulativePV = 0;
    let cumulativeVol = 0;
    return candles.map(c => {
        // Using closing value for VWAP calculation as per user request
        const price = c.close;
        cumulativePV += price * c.volume;
        cumulativeVol += c.volume;
        return cumulativePV / cumulativeVol;
    });
}

let nfoInstrumentsCache: any[] | null = null;
async function getNfoInstruments(): Promise<any[]> {
    if (nfoInstrumentsCache) return nfoInstrumentsCache;
    try {
        console.log("Fetching NFO instruments...");
        nfoInstrumentsCache = await kc.getInstruments("NFO");
        return nfoInstrumentsCache;
    } catch (err: any) {
        console.error("Error getting NFO instruments:", err.message);
        return [];
    }
}

async function runBacktest(backtestDate: Date): Promise<{
    date: string;
    totalTrades: number;
    totalPnl: number;
    status: string;
    trades: Trade[];
}> {
    try {
        const instruments = await getNfoInstruments();
        const expiry = getNextExpiry(instruments, backtestDate);
        if (!expiry) return { date: dayjs(backtestDate).format("YYYY-MM-DD"), totalTrades: 0, totalPnl: 0, status: "Expiry not found", trades: [] };

        console.log(`📅 Selected Expiry: ${dayjs(expiry).format("YYYY-MM-DD")} (Next available expiry after ${dayjs(backtestDate).format("YYYY-MM-DD")})`);

        const spotToken = await getNiftySpotToken();
        if (!spotToken) return { date: dayjs(backtestDate).format("YYYY-MM-DD"), totalTrades: 0, totalPnl: 0, status: "Spot token not found", trades: [] };

        // Select strikes at 9:20 AM
        const strikeSelectionTime = new Date(backtestDate);
        strikeSelectionTime.setHours(9, 20, 0, 0);
        
        // Trades start at 10:00 AM
        const tradeStartTime = new Date(backtestDate);
        tradeStartTime.setHours(10, 0, 0, 0);

        const spotCandles1m = await getHistoricalCandles(spotToken, "minute", new Date(strikeSelectionTime.getTime() - 5 * 60000), new Date(strikeSelectionTime.getTime() + 60000));
        if (spotCandles1m.length === 0) {
            return { date: dayjs(backtestDate).format("YYYY-MM-DD"), totalTrades: 0, totalPnl: 0, status: "No market data available (likely a holiday)", trades: [] };
        }
        const spotPrice = spotCandles1m.find(c => new Date(c.date).getTime() >= strikeSelectionTime.getTime())?.close || spotCandles1m[spotCandles1m.length - 1]?.close;
        if (!spotPrice) {
            return { date: dayjs(backtestDate).format("YYYY-MM-DD"), totalTrades: 0, totalPnl: 0, status: "Could not determine spot price", trades: [] };
        }
        const atmStrike = Math.round(spotPrice / 50) * 50;
        const peStrike = atmStrike + 150;
        const ceStrike = atmStrike - 150;

        console.log(`\n[${dayjs(backtestDate).format("YYYY-MM-DD")}] Spot (at 9:20): ${spotPrice.toFixed(2)}, ATM: ${atmStrike}`);
        console.log(`CE Strike: ${ceStrike} (ATM), PE Strike: ${peStrike} (ATM)`);
        console.log(`Trading starts after: 10:00:00`);

        const ce = instruments.find(inst => inst.name === "NIFTY" && inst.strike === ceStrike && inst.instrument_type === "CE" && new Date(inst.expiry).getTime() === expiry.getTime());
        const pe = instruments.find(inst => inst.name === "NIFTY" && inst.strike === peStrike && inst.instrument_type === "PE" && new Date(inst.expiry).getTime() === expiry.getTime());

        if (!ce || !pe) return { date: dayjs(backtestDate).format("YYYY-MM-DD"), totalTrades: 0, totalPnl: 0, status: "Instruments not found", trades: [] };

        const ceToken = Number(ce.instrument_token);
        const peToken = Number(pe.instrument_token);

        // Fetch 5-minute candles
        let previousDay = new Date(backtestDate);
        previousDay.setDate(previousDay.getDate() - 1);
        while (previousDay.getDay() === 0 || previousDay.getDay() === 6) previousDay.setDate(previousDay.getDate() - 1);
        const rsiStartTime = new Date(previousDay.getTime());
        rsiStartTime.setHours(9, 15, 0, 0);
        
        const sessionEnd = new Date(backtestDate);
        sessionEnd.setHours(15, 25, 0, 0);

        const ceCandles = await getHistoricalCandles(ceToken, "5minute", rsiStartTime, sessionEnd);
        const peCandles = await getHistoricalCandles(peToken, "5minute", rsiStartTime, sessionEnd);

        if (ceCandles.length === 0 || peCandles.length === 0) return { date: dayjs(backtestDate).format("YYYY-MM-DD"), totalTrades: 0, totalPnl: 0, status: "No candles", trades: [] };

        // Filter and process session candles
        const sessionStartTs = new Date(backtestDate).setHours(9, 15, 0, 0);
        const ceSessionCandles = ceCandles.filter(c => new Date(c.date).getTime() >= sessionStartTs);
        const peSessionCandles = peCandles.filter(c => new Date(c.date).getTime() >= sessionStartTs);

        const ceVwapHistory = calculateVWAPHistory(ceSessionCandles);
        const peVwapHistory = calculateVWAPHistory(peSessionCandles);

        const trades: Trade[] = [];
        const cePos: Position = { isOpen: false, entryPrice: 0, entryTime: "" };
        const pePos: Position = { isOpen: false, entryPrice: 0, entryTime: "" };

        // Simulation loop for CE and PE separately
        // Track previous price and VWAP for instant entry condition (using objects for pass-by-reference)
        const cePreviousPrice = { value: null as number | null };
        const cePreviousVwap = { value: null as number | null };
        const pePreviousPrice = { value: null as number | null };
        const pePreviousVwap = { value: null as number | null };

        const processInstrument = (candles: Candle[], sessionCandles: Candle[], vwapHistory: number[], pos: Position, type: "CE" | "PE", previousPrice: { value: number | null }, previousVwap: { value: number | null }) => {
            sessionCandles.forEach((candle, idx) => {
                const candleTs = new Date(candle.date).getTime();
                if (candleTs < tradeStartTime.getTime()) {
                    // Update previous values even before trade start time
                    previousPrice.value = candle.close;
                    previousVwap.value = vwapHistory[idx];
                    return;
                }

                const vwap = vwapHistory[idx];
                const fullIndex = candles.findIndex(c => c.date === candle.date);
                const rsi = calculateRSI(candles.slice(0, fullIndex + 1).map(c => c.close), rsiPeriod);

                // Check if this is the end of a 5-minute candle
                // 5-minute candles end at :00, :05, :10, :15, :20, :25, :30, :35, :40, :45, :50, :55
                // (minutes divisible by 5)
                const candleDate = new Date(candle.date);
                const candleMinute = candleDate.getMinutes();
                const isEndOf5Min = candleMinute % 5 === 0; // Minutes divisible by 5

                if (pos.isOpen) {
                    // Exit conditions (checked on every candle for continuous monitoring)
                    // Stop Loss: Entry + 30 (price moved 30 points above entry) - checked continuously
                    const isStopLoss = candle.close >= pos.entryPrice + stopLossPoints;
                    // VWAP Exit: Price > VWAP - checked continuously
                    const isVwapExit = candle.close > vwap;
                    // Profit Target: Entry - 25 (price moved 25 points below entry) - checked continuously on every candle
                    // Similar to stop loss, checked on every candle for immediate execution
                    const isProfitTarget = candle.close <= pos.entryPrice - profitTargetPoints;

                    if (isStopLoss || isVwapExit || isProfitTarget) {
                        const pnl = (pos.entryPrice - candle.close) * lotSize;
                        let reason = "";
                        if (isStopLoss) reason = `Price Exit (Stop Loss): Price ${candle.close.toFixed(2)} is ${(candle.close - pos.entryPrice).toFixed(2)} points above entry ${pos.entryPrice.toFixed(2)}`;
                        else if (isVwapExit) reason = `Price > VWAP reclaim: Price ${candle.close.toFixed(2)} > VWAP ${vwap.toFixed(2)}`;
                        else reason = `Profit Target hit (25 pts): Price ${candle.close.toFixed(2)} is ${(pos.entryPrice - candle.close).toFixed(2)} points below entry ${pos.entryPrice.toFixed(2)}`;

                        trades.push({
                            timestamp: dayjs(candle.date).format("YYYY-MM-DD HH:mm:ss"),
                            instrument: type,
                            action: "EXIT",
                            price: candle.close,
                            quantity: lotSize,
                            pnl,
                            reason: reason
                        });
                        pos.isOpen = false;
                        // Reset previous values after exit
                        previousPrice.value = null;
                        previousVwap.value = null;
                    }
                } else {
                    // Entry Condition 1: 5-minute candle entry
                    // Only check at end of 5-minute candles (last 10 seconds)
                    // Price must be between VWAP - 10 and VWAP - 5
                    if (isEndOf5Min && candle.close >= vwap - 10 && candle.close <= vwap - 5) {
                        trades.push({
                            timestamp: dayjs(candle.date).format("YYYY-MM-DD HH:mm:ss"),
                            instrument: type,
                            action: "ENTRY",
                            price: candle.close,
                            quantity: lotSize,
                            reason: `5-min candle entry: Price=${candle.close.toFixed(2)} between VWAP-10=${(vwap-10).toFixed(2)} and VWAP-5=${(vwap-5).toFixed(2)}`
                        });
                        pos.isOpen = true;
                        pos.entryPrice = candle.close;
                        pos.entryTime = candle.date;
                        // Reset previous values after entry
                        previousPrice.value = null;
                        previousVwap.value = null;
                        return; // Skip updating previous values since we reset them
                    }

                    // Entry Condition 2: Instant entry (price crosses below VWAP - 10)
                    // Check if previous price >= VWAP - 10 AND current price < VWAP - 10
                    // Simulate the crossing during the candle
                    if (previousPrice.value !== null && previousVwap.value !== null) {
                        const previousLowerBound = previousVwap.value - 10;
                        const currentLowerBound = vwap - 10;
                        
                        // Check if price crossed below the lower bound during the candle
                        // Previous price was >= VWAP - 10, and current candle crossed below VWAP - 10
                        if (previousPrice.value >= previousLowerBound && candle.low < currentLowerBound) {
                            // Entry price should be at VWAP - 10 (the trigger level), but ensure it's within the candle's range
                            // Clamp entry price between candle's low and high
                            const entryPrice = Math.max(candle.low, Math.min(currentLowerBound, candle.high));
                            
                            trades.push({
                                timestamp: dayjs(candle.date).format("YYYY-MM-DD HH:mm:ss"),
                                instrument: type,
                                action: "ENTRY",
                                price: entryPrice,
                                quantity: lotSize,
                                reason: `Instant entry: Price crossed below VWAP-10 (${previousPrice.value.toFixed(2)} >= ${previousLowerBound.toFixed(2)} -> ${candle.low.toFixed(2)} < ${currentLowerBound.toFixed(2)})`
                            });
                            pos.isOpen = true;
                            pos.entryPrice = entryPrice;
                            pos.entryTime = candle.date;
                            // Reset previous values after entry
                            previousPrice.value = null;
                            previousVwap.value = null;
                            return; // Skip updating previous values since we reset them
                        }
                    }
                }

                // Update previous values for next candle (after all checks are done)
                previousPrice.value = candle.close;
                previousVwap.value = vwap;
            });
        };

        processInstrument(ceCandles, ceSessionCandles, ceVwapHistory, cePos, "CE", cePreviousPrice, cePreviousVwap);
        processInstrument(peCandles, peSessionCandles, peVwapHistory, pePos, "PE", pePreviousPrice, pePreviousVwap);

        // Square off at 3:20 PM
        const squareOffTime = "15:20:00";
        [ { pos: cePos, type: "CE", candles: ceSessionCandles }, { pos: pePos, type: "PE", candles: peSessionCandles } ].forEach(({ pos, type, candles }) => {
            if (pos.isOpen) {
                const lastCandle = candles[candles.length - 1];
                const pnl = (pos.entryPrice - lastCandle.close) * lotSize;
                trades.push({
                    timestamp: dayjs(lastCandle.date).format("YYYY-MM-DD HH:mm:ss"),
                    instrument: type as "CE" | "PE",
                    action: "EXIT",
                    price: lastCandle.close,
                    quantity: lotSize,
                    pnl,
                    reason: "Session end square off (15:20)"
                });
                pos.isOpen = false;
            }
        });

        const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
        return {
            date: dayjs(backtestDate).format("YYYY-MM-DD"),
            totalTrades: trades.filter(t => t.action === "EXIT").length,
            totalPnl,
            status: "Success",
            trades
        };

    } catch (err: any) {
        return { date: dayjs(backtestDate).format("YYYY-MM-DD"), totalTrades: 0, totalPnl: 0, status: `Error: ${err.message}`, trades: [] };
    }
}

async function main() {
    kc.setAccessToken(accessToken);
    const dates = getBacktestDates();
    const allResults = [];
    for (const date of dates) {
        const result = await runBacktest(date);
        allResults.push(result);
        if (result.status === "Success") {
            console.log(`✅ ${result.date}: P&L: ${result.totalPnl.toFixed(2)} (${result.totalTrades} trades)`);
        } else {
            console.log(`⚠️  ${result.date}: ${result.status}`);
        }
        await new Promise(r => setTimeout(r, 2000));
    }

    const summaryPnl = allResults.reduce((sum, r) => sum + r.totalPnl, 0);
    console.log(`\nFinal P&L: ${summaryPnl.toFixed(2)}`);
    
    const csvContent = "date,timestamp,instrument,action,price,pnl,reason\n" + 
        allResults.flatMap(r => r.trades.map(t => `${r.date},${t.timestamp},${t.instrument},${t.action},${t.price},${t.pnl || ""},"${t.reason}"`)).join("\n");
    await writeFile("vwap_rsi_backtest_jan01_2026.csv", csvContent);
}

main();

