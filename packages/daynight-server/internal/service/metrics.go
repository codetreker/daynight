package service

import (
	"fmt"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// newMetricsRegistry creates a registry owned by one App, never the global registry.
func newMetricsRegistry() (*prometheus.Registry, error) {
	return registerMetrics(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{ReportErrors: true}),
	)
}

func registerMetrics(collectors ...prometheus.Collector) (*prometheus.Registry, error) {
	registry := prometheus.NewRegistry()
	for _, collector := range collectors {
		if err := registry.Register(collector); err != nil {
			return nil, fmt.Errorf("register metrics collector: %w", err)
		}
	}
	return registry, nil
}
