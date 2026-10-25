-- Customer attachments never enter public site_images or document retrieval.
CREATE TABLE app_private.chat_images (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES app_private.conversations(id) ON DELETE CASCADE,
 bytes BYTEA NOT NULL CHECK (octet_length(bytes) <= 5242880),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chat_images_conversation ON app_private.chat_images(conversation_id);
ALTER TABLE app_private.chat_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_only ON app_private.chat_images TO aoki_app USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,DELETE ON app_private.chat_images TO aoki_app;
REVOKE ALL ON app_private.chat_images FROM PUBLIC,anon,authenticated;
