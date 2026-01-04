# Vercel Frontend Deployment Guide

This guide explains how to deploy the AutoTrade frontend to Vercel while keeping the backend on Railway.

## Architecture

- **Frontend (Vercel)**: Static HTML/CSS/JS files - fast, global CDN
- **Backend (Railway)**: API server with database and trading strategy - long-running process

## Prerequisites

1. Vercel account (sign up at [vercel.com](https://vercel.com))
2. Railway backend already deployed and running
3. Your Railway backend URL (e.g., `https://autotrade-api.railway.app`)

## Step 1: Get Your Railway Backend URL

1. Go to your Railway project dashboard
2. Click on your service
3. Go to **Settings** → **Networking**
4. Click **Generate Domain** or copy your existing domain
5. Copy the URL (e.g., `https://autotrade-api.railway.app`)

## Step 2: Deploy to Vercel

### Option A: Deploy via Vercel CLI

1. Install Vercel CLI:
   ```bash
   npm i -g vercel
   ```

2. Login to Vercel:
   ```bash
   vercel login
   ```

3. Deploy:
   ```bash
   vercel --prod
   ```

4. When prompted, set the API URL:
   - Environment variable name: `VERCEL_ENV_API_URL`
   - Value: Your Railway backend URL (e.g., `https://autotrade-api.railway.app`)

### Option B: Deploy via GitHub (Recommended)

1. Push your code to GitHub (already done)

2. Go to [vercel.com](https://vercel.com) and sign in

3. Click **Add New Project**

4. Import your `AutoTrade` repository

5. Configure the project:
   - **Framework Preset**: Other
   - **Root Directory**: `./` (root)
   - **Build Command**: Leave empty (static files)
   - **Output Directory**: `public`

6. Add Environment Variable:
   - **Name**: `VERCEL_ENV_API_URL`
   - **Value**: Your Railway backend URL (e.g., `https://autotrade-api.railway.app`)

7. Click **Deploy**

## Step 3: Update Frontend Configuration

After deployment, you need to update the API URL in the frontend:

1. Go to your Vercel project dashboard
2. Go to **Settings** → **Environment Variables**
3. Add or update:
   - `VERCEL_ENV_API_URL` = `https://your-railway-backend.railway.app`

4. Redeploy (Vercel will auto-redeploy when you update env vars)

## Step 4: Update config.js (Alternative Method)

If environment variables don't work, you can directly edit `public/config.js`:

```javascript
window.API_URL = 'https://your-railway-backend.railway.app';
```

Then commit and push:
```bash
git add public/config.js
git commit -m "Update API URL for Vercel"
git push origin main
```

Vercel will auto-deploy.

## Step 5: Enable CORS on Railway Backend

Make sure your Railway backend allows requests from your Vercel domain:

1. The `server.ts` already includes CORS headers
2. If needed, update the CORS origin in `server.ts` to include your Vercel domain:
   ```typescript
   "Access-Control-Allow-Origin": "https://your-vercel-app.vercel.app"
   ```

## Testing

1. Visit your Vercel deployment URL
2. Register a new account
3. Enter your Zerodha credentials
4. Try starting the strategy

## Troubleshooting

### CORS Errors

If you see CORS errors:
- Check that Railway backend is running
- Verify CORS headers in `server.ts`
- Check browser console for specific error messages

### API Connection Failed

- Verify your Railway backend URL is correct
- Check that Railway service is running
- Test the API directly: `https://your-railway-backend.railway.app/api/status`

### Environment Variables Not Working

- Vercel environment variables are injected at build time
- For runtime configuration, use `public/config.js` instead
- Make sure to redeploy after changing environment variables

## Custom Domain (Optional)

1. In Vercel dashboard, go to **Settings** → **Domains**
2. Add your custom domain
3. Follow DNS configuration instructions
4. Update `config.js` or environment variable if needed

## Benefits of This Setup

- ✅ **Fast Frontend**: Vercel's global CDN for instant page loads
- ✅ **Scalable Backend**: Railway handles long-running processes
- ✅ **Cost Effective**: Vercel free tier for frontend, Railway for backend
- ✅ **Easy Updates**: Push to GitHub, both platforms auto-deploy

