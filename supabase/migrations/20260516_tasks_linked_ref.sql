-- Add linked_ref and linked_name columns to tasks table for attaching leads/clients to notes
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS linked_ref text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS linked_name text;
