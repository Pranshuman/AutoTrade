# Database Setup Guide

## Current Setup

The server uses **SQLite** by default, which creates a local `autotrade.db` file. This works but has limitations on Railway.

## Database Options

### Option 1: SQLite (Current - Works but data is ephemeral)

**Pros:**
- ✅ No setup required
- ✅ Works immediately
- ✅ Good for testing

**Cons:**
- ❌ Data is lost on Railway redeployments
- ❌ Not persistent across restarts
- ❌ Not suitable for production

**Status:** Already working, but data won't persist.

---

### Option 2: PostgreSQL on Railway (Recommended for Production)

**Pros:**
- ✅ Data persists across deployments
- ✅ Production-ready
- ✅ Free tier available on Railway
- ✅ Better for multiple users

**Cons:**
- ⚠️ Requires setup

## How to Set Up PostgreSQL on Railway

### Step 1: Add PostgreSQL Service

1. Go to your Railway project dashboard
2. Click **"+ New"** → **"Database"** → **"Add PostgreSQL"**
3. Railway will create a PostgreSQL service automatically

### Step 2: Connect to Your Service

1. Railway automatically sets the `DATABASE_URL` environment variable
2. Your `server.ts` will automatically use it (if we update the code)

### Step 3: Update Server Code (Optional)

The current `server.ts` uses SQLite. To use PostgreSQL:

1. Install postgres package:
   ```bash
   bun add postgres
   ```

2. Update `server.ts` to check for `DATABASE_URL` and use PostgreSQL if available

**OR** just keep using SQLite for now - it works, you'll just need to re-register users after redeployments.

---

## Quick Answer

**Do you need a database?** 
- **Yes** - Required for user accounts and credential storage

**Does it work now?**
- **Yes** - SQLite is working, but data is temporary

**Should you set up PostgreSQL?**
- **Optional** - Only if you want data to persist across deployments
- For testing, SQLite is fine
- For production with multiple users, PostgreSQL is better

---

## Current Status

✅ **SQLite is working** - Your app functions normally
⚠️ **Data is ephemeral** - Users/credentials reset on redeploy
💡 **PostgreSQL is optional** - Set it up only if you need persistence

