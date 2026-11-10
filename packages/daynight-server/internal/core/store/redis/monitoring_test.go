package redis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
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
	return store.MonitoringCandidate{RunID: run, Sequence: seq, Body: []byte(body), Summary: []byte(`{"capturedAt":"2026-01-01T00:00:00Z","lifecycle":"running","scheduler":{"phase":"initializing","coverage":"unknown","lastSuccessfulAt":null,"nextPollAt":null},"capacity":null,"detailCoverage":"complete","admission":{"observedAt":"2026-01-01T00:00:00Z","coverage":"unknown","reasons":[]}}`)}
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

// malformedRangeReplyHook replaces only the returned Lua tuple after the real
// command finishes, so the public store path still executes against Redis.
type malformedRangeReplyHook struct {
	script   string
	reply    []any
	observed bool
}

func (h *malformedRangeReplyHook) DialHook(next redisclient.DialHook) redisclient.DialHook {
	return next
}
func (h *malformedRangeReplyHook) ProcessPipelineHook(next redisclient.ProcessPipelineHook) redisclient.ProcessPipelineHook {
	return next
}
func (h *malformedRangeReplyHook) ProcessHook(next redisclient.ProcessHook) redisclient.ProcessHook {
	return func(ctx context.Context, cmd redisclient.Cmder) error {
		err := next(ctx, cmd)
		args := cmd.Args()
		if err != nil || len(args) < 2 || args[0] != "eval" || args[1] != h.script {
			return err
		}
		result, ok := cmd.(*redisclient.Cmd)
		if !ok {
			return errors.New("unexpected Redis command type")
		}
		if h.script == readScript {
			original, ok := result.Val().([]any)
			if !ok || len(original) != 3 {
				return errors.New("unexpected Redis read response")
			}
			result.SetVal([]any{original[0], original[1], h.reply})
		} else {
			result.SetVal(h.reply)
		}
		h.observed = true
		return nil
	}
}

func TestMalformedRangeScriptReplyIsRejected(t *testing.T) {
	replies := []struct {
		name  string
		value []any
	}{
		{"empty tuple", []any{}},
		{"missing data", []any{int64(1)}},
		{"extra data", []any{int64(0), "", "extra"}},
		{"non-integer presence", []any{"1", "frame"}},
		{"non-string data", []any{int64(1), int64(42)}},
		{"negative presence", []any{int64(-1), ""}},
		{"out of range presence", []any{int64(2), ""}},
		{"absent with data", []any{int64(0), "frame"}},
	}
	for _, operation := range []string{"read", "summary", "compare-and-set"} {
		for _, tc := range replies {
			t.Run(operation+"/"+tc.name, func(t *testing.T) {
				s, id, k := fixture(t)
				script := readScript
				if operation == "compare-and-set" {
					script = rangeScript
				}
				hook := &malformedRangeReplyHook{script: script, reply: tc.value}
				s.client.AddHook(hook)
				var err error
				switch operation {
				case "read":
					result, e := s.Read(context.Background(), id)
					err = e
					if result.Value != nil {
						t.Fatalf("malformed read returned value: %+v", result)
					}
				case "summary":
					result, e := s.ReadSummaries(context.Background(), []store.MonitoringIdentity{id})
					err = e
					if result.Values != nil {
						t.Fatalf("malformed read returned summaries: %+v", result)
					}
				case "compare-and-set":
					result, e := s.CompareAndSet(context.Background(), id, nil, candidate(uuid.NewString(), "1", `{}`))
					err = e
					if result.Receipt != nil || result.Kind != "" {
						t.Fatalf("malformed preflight returned receipt: %+v", result)
					}
					if errors.Is(err, store.ErrMonitoringWriteOutcomeUnknown) {
						t.Fatalf("preflight incorrectly reported an unknown write: %v", err)
					}
				}
				var failure *store.MonitoringError
				if !hook.observed || !errors.Is(err, ErrInvalidFrame) || !errors.As(err, &failure) || failure.Kind != "format" {
					t.Fatalf("malformed response: observed=%v, error=%v", hook.observed, err)
				}
				if exists, e := s.client.Exists(context.Background(), k).Result(); e != nil || exists != 0 {
					t.Fatalf("malformed response changed key: exists=%d err=%v", exists, e)
				}
			})
		}
	}
}

func TestRangeScriptDistinguishesMissingFromEmptyValue(t *testing.T) {
	s, id, k := fixture(t)
	ctx := context.Background()
	result, err := s.Read(ctx, id)
	if err != nil || result.Value != nil {
		t.Fatalf("missing key: %+v %v", result, err)
	}
	summaries, err := s.ReadSummaries(ctx, []store.MonitoringIdentity{id})
	if err != nil || len(summaries.Values) != 1 || summaries.Values[0] != nil {
		t.Fatalf("missing summary: %+v %v", summaries, err)
	}
	if err := s.client.Set(ctx, k, "", time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(ctx, id); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("empty value read: %v", err)
	}
	if _, err := s.ReadSummaries(ctx, []store.MonitoringIdentity{id}); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("empty value summary: %v", err)
	}
	if _, err := s.CompareAndSet(ctx, id, nil, candidate(uuid.NewString(), "1", `{}`)); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("empty value preflight: %v", err)
	}
	value, err := s.client.Get(ctx, k).Result()
	if err != nil || value != "" {
		t.Fatalf("empty value changed: %q %v", value, err)
	}
}

