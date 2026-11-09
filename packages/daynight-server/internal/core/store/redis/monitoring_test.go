package redis

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	redisclient "github.com/redis/go-redis/v9"
)

func fixture(t *testing.T) (*Store, store.MonitoringIdentity, string) {
	t.Helper()
	raw := os.Getenv("DAYNIGHT_TEST_REDIS_URL")
	if raw == "" {
		t.Fatal("DAYNIGHT_TEST_REDIS_URL is required for Redis DAO tests")
	}
	s, err := New(raw)
	if err != nil {
		t.Fatal(err)
	}
	id := store.MonitoringIdentity{UserID: uuid.NewString(), WorkerID: uuid.NewString()}
	k, err := key(id)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := s.client.Del(ctx, k).Err(); err != nil {
			t.Errorf("delete fixture: %v", err)
		}
		if err := s.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
	})
	return s, id, k
}
func candidate(run, seq, body string) store.MonitoringCandidate {
	return store.MonitoringCandidate{RunID: run, Sequence: seq, Body: []byte(body), Summary: []byte(`{"capturedAt":"2026-01-01T00:00:00Z","lifecycle":"running","scheduler":{"phase":"initializing","coverage":"unknown","lastSuccessfulAt":null,"nextPollAt":null},"capacity":null,"detailCoverage":"complete"}`)}
}
func TestCASPersistenceAndTTL(t *testing.T) {
	s, id, k := fixture(t)
	ctx := context.Background()
	run := uuid.NewString()
	c := candidate(run, "9223372036854775806", `{"a":1}`)
	if TTL != 3600*time.Second {
		t.Fatal("production TTL changed")
	}
	s.ttl = 4 * time.Second
	first, err := s.CompareAndSet(ctx, id, nil, c)
	if err != nil || first.Kind != store.MonitoringAccepted || first.Receipt == nil {
		t.Fatalf("first: %+v %v", first, err)
	}
	if delta := first.Receipt.ExpiresAt.Sub(first.Receipt.ReceivedAt); delta != s.ttl {
		t.Fatalf("expiry: %v", delta)
	}
	if err := s.client.PExpire(ctx, k, 1500*time.Millisecond).Err(); err != nil {
		t.Fatal(err)
	}
	assertNoRefresh := func() {
		t.Helper()
		ttl, err := s.client.PTTL(ctx, k).Result()
		if err != nil || ttl <= 0 || ttl > 1500*time.Millisecond {
			t.Fatalf("TTL changed: %v %v", ttl, err)
		}
	}
	dup, err := s.CompareAndSet(ctx, id, nil, c)
	if err != nil || dup.Kind != store.MonitoringDuplicate || *dup.Receipt != *first.Receipt {
		t.Fatalf("duplicate: %+v %v", dup, err)
	}
	assertNoRefresh()
	other := candidate(run, c.Sequence, `{"a":2}`)
	conflict, err := s.CompareAndSet(ctx, id, nil, other)
	if err != nil || conflict.Kind != store.MonitoringSampleConflict {
		t.Fatalf("sample conflict: %+v %v", conflict, err)
	}
	assertNoRefresh()
	stale := candidate(run, "9223372036854775805", `{"a":3}`)
	conflict, err = s.CompareAndSet(ctx, id, nil, stale)
	if err != nil || conflict.Kind != store.MonitoringSequenceStale {
		t.Fatalf("stale: %+v %v", conflict, err)
	}
	assertNoRefresh()
	next := candidate(run, "9223372036854775807", `{"a":4}`)
	conflict, err = s.CompareAndSet(ctx, id, nil, next)
	if err != nil || conflict.Kind != store.MonitoringRevisionConflict {
		t.Fatalf("revision: %+v %v", conflict, err)
	}
	assertNoRefresh()
	got, err := s.Read(ctx, id)
	if err != nil || got.Value == nil || string(got.Value.Body) != string(c.Body) || got.Value.Receipt != *first.Receipt || got.ObservedAt.IsZero() {
		t.Fatalf("read: %+v %v", got, err)
	}
	assertNoRefresh()
	absent := store.MonitoringIdentity{UserID: id.UserID, WorkerID: uuid.NewString()}
	batch, err := s.ReadSummaries(ctx, []store.MonitoringIdentity{absent, id})
	if err != nil || len(batch.Values) != 2 || batch.Values[0] != nil || batch.Values[1] == nil || batch.Values[1].Body != nil || batch.Values[1].Receipt != *first.Receipt {
		t.Fatalf("summaries: %+v %v", batch, err)
	}
	assertNoRefresh()
	updated, err := s.CompareAndSet(ctx, id, &first.Receipt.Revision, next)
	if err != nil || updated.Kind != store.MonitoringAccepted || updated.Receipt.Revision == first.Receipt.Revision {
		t.Fatalf("update: %+v %v", updated, err)
	}
	if ttl := s.client.PTTL(ctx, k).Val(); ttl < 3*time.Second {
		t.Fatalf("new state did not reset TTL: %v", ttl)
	}
	newRun := candidate(uuid.NewString(), "1", `{"a":5}`)
	advanced, err := s.CompareAndSet(ctx, id, &updated.Receipt.Revision, newRun)
	if err != nil || advanced.Kind != store.MonitoringAccepted {
		t.Fatalf("new run: %+v %v", advanced, err)
	}
	conflict, err = s.CompareAndSet(ctx, id, &updated.Receipt.Revision, next)
	if err != nil || conflict.Kind != store.MonitoringRevisionConflict {
		t.Fatalf("old run: %+v %v", conflict, err)
	}
	if err := s.client.Del(ctx, k).Err(); err != nil {
		t.Fatal(err)
	}
	conflict, err = s.CompareAndSet(ctx, id, &advanced.Receipt.Revision, newRun)
	if err != nil || conflict.Kind != store.MonitoringStateLost {
		t.Fatalf("state lost: %+v %v", conflict, err)
	}
	got, err = s.Read(ctx, id)
	if err != nil || got.Value != nil {
		t.Fatalf("absent: %+v %v", got, err)
	}
}
func TestCorruptFramesAndWrongTypes(t *testing.T) {
	s, id, k := fixture(t)
	ctx := context.Background()
	c := candidate(uuid.NewString(), "1", `{"a":1}`)
	for _, frame := range []string{"", "garbage", "{}\n{}", strings.Repeat("a", headerLimit) + "\n{}"} {
		if err := s.client.Set(ctx, k, frame, time.Minute).Err(); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Read(ctx, id); !errors.Is(err, ErrInvalidFrame) {
			t.Fatalf("read corrupt %q: %v", frame, err)
		}
		if _, err := s.ReadSummaries(ctx, []store.MonitoringIdentity{id}); !errors.Is(err, ErrInvalidFrame) {
			t.Fatalf("summary corrupt: %v", err)
		}
		if _, err := s.CompareAndSet(ctx, id, nil, c); err == nil {
			t.Fatalf("CAS accepted corrupt frame")
		}
	}
	if err := s.client.Del(ctx, k).Err(); err != nil {
		t.Fatal(err)
	}
	if err := s.client.LPush(ctx, k, "value").Err(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(ctx, id); err == nil {
		t.Fatal("read wrong type")
	} else {
		var failure *store.MonitoringError
		if !errors.As(err, &failure) || failure.Kind != "type" {
			t.Fatalf("wrong type classification: %v", err)
		}
	}
	if _, err := s.ReadSummaries(ctx, []store.MonitoringIdentity{id}); err == nil {
		t.Fatal("summary wrong type")
	}
	if _, err := s.CompareAndSet(ctx, id, nil, c); err == nil {
		t.Fatal("CAS wrong type")
	}
}
func TestValidationAndDeadlines(t *testing.T) {
	for _, raw := range []string{"", "http://localhost", "://bad", "unix:///tmp/redis.sock", "redis:///0"} {
		if ValidateURL(raw) == nil {
			t.Fatalf("accepted URL %q", raw)
		}
	}
	for _, raw := range []string{"redis://127.0.0.1:6379/0", "rediss://localhost:6379"} {
		if err := ValidateURL(raw); err != nil {
			t.Fatal(err)
		}
	}
	s, id, _ := fixture(t)
	ctx := context.Background()
	good := candidate(uuid.NewString(), "1", `{}`)
	for _, seq := range []string{"", "0", "01", "9223372036854775808", "+1"} {
		c := good
		c.Sequence = seq
		if _, err := s.CompareAndSet(ctx, id, nil, c); err == nil {
			t.Fatalf("accepted %q", seq)
		}
	}
	bad := good
	bad.Body = []byte(`{ }`)
	if _, err := s.CompareAndSet(ctx, id, nil, bad); err == nil {
		t.Fatal("accepted noncanonical body")
	}
	bad = good
	bad.Body = []byte(`{"x":"` + strings.Repeat("x", bodyLimit) + `"}`)
	if _, err := s.CompareAndSet(ctx, id, nil, bad); err == nil {
		t.Fatal("accepted oversized body")
	}
	invalidRevision := "invalid"
	if _, err := s.CompareAndSet(ctx, id, &invalidRevision, good); err == nil {
		t.Fatal("accepted invalid revision")
	}
	bad = good
	bad.Summary = []byte(`[]`)
	if _, err := s.CompareAndSet(ctx, id, nil, bad); err == nil {
		t.Fatal("accepted invalid summary")
	}
	if _, err := New("invalid-url"); err == nil {
		t.Fatal("accepted invalid URL")
	}
	if _, err := s.ReadSummaries(ctx, []store.MonitoringIdentity{{}}); err == nil {
		t.Fatal("accepted invalid identity for summaries")
	}
	if _, err := s.Read(ctx, store.MonitoringIdentity{}); err == nil {
		t.Fatal("accepted invalid identity")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	stall, cancel := context.WithCancel(context.Background())
	go func() {
		defer close(done)
		conn, e := listener.Accept()
		if e == nil {
			defer conn.Close()
			buf := make([]byte, 1024)
			_, _ = conn.Read(buf)
			<-stall.Done()
		}
	}()
	// The peer never responds; the operation's own deadline must bound it.
	blocked, err := New(fmt.Sprintf("redis://%s", listener.Addr()))
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, err = blocked.CompareAndSet(context.Background(), id, nil, good)
	elapsed := time.Since(start)
	if err == nil || errors.Is(err, store.ErrMonitoringWriteOutcomeUnknown) || elapsed > time.Second {
		t.Fatalf("deadline: %v after %v", err, elapsed)
	}
	_ = blocked.Close()
	_ = listener.Close()
	cancel()
	<-done
}

func TestNoEvictionRejectsWriteWithoutPartialMutation(t *testing.T) {
	s, id, k := fixture(t)
	ctx := context.Background()
	c := candidate(uuid.NewString(), "1", `{}`)
	first, err := s.CompareAndSet(ctx, id, nil, c)
	if err != nil {
		t.Fatal(err)
	}
	before, err := s.client.Get(ctx, k).Result()
	if err != nil {
		t.Fatal(err)
	}
	config, err := s.client.ConfigGet(ctx, "maxmemory*").Result()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.client.ConfigSet(context.Background(), "maxmemory", config["maxmemory"]).Err(); err != nil {
			t.Errorf("restore maxmemory: %v", err)
		}
		if err := s.client.ConfigSet(context.Background(), "maxmemory-policy", config["maxmemory-policy"]).Err(); err != nil {
			t.Errorf("restore policy: %v", err)
		}
	})
	if err := s.client.ConfigSet(ctx, "maxmemory-policy", "noeviction").Err(); err != nil {
		t.Fatal(err)
	}
	if err := s.client.ConfigSet(ctx, "maxmemory", "1").Err(); err != nil {
		t.Fatal(err)
	}
	next := candidate(c.RunID, "2", `{"next":true}`)
	_, err = s.CompareAndSet(ctx, id, &first.Receipt.Revision, next)
	if err == nil || errors.Is(err, store.ErrMonitoringWriteOutcomeUnknown) {
		t.Fatalf("OOM must be a definite refusal: %v", err)
	}
	var failure *store.MonitoringError
	if !errors.As(err, &failure) || failure.Kind != "oom" {
		t.Fatalf("OOM classification: %v", err)
	}
	after, err := s.client.Get(ctx, k).Result()
	if err != nil || after != before {
		t.Fatalf("OOM changed existing state: %v", err)
	}
	if ttl := s.client.TTL(ctx, k).Val(); ttl <= 0 || ttl > TTL {
		t.Fatalf("OOM changed expiry: %v", ttl)
	}
}

