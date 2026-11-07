package task

// These limits apply to encoded resources and already paginated responses.
const (
	MaxTaskResponseJSONBytes = 512 << 10
	MaxSyncResponseJSONBytes = 64 << 20
	MaxPageResponseJSONBytes = 4 << 20
)