func TestLegacyFrameExpiresWithoutRenewalBeforeV2Write(t *testing.T) {
	s, id, k := fixture(t)
	ctx := context.Background()
	legacy, c := legacyV1Fixture(t)
	observation, err := monitoring.ParseObservation(c.Body)
	if err != nil {
		t.Fatal(err)
	}
	c.Summary, err = monitoring.Summary(observation)
	if err != nil {
		t.Fatal(err)
	}
	// Use a short fixture TTL to exercise natural expiry; TTL above is asserted
	// independently as the production 3600-second constant.
	if err := s.client.Set(ctx, k, legacy, 2*time.Second).Err(); err != nil {
		t.Fatal(err)
	}
	before, err := s.client.PTTL(ctx, k).Result()
	if err != nil || before <= 0 {
		t.Fatalf("legacy TTL: %v %v", before, err)
	}
	if _, err := s.Read(ctx, id); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("accepted v1 detail: %v", err)
	}
	if _, err := s.ReadSummaries(ctx, []store.MonitoringIdentity{id}); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("accepted v1 summary: %v", err)
	}
	if _, err := s.CompareAndSet(ctx, id, nil, c); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("accepted v1 CAS: %v", err)
	}
	after, err := s.client.PTTL(ctx, k).Result()
	if err != nil || after <= 0 || after > before {
		t.Fatalf("rejected operations renewed TTL: before=%v after=%v err=%v", before, after, err)
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for s.client.Exists(ctx, k).Val() != 0 {
		select {
		case <-deadline.C:
			t.Fatal("legacy fixture did not expire")
		case <-ticker.C:
		}
	}
	v2, err := s.CompareAndSet(ctx, id, nil, c)
	if err != nil || v2.Kind != store.MonitoringAccepted {
		t.Fatalf("first v2 write after natural expiry: %+v %v", v2, err)
	}
	value, err := s.client.Get(ctx, k).Result()
	if err != nil || !strings.HasPrefix(value, `{"formatVersion":2,`) {
		t.Fatalf("stored frame is not v2: %v", err)
	}
}

func TestActualMaximumSummaryFitsHeader(t *testing.T) {
	s, identity, k := fixture(t)
	at := "9999-12-31T23:59:59.999999999Z"
	project, task, claim := uuid.NewString(), uuid.NewString(), uuid.NewString()
	reasons := make([]any, 16)
	for i := range reasons {
		reasons[i] = map[string]any{"code": "stopping", "scope": map[string]any{"kind": "claim", "projectId": project, "taskId": task, "claimId": claim}, "observedAt": at, "nextAttemptAt": nil}
	}
	o := map[string]any{
		"runId": uuid.NewString(), "sequence": "9223372036854775807", "capturedAt": at, "lifecycle": "starting",
		"scheduler":    map[string]any{"phase": "resource-observation", "coverage": "complete", "cycleId": nil, "lastCompletedAt": nil, "lastSuccessfulAt": at, "lastOutcome": nil, "nextPollAt": at},
		"capacity":     map[string]any{"observedAt": at, "quality": "current", "limit": 64, "occupied": int64(9007199254740991), "available": 0, "detailCoverage": "complete"},
		"admission":    map[string]any{"observedAt": at, "coverage": "complete", "reasons": reasons},
		"reservations": []any{}, "activities": []any{}, "currentFailures": []any{}, "lastRecovery": nil,
		"detailCoverage": "complete", "delivery": map[string]any{"lastSucceededAt": nil, "lastFailure": nil},
	}
	wire, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	observed, err := monitoring.ParseObservation(wire)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := monitoring.Summary(observed)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(observed)
	if err != nil {
		t.Fatal(err)
	}
	candidate := store.MonitoringCandidate{RunID: o["runId"].(string), Sequence: o["sequence"].(string), Body: body, Summary: summary}
	if result, err := s.CompareAndSet(context.Background(), identity, nil, candidate); err != nil || result.Kind != store.MonitoringAccepted {
		t.Fatalf("write: %+v %v", result, err)
	}
	frame, err := s.client.Get(context.Background(), k).Result()
	if err != nil {
		t.Fatal(err)
	}
	newline := strings.IndexByte(frame, '\n')
	if newline < 0 || newline+1 > headerLimit {
		t.Fatalf("actual header including newline: %d", newline+1)
	}
	t.Logf("actual Redis header including LF: %d bytes; summary: %d bytes", newline+1, len(summary))
	batch, err := s.ReadSummaries(context.Background(), []store.MonitoringIdentity{identity})
	if err != nil || batch.Values[0] == nil || batch.Values[0].Body != nil {
		t.Fatalf("summary-only read: %+v %v", batch, err)
	}
	stored, err := monitoring.ParseStoredSummary(batch.Values[0].Summary)
	if err != nil || len(stored.Admission.Reasons) != 16 {
		t.Fatalf("read stored reasons: %+v %v", stored.Admission, err)
	}
}
