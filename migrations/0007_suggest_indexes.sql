-- Suggestions: tag keys and their values across issues, by count
CREATE INDEX IF NOT EXISTS issue_tag_values_key_value ON issue_tag_values (key, value);
