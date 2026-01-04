/**
 * Backend API Server for AutoTrade with PostgreSQL
 * Handles user authentication, credential management, and strategy control
 * 
 * To use this, add PostgreSQL service in Railway and set DATABASE_URL environment variable
 */

import { serve } from "bun";
import { join } from "path";
import { readFile } from "fs/promises";

// PostgreSQL connection (using postgres package)
// Install: bun add postgres
let db: any = null;

async function initDatabase() {
  try {
    const postgres = await import("postgres");
    const connectionString = process.env.DATABASE_URL;
    
    if (!connectionString) {
      console.warn("⚠️ DATABASE_URL not set, falling back to SQLite");
      return null;
    }

    db = postgres.default(connectionString);
    
    // Create tables
    await db`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    
    await db`
      CREATE TABLE IF NOT EXISTS credentials (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        api_key TEXT NOT NULL,
        api_secret TEXT NOT NULL,
        access_token TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    
    await db`
      CREATE TABLE IF NOT EXISTS strategy_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        started_at TIMESTAMP,
        stopped_at TIMESTAMP
      )
    `;
    
    console.log("✅ PostgreSQL database initialized");
    return db;
  } catch (err) {
    console.error("❌ PostgreSQL connection failed:", err);
    return null;
  }
}

// Fallback to SQLite if PostgreSQL not available
let sqliteDb: any = null;
function initSQLite() {
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
    
    console.log("✅ SQLite database initialized (fallback)");
    return sqliteDb;
  } catch (err) {
    console.error("❌ SQLite initialization failed:", err);
    return null;
  }
}

// Initialize database on startup
(async () => {
  db = await initDatabase();
  if (!db) {
    sqliteDb = initSQLite();
  }
})();

// Database query helpers
async function query(sql: string, params: any[] = []) {
  if (db) {
    // PostgreSQL
    return await db.unsafe(sql, params);
  } else if (sqliteDb) {
    // SQLite
    return sqliteDb.query(sql).all(...params);
  }
  throw new Error("No database available");
}

async function queryOne(sql: string, params: any[] = []) {
  if (db) {
    const result = await db.unsafe(sql, params);
    return result[0] || null;
  } else if (sqliteDb) {
    return sqliteDb.query(sql).get(...params);
  }
  throw new Error("No database available");
}

async function execute(sql: string, params: any[] = []) {
  if (db) {
    await db.unsafe(sql, params);
  } else if (sqliteDb) {
    sqliteDb.run(sql, ...params);
  } else {
    throw new Error("No database available");
  }
}

// Rest of the server code remains the same...
// (Copy from server.ts but replace db.query() with query() and db.run() with execute())

