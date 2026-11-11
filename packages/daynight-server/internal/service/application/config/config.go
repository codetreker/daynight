package config

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type TaskSyncConfig struct {
	Overlap time.Duration `yaml:"overlap"`
}

func DefaultConfig() TaskSyncConfig { return TaskSyncConfig{Overlap: 10 * time.Second} }

func (c TaskSyncConfig) Validate() error {
	if c.Overlap <= 0 {
		return &configvalue.ConfigurationError{Field: "DAYNIGHT_TASK_SYNC_OVERLAP", Rule: "must be a positive Go duration"}
	}
	return nil
}

func (c *TaskSyncConfig) ApplyEnvironment(lookup func(string) (string, bool), mark func(field, variable string)) error {
	const variable = "DAYNIGHT_TASK_SYNC_OVERLAP"
	if value, ok := lookup(variable); ok {
		parsed, err := configvalue.Duration(value, variable)
		if err != nil {
			return err
		}
		c.Overlap = parsed
		if mark != nil {
			mark("overlap", variable)
		}
	}
	return nil
}
