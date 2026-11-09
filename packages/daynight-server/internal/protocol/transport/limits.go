// Package transport owns shared input budgets; future budgets are not enabled
// until their transport and lifecycle owners apply them.
package transport

import "time"

const (
	MaxRESTJSONBodyBytes      = 1 << 20
	MaxMCPJSONBodyBytes       = 4 << 20
	MaxEncodedCursorBytes     = 16 << 10
	MaxRawQueryBytes          = 24 << 10
	MaxRequestTargetBytes     = 48 << 10
	MaxRequestHeadersBytes    = 64 << 10
	JSONBodyReadTimeout       = 15 * time.Second
	AttachmentBodyReadTimeout = 60 * time.Second
	ArchiveBodyReadTimeout    = 120 * time.Second
	MaxMCPInputOperations     = 16
)
