/**
 * Backend API Server for AutoTrade
 * Handles user authentication, credential management, and strategy control
 */

import { Database } from "bun:sqlite";
import { serve } from "bun";
import { join } from "path";
import { readFile } from "fs/promises";

// Database setup
const db = new Database("autotrade.db");

// Initialize database tables
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
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

db.run(`
  CREATE TABLE IF NOT EXISTS strategy_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    started_at DATETIME,
    stopped_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);

// Simple password hashing (use bcrypt in production)
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
const server = serve({
  port: process.env.PORT || 3000,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
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
        const body = await req.json();
        const { username, password } = body;

        if (!username || !password) {
          return new Response(JSON.stringify({ error: "Username and password required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        try {
          const passwordHash = hashPassword(password);
          const result = db.query("INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id, username").get(username, passwordHash) as any;
          
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
        } catch (err: any) {
          if (err.message.includes("UNIQUE")) {
            return new Response(JSON.stringify({ error: "Username already exists" }), {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      if (path === "/api/login" && method === "POST") {
        const body = await req.json();
        const { username, password } = body;

        const user = db.query("SELECT id, username, password_hash FROM users WHERE username = ?").get(username) as any;
        if (!user || !verifyPassword(password, user.password_hash)) {
          return new Response(JSON.stringify({ error: "Invalid credentials" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const token = generateToken(user.id, user.username);
        return new Response(JSON.stringify({ token, user: { id: user.id, username: user.username } }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Protected routes
      if (!user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/api/credentials" && method === "GET") {
        const creds = db.query("SELECT api_key, api_secret, access_token, updated_at FROM credentials WHERE user_id = ?").get(user.userId) as any;
        if (!creds) {
          return new Response(JSON.stringify({ credentials: null }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ credentials: { apiKey: creds.api_key, apiSecret: creds.api_secret, accessToken: creds.access_token, updatedAt: creds.updated_at } }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
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

        // Check if credentials exist
        const existing = db.query("SELECT id FROM credentials WHERE user_id = ?").get(user.userId) as any;
        
        if (existing) {
          db.run("UPDATE credentials SET api_key = ?, api_secret = ?, access_token = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?", apiKey, apiSecret, accessToken, user.userId);
        } else {
          db.run("INSERT INTO credentials (user_id, api_key, api_secret, access_token) VALUES (?, ?, ?, ?)", user.userId, apiKey, apiSecret, accessToken);
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/api/strategy/status" && method === "GET") {
        const strategy = activeStrategies.get(user.userId);
        const session = db.query("SELECT status, started_at, stopped_at FROM strategy_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(user.userId) as any;
        
        return new Response(JSON.stringify({ 
          status: strategy?.status || session?.status || "stopped",
          startedAt: session?.started_at || null,
          stoppedAt: session?.stopped_at || null,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/api/strategy/start" && method === "POST") {
        // Check if credentials exist
        const creds = db.query("SELECT api_key, api_secret, access_token FROM credentials WHERE user_id = ?").get(user.userId) as any;
        if (!creds) {
          return new Response(JSON.stringify({ error: "Please set your credentials first" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
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
        
        db.run("INSERT INTO strategy_sessions (user_id, status, started_at) VALUES (?, ?, CURRENT_TIMESTAMP)", user.userId, "running");

        return new Response(JSON.stringify({ success: true, message: "Strategy started" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
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
        
        db.run("UPDATE strategy_sessions SET status = 'stopped', stopped_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = 'running'", user.userId);

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

console.log(`🚀 AutoTrade API Server running on http://localhost:${server.port}`);

