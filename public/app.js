// API Base URL - Configured via config.js or environment variable
// config.js sets window.API_URL (set in Vercel environment variables)
// For local development, defaults to http://localhost:3000
const API_URL = (() => {
  // Check if config.js set the API URL
  if (typeof window !== 'undefined' && window.API_URL) {
    return window.API_URL;
  }
  // Local development fallback
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3000';
  }
  // Production fallback - update this to your Railway backend URL
  // Or set window.API_URL in config.js
  return 'https://autotrade-api.railway.app';
})();

// State
let authToken = localStorage.getItem('authToken');
let currentUser = null;

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    if (authToken) {
        checkAuth();
    } else {
        showAuth();
    }
    
    // Set up Kite login URL link
    setupKiteLoginLink();
});

// Setup Kite Connect login URL
async function setupKiteLoginLink() {
    const loginLink = document.getElementById('kite-login-link');
    const loginUrlText = document.getElementById('kite-login-url-text');
    
    if (!loginLink) return;
    
    try {
        // Fetch login URL from API
        const response = await fetch(`${API_URL}/api/kite-login-url`);
        const data = await response.json();
        
        if (data.loginURL) {
            loginLink.href = data.loginURL;
            loginLink.textContent = '🔗 Open Zerodha Login Page';
            loginLink.onclick = null; // Remove preventDefault
            
            if (loginUrlText) {
                loginUrlText.textContent = `URL: ${data.loginURL}`;
            }
            
            console.log('✅ Kite login URL loaded:', data.loginURL);
        } else {
            throw new Error('No login URL in response');
        }
    } catch (error) {
        console.error('Error loading Kite login URL:', error);
        loginLink.href = '#';
        loginLink.textContent = '⚠️ Click to see instructions';
        loginLink.onclick = (e) => {
            e.preventDefault();
            alert('Could not load login URL. Please run locally:\n\nbun run kite_auth_flow.ts\n\nOr visit: https://kite.trade/connect/login');
        };
        
        if (loginUrlText) {
            loginUrlText.textContent = 'Error loading URL. Use bun run kite_auth_flow.ts instead.';
            loginUrlText.style.color = '#e74c3c';
        }
    }
}

// Auth functions
function showLogin() {
    document.getElementById('login-form').style.display = 'flex';
    document.getElementById('register-form').style.display = 'none';
    document.querySelectorAll('.tab-btn').forEach((btn, idx) => {
        btn.classList.toggle('active', idx === 0);
    });
}

function showRegister() {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = 'flex';
    document.querySelectorAll('.tab-btn').forEach((btn, idx) => {
        btn.classList.toggle('active', idx === 1);
    });
}

