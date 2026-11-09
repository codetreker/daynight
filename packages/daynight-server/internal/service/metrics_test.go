package service

import (
	"context"
	"errors"
	"runtime"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

func TestAppMetricsIsolationAndOfficialCollectors(t *testing.T) {
	c := appTestConfig(t)
	c.MetricsListenAddress = "127.0.0.1:0"
	first, _, err := openTestApp(t, context.Background(), c, nil)
	if err != nil {
		t.Fatal(err)
	}
	other := appTestConfig(t)
	other.MetricsListenAddress = "127.0.0.1:0"
	second, _, err := openTestApp(t, context.Background(), other, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.Metrics == nil || second.Metrics == nil || first.Metrics == second.Metrics {
		t.Fatal("enabled Apps must own distinct registries")
	}
	marker := prometheus.NewGauge(prometheus.GaugeOpts{Name: "test_instance_marker", Help: "Instance marker."})
	if err := first.Metrics.Register(marker); err != nil {
		t.Fatal(err)
	}
	marker.Set(1)
	for i, registry := range []*prometheus.Registry{first.Metrics, second.Metrics} {
		families, err := registry.Gather()
		if runtime.GOOS != "linux" && runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
			if err == nil {
				t.Errorf("unsupported platform %s silently collected process metrics", runtime.GOOS)
			}
			continue
		}
		if err != nil {
			t.Fatalf("gather registry %d: %v", i, err)
		}
		names := make(map[string]bool)
		for _, family := range families {
			names[family.GetName()] = true
		}
		for _, name := range []string{"go_goroutines", "go_gc_duration_seconds", "go_memstats_alloc_bytes"} {
			if !names[name] {
				t.Errorf("registry %d missing %s", i, name)
			}
		}
		for _, name := range []string{"process_cpu_seconds_total", "process_start_time_seconds", "process_open_fds", "process_max_fds"} {
			if !names[name] {
				t.Errorf("registry %d missing %s", i, name)
			}
		}
		for _, name := range []string{"process_virtual_memory_bytes", "process_resident_memory_bytes"} {
			want := runtime.GOOS != "darwin" || metricsDarwinCGO
			if names[name] != want {
				t.Errorf("registry %d metric %s present=%t, want %t", i, name, names[name], want)
			}
		}
		if names["test_instance_marker"] != (i == 0) {
			t.Errorf("registry %d leaked marker", i)
		}
	}
}

func TestMetricsDisabledAndRegistrationFailureCleanup(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(map[bool]string{false: "disabled", true: "registration failure"}[enabled], func(t *testing.T) {
			c := appTestConfig(t)
			if enabled {
				c.MetricsListenAddress = "127.0.0.1:0"
			}
			backend := newAppBackend(t)
			open := appTestOpeners(t, c, backend)
			called := false
			failure := errors.New("registration failed")
			open.metrics = func() (*prometheus.Registry, error) { called = true; return nil, failure }
			app, err := openApp(context.Background(), c, nil, open)
			if enabled {
				if app != nil || !called || !errors.Is(err, failure) {
					t.Fatalf("registration failure lost: app=%v called=%v err=%v", app, called, err)
				}
				return
			}
			if err != nil || called || app.Metrics != nil {
				t.Fatalf("disabled registry: app=%v called=%v err=%v", app, called, err)
			}
			if backend.collector.collects.Load() != 0 {
				t.Fatal("disabled metrics collected persistence")
			}
			if err := app.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAppRegistersItsPersistenceCollector(t *testing.T) {
	var apps [2]*App
	var backends [2]*appBackend
	for i := range apps {
		c := appTestConfig(t)
		c.MetricsListenAddress = "127.0.0.1:0"
		var err error
		apps[i], backends[i], err = openTestApp(t, context.Background(), c, nil)
		if err != nil {
			t.Fatal(err)
		}
		if apps[i].persistence.Transactions != backends[i] || apps[i].persistence.MetricsCollector != backends[i].collector {
			t.Fatal("App did not retain the collector from its own persistence backend")
		}
		backends[i].collector.gauge.Set(float64(i + 1))
	}
	for i, app := range apps {
		families, err := app.Metrics.Gather()
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, family := range families {
			if family.GetName() == "test_persistence_instance" {
				found = true
				if len(family.Metric) != 1 || family.Metric[0].GetGauge().GetValue() != float64(i+1) {
					t.Fatalf("App %d collected another persistence instance: %v", i, family)
				}
			}
		}
		if !found || backends[i].collector.collects.Load() != 1 || backends[1-i].collector.collects.Load() != int32(i) {
			t.Fatalf("App %d collection was missing or leaked to another instance", i)
		}
	}
}

func TestPersistenceCollectorRegistrationFailureCleansResources(t *testing.T) {
	c := appTestConfig(t)
	c.MetricsListenAddress = "127.0.0.1:0"
	backend := newAppBackend(t)
	open := appTestOpeners(t, c, backend)
	open.metrics = func() (*prometheus.Registry, error) {
		registry := prometheus.NewRegistry()
		if err := registry.Register(backend.collector); err != nil {
			t.Fatal(err)
		}
		return registry, nil
	}
	app, err := openApp(context.Background(), c, nil, open)
	var duplicate prometheus.AlreadyRegisteredError
	if app != nil || !errors.As(err, &duplicate) {
		t.Fatalf("duplicate collector error lost: app=%v err=%v", app, err)
	}
	// The fixture asserts that both resources close once, in dependency order.
}

func TestMissingMetricsRegistryCleansResources(t *testing.T) {
	c := appTestConfig(t)
	c.MetricsListenAddress = "127.0.0.1:0"
	backend := newAppBackend(t)
	open := appTestOpeners(t, c, backend)
	open.metrics = func() (*prometheus.Registry, error) { return nil, nil }
	app, err := openApp(context.Background(), c, nil, open)
	if app != nil || err == nil {
		t.Fatalf("missing registry accepted: app=%v err=%v", app, err)
	}
}

func TestPersistenceRejectsMissingCollector(t *testing.T) {
	c := appTestConfig(t)
	backend := newAppBackend(t)
	backend.collector = nil
	backend.expectedPolicies, backend.expectedReferences = 0, 0
	app, err := openApp(context.Background(), c, nil, appTestOpeners(t, c, backend))
	if app != nil || err == nil {
		t.Fatalf("missing collector accepted: app=%v err=%v", app, err)
	}
}

func TestMetricsRegistrationAndGatherErrors(t *testing.T) {
	gauge := prometheus.NewGauge(prometheus.GaugeOpts{Name: "test_duplicate", Help: "Duplicate."})
	registry, err := registerMetrics(gauge, gauge)
	var duplicate prometheus.AlreadyRegisteredError
	if registry != nil || !errors.As(err, &duplicate) {
		t.Fatalf("registration error lost: registry=%v error=%v", registry, err)
	}
	registry, err = registerMetrics(invalidMetricsCollector{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Gather(); err == nil {
		t.Fatal("invalid collector gather error was hidden")
	}
	pidErr := errors.New("process PID unavailable")
	registry, err = registerMetrics(collectors.NewProcessCollector(collectors.ProcessCollectorOpts{
		PidFn: func() (int, error) { return 0, pidErr }, ReportErrors: true,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Gather(); err == nil || !errors.Is(err, pidErr) {
		t.Fatalf("process collector error was hidden: %v", err)
	}
}

type invalidMetricsCollector struct{}

func (invalidMetricsCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- prometheus.NewDesc("test_invalid", "Invalid metric.", nil, nil)
}

func (invalidMetricsCollector) Collect(ch chan<- prometheus.Metric) {
	ch <- prometheus.NewInvalidMetric(prometheus.NewDesc("test_invalid", "Invalid metric.", nil, nil), errors.New("collect failure"))
}
