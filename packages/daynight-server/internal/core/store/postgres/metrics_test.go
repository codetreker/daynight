package postgres

import (
	"context"
	"errors"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

type fixedPoolSnapshot struct{}

func (fixedPoolSnapshot) AcquiredConns() int32                { return 2 }
func (fixedPoolSnapshot) IdleConns() int32                    { return 3 }
func (fixedPoolSnapshot) ConstructingConns() int32            { return 1 }
func (fixedPoolSnapshot) TotalConns() int32                   { return 6 }
func (fixedPoolSnapshot) MaxConns() int32                     { return 9 }
func (fixedPoolSnapshot) AcquireCount() int64                 { return 17 }
func (fixedPoolSnapshot) AcquireDuration() time.Duration      { return 2500 * time.Millisecond }
func (fixedPoolSnapshot) CanceledAcquireCount() int64         { return 4 }
func (fixedPoolSnapshot) EmptyAcquireCount() int64            { return 8 }
func (fixedPoolSnapshot) EmptyAcquireWaitTime() time.Duration { return 1250 * time.Millisecond }

type metricValue struct {
	kind  dto.MetricType
	value float64
}

func gatherPoolMetrics(t *testing.T, registry *prometheus.Registry) map[string]metricValue {
	t.Helper()
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	values := make(map[string]metricValue)
	for _, family := range families {
		for _, metric := range family.Metric {
			key := family.GetName()
			if len(metric.Label) > 0 {
				if len(metric.Label) != 1 || metric.Label[0].GetName() != "state" {
					t.Fatalf("unexpected labels on %s: %v", key, metric.Label)
				}
				key += "/" + metric.Label[0].GetValue()
			}
			var value float64
			switch family.GetType() {
			case dto.MetricType_GAUGE:
				value = metric.GetGauge().GetValue()
			case dto.MetricType_COUNTER:
				value = metric.GetCounter().GetValue()
			default:
				t.Fatalf("unexpected type for %s: %s", key, family.GetType())
			}
			if _, ok := values[key]; ok {
				t.Fatalf("duplicate metric %s", key)
			}
			values[key] = metricValue{family.GetType(), value}
		}
	}
	return values
}

func TestPoolCollectorMapsOneSnapshotPerScrape(t *testing.T) {
	calls := 0
	collector := poolCollector{snapshot: func() poolSnapshot { calls++; return fixedPoolSnapshot{} }}
	registry := prometheus.NewRegistry()
	if err := registry.Register(collector); err != nil {
		t.Fatal(err)
	}
	want := map[string]metricValue{
		"daynight_postgres_pool_connections/acquired":             {dto.MetricType_GAUGE, 2},
		"daynight_postgres_pool_connections/idle":                 {dto.MetricType_GAUGE, 3},
		"daynight_postgres_pool_connections/constructing":         {dto.MetricType_GAUGE, 1},
		"daynight_postgres_pool_total_connections":                {dto.MetricType_GAUGE, 6},
		"daynight_postgres_pool_max_connections":                  {dto.MetricType_GAUGE, 9},
		"daynight_postgres_pool_acquires_total":                   {dto.MetricType_COUNTER, 17},
		"daynight_postgres_pool_acquire_duration_seconds_total":   {dto.MetricType_COUNTER, 2.5},
		"daynight_postgres_pool_canceled_acquires_total":          {dto.MetricType_COUNTER, 4},
		"daynight_postgres_pool_empty_acquires_total":             {dto.MetricType_COUNTER, 8},
		"daynight_postgres_pool_empty_acquire_wait_seconds_total": {dto.MetricType_COUNTER, 1.25},
	}
	for scrape := 1; scrape <= 2; scrape++ {
		got := gatherPoolMetrics(t, registry)
		if len(got) != len(want) {
			t.Fatalf("scrape %d: got %v, want %v", scrape, got, want)
		}
		for name, expected := range want {
			if got[name] != expected {
				t.Errorf("%s: got %v, want %v", name, got[name], expected)
			}
		}
		if calls != scrape {
			t.Fatalf("scrape %d read %d snapshots", scrape, calls)
		}
	}
}

type poolQueryTracer struct{ queries atomic.Int64 }

func (tracer *poolQueryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	tracer.queries.Add(1)
	return ctx
}
func (*poolQueryTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// The second Done call occurs after puddle has found the only pool slot occupied,
// when it enters the semaphore wait. This makes release and cancellation deterministic.
type waitObservedContext struct {
	context.Context
	calls   atomic.Int32
	waiting chan struct{}
}

func (ctx *waitObservedContext) Done() <-chan struct{} {
	if ctx.calls.Add(1) == 2 {
		close(ctx.waiting)
	}
	return ctx.Context.Done()
}

func awaitPoolWait(t *testing.T, ctx *waitObservedContext) {
	t.Helper()
	select {
	case <-ctx.waiting:
	case <-time.After(10 * time.Second):
		t.Fatal("acquire did not reach pool wait")
	}
}

func TestPoolCollectorReflectsRealAcquiresWithoutSQL(t *testing.T) {
	raw := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if raw == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for PostgreSQL tests")
	}
	config, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	config.MinConns = 0
	config.ShouldPing = func(context.Context, pgxpool.ShouldPingParams) bool { return false }
	tracer := &poolQueryTracer{}
	config.ConnConfig.Tracer = tracer
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	registry := prometheus.NewRegistry()
	if err := registry.Register((&Store{Pool: pool}).MetricsCollector()); err != nil {
		t.Fatal(err)
	}
	holder, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	held := true
	defer func() {
		if held {
			holder.Release()
		}
	}()
	before := gatherPoolMetrics(t, registry)
	assertMetric := func(values map[string]metricValue, name string, value float64) {
		t.Helper()
		if got := values[name].value; got != value {
			t.Fatalf("%s = %v, want %v", name, got, value)
		}
	}
	assertMetric(before, "daynight_postgres_pool_connections/acquired", 1)
	assertMetric(before, "daynight_postgres_pool_connections/idle", 0)
	assertMetric(before, "daynight_postgres_pool_total_connections", 1)
	assertMetric(before, "daynight_postgres_pool_max_connections", 1)

	cancelCtx, stop := context.WithCancel(ctx)
	defer stop()
	waitingCancel := &waitObservedContext{Context: cancelCtx, waiting: make(chan struct{})}
	cancelResult := make(chan error, 1)
	go func() {
		conn, err := pool.Acquire(waitingCancel)
		if conn != nil {
			conn.Release()
		}
		cancelResult <- err
	}()
	awaitPoolWait(t, waitingCancel)
	stop()
	if err := <-cancelResult; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled acquire: %v", err)
	}
	afterCancel := gatherPoolMetrics(t, registry)
	for _, key := range []string{"daynight_postgres_pool_acquires_total", "daynight_postgres_pool_acquire_duration_seconds_total", "daynight_postgres_pool_empty_acquires_total", "daynight_postgres_pool_empty_acquire_wait_seconds_total"} {
		if afterCancel[key] != before[key] {
			t.Errorf("canceled acquire changed %s: %v -> %v", key, before[key], afterCancel[key])
		}
	}
	assertMetric(afterCancel, "daynight_postgres_pool_canceled_acquires_total", before["daynight_postgres_pool_canceled_acquires_total"].value+1)

	successCtx, stopSuccess := context.WithCancel(ctx)
	waitingSuccess := &waitObservedContext{Context: successCtx, waiting: make(chan struct{})}
	type acquireResult struct {
		conn *pgxpool.Conn
		err  error
	}
	successResult := make(chan acquireResult, 1)
	go func() { conn, err := pool.Acquire(waitingSuccess); successResult <- acquireResult{conn, err} }()
	consumed := false
	defer func() {
		stopSuccess()
		if !consumed {
			result := <-successResult
			if result.conn != nil {
				result.conn.Release()
			}
		}
	}()
	awaitPoolWait(t, waitingSuccess)
	holder.Release()
	held = false
	result := <-successResult
	consumed = true
	if result.err != nil {
		t.Fatal(result.err)
	}
	defer result.conn.Release()
	afterWait := gatherPoolMetrics(t, registry)
	assertMetric(afterWait, "daynight_postgres_pool_acquires_total", before["daynight_postgres_pool_acquires_total"].value+1)
	assertMetric(afterWait, "daynight_postgres_pool_empty_acquires_total", before["daynight_postgres_pool_empty_acquires_total"].value+1)
	for _, key := range []string{"daynight_postgres_pool_acquire_duration_seconds_total", "daynight_postgres_pool_empty_acquire_wait_seconds_total"} {
		if afterWait[key].value <= before[key].value {
			t.Errorf("successful wait did not increase %s: %v -> %v", key, before[key], afterWait[key])
		}
	}
	result.conn.Release()
	afterRelease := gatherPoolMetrics(t, registry)
	assertMetric(afterRelease, "daynight_postgres_pool_connections/acquired", 0)
	assertMetric(afterRelease, "daynight_postgres_pool_connections/idle", 1)
	for name, metric := range afterRelease {
		if metric.value < 0 {
			t.Errorf("negative %s: %v", name, metric.value)
		}
	}
	if got := tracer.queries.Load(); got != 0 {
		t.Fatalf("collector executed %d SQL queries", got)
	}
}
