package model

type Fault struct {
	Code             string
	Message          string
	Cause            error
	TaskIDs          []string
	StepsLimit       *StepsLimitDetails
	SearchExpression *SearchExpressionDetails
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
