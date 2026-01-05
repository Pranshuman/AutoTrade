/**
 * Backend API Server for AutoTrade with Supabase
 * Handles user authentication, credential management, and strategy control
 */

import { createClient } from "@supabase/supabase-js";
import { KiteConnect } from "kiteconnect";
import { serve } from "bun";
import { join } from "path";
import { readFile } from "fs/promises";

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_ANON_KEY || "";

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Missing Supabase credentials. Please set SUPABASE_URL and SUPABASE_ANON_KEY environment variables.");
  console.error("   Falling back to SQLite for local development...");
}

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Fallback to SQLite for local development
let sqliteDb: any = null;
if (!supabase) {
  try {
    const { Database } = require("bun:sqlite");
    sqliteDb = new Database("autotrade.db");
    
    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        api_key TEXT NOT NULL,
        api_secret TEXT NOT NULL,
        access_token TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    
    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS strategy_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at DATETIME,
        stopped_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    
    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        access_token TEXT NOT NULL,
        session_date DATE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, session_date)
      )
    `);
    
    console.log("✅ SQLite database initialized (fallback mode)");
  } catch (err) {
    console.error("❌ Failed to initialize SQLite:", err);
  }
} else {
  console.log("✅ Supabase client initialized");
}

// Simple password hashing
function hashPassword(password: string): string {
  return Bun.password.hashSync(password);
}

function verifyPassword(password: string, hash: string): boolean {
  return Bun.password.verifySync(password, hash);
}

// JWT-like token generation (simple version)
function generateToken(userId: number, username: string): string {
  const payload = { userId, username, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }; // 7 days
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function verifyToken(token: string): { userId: number; username: string } | null {
  try {
    const payload = JSON.parse(Buffer.from(token, "base64url").toString());
    if (payload.exp && payload.exp < Date.now()) return null;
    return { userId: payload.userId, username: payload.username };
  } catch {
    return null;
  }
}

// Get today's date in IST (YYYY-MM-DD format)
// IST is UTC+5:30, so we add 5.5 hours to UTC time to get IST
function getTodayIST(): string {
  const now = new Date(); // Current UTC time
  // IST offset: UTC+5:30 = 5.5 hours = 19,800,000 milliseconds
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  // Add IST offset to get IST time representation
  const istTimestamp = now.getTime() + istOffsetMs;
  const istDate = new Date(istTimestamp);
  // Extract date components (using UTC methods since Date is always UTC internally)
  // This gives us the date in IST timezone
  const year = istDate.getUTCFullYear();
  const month = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(istDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Check if user has valid access token for today
async function hasValidAccessTokenToday(userId: number): Promise<{ hasToken: boolean; accessToken?: string }> {
  const today = getTodayIST();
  
  try {
    if (supabase) {
      const { data, error } = await supabase
        .from("sessions")
        .select("access_token")
        .eq("user_id", userId)
        .eq("session_date", today)
        .single();
      
      if (error || !data) {
        return { hasToken: false };
      }
      
      // Verify token is still valid by trying to use it
      try {
        // Get user's API key from credentials
        const { data: creds } = await supabase
          .from("credentials")
          .select("api_key")
          .eq("user_id", userId)
          .single();
        
        if (creds && creds.api_key) {
          const kc = new KiteConnect({ api_key: creds.api_key });
          kc.setAccessToken(data.access_token);
          await kc.getProfile(); // This will throw if token is invalid
          return { hasToken: true, accessToken: data.access_token };
        }
      } catch (err) {
        // Token is invalid, remove it
        await supabase
          .from("sessions")
          .delete()
          .eq("user_id", userId)
          .eq("session_date", today);
        return { hasToken: false };
      }
      
      return { hasToken: true, accessToken: data.access_token };
    } else {
      // SQLite fallback
      const session = sqliteDb.query("SELECT access_token FROM sessions WHERE user_id = ? AND session_date = ?").get(userId, today) as any;
      
      if (!session) {
        return { hasToken: false };
      }
      
      // Verify token is still valid
      try {
        const creds = sqliteDb.query("SELECT api_key FROM credentials WHERE user_id = ?").get(userId) as any;
        if (creds && creds.api_key) {
          const kc = new KiteConnect({ api_key: creds.api_key });
          kc.setAccessToken(session.access_token);
          await kc.getProfile();
          return { hasToken: true, accessToken: session.access_token };
        }
      } catch (err) {
        // Token is invalid, remove it
        sqliteDb.run("DELETE FROM sessions WHERE user_id = ? AND session_date = ?", userId, today);
        return { hasToken: false };
      }
      
      return { hasToken: true, accessToken: session.access_token };
    }
  } catch (err) {
    console.error("Error checking access token:", err);
    return { hasToken: false };
  }
}

// Active strategy instances per user
const activeStrategies = new Map<number, { process: any; status: string }>();

// Track strategy data per user (positions, trades, prices)
interface StrategyTracker {
  positions: {
    ce?: { isOpen: boolean; entryPrice: number; entryTime: string; currentPrice?: number; pnl?: number };
    pe?: { isOpen: boolean; entryPrice: number; entryTime: string; currentPrice?: number; pnl?: number };
  };
  prices: {
    cePrice?: number;
    pePrice?: number;
    spotPrice?: number;
    ceVwap?: number;
    peVwap?: number;
    lastUpdate?: string;
  };
  recentTrades: Array<{
    timestamp: string;
    instrument: string;
    action: string;
    price: number;
    quantity: number;
    pnl?: number;
    reason: string;
  }>;
  summary: {
    totalTrades: number;
    totalPnL: number;
    winRate: number;
    startedAt?: string;
  };
}

const strategyTrackers = new Map<number, StrategyTracker>();

// Initialize tracker for user
function initTracker(userId: number) {
  strategyTrackers.set(userId, {
    positions: {},
    prices: {},
    recentTrades: [],
    summary: { totalTrades: 0, totalPnL: 0, winRate: 0 }
  });
}

// Serve static files
async function serveStaticFile(path: string): Promise<Response | null> {
  try {
    const filePath = join(process.cwd(), path === "/" ? "index.html" : path);
    const file = await readFile(filePath);
    
    // Determine content type based on file extension
    let ext = path.split(".").pop()?.toLowerCase();
    // If path is "/", it's index.html
    if (path === "/" || path === "/index.html") {
      ext = "html";
    }
    
    const contentType: Record<string, string> = {
      html: "text/html",
      css: "text/css",
      js: "application/javascript",
      json: "application/json",
    };
    
    return new Response(file, {
      headers: { "Content-Type": contentType[ext || ""] || "text/plain" },
    });
  } catch {
    return null;
  }
}

// API routes
// Railway requires binding to 0.0.0.0, not localhost
const server = serve({
  hostname: "0.0.0.0", // Required for Railway - binds to all interfaces
  port: process.env.PORT || 3000,
  error(error) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  },
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const origin = req.headers.get("origin");
    const userAgent = req.headers.get("user-agent") || "unknown";
    
    // Log all incoming requests for debugging
    console.log(`\n[${new Date().toISOString()}] ${method} ${path}`);
    console.log(`  Origin: ${origin || "none"}`);
    console.log(`  User-Agent: ${userAgent.substring(0, 50)}`);
    console.log(`  All Request Headers:`, Object.fromEntries(req.headers.entries()));

    // CORS headers - Handle Railway proxy by explicitly setting headers
    // Railway's proxy might add headers, so we need to be explicit
    const corsHeaders: Record<string, string> = {};
    
    // Set origin - use the actual request origin to avoid Railway proxy issues
    if (origin) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
      console.log(`  ✅ Setting CORS origin to: ${origin}`);
    } else {
      corsHeaders["Access-Control-Allow-Origin"] = "*";
      console.log(`  ⚠️  No origin header, setting CORS to: *`);
    }
    
    corsHeaders["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    corsHeaders["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Requested-With";
    corsHeaders["Access-Control-Allow-Credentials"] = "true";
    corsHeaders["Access-Control-Max-Age"] = "86400";
    
    console.log(`  CORS Headers we're setting:`, corsHeaders);

    // Handle preflight OPTIONS request
    if (method === "OPTIONS") {
      console.log(`  🔵 Handling OPTIONS preflight request`);
      const response = new Response(null, { 
        status: 204,
        headers: {
          ...corsHeaders,
          "Content-Length": "0",
        }
      });
      console.log(`  📤 OPTIONS Response status: ${response.status}`);
      console.log(`  📤 OPTIONS Response headers:`, Object.fromEntries(response.headers.entries()));
      return response;
    }

    // Handle favicon request
    if (path === "/favicon.ico") {
      // Return a simple SVG favicon to prevent 404
      const svgFavicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📈</text></svg>`;
      return new Response(svgFavicon, {
        headers: { "Content-Type": "image/svg+xml" },
      });
    }

    // Static files
    if (path === "/" || path.startsWith("/static/") || path.endsWith(".html") || path.endsWith(".css") || path.endsWith(".js")) {
      const staticFile = await serveStaticFile(path);
      if (staticFile) return staticFile;
    }

    // API routes
    if (path.startsWith("/api/")) {
      const authHeader = req.headers.get("Authorization");
      let user: { userId: number; username: string } | null = null;

      // Parse auth token
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        user = verifyToken(token);
      }

      // Public routes
      if (path === "/api/register" && method === "POST") {
        console.log(`  📝 POST /api/register - Processing registration`);
        const body = await req.json();
        const { username, password, apiKey, apiSecret } = body;
        console.log(`  📝 Registration attempt for username: ${username}`);

        if (!username || !password) {
          return new Response(JSON.stringify({ error: "Username and password required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        if (!apiKey || !apiSecret) {
          return new Response(JSON.stringify({ error: "API Key and API Secret are required for registration" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        if (!username || !password) {
          return new Response(JSON.stringify({ error: "Username and password required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        try {
          const passwordHash = hashPassword(password);
          
          if (supabase) {
            // Use Supabase
            const { data, error } = await supabase
              .from("users")
              .insert({ username, password_hash: passwordHash })
              .select("id, username")
              .single();
            
            if (error) {
              if (error.code === "23505") { // Unique constraint violation
                return new Response(JSON.stringify({ error: "Username already exists" }), {
                  status: 400,
                  headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
              }
              throw error;
            }
            
            const token = generateToken(data.id, data.username);
            
            // Generate Kite login URL using user's API key
            const kc = new KiteConnect({ api_key: apiKey });
            const loginURL = kc.getLoginURL();
            
            const response = new Response(JSON.stringify({ 
              token, 
              user: { id: data.id, username: data.username },
              loginURL // Return login URL for the next step
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
            console.log(`  ✅ Registration successful for: ${data.username}`);
            console.log(`  🔗 Generated Kite login URL`);
            return response;
          } else {
            // Fallback to SQLite
            const result = sqliteDb.query("INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id, username").get(username, passwordHash) as any;
            if (!result) {
              return new Response(JSON.stringify({ error: "Failed to create user" }), {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            const token = generateToken(result.id, result.username);
            
            // Generate Kite login URL using user's API key
            const kc = new KiteConnect({ api_key: apiKey });
            const loginURL = kc.getLoginURL();
            
            return new Response(JSON.stringify({ 
              token, 
              user: { id: result.id, username: result.username },
              loginURL
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        } catch (err: any) {
          if (err.message?.includes("UNIQUE") || err.code === "23505") {
            return new Response(JSON.stringify({ error: "Username already exists" }), {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ error: err.message || "Registration failed" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      if (path === "/api/login" && method === "POST") {
        console.log(`  🔐 POST /api/login - Processing login`);
        const body = await req.json();
        const { username, password } = body;
        console.log(`  🔐 Login attempt for username: ${username}`);

        try {
          let userData: any = null;
          
          if (supabase) {
            // Use Supabase
            const { data, error } = await supabase
              .from("users")
              .select("id, username, password_hash")
              .eq("username", username)
              .single();
            
            if (error || !data) {
              return new Response(JSON.stringify({ error: "Invalid credentials" }), {
                status: 401,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            userData = data;
          } else {
            // Fallback to SQLite
            userData = sqliteDb.query("SELECT id, username, password_hash FROM users WHERE username = ?").get(username) as any;
          }
          
          if (!userData || !verifyPassword(password, userData.password_hash)) {
            return new Response(JSON.stringify({ error: "Invalid credentials" }), {
              status: 401,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          // Check if user has API credentials
          let creds: any = null;
          if (supabase) {
            const { data } = await supabase
              .from("credentials")
              .select("api_key, api_secret")
              .eq("user_id", userData.id)
              .single();
            creds = data;
          } else {
            creds = sqliteDb.query("SELECT api_key, api_secret FROM credentials WHERE user_id = ?").get(userData.id) as any;
          }

          if (!creds || !creds.api_key || !creds.api_secret) {
            return new Response(JSON.stringify({ 
              error: "API credentials not found. Please register with API key and secret.",
              needsCredentials: true
            }), {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          // Check if user has valid access token for today
          const tokenCheck = await hasValidAccessTokenToday(userData.id);
          
          const token = generateToken(userData.id, userData.username);
          
          // If no valid token, return login URL for Kite authentication
          if (!tokenCheck.hasToken) {
            const kc = new KiteConnect({ api_key: creds.api_key });
            const loginURL = kc.getLoginURL();
            
            const response = new Response(JSON.stringify({ 
              token, 
              user: { id: userData.id, username: userData.username },
              needsAuth: true,
              loginURL
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
            console.log(`  ✅ Login successful for: ${userData.username} (needs Kite auth)`);
            return response;
          }

          const response = new Response(JSON.stringify({ 
            token, 
            user: { id: userData.id, username: userData.username },
            needsAuth: false
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
          console.log(`  ✅ Login successful for: ${userData.username}`);
          console.log(`  📤 Response status: ${response.status}`);
          console.log(`  📤 Response headers:`, Object.fromEntries(response.headers.entries()));
          return response;
        } catch (err: any) {
          return new Response(JSON.stringify({ error: "Login failed" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // Protected routes - Get Kite login URL
      if (path === "/api/kite-login-url" && method === "GET") {
        if (!user) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        try {
          // Get user's API key from credentials
          let creds: any = null;
          if (supabase) {
            const { data, error } = await supabase
              .from("credentials")
              .select("api_key")
              .eq("user_id", user.userId)
              .single();
            
            if (error || !data) {
              return new Response(JSON.stringify({ error: "API credentials not found" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            creds = data;
          } else {
            creds = sqliteDb.query("SELECT api_key FROM credentials WHERE user_id = ?").get(user.userId) as any;
            if (!creds) {
              return new Response(JSON.stringify({ error: "API credentials not found" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
          }

          const kc = new KiteConnect({ api_key: creds.api_key });
          const loginURL = kc.getLoginURL();

          return new Response(JSON.stringify({ loginURL }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: "Failed to generate login URL" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // Protected routes - Generate access token from request token
      if (path === "/api/generate-access-token" && method === "POST") {
        // This endpoint requires authentication
        if (!user) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const body = await req.json();
        const { requestToken, apiKey, apiSecret } = body;

        if (!requestToken || !apiKey || !apiSecret) {
          return new Response(JSON.stringify({ error: "Request token, API key, and API secret are required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        try {
          console.log(`  🔐 Generating access token for user: ${user.userId}`);
          const kc = new KiteConnect({ api_key: apiKey });
          const session = await kc.generateSession(requestToken, apiSecret);
          
          if (!session || !session.access_token) {
            throw new Error("Failed to generate access token");
          }

          const accessToken = session.access_token;
          
          // Verify the token works
          kc.setAccessToken(accessToken);
          const profile = await kc.getProfile();
          
          console.log(`  ✅ Access token generated and verified for: ${profile.user_name}`);
          
          const today = getTodayIST();
          
          // Save API key and secret to credentials table (if not already there)
          if (supabase) {
            // Check if credentials exist
            const { data: existing } = await supabase
              .from("credentials")
              .select("id")
              .eq("user_id", user.userId)
              .single();
            
            if (existing) {
              await supabase
                .from("credentials")
                .update({ 
                  api_key: apiKey, 
                  api_secret: apiSecret,
                  updated_at: new Date().toISOString()
                })
                .eq("user_id", user.userId);
            } else {
              await supabase
                .from("credentials")
                .insert({ 
                  user_id: user.userId,
                  api_key: apiKey, 
                  api_secret: apiSecret,
                  access_token: accessToken // Keep for backward compatibility
                });
            }
            
            // Store access token in sessions table for today
            await supabase
              .from("sessions")
              .upsert({
                user_id: user.userId,
                access_token: accessToken,
                session_date: today,
                created_at: new Date().toISOString()
              }, {
                onConflict: "user_id,session_date"
              });
          } else {
            // SQLite fallback
            const existing = sqliteDb.query("SELECT id FROM credentials WHERE user_id = ?").get(user.userId) as any;
            if (existing) {
              sqliteDb.run("UPDATE credentials SET api_key = ?, api_secret = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?", 
                apiKey, apiSecret, user.userId);
            } else {
              sqliteDb.run("INSERT INTO credentials (user_id, api_key, api_secret, access_token) VALUES (?, ?, ?, ?)", 
                user.userId, apiKey, apiSecret, accessToken);
            }
            
            // Store access token in sessions table for today
            sqliteDb.run(`
              INSERT OR REPLACE INTO sessions (user_id, access_token, session_date, created_at)
              VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `, user.userId, accessToken, today);
          }

          return new Response(JSON.stringify({ 
            success: true, 
            message: "Access token generated and saved successfully",
            profile: {
              userName: profile.user_name,
              email: profile.email,
              userId: profile.user_id
            }
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: any) {
          console.error(`  ❌ Error generating access token: ${err.message}`);
          return new Response(JSON.stringify({ 
            error: "Failed to generate access token", 
            details: err.message 
          }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // Protected routes
      if (!user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/api/credentials" && method === "GET") {
        try {
          let creds: any = null;
          const today = getTodayIST();
          
          if (supabase) {
            const { data, error } = await supabase
              .from("credentials")
              .select("api_key, api_secret, updated_at")
              .eq("user_id", user.userId)
              .single();
            
            if (error && error.code !== "PGRST116") { // PGRST116 = no rows returned
              throw error;
            }
            creds = data;
            
            // Get today's access token from sessions table
            if (creds) {
              const { data: session } = await supabase
                .from("sessions")
                .select("access_token")
                .eq("user_id", user.userId)
                .eq("session_date", today)
                .single();
              
              if (session) {
                creds.access_token = session.access_token;
              }
            }
          } else {
            creds = sqliteDb.query("SELECT api_key, api_secret, updated_at FROM credentials WHERE user_id = ?").get(user.userId) as any;
            
            // Get today's access token from sessions table
            if (creds) {
              const session = sqliteDb.query("SELECT access_token FROM sessions WHERE user_id = ? AND session_date = ?").get(user.userId, today) as any;
              if (session) {
                creds.access_token = session.access_token;
              }
            }
          }
          
          if (!creds) {
            return new Response(JSON.stringify({ credentials: null, tokenValid: false }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          // Check if token is valid and not expired
          let tokenValid = false;
          let tokenExpired = false;
          try {
            if (creds.access_token) {
              const kc = new KiteConnect({ api_key: creds.api_key });
              kc.setAccessToken(creds.access_token);
              await kc.getProfile(); // This will throw if token is invalid/expired
              tokenValid = true;
            } else {
              tokenExpired = true;
            }
          } catch (err: any) {
            tokenValid = false;
            tokenExpired = true;
          }
          
          return new Response(JSON.stringify({ 
            credentials: { 
              apiKey: creds.api_key, 
              apiSecret: creds.api_secret, 
              accessToken: creds.access_token || null, 
              updatedAt: creds.updated_at 
            },
            tokenValid,
            tokenExpired
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: "Failed to fetch credentials" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      if (path === "/api/credentials" && method === "POST") {
        const body = await req.json();
        const { apiKey, apiSecret, accessToken } = body;

        if (!apiKey || !apiSecret) {
          return new Response(JSON.stringify({ error: "API Key and API Secret are required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        try {
          const today = getTodayIST();
          
          if (supabase) {
            // Check if credentials exist
            const { data: existing } = await supabase
              .from("credentials")
              .select("id")
              .eq("user_id", user.userId)
              .single();
            
            if (existing) {
              // Update API key and secret only (access token is managed in sessions table)
              await supabase
                .from("credentials")
                .update({ 
                  api_key: apiKey, 
                  api_secret: apiSecret,
                  updated_at: new Date().toISOString()
                })
                .eq("user_id", user.userId);
            } else {
              // Insert (access token optional for backward compatibility)
              await supabase
                .from("credentials")
                .insert({ 
                  user_id: user.userId,
                  api_key: apiKey, 
                  api_secret: apiSecret,
                  access_token: accessToken || "" // Keep for backward compatibility
                });
            }
            
            // If access token is provided, also store it in sessions table
            if (accessToken) {
              await supabase
                .from("sessions")
                .upsert({
                  user_id: user.userId,
                  access_token: accessToken,
                  session_date: today,
                  created_at: new Date().toISOString()
                }, {
                  onConflict: "user_id,session_date"
                });
            }
          } else {
            // SQLite fallback
            const existing = sqliteDb.query("SELECT id FROM credentials WHERE user_id = ?").get(user.userId) as any;
            if (existing) {
              sqliteDb.run("UPDATE credentials SET api_key = ?, api_secret = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?", apiKey, apiSecret, user.userId);
            } else {
              sqliteDb.run("INSERT INTO credentials (user_id, api_key, api_secret, access_token) VALUES (?, ?, ?, ?)", user.userId, apiKey, apiSecret, accessToken || "");
            }
            
            // If access token is provided, also store it in sessions table
            if (accessToken) {
              sqliteDb.run(`
                INSERT OR REPLACE INTO sessions (user_id, access_token, session_date, created_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
              `, user.userId, accessToken, today);
            }
          }

          return new Response(JSON.stringify({ success: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: "Failed to save credentials" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      if (path === "/api/strategy/status" && method === "GET") {
        try {
          const strategy = activeStrategies.get(user.userId);
          let session: any = null;
          
          if (supabase) {
            const { data } = await supabase
              .from("strategy_sessions")
              .select("status, started_at, stopped_at")
              .eq("user_id", user.userId)
              .order("id", { ascending: false })
              .limit(1)
              .single();
            session = data;
          } else {
            session = sqliteDb.query("SELECT status, started_at, stopped_at FROM strategy_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(user.userId) as any;
          }
          
          return new Response(JSON.stringify({ 
            status: strategy?.status || session?.status || "stopped",
            startedAt: session?.started_at || null,
            stoppedAt: session?.stopped_at || null,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ 
            status: activeStrategies.get(user.userId)?.status || "stopped",
            startedAt: null,
            stoppedAt: null,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      if (path === "/api/strategy/start" && method === "POST") {
        try {
          // Check if credentials exist
          let creds: any = null;
          const today = getTodayIST();
          
          if (supabase) {
            const { data, error } = await supabase
              .from("credentials")
              .select("api_key, api_secret")
              .eq("user_id", user.userId)
              .single();
            
            if (error || !data) {
              return new Response(JSON.stringify({ error: "Please set your credentials first" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            creds = data;
            
            // Get today's access token from sessions table
            const { data: session } = await supabase
              .from("sessions")
              .select("access_token")
              .eq("user_id", user.userId)
              .eq("session_date", today)
              .single();
            
            if (!session || !session.access_token) {
              return new Response(JSON.stringify({ error: "Access token not found for today. Please authenticate with Zerodha Kite first." }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            
            creds.access_token = session.access_token;
          } else {
            creds = sqliteDb.query("SELECT api_key, api_secret FROM credentials WHERE user_id = ?").get(user.userId) as any;
            if (!creds) {
              return new Response(JSON.stringify({ error: "Please set your credentials first" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            
            // Get today's access token from sessions table
            const session = sqliteDb.query("SELECT access_token FROM sessions WHERE user_id = ? AND session_date = ?").get(user.userId, today) as any;
            if (!session || !session.access_token) {
              return new Response(JSON.stringify({ error: "Access token not found for today. Please authenticate with Zerodha Kite first." }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            
            creds.access_token = session.access_token;
          }

          // Check if already running
          if (activeStrategies.has(user.userId)) {
            return new Response(JSON.stringify({ error: "Strategy already running" }), {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          // Initialize tracker
          initTracker(user.userId);
          const tracker = strategyTrackers.get(user.userId)!;
          tracker.summary.startedAt = new Date().toISOString();

          // Start strategy in background with user credentials
          const strategyProcess = Bun.spawn(["bun", "run", "vwap_rsi_live_strategy.ts"], {
            env: {
              ...process.env,
              KITE_API_KEY: creds.api_key,
              KITE_API_SECRET: creds.api_secret,
              KITE_ACCESS_TOKEN: creds.access_token,
              USER_ID: String(user.userId), // Pass user ID for logging/tracking
            },
            stdout: "pipe",
            stderr: "pipe",
          });

          // Parse strategy output for tracking
          const outputBuffer: string[] = [];
          let bufferTimeout: any = null;

          const processOutput = (data: Buffer) => {
            const text = data.toString();
            outputBuffer.push(text);
            
            // Clear timeout and set new one (debounce)
            if (bufferTimeout) clearTimeout(bufferTimeout);
            bufferTimeout = setTimeout(() => {
              const fullText = outputBuffer.join("");
              parseStrategyOutput(fullText, user.userId);
              outputBuffer.length = 0; // Clear buffer
            }, 1000); // Process every second
          };

          strategyProcess.stdout.on("data", processOutput);
          strategyProcess.stderr.on("data", processOutput);

          activeStrategies.set(user.userId, { process: strategyProcess, status: "running" });
          
          // Save session
          if (supabase) {
            await supabase
              .from("strategy_sessions")
              .insert({ 
                user_id: user.userId, 
                status: "running", 
                started_at: new Date().toISOString() 
              });
          } else {
            sqliteDb.run("INSERT INTO strategy_sessions (user_id, status, started_at) VALUES (?, ?, CURRENT_TIMESTAMP)", user.userId, "running");
          }

          return new Response(JSON.stringify({ success: true, message: "Strategy started" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: "Failed to start strategy" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      if (path === "/api/strategy/stop" && method === "POST") {
        const strategy = activeStrategies.get(user.userId);
        if (!strategy) {
          return new Response(JSON.stringify({ error: "Strategy not running" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        strategy.process.kill();
        activeStrategies.delete(user.userId);
        
        // Clear tracker
        strategyTrackers.delete(user.userId);
        
        // Update session
        if (supabase) {
          await supabase
            .from("strategy_sessions")
            .update({ 
              status: "stopped", 
              stopped_at: new Date().toISOString() 
            })
            .eq("user_id", user.userId)
            .eq("status", "running");
        } else {
          sqliteDb.run("UPDATE strategy_sessions SET status = 'stopped', stopped_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = 'running'", user.userId);
        }

        return new Response(JSON.stringify({ success: true, message: "Strategy stopped" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Get strategy tracker data
      if (path === "/api/strategy/tracker" && method === "GET") {
        const tracker = strategyTrackers.get(user.userId);
        if (!tracker) {
          return new Response(JSON.stringify({ 
            positions: {},
            prices: {},
            recentTrades: [],
            summary: { totalTrades: 0, totalPnL: 0, winRate: 0 }
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify(tracker), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

// Parse strategy output to extract tracking data
function parseStrategyOutput(output: string, userId: string) {
  const tracker = strategyTrackers.get(userId);
  if (!tracker) return;

  try {
    // Parse price updates: [HH:mm:ss] [3s] 💰 Price - CE(strike): ₹price [OPEN @ entry] | PE(strike): ₹price [OPEN @ entry] | Spot: ₹price | CE VWAP: ₹vwap | PE VWAP: ₹vwap
    const priceMatch = output.match(/\[(\d{2}:\d{2}:\d{2})\]\s+\[3s\]\s+💰\s+Price\s+-\s+CE\((\d+)\):\s+₹([\d.]+)\s+(\[OPEN\s+@\s+([\d.]+)\]|\[CLOSED\])?\s+\|\s+PE\((\d+)\):\s+₹([\d.]+)\s+(\[OPEN\s+@\s+([\d.]+)\]|\[CLOSED\])?\s+\|\s+Spot:\s+₹([\d.]+)\s+\|\s+CE\s+VWAP:\s+₹([\d.]+)\s+\|\s+PE\s+VWAP:\s+₹([\d.]+)/);
    if (priceMatch) {
      tracker.prices = {
        cePrice: parseFloat(priceMatch[3]),
        pePrice: parseFloat(priceMatch[7]),
        spotPrice: parseFloat(priceMatch[11]),
        ceVwap: parseFloat(priceMatch[12]),
        peVwap: parseFloat(priceMatch[13]),
        lastUpdate: new Date().toISOString()
      };

      // Update positions if open
      if (priceMatch[4] && priceMatch[4].includes("OPEN")) {
        tracker.positions.ce = {
          isOpen: true,
          entryPrice: parseFloat(priceMatch[5]),
          entryTime: priceMatch[1],
          currentPrice: parseFloat(priceMatch[3]),
          pnl: (parseFloat(priceMatch[3]) - parseFloat(priceMatch[5])) * 195 // lot size
        };
      } else {
        tracker.positions.ce = { isOpen: false, entryPrice: 0, entryTime: "" };
      }

      if (priceMatch[8] && priceMatch[8].includes("OPEN")) {
        tracker.positions.pe = {
          isOpen: true,
          entryPrice: parseFloat(priceMatch[10]),
          entryTime: priceMatch[1],
          currentPrice: parseFloat(priceMatch[7]),
          pnl: (parseFloat(priceMatch[7]) - parseFloat(priceMatch[10])) * 195
        };
      } else {
        tracker.positions.pe = { isOpen: false, entryPrice: 0, entryTime: "" };
      }
    }

    // Parse trade entries: 📈 CE ENTRY EXECUTED @ price (reason)
    const entryMatch = output.match(/📈\s+(CE|PE)\s+ENTRY\s+EXECUTED\s+@\s+([\d.]+)\s+\(([^)]+)\)/);
    if (entryMatch) {
      const instrument = entryMatch[1];
      const price = parseFloat(entryMatch[2]);
      const reason = entryMatch[3];
      
      tracker.recentTrades.push({
        timestamp: new Date().toISOString(),
        instrument,
        action: "ENTRY",
        price,
        quantity: 195,
        reason
      });
      
      // Keep only last 50 trades
      if (tracker.recentTrades.length > 50) {
        tracker.recentTrades.shift();
      }
      
      tracker.summary.totalTrades++;
    }

    // Parse trade exits: 📉 CE EXIT EXECUTED @ price (reason) | PnL: ₹amount
    const exitMatch = output.match(/📉\s+(CE|PE)\s+(EXIT|SQUARE_OFF)\s+EXECUTED\s+@\s+([\d.]+)\s+\(([^)]+)\)(?:\s+\|\s+PnL:\s+₹([\d.-]+))?/);
    if (exitMatch) {
      const instrument = exitMatch[1];
      const action = exitMatch[2];
      const price = parseFloat(exitMatch[3]);
      const reason = exitMatch[4];
      const pnl = exitMatch[5] ? parseFloat(exitMatch[5]) : undefined;
      
      tracker.recentTrades.push({
        timestamp: new Date().toISOString(),
        instrument,
        action,
        price,
        quantity: 195,
        pnl,
        reason
      });
      
      if (tracker.recentTrades.length > 50) {
        tracker.recentTrades.shift();
      }
      
      tracker.summary.totalTrades++;
      
      if (pnl !== undefined) {
        tracker.summary.totalPnL += pnl;
        
        // Update win rate
        const winningTrades = tracker.recentTrades.filter(t => t.pnl && t.pnl > 0).length;
        tracker.summary.winRate = tracker.recentTrades.length > 0 
          ? (winningTrades / tracker.recentTrades.length) * 100 
          : 0;
      }
    }
  } catch (err) {
    // Silently fail parsing - don't break the server
    console.error(`Error parsing strategy output for user ${userId}:`, err);
  }
}

console.log(`🚀 AutoTrade API Server running on 0.0.0.0:${server.port}`);
console.log(`🌐 Public URL: https://autotrade-api.railway.app (via Railway proxy)`);
console.log(`📊 CORS Debugging: ENABLED - All requests will be logged`);
console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);
if (supabase) {
  console.log(`✅ Using Supabase database`);
} else {
  console.log(`⚠️  Using SQLite (fallback mode - set SUPABASE_URL and SUPABASE_ANON_KEY for production)`);
}
console.log(`\n📝 Watch Railway logs to see CORS header details for each request\n`);
