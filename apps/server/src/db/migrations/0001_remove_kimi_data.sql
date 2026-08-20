WITH kimi_sessions AS (
  SELECT DISTINCT session_id
  FROM app_private.session_agents
  WHERE config_payload #> ARRAY['models', 'kimi'] IS NOT NULL

  UNION

  SELECT DISTINCT session_id
  FROM app_private.agent_attempts
  WHERE lower(provider) = 'kimi'
     OR lower(model) LIKE 'kimi%'

  UNION

  SELECT DISTINCT session_id
  FROM app_private.session_events
  WHERE public_event_payload ->> 'type' = 'agentProviderFallback'
)
UPDATE app_private.sessions
SET agent_run_state = 'idle',
    active_player_run_id = NULL,
    active_decision_request_id = NULL
WHERE id IN (SELECT session_id FROM kimi_sessions);
--> statement-breakpoint
WITH kimi_sessions AS (
  SELECT DISTINCT session_id
  FROM app_private.session_agents
  WHERE config_payload #> ARRAY['models', 'kimi'] IS NOT NULL

  UNION

  SELECT DISTINCT session_id
  FROM app_private.agent_attempts
  WHERE lower(provider) = 'kimi'
     OR lower(model) LIKE 'kimi%'

  UNION

  SELECT DISTINCT session_id
  FROM app_private.session_events
  WHERE public_event_payload ->> 'type' = 'agentProviderFallback'
)
DELETE FROM app_private.sessions AS session
USING kimi_sessions
WHERE session.id = kimi_sessions.session_id;
