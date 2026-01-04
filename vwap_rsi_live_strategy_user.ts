/**
 * User-specific strategy runner
 * This file is spawned by the server with user credentials from environment variables
 * It reads the original strategy file and patches it to use environment variables
 */

import { readFileSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { join } from "path";

const userId = process.argv[2];
const apiKey = process.env.KITE_API_KEY;
const apiSecret = process.env.KITE_API_SECRET;
const accessToken = process.env.KITE_ACCESS_TOKEN;

if (!apiKey || !apiSecret || !accessToken) {
    console.error("❌ Missing required environment variables");
    process.exit(1);
}

// Read the original strategy file
const strategyPath = join(process.cwd(), "vwap_rsi_live_strategy.ts");
const originalCode = readFileSync(strategyPath, "utf-8");

// Replace hardcoded credentials with environment variables
const modifiedCode = originalCode
    .replace(
        /const apiKey = ".*?";/,
        `const apiKey = process.env.KITE_API_KEY || "";`
    )
    .replace(
        /const apiSecret = ".*?";/,
        `const apiSecret = process.env.KITE_API_SECRET || "";`
    )
    .replace(
        /const accessToken = ".*?";/,
        `const accessToken = process.env.KITE_ACCESS_TOKEN || "";`
    )
    .replace(
        /const kc = new KiteConnect\(\{ api_key: apiKey \}\);/,
        `if (!apiKey || !apiSecret || !accessToken) {
    console.error("❌ Missing credentials");
    process.exit(1);
}
const kc = new KiteConnect({ api_key: apiKey });`
    );

// Write modified file to a temp location
const tempPath = join(process.cwd(), `vwap_rsi_live_strategy_user_${userId}.ts`);
writeFileSync(tempPath, modifiedCode);

// Execute the modified strategy
console.log(`🚀 Starting VWAP RSI Strategy for User ${userId}`);

const child = spawn("bun", ["run", tempPath], {
    stdio: "inherit",
    env: {
        ...process.env,
        KITE_API_KEY: apiKey,
        KITE_API_SECRET: apiSecret,
        KITE_ACCESS_TOKEN: accessToken,
    },
});

child.on("exit", (code) => {
    // Clean up temp file
    try {
        require("fs").unlinkSync(tempPath);
    } catch {}
    process.exit(code || 0);
});

process.on("SIGTERM", () => {
    child.kill("SIGTERM");
});
process.on("SIGINT", () => {
    child.kill("SIGINT");
});

