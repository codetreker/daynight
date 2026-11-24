package model

type Fault struct {
	Code             string
	Message          string
	Cause            error
	TaskIDs          []string
	StepsLimit       *StepsLimitDetails
	SearchExpression *SearchExpressionDetails
	ExistingEndpoint *ExistingEndpointDetails
}

// ExistingEndpointDetails identifies the live webhook endpoint holding a
// requested creation key, for callers allowed to read that owner's endpoints.
type ExistingEndpointDetails struct {
	ID            string
	ConfigVersion int64
}

type SearchExpressionDetails struct {
	Reason   string
	Position int
	Length   int
}

type StepsLimitDetails struct {
	EncodedBytes    int64
	MaxEncodedBytes int64
}

func (f *Fault) Error() string { return f.Message }
func (f *Fault) Unwrap() error { return f.Cause }