async function handleLogin() {
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const errorDiv = document.getElementById('auth-error');

    try {
        const response = await fetch(`${API_URL}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (!response.ok) {
            errorDiv.textContent = data.error || 'Login failed';
            errorDiv.classList.add('show');
            return;
        }

        authToken = data.token;
        currentUser = data.user;
        localStorage.setItem('authToken', authToken);
        showDashboard();
        loadCredentials();
        checkStrategyStatus();
    } catch (error) {
        errorDiv.textContent = 'Network error. Please try again.';
        errorDiv.classList.add('show');
    }
}

async function handleRegister() {
    const username = document.getElementById('register-username').value;
    const password = document.getElementById('register-password').value;
    const apiKey = document.getElementById('register-api-key').value;
    const apiSecret = document.getElementById('register-api-secret').value;
    const errorDiv = document.getElementById('register-error');

    if (!username || !password || !apiKey || !apiSecret) {
        errorDiv.textContent = 'All fields are required';
        errorDiv.classList.add('show');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, apiKey, apiSecret })
        });

        const data = await response.json();

        if (!response.ok) {
            errorDiv.textContent = data.error || 'Registration failed';
            errorDiv.classList.add('show');
            return;
        }

        authToken = data.token;
        currentUser = data.user;
        localStorage.setItem('authToken', authToken);
        
        // Store API key and secret temporarily for login flow
        sessionStorage.setItem('pendingApiKey', apiKey);
        sessionStorage.setItem('pendingApiSecret', apiSecret);
        
        // Show login URL step
        showKiteLoginStep(data.loginURL);
    } catch (error) {
        errorDiv.textContent = 'Network error. Please try again.';
        errorDiv.classList.add('show');
    }
}

function showKiteLoginStep(loginURL) {
    // Hide auth section
    document.getElementById('auth-section').style.display = 'none';
    
    // Show Kite login step
    const loginStep = document.getElementById('kite-login-step');
    if (!loginStep) {
        // Create the step if it doesn't exist
        const step = document.createElement('div');
        step.id = 'kite-login-step';
        step.className = 'section';
        step.innerHTML = `
            <h1>🔐 Complete Zerodha Login</h1>
            <div class="card">
                <h2>Step 2: Login to Zerodha</h2>
                <p>Click the button below to open Zerodha login page. After logging in, you'll be redirected back.</p>
                <a href="${loginURL}" target="_blank" id="kite-login-button" class="kite-login-btn" style="display: block; padding: 15px; background: #3498db; color: white; text-decoration: none; border-radius: 8px; text-align: center; font-weight: 600; font-size: 18px; margin: 20px 0;">
                    🔗 Open Zerodha Login Page
                </a>
                <div id="kite-redirect-instructions" style="background: #fff3cd; padding: 15px; border-radius: 8px; margin-top: 20px; border-left: 4px solid #ffc107;">
                    <h3 style="margin-top: 0; color: #856404;">📋 After Login:</h3>
                    <ol style="margin: 10px 0; padding-left: 20px; color: #856404;">
                        <li>You'll be redirected to a URL with <code>?request_token=...</code></li>
                        <li>Copy the entire URL from your browser's address bar</li>
                        <li>Paste it in the field below</li>
                    </ol>
                </div>
                <div style="margin-top: 20px;">
                    <label for="redirect-url" style="display: block; margin-bottom: 10px; font-weight: 600;">Paste Redirect URL Here:</label>
                    <input type="text" id="redirect-url" placeholder="https://your-redirect-url.com/?request_token=XXXXX&action=login&status=success" style="width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 14px;">
                    <button onclick="handleKiteRedirect()" style="margin-top: 15px; width: 100%; padding: 12px; background: #2ecc71; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer;">
                        ✅ Generate Access Token
                    </button>
                </div>
                <div id="kite-error" class="error-message"></div>
                <div id="kite-success" class="success-message"></div>
            </div>
        `;
        document.querySelector('.container').appendChild(step);
    } else {
        loginStep.style.display = 'block';
        document.getElementById('kite-login-button').href = loginURL;
    }
}

async function handleKiteRedirect() {
    const redirectURL = document.getElementById('redirect-url').value;
    const errorDiv = document.getElementById('kite-error');
    const successDiv = document.getElementById('kite-success');
    
    errorDiv.classList.remove('show');
    successDiv.classList.remove('show');
    
    if (!redirectURL) {
        errorDiv.textContent = 'Please paste the redirect URL';
        errorDiv.classList.add('show');
        return;
    }
    
    // Extract request_token from URL
    try {
        const url = new URL(redirectURL);
        const requestToken = url.searchParams.get('request_token');
        
        if (!requestToken) {
            throw new Error('No request_token found in URL');
        }
        
        // Get pending API credentials
        const apiKey = sessionStorage.getItem('pendingApiKey');
        const apiSecret = sessionStorage.getItem('pendingApiSecret');
        
        if (!apiKey || !apiSecret) {
            throw new Error('API credentials not found. Please register again.');
        }
        
        // Call API to generate access token
        const response = await fetch(`${API_URL}/api/generate-access-token`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ requestToken, apiKey, apiSecret })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            errorDiv.textContent = data.error || 'Failed to generate access token';
            errorDiv.classList.add('show');
            return;
        }
        
        // Success! Clear pending credentials and show dashboard
        sessionStorage.removeItem('pendingApiKey');
        sessionStorage.removeItem('pendingApiSecret');
        
        successDiv.textContent = '✅ Access token generated! Loading dashboard...';
        successDiv.classList.add('show');
        
        // Hide login step and show dashboard
        document.getElementById('kite-login-step').style.display = 'none';
        showDashboard();
        
        // Load credentials (they should be saved automatically)
        setTimeout(() => {
            loadCredentials();
        }, 1000);
        
    } catch (err) {
        errorDiv.textContent = `Invalid URL: ${err.message}`;
        errorDiv.classList.add('show');
    }
}

async function checkAuth() {
    if (!authToken) {
        showAuth();
        return;
    }

    // Verify token by trying to fetch credentials
    try {
        await loadCredentials();
        showDashboard();
        checkStrategyStatus();
    } catch {
        localStorage.removeItem('authToken');
        authToken = null;
        showAuth();
    }
}

function handleLogout() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem('authToken');
    showAuth();
}

function showAuth() {
    document.getElementById('auth-section').style.display = 'block';
    document.getElementById('dashboard').style.display = 'none';
}

function showDashboard() {
    document.getElementById('auth-section').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
}

// Credentials functions
async function loadCredentials() {
    try {
        const response = await fetch(`${API_URL}/api/credentials`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();

        if (data.credentials) {
            document.getElementById('api-key').value = data.credentials.apiKey;
            document.getElementById('api-secret').value = data.credentials.apiSecret;
            document.getElementById('access-token').value = data.credentials.accessToken;
            
            const statusBadge = document.getElementById('credentials-status');
            
            // Check token validity
            if (data.tokenExpired || !data.tokenValid) {
                statusBadge.textContent = '⚠️ Access Token Expired - Regenerate Required';
                statusBadge.className = 'status-badge no-credentials';
                statusBadge.style.background = '#e74c3c';
                
                // Show warning message
                const errorDiv = document.getElementById('credentials-error');
                errorDiv.textContent = '⚠️ Your access token has expired. Zerodha tokens expire daily at midnight IST. Please regenerate your token using the "Generate Access Token" button below.';
                errorDiv.classList.add('show');
                
                document.getElementById('start-btn').disabled = true;
            } else {
                statusBadge.textContent = '✓ Credentials Saved';
                statusBadge.className = 'status-badge has-credentials';
                statusBadge.style.background = '';
                
                // Clear any previous error messages
                document.getElementById('credentials-error').classList.remove('show');
                
                document.getElementById('start-btn').disabled = false;
            }
        } else {
            const statusBadge = document.getElementById('credentials-status');
            statusBadge.textContent = '⚠ No Credentials Set';
            statusBadge.className = 'status-badge no-credentials';
            statusBadge.style.background = '';
            
            document.getElementById('start-btn').disabled = true;
        }
    } catch (error) {
        console.error('Error loading credentials:', error);
    }
}

async function handleSaveCredentials(event) {
    event.preventDefault();
    const errorDiv = document.getElementById('credentials-error');
    const successDiv = document.getElementById('credentials-success');

    const apiKey = document.getElementById('api-key').value;
    const apiSecret = document.getElementById('api-secret').value;
    const accessToken = document.getElementById('access-token').value;

    try {
        const response = await fetch(`${API_URL}/api/credentials`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ apiKey, apiSecret, accessToken })
        });

        const data = await response.json();

        if (!response.ok) {
            errorDiv.textContent = data.error || 'Failed to save credentials';
            errorDiv.classList.add('show');
            successDiv.classList.remove('show');
            return;
        }

        successDiv.textContent = 'Credentials saved successfully!';
        successDiv.classList.add('show');
        errorDiv.classList.remove('show');
        
        loadCredentials();
    } catch (error) {
        errorDiv.textContent = 'Network error. Please try again.';
        errorDiv.classList.add('show');
        successDiv.classList.remove('show');
    }
}

// Strategy control functions
async function checkStrategyStatus() {
    try {
        const response = await fetch(`${API_URL}/api/strategy/status`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        const status = data.status || 'stopped';
        updateStrategyUI(status);

        // Show/hide tracker based on status
        const trackerSection = document.getElementById('tracker-section');
        if (trackerSection) {
            trackerSection.style.display = status === 'running' ? 'block' : 'none';
        }

        // Start/stop tracker updates
        if (status === 'running') {
            startTrackerUpdates();
        } else {
            stopTrackerUpdates();
        }
    } catch (error) {
        console.error('Error checking strategy status:', error);
    }
}

function updateStrategyUI(status) {
    const statusValue = document.getElementById('status-value');
    statusValue.textContent = status.toUpperCase();
    statusValue.className = `status-value ${status}`;

    document.getElementById('start-btn').disabled = status === 'running';
    document.getElementById('stop-btn').disabled = status !== 'running';
}

let trackerUpdateInterval = null;

function startTrackerUpdates() {
    if (trackerUpdateInterval) return; // Already running
    
    updateTracker(); // Initial update
    trackerUpdateInterval = setInterval(updateTracker, 3000); // Update every 3 seconds
}

function stopTrackerUpdates() {
    if (trackerUpdateInterval) {
        clearInterval(trackerUpdateInterval);
        trackerUpdateInterval = null;
    }
}

async function updateTracker() {
    try {
        const response = await fetch(`${API_URL}/api/strategy/tracker`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();

        // Update prices
        if (data.prices) {
            const prices = data.prices;
            updateElement('tracker-ce-price', prices.cePrice ? `₹${prices.cePrice.toFixed(2)}` : '--');
            updateElement('tracker-pe-price', prices.pePrice ? `₹${prices.pePrice.toFixed(2)}` : '--');
            updateElement('tracker-spot-price', prices.spotPrice ? `₹${prices.spotPrice.toFixed(2)}` : '--');
            updateElement('tracker-ce-vwap', prices.ceVwap ? `₹${prices.ceVwap.toFixed(2)}` : '--');
            updateElement('tracker-pe-vwap', prices.peVwap ? `₹${prices.peVwap.toFixed(2)}` : '--');
            
            if (prices.lastUpdate) {
                const updateTime = new Date(prices.lastUpdate);
                updateElement('tracker-last-update', `Last update: ${updateTime.toLocaleTimeString()}`);
            }
        }

        // Update positions
        if (data.positions) {
            updatePosition('ce', data.positions.ce);
            updatePosition('pe', data.positions.pe);
        }

        // Update summary
        if (data.summary) {
            const summary = data.summary;
            updateElement('tracker-total-trades', summary.totalTrades || 0);
            updateElement('tracker-total-pnl', `₹${(summary.totalPnL || 0).toFixed(2)}`);
            updateElement('tracker-win-rate', `${(summary.winRate || 0).toFixed(1)}%`);
            
            if (summary.startedAt) {
                const started = new Date(summary.startedAt);
                updateElement('tracker-started-at', started.toLocaleString());
            }
        }

        // Update recent trades
        if (data.recentTrades) {
            updateTradesList(data.recentTrades);
        }
    } catch (error) {
        console.error('Error updating tracker:', error);
    }
}

function updateElement(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function updatePosition(instrument, position) {
    const card = document.getElementById(`tracker-${instrument}-position`);
    if (!card) return;

    const statusEl = card.querySelector('.position-status');
    const entryPriceEl = document.getElementById(`${instrument}-entry-price`);
    const currentPriceEl = document.getElementById(`${instrument}-current-price`);
    const pnlEl = document.getElementById(`${instrument}-pnl`);

    if (position && position.isOpen) {
        card.classList.remove('closed');
        card.classList.add('open');
        if (statusEl) {
            statusEl.textContent = 'OPEN';
            statusEl.classList.remove('closed');
            statusEl.classList.add('open');
        }
        if (entryPriceEl) entryPriceEl.textContent = `₹${position.entryPrice.toFixed(2)}`;
        if (currentPriceEl) currentPriceEl.textContent = `₹${position.currentPrice?.toFixed(2) || '--'}`;
        if (pnlEl) {
            const pnl = position.pnl || 0;
            pnlEl.textContent = `₹${pnl.toFixed(2)}`;
            pnlEl.className = `pnl-value ${pnl >= 0 ? 'profit' : 'loss'}`;
        }
    } else {
        card.classList.remove('open');
        card.classList.add('closed');
        if (statusEl) {
            statusEl.textContent = 'CLOSED';
            statusEl.classList.remove('open');
            statusEl.classList.add('closed');
        }
        if (entryPriceEl) entryPriceEl.textContent = '--';
        if (currentPriceEl) currentPriceEl.textContent = '--';
        if (pnlEl) {
            pnlEl.textContent = '--';
            pnlEl.className = 'pnl-value';
        }
    }
}

function updateTradesList(trades) {
    const listEl = document.getElementById('tracker-trades-list');
    if (!listEl) return;

    if (trades.length === 0) {
        listEl.innerHTML = '<div class="no-trades">No trades yet</div>';
        return;
    }

    // Show last 10 trades
    const recentTrades = trades.slice(-10).reverse();
    listEl.innerHTML = recentTrades.map(trade => {
        const time = new Date(trade.timestamp);
        const pnlClass = trade.pnl !== undefined ? (trade.pnl >= 0 ? 'profit' : 'loss') : '';
        const pnlText = trade.pnl !== undefined ? `₹${trade.pnl.toFixed(2)}` : '';
        
        return `
            <div class="trade-item ${trade.action.toLowerCase()}">
                <div class="trade-header">
                    <span class="trade-instrument">${trade.instrument}</span>
                    <span class="trade-action ${trade.action.toLowerCase()}">${trade.action}</span>
                    <span class="trade-time">${time.toLocaleTimeString()}</span>
                </div>
                <div class="trade-details">
                    <span>Price: ₹${trade.price.toFixed(2)}</span>
                    <span>Qty: ${trade.quantity}</span>
                    ${pnlText ? `<span class="trade-pnl ${pnlClass}">P&L: ${pnlText}</span>` : ''}
                </div>
                <div class="trade-reason">${trade.reason}</div>
            </div>
        `;
    }).join('');
}

async function handleStartStrategy() {
    const errorDiv = document.getElementById('strategy-error');
    const successDiv = document.getElementById('strategy-success');

    try {
        const response = await fetch(`${API_URL}/api/strategy/start`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });

        const data = await response.json();

        if (!response.ok) {
            errorDiv.textContent = data.error || 'Failed to start strategy';
            errorDiv.classList.add('show');
            successDiv.classList.remove('show');
            return;
        }

        successDiv.textContent = 'Strategy started successfully!';
        successDiv.classList.add('show');
        errorDiv.classList.remove('show');
        
        updateStrategyUI('running');
        setTimeout(checkStrategyStatus, 1000);
    } catch (error) {
        errorDiv.textContent = 'Network error. Please try again.';
        errorDiv.classList.add('show');
        successDiv.classList.remove('show');
    }
}

async function handleStopStrategy() {
    const errorDiv = document.getElementById('strategy-error');
    const successDiv = document.getElementById('strategy-success');

    try {
        const response = await fetch(`${API_URL}/api/strategy/stop`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });

        const data = await response.json();

        if (!response.ok) {
            errorDiv.textContent = data.error || 'Failed to stop strategy';
            errorDiv.classList.add('show');
            successDiv.classList.remove('show');
            return;
        }

        successDiv.textContent = 'Strategy stopped successfully!';
        successDiv.classList.add('show');
        errorDiv.classList.remove('show');
        
        updateStrategyUI('stopped');
    } catch (error) {
        errorDiv.textContent = 'Network error. Please try again.';
        errorDiv.classList.add('show');
        successDiv.classList.remove('show');
    }
}

// Poll strategy status every 5 seconds
setInterval(() => {
    if (authToken) {
        checkStrategyStatus();
    }
}, 5000);

