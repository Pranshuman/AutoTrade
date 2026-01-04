/**
 * Zerodha Kite Connect Authentication Flow
 * 
 * This script helps you get your access token for Zerodha Kite API
 * 
 * Steps:
 * 1. Run this script: bun run kite_auth_flow.ts
 * 2. Copy the login URL that's printed
 * 3. Open it in your browser and login to Zerodha
 * 4. After login, you'll be redirected to a URL with ?request_token=...
 * 5. Copy the request_token value from the URL
 * 6. Paste it when prompted by this script
 * 7. The script will generate your access token
 */

import { KiteConnect } from "kiteconnect";
import { readFileSync, writeFileSync } from "fs";
import * as readline from "readline";

// Your Zerodha API credentials (from Kite Connect app settings)
const apiKey = "gssli7u395tn5in8";
const apiSecret = "yeq4xu913i50u2d5j5b0wkgqp6cp0ufo";

const kc = new KiteConnect({ api_key: apiKey });

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  console.log("\n🔐 Zerodha Kite Connect Access Token Generator\n");
  console.log("=" .repeat(60));
  
  // Step 1: Generate login URL
  const loginURL = kc.getLoginURL();
  console.log("\n📋 Step 1: Login to Zerodha");
  console.log("Open this URL in your browser:");
  console.log(`\n${loginURL}\n`);
  console.log("After logging in, you'll be redirected to a URL like:");
  console.log("https://your-redirect-url.com/?request_token=XXXXX&action=login&status=success\n");
  
  // Step 2: Get request token from user
  const requestToken = await question("📝 Step 2: Paste the request_token from the redirect URL: ");
  
  if (!requestToken || requestToken.trim() === "") {
    console.error("❌ Request token is required!");
    rl.close();
    process.exit(1);
  }
  
  console.log("\n⏳ Generating access token...\n");
  
  try {
    // Step 3: Generate session (exchange request token for access token)
    const response = await kc.generateSession(requestToken.trim(), apiSecret);
    
    if (!response || !response.access_token) {
      throw new Error("Failed to generate access token");
    }
    
    const accessToken = response.access_token;
    
    console.log("✅ Success! Your access token has been generated.\n");
    console.log("=" .repeat(60));
    console.log("\n📋 Your Credentials:\n");
    console.log(`API Key: ${apiKey}`);
    console.log(`API Secret: ${apiSecret}`);
    console.log(`Access Token: ${accessToken}\n`);
    console.log("=" .repeat(60));
    
    // Step 4: Verify the token works
    kc.setAccessToken(accessToken);
    try {
      const profile = await kc.getProfile();
      console.log("\n✅ Token verified! Your profile:");
      console.log(`   Name: ${profile.user_name}`);
      console.log(`   Email: ${profile.email}`);
      console.log(`   User ID: ${profile.user_id}\n`);
    } catch (err: any) {
      console.warn("⚠️  Could not verify token:", err.message);
    }
    
    // Step 5: Save to file (optional)
    const save = await question("\n💾 Save credentials to .env file? (y/n): ");
    if (save.toLowerCase() === 'y') {
      const envContent = `KITE_API_KEY=${apiKey}
KITE_API_SECRET=${apiSecret}
KITE_ACCESS_TOKEN=${accessToken}
`;
      writeFileSync(".env", envContent);
      console.log("✅ Credentials saved to .env file");
    }
    
    console.log("\n📝 Next Steps:");
    console.log("1. Copy these credentials");
    console.log("2. Go to your Vercel frontend: https://autotrade1234.vercel.app");
    console.log("3. Register/Login to your account");
    console.log("4. Enter these credentials in the dashboard");
    console.log("5. Start your trading strategy!\n");
    
    console.log("⚠️  Note: Access tokens expire daily. You'll need to regenerate them.");
    console.log("   Run this script again when your token expires.\n");
    
  } catch (err: any) {
    console.error("\n❌ Error generating access token:");
    console.error(err.message);
    if (err.message.includes("Invalid request token")) {
      console.error("\n💡 Tip: Make sure you copied the request_token correctly from the redirect URL");
    }
  } finally {
    rl.close();
  }
}

main();

