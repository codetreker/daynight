package configvalue

import "fmt"

type ConfigurationError struct {
	Field string
	Rule  string
	Cause error
}

func (e *ConfigurationError) Error() string { return fmt.Sprintf("%s %s", e.Field, e.Rule) }
func (e *ConfigurationError) Unwrap() error { return e.Cause }
