import { KiteConnect } from "kiteconnect";

const apiKey = "gssli7u395tn5in8";
const apiSecret = "yeq4xu913i50u2d5j5b0wkgqp6cp0ufo";
const requestToken = "6DVMd0d2QI7jsZnOWNL8WxaLvBW7LmPo";
// const accessToken = "B6YlUbYIj7Qiq2SnpfNZUKDsRVsvJ8RE";
const kc = new KiteConnect({ api_key: apiKey });

console.log(kc.getLoginURL());

async function init() {
  try {
    await generateSession();
    // kc.setAccessToken(accessToken);
    await getProfile()
  } catch (err) {
    console.error(err);
  }
}

async function generateSession() {
  try {
    const response = await kc.generateSession(requestToken, apiSecret);
    console.log(response.access_token);
    kc.setAccessToken(response.access_token);
    console.log("Session generated:", response);
  } catch (err) {
    console.error("Error generating session:", err);
  }
}

async function getProfile() {
  try {
    const profile = await kc.getProfile();
    console.log("Profile:", profile);
  } catch (err) {
    console.error("Error getting profile:", err);
  }
}
// Initialize the API calls
init();