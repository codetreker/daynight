// Package limit describes measured admission failures without retaining input values.
package limit

import "fmt"

// Violation identifies a measured value outside a policy limit. Min is set for
// a lower-bound violation; Max records the inclusive upper bound when relevant.
type Violation struct {
	Field  string
	Actual int64
	Max    int64
	Min    *int64
	Unit   string
	// LowerBound reports that Actual is the first observed excess, not the total.
	LowerBound bool
}

func (v *Violation) Error() string {
	if v.Min != nil {
		return fmt.Sprintf("%s: %d %s is below minimum %d", v.Field, v.Actual, v.Unit, *v.Min)
	}
	if v.LowerBound {
		return fmt.Sprintf("%s: at least %d %s exceeds maximum %d", v.Field, v.Actual, v.Unit, v.Max)
	}
	return fmt.Sprintf("%s: %d %s exceeds maximum %d", v.Field, v.Actual, v.Unit, v.Max)
}
