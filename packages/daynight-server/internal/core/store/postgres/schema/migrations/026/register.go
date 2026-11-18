package store

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

// Apply executes migration 026's frozen data transformation.
func Apply(ctx context.Context, tx pgx.Tx) error { return migratePropertyRows026(ctx, tx) }

// SQL returns migration 026's frozen schema change.
func SQL() string { return propertyRowsSQL }

// TransformSource returns the source included in migration 026's checksum.
func TransformSource() string { return propertyRowsTransformSource }

// DecodeLegacyProperties exposes the frozen pre-row contract for historical fixtures.
func DecodeLegacyProperties(raw []byte) (map[string]json.RawMessage, error) {
	return decodeLegacyPropertyRows026(raw)
}
