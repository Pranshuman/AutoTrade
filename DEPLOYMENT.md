# Deployment Guide: VWAP RSI Live Strategy

This guide explains how to deploy your live trading strategy to Railway and Vercel.

## ⚠️ Important Notes

### Railway vs Vercel

- **Railway** ✅ **RECOMMENDED**: Perfect for long-running processes. Your strategy runs continuously during market hours (9:15 AM - 3:20 PM IST).
- **Vercel** ❌ **NOT RECOMMENDED**: Serverless functions have execution time limits (10s free, 60s pro). Your strategy needs to run for hours, so Vercel will timeout.

## 🚂 Railway Deployment (Recommended)

### Prerequisites
1. GitHub account with your code repository
2. Railway account (sign up at [railway.app](https://railway.app))

### Step 1: Prepare Your Repository

1. **Web Interface**: 
   - The app now includes a web interface at `index.html`
   - Users can register/login and enter their own credentials
   - Each user's credentials are stored securely in SQLite database

2. **Commit and push to GitHub**:
   ```bash
   git add .
   git commit -m "Prepare for Railway deployment"
   git push origin main
   ```

### Step 2: Deploy to Railway

1. Go to [railway.app](https://railway.app) and sign in
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"**
4. Choose your AutoTrade repository
5. Railway will automatically detect Bun and start building

### Step 3: Configure Environment Variables (Optional)

**Note**: Currently, your strategy uses hardcoded credentials. If you want to use environment variables:

1. In your Railway project, go to **Variables** tab
2. Add the following environment variables (if you modify the code to use them):
   ```
   KITE_API_KEY=your_api_key_here
   KITE_API_SECRET=your_api_secret_here
   KITE_ACCESS_TOKEN=your_access_token_here
   ```

**For now**: Your strategy will use the credentials in `vwap_rsi_live_strategy.ts`. Make sure they're valid before deploying.

### Step 4: Configure Build Settings

Railway should auto-detect Bun, but verify:
- **Build Command**: `bun install`
- **Start Command**: `bun run server.ts` (for the web interface)
- The web server runs on port 3000 (or Railway's assigned PORT)

### Step 5: Deploy

1. Railway will automatically deploy when you push to GitHub
2. Check the **Deployments** tab to see build logs
3. Check the **Logs** tab to see your strategy running

### Step 6: Monitor Your Deployment

- **Logs**: View real-time logs in Railway dashboard
- **Metrics**: Monitor CPU, memory, and network usage
- **Restarts**: Railway will auto-restart on crashes

## 🔄 Updating Your Strategy

1. Make changes to your code locally
2. Commit and push to GitHub:
   ```bash
   git add .
   git commit -m "Update strategy"
   git push origin main
   ```
3. Railway will automatically redeploy

## 📊 Accessing Output Files

Railway provides persistent storage. Your CSV and SVG files will be saved in the project directory. To access them:

1. Use Railway's **Files** tab (if available)
2. Or set up a file storage service (S3, etc.) and modify the code to upload files there
3. Or use Railway's volume mounts for persistent storage

## 🔐 Security Best Practices

1. **Never commit credentials to Git**
   - Use environment variables instead
   - Add `.env` to `.gitignore` (already done)

2. **Rotate access tokens regularly**
   - Update `KITE_ACCESS_TOKEN` in Railway when it expires

3. **Use Railway's secrets management**
   - Mark sensitive variables as "Secret" in Railway

## 🐛 Troubleshooting

### Strategy not starting
- Check Railway logs for errors
- Verify environment variables are set correctly
- Ensure Bun is installed (Railway auto-detects)

### Access token expired
- Run `login_access_token.ts` locally to get new token
- Update `KITE_ACCESS_TOKEN` in Railway variables
- Redeploy or restart the service

### Timezone issues
- Railway servers may be in UTC
- Your strategy uses IST (Indian Standard Time)
- Verify timezone handling in your code

## 💰 Railway Pricing

- **Free Tier**: $5 credit/month (good for testing)
- **Hobby Plan**: $20/month (recommended for production)
- **Pro Plan**: Custom pricing (for high-volume trading)

## 📝 Notes on Vercel

Vercel is **NOT suitable** for this use case because:
- Serverless functions timeout after 10-60 seconds
- Your strategy needs to run continuously for 6+ hours
- No persistent state between invocations

If you still want to try Vercel (not recommended):
1. You'd need to refactor to use scheduled functions
2. Use external storage (database) for state
3. Much more complex architecture required

## 🎯 Recommended Architecture

For production, consider:
1. **Railway** for the main trading bot
2. **Database** (PostgreSQL/Redis) for state persistence
3. **Monitoring** (Sentry, DataDog) for error tracking
4. **Alerts** (Discord, Telegram) for trade notifications

