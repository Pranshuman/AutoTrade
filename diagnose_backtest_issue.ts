import { KiteConnect } from "kiteconnect";
import dayjs from "dayjs";

// API Credentials
const apiKey = "gssli7u395tn5in8";
const apiSecret = "yeq4xu913i50u2d5j5b0wkgqp6cp0ufo";
const accessToken = "pCSTgs0y86yKMw0mSDCEpmnnKaW9YdtA";
const kc = new KiteConnect({ api_key: apiKey });

type Candle = {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};

async function getHistoricalCandles(instrumentToken: number, from: Date, to: Date): Promise<Candle[]> {
    try {
        const candles = await kc.getHistoricalData(instrumentToken, "minute", from, to, false);
        return candles as unknown as Candle[];
    } catch (err: any) {
        console.error(`Error fetching candles for token ${instrumentToken}:`, err);
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

async function main() {
    try {
        kc.setAccessToken(accessToken);
        
        const backtestDate = new Date(2025, 11, 9); // December 9, 2025
        console.log(`\n${"=".repeat(80)}`);
        console.log(`DIAGNOSING BACKTEST ISSUE FOR DECEMBER 9, 2025`);
        console.log(`${"=".repeat(80)}\n`);
        
        // Get instruments
        const instruments = await kc.getInstruments("NFO");
        
        // Find December 23rd expiry
        const year = backtestDate.getFullYear();
        const dec23Expiry = instruments
            .filter(inst => {
                if (inst.name !== "NIFTY" || inst.instrument_type !== "CE") return false;
                const expiry = new Date(inst.expiry);
                return expiry.getFullYear() === year && 
                       expiry.getMonth() === 11 && 
                       expiry.getDate() === 23;
            })
            .map(inst => new Date(inst.expiry).getTime())
            .filter((ts, index, self) => self.indexOf(ts) === index)
            .sort((a, b) => a - b);
        
        if (dec23Expiry.length === 0) {
            console.error("❌ No December 23rd expiry found");
            return;
        }
        
        const expiry = new Date(dec23Expiry[0]);
        const expiryTs = expiry.getTime();
        
        // Get spot price at 9:20 AM
        const spotToken = await getNiftySpotToken();
        if (!spotToken) {
            console.error("❌ Could not find NIFTY spot token");
            return;
        }
        
        const entryCutoff = new Date(backtestDate);
        entryCutoff.setHours(9, 20, 0, 0);
        const fromTime = new Date(entryCutoff.getTime() - 10 * 60 * 1000);
        const toTime = new Date(entryCutoff.getTime() + 30 * 60 * 1000);
        
        const spotCandles = await getHistoricalCandles(spotToken, fromTime, toTime);
        const cutoffCandle = spotCandles.find(candle => {
            const ts = new Date(candle.date).getTime();
            return ts >= entryCutoff.getTime() && ts < entryCutoff.getTime() + 60000;
        }) || spotCandles[spotCandles.length - 1];
        
        const spotPrice = cutoffCandle.close;
        const atmStrike = Math.round(spotPrice / 50) * 50;
        const peStrike = atmStrike + 150;
        const ceStrike = atmStrike - 150;
        
        console.log(`Spot at 9:20 AM: ${spotPrice.toFixed(2)}`);
        console.log(`Strikes: CE=${ceStrike}, PE=${peStrike}\n`);
        
        // Find instruments
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
            console.error(`❌ Could not find instruments`);
            return;
        }
        
        const ceToken = Number(ce.instrument_token);
        const peToken = Number(pe.instrument_token);
        
        console.log(`CE: ${ce.tradingsymbol} (Token: ${ceToken})`);
        console.log(`PE: ${pe.tradingsymbol} (Token: ${peToken})\n`);
        
        // Get session times
        const sessionStart = new Date(backtestDate);
        sessionStart.setHours(9, 15, 0, 0);
        const sessionEnd = new Date(backtestDate);
        sessionEnd.setHours(15, 20, 0, 0);
        
        // Get previous day for RSI
        let previousDay = new Date(backtestDate);
        previousDay.setDate(previousDay.getDate() - 1);
        while (previousDay.getDay() === 0 || previousDay.getDay() === 6) {
            previousDay.setDate(previousDay.getDate() - 1);
        }
        const rsiStartTime = new Date(previousDay.getTime() + 9 * 60 * 60 * 1000 + 15 * 60 * 1000);
        
        // Fetch candles
        const ceCandles = await getHistoricalCandles(ceToken, rsiStartTime, sessionEnd);
        const peCandles = await getHistoricalCandles(peToken, rsiStartTime, sessionEnd);
        
        console.log(`Total CE Candles: ${ceCandles.length}`);
        console.log(`Total PE Candles: ${peCandles.length}\n`);
        
        // Filter to session
        const sessionStartTs = sessionStart.getTime();
        const sessionCeCandles = ceCandles.filter(c => new Date(c.date).getTime() >= sessionStartTs);
        const sessionPeCandles = peCandles.filter(c => new Date(c.date).getTime() >= sessionStartTs);
        
        console.log(`Session CE Candles: ${sessionCeCandles.length}`);
        console.log(`Session PE Candles: ${sessionPeCandles.length}\n`);
        
        // Check alignment - this is the key issue!
        console.log(`${"=".repeat(80)}`);
        console.log(`CHECKING CANDLE ALIGNMENT (9:20 - 9:30)`);
        console.log(`${"=".repeat(80)}\n`);
        
        const entryCutoffTs = entryCutoff.getTime();
        const checkEnd = new Date(backtestDate);
        checkEnd.setHours(9, 30, 0, 0);
        const checkEndTs = checkEnd.getTime();
        
        const ceCheckCandles = sessionCeCandles.filter(c => {
            const ts = new Date(c.date).getTime();
            return ts >= entryCutoffTs && ts <= checkEndTs;
        });
        
        const peCheckCandles = sessionPeCandles.filter(c => {
            const ts = new Date(c.date).getTime();
            return ts >= entryCutoffTs && ts <= checkEndTs;
        });
        
        console.log(`CE candles (9:20-9:30): ${ceCheckCandles.length}`);
        console.log(`PE candles (9:20-9:30): ${peCheckCandles.length}\n`);
        
        // Create maps by timestamp
        const ceMap = new Map<number, Candle>();
        const peMap = new Map<number, Candle>();
        
        ceCheckCandles.forEach(c => {
            const ts = new Date(c.date).getTime();
            ceMap.set(ts, c);
        });
        
        peCheckCandles.forEach(c => {
            const ts = new Date(c.date).getTime();
            peMap.set(ts, c);
        });
        
        // Check if they're aligned by index (as backtest does)
        console.log(`Checking alignment by INDEX (as backtest does):\n`);
        for (let i = 0; i < Math.min(ceCheckCandles.length, peCheckCandles.length); i++) {
            const ceC = ceCheckCandles[i];
            const peC = peCheckCandles[i];
            const ceTime = new Date(ceC.date);
            const peTime = new Date(peC.date);
            const timeDiff = Math.abs(ceTime.getTime() - peTime.getTime());
            
            if (timeDiff > 60000) {
                console.log(`⚠️  MISALIGNMENT at index ${i}:`);
                console.log(`   CE: ${dayjs(ceTime).format("HH:mm:ss")} @ ${ceC.close.toFixed(2)}`);
                console.log(`   PE: ${dayjs(peTime).format("HH:mm:ss")} @ ${peC.close.toFixed(2)}`);
                console.log(`   Time diff: ${timeDiff / 1000} seconds\n`);
            }
        }
        
        // Check alignment by timestamp (correct way)
        console.log(`\nChecking alignment by TIMESTAMP (correct way):\n`);
        const allTimestamps = new Set([...ceMap.keys(), ...peMap.keys()]);
        const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);
        
        let misaligned = 0;
        for (const ts of sortedTimestamps) {
            const ceC = ceMap.get(ts);
            const peC = peMap.get(ts);
            
            if (!ceC || !peC) {
                misaligned++;
                const timeStr = dayjs(ts).format("HH:mm:ss");
                if (!ceC) {
                    console.log(`⚠️  Missing CE candle at ${timeStr}, PE has: ${peC.close.toFixed(2)}`);
                }
                if (!peC) {
                    console.log(`⚠️  Missing PE candle at ${timeStr}, CE has: ${ceC?.close.toFixed(2) || 'N/A'}`);
                }
            }
        }
        
        if (misaligned === 0) {
            console.log(`✅ All candles are properly aligned by timestamp`);
        } else {
            console.log(`\n❌ Found ${misaligned} misaligned timestamps`);
        }
        
        // Show what backtest would see
        console.log(`\n${"=".repeat(80)}`);
        console.log(`WHAT BACKTEST SEES (using index-based alignment)`);
        console.log(`${"=".repeat(80)}\n`);
        
        for (let i = 0; i < Math.min(10, ceCheckCandles.length, peCheckCandles.length); i++) {
            const ceC = ceCheckCandles[i];
            const peC = peCheckCandles[i];
            const ceTime = dayjs(ceC.date).format("HH:mm:ss");
            const peTime = dayjs(peC.date).format("HH:mm:ss");
            
            console.log(`Index ${i}: CE[${ceTime}]=${ceC.close.toFixed(2)}, PE[${peTime}]=${peC.close.toFixed(2)}`);
        }
        
    } catch (err: any) {
        console.error("Error:", err);
    }
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});



