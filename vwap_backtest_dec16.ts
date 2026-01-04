import { KiteConnect } from "kiteconnect";
import dayjs from "dayjs";
import { writeFile } from "fs/promises";

// API Credentials
const apiKey = "gssli7u395tn5in8";
const apiSecret = "yeq4xu913i50u2d5j5b0wkgqp6cp0ufo";
const accessToken = "dkMtnoil83u85mBrOxuHTmNC1AifbYkr";
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
const lotSize = 75; // NIFTY lot size (matching live strategy)
const rsiPeriod = 14;
const profitTargetPoints = 20;

// Helper function to get dates from Dec 1-12
function getDec1To12Dates(): Date[] {
    const dates: Date[] = [];
    const year = 2025;
    for (let day = 1; day <= 12; day++) {
        const date = new Date(year, 11, day); // December is month 11
        const dayOfWeek = date.getDay();
        // Skip weekends (0 = Sunday, 6 = Saturday)
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            dates.push(date);
        }
    }
    return dates;
}

// Get December 16th expiry (fixed expiry date)
function getDecember16Expiry(instruments: any[], backtestDate: Date): Date | null {
    const year = backtestDate.getFullYear();
    
    // Find December 16th expiry
    const dec16Expiry = instruments
        .filter(inst => {
            if (inst.name !== "NIFTY" || inst.instrument_type !== "CE") return false;
            const expiry = new Date(inst.expiry);
            return expiry.getFullYear() === year && 
                   expiry.getMonth() === 11 && // December is month 11
                   expiry.getDate() === 16;
        })
        .map(inst => new Date(inst.expiry).getTime())
        .filter((ts, index, self) => self.indexOf(ts) === index)
        .sort((a, b) => a - b);
    
    if (dec16Expiry.length === 0) {
        return null;
    }
    
    // Return December 16th expiry
    return new Date(dec16Expiry[0]);
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

function calculateRSI(prices: number[], period: number): number {
    if (prices.length < period + 1) {
        return 0;
    }

    let gains: number[] = [];
    let losses: number[] = [];

    for (let i = 1; i < prices.length; i++) {
        const prevPrice = prices[i - 1];
        const currPrice = prices[i];
        if (prevPrice === undefined || currPrice === undefined) continue;
        const change = currPrice - prevPrice;
        if (change > 0) {
            gains.push(change);
            losses.push(0);
        } else {
            gains.push(0);
            losses.push(Math.abs(change));
        }
    }

    // Initial average (first period)
    let avgGain = gains.slice(0, period).reduce((sum, g) => sum + g, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((sum, l) => sum + l, 0) / period;

    // Wilder's smoothing for subsequent periods
    for (let i = period; i < gains.length; i++) {
        const gain = gains[i];
        const loss = losses[i];
        if (gain === undefined || loss === undefined) continue;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) {
        return 100;
    }

    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    return rsi;
}

async function runBacktest(backtestDate: Date): Promise<{
    date: string;
    totalTrades: number;
    ceTrades: number;
    peTrades: number;
    totalPnl: number;
    cePnl: number;
    pePnl: number;
    status: string;
    trades: Trade[];
}> {
    try {
        kc.setAccessToken(accessToken);
        
        // Get instruments
        const instruments = await kc.getInstruments("NFO");
        
        // Get December 16th expiry
        const expiry = getDecember16Expiry(instruments, backtestDate);
        if (!expiry) {
            return {
                date: dayjs(backtestDate).format("YYYY-MM-DD"),
                totalTrades: 0,
                ceTrades: 0,
                peTrades: 0,
                totalPnl: 0,
                cePnl: 0,
                pePnl: 0,
                status: "No December 16th expiry found",
                trades: []
            };
        }
        
        // Get spot price at 9:20 AM
        const spotToken = await getNiftySpotToken();
        if (!spotToken) {
            return {
                date: dayjs(backtestDate).format("YYYY-MM-DD"),
                totalTrades: 0,
                ceTrades: 0,
                peTrades: 0,
                totalPnl: 0,
                cePnl: 0,
                pePnl: 0,
                status: "Could not find NIFTY spot token",
                trades: []
            };
        }
        
        const entryCutoff = new Date(backtestDate);
        entryCutoff.setHours(9, 20, 0, 0);
        const fromTime = new Date(entryCutoff.getTime() - 10 * 60 * 1000);
        const toTime = new Date(entryCutoff.getTime() + 30 * 60 * 1000);
        
        const spotCandles = await getHistoricalCandles(spotToken, fromTime, toTime);
        if (spotCandles.length === 0) {
            return {
                date: dayjs(backtestDate).format("YYYY-MM-DD"),
                totalTrades: 0,
                ceTrades: 0,
                peTrades: 0,
                totalPnl: 0,
                cePnl: 0,
                pePnl: 0,
                status: "No spot candles available",
                trades: []
            };
        }
        
        const cutoffCandle = spotCandles.find(candle => {
            const ts = new Date(candle.date).getTime();
            return ts >= entryCutoff.getTime() && ts < entryCutoff.getTime() + 60000;
        }) || spotCandles[spotCandles.length - 1];
        
        if (!cutoffCandle) {
            return {
                date: dayjs(backtestDate).format("YYYY-MM-DD"),
                totalTrades: 0,
                ceTrades: 0,
                peTrades: 0,
                totalPnl: 0,
                cePnl: 0,
                pePnl: 0,
                status: "No cutoff candle available",
                trades: []
            };
        }
        
        const spotPrice = cutoffCandle.close;
        const atmStrike = Math.round(spotPrice / 50) * 50;
        const peStrike = atmStrike + 150;
        const ceStrike = atmStrike - 150;
        
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
            return {
                date: dayjs(backtestDate).format("YYYY-MM-DD"),
                totalTrades: 0,
                ceTrades: 0,
                peTrades: 0,
                totalPnl: 0,
                cePnl: 0,
                pePnl: 0,
                status: `Could not find instruments for strikes CE:${ceStrike}, PE:${peStrike}`,
                trades: []
            };
        }
        
        const ceToken = Number(ce.instrument_token);
        const peToken = Number(pe.instrument_token);
        
        // Get RSI start time (previous working day 9:15 AM)
        let previousDay = new Date(backtestDate);
        previousDay.setDate(previousDay.getDate() - 1);
        while (previousDay.getDay() === 0 || previousDay.getDay() === 6) {
            previousDay.setDate(previousDay.getDate() - 1);
        }
        const rsiStartTime = new Date(previousDay.getTime() + 9 * 60 * 60 * 1000 + 15 * 60 * 1000);
        
        // Get session times
        const sessionStart = new Date(backtestDate);
        sessionStart.setHours(9, 15, 0, 0);
        const sessionEnd = new Date(backtestDate);
        sessionEnd.setHours(15, 20, 0, 0); // 3:20 PM (matching live strategy)
        
        // Get all candles for the day
        const ceCandles = await getHistoricalCandles(ceToken, rsiStartTime, sessionEnd);
        const peCandles = await getHistoricalCandles(peToken, rsiStartTime, sessionEnd);
        
        if (ceCandles.length === 0 || peCandles.length === 0) {
            return {
                date: dayjs(backtestDate).format("YYYY-MM-DD"),
                totalTrades: 0,
                ceTrades: 0,
                peTrades: 0,
                totalPnl: 0,
                cePnl: 0,
                pePnl: 0,
                status: "No option candles available",
                trades: []
            };
        }
        
        // Filter candles from session start (9:15 AM)
        const sessionStartTs = sessionStart.getTime();
        const sessionCeCandles = ceCandles.filter(c => new Date(c.date).getTime() >= sessionStartTs);
        const sessionPeCandles = peCandles.filter(c => new Date(c.date).getTime() >= sessionStartTs);
        
        // Calculate RSI for each minute
        const ceClosePrices = ceCandles.map(c => c.close);
        const peClosePrices = peCandles.map(c => c.close);
        
        // Simulate trading
        const trades: Trade[] = [];
        const cePosition: Position = { isOpen: false, entryPrice: 0, entryTime: "" };
        const pePosition: Position = { isOpen: false, entryPrice: 0, entryTime: "" };
        
        const ceRsiHistory: number[] = [];
        const peRsiHistory: number[] = [];
        
        // Build RSI history from all candles (including previous day)
        for (let i = rsiPeriod + 1; i <= ceCandles.length; i++) {
            const ceRsi = calculateRSI(ceClosePrices.slice(0, i), rsiPeriod);
            const peRsi = calculateRSI(peClosePrices.slice(0, i), rsiPeriod);
            ceRsiHistory.push(ceRsi);
            peRsiHistory.push(peRsi);
        }
        
        // Process each minute candle from session start
        for (let i = 0; i < sessionCeCandles.length; i++) {
            const ceCandle = sessionCeCandles[i];
            const peCandle = sessionPeCandles[i];
            if (!ceCandle || !peCandle) continue;
            const candleTime = new Date(ceCandle.date);
            
            // Skip if before 9:20 AM
            if (candleTime < entryCutoff) {
                continue;
            }
            
            // Get RSI index (account for previous day candles)
            const rsiIndex = ceCandles.findIndex(c => new Date(c.date).getTime() === candleTime.getTime());
            if (rsiIndex < rsiPeriod + 1) continue;
            
            const currentCeRsi = ceRsiHistory[rsiIndex - rsiPeriod - 1] ?? 0;
            const currentPeRsi = peRsiHistory[rsiIndex - rsiPeriod - 1] ?? 0;
            const lastCeRsi = rsiIndex > rsiPeriod + 1 ? (ceRsiHistory[rsiIndex - rsiPeriod - 2] ?? 0) : 0;
            const lastPeRsi = rsiIndex > rsiPeriod + 1 ? (peRsiHistory[rsiIndex - rsiPeriod - 2] ?? 0) : 0;
            
            const timeStr = dayjs(candleTime).format("HH:mm:ss");
            const cePrice = ceCandle.close;
            const pePrice = peCandle.close;
            
            // Check exit conditions first
            // CE Exit
            if (cePosition.isOpen) {
                // Exit 1: RSI condition
                if (lastCeRsi >= 30 && currentCeRsi < 30) {
                    const pnl = (cePosition.entryPrice - cePrice) * lotSize;
                    trades.push({
                        timestamp: dayjs(candleTime).format("YYYY-MM-DD HH:mm:ss"),
                        instrument: "CE",
                        action: "EXIT",
                        price: cePrice,
                        quantity: lotSize,
                        pnl,
                        reason: `RSI Exit: ${lastCeRsi.toFixed(2)} -> ${currentCeRsi.toFixed(2)}`
                    });
                    cePosition.isOpen = false;
                    continue;
                }
                
                // Exit 2: Price moved 20 points above entry
                if (cePrice >= cePosition.entryPrice + profitTargetPoints) {
                    const pnl = (cePosition.entryPrice - cePrice) * lotSize;
                    trades.push({
                        timestamp: dayjs(candleTime).format("YYYY-MM-DD HH:mm:ss"),
                        instrument: "CE",
                        action: "EXIT",
                        price: cePrice,
                        quantity: lotSize,
                        pnl,
                        reason: `Price Exit: ${cePrice.toFixed(2)} >= ${(cePosition.entryPrice + profitTargetPoints).toFixed(2)}`
                    });
                    cePosition.isOpen = false;
                    continue;
                }
            }
            
            // PE Exit
            if (pePosition.isOpen) {
                // Exit 1: RSI condition
                if (lastPeRsi >= 30 && currentPeRsi < 30) {
                    const pnl = (pePosition.entryPrice - pePrice) * lotSize;
                    trades.push({
                        timestamp: dayjs(candleTime).format("YYYY-MM-DD HH:mm:ss"),
                        instrument: "PE",
                        action: "EXIT",
                        price: pePrice,
                        quantity: lotSize,
                        pnl,
                        reason: `RSI Exit: ${lastPeRsi.toFixed(2)} -> ${currentPeRsi.toFixed(2)}`
                    });
                    pePosition.isOpen = false;
                    continue;
                }
                
                // Exit 2: Price moved 20 points above entry
                if (pePrice >= pePosition.entryPrice + profitTargetPoints) {
                    const pnl = (pePosition.entryPrice - pePrice) * lotSize;
                    trades.push({
                        timestamp: dayjs(candleTime).format("YYYY-MM-DD HH:mm:ss"),
                        instrument: "PE",
                        action: "EXIT",
                        price: pePrice,
                        quantity: lotSize,
                        pnl,
                        reason: `Price Exit: ${pePrice.toFixed(2)} >= ${(pePosition.entryPrice + profitTargetPoints).toFixed(2)}`
                    });
                    pePosition.isOpen = false;
                    continue;
                }
            }
            
            // Check entry conditions
            // CE Entry: Last RSI >= 70 AND current RSI < 70
            if (!cePosition.isOpen && lastCeRsi >= 70 && currentCeRsi < 70) {
                trades.push({
                    timestamp: dayjs(candleTime).format("YYYY-MM-DD HH:mm:ss"),
                    instrument: "CE",
                    action: "ENTRY",
                    price: cePrice,
                    quantity: lotSize,
                    reason: `RSI Entry: ${lastCeRsi.toFixed(2)} -> ${currentCeRsi.toFixed(2)}`
                });
                cePosition.isOpen = true;
                cePosition.entryPrice = cePrice;
                cePosition.entryTime = timeStr;
            }
            
            // PE Entry: Last RSI >= 70 AND current RSI < 70
            if (!pePosition.isOpen && lastPeRsi >= 70 && currentPeRsi < 70) {
                trades.push({
                    timestamp: dayjs(candleTime).format("YYYY-MM-DD HH:mm:ss"),
                    instrument: "PE",
                    action: "ENTRY",
                    price: pePrice,
                    quantity: lotSize,
                    reason: `RSI Entry: ${lastPeRsi.toFixed(2)} -> ${currentPeRsi.toFixed(2)}`
                });
                pePosition.isOpen = true;
                pePosition.entryPrice = pePrice;
                pePosition.entryTime = timeStr;
            }
        }
        
        // Square off any open positions at session end
        if (cePosition.isOpen && sessionCeCandles.length > 0) {
            const lastCandle = sessionCeCandles[sessionCeCandles.length - 1];
            if (lastCandle) {
                const pnl = (cePosition.entryPrice - lastCandle.close) * lotSize;
            trades.push({
                timestamp: dayjs(sessionEnd).format("YYYY-MM-DD HH:mm:ss"),
                instrument: "CE",
                action: "EXIT",
                price: lastCandle.close,
                quantity: lotSize,
                pnl,
                reason: "Session end - Square off"
                });
            }
        }
        
        if (pePosition.isOpen && sessionPeCandles.length > 0) {
            const lastCandle = sessionPeCandles[sessionPeCandles.length - 1];
            if (lastCandle) {
                const pnl = (pePosition.entryPrice - lastCandle.close) * lotSize;
            trades.push({
                timestamp: dayjs(sessionEnd).format("YYYY-MM-DD HH:mm:ss"),
                instrument: "PE",
                action: "EXIT",
                price: lastCandle.close,
                quantity: lotSize,
                pnl,
                reason: "Session end - Square off"
                });
            }
        }
        
        // Calculate summary
        const ceTrades = trades.filter(t => t.instrument === "CE" && t.action === "EXIT");
        const peTrades = trades.filter(t => t.instrument === "PE" && t.action === "EXIT");
        const cePnl = ceTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
        const pePnl = peTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
        const totalPnl = cePnl + pePnl;
        
        return {
            date: dayjs(backtestDate).format("YYYY-MM-DD"),
            totalTrades: ceTrades.length + peTrades.length,
            ceTrades: ceTrades.length,
            peTrades: peTrades.length,
            totalPnl,
            cePnl,
            pePnl,
            status: "Success",
            trades
        };
        
    } catch (err: any) {
        const errorMsg = err?.message || String(err);
        return {
            date: dayjs(backtestDate).format("YYYY-MM-DD"),
            totalTrades: 0,
            ceTrades: 0,
            peTrades: 0,
            totalPnl: 0,
            cePnl: 0,
            pePnl: 0,
            status: `Error: ${errorMsg.substring(0, 100)}`,
            trades: []
        };
    }
}

// Main execution
async function main() {
    console.log(`\n${"=".repeat(80)}`);
    console.log("NIFTY RSI Strategy Backtest - December 1-12, 2025");
    console.log("Using December 16th Expiry");
    console.log(`${"=".repeat(80)}\n`);
    
    const workingDays = getDec1To12Dates();
    console.log(`Found ${workingDays.length} working days to analyze\n`);
    
    const results: Array<{
        date: string;
        totalTrades: number;
        ceTrades: number;
        peTrades: number;
        totalPnl: number;
        cePnl: number;
        pePnl: number;
        status: string;
        trades: Trade[];
    }> = [];
    
    for (let i = 0; i < workingDays.length; i++) {
        const date = workingDays[i];
        if (!date) continue;
        const dateStr = dayjs(date).format("YYYY-MM-DD");
        console.log(`\n${"-".repeat(80)}`);
        console.log(`[${i + 1}/${workingDays.length}] Running backtest for ${dateStr}...`);
        console.log(`${"-".repeat(80)}`);
        
        const result = await runBacktest(date);
        results.push(result);
        
        if (result.status === "Success") {
            console.log(`✅ ${dateStr}: ${result.totalTrades} trades, Total P&L: ${result.totalPnl >= 0 ? '+' : ''}${result.totalPnl.toFixed(2)}`);
            console.log(`   CE: ${result.ceTrades} trades, P&L: ${result.cePnl >= 0 ? '+' : ''}${result.cePnl.toFixed(2)}`);
            console.log(`   PE: ${result.peTrades} trades, P&L: ${result.pePnl >= 0 ? '+' : ''}${result.pePnl.toFixed(2)}`);
        } else {
            console.log(`⚠️  ${dateStr}: ${result.status}`);
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Print summary
    console.log(`\n${"=".repeat(80)}`);
    console.log("📊 SUMMARY: RSI Strategy Backtest Results (December 1-12, 2025)");
    console.log(`${"=".repeat(80)}\n`);
    
    const successfulDays = results.filter(r => r.status === "Success");
    const totalDays = results.length;
    const tradingDays = successfulDays.length;
    
    const totalTrades = successfulDays.reduce((sum, r) => sum + r.totalTrades, 0);
    const totalCeTrades = successfulDays.reduce((sum, r) => sum + r.ceTrades, 0);
    const totalPeTrades = successfulDays.reduce((sum, r) => sum + r.peTrades, 0);
    const totalPnl = successfulDays.reduce((sum, r) => sum + r.totalPnl, 0);
    const totalCePnl = successfulDays.reduce((sum, r) => sum + r.cePnl, 0);
    const totalPePnl = successfulDays.reduce((sum, r) => sum + r.pePnl, 0);
    const avgPnlPerDay = tradingDays > 0 ? totalPnl / tradingDays : 0;
    const avgPnlPerTrade = totalTrades > 0 ? totalPnl / totalTrades : 0;
    
    console.log(`Total Days Analyzed: ${totalDays}`);
    console.log(`Trading Days: ${tradingDays}`);
    console.log(`Market Closed/Error Days: ${totalDays - tradingDays}`);
    console.log(`\nTotal Trades: ${totalTrades}`);
    console.log(`  - CE Trades: ${totalCeTrades}`);
    console.log(`  - PE Trades: ${totalPeTrades}`);
    console.log(`\nTotal P&L: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`);
    console.log(`  - CE P&L: ${totalCePnl >= 0 ? '+' : ''}${totalCePnl.toFixed(2)}`);
    console.log(`  - PE P&L: ${totalPePnl >= 0 ? '+' : ''}${totalPePnl.toFixed(2)}`);
    console.log(`\nAverage P&L per Trading Day: ${avgPnlPerDay >= 0 ? '+' : ''}${avgPnlPerDay.toFixed(2)}`);
    console.log(`Average P&L per Trade: ${avgPnlPerTrade >= 0 ? '+' : ''}${avgPnlPerTrade.toFixed(2)}`);
    
    console.log(`\n${"-".repeat(80)}`);
    console.log("Daily Breakdown:");
    console.log(`${"-".repeat(80)}`);
    console.log("Date       | Trades | CE | PE | CE P&L    | PE P&L    | Total P&L  | Status");
    console.log(`${"-".repeat(80)}`);
    
    results.forEach(r => {
        const dateStr = r.date.substring(5); // YYYY-MM-DD -> MM-DD
        const cePnlStr = r.cePnl >= 0 ? `+${r.cePnl.toFixed(2)}` : r.cePnl.toFixed(2);
        const pePnlStr = r.pePnl >= 0 ? `+${r.pePnl.toFixed(2)}` : r.pePnl.toFixed(2);
        const totalPnlStr = r.totalPnl >= 0 ? `+${r.totalPnl.toFixed(2)}` : r.totalPnl.toFixed(2);
        const statusStr = r.status.length > 20 ? r.status.substring(0, 17) + "..." : r.status;
        console.log(
            `${dateStr}   | ${r.totalTrades.toString().padStart(6)} | ${r.ceTrades.toString().padStart(2)} | ${r.peTrades.toString().padStart(2)} | ${cePnlStr.padStart(9)} | ${pePnlStr.padStart(9)} | ${totalPnlStr.padStart(10)} | ${statusStr}`
        );
    });
    
    console.log(`\n${"=".repeat(80)}\n`);
    
    // Save detailed results to CSV
    try {
        const csvHeader = "date,timestamp,instrument,action,price,quantity,pnl,reason\n";
        const csvRows = results.flatMap(r => 
            r.trades.map(t => 
                `${r.date},${t.timestamp},${t.instrument},${t.action},${t.price.toFixed(2)},${t.quantity},${t.pnl?.toFixed(2) || ""},${t.reason}`
            )
        );
        const csvContent = csvHeader + csvRows.join("\n");
        const filename = `rsi_backtest_dec16_${dayjs().format("YYYY-MM-DD")}.csv`;
        await writeFile(filename, csvContent, "utf-8");
        console.log(`📁 Detailed trade log saved: ${filename}`);
    } catch (err) {
        console.error("Error saving CSV:", err);
    }
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});

