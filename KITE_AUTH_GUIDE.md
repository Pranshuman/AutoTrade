# Zerodha Kite Connect Authentication Guide

## Overview

To use the AutoTrade strategy, you need three credentials from Zerodha:
1. **API Key** - From your Kite Connect app
2. **API Secret** - From your Kite Connect app  
3. **Access Token** - Generated after logging in (expires daily)

## Step-by-Step Guide

### Step 1: Get API Key & Secret

1. Go to [Zerodha Kite Connect](https://kite.trade/)
2. Log in to your Zerodha account
3. Go to **Apps** → **My Apps** → **Create New App**
4. Fill in:
   - **App Name**: AutoTrade (or any name)
   - **Redirect URL**: `http://localhost:3000` (for local testing)
5. After creating, you'll get:
   - **API Key** (e.g., `gssli7u395tn5in8`)
   - **API Secret** (e.g., `yeq4xu913i50u2d5j5b0wkgqp6cp0ufo`)

### Step 2: Generate Access Token

The access token requires a login flow. You have two options:

#### Option A: Use the Script (Recommended)

1. **Run the authentication script:**
   ```bash
   bun run kite_auth_flow.ts
   ```

2. **Copy the login URL** that's printed

3. **Open it in your browser** and log in to Zerodha

4. **After login**, you'll be redirected to a URL like:
   ```
   http://localhost:3000/?request_token=XXXXX&action=login&status=success
   ```

5. **Copy the `request_token`** value from the URL

6. **Paste it** when prompted by the script

7. **The script will generate your access token**

#### Option B: Manual Process

1. **Get login URL:**
   ```bash
   bun run login_access_token.ts
   ```
   This will print a login URL.

2. **Open the URL** in your browser and log in

3. **After login**, copy the `request_token` from the redirect URL

4. **Update `login_access_token.ts`** with the request token:
   ```typescript
   const requestToken = "YOUR_REQUEST_TOKEN_HERE";
   ```

5. **Run the script again:**
   ```bash
   bun run login_access_token.ts
   ```

6. **Copy the access token** from the output

### Step 3: Enter Credentials in Web Interface

1. Go to your Vercel frontend: `https://autotrade1234.vercel.app`
2. Register/Login to your account
3. Go to the **Credentials** section
4. Enter:
   - **API Key**: Your API key from Step 1
   - **API Secret**: Your API secret from Step 1
   - **Access Token**: The access token from Step 2
5. Click **Save Credentials**

### Step 4: Start Trading

Once credentials are saved:
1. Click **Start Strategy**
2. Your trading bot will begin running during market hours (9:15 AM - 3:20 PM IST)

## Important Notes

### Access Token Expiry

- ⚠️ **Access tokens expire daily** (at midnight IST)
- You'll need to regenerate them when they expire
- Run `bun run kite_auth_flow.ts` again to get a new token
- Update it in the web interface

### Security

- ✅ **Never share** your API Secret or Access Token
- ✅ **Never commit** credentials to Git (they're in `.gitignore`)
- ✅ Each user has their own credentials stored securely in Supabase
- ✅ Credentials are encrypted in the database

### Troubleshooting

**"Invalid request token" error:**
- Make sure you copied the entire `request_token` from the redirect URL
- Request tokens expire quickly (within minutes), generate a new one

**"Invalid access token" error:**
- Your access token has expired (they expire daily)
- Generate a new one using the steps above

**"Session expired" error:**
- Your access token needs to be refreshed
- Generate a new access token

## Quick Reference

```bash
# Generate access token
bun run kite_auth_flow.ts

# Or use the manual script
bun run login_access_token.ts
```

## API Credentials Location

- **Zerodha Dashboard**: https://kite.trade/connect/apps
- **Your App**: Shows API Key and Secret
- **Access Token**: Generated via login flow (expires daily)

