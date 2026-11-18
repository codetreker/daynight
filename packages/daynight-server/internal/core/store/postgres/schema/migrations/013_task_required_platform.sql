ALTER TABLE tasks ADD COLUMN required_platform text
    CHECK (required_platform IN ('windows', 'linux', 'macos'));
