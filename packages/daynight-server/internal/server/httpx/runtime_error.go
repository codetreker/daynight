package httpx

import "fmt"

type RuntimeError struct {
	Component string
	Phase     string
	Cause     error
}

func (e *RuntimeError) Error() string { return fmt.Sprintf("HTTP %s failed", e.Phase) }
func (e *RuntimeError) Unwrap() error { return e.Cause }
