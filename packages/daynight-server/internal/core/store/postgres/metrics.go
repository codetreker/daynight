package postgres

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

var (
	poolConnections      = prometheus.NewDesc("daynight_postgres_pool_connections", "Current pool connections by state.", []string{"state"}, nil)
	poolTotalConnections = prometheus.NewDesc("daynight_postgres_pool_total_connections", "Current total pool connections.", nil, nil)
	poolMaxConnections   = prometheus.NewDesc("daynight_postgres_pool_max_connections", "Configured maximum pool connections.", nil, nil)
	poolAcquires         = prometheus.NewDesc("daynight_postgres_pool_acquires_total", "Successful pool acquires.", nil, nil)
	poolAcquireDuration  = prometheus.NewDesc("daynight_postgres_pool_acquire_duration_seconds_total", "Total time spent in successful pool acquires, in seconds.", nil, nil)
	poolCanceledAcquires = prometheus.NewDesc("daynight_postgres_pool_canceled_acquires_total", "Pool acquires canceled by context.", nil, nil)
	poolEmptyAcquires    = prometheus.NewDesc("daynight_postgres_pool_empty_acquires_total", "Successful pool acquires waiting for an empty pool.", nil, nil)
	poolEmptyAcquireWait = prometheus.NewDesc("daynight_postgres_pool_empty_acquire_wait_seconds_total", "Total time spent in successful acquires waiting for an empty pool, in seconds.", nil, nil)
)

type poolSnapshot interface {
	AcquiredConns() int32
	IdleConns() int32
	ConstructingConns() int32
	TotalConns() int32
	MaxConns() int32
	AcquireCount() int64
	AcquireDuration() time.Duration
	CanceledAcquireCount() int64
	EmptyAcquireCount() int64
	EmptyAcquireWaitTime() time.Duration
}

type poolCollector struct{ snapshot func() poolSnapshot }

// MetricsCollector observes this Store's pool without querying or owning it.
func (s *Store) MetricsCollector() prometheus.Collector {
	return poolCollector{snapshot: func() poolSnapshot { return s.Pool.Stat() }}
}

func (c poolCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, desc := range []*prometheus.Desc{poolConnections, poolTotalConnections, poolMaxConnections, poolAcquires, poolAcquireDuration, poolCanceledAcquires, poolEmptyAcquires, poolEmptyAcquireWait} {
		ch <- desc
	}
}

func (c poolCollector) Collect(ch chan<- prometheus.Metric) {
	stat := c.snapshot()
	ch <- prometheus.MustNewConstMetric(poolConnections, prometheus.GaugeValue, float64(stat.AcquiredConns()), "acquired")
	ch <- prometheus.MustNewConstMetric(poolConnections, prometheus.GaugeValue, float64(stat.IdleConns()), "idle")
	ch <- prometheus.MustNewConstMetric(poolConnections, prometheus.GaugeValue, float64(stat.ConstructingConns()), "constructing")
	ch <- prometheus.MustNewConstMetric(poolTotalConnections, prometheus.GaugeValue, float64(stat.TotalConns()))
	ch <- prometheus.MustNewConstMetric(poolMaxConnections, prometheus.GaugeValue, float64(stat.MaxConns()))
	ch <- prometheus.MustNewConstMetric(poolAcquires, prometheus.CounterValue, float64(stat.AcquireCount()))
	ch <- prometheus.MustNewConstMetric(poolAcquireDuration, prometheus.CounterValue, stat.AcquireDuration().Seconds())
	ch <- prometheus.MustNewConstMetric(poolCanceledAcquires, prometheus.CounterValue, float64(stat.CanceledAcquireCount()))
	ch <- prometheus.MustNewConstMetric(poolEmptyAcquires, prometheus.CounterValue, float64(stat.EmptyAcquireCount()))
	ch <- prometheus.MustNewConstMetric(poolEmptyAcquireWait, prometheus.CounterValue, stat.EmptyAcquireWaitTime().Seconds())
}
