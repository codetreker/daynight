CREATE TABLE outbox_totals (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0 AND byte_length <= 9007199254740991)
) STRICT;

INSERT INTO outbox_totals(id, byte_length) VALUES(1, 0);
