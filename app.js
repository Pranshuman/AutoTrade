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
    // Don't call setupKiteLoginLink here - it will be called after credentials are loaded
});

// Generate new access token - show Kite login step
async function generateNewAccessToken() {
    if (!authToken) {
        alert('Please login first');
        return;
    }
    
    const errorDiv = document.getElementById('credentials-error');
    const generateBtn = document.getElementById('generate-token-btn');
    
    // Disable button while loading
    if (generateBtn) {
        generateBtn.disabled = true;
        generateBtn.textContent = '⏳ Loading...';
    }
    
    try {
        const response = await fetch(`${API_URL}/api/kite-login-url`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (data.loginURL) {
            showKiteLoginStep(data.loginURL);
        } else {
            throw new Error('No login URL in response');
        }
    } catch (error) {
        console.error('Error generating login URL:', error);
        
        // Show error message
        if (errorDiv) {
            errorDiv.textContent = `Error: ${error.message || 'Could not generate login URL'}. Please ensure you have saved your API Key and Secret first.`;
            errorDiv.classList.add('show');
        }
        
        // Re-enable button
        if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.textContent = '🔐 Generate Access Token (Required)';
        }
    }
}

// Setup Kite Connect login URL
async function setupKiteLoginLink() {
    const loginLink = document.getElementById('kite-login-link');
    const loginUrlText = document.getElementById('kite-login-url-text');
    
    if (!loginLink || !authToken) return;
    
    try {
        // Fetch login URL from API
        const response = await fetch(`${API_URL}/api/kite-login-url`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
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
            alert('Could not load login URL. Please ensure you are logged in and have saved your API credentials.');
        };
        
        if (loginUrlText) {
            loginUrlText.textContent = 'Error loading URL. Please ensure you are logged in.';
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
        
        // Check if user needs to authenticate with Kite
        if (data.needsAuth && data.loginURL) {
            // Show Kite login step
            showKiteLoginStep(data.loginURL);
        } else {
            // Normal login flow
        showDashboard();
        loadCredentials();
        checkStrategyStatus();
        updatePrerequisites();
        }
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
        
        // Get API credentials from credentials endpoint or session storage
        let apiKey, apiSecret;
        
        // First try to get from credentials endpoint
        try {
            const credsResponse = await fetch(`${API_URL}/api/credentials`, {
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            const credsData = await credsResponse.json();
            
            if (credsData.credentials && credsData.credentials.apiKey && credsData.credentials.apiSecret) {
                apiKey = credsData.credentials.apiKey;
                apiSecret = credsData.credentials.apiSecret;
            }
        } catch (err) {
            console.warn('Could not fetch credentials from API:', err);
        }
        
        // Fallback to session storage (for registration flow)
        if (!apiKey || !apiSecret) {
            apiKey = sessionStorage.getItem('pendingApiKey');
            apiSecret = sessionStorage.getItem('pendingApiSecret');
        }
        
        if (!apiKey || !apiSecret) {
            throw new Error('API credentials not found. Please ensure your API key and secret are saved in credentials.');
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
        const loginStep = document.getElementById('kite-login-step');
        if (loginStep) {
            loginStep.style.display = 'none';
        }
        showDashboard();
        
        // Load credentials (they should be saved automatically)
        setTimeout(() => {
            loadCredentials();
            checkStrategyStatus();
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
            // Access token is now managed automatically, but show it if available
            if (data.credentials.accessToken) {
                document.getElementById('access-token').value = data.credentials.accessToken;
            }
            
            const statusBadge = document.getElementById('credentials-status');
            const generateBtn = document.getElementById('generate-token-btn');
            const errorDiv = document.getElementById('credentials-error');
            const successDiv = document.getElementById('credentials-success');
            
            if (data.tokenValid) {
                statusBadge.textContent = '✓ Credentials Valid';
                statusBadge.className = 'status-badge has-credentials';
                // Don't enable start button here - let updateStrategyUI handle it
                updatePrerequisites();
                
                // Hide error messages
                if (errorDiv) errorDiv.classList.remove('show');
                if (successDiv) {
                    successDiv.textContent = 'Access token is valid for today.';
                    successDiv.classList.add('show');
                }
                
                // Update button text
                if (generateBtn) {
                    generateBtn.textContent = '🔄 Regenerate Access Token';
                    generateBtn.style.background = '#95a5a6';
                }
            } else {
                statusBadge.textContent = '⚠ Access Token Missing or Expired';
                statusBadge.className = 'status-badge no-credentials';
                // Don't disable start button here - let updateStrategyUI handle it
                updatePrerequisites();
                
                // Show message to re-authenticate
                if (errorDiv) {
                    errorDiv.textContent = '⚠️ Your access token is missing or expired. Click "Generate Access Token" below to authenticate with Zerodha Kite.';
                    errorDiv.classList.add('show');
                }
                if (successDiv) successDiv.classList.remove('show');
                
                // Update button to be more prominent
                if (generateBtn) {
                    generateBtn.textContent = '🔐 Generate Access Token (Required)';
                    generateBtn.style.background = '#e74c3c';
                    generateBtn.style.fontWeight = 'bold';
                }
            }
        } else {
            const statusBadge = document.getElementById('credentials-status');
            statusBadge.textContent = '⚠ No Credentials Set';
            statusBadge.className = 'status-badge no-credentials';
            
            updatePrerequisites();
            
            // Show message to save credentials first
            const errorDiv = document.getElementById('credentials-error');
            if (errorDiv) {
                errorDiv.textContent = 'Please save your API Key and Secret first, then generate access token.';
                errorDiv.classList.add('show');
            }
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
        updateStrategyUI(data.status || 'stopped', data.startedAt);
    } catch (error) {
        console.error('Error checking strategy status:', error);
        updateStrategyUI('stopped');
    }
}

function updateStrategyUI(status, startedAt = null) {
    const statusValue = document.getElementById('status-value');
    const statusIcon = document.getElementById('status-icon');
    const statusDetails = document.getElementById('status-details');
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    const startBtnText = document.getElementById('start-btn-text');
    const stopBtnText = document.getElementById('stop-btn-text');
    const logsSection = document.getElementById('strategy-logs-section');
    
    // Update status display
    statusValue.textContent = status === 'running' ? 'RUNNING' : status === 'stopped' ? 'STOPPED' : 'READY';
    statusValue.className = `status-value ${status}`;
    
    // Show/hide logs section
    if (logsSection) {
        logsSection.style.display = status === 'running' ? 'block' : 'none';
    }
    
    // Update icon and details
    if (status === 'running') {
        statusIcon.textContent = '🟢';
        statusDetails.textContent = startedAt 
            ? `Started at ${new Date(startedAt).toLocaleTimeString()} - Strategy is actively trading`
            : 'Strategy is actively trading';
        statusDetails.style.color = '#27ae60';
        
        // Button states
        startBtn.disabled = true;
        startBtn.style.opacity = '0.5';
        startBtn.style.cursor = 'not-allowed';
        stopBtn.disabled = false;
        stopBtn.style.opacity = '1';
        stopBtn.style.cursor = 'pointer';
        stopBtnText.textContent = '⏹️ Stop Strategy';
        
        // Start polling logs
        startLogsPolling();
    } else if (status === 'stopped') {
        statusIcon.textContent = '🔴';
        statusDetails.textContent = 'Strategy is stopped. Click "Start Strategy" to begin trading.';
        statusDetails.style.color = '#e74c3c';
        
        // Button states
        startBtn.disabled = false;
        startBtn.style.opacity = '1';
        startBtn.style.cursor = 'pointer';
        stopBtn.disabled = true;
        stopBtn.style.opacity = '0.5';
        stopBtn.style.cursor = 'not-allowed';
        startBtnText.textContent = '▶️ Start Strategy';
        
        // Stop polling logs
        stopLogsPolling();
    } else {
        statusIcon.textContent = '⚪';
        statusDetails.textContent = 'Ready to start. Ensure credentials are valid before starting.';
        statusDetails.style.color = '#7f8c8d';
        
        // Button states
        startBtn.disabled = false;
        startBtn.style.opacity = '1';
        startBtn.style.cursor = 'pointer';
        stopBtn.disabled = true;
        stopBtn.style.opacity = '0.5';
        stopBtn.style.cursor = 'not-allowed';
        startBtnText.textContent = '▶️ Start Strategy';
        
        // Stop polling logs
        stopLogsPolling();
    }
    
    // Update prerequisites
    updatePrerequisites();
}

// Logs polling
let logsPollInterval = null;
let lastLogCount = 0;

function startLogsPolling() {
    if (logsPollInterval) return; // Already polling
    
    updateLogs(); // Initial load
    logsPollInterval = setInterval(updateLogs, 2000); // Poll every 2 seconds
}

function stopLogsPolling() {
    if (logsPollInterval) {
        clearInterval(logsPollInterval);
        logsPollInterval = null;
    }
}

async function updateLogs() {
    try {
        const response = await fetch(`${API_URL}/api/strategy/logs?limit=100`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        const logsContent = document.getElementById('strategy-logs-content');
        if (!logsContent) return;
        
        if (data.logs && data.logs.length > 0) {
            // Only update if we have new logs
            if (data.logs.length !== lastLogCount) {
                lastLogCount = data.logs.length;
                
                logsContent.innerHTML = data.logs.map(log => {
                    const time = new Date(log.timestamp);
                    const timeStr = time.toLocaleTimeString();
                    
                    // Color code by type
                    let color = '#d4d4d4';
                    if (log.type === 'price') color = '#4ec9b0';
                    else if (log.type === 'trade') color = '#dcdcaa';
                    else if (log.type === 'error') color = '#f48771';
                    else if (log.type === 'warning') color = '#ce9178';
                    
                    // Escape HTML in message
                    const message = log.message
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;');
                    
                    return `<div style="color: ${color}; margin-bottom: 2px;">[${timeStr}] ${message}</div>`;
                }).join('');
                
                // Auto-scroll if enabled
                const autoScroll = document.getElementById('auto-scroll-logs');
                if (autoScroll && autoScroll.checked) {
                    logsContent.parentElement.scrollTop = logsContent.parentElement.scrollHeight;
                }
            }
        } else {
            logsContent.innerHTML = '<div style="color: #888;">No logs yet. Logs will appear here when strategy starts.</div>';
        }
    } catch (error) {
        console.error('Error fetching logs:', error);
    }
}

function clearLogs() {
    const logsContent = document.getElementById('strategy-logs-content');
    if (logsContent) {
        logsContent.innerHTML = '<div style="color: #888;">Logs cleared.</div>';
    }
    lastLogCount = 0;
}

function updatePrerequisites() {
    const credsStatus = document.getElementById('credentials-status');
    const prereqCredentials = document.getElementById('prereq-credentials');
    const prereqToken = document.getElementById('prereq-token');
    
    if (credsStatus) {
        const hasCredentials = credsStatus.textContent.includes('✓') || credsStatus.textContent.includes('Valid');
        const tokenValid = credsStatus.className.includes('has-credentials');
        
        prereqCredentials.innerHTML = hasCredentials 
            ? '✅ <span style="color: #27ae60;">Credentials saved</span>' 
            : '❌ <span style="color: #e74c3c;">Save API Key & Secret first</span>';
        
        prereqToken.innerHTML = tokenValid 
            ? '✅ <span style="color: #27ae60;">Access token valid</span>' 
            : '❌ <span style="color: #e74c3c;">Generate access token first</span>';
    }
}

async function handleStartStrategy() {
    const errorDiv = document.getElementById('strategy-error');
    const successDiv = document.getElementById('strategy-success');
    const startBtn = document.getElementById('start-btn');
    const startBtnText = document.getElementById('start-btn-text');
    const statusDetails = document.getElementById('status-details');

    // Show loading state
    startBtn.disabled = true;
    startBtnText.textContent = '⏳ Starting...';
    statusDetails.textContent = 'Starting strategy...';
    errorDiv.classList.remove('show');
    successDiv.classList.remove('show');

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
            startBtnText.textContent = '▶️ Start Strategy';
            startBtn.disabled = false;
            statusDetails.textContent = 'Failed to start. Please check credentials and try again.';
            statusDetails.style.color = '#e74c3c';
            return;
        }

        successDiv.textContent = '✅ Strategy started successfully! Trading will begin during market hours.';
        successDiv.classList.add('show');
        errorDiv.classList.remove('show');
        
        // Update UI immediately
        updateStrategyUI('running', new Date().toISOString());
        
        // Check status again after a moment to get server confirmation
        setTimeout(checkStrategyStatus, 1500);
    } catch (error) {
        errorDiv.textContent = 'Network error. Please check your connection and try again.';
        errorDiv.classList.add('show');
        successDiv.classList.remove('show');
        startBtnText.textContent = '▶️ Start Strategy';
        startBtn.disabled = false;
        statusDetails.textContent = 'Connection error. Please try again.';
        statusDetails.style.color = '#e74c3c';
    }
}

async function handleStopStrategy() {
    const errorDiv = document.getElementById('strategy-error');
    const successDiv = document.getElementById('strategy-success');
    const stopBtn = document.getElementById('stop-btn');
    const stopBtnText = document.getElementById('stop-btn-text');
    const statusDetails = document.getElementById('status-details');

    // Confirm before stopping
    if (!confirm('Are you sure you want to stop the strategy? This will close all open positions.')) {
        return;
    }

    // Show loading state
    stopBtn.disabled = true;
    stopBtnText.textContent = '⏳ Stopping...';
    statusDetails.textContent = 'Stopping strategy and closing positions...';
    errorDiv.classList.remove('show');
    successDiv.classList.remove('show');

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
            stopBtnText.textContent = '⏹️ Stop Strategy';
            stopBtn.disabled = false;
            statusDetails.textContent = 'Failed to stop. Please try again.';
            statusDetails.style.color = '#e74c3c';
            return;
        }

        successDiv.textContent = '✅ Strategy stopped successfully. All positions have been closed.';
        successDiv.classList.add('show');
        errorDiv.classList.remove('show');
        
        // Update UI immediately
        updateStrategyUI('stopped');
        
        // Check status again to confirm
        setTimeout(checkStrategyStatus, 1000);
    } catch (error) {
        errorDiv.textContent = 'Network error. Please check your connection and try again.';
        errorDiv.classList.add('show');
        successDiv.classList.remove('show');
        stopBtnText.textContent = '⏹️ Stop Strategy';
        stopBtn.disabled = false;
        statusDetails.textContent = 'Connection error. Please try again.';
        statusDetails.style.color = '#e74c3c';
    }
}

// Poll strategy status every 5 seconds
setInterval(() => {
    if (authToken) {
        checkStrategyStatus();
    }
}, 5000);