func TestFrameBodyIntegrity(t *testing.T) {
	s, id, k := fixture(t)
	ctx := context.Background()
	c := candidate(uuid.NewString(), "1", `{}`)
	if _, err := s.CompareAndSet(ctx, id, nil, c); err != nil {
		t.Fatal(err)
	}
	frame, err := s.client.Get(ctx, k).Result()
	if err != nil {
		t.Fatal(err)
	}
	i := strings.IndexByte(frame, '\n')
	if i < 0 {
		t.Fatal("missing separator")
	}
	if err := s.client.Set(ctx, k, frame[:i+1]+`{"changed":true}`, time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(ctx, id); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("body digest: %v", err)
	}
	if _, err := parseValue([]byte(frame[:i+1]+strings.Repeat("x", bodyLimit+1)), true); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("oversized body: %v", err)
	}
}

// responseHook simulates a response lost after Redis executed the write.
type responseHook struct{}

func (responseHook) DialHook(next redisclient.DialHook) redisclient.DialHook { return next }
func (responseHook) ProcessPipelineHook(next redisclient.ProcessPipelineHook) redisclient.ProcessPipelineHook {
	return next
}
func (responseHook) ProcessHook(next redisclient.ProcessHook) redisclient.ProcessHook {
	return func(ctx context.Context, cmd redisclient.Cmder) error {
		err := next(ctx, cmd)
		args := cmd.Args()
		if err == nil && len(args) > 1 && args[0] == "eval" && args[1] == casScript {
			return context.DeadlineExceeded
		}
		return err
	}
}
func TestUnknownWriteAfterCommit(t *testing.T) {
	s, id, _ := fixture(t)
	s.client.AddHook(responseHook{})
	c := candidate(uuid.NewString(), "1", `{}`)
	_, err := s.CompareAndSet(context.Background(), id, nil, c)
	if !errors.Is(err, store.ErrMonitoringWriteOutcomeUnknown) {
		t.Fatalf("lost response: %v", err)
	}
	got, err := s.Read(context.Background(), id)
	if err != nil || got.Value == nil || string(got.Value.Body) != string(c.Body) {
		t.Fatalf("write observation: %+v %v", got, err)
	}
}

