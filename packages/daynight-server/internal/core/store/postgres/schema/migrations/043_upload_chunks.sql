-- Receipts survive lost responses and are retained with their transfer record.
-- Each object is private to the namespace owned by that record.
CREATE TABLE private_upload_chunks (
    transfer_id uuid NOT NULL REFERENCES private_transfers(id) ON DELETE CASCADE,
    chunk_id uuid NOT NULL,
    object_id uuid NOT NULL,
    byte_offset bigint NOT NULL CHECK (byte_offset >= 0),
    byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 524288),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CHECK (byte_offset <= 9223372036854775807 - byte_size),
    PRIMARY KEY (transfer_id, chunk_id),
    UNIQUE (transfer_id, byte_offset),
    UNIQUE (transfer_id, object_id)
);
