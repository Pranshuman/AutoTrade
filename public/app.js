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
    const errorDiv = document.getElementById('register-error');

    try {
        const response = await fetch(`${API_URL}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
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
        showDashboard();
    } catch (error) {
        errorDiv.textContent = 'Network error. Please try again.';
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
            statusBadge.textContent = '✓ Credentials Saved';
            statusBadge.className = 'status-badge has-credentials';
            
            document.getElementById('start-btn').disabled = false;
        } else {
            const statusBadge = document.getElementById('credentials-status');
            statusBadge.textContent = '⚠ No Credentials Set';
            statusBadge.className = 'status-badge no-credentials';
            
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
        updateStrategyUI(data.status);
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

