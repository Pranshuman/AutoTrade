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

// Active strategy instances per user
const activeStrategies = new Map<number, { process: any; status: string }>();

// Serve static files
async function serveStaticFile(path: string): Promise<Response | null> {
  try {
    const filePath = join(process.cwd(), path === "/" ? "index.html" : path);
    const file = await readFile(filePath);
    const ext = path.split(".").pop()?.toLowerCase();
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
            const response = new Response(JSON.stringify({ token, user: { id: data.id, username: data.username } }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
            console.log(`  ✅ Registration successful for: ${data.username}`);
            console.log(`  📤 Response status: ${response.status}`);
            console.log(`  📤 Response headers:`, Object.fromEntries(response.headers.entries()));
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
            return new Response(JSON.stringify({ token, user: { id: result.id, username: result.username } }), {
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

          const token = generateToken(userData.id, userData.username);
          const response = new Response(JSON.stringify({ token, user: { id: userData.id, username: userData.username } }), {
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
          
          if (supabase) {
            const { data, error } = await supabase
              .from("credentials")
              .select("api_key, api_secret, access_token, updated_at")
              .eq("user_id", user.userId)
              .single();
            
            if (error && error.code !== "PGRST116") { // PGRST116 = no rows returned
              throw error;
            }
            creds = data;
          } else {
            creds = sqliteDb.query("SELECT api_key, api_secret, access_token, updated_at FROM credentials WHERE user_id = ?").get(user.userId) as any;
          }
          
          if (!creds) {
            return new Response(JSON.stringify({ credentials: null }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          
          return new Response(JSON.stringify({ 
            credentials: { 
              apiKey: creds.api_key, 
              apiSecret: creds.api_secret, 
              accessToken: creds.access_token, 
              updatedAt: creds.updated_at 
            } 
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

        if (!apiKey || !apiSecret || !accessToken) {
          return new Response(JSON.stringify({ error: "All credentials required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        try {
          if (supabase) {
            // Check if credentials exist
            const { data: existing } = await supabase
              .from("credentials")
              .select("id")
              .eq("user_id", user.userId)
              .single();
            
            if (existing) {
              // Update
              await supabase
                .from("credentials")
                .update({ 
                  api_key: apiKey, 
                  api_secret: apiSecret, 
                  access_token: accessToken,
                  updated_at: new Date().toISOString()
                })
                .eq("user_id", user.userId);
            } else {
              // Insert
              await supabase
                .from("credentials")
                .insert({ 
                  user_id: user.userId,
                  api_key: apiKey, 
                  api_secret: apiSecret, 
                  access_token: accessToken 
                });
            }
          } else {
            // SQLite fallback
            const existing = sqliteDb.query("SELECT id FROM credentials WHERE user_id = ?").get(user.userId) as any;
            if (existing) {
              sqliteDb.run("UPDATE credentials SET api_key = ?, api_secret = ?, access_token = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?", apiKey, apiSecret, accessToken, user.userId);
            } else {
              sqliteDb.run("INSERT INTO credentials (user_id, api_key, api_secret, access_token) VALUES (?, ?, ?, ?)", user.userId, apiKey, apiSecret, accessToken);
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
          
          if (supabase) {
            const { data, error } = await supabase
              .from("credentials")
              .select("api_key, api_secret, access_token")
              .eq("user_id", user.userId)
              .single();
            
            if (error || !data) {
              return new Response(JSON.stringify({ error: "Please set your credentials first" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            creds = data;
          } else {
            creds = sqliteDb.query("SELECT api_key, api_secret, access_token FROM credentials WHERE user_id = ?").get(user.userId) as any;
            if (!creds) {
              return new Response(JSON.stringify({ error: "Please set your credentials first" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
          }

          // Check if already running
          if (activeStrategies.has(user.userId)) {
            return new Response(JSON.stringify({ error: "Strategy already running" }), {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          // Start strategy in background
          const strategyProcess = Bun.spawn(["bun", "run", "vwap_rsi_live_strategy_user.ts", String(user.userId)], {
            env: {
              ...process.env,
              KITE_API_KEY: creds.api_key,
              KITE_API_SECRET: creds.api_secret,
              KITE_ACCESS_TOKEN: creds.access_token,
            },
            stdout: "pipe",
            stderr: "pipe",
          });

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

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

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
