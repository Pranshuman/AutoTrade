-- AutoTrade Supabase Database Setup
-- Run this in Supabase SQL Editor

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

-- Enable Row Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_sessions ENABLE ROW LEVEL SECURITY;

-- Create policies to allow all operations
-- Note: In production, you'd want more restrictive policies
CREATE POLICY "Allow all operations on users" ON users
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations on credentials" ON credentials
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all operations on strategy_sessions" ON strategy_sessions
  FOR ALL USING (true) WITH CHECK (true);

-- Verify tables were created
SELECT 'Tables created successfully!' as status;

