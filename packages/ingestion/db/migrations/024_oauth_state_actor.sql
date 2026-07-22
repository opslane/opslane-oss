-- 024_oauth_state_actor.sql — bind GitHub installation callbacks to their initiating user.
ALTER TABLE oauth_login_states
  ADD COLUMN IF NOT EXISTS initiating_user_id UUID REFERENCES users(id);

