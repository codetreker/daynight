//go:build usageperformance

package usage_test

import (
	"context"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type usageQuerySample struct {
	sql       string
	args      []any
	durations []time.Duration
}
type usageQueryTrace struct {
	mu      sync.Mutex
	queries map[string]*usageQuerySample
}
type usageQueryStart struct {
	sql  string
	time time.Time
}
type usageQueryTraceKey struct{}

func (trace *usageQueryTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if !strings.HasPrefix(data.SQL, "SELECT") && !strings.HasPrefix(data.SQL, "WITH") || !strings.Contains(data.SQL, "usage_records") {
		return ctx
	}
	args := slices.Clone(data.Args)
	for i, value := range args {
		if ids, ok := value.([]string); ok {
			args[i] = slices.Clone(ids)
		}
	}
	trace.mu.Lock()
	if trace.queries[data.SQL] == nil {
		trace.queries[data.SQL] = &usageQuerySample{sql: data.SQL, args: args}
	}
	trace.mu.Unlock()
	return context.WithValue(ctx, usageQueryTraceKey{}, usageQueryStart{data.SQL, time.Now()})
}
func (trace *usageQueryTrace) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	start, ok := ctx.Value(usageQueryTraceKey{}).(usageQueryStart)
	if !ok {
		return
	}
	trace.mu.Lock()
	trace.queries[start.sql].durations = append(trace.queries[start.sql].durations, time.Since(start.time))
	trace.mu.Unlock()
}
func traceUsageQueries(t *testing.T, f *workflowFixture) *usageQueryTrace {
	t.Helper()
	trace := &usageQueryTrace{queries: map[string]*usageQuerySample{}}
	config := f.db.Pool.Config()
	config.ConnConfig.Tracer = trace
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	f.service, err = app.New(&postgres.Store{Pool: pool}, app.Options{
		WriteEnabled:      true,
		QualifiedProfiles: []string{f.registration.ProfileID + "@" + f.registration.ProviderVersion},
		CursorKey:         []byte(strings.Repeat("k", 32)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return trace
}
func (trace *usageQueryTrace) explain(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	trace.mu.Lock()
	queries := make([]usageQuerySample, 0, len(trace.queries))
	for _, sample := range trace.queries {
		queries = append(queries, *sample)
	}
	trace.queries = map[string]*usageQuerySample{}
	trace.mu.Unlock()
	if len(queries) == 0 {
		t.Fatal("usage qualification captured no actual DAO queries")
	}
	sort.Slice(queries, func(i, j int) bool { return queries[i].sql < queries[j].sql })
	for i, sample := range queries {
		sort.Slice(sample.durations, func(i, j int) bool { return sample.durations[i] < sample.durations[j] })
		p95 := sample.durations[(len(sample.durations)*95+99)/100-1]
		t.Logf("actual DAO query %d samples=%d query-and-row-decoding-p95=%s SQL=%s", i+1, len(sample.durations), p95, sample.sql)
		rows, err := pool.Query(t.Context(), "EXPLAIN (ANALYZE,BUFFERS) "+sample.sql, sample.args...)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var line string
			if err = rows.Scan(&line); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			t.Log(line)
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			t.Fatal(err)
		}
	}
}
