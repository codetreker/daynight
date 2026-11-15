ALTER TABLE project_tags ADD COLUMN color text NOT NULL DEFAULT '#9AA3B2';
ALTER TABLE project_tags ADD CONSTRAINT project_tags_color_check CHECK (color ~ '^#[0-9A-F]{6}$');