type afterReadHook struct{ fn func() }

func (h *afterReadHook) DialHook(next redisclient.DialHook) redisclient.DialHook { return next }
func (h *afterReadHook) ProcessHook(next redisclient.ProcessHook) redisclient.ProcessHook {
	return func(ctx context.Context, cmd redisclient.Cmder) error {
		err := next(ctx, cmd)
		args := cmd.Args()
		if err == nil && h.fn != nil && len(args) > 1 && args[0] == "eval" && args[1] == readScript {
			fn := h.fn
			h.fn = nil
			fn()
		}
		return err
	}
}
func (h *afterReadHook) ProcessPipelineHook(next redisclient.ProcessPipelineHook) redisclient.ProcessPipelineHook {
	return next
}

func TestAbsentReadConcurrentCreation(t *testing.T) {
	for _, batch := range []bool{false, true} {
		t.Run(fmt.Sprintf("batch=%v", batch), func(t *testing.T) {
			s, id, _ := fixture(t)
			c := candidate(uuid.NewString(), "1", `{}`)
			hook := &afterReadHook{}
			hook.fn = func() {
				r, err := s.CompareAndSet(context.Background(), id, nil, c)
				if err != nil || r.Kind != store.MonitoringAccepted {
					t.Errorf("concurrent creation: %+v %v", r, err)
				}
			}
			s.client.AddHook(hook)
			if batch {
				r, err := s.ReadSummaries(context.Background(), []store.MonitoringIdentity{id})
				if err != nil || len(r.Values) != 1 || r.Values[0] != nil {
					t.Fatalf("batch absence: %+v %v", r, err)
				}
			} else {
				r, err := s.Read(context.Background(), id)
				if err != nil || r.Value != nil {
					t.Fatalf("absence: %+v %v", r, err)
				}
			}
			r, err := s.Read(context.Background(), id)
			if err != nil || r.Value == nil {
				t.Fatalf("created state: %+v %v", r, err)
			}
		})
	}
}

