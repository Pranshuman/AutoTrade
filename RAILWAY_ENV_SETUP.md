# Railway Environment Variables Setup

## Your Supabase Credentials

Add these to Railway:

### Step 1: Go to Railway
1. Open your Railway project dashboard
2. Click on your service (the one running `server.ts`)
3. Go to **Variables** tab
4. Click **"+ New Variable"**

### Step 2: Add First Variable
- **Name**: `SUPABASE_URL`
- **Value**: `https://pfwlzpjrvomgqpldyxbg.supabase.co`
- Click **"Add"**

### Step 3: Add Second Variable
- **Name**: `SUPABASE_ANON_KEY`
- **Value**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmd2x6cGpydm9tZ3FwbGR5eGJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1Mzg0NDgsImV4cCI6MjA4MzExNDQ0OH0.NrhIlN_nRzaaOQBKa68go37Dv2LnboDOO2kk-brogRs`
- Click **"Add"**

### Step 4: Verify
After adding both variables, Railway will automatically redeploy. Check the logs - you should see:
```
✅ Supabase client initialized
```

## Next: Create Database Tables

1. Go to your Supabase dashboard: https://pfwlzpjrvomgqpldyxbg.supabase.co
2. Click **SQL Editor** in the left sidebar
3. Click **"New query"**
4. Copy and paste the contents of `supabase_setup.sql`
5. Click **"Run"** (or press Cmd/Ctrl + Enter)
6. You should see: "Tables created successfully!"

## That's It!

Your app is now connected to Supabase! 🎉

