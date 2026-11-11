package config

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type TaskSyncConfig struct {
	Overlap time.Duration `yaml:"overlap"`
}

type TaskSyncPatch struct {
	Overlap *configvalue.DurationString `yaml:"overlap"`
}

func (p TaskSyncPatch) ApplyTo(c *TaskSyncConfig) error {
	if p.Overlap != nil {
		value, err := time.ParseDuration(string(*p.Overlap))
		if err != nil {
			return &configvalue.ConfigurationError{Field: "overlap", Rule: "must be a Go duration", Cause: err}
		}
		c.Overlap = value
	}
	return nil
}

func DefaultConfig() TaskSyncConfig { return TaskSyncConfig{Overlap: 10 * time.Second} }

func (c TaskSyncConfig) Validate() error {
	if c.Overlap <= 0 {
		return &configvalue.ConfigurationError{Field: "overlap", Rule: "must be a positive Go duration"}
	}
	return nil
}

func (c *TaskSyncConfig) ApplyEnvironment(lookup func(string) (string, bool), mark func(field, variable string)) error {
	const variable = "DAYNIGHT_TASK_SYNC_OVERLAP"
	if value, ok := lookup(variable); ok {
		if mark != nil {
			mark("overlap", variable)
		}
		parsed, err := configvalue.Duration(value, "overlap")
		if err != nil {
			return err
		}
		c.Overlap = parsed
	}
	return nil
}
