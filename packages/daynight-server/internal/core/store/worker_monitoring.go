package store

import (
	"context"
	"time"
)

// WorkerMonitoringReader selects only current, account-visible resources. It is
// valid for the lifetime of the enclosing snapshot. Callers must compare the
// complete requested set with the returned IDs before accessing monitoring data.
type WorkerMonitoringReader interface {
	MonitoringWorkers(context.Context, string, []string, time.Time) ([]string, error)
	MonitoringSources(context.Context, string, []string, []string) (WorkerMonitoringSources, error)
}

// WorkerMonitoringSources omits inaccessible or deleted resources. A Task's
// ProjectID must still be compared with the reported scope by the caller.
type WorkerMonitoringSources struct {
	Projects map[string]string
	Tasks    map[string]WorkerTaskSource
}
