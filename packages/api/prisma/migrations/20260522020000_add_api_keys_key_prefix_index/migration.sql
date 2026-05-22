-- R-077: Add an index on api_keys.key_prefix so that the API-key authentication
-- lookup (verifyApiKey -> findMany({ where: { keyPrefix } })) can use an index
-- scan instead of a sequential scan as the api_keys table grows.

CREATE INDEX IF NOT EXISTS "api_keys_keyPrefix_idx"
  ON "api_keys" ("keyPrefix");
