import { KiteConnect } from "kiteconnect";
import dayjs from "dayjs";
import { writeFile } from "fs/promises";

// API Credentials
const apiKey = "gssli7u395tn5in8";
const apiSecret = "yeq4xu913i50u2d5j5b0wkgqp6cp0ufo";
const accessToken = "l1CaG29LiH6YsBp24aoJirpMWjVc4fao";
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

type Trade = {
    date: string;
    entryTime: string;
    exitTime: string;
    type: "BUY" | "SELL";
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    reason: string;
};

// Helper function to get dates for December 2025
function getDecemberDates(): Date[] {
    const dates: Date[] = [];
    const year = 2025;
    const month = 11; // December is 11 in JS
    const today = new Date();
    const endDay = (today.getFullYear() === year && today.getMonth() === month) ? today.getDate() : 31;

    for (let day = 1; day <= endDay; day++) {
        const date = new Date(year, month, day);
        const dayOfWeek = date.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Skip weekends
            dates.push(date);
        }
    }
    return dates;
}

async function getHistoricalCandles(instrumentToken: number, from: Date, to: Date): Promise<Candle[]> {
    try {
        const candles = await kc.getHistoricalData(instrumentToken, "minute", from, to, false);
        return candles as unknown as Candle[];
    } catch (err: any) {
        console.error(`Error fetching candles:`, err.message);
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

function calculateRSI(prices: number[], period: number = 14): number {
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

async function runBacktest() {
    try {
        kc.setAccessToken(accessToken);
        const spotToken = await getNiftySpotToken();
        if (!spotToken) {
            console.error("NIFTY Spot token not found");
            return;
        }

        const dates = getDecemberDates();
        const trades: Trade[] = [];

        for (const date of dates) {
            const dateStr = dayjs(date).format("YYYY-MM-DD");
            
            // Get RSI start time (previous working day 3:00 PM to now for warmup)
            let previousDay = new Date(date);
            previousDay.setDate(previousDay.getDate() - 1);
            while (previousDay.getDay() === 0 || previousDay.getDay() === 6) {
                previousDay.setDate(previousDay.getDate() - 1);
            }
            const from = new Date(previousDay.getTime());
            from.setHours(15, 0, 0, 0);
            
            const to = new Date(date);
            to.setHours(15, 30, 0, 0);

            const allCandles = await getHistoricalCandles(spotToken, from, to);
            if (allCandles.length === 0) continue;

            const candles = allCandles.filter(c => dayjs(c.date).format("YYYY-MM-DD") === dateStr);
            if (candles.length === 0) continue;

            // 1. Get spot at 9:19 AM
            const candle919 = candles.find(c => dayjs(c.date).format("HH:mm") === "09:19");
            if (!candle919) {
                console.log(`[${dateStr}] No 9:19 candle found`);
                continue;
            }

            const spot919 = candle919.close;
            const upperEdge = spot919 + 20;
            const lowerEdge = spot919 - 20;
            
            let position: { type: "BUY" | "SELL"; entryPrice: number; entryTime: string } | null = null;

            // 2. Start checking from 9:20 AM onwards
            const sessionCandles = candles.filter(c => dayjs(c.date).isAfter(dayjs(candle919.date)));

            for (const candle of sessionCandles) {
                const currentTime = dayjs(candle.date).format("HH:mm");
                
                // Calculate current RSI
                const candleIdxInAll = allCandles.findIndex(c => c.date === candle.date);
                const rsiPrices = allCandles.slice(0, candleIdxInAll + 1).map(c => c.close);
                const currentRsi = calculateRSI(rsiPrices);

                if (!position) {
                    // Entry Logic: Breakout + RSI check
                    if (candle.close > upperEdge && currentRsi > 70) {
                        position = { type: "BUY", entryPrice: candle.close, entryTime: currentTime };
                    } else if (candle.close < lowerEdge && currentRsi < 30) {
                        position = { type: "SELL", entryPrice: candle.close, entryTime: currentTime };
                    }
                } else {
                    // Exit Logic
                    const isSessionEnd = currentTime === "15:25" || currentTime === "15:26" || currentTime === "15:27" || currentTime === "15:28" || currentTime === "15:29" || currentTime === "15:30";
                    
                    let shouldExit = false;
                    let exitReason = "";

                    if (position.type === "BUY") {
                        if (candle.close < spot919) {
                            shouldExit = true;
                            exitReason = "Stop Loss (Close < 9:19 Spot)";
                        }
                    } else if (position.type === "SELL") {
                        if (candle.close > spot919) {
                            shouldExit = true;
                            exitReason = "Stop Loss (Close > 9:19 Spot)";
                        }
                    }

                    if (isSessionEnd && !shouldExit) {
                        shouldExit = true;
                        exitReason = "Session End";
                    }

                    if (shouldExit) {
                        const pnl = position.type === "BUY" ? candle.close - position.entryPrice : position.entryPrice - candle.close;
                        trades.push({
                            date: dateStr,
                            entryTime: position.entryTime,
                            exitTime: currentTime,
                            type: position.type,
                            entryPrice: position.entryPrice,
                            exitPrice: candle.close,
                            pnl: pnl,
                            reason: exitReason
                        });
                        position = null;
                        // Removed break to allow multiple trades per day
                    }
                }
            }
            
            // Log daily result
            const dailyTrades = trades.filter(t => t.date === dateStr);
            const dailyPnl = dailyTrades.reduce((sum, t) => sum + t.pnl, 0);
            if (dailyTrades.length > 0) {
                console.log(`✅ ${dateStr}: Spot919=${spot919.toFixed(2)}, Range=[${lowerEdge.toFixed(2)}-${upperEdge.toFixed(2)}], P&L=${dailyPnl.toFixed(2)}`);
            } else {
                console.log(`⚪ ${dateStr}: No breakout detected`);
            }
            
            // Delay to avoid rate limiting
            await new Promise(r => setTimeout(r, 500));
        }

        // Summary
        console.log(`\n${"=".repeat(50)}`);
        console.log(`Summary for December 2025`);
        console.log(`${"=".repeat(50)}`);
        const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
        const winTrades = trades.filter(t => t.pnl > 0).length;
        console.log(`Total Trades: ${trades.length}`);
        console.log(`Wins: ${winTrades}, Losses: ${trades.length - winTrades}`);
        console.log(`Total Nifty Points: ${totalPnl.toFixed(2)}`);
        
        // Save to CSV
        const csvHeader = "Date,Type,Entry Time,Entry Price,Exit Time,Exit Price,P&L,Reason\n";
        const csvRows = trades.map(t => `${t.date},${t.type},${t.entryTime},${t.entryPrice},${t.exitTime},${t.exitPrice},${t.pnl.toFixed(2)},${t.reason}`);
        await writeFile("nifty_rectangle_results.csv", csvHeader + csvRows.join("\n"));
        console.log(`\n📁 Results saved to nifty_rectangle_results.csv`);

    } catch (err: any) {
        console.error("Fatal error:", err.message);
    }
}

runBacktest();