func TestNoImplicitDialRetry(t *testing.T) {
	opts, err := options("redis://127.0.0.1:6379")
	if err != nil {
		t.Fatal(err)
	}
	attempts := 0
	opts.Dialer = func(context.Context, string, string) (net.Conn, error) {
		attempts++
		return nil, errors.New("dial refused")
	}
	s := &Store{client: redisclient.NewClient(opts), ttl: TTL}
	defer s.Close()
	id := store.MonitoringIdentity{UserID: uuid.NewString(), WorkerID: uuid.NewString()}
	if _, err := s.Read(context.Background(), id); err == nil {
		t.Fatal("expected dial error")
	}
	if attempts != 1 {
		t.Fatalf("dial attempts: %d", attempts)
	}
}

func TestCorruptSummaryBlocksCAS(t *testing.T) {
	s, id, k := fixture(t)
	ctx := context.Background()
	c := candidate(uuid.NewString(), "1", `{}`)
	first, err := s.CompareAndSet(ctx, id, nil, c)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := s.client.Get(ctx, k).Result()
	if err != nil {
		t.Fatal(err)
	}
	corrupt := strings.Replace(frame, `"lifecycle":"running"`, `"private":"secret","lifecycle":"running"`, 1)
	if corrupt == frame {
		t.Fatal("fixture did not change")
	}
	if err = s.client.Set(ctx, k, corrupt, time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	next := candidate(c.RunID, "2", `{"new":true}`)
	if _, err = s.CompareAndSet(ctx, id, &first.Receipt.Revision, next); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("corrupt CAS: %v", err)
	}
	after, err := s.client.Get(ctx, k).Result()
	if err != nil || after != corrupt {
		t.Fatalf("corrupt value changed: %v", err)
	}
}

func TestFailureClassificationPreservesCause(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		kind string
	}{
		{"deadline", context.DeadlineExceeded, "deadline"},
		{"cancel", context.Canceled, "cancelled"},
		{"format", ErrInvalidFrame, "format"},
		{"network", &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("private address")}, "network"},
		{"other", errors.New("private URL"), "other"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyFailure(tc.err)
			var failure *store.MonitoringError
			if !errors.As(got, &failure) || failure.Kind != tc.kind || !errors.Is(got, tc.err) || strings.Contains(got.Error(), "private") {
				t.Fatalf("classification: %v", got)
			}
		})
	}
}
