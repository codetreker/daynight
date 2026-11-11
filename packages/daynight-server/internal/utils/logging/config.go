package logging

import "errors"

// Config defines the fixed rotation policy for the server log.
type Config struct {
	MaxBytes int64
	Archives int
}

func DefaultConfig() Config { return Config{MaxBytes: 100 * 1024 * 1024, Archives: 10} }

func (c Config) Validate() error {
	if c.MaxBytes <= 0 || c.Archives <= 0 {
		return errors.New("invalid logging rotation policy")
	}
	return nil
}
