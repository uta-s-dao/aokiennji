-- Keep existing private photo URLs and ownership checks for all attachments.
ALTER TABLE app_private.chat_images
 ADD COLUMN content_type TEXT NOT NULL DEFAULT 'image/webp',
 ADD COLUMN file_name TEXT NOT NULL DEFAULT 'photo.webp',
 ADD COLUMN extracted_text TEXT NOT NULL DEFAULT '';
