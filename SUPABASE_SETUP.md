# Supabase Setup Guide

## Quick Setup Steps

### Step 1: Create Supabase Project

1. Go to [supabase.com](https://supabase.com)
2. Sign up / Log in
3. Click **"New Project"**
4. Fill in:
   - **Name**: `autotrade` (or any name)
   - **Database Password**: Create a strong password (save it!)
   - **Region**: Choose closest to you
5. Click **"Create new project"**
6. Wait 2-3 minutes for setup to complete

### Step 2: Get Your Supabase Credentials

1. In your Supabase project dashboard, go to **Settings** → **API**
2. Copy these values:
   - **Project URL** (e.g., `https://xxxxx.supabase.co`)
   - **anon/public key** (starts with `eyJ...`)

### Step 3: Create Database Tables

1. In Supabase dashboard, go to **SQL Editor**
2. Click **"New query"**
3. Paste this SQL:

```sql
-- Create users table
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create credentials table
CREATE TABLE IF NOT EXISTS credentials (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key TEXT NOT NULL,
  api_secret TEXT NOT NULL,
  access_token TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create strategy_sessions table
CREATE TABLE IF NOT EXISTS strategy_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  started_at TIMESTAMP,
  stopped_at TIMESTAMP
);

-- Enable Row Level Security (optional but recommended)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_sessions ENABLE ROW LEVEL SECURITY;

-- Create policies to allow all operations (for now)
-- In production, you'd want more restrictive policies
CREATE POLICY "Allow all operations on users" ON users
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations on credentials" ON credentials
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations on strategy_sessions" ON strategy_sessions
  FOR ALL USING (true) WITH CHECK (true);
```

4. Click **"Run"** to execute

### Step 4: Set Environment Variables on Railway

1. Go to your Railway project
2. Click on your service (the one running `server.ts`)
3. Go to **Variables** tab
4. Add these environment variables:

```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Replace with your actual values from Step 2.

5. Railway will automatically redeploy

### Step 5: Verify It's Working

1. Check Railway logs - you should see:
   ```
   ✅ Supabase client initialized
   ```

2. If you see:
   ```
   ⚠️  Using SQLite (fallback mode...)
   ```
   Then the environment variables aren't set correctly.

## Troubleshooting

### "Missing Supabase credentials" error

- Check that `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set in Railway
- Make sure there are no extra spaces or quotes
- Redeploy after adding variables

### Database connection errors

- Verify your Supabase project is active (not paused)
- Check that tables were created successfully
- Verify RLS policies allow operations

### Tables not found

- Run the SQL script again in Supabase SQL Editor
- Check the "Table Editor" in Supabase to see if tables exist

## Benefits of Supabase

✅ **Persistent data** - Survives Railway redeployments  
✅ **Free tier** - 500MB database, 2GB bandwidth  
✅ **Easy management** - Web dashboard for viewing data  
✅ **Automatic backups** - Daily backups included  
✅ **Scalable** - Can upgrade as you grow  

## Free Tier Limits

- **Database size**: 500MB
- **Bandwidth**: 2GB/month
- **API requests**: 50,000/month
- **File storage**: 1GB

Perfect for your trading app! 🚀

